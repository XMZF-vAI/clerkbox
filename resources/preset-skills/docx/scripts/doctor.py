#!/usr/bin/env python3
"""Detect dependencies required by docx-pro and print per-platform install hints.

Run this FIRST so you can choose the right Markdown->docx engine:
  - pandoc available           -> use md_to_docx.py (preferred)
  - pandoc missing, node ok     -> use md_to_docx.mjs (Node fallback)
  - soffice + pdftoppm available -> preview.py self-check enabled
"""
import os
import shutil
import subprocess
import sys
import platform


def _run(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else ""
    except Exception:
        return ""


def _node_has_docx():
    """Check whether the global `docx` npm package is importable."""
    if not shutil.which("node"):
        return False
    probe = "try{require('docx');console.log('ok')}catch(e){process.exit(1)}"
    try:
        out = subprocess.run(["node", "-e", probe], capture_output=True, text=True, timeout=30)
        if "ok" in out.stdout:
            return True
        # Try global resolution: put the global node_modules on NODE_PATH so Node
        # can resolve `docx` itself. Passing the path via the environment avoids
        # interpolating it into JS source, which breaks on paths containing
        # characters like apostrophes (e.g. a user named "hei'jiao").
        # Resolve the real npm executable; on Windows it is npm.cmd, and calling
        # bare "npm" without shell=True raises FileNotFoundError.
        npm = shutil.which("npm")
        if not npm:
            return False
        root = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, timeout=30).stdout.strip()
        if not root:
            return False
        env = dict(os.environ)
        existing = env.get("NODE_PATH", "")
        env["NODE_PATH"] = root + (os.pathsep + existing if existing else "")
        out2 = subprocess.run(["node", "-e", probe], capture_output=True, text=True, timeout=30, env=env)
        return "ok" in out2.stdout
    except Exception:
        return False


HINTS = {
    "pandoc": {
        "Darwin": "brew install pandoc",
        "Windows": "winget install --id JohnMacFarlane.Pandoc  (or: choco install pandoc)",
        "Linux": "sudo apt-get install -y pandoc",
    },
    "docx-npm": {
        "*": "npm install -g docx",
    },
    "soffice": {
        "Darwin": "brew install --cask libreoffice",
        "Windows": "winget install --id TheDocumentFoundation.LibreOffice",
        "Linux": "sudo apt-get install -y libreoffice",
    },
    "pdftoppm": {
        "Darwin": "brew install poppler",
        "Windows": "Bundled with many LibreOffice installs; or: choco install poppler",
        "Linux": "sudo apt-get install -y poppler-utils",
    },
}


def hint(name):
    osname = platform.system()
    table = HINTS.get(name, {})
    return table.get(osname) or table.get("*") or "(see project docs)"


def main():
    osname = platform.system()
    print(f"docx-pro doctor  (OS: {osname})\n" + "-" * 40)

    pandoc = bool(shutil.which("pandoc"))
    node = bool(shutil.which("node"))
    npm_docx = _node_has_docx()
    soffice = bool(shutil.which("soffice") or shutil.which("libreoffice"))
    pdftoppm = bool(shutil.which("pdftoppm"))

    def line(label, ok, hint_key=None, extra=""):
        mark = "OK " if ok else "-- "
        msg = f"[{mark}] {label}"
        if extra:
            msg += f"  {extra}"
        if not ok and hint_key:
            msg += f"\n       install: {hint(hint_key)}"
        print(msg)

    line("pandoc", pandoc, "pandoc", _run(["pandoc", "--version"]) if pandoc else "")
    line("node", node, None, _run(["node", "--version"]) if node else "")
    line("docx (npm global)", npm_docx, "docx-npm")
    line("LibreOffice (soffice)", soffice, "soffice")
    line("pdftoppm (poppler)", pdftoppm, "pdftoppm")

    print("-" * 40)
    if pandoc:
        print("ENGINE: use scripts/md_to_docx.py  (pandoc, preferred)")
    elif node and npm_docx:
        print("ENGINE: use scripts/md_to_docx.mjs  (Node fallback)")
    else:
        print("ENGINE: none ready. Install pandoc OR `npm install -g docx`,")
        print("        or hand the task to the base 'docx' skill.")

    if soffice and pdftoppm:
        print("PREVIEW: scripts/preview.py available.")
    elif not soffice:
        print("PREVIEW: disabled (LibreOffice not found).")
    else:
        print("PREVIEW: disabled (pdftoppm not found).")

    # Non-zero exit only if NO engine is usable, so callers can branch.
    return 0 if (pandoc or (node and npm_docx)) else 1


if __name__ == "__main__":
    sys.exit(main())
