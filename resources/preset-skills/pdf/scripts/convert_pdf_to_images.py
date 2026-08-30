"""Render each page of a PDF document as a PNG image file.

Usage:
    python convert_pdf_to_images.py <input.pdf> <output_directory>
"""

import argparse
import sys
from pathlib import Path
from typing import List

import pdf2image
from PIL import Image

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_SUCCESS: int = 0
EXIT_FAILURE: int = 1

RENDER_DPI: int = 200
DEFAULT_MAX_DIMENSION: int = 1000

OUTPUT_FORMAT: str = "png"
FILENAME_TEMPLATE: str = "page_{}.png"

# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def render_pages_to_png(
    source_pdf: Path,
    dest_folder: Path,
    dimension_cap: int = DEFAULT_MAX_DIMENSION,
) -> None:
    """Convert all pages in *source_pdf* to PNG files within *dest_folder*."""
    rendered: List[Image.Image] = pdf2image.convert_from_path(
        str(source_pdf), dpi=RENDER_DPI
    )

    for page_idx, img in enumerate(rendered):
        w, h = img.size
        needs_resize: bool = w > dimension_cap or h > dimension_cap
        if needs_resize:
            ratio: float = min(dimension_cap / w, dimension_cap / h)
            resized_w: int = int(w * ratio)
            resized_h: int = int(h * ratio)
            img = img.resize((resized_w, resized_h))

        out_path: Path = dest_folder / FILENAME_TEMPLATE.format(page_idx + 1)
        img.save(str(out_path))
        print(
            "Saved page %d as %s (size: %s)"
            % (page_idx + 1, out_path, str(img.size))
        )

    print("Converted %d pages to PNG images" % len(rendered))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="Render PDF pages as PNG image files."
    )
    parser.add_argument(
        "input_pdf",
        type=Path,
        help="Path to the source PDF document.",
    )
    parser.add_argument(
        "output_directory",
        type=Path,
        help="Directory to write PNG page images into.",
    )
    return parser


def main() -> None:
    """Entry point: parse arguments, create output dir, render pages."""
    parser = build_parser()
    args = parser.parse_args()

    input_pdf: Path = args.input_pdf
    output_dir: Path = args.output_directory

    if not input_pdf.exists():
        print("ERROR: File not found: {}".format(input_pdf), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    output_dir.mkdir(parents=True, exist_ok=True)
    render_pages_to_png(input_pdf, output_dir)


if __name__ == "__main__":
    main()
