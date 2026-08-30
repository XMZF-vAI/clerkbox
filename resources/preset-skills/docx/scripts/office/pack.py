"""Reassemble an unpacked Office directory into a DOCX / PPTX / XLSX archive.

The tool validates with automatic repair, strips cosmetic whitespace from XML,
and produces the final ZIP-based file.

Invocation::

    python pack.py <src_dir> <dest_file> [--original <file>] [--validate true|false]

Samples::

    python pack.py unpacked/ output.docx --original input.docx
    python pack.py unpacked/ output.pptx --validate false
"""

import argparse
import shutil
import sys
import tempfile
import zipfile
import pathlib

import defusedxml.minidom


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


_ALLOWED_EXTENSIONS = {".docx", ".pptx", ".xlsx"}


def _strip_xml_formatting(fp: pathlib.Path) -> None:
    """Collapse pretty-printed XML back to a compact single-line form."""
    try:
        with open(fp, encoding="utf-8") as fh:
            parsed = defusedxml.minidom.parse(fh)

        for el in parsed.getElementsByTagName("*"):
            if el.tagName.endswith(":t"):
                continue
            children_to_drop = [
                ch for ch in list(el.childNodes)
                if (ch.nodeType == ch.TEXT_NODE and ch.nodeValue and ch.nodeValue.strip() == "")
                or ch.nodeType == ch.COMMENT_NODE
            ]
            for ch in children_to_drop:
                el.removeChild(ch)

        fp.write_bytes(parsed.toxml(encoding="UTF-8"))
    except Exception as err:
        print("ERROR: Failed to parse {}: {}".format(fp.name, err), file=sys.stderr)
        raise


def _execute_validators(
    src_dir: pathlib.Path,
    orig: pathlib.Path,
    ext: str,
    author_fn=None,
) -> tuple[bool, str | None]:
    """Run the appropriate validator chain and return (ok, log_text)."""
    log_parts: list[str] = []
    checkers: list = []

    if ext == ".docx":
        writer = "Claude"
        if author_fn:
            try:
                writer = author_fn(src_dir, orig)
            except ValueError as ve:
                print("Warning: {} Using default author 'Claude'.".format(ve), file=sys.stderr)
        checkers = [
            DOCXSchemaValidator(src_dir, orig),
            RedliningValidator(src_dir, orig, author=writer),
        ]
    elif ext == ".pptx":
        checkers = [PPTXSchemaValidator(src_dir, orig)]

    if not checkers:
        return True, None

    fixed = sum(c.repair() for c in checkers)
    if fixed:
        log_parts.append("Auto-repaired {} issue(s)".format(fixed))

    ok = all(c.validate() for c in checkers)
    if ok:
        log_parts.append("All validations PASSED!")

    return ok, "\n".join(log_parts) if log_parts else None


def pack(
    input_directory: str,
    output_file: str,
    original_file: str | None = None,
    validate: bool = True,
    infer_author_func=None,
) -> tuple[None, str]:
    """Pack *input_directory* into *output_file* (Office ZIP archive)."""
    src = pathlib.Path(input_directory)
    dest = pathlib.Path(output_file)
    ext = dest.suffix.lower()

    if not src.is_dir():
        return None, "Error: {} is not a directory".format(src)

    if ext not in _ALLOWED_EXTENSIONS:
        return None, "Error: {} must be a .docx, .pptx, or .xlsx file".format(output_file)

    if validate and original_file:
        orig_p = pathlib.Path(original_file)
        if orig_p.exists():
            ok, report = _execute_validators(src, orig_p, ext, infer_author_func)
            if report:
                print(report)
            if not ok:
                return None, "Error: Validation failed for {}".format(src)

    with tempfile.TemporaryDirectory() as scratch:
        staging = pathlib.Path(scratch) / "content"
        shutil.copytree(src, staging)

        xml_globs = ("*.xml", "*.rels")
        for g in xml_globs:
            for xf in staging.rglob(g):
                _strip_xml_formatting(xf)

        dest.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
            for item in staging.rglob("*"):
                if item.is_file():
                    zf.write(item, item.relative_to(staging))

    return None, "Successfully packed {} to {}".format(src, output_file)


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    _force_utf8_stdio()
    ap = argparse.ArgumentParser(
        description="Pack a directory into a DOCX, PPTX, or XLSX file"
    )
    ap.add_argument("input_directory", help="Unpacked Office document directory")
    ap.add_argument("output_file", help="Output Office file (.docx/.pptx/.xlsx)")
    ap.add_argument(
        "--original",
        help="Original file for validation comparison",
    )
    ap.add_argument(
        "--validate",
        type=lambda v: v.lower() == "true",
        default=True,
        metavar="true|false",
        help="Run validation with auto-repair (default: true)",
    )
    cli = ap.parse_args()

    _, message = pack(
        cli.input_directory,
        cli.output_file,
        original_file=cli.original,
        validate=cli.validate,
    )
    print(message)

    if "Error" in message:
        sys.exit(1)
