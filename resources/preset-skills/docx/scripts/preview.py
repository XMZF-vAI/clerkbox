#!/usr/bin/env python3
"""Render .docx pages to JPEG for visual self-check (requires LibreOffice).

Converts the docx to PDF via LibreOffice, then rasterizes selected pages with
pdftoppm. Use this before delivering any multi-page or table-heavy document to
catch margin overflow, squeezed tables, missing fonts, or empty TOC fields.

Usage:
  python preview.py output.docx --pages 1,2,last --dpi 120
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import glob


def find_soffice():
    for name in ("soffice", "libreoffice"):
        p = shutil.which(name)
        if p:
            return p
    # common Windows install path
    for c in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ):
        if os.path.isfile(c):
            return c
    return None


def main():
    ap = argparse.ArgumentParser(description="Render docx pages to JPEG")
    ap.add_argument("docx", help="input .docx")
    ap.add_argument("--pages", default="1", help="comma list, e.g. 1,2,last (default 1)")
    ap.add_argument("--dpi", type=int, default=120)
    ap.add_argument("--outdir", default=None, help="where to write JPEGs (default: alongside docx)")
    args = ap.parse_args()

    if not os.path.isfile(args.docx):
        print(f"ERROR: not found: {args.docx}", file=sys.stderr)
        return 2

    soffice = find_soffice()
    if not soffice:
        print("ERROR: LibreOffice (soffice) not found; preview unavailable.", file=sys.stderr)
        print("Install: see `python doctor.py` for the per-platform command.", file=sys.stderr)
        return 2
    if not shutil.which("pdftoppm"):
        print("ERROR: pdftoppm (poppler) not found.", file=sys.stderr)
        return 2

    outdir = args.outdir or os.path.dirname(os.path.abspath(args.docx)) or "."
    os.makedirs(outdir, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="docxpro_prev_")
    try:
        # docx -> pdf
        subprocess.run(
            [soffice, "--headless", "--convert-to", "pdf", "--outdir", tmp, args.docx],
            check=True, capture_output=True, text=True, timeout=180,
        )
        pdf = glob.glob(os.path.join(tmp, "*.pdf"))
        if not pdf:
            print("ERROR: PDF conversion produced no file.", file=sys.stderr)
            return 1
        pdf = pdf[0]

        # determine page count via pdfinfo if available, else fallback
        total = None
        if shutil.which("pdfinfo"):
            info = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True)
            for ln in info.stdout.splitlines():
                if ln.lower().startswith("pages:"):
                    total = int(ln.split(":")[1].strip())

        base = os.path.splitext(os.path.basename(args.docx))[0]
        wanted = []
        for tok in args.pages.split(","):
            tok = tok.strip().lower()
            if tok == "last":
                wanted.append(total if total else 1)
            elif tok.isdigit():
                wanted.append(int(tok))
        wanted = sorted(set(p for p in wanted if p >= 1))

        written = []
        for pg in wanted:
            prefix = os.path.join(outdir, f"{base}_p{pg}")
            subprocess.run(
                ["pdftoppm", "-jpeg", "-r", str(args.dpi),
                 "-f", str(pg), "-l", str(pg), pdf, prefix],
                check=True, capture_output=True, text=True,
            )
            for f in glob.glob(prefix + "*"):
                written.append(f)

        if written:
            print("OK: wrote preview images:")
            for f in sorted(written):
                print("  " + f)
            print("Now open these images and check layout before delivering.")
        else:
            print("WARNING: no preview images produced.")
        return 0
    except subprocess.TimeoutExpired:
        print("ERROR: LibreOffice conversion timed out (>=180s).", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as e:
        print("ERROR:", e.stderr or e, file=sys.stderr)
        return 1
    except Exception as e:
        print(f"ERROR: unexpected failure during preview: {e}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
