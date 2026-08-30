"""Introspect fillable PDF form fields and serialize their metadata to JSON.

Supports text inputs, checkboxes, radio button groups, and dropdown choices.

Usage:
    python extract_form_field_info.py <input.pdf> <output.json>
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import pypdf

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_SUCCESS: int = 0
EXIT_FAILURE: int = 1

FIELD_TYPE_TEXT: str = "text"
FIELD_TYPE_CHECKBOX: str = "checkbox"
FIELD_TYPE_RADIO: str = "radio_group"
FIELD_TYPE_CHOICE: str = "choice"

PDF_FT_TEXT: str = "/Tx"
PDF_FT_BUTTON: str = "/Btn"
PDF_FT_CHOICE: str = "/Ch"

OFF_STATE: str = "/Off"

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _resolve_qualified_name(annot_obj: Any) -> Optional[str]:
    """Walk the /Parent chain to assemble a dot-separated field identifier."""
    parts: List[str] = []
    node = annot_obj
    while node is not None:
        name_component = node.get("/T")
        if name_component:
            parts.append(name_component)
        node = node.get("/Parent")
    return ".".join(reversed(parts)) if parts else None


def _build_field_descriptor(raw_field: Any, identifier: str) -> Dict[str, Any]:
    """Construct a typed descriptor dict from a raw PDF field object."""
    descriptor: Dict[str, Any] = {"field_id": identifier}
    field_type_code = raw_field.get("/FT")

    if field_type_code == PDF_FT_TEXT:
        descriptor["type"] = FIELD_TYPE_TEXT

    elif field_type_code == PDF_FT_BUTTON:
        descriptor["type"] = FIELD_TYPE_CHECKBOX
        available_states = raw_field.get("/_States_", [])
        if len(available_states) == 2:
            off_present = OFF_STATE in available_states
            if off_present:
                on_val = (
                    available_states[0]
                    if available_states[0] != OFF_STATE
                    else available_states[1]
                )
                descriptor["checked_value"] = on_val
                descriptor["unchecked_value"] = OFF_STATE
            else:
                print(
                    "Unexpected state values for checkbox `$%s`. "
                    "Its checked and unchecked values may not be correct; "
                    "if you're trying to check it, visually verify the results."
                    % identifier
                )
                descriptor["checked_value"] = available_states[0]
                descriptor["unchecked_value"] = available_states[1]

    elif field_type_code == PDF_FT_CHOICE:
        descriptor["type"] = FIELD_TYPE_CHOICE
        available_states = raw_field.get("/_States_", [])
        descriptor["choice_options"] = [
            {"value": opt[0], "text": opt[1]} for opt in available_states
        ]

    else:
        descriptor["type"] = "unknown (%s)" % field_type_code

    return descriptor


def _ordering_key(item: Dict[str, Any]) -> List[Any]:
    """Produce a sort key: page number, then top-to-bottom left-to-right."""
    if "radio_options" in item:
        rect = item["radio_options"][0]["rect"] or [0, 0, 0, 0]
    else:
        rect = item.get("rect") or [0, 0, 0, 0]
    return [item.get("page"), [-rect[1], rect[0]]]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_field_info(pdf_reader: pypdf.PdfReader) -> List[Dict[str, Any]]:
    """Extract structured field metadata from all form fields in the document.

    Returns a sorted list of field descriptors with page/rect info.
    """
    raw_fields = pdf_reader.get_fields()
    if not raw_fields:
        return []

    descriptors_map: Dict[str, Dict[str, Any]] = {}
    candidate_radio_ids: Set[str] = set()

    for fid, fobj in raw_fields.items():
        if fobj.get("/Kids"):
            if fobj.get("/FT") == PDF_FT_BUTTON:
                candidate_radio_ids.add(fid)
            continue
        descriptors_map[fid] = _build_field_descriptor(fobj, fid)

    radio_groups: Dict[str, Dict[str, Any]] = {}

    for pg_idx, pg in enumerate(pdf_reader.pages):
        annot_list = pg.get("/Annots", [])
        for annot in annot_list:
            qualified = _resolve_qualified_name(annot)
            if qualified in descriptors_map:
                descriptors_map[qualified]["page"] = pg_idx + 1
                descriptors_map[qualified]["rect"] = annot.get("/Rect")
            elif qualified in candidate_radio_ids:
                try:
                    active_vals = [
                        k for k in annot["/AP"]["/N"] if k != OFF_STATE
                    ]
                except KeyError:
                    continue
                if len(active_vals) != 1:
                    continue
                rect_val = annot.get("/Rect")
                if qualified not in radio_groups:
                    radio_groups[qualified] = {
                        "field_id": qualified,
                        "type": FIELD_TYPE_RADIO,
                        "page": pg_idx + 1,
                        "radio_options": [],
                    }
                radio_groups[qualified]["radio_options"].append({
                    "value": active_vals[0],
                    "rect": rect_val,
                })

    # Filter out fields without a determined page location
    located = [d for d in descriptors_map.values() if "page" in d]
    for orphan in descriptors_map.values():
        if "page" not in orphan:
            print(
                "Unable to determine location for field id: %s, ignoring"
                % orphan.get("field_id")
            )

    combined = located + list(radio_groups.values())
    combined.sort(key=_ordering_key)
    return combined


def serialize_field_info(pdf_file: Path, output_json: Path) -> None:
    """Read the PDF and write field info as JSON."""
    reader = pypdf.PdfReader(str(pdf_file))
    info = get_field_info(reader)
    with open(output_json, "w", encoding="utf-8") as fp:
        json.dump(info, fp, indent=2)
    print("Wrote %d fields to %s" % (len(info), output_json))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="Extract fillable form field metadata from a PDF to JSON."
    )
    parser.add_argument(
        "input_pdf",
        type=Path,
        help="Path to the source PDF with form fields.",
    )
    parser.add_argument(
        "output_json",
        type=Path,
        help="Destination path for the JSON output.",
    )
    return parser


def main() -> None:
    """Entry point: parse arguments and run extraction."""
    parser = build_parser()
    args = parser.parse_args()

    input_pdf: Path = args.input_pdf
    if not input_pdf.exists():
        print("ERROR: File not found: {}".format(input_pdf), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    serialize_field_info(input_pdf, args.output_json)


if __name__ == "__main__":
    main()
