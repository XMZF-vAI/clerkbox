"""Extract and beautify Office archives (DOCX / PPTX / XLSX) for manual XML editing.

The ZIP contents are inflated, every XML file is pretty-printed, and — for
Word documents — adjacent runs may be coalesced and redundant tracked-change
wrappers collapsed.

Invocation::

    python unpack.py <office_file> <output_dir> [options]

Samples::

    python unpack.py document.docx unpacked/
    python unpack.py presentation.pptx unpacked/
    python unpack.py document.docx unpacked/ --merge-runs false
"""

import argparse
import pathlib
import sys
import zipfile

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

from helpers.merge_runs import merge_runs as _coalesce_runs
from helpers.simplify_redlines import simplify_redlines as _compact_redlines

_TYPOGRAPHIC_QUOTES = {
    "\u201c": "&#x201C;",
    "\u201d": "&#x201D;",
    "\u2018": "&#x2018;",
    "\u2019": "&#x2019;",
}

_OFFICE_SUFFIXES = {".docx", ".pptx", ".xlsx"}


def _beautify_xml(fp: pathlib.Path) -> None:
    """Rewrite *fp* in indented form via minidom."""
    try:
        raw = fp.read_text(encoding="utf-8")
        dom = defusedxml.minidom.parseString(raw)
        fp.write_bytes(dom.toprettyxml(indent="  ", encoding="utf-8"))
    except Exception:
        pass


def _replace_typographic_quotes(fp: pathlib.Path) -> None:
    """Convert Unicode curly quotes to XML numeric entities so they survive round-trips."""
    try:
        blob = fp.read_text(encoding="utf-8")
        for ch, entity in _TYPOGRAPHIC_QUOTES.items():
            blob = blob.replace(ch, entity)
        fp.write_text(blob, encoding="utf-8")
    except Exception:
        pass


def unpack(
    input_file: str,
    output_directory: str,
    merge_runs: bool = True,
    simplify_redlines: bool = True,
) -> tuple[None, str]:
    """Inflate *input_file* into *output_directory* and post-process XML."""
    src = pathlib.Path(input_file)
    dest = pathlib.Path(output_directory)
    ext = src.suffix.lower()

    if not src.exists():
        return None, "Error: %s does not exist" % input_file

    if ext not in _OFFICE_SUFFIXES:
        return None, "Error: %s must be a .docx, .pptx, or .xlsx file" % input_file

    try:
        dest.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(src, "r") as zf:
            zf.extractall(dest)

        xml_inventory = [
            *dest.rglob("*.xml"),
            *dest.rglob("*.rels"),
        ]

        for xf in xml_inventory:
            _beautify_xml(xf)

        summary = "Unpacked %s (%d XML files)" % (input_file, len(xml_inventory))

        if ext == ".docx":
            if simplify_redlines:
                n_simplified, _ = _compact_redlines(str(dest))
                summary += ", simplified %d tracked changes" % n_simplified

            if merge_runs:
                n_merged, _ = _coalesce_runs(str(dest))
                summary += ", merged %d runs" % n_merged

        for xf in xml_inventory:
            _replace_typographic_quotes(xf)

        return None, summary

    except zipfile.BadZipFile:
        return None, "Error: %s is not a valid Office file" % input_file
    except Exception as exc:
        return None, "Error unpacking: %s" % exc


# ── CLI entry point ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    _force_utf8_stdio()
    ap = argparse.ArgumentParser(
        description="Unpack an Office file (DOCX, PPTX, XLSX) for editing"
    )
    ap.add_argument("input_file", help="Office file to unpack")
    ap.add_argument("output_directory", help="Output directory")
    ap.add_argument(
        "--merge-runs",
        type=lambda v: v.lower() == "true",
        default=True,
        metavar="true|false",
        help="Merge adjacent runs with identical formatting (DOCX only, default: true)",
    )
    ap.add_argument(
        "--simplify-redlines",
        type=lambda v: v.lower() == "true",
        default=True,
        metavar="true|false",
        help="Merge adjacent tracked changes from same author (DOCX only, default: true)",
    )
    cli = ap.parse_args()

    _, message = unpack(
        cli.input_file,
        cli.output_directory,
        merge_runs=cli.merge_runs,
        simplify_redlines=cli.simplify_redlines,
    )
    print(message)

    if "Error" in message:
        sys.exit(1)
