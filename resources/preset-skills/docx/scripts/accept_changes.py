"""Resolve every tracked revision inside a Word document via LibreOffice automation.

Deploys a Basic macro into a dedicated LibreOffice user profile, opens the
target document headlessly, executes the macro to accept all changes, then
saves and closes.

LibreOffice (``soffice``) must be available on the system PATH.
"""

from __future__ import annotations

import argparse
import logging
import pathlib
import shutil
import subprocess
from dataclasses import dataclass
from typing import Final

import office.soffice as _lo

# ── Logging ──────────────────────────────────────────────────────────────────

_LOG: Final = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

_PROFILE_ROOT: Final[str] = "/tmp/libreoffice_docx_profile"
_MACRO_FOLDER: Final[pathlib.Path] = pathlib.Path(
    f"{_PROFILE_ROOT}/user/basic/Standard"
)
_MACRO_FILE: Final[pathlib.Path] = _MACRO_FOLDER / "Module1.xba"
_MACRO_ENTRY_POINT: Final[str] = "AcceptAllTrackedChanges"

_BASIC_MACRO_BODY: Final[str] = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">\n'
    '<script:module xmlns:script="http://openoffice.org/2000/script" '
    'script:name="Module1" script:language="StarBasic">\n'
    "    Sub AcceptAllTrackedChanges()\n"
    "        Dim document As Object\n"
    "        Dim dispatcher As Object\n"
    "\n"
    "        document = ThisComponent.CurrentController.Frame\n"
    '        dispatcher = createUnoService("com.sun.star.frame.DispatchHelper")\n'
    "\n"
    '        dispatcher.executeDispatch(document, ".uno:AcceptAllTrackedChanges", "", 0, Array())\n'
    "        ThisComponent.store()\n"
    "        ThisComponent.close(True)\n"
    "    End Sub\n"
    "</script:module>"
)

_SOFFICE_TIMEOUT_SECONDS: Final[int] = 30
_PROFILE_INIT_TIMEOUT_SECONDS: Final[int] = 10
_USER_INSTALL_ARG: Final[str] = f"-env:UserInstallation=file://{_PROFILE_ROOT}"
_MACRO_URI: Final[str] = (
    f"vnd.sun.star.script:Standard.Module1.{_MACRO_ENTRY_POINT}"
    "?language=Basic&location=application"
)


# ── Data structures ──────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Result:
    """Outcome of an accept-changes operation."""

    success: bool
    message: str


# ── Internal helpers ─────────────────────────────────────────────────────────


def _initialize_profile_directory() -> None:
    """Launch soffice once to bootstrap the user profile directory tree."""
    subprocess.run(
        ["soffice", "--headless", _USER_INSTALL_ARG, "--terminate_after_init"],
        capture_output=True,
        timeout=_PROFILE_INIT_TIMEOUT_SECONDS,
        check=False,
        env=_lo.get_soffice_env(),
    )
    _MACRO_FOLDER.mkdir(parents=True, exist_ok=True)


def _provision_macro() -> bool:
    """Ensure the LO Basic macro file exists and contains the expected code."""
    if _MACRO_FILE.exists() and _MACRO_ENTRY_POINT in _MACRO_FILE.read_text():
        return True

    if not _MACRO_FOLDER.exists():
        _initialize_profile_directory()

    try:
        _MACRO_FILE.write_text(_BASIC_MACRO_BODY)
        return True
    except Exception as exc:
        _LOG.warning("Macro provisioning failed: %s", exc)
        return False


def _validate_input(src_path: pathlib.Path) -> str | None:
    """Return an error message if the input is invalid, else None."""
    if not src_path.exists():
        return f"Error: Input file not found: {src_path}"
    if src_path.suffix.lower() != ".docx":
        return f"Error: Input file is not a DOCX file: {src_path}"
    return None


def _copy_source_to_destination(
    src_path: pathlib.Path, dst_path: pathlib.Path
) -> str | None:
    """Copy the source file to the destination. Return error message on failure."""
    try:
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_path, dst_path)
        return None
    except Exception as exc:
        return f"Error: Failed to copy input file to output location: {exc}"


def _run_macro(dst_path: pathlib.Path) -> Result:
    """Invoke LibreOffice with the accept-changes macro on the given file."""
    argv = [
        "soffice",
        "--headless",
        _USER_INSTALL_ARG,
        "--norestore",
        _MACRO_URI,
        str(dst_path.absolute()),
    ]

    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=_SOFFICE_TIMEOUT_SECONDS,
            check=False,
            env=_lo.get_soffice_env(),
        )
    except subprocess.TimeoutExpired:
        # Timeout is treated as success — LO sometimes hangs after completing.
        return Result(success=True, message="")

    if proc.returncode != 0:
        return Result(success=False, message=f"Error: LibreOffice failed: {proc.stderr}")

    return Result(success=True, message="")


# ── Public API ───────────────────────────────────────────────────────────────


def accept_changes(src: str, dst: str) -> tuple[None, str]:
    """Accept all revisions in *src* and write the clean result to *dst*.

    Returns:
        A tuple of ``(None, message)`` where *message* describes the outcome.
    """
    src_path = pathlib.Path(src)
    dst_path = pathlib.Path(dst)

    # Validate input file.
    error = _validate_input(src_path)
    if error:
        return None, error

    # Copy source to destination for in-place macro editing.
    error = _copy_source_to_destination(src_path, dst_path)
    if error:
        return None, error

    # Deploy the macro if not already present.
    if not _provision_macro():
        return None, "Error: Failed to setup LibreOffice macro"

    # Execute the macro.
    result = _run_macro(dst_path)
    if not result.success:
        return None, result.message

    return None, f"Successfully accepted all tracked changes: {src} -> {dst}"


# ── CLI entry point ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Accept all tracked changes in a DOCX file"
    )
    ap.add_argument("input_file", help="Input DOCX file with tracked changes")
    ap.add_argument(
        "output_file", help="Output DOCX file (clean, no tracked changes)"
    )
    cli = ap.parse_args()

    _, msg = accept_changes(cli.input_file, cli.output_file)
    print(msg)

    if "Error" in msg:
        raise SystemExit(1)
