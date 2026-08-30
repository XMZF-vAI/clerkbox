"""Detect whether a PDF document contains interactive form fields.

Usage:
    python check_fillable_fields.py <pdf_path>

Outputs a human-readable message indicating whether the document
has native fillable form widgets.
"""

import argparse
import sys
from pathlib import Path

import pypdf


EXIT_SUCCESS: int = 0
EXIT_FAILURE: int = 1

MSG_HAS_FIELDS: str = "This PDF has fillable form fields"
MSG_NO_FIELDS: str = (
    "This PDF does not have fillable form fields; "
    "you will need to visually determine where to enter data"
)


def check_fillable(pdf_path: Path) -> bool:
    """Return True if the PDF at *pdf_path* contains interactive form fields."""
    reader = pypdf.PdfReader(str(pdf_path))
    return bool(reader.get_fields())


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI argument parser."""
    parser = argparse.ArgumentParser(
        description="Detect whether a PDF contains interactive form fields."
    )
    parser.add_argument(
        "pdf_path",
        type=Path,
        help="Path to the PDF document to inspect.",
    )
    return parser


def main() -> None:
    """Entry point: parse arguments, inspect PDF, print result."""
    parser = build_parser()
    args = parser.parse_args()

    pdf_path: Path = args.pdf_path
    if not pdf_path.exists():
        print("ERROR: File not found: {}".format(pdf_path), file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    has_fields = check_fillable(pdf_path)
    if has_fields:
        print(MSG_HAS_FIELDS)
    else:
        print(MSG_NO_FIELDS)


if __name__ == "__main__":
    main()
