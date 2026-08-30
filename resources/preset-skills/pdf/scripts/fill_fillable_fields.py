"""Populate interactive PDF form fields with values specified in a JSON manifest.

Validates field IDs, page numbers, and value constraints before writing.

Usage:
    python fill_fillable_fields.py <input.pdf> <field_values.json> <output.pdf>
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pypdf

from extract_form_field_info import get_field_info

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_SUCCESS: int = 0
EXIT_FAILURE: int = 1

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _check_value_constraint(descriptor: Dict[str, Any], val: str) -> Optional[str]:
    """Verify that *val* is acceptable for the given field descriptor.

    Returns an error string or None if valid.
    """
    ftype: str = descriptor["type"]
    fid: str = descriptor["field_id"]

    if ftype == "checkbox":
        on_val: str = descriptor["checked_value"]
        off_val: str = descriptor["unchecked_value"]
        if val != on_val and val != off_val:
            return (
                'ERROR: Invalid value "%s" for checkbox field "%s". '
                'The checked value is "%s" and the unchecked value is "%s"'
                % (val, fid, on_val, off_val)
            )

    elif ftype == "radio_group":
        allowed: List[str] = [o["value"] for o in descriptor["radio_options"]]
        if val not in allowed:
            return (
                'ERROR: Invalid value "%s" for radio group field "%s". '
                "Valid values are: %s" % (val, fid, allowed)
            )

    elif ftype == "choice":
        allowed = [o["value"] for o in descriptor["choice_options"]]
        if val not in allowed:
            return (
                'ERROR: Invalid value "%s" for choice field "%s". '
                "Valid values are: %s" % (val, fid, allowed)
            )

    return None


# ---------------------------------------------------------------------------
# pypdf compatibility patch
# ---------------------------------------------------------------------------


def _apply_pypdf_option_patch() -> None:
    """Monkey-patch pypdf to handle two-element option arrays correctly.

    Some PDFs encode choices as [[export_value, display_text], ...].
    """
    from pypdf.generic import DictionaryObject
    from pypdf.constants import FieldDictionaryAttributes

    _orig = DictionaryObject.get_inherited

    def _patched(self: Any, key: str, default: Any = None) -> Any:
        out = _orig(self, key, default)
        if key == FieldDictionaryAttributes.Opt:
            if isinstance(out, list) and all(
                isinstance(v, list) and len(v) == 2 for v in out
            ):
                out = [pair[0] for pair in out]
        return out

    DictionaryObject.get_inherited = _patched


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def populate_fields(src_pdf: Path, values_json: Path, dest_pdf: Path) -> None:
    """Read field values from *values_json*, validate against the PDF's actual
    fields, then write the filled output to *dest_pdf*.
    """
    with open(values_json, "r", encoding="utf-8") as fh:
        requested: List[Dict[str, Any]] = json.load(fh)

    # Group values by page
    page_map: Dict[int, Dict[str, str]] = {}
    for item in requested:
        if "value" not in item:
            continue
        page_map.setdefault(item["page"], {})[item["field_id"]] = item["value"]

    reader = pypdf.PdfReader(str(src_pdf))

    # Validate all entries
    known_fields = get_field_info(reader)
    lookup: Dict[str, Dict[str, Any]] = {f["field_id"]: f for f in known_fields}
    error_found: bool = False

    for item in requested:
        fid: str = item["field_id"]
        existing = lookup.get(fid)
        if existing is None:
            error_found = True
            print("ERROR: `%s` is not a valid field ID" % fid)
        elif item["page"] != existing["page"]:
            error_found = True
            print(
                "ERROR: Incorrect page number for `%s` (got %s, expected %s)"
                % (fid, item["page"], existing["page"])
            )
        elif "value" in item:
            err = _check_value_constraint(existing, item["value"])
            if err:
                print(err)
                error_found = True

    if error_found:
        sys.exit(EXIT_FAILURE)

    # Write filled PDF
    writer = pypdf.PdfWriter(clone_from=reader)
    for pg_num, vals in page_map.items():
        writer.update_page_form_field_values(
            writer.pages[pg_num - 1], vals, auto_regenerate=False
        )

    writer.set_need_appearances_writer(True)

    with open(dest_pdf, "wb") as out:
        writer.write(out)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="Fill interactive PDF form fields using a JSON value manifest."
    )
    parser.add_argument(
        "input_pdf",
        type=Path,
        help="Path to the source PDF with form fields.",
    )
    parser.add_argument(
        "field_values_json",
        type=Path,
        help="JSON file specifying field IDs and values.",
    )
    parser.add_argument(
        "output_pdf",
        type=Path,
        help="Destination path for the filled PDF.",
    )
    return parser


def main() -> None:
    """Entry point: parse arguments, apply patch, populate fields."""
    parser = build_parser()
    args = parser.parse_args()

    input_pdf: Path = args.input_pdf
    values_json: Path = args.field_values_json
    output_pdf: Path = args.output_pdf

    if not input_pdf.exists():
        print("ERROR: File not found: {}".format(input_pdf), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    if not values_json.exists():
        print("ERROR: File not found: {}".format(values_json), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    _apply_pypdf_option_patch()
    populate_fields(input_pdf, values_json, output_pdf)


if __name__ == "__main__":
    main()
