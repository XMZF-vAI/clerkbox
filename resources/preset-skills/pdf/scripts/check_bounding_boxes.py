"""Validate geometric constraints of form field bounding regions.

Detects overlapping bounding boxes and entry regions too small for their
specified font size.

Usage:
    python check_bounding_boxes.py <fields.json>
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, TextIO, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_SUCCESS: int = 0
EXIT_FAILURE: int = 1

MAX_REPORTED_ISSUES: int = 20

BoundingBox = Tuple[float, float, float, float]

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


class FieldRegion:
    """Encapsulates a rectangle associated with a specific form field."""

    __slots__ = ("bounds", "kind", "parent_field")

    def __init__(
        self,
        bounds: List[float],
        kind: str,
        parent_field: Dict[str, Any],
    ) -> None:
        self.bounds = bounds
        self.kind = kind
        self.parent_field = parent_field


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def _do_overlap(box_a: List[float], box_b: List[float]) -> bool:
    """Determine whether two axis-aligned rectangles share any area."""
    separated_x: bool = box_a[0] >= box_b[2] or box_b[0] >= box_a[2]
    separated_y: bool = box_a[1] >= box_b[3] or box_b[1] >= box_a[3]
    return not separated_x and not separated_y


def _height_too_small(region: FieldRegion) -> bool:
    """Check if an entry region is vertically insufficient for its text."""
    if "entry_text" not in region.parent_field:
        return False
    font_size: float = region.parent_field["entry_text"].get("font_size", 14)
    height: float = region.bounds[3] - region.bounds[1]
    return height < font_size


# ---------------------------------------------------------------------------
# Core validation
# ---------------------------------------------------------------------------


def validate_field_geometry(input_stream: TextIO) -> List[str]:
    """Analyze all field bounding boxes from the given JSON stream.

    Returns a list of diagnostic strings.
    """
    doc: Dict[str, Any] = json.load(input_stream)
    form_entries: List[Dict[str, Any]] = doc["form_fields"]
    diagnostics: List[str] = ["Read %d fields" % len(form_entries)]

    # Build flat list of all regions
    all_regions: List[FieldRegion] = []
    for entry in form_entries:
        all_regions.append(
            FieldRegion(entry["label_bounding_box"], "label", entry)
        )
        all_regions.append(
            FieldRegion(entry["entry_bounding_box"], "entry", entry)
        )

    found_problem: bool = False
    idx: int = 0

    while idx < len(all_regions):
        ri = all_regions[idx]

        # Check pairwise overlaps with subsequent regions
        for jdx in range(idx + 1, len(all_regions)):
            rj = all_regions[jdx]
            if ri.parent_field["page_number"] != rj.parent_field["page_number"]:
                continue
            if not _do_overlap(ri.bounds, rj.bounds):
                continue

            found_problem = True
            if ri.parent_field is rj.parent_field:
                msg = (
                    "FAILURE: intersection between label and entry "
                    "bounding boxes for `{}` ({}, {})".format(
                        ri.parent_field["description"], ri.bounds, rj.bounds
                    )
                )
            else:
                msg = (
                    "FAILURE: intersection between {} bounding box for "
                    "`{}` ({}) and {} bounding box for `{}` ({})".format(
                        ri.kind,
                        ri.parent_field["description"],
                        ri.bounds,
                        rj.kind,
                        rj.parent_field["description"],
                        rj.bounds,
                    )
                )
            diagnostics.append(msg)
            if len(diagnostics) >= MAX_REPORTED_ISSUES:
                diagnostics.append(
                    "Aborting further checks; fix bounding boxes and try again"
                )
                return diagnostics

        # Height validation for entry regions
        if ri.kind == "entry" and _height_too_small(ri):
            found_problem = True
            height: float = ri.bounds[3] - ri.bounds[1]
            font_size = ri.parent_field["entry_text"].get("font_size", 14)
            diagnostics.append(
                "FAILURE: entry bounding box height ({}) for `{}` is too short "
                "for the text content (font size: {}). Increase the box height "
                "or decrease the font size.".format(
                    height, ri.parent_field["description"], font_size
                )
            )
            if len(diagnostics) >= MAX_REPORTED_ISSUES:
                diagnostics.append(
                    "Aborting further checks; fix bounding boxes and try again"
                )
                return diagnostics

        idx += 1

    if not found_problem:
        diagnostics.append("SUCCESS: All bounding boxes are valid")
    return diagnostics


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description=(
            "Validate bounding box geometry in a fields.json specification. "
            "Detects overlaps and insufficient entry heights."
        )
    )
    parser.add_argument(
        "fields_json",
        type=Path,
        help="Path to the fields.json file to validate.",
    )
    return parser


def main() -> None:
    """Entry point: parse arguments and run geometry validation."""
    parser = build_parser()
    args = parser.parse_args()

    fields_json: Path = args.fields_json
    if not fields_json.exists():
        print("ERROR: File not found: {}".format(fields_json), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    with open(fields_json, "r", encoding="utf-8") as handle:
        results = validate_field_geometry(handle)

    for line in results:
        print(line)


if __name__ == "__main__":
    main()
