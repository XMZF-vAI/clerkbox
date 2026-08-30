---
name: pdf
version: 1.0.1
description: Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.
description_zh: 当用户需要对 PDF 文件执行任何操作时使用此技能。包括：读取或提取 PDF 中的文本/表格、合并多个 PDF、拆分 PDF、旋转页面、添加水印、创建新 PDF、填写 PDF 表单、加密/解密 PDF、提取图片，以及对扫描版 PDF 进行 OCR 使其可搜索。只要用户提及 .pdf 文件或要求生成 PDF，就使用此技能。
license: Proprietary. LICENSE.txt has complete terms
icon: 📕
category: document
author: ClerkBox
trigger_keywords: [PDF, pdf, 提取文本, 合并PDF, 拆分, 水印, OCR, 表单, 加密, 解密, 提取图片]
---

# Working with PDF Documents

## Introduction

A comprehensive toolkit for PDF manipulation through Python and shell utilities. Consult `advanced-reference.md` for extended capabilities (pypdfium2, JavaScript ecosystems, performance guidance). When form-filling is required, follow the workflow described in `form-filling-guide.md`.

## Getting Started

```python
import pypdf

# Open and inspect a document
doc = pypdf.PdfReader("document.pdf")
total_pages = len(doc.pages)
print("Pages: {}".format(total_pages))

# Gather all textual content
content = "".join(pg.extract_text() for pg in doc.pages)
```

## Core Python Libraries

### pypdf — Structural Manipulation

#### Combining Multiple Documents

```python
import pypdf

output = pypdf.PdfWriter()
sources = ["doc1.pdf", "doc2.pdf", "doc3.pdf"]
for src in sources:
    rdr = pypdf.PdfReader(src)
    for pg in rdr.pages:
        output.add_page(pg)

with open("merged.pdf", "wb") as dest:
    output.write(dest)
```

#### Separating Pages Into Individual Files

```python
import pypdf

source = pypdf.PdfReader("input.pdf")
for idx, pg in enumerate(source.pages):
    single = pypdf.PdfWriter()
    single.add_page(pg)
    with open("page_{}.pdf".format(idx + 1), "wb") as dest:
        single.write(dest)
```

#### Reading Document Properties

```python
import pypdf

source = pypdf.PdfReader("document.pdf")
props = source.metadata
print("Title: {}".format(props.title))
print("Author: {}".format(props.author))
print("Subject: {}".format(props.subject))
print("Creator: {}".format(props.creator))
```

#### Changing Page Orientation

```python
import pypdf

source = pypdf.PdfReader("input.pdf")
output = pypdf.PdfWriter()

target = source.pages[0]
target.rotate(90)  # 90-degree clockwise rotation
output.add_page(target)

with open("rotated.pdf", "wb") as dest:
    output.write(dest)
```

### pdfplumber — Content Extraction

#### Retrieving Text Preserving Layout

```python
import pdfplumber

with pdfplumber.open("document.pdf") as doc:
    for pg in doc.pages:
        content = pg.extract_text()
        print(content)
```

#### Pulling Tabular Data

```python
import pdfplumber

with pdfplumber.open("document.pdf") as doc:
    for pg_idx, pg in enumerate(doc.pages):
        found_tables = pg.extract_tables()
        for tbl_idx, tbl in enumerate(found_tables):
            print("Table {} on page {}:".format(tbl_idx + 1, pg_idx + 1))
            for row in tbl:
                print(row)
```

#### Structured Table Export

```python
import pdfplumber
import pandas as pd

with pdfplumber.open("document.pdf") as doc:
    collected = []
    for pg in doc.pages:
        for tbl in pg.extract_tables():
            if tbl:
                frame = pd.DataFrame(tbl[1:], columns=tbl[0])
                collected.append(frame)

if collected:
    merged = pd.concat(collected, ignore_index=True)
    merged.to_excel("extracted_tables.xlsx", index=False)
```

### reportlab — Document Generation

#### Producing a Simple PDF

```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

doc = canvas.Canvas("hello.pdf", pagesize=letter)
w, h = letter

doc.drawString(100, h - 100, "Hello World!")
doc.drawString(100, h - 120, "This is a PDF created with reportlab")

doc.line(100, h - 140, 400, h - 140)

doc.save()
```

#### Multi-Page Document Construction

```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

template = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
elements = []

elements.append(Paragraph("Report Title", styles['Title']))
elements.append(Spacer(1, 12))
elements.append(Paragraph("This is the body of the report. " * 20, styles['Normal']))
elements.append(PageBreak())

elements.append(Paragraph("Page 2", styles['Heading1']))
elements.append(Paragraph("Content for page 2", styles['Normal']))

template.build(elements)
```

#### Handling Sub/Superscripts

**IMPORTANT**: Never use Unicode subscript/superscript characters (₀₁₂₃₄₅₆₇₈₉, ⁰¹²³⁴⁵⁶⁷⁸⁹) in ReportLab PDFs. The built-in fonts do not include these glyphs, causing them to render as solid black boxes.

Instead, use ReportLab's XML markup tags in Paragraph objects:
```python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()

# Subscripts: use <sub> tag
chemical = Paragraph("H<sub>2</sub>O", styles['Normal'])

# Superscripts: use <super> tag
squared = Paragraph("x<super>2</super> + y<super>2</super>", styles['Normal'])
```

For canvas-drawn text (not Paragraph objects), manually adjust font the size and position rather than using Unicode subscripts/superscripts.

## Shell Utilities

### poppler-utils (pdftotext)

```bash
# Plain text extraction
pdftotext input.pdf output.txt

# Layout-preserving extraction
pdftotext -layout input.pdf output.txt

# Page range selection
pdftotext -f 1 -l 5 input.pdf output.txt  # Pages 1-5
```

### qpdf

```bash
# Combine documents
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Extract page subsets
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
qpdf input.pdf --pages . 6-10 -- pages6-10.pdf

# Orientation adjustment
qpdf input.pdf output.pdf --rotate=+90:1  # Rotate page 1 by 90 degrees

# Decrypt protected files
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

### pdftk (if available)

```bash
# Combine
pdftk file1.pdf file2.pdf cat output merged.pdf

# Burst into pages
pdftk input.pdf burst

# Orientation change
pdftk input.pdf rotate 1east output rotated.pdf
```

## Typical Workflows

### OCR for Scanned Documents

```python
import pytesseract
from pdf2image import convert_from_path

rendered = convert_from_path('scanned.pdf')

content = ""
for idx, frame in enumerate(rendered):
    content += "Page {}:\n".format(idx + 1)
    content += pytesseract.image_to_string(frame)
    content += "\n\n"

print(content)
```

### Overlaying a Watermark

```python
import pypdf

stamp = pypdf.PdfReader("watermark.pdf").pages[0]

source = pypdf.PdfReader("document.pdf")
output = pypdf.PdfWriter()

for pg in source.pages:
    pg.merge_page(stamp)
    output.add_page(pg)

with open("watermarked.pdf", "wb") as dest:
    output.write(dest)
```

### Extracting Embedded Graphics

```bash
# Using pdfimages (poppler-utils)
pdfimages -j input.pdf output_prefix

# This extracts all images as output_prefix-000.jpg, output_prefix-001.jpg, etc.
```

### Applying Password Protection

```python
import pypdf

source = pypdf.PdfReader("input.pdf")
output = pypdf.PdfWriter()

for pg in source.pages:
    output.add_page(pg)

output.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as dest:
    output.write(dest)
```

## Capability Matrix

| Operation | Recommended Tool | Approach |
|-----------|-----------------|----------|
| Combine documents | pypdf | `writer.add_page(page)` |
| Separate pages | pypdf | One file per page |
| Read text content | pdfplumber | `page.extract_text()` |
| Parse tables | pdfplumber | `page.extract_tables()` |
| Generate new PDFs | reportlab | Canvas or Platypus |
| CLI merging | qpdf | `qpdf --empty --pages ...` |
| Scanned document OCR | pytesseract | Render to image first |
| Form completion | pdf-lib or pypdf (see form-filling-guide.md) | See form-filling-guide.md |

## Additional Resources

- Extended pypdfium2 documentation: `advanced-reference.md`
- JavaScript library details (pdf-lib): `advanced-reference.md`
- Form-filling procedures: `form-filling-guide.md`
- Error resolution guidance: `advanced-reference.md`
