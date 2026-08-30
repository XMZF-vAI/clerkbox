"""
Wrapper around LibreOffice (``soffice``) that transparently handles
sandboxed environments where AF_UNIX sockets are unavailable.

The module detects the restriction at startup and, when necessary,
compiles and injects a tiny C shim via ``LD_PRELOAD``.

Public surface::

    from office.soffice import run_soffice, get_soffice_env

    # Approach A – call soffice directly
    result = run_soffice(["--headless", "--convert-to", "pdf", "input.docx"])

    # Approach B – retrieve an env dict for manual subprocess usage
    env = get_soffice_env()
    subprocess.run(["soffice", ...], env=env)
"""

import os
import pathlib
import socket
import subprocess
import tempfile


# ── Shared-object path for the optional shim ────────────────────────────────

_COMPILED_SHIM = pathlib.Path(tempfile.gettempdir()) / "lo_socket_shim.so"

# ── C source for the LD_PRELOAD shim ────────────────────────────────────────

_C_SOURCE = r"""
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int (*real_socket)(int, int, int);
static int (*real_socketpair)(int, int, int, int[2]);
static int (*real_listen)(int, int);
static int (*real_accept)(int, struct sockaddr *, socklen_t *);
static int (*real_close)(int);
static int (*real_read)(int, void *, size_t);

/* Per-FD bookkeeping (FDs >= 1024 are passed through unshimmed). */
static int is_shimmed[1024];
static int peer_of[1024];
static int wake_r[1024];            /* accept() blocks reading this */
static int wake_w[1024];            /* close()  writes to this      */
static int listener_fd = -1;        /* FD that received listen()    */

__attribute__((constructor))
static void init(void) {
    real_socket     = dlsym(RTLD_NEXT, "socket");
    real_socketpair = dlsym(RTLD_NEXT, "socketpair");
    real_listen     = dlsym(RTLD_NEXT, "listen");
    real_accept     = dlsym(RTLD_NEXT, "accept");
    real_close      = dlsym(RTLD_NEXT, "close");
    real_read       = dlsym(RTLD_NEXT, "read");
    for (int i = 0; i < 1024; i++) {
        peer_of[i] = -1;
        wake_r[i]  = -1;
        wake_w[i]  = -1;
    }
}

/* ---- socket ---------------------------------------------------------- */
int socket(int domain, int type, int protocol) {
    if (domain == AF_UNIX) {
        int fd = real_socket(domain, type, protocol);
        if (fd >= 0) return fd;
        /* socket(AF_UNIX) blocked – fall back to socketpair(). */
        int sv[2];
        if (real_socketpair(domain, type, protocol, sv) == 0) {
            if (sv[0] >= 0 && sv[0] < 1024) {
                is_shimmed[sv[0]] = 1;
                peer_of[sv[0]]    = sv[1];
                int wp[2];
                if (pipe(wp) == 0) {
                    wake_r[sv[0]] = wp[0];
                    wake_w[sv[0]] = wp[1];
                }
            }
            return sv[0];
        }
        errno = EPERM;
        return -1;
    }
    return real_socket(domain, type, protocol);
}

/* ---- listen ---------------------------------------------------------- */
int listen(int sockfd, int backlog) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        listener_fd = sockfd;
        return 0;
    }
    return real_listen(sockfd, backlog);
}

/* ---- accept ---------------------------------------------------------- */
int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        /* Block until close() writes to the wake pipe. */
        if (wake_r[sockfd] >= 0) {
            char buf;
            real_read(wake_r[sockfd], &buf, 1);
        }
        errno = ECONNABORTED;
        return -1;
    }
    return real_accept(sockfd, addr, addrlen);
}

/* ---- close ----------------------------------------------------------- */
int close(int fd) {
    if (fd >= 0 && fd < 1024 && is_shimmed[fd]) {
        int was_listener = (fd == listener_fd);
        is_shimmed[fd] = 0;

        if (wake_w[fd] >= 0) {              /* unblock accept() */
            char c = 0;
            write(wake_w[fd], &c, 1);
            real_close(wake_w[fd]);
            wake_w[fd] = -1;
        }
        if (wake_r[fd] >= 0) { real_close(wake_r[fd]); wake_r[fd]  = -1; }
        if (peer_of[fd] >= 0) { real_close(peer_of[fd]); peer_of[fd] = -1; }

        if (was_listener)
            _exit(0);                        /* conversion done – exit */
    }
    return real_close(fd);
}
"""


# ── Internal helpers ─────────────────────────────────────────────────────────

def _unix_sockets_blocked() -> bool:
    """Return *True* when the OS refuses to create AF_UNIX sockets."""
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.close()
        return False
    except OSError:
        return True


def _build_shim_if_missing() -> pathlib.Path:
    """Compile the C shim to a shared object when it is not yet present."""
    if _COMPILED_SHIM.exists():
        return _COMPILED_SHIM

    c_file = pathlib.Path(tempfile.gettempdir()) / "lo_socket_shim.c"
    c_file.write_text(_C_SOURCE)
    subprocess.run(
        ["gcc", "-shared", "-fPIC", "-o", str(_COMPILED_SHIM), str(c_file), "-ldl"],
        check=True,
        capture_output=True,
    )
    c_file.unlink()
    return _COMPILED_SHIM


# ── Public API ───────────────────────────────────────────────────────────────

def get_soffice_env() -> dict:
    """Return an ``env`` dict suitable for ``subprocess.run(env=…)``."""
    merged = os.environ.copy()
    merged["SAL_USE_VCLPLUGIN"] = "svp"

    if _unix_sockets_blocked():
        merged["LD_PRELOAD"] = str(_build_shim_if_missing())

    return merged


def run_soffice(args: list[str], **kw) -> subprocess.CompletedProcess:
    """Launch ``soffice`` with the correct environment and given *args*."""
    return subprocess.run(["soffice"] + args, env=get_soffice_env(), **kw)


# ── CLI passthrough ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    outcome = run_soffice(sys.argv[1:])
    sys.exit(outcome.returncode)
