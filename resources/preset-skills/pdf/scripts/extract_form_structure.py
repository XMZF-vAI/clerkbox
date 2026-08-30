"""Analyze non-fillable PDF layout to discover text elements, ruling lines,
and checkbox-like rectangles.

Produces a JSON manifest for downstream coordinate-based form filling.

Usage:
    python extract_form_structure.py <input.pdf> <output.json>
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import pdfplumber

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_SUCCESS: int = 0
EXIT_FAILURE: int = 1

# Constraints for identifying checkbox-shaped rectangles
CHECKBOX_MIN_SIZE: float = 5.0
CHECKBOX_MAX_SIZE: float = 15.0
CHECKBOX_ASPECT_TOLERANCE: float = 2.0

# Minimum fraction of page width for a line to be considered "spanning"
SPANNING_LINE_RATIO: float = 0.5

COORDINATE_PRECISION: int = 1

# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------


def _is_checkbox_rect(rect_obj: Dict[str, Any]) -> bool:
    """Return True if the rectangle resembles a checkbox (small, roughly square)."""
    w: float = float(rect_obj["x1"]) - float(rect_obj["x0"])
    h: float = float(rect_obj["bottom"]) - float(rect_obj["top"])
    size_ok = (
        CHECKBOX_MIN_SIZE <= w <= CHECKBOX_MAX_SIZE
        and CHECKBOX_MIN_SIZE <= h <= CHECKBOX_MAX_SIZE
    )
    square_ok = abs(w - h) < CHECKBOX_ASPECT_TOLERANCE
    return size_ok and square_ok


def _is_spanning_line(line_obj: Dict[str, Any], page_width: float) -> bool:
    """Return True if the line covers more than half the page width."""
    span: float = abs(float(line_obj["x1"]) - float(line_obj["x0"]))
    return span > page_width * SPANNING_LINE_RATIO


# ---------------------------------------------------------------------------
# Core analysis
# ---------------------------------------------------------------------------


def analyze_pdf_layout(pdf_path: Path) -> Dict[str, Any]:
    """Open a PDF and extract structural elements.

    Extracts words, long horizontal lines, and small square rectangles
    (checkboxes). Returns a dict of categorized data.
    """
    result: Dict[str, Any] = {
        "pages": [],
        "labels": [],
        "lines": [],
        "checkboxes": [],
        "row_boundaries": [],
    }

    with pdfplumber.open(str(pdf_path)) as doc:
        for pg_num, pg in enumerate(doc.pages, start=1):
            result["pages"].append({
                "page_number": pg_num,
                "width": float(pg.width),
                "height": float(pg.height),
            })

            # Collect word-level text elements
            for word in pg.extract_words():
                result["labels"].append({
                    "page": pg_num,
                    "text": word["text"],
                    "x0": round(float(word["x0"]), COORDINATE_PRECISION),
                    "top": round(float(word["top"]), COORDINATE_PRECISION),
                    "x1": round(float(word["x1"]), COORDINATE_PRECISION),
                    "bottom": round(float(word["bottom"]), COORDINATE_PRECISION),
                })

            # Collect long horizontal rules
            for ln in pg.lines:
                if _is_spanning_line(ln, pg.width):
                    result["lines"].append({
                        "page": pg_num,
                        "y": round(float(ln["top"]), COORDINATE_PRECISION),
                        "x0": round(float(ln["x0"]), COORDINATE_PRECISION),
                        "x1": round(float(ln["x1"]), COORDINATE_PRECISION),
                    })

            # Collect checkbox-like rectangles
            for rect in pg.rects:
                if _is_checkbox_rect(rect):
                    x0v: float = float(rect["x0"])
                    x1v: float = float(rect["x1"])
                    topv: float = float(rect["top"])
                    botv: float = float(rect["bottom"])
                    result["checkboxes"].append({
                        "page": pg_num,
                        "x0": round(x0v, COORDINATE_PRECISION),
                        "top": round(topv, COORDINATE_PRECISION),
                        "x1": round(x1v, COORDINATE_PRECISION),
                        "bottom": round(botv, COORDINATE_PRECISION),
                        "center_x": round((x0v + x1v) / 2, COORDINATE_PRECISION),
                        "center_y": round((topv + botv) / 2, COORDINATE_PRECISION),
                    })

    # Derive row boundaries from horizontal lines
    _compute_row_boundaries(result)

    return result


def _compute_row_boundaries(result: Dict[str, Any]) -> None:
    """Derive row boundary intervals from collected horizontal lines."""
    per_page_ys: Dict[int, List[float]] = {}
    for ln in result["lines"]:
        per_page_ys.setdefault(ln["page"], []).append(ln["y"])

    for pg_key, ys in per_page_ys.items():
        sorted_ys = sorted(set(ys))
        for k in range(len(sorted_ys) - 1):
            result["row_boundaries"].append({
                "page": pg_key,
                "row_top": sorted_ys[k],
                "row_bottom": sorted_ys[k + 1],
                "row_height": round(
                    sorted_ys[k + 1] - sorted_ys[k], COORDINATE_PRECISION
                ),
            })


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description=(
            "Analyze PDF layout structure: text labels, ruling lines, "
            "and checkbox shapes."
        )
    )
    parser.add_argument(
        "input_pdf",
        type=Path,
        help="Path to the source PDF to analyze.",
    )
    parser.add_argument(
        "output_json",
        type=Path,
        help="Destination path for the JSON structure output.",
    )
    return parser


def main() -> None:
    """Entry point: parse arguments and run layout analysis."""
    parser = build_parser()
    args = parser.parse_args()

    input_pdf: Path = args.input_pdf
    output_json: Path = args.output_json

    if not input_pdf.exists():
        print("ERROR: File not found: {}".format(input_pdf), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    print("Extracting structure from %s..." % input_pdf)
    data = analyze_pdf_layout(input_pdf)

    with open(output_json, "w", encoding="utf-8") as out:
        json.dump(data, out, indent=2)

    print("Found:")
    print("  - %d pages" % len(data["pages"]))
    print("  - %d text labels" % len(data["labels"]))
    print("  - %d horizontal lines" % len(data["lines"]))
    print("  - %d checkboxes" % len(data["checkboxes"]))
    print("  - %d row boundaries" % len(data["row_boundaries"]))
    print("Saved to %s" % output_json)


if __name__ == "__main__":
    main()
