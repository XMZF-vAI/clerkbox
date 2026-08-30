#!/usr/bin/env python3
"""Markdown -> .docx via pandoc (preferred engine).

Handles relative image paths, optional Table of Contents, and a reference
document for styling. If pandoc is unavailable, this script tells you to use
the Node fallback (scripts/md_to_docx.mjs) instead.

Usage:
  python md_to_docx.py input.md output.docx [--reference templates/report-standard.docx] [--toc]
"""
import argparse
import os
import shutil
import subprocess
import sys


def main():
    ap = argparse.ArgumentParser(description="Markdown -> docx via pandoc")
    ap.add_argument("input", help="input Markdown file")
    ap.add_argument("output", help="output .docx file")
    ap.add_argument("--reference", help="reference .docx for styling", default=None)
    ap.add_argument("--toc", action="store_true", help="insert a Table of Contents")
    ap.add_argument("--toc-depth", type=int, default=3, help="TOC heading depth (default 3)")
    args = ap.parse_args()

    if not shutil.which("pandoc"):
        print("ERROR: pandoc not found.", file=sys.stderr)
        print("Use the Node fallback instead:", file=sys.stderr)
        print(f"  node scripts/md_to_docx.mjs {args.input} {args.output} --cjk", file=sys.stderr)
        return 2

    if not os.path.isfile(args.input):
        print(f"ERROR: input not found: {args.input}", file=sys.stderr)
        return 2

    # Resolve images relative to the Markdown file's directory.
    md_dir = os.path.dirname(os.path.abspath(args.input)) or "."

    cmd = [
        "pandoc", args.input,
        "-f", "markdown+pipe_tables+yaml_metadata_block",
        "-o", args.output,
        "--resource-path", md_dir,
    ]
    if args.toc:
        cmd += ["--toc", f"--toc-depth={args.toc_depth}"]
    if args.reference:
        if not os.path.isfile(args.reference):
            print(f"ERROR: reference doc not found: {args.reference}", file=sys.stderr)
            return 2
        cmd += [f"--reference-doc={args.reference}"]

    print("Running:", " ".join(cmd))
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stderr, file=sys.stderr)
        return res.returncode

    print(f"OK: wrote {args.output}")
    print("Next: validate + preview")
    print(f"  python scripts/office/validate.py {args.output}")
    print(f"  python scripts/preview.py {args.output} --pages 1,2,last")
    return 0


if __name__ == "__main__":
    sys.exit(main())
