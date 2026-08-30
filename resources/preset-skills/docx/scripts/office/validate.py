"""
CLI for checking Office XML against XSD schemas and tracked-change rules.

Invocation::

    python validate.py <path> [--original <original_file>] [--auto-repair] [--author NAME]

``<path>`` may be either an already-unpacked directory **or** a packed
``.docx``/``.pptx``/``.xlsx`` file (which is temporarily inflated).

Auto-repair capabilities:

* ``paraId`` / ``durableId`` values exceeding OOXML limits are regenerated.
* Missing ``xml:space="preserve"`` on ``w:t`` nodes with leading/trailing
  whitespace is injected.
"""

import argparse
import pathlib
import sys
import tempfile
import zipfile

def _force_utf8_stdio():
    """Force UTF-8 on stdout/stderr so Chinese paths and messages print correctly
    when invoked as a CLI script via pipe (upper framework decodes as UTF-8)."""
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


from validators import DOCXSchemaValidator, PPTXSchemaValidator, RedliningValidator

_SUPPORTED_EXTS = [".docx", ".pptx", ".xlsx"]


def main():
    _force_utf8_stdio()
    ap = argparse.ArgumentParser(description="Validate Office document XML files")
    ap.add_argument(
        "path",
        help="Path to unpacked directory or packed Office file (.docx/.pptx/.xlsx)",
    )
    ap.add_argument(
        "--original",
        required=False,
        default=None,
        help="Path to original file (.docx/.pptx/.xlsx). If omitted, all XSD errors are reported and redlining validation is skipped.",
    )
    ap.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose output",
    )
    ap.add_argument(
        "--auto-repair",
        action="store_true",
        help="Automatically repair common issues (hex IDs, whitespace preservation)",
    )
    ap.add_argument(
        "--author",
        default="Claude",
        help="Author name for redlining validation (default: Claude)",
    )
    opts = ap.parse_args()

    target = pathlib.Path(opts.path)
    assert target.exists(), "Error: %s does not exist" % target

    ref_file = None
    if opts.original:
        ref_file = pathlib.Path(opts.original)
        assert ref_file.is_file(), "Error: %s is not a file" % ref_file
        assert ref_file.suffix.lower() in _SUPPORTED_EXTS, (
            "Error: %s must be a .docx, .pptx, or .xlsx file" % ref_file
        )

    ext = (ref_file or target).suffix.lower()
    assert ext in _SUPPORTED_EXTS, (
        "Error: Cannot determine file type from %s. Use --original or provide a .docx/.pptx/.xlsx file." % target
    )

    if target.is_file() and target.suffix.lower() in _SUPPORTED_EXTS:
        scratch = tempfile.mkdtemp()
        with zipfile.ZipFile(target, "r") as zf:
            zf.extractall(scratch)
        work_dir = pathlib.Path(scratch)
    else:
        assert target.is_dir(), "Error: %s is not a directory or Office file" % target
        work_dir = target

    match ext:
        case ".docx":
            checkers = [
                DOCXSchemaValidator(work_dir, ref_file, verbose=opts.verbose),
            ]
            if ref_file:
                checkers.append(
                    RedliningValidator(work_dir, ref_file, verbose=opts.verbose, author=opts.author)
                )
        case ".pptx":
            checkers = [
                PPTXSchemaValidator(work_dir, ref_file, verbose=opts.verbose),
            ]
        case _:
            print("Error: Validation not supported for file type %s" % ext)
            sys.exit(1)

    if opts.auto_repair:
        n_fixed = sum(c.repair() for c in checkers)
        if n_fixed:
            print("Auto-repaired %d issue(s)" % n_fixed)

    ok = all(c.validate() for c in checkers)

    if ok:
        print("All validations PASSED!")

    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
