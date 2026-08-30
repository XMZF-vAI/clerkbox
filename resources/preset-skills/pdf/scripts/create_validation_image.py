"""Overlay colored rectangles on a page image to visualize field bounding boxes.

Usage:
    python create_validation_image.py <page_number> <fields.json> <input_image> <output_image>
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

from PIL import Image as PILImage
from PIL import ImageDraw as PILDraw

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_SUCCESS: int = 0
EXIT_FAILURE: int = 1

ENTRY_OUTLINE_COLOR: str = "red"
LABEL_OUTLINE_COLOR: str = "blue"
OUTLINE_WIDTH: int = 2

# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def generate_overlay(
    target_page: int,
    fields_path: Path,
    src_image: Path,
    dst_image: Path,
) -> None:
    """Draw entry (red) and label (blue) rectangles onto the source image
    for all fields matching *target_page*, then save to *dst_image*.
    """
    with open(fields_path, "r", encoding="utf-8") as fh:
        spec: Dict[str, Any] = json.load(fh)

    canvas = PILImage.open(str(src_image))
    pen = PILDraw.Draw(canvas)
    box_count: int = 0

    matching: List[Dict[str, Any]] = [
        f for f in spec["form_fields"] if f["page_number"] == target_page
    ]
    for fld in matching:
        pen.rectangle(
            fld["entry_bounding_box"],
            outline=ENTRY_OUTLINE_COLOR,
            width=OUTLINE_WIDTH,
        )
        pen.rectangle(
            fld["label_bounding_box"],
            outline=LABEL_OUTLINE_COLOR,
            width=OUTLINE_WIDTH,
        )
        box_count += 2

    canvas.save(str(dst_image))
    print(
        "Created validation image at {} with {} bounding boxes".format(
            dst_image, box_count
        )
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="Visualize field bounding boxes by overlaying colored rectangles on a page image."
    )
    parser.add_argument(
        "page_number",
        type=int,
        help="1-indexed page number to visualize.",
    )
    parser.add_argument(
        "fields_json",
        type=Path,
        help="Path to the fields.json specification file.",
    )
    parser.add_argument(
        "input_image",
        type=Path,
        help="Path to the source page image.",
    )
    parser.add_argument(
        "output_image",
        type=Path,
        help="Destination path for the annotated image.",
    )
    return parser


def main() -> None:
    """Entry point: parse arguments and generate validation overlay."""
    parser = build_parser()
    args = parser.parse_args()

    fields_json: Path = args.fields_json
    input_image: Path = args.input_image

    if not fields_json.exists():
        print("ERROR: File not found: {}".format(fields_json), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    if not input_image.exists():
        print("ERROR: File not found: {}".format(input_image), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    generate_overlay(args.page_number, fields_json, input_image, args.output_image)


if __name__ == "__main__":
    main()
