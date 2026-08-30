"""Place text onto a PDF using FreeText annotations, guided by a JSON
coordinate specification.

Supports both image-pixel and native PDF coordinate inputs with automatic
conversion.

Usage:
    python fill_pdf_form_with_annotations.py <input.pdf> <fields.json> <output.pdf>
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pypdf
from pypdf.annotations import FreeText as TextAnnotation

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXIT_SUCCESS: int = 0
EXIT_FAILURE: int = 1

DEFAULT_FONT: str = "Arial"
DEFAULT_SIZE: int = 14
DEFAULT_COLOR: str = "000000"

# ---------------------------------------------------------------------------
# Coordinate transformation
# ---------------------------------------------------------------------------


def _pixel_to_pdf_rect(
    box: List[float],
    img_w: float,
    img_h: float,
    doc_w: float,
    doc_h: float,
) -> Tuple[float, float, float, float]:
    """Map image-space pixel coordinates to PDF annotation coordinates."""
    sx: float = doc_w / img_w
    sy: float = doc_h / img_h
    pdf_left: float = box[0] * sx
    pdf_right: float = box[2] * sx
    pdf_top: float = doc_h - (box[1] * sy)
    pdf_bottom: float = doc_h - (box[3] * sy)
    return pdf_left, pdf_bottom, pdf_right, pdf_top


def _native_to_pypdf_rect(
    box: List[float],
    doc_h: float,
) -> Tuple[float, float, float, float]:
    """Convert PDF-native coordinates (y=0 at top) to pypdf annotation rect."""
    left: float = box[0]
    right: float = box[2]
    pypdf_top: float = doc_h - box[1]
    pypdf_bottom: float = doc_h - box[3]
    return left, pypdf_bottom, right, pypdf_top


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def annotate_pdf(src_path: Path, spec_path: Path, out_path: Path) -> None:
    """Read the coordinate spec, add FreeText annotations to each field,
    and write the result to *out_path*.
    """
    with open(spec_path, "r", encoding="utf-8") as fh:
        spec: Dict[str, Any] = json.load(fh)

    source = pypdf.PdfReader(str(src_path))
    output = pypdf.PdfWriter()
    output.append(source)

    # Cache actual page dimensions from the source PDF
    actual_dims: Dict[int, Tuple[float, float]] = {}
    for idx, pg in enumerate(source.pages):
        mb = pg.mediabox
        actual_dims[idx + 1] = (float(mb.width), float(mb.height))

    annotation_count: int = 0

    for fld in spec["form_fields"]:
        pg_num: int = fld["page_number"]
        pg_meta: Dict[str, Any] = next(
            p for p in spec["pages"] if p["page_number"] == pg_num
        )
        real_w, real_h = actual_dims[pg_num]

        # Determine coordinate system and transform
        use_pdf_coords: bool = "pdf_width" in pg_meta
        if use_pdf_coords:
            rect = _native_to_pypdf_rect(fld["entry_bounding_box"], real_h)
        else:
            rect = _pixel_to_pdf_rect(
                fld["entry_bounding_box"],
                pg_meta["image_width"],
                pg_meta["image_height"],
                real_w,
                real_h,
            )

        # Skip fields without text content
        txt_spec = fld.get("entry_text")
        if txt_spec is None or "text" not in txt_spec:
            continue
        content: str = txt_spec["text"]
        if not content:
            continue

        # Build annotation with styling
        face: str = txt_spec.get("font", DEFAULT_FONT)
        size_str: str = "%spt" % txt_spec.get("font_size", DEFAULT_SIZE)
        color: str = txt_spec.get("font_color", DEFAULT_COLOR)

        ann = TextAnnotation(
            text=content,
            rect=rect,
            font=face,
            font_size=size_str,
            font_color=color,
            border_color=None,
            background_color=None,
        )
        output.add_annotation(page_number=pg_num - 1, annotation=ann)
        annotation_count += 1

    with open(out_path, "wb") as dest:
        output.write(dest)

    print("Successfully filled PDF form and saved to %s" % out_path)
    print("Added %d text annotations" % annotation_count)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description=(
            "Fill a PDF form by placing FreeText annotations at coordinates "
            "specified in a JSON file."
        )
    )
    parser.add_argument(
        "input_pdf",
        type=Path,
        help="Path to the source PDF document.",
    )
    parser.add_argument(
        "fields_json",
        type=Path,
        help="JSON specification with field coordinates and text.",
    )
    parser.add_argument(
        "output_pdf",
        type=Path,
        help="Destination path for the annotated PDF.",
    )
    return parser


def main() -> None:
    """Entry point: parse arguments and annotate PDF."""
    parser = build_parser()
    args = parser.parse_args()

    input_pdf: Path = args.input_pdf
    fields_json: Path = args.fields_json
    output_pdf: Path = args.output_pdf

    if not input_pdf.exists():
        print("ERROR: File not found: {}".format(input_pdf), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    if not fields_json.exists():
        print("ERROR: File not found: {}".format(fields_json), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    annotate_pdf(input_pdf, fields_json, output_pdf)


if __name__ == "__main__":
    main()
