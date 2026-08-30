# Advanced PDF Toolkit Reference

This companion document covers advanced capabilities, auxiliary libraries, and specialized workflows beyond the essentials in the primary skill guide.

---

## pypdfium2 (Apache/BSD Licensed)

### About the Library

A Python wrapper around PDFium (the rendering engine inside Chromium). Ideal for high-fidelity page rasterization and serves as an alternative to PyMuPDF.

### Page Rasterization

```python
import pypdfium2 as pdfium
from PIL import Image

doc = pdfium.PdfDocument("document.pdf")

# Render the first page at double resolution
first_page = doc[0]
bmp = first_page.render(scale=2.0, rotation=0)

# Export as PIL image
pil_img = bmp.to_pil()
pil_img.save("page_1.png", "PNG")

# Batch-render every page
for n, pg in enumerate(doc):
    bmp = pg.render(scale=1.5)
    pil_img = bmp.to_pil()
    pil_img.save("page_{}.jpg".format(n + 1), "JPEG", quality=90)
```

### Textual Content Retrieval

```python
import pypdfium2 as pdfium

doc = pdfium.PdfDocument("document.pdf")
for n, pg in enumerate(doc):
    raw = pg.get_text()
    print("Page {} text length: {} chars".format(n + 1, len(raw)))
```

---

## JavaScript Ecosystem

### pdf-lib (MIT Licensed)

A versatile JS library for constructing and editing PDF documents across all JavaScript runtimes.

#### Modifying an Existing Document

```javascript
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';

async function manipulatePDF() {
    const rawBytes = fs.readFileSync('input.pdf');
    const doc = await PDFDocument.load(rawBytes);

    const numPages = doc.getPageCount();
    console.log(`Document has ${numPages} pages`);

    const fresh = doc.addPage([600, 400]);
    fresh.drawText('Added by pdf-lib', {
        x: 100,
        y: 300,
        size: 16
    });

    const output = await doc.save();
    fs.writeFileSync('modified.pdf', output);
}
```

#### Building a Document From Scratch

```javascript
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';

async function createPDF() {
    const doc = await PDFDocument.create();

    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    const sheet = doc.addPage([595, 842]); // A4 dimensions
    const { width, height } = sheet.getSize();

    sheet.drawText('Invoice #12345', {
        x: 50,
        y: height - 50,
        size: 18,
        font: bold,
        color: rgb(0.2, 0.2, 0.8)
    });

    sheet.drawRectangle({
        x: 40,
        y: height - 100,
        width: width - 80,
        height: 30,
        color: rgb(0.9, 0.9, 0.9)
    });

    const rows = [
        ['Item', 'Qty', 'Price', 'Total'],
        ['Widget', '2', '$50', '$100'],
        ['Gadget', '1', '$75', '$75']
    ];

    let cursorY = height - 150;
    rows.forEach(cells => {
        let cursorX = 50;
        cells.forEach(val => {
            sheet.drawText(val, {
                x: cursorX,
                y: cursorY,
                size: 12,
                font: regular
            });
            cursorX += 120;
        });
        cursorY -= 25;
    });

    const bytes = await doc.save();
    fs.writeFileSync('created.pdf', bytes);
}
```

#### Page Selection and Merging

```javascript
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';

async function mergePDFs() {
    const combined = await PDFDocument.create();

    const src1 = await PDFDocument.load(fs.readFileSync('doc1.pdf'));
    const src2 = await PDFDocument.load(fs.readFileSync('doc2.pdf'));

    const allFromFirst = await combined.copyPages(src1, src1.getPageIndices());
    allFromFirst.forEach(p => combined.addPage(p));

    const selectedFromSecond = await combined.copyPages(src2, [0, 2, 4]);
    selectedFromSecond.forEach(p => combined.addPage(p));

    const result = await combined.save();
    fs.writeFileSync('merged.pdf', result);
}
```

### pdfjs-dist (Apache Licensed)

Mozilla's client-side PDF rendering engine.

#### Loading and Rendering

```javascript
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.js';

async function renderPDF() {
    const task = pdfjsLib.getDocument('document.pdf');
    const doc = await task.promise;

    console.log(`Loaded PDF with ${doc.numPages} pages`);

    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1.5 });

    const cvs = document.createElement('canvas');
    const ctx = cvs.getContext('2d');
    cvs.height = vp.height;
    cvs.width = vp.width;

    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    document.body.appendChild(cvs);
}
```

#### Positioned Text Extraction

```javascript
import * as pdfjsLib from 'pdfjs-dist';

async function extractText() {
    const task = pdfjsLib.getDocument('document.pdf');
    const doc = await task.promise;

    let accumulated = '';

    for (let n = 1; n <= doc.numPages; n++) {
        const pg = await doc.getPage(n);
        const tc = await pg.getTextContent();

        const pageStr = tc.items.map(el => el.str).join(' ');
        accumulated += `\n--- Page ${n} ---\n${pageStr}`;

        const positioned = tc.items.map(el => ({
            text: el.str,
            x: el.transform[4],
            y: el.transform[5],
            width: el.width,
            height: el.height
        }));
    }

    console.log(accumulated);
    return accumulated;
}
```

#### Annotation and Form Field Discovery

```javascript
import * as pdfjsLib from 'pdfjs-dist';

async function extractAnnotations() {
    const task = pdfjsLib.getDocument('annotated.pdf');
    const doc = await task.promise;

    for (let n = 1; n <= doc.numPages; n++) {
        const pg = await doc.getPage(n);
        const notes = await pg.getAnnotations();

        notes.forEach(note => {
            console.log(`Annotation type: ${note.subtype}`);
            console.log(`Content: ${note.contents}`);
            console.log(`Coordinates: ${JSON.stringify(note.rect)}`);
        });
    }
}
```

---

## Advanced Shell Operations

### poppler-utils: Deep Features

#### Coordinate-Tagged Text Export

```bash
# Produce XML with precise bounding boxes per text element
pdftotext -bbox-layout document.pdf output.xml

# The XML contains exact spatial data for every text fragment
```

#### High-Fidelity Image Conversion

```bash
# PNG output at 300 DPI
pdftoppm -png -r 300 document.pdf output_prefix

# Selective pages at maximum quality
pdftoppm -png -r 600 -f 1 -l 3 document.pdf high_res_pages

# JPEG with compression control
pdftoppm -jpeg -jpegopt quality=85 -r 200 document.pdf jpeg_output
```

#### Embedded Image Retrieval

```bash
# Dump all images preserving original encoding
pdfimages -j -p document.pdf page_images

# Catalogue images without extraction
pdfimages -list document.pdf

# Native-format extraction
pdfimages -all document.pdf images/img
```

### qpdf: Power Features

#### Sophisticated Page Operations

```bash
# Chunk-split every 3 pages
qpdf --split-pages=3 input.pdf output_group_%02d.pdf

# Complex range expressions
qpdf input.pdf --pages input.pdf 1,3-5,8,10-end -- extracted.pdf

# Cross-document page assembly
qpdf --empty --pages doc1.pdf 1-3 doc2.pdf 5-7 doc3.pdf 2,4 -- combined.pdf
```

#### Optimization and Recovery

```bash
# Web-optimized streaming layout
qpdf --linearize input.pdf optimized.pdf

# Aggressive size reduction
qpdf --optimize-level=all input.pdf compressed.pdf

# Structural integrity check
qpdf --check input.pdf
qpdf --fix-qdf damaged.pdf repaired.pdf

# Dump internal structure
qpdf --show-all-pages input.pdf > structure.txt
```

#### Encryption Management

```bash
# Apply 256-bit encryption with restricted permissions
qpdf --encrypt user_pass owner_pass 256 --print=none --modify=none -- input.pdf encrypted.pdf

# Inspect protection status
qpdf --show-encryption encrypted.pdf

# Strip encryption (password required)
qpdf --password=secret123 --decrypt encrypted.pdf decrypted.pdf
```

---

## Advanced Python Patterns

### pdfplumber: Precision Features

#### Character-Level Coordinate Access

```python
import pdfplumber

with pdfplumber.open("document.pdf") as doc:
    pg = doc.pages[0]

    # Individual character positions
    for ch in pg.chars[:10]:
        print("Char: '{}' at x:{:.1f} y:{:.1f}".format(ch['text'], ch['x0'], ch['y0']))

    # Region-bounded text extraction (left, top, right, bottom)
    region_text = pg.within_bbox((100, 100, 400, 200)).extract_text()
```

#### Custom Table Detection Parameters

```python
import pdfplumber
import pandas as pd

with pdfplumber.open("complex_table.pdf") as doc:
    pg = doc.pages[0]

    config = {
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines",
        "snap_tolerance": 3,
        "intersection_tolerance": 15
    }
    found = pg.extract_tables(config)

    # Debug visualization
    debug_img = pg.to_image(resolution=150)
    debug_img.save("debug_layout.png")
```

### reportlab: Professional Output

#### Styled Tabular Reports

```python
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors

records = [
    ['Product', 'Q1', 'Q2', 'Q3', 'Q4'],
    ['Widgets', '120', '135', '142', '158'],
    ['Gadgets', '85', '92', '98', '105']
]

template = SimpleDocTemplate("report.pdf")
parts = []

styles = getSampleStyleSheet()
parts.append(Paragraph("Quarterly Sales Report", styles['Title']))

grid = Table(records)
grid.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, 0), 14),
    ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
    ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
    ('GRID', (0, 0), (-1, -1), 1, colors.black)
]))
parts.append(grid)

template.build(parts)
```

---

## Composite Workflows

### Extracting Visual Assets

#### Approach 1: Shell-Based (Fastest)

```bash
pdfimages -all document.pdf images/img
```

#### Approach 2: Programmatic with pypdfium2

```python
import pypdfium2 as pdfium
from PIL import Image
import numpy as np

def extract_figures(pdf_path, output_dir):
    doc = pdfium.PdfDocument(pdf_path)

    for pg_idx, pg in enumerate(doc):
        bmp = pg.render(scale=3.0)
        frame = bmp.to_pil()

        arr = np.array(frame)

        # Naive figure detection: non-white pixel regions
        non_white = np.any(arr != [255, 255, 255], axis=2)

        # Contour analysis and bounding box extraction
        # (Simplified — production use needs more robust detection)

        # Save discovered regions
        # ... details depend on requirements
```

### Batch Operations with Resilience

```python
import os
import glob
import logging

import pypdf

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

def batch_process(source_dir, mode='merge'):
    targets = glob.glob(os.path.join(source_dir, "*.pdf"))

    if mode == 'merge':
        output = pypdf.PdfWriter()
        for path in targets:
            try:
                rdr = pypdf.PdfReader(path)
                for pg in rdr.pages:
                    output.add_page(pg)
                log.info("Processed: %s", path)
            except Exception as exc:
                log.error("Failed to process %s: %s", path, exc)
                continue

        with open("batch_merged.pdf", "wb") as dest:
            output.write(dest)

    elif mode == 'extract_text':
        for path in targets:
            try:
                rdr = pypdf.PdfReader(path)
                content = "".join(pg.extract_text() for pg in rdr.pages)

                txt_path = path.replace('.pdf', '.txt')
                with open(txt_path, 'w', encoding='utf-8') as out:
                    out.write(content)
                log.info("Extracted text from: %s", path)

            except Exception as exc:
                log.error("Failed to extract text from %s: %s", path, exc)
                continue
```

### Region Cropping

```python
import pypdf

source = pypdf.PdfReader("input.pdf")
output = pypdf.PdfWriter()

# Define visible area (left, bottom, right, top in points)
pg = source.pages[0]
pg.mediabox.left = 50
pg.mediabox.bottom = 50
pg.mediabox.right = 550
pg.mediabox.top = 750

output.add_page(pg)
with open("cropped.pdf", "wb") as dest:
    output.write(dest)
```

---

## Performance Guidelines

### 1. Handling Large Documents
- Process pages individually rather than loading entire files into memory
- Leverage `qpdf --split-pages` for breaking apart large PDFs
- Use pypdfium2 for per-page rendering without full document buffering

### 2. Text Extraction Speed
- `pdftotext -bbox-layout` provides the fastest plain-text pipeline
- pdfplumber excels at structured/tabular content
- Avoid `pypdf.extract_text()` on very large files

### 3. Image Extraction Efficiency
- `pdfimages` significantly outperforms page rendering for embedded assets
- Use low DPI for thumbnails, high DPI for production output

### 4. Form Processing
- pdf-lib preserves form structure more reliably than most alternatives
- Always validate field specifications before bulk processing

### 5. Memory-Conscious Processing

```python
import pypdf

def chunked_processing(pdf_path, pages_per_chunk=10):
    source = pypdf.PdfReader(pdf_path)
    n_pages = len(source.pages)

    for offset in range(0, n_pages, pages_per_chunk):
        limit = min(offset + pages_per_chunk, n_pages)
        chunk = pypdf.PdfWriter()

        for k in range(offset, limit):
            chunk.add_page(source.pages[k])

        with open("chunk_{}.pdf".format(offset // pages_per_chunk), "wb") as dest:
            chunk.write(dest)
```

---

## Diagnosing Common Problems

### Encrypted Documents

```python
import pypdf

try:
    doc = pypdf.PdfReader("encrypted.pdf")
    if doc.is_encrypted:
        doc.decrypt("password")
except Exception as exc:
    print("Failed to decrypt: {}".format(exc))
```

### Damaged Files

```bash
# Verify structural integrity
qpdf --check corrupted.pdf
qpdf --replace-input corrupted.pdf
```

### Unreadable Scanned Content

```python
import pytesseract
from pdf2image import convert_from_path

def ocr_fallback(pdf_path):
    frames = convert_from_path(pdf_path)
    content = ""
    for frame in frames:
        content += pytesseract.image_to_string(frame)
    return content
```

---

## Licensing Summary

| Library | License |
|---------|---------|
| pypdf | BSD |
| pdfplumber | MIT |
| pypdfium2 | Apache/BSD |
| reportlab | BSD |
| poppler-utils | GPL-2 |
| qpdf | Apache |
| pdf-lib | MIT |
| pdfjs-dist | Apache |
