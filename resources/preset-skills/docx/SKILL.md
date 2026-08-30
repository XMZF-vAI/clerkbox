---
name: docx
version: 2.0.0
description: "Comprehensive Word (.docx) skill: create, read, edit, and manipulate Word documents end-to-end. Covers turning Markdown or structured text into polished Word output, filling reusable templates ({{token}} or reference-doc), applying correct Chinese (CJK) typography defaults, generating bespoke docs from scratch with docx-js, and low-level OOXML patching including tracked changes and comments. Triggers include any mention of 'Word doc', 'word document', '.docx', '报告', '备忘录', '信函', '合同', '会议纪要', 'Markdown 转 Word', 'md 转 docx', '套模板生成 Word', '中文 Word 报告', 'tracked changes', '修订标记', 'Word 批注', 'OOXML', or requests to insert/replace images, perform find-and-replace, or convert content into a polished Word document. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
description_zh: "全功能 Word(.docx) 技能：端到端创建、读取、编辑和操作 Word 文档。覆盖 Markdown/结构化文本转 Word、模板套用（{{token}} 或 reference-doc 两种）、正确的中文排版默认值、用 docx-js 从零定制文档、以及 OOXML 底层修补（含修订标记、批注）。触发词：'Word 文档'、'.docx'、'报告/备忘录/信函/合同/会议纪要'、'Markdown 转 Word'、'md 转 docx'、'套模板生成 Word'、'中文 Word 报告'、'修订标记'、'Word 批注'、'OOXML'，以及插入/替换图片、查找替换、把内容转为精美 Word 文档等请求。不适用于 PDF、电子表格、Google Docs 或与文档生成无关的编程任务。"
license: Proprietary
icon: 📄
category: document
author: ClerkBox
trigger_keywords: [Word, word文档, docx, 报告, 备忘录, 信函, 合同, 会议纪要, Markdown转Word, 中文排版, 修订, 批注, tracked changes, OOXML]
---

# docx-pro: Complete Word document skill

Single self-contained skill for everything related to `.docx` files —
high-frequency Markdown/template workflows on top, full docx-js generation in
the middle, and low-level OOXML patching at the bottom.

A `.docx` file is a ZIP container holding a tree of XML files conforming to the
OOXML standard. This skill works at every layer: composing Markdown and
rendering with pandoc, generating from scratch with docx-js, and unpacking the
archive to edit XML directly.

---

## ⚠️ Golden Rule: Compose first, render second

**The user's request/spec is NOT your Markdown input.** You must:

1. **Read and understand** the user's requirements (content, structure, data).
2. **Compose** a clean, publication-ready Markdown file containing ONLY the
   final document content — no meta-instructions, no "排版要求" sections, no
   "用表格呈现：" directives, no formatting instructions.
3. **Then** feed that composed Markdown to the renderer.

```
❌ WRONG — piping the spec file directly:

   # The user gave you "需求.md" describing what doc to produce;
   # you must NOT render it directly:
   python scripts/md_to_docx.py 需求.md output.docx        # BAD!

✅ CORRECT — compose then render:

   # 1. Write a NEW .md with clean business content only
   #    (organize headings, tables, prose based on the spec)
   # 2. Then render YOUR composed file
   python scripts/md_to_docx.py content.md output.docx     # GOOD
```

If the user explicitly says "把这个 Markdown 文件原样转成 Word" (convert this
exact Markdown as-is), only then may you skip the composition step.

**Self-check before rendering:** Open your composed `.md` and ask: "Would I
hand this text directly to a client/boss as the document body?" If it contains
anything a reader shouldn't see (instructions, meta-commentary, formatting
directives, section labels like "排版要求"), remove it before rendering.

---

## Decision Matrix

| Goal | Pathway |
|------|---------|
| User gives a brief/spec → produce a Word doc | §Standard workflow → §Markdown pipeline |
| User has a finished Markdown file → format as Word | §Markdown pipeline (skip composition) |
| Fill a reusable template with placeholder values | §Template fill |
| Chinese-language doc with correct CJK typography | §Chinese typography |
| Build a fully custom doc from scratch | §Generating from scratch with docx-js |
| Modify an existing `.docx` file | §Patching existing documents |
| Inspect / extract text | `pandoc` or §Patching → unpack to browse raw XML |
| Tracked changes, comments, paragraph-level XML | §XML patterns + §Patching existing documents |

---

## Standard workflow (requirement → docx)

When the user gives you a task description, brief, or specification — NOT a
finished Markdown file they want converted as-is — follow these steps in order:

1. **Understand the requirement** — identify: document type, target audience,
   required content (specific data, tables, lists), and formatting preferences
   (Chinese/English, font, layout).

2. **Choose a template** — pick the closest match from `templates/`. If none
   fits, use `report-standard.docx` as a general-purpose default.

3. **Compose the Markdown** — write a NEW `.md` file that contains ONLY the
   final document content a reader would see:
   - Professional headings (`#` / `##` / `###`)
   - Business prose paragraphs
   - Pipe tables with real data (header + separator + rows)
   - Ordered/unordered lists with actual items
   - **NO** "排版要求", "用表格呈现：", "用有序列表：", or any instructional /
     meta text from the spec

4. **Run doctor** — `python scripts/doctor.py` (once per session) to choose the
   rendering engine.

5. **Render** — call `md_to_docx.py` (pandoc) or `md_to_docx.mjs` (Node
   fallback) on your **composed** file — never on the original spec file.

6. **Validate + preview** — run `validate.py` and (if available) `preview.py`.

---

## First step: environment check

Always run the doctor once per task before generating, so you pick the right
engine:

```bash
python scripts/doctor.py
```

It reports availability of `pandoc`, `node` + `docx`, `soffice` (LibreOffice),
and `pdftoppm`. Choose the engine based on results:

- **pandoc available** → preferred for Markdown→docx (fastest, template-aware).
- **pandoc missing, node available** → use the Node fallback renderer
  `scripts/md_to_docx.mjs` (covers headings, lists, tables, bold/italic, code,
  images, blockquotes).
- **soffice available** → enables `scripts/preview.py` self-check screenshots.
- All missing → tell the user which dependency to install (doctor prints the
  per-platform command).

---

# Part A: Markdown pipeline

Convert a Markdown file (or content you wrote to a temp `.md`) into `.docx`.

> **Important:** The input `.md` must contain publication-ready content only. If
> you are working from a user's requirement spec, you must first compose a clean
> content file (see §Standard workflow above) — never feed a spec/brief directly
> to the renderer.

### Preferred: pandoc

```bash
python scripts/md_to_docx.py input.md output.docx \
  --reference templates/report-standard.docx \
  --toc
```

`md_to_docx.py` wraps pandoc and automatically:
- resolves relative image paths against the Markdown file's directory,
- inserts a Table of Contents field when `--toc` is passed,
- applies a reference document for styling (defaults to a clean A4 style),
- preserves fenced code blocks and tables.

### Fallback: Node renderer (no pandoc required)

```bash
node scripts/md_to_docx.mjs input.md output.docx --cjk
```

Requires the global `docx` npm package. The `--cjk` flag applies Chinese
typography defaults (see §Chinese typography). Supported Markdown: headings
(#–######), ordered/unordered lists (nested), tables, bold/italic/inline-code,
fenced code blocks, blockquotes, images, horizontal rules, and links.

### After generating: validate + preview

```bash
python scripts/office/validate.py output.docx
python scripts/preview.py output.docx --pages 1,2,last  # if soffice present
```

`validate.py` passing does NOT mean the layout is visually correct. For any
multi-page or table-heavy document, render at least pages 1–2 and inspect them
for margin overflow, squeezed tables, missing fonts, or empty TOC.

---

# Part B: Template fill

Generate a standard document by filling a template instead of building from
scratch. Templates live in `templates/`:

| File | Use for |
|------|---------|
| `report-standard.docx` | A4 report: cover, TOC, H1–H3, header/footer, page numbers |
| `memo.docx` | Memo with To / From / Subject / Date header block |
| `letter.docx` | Business letter with letterhead and signature block |
| `contract.docx` | Contract skeleton with numbered clauses and signature area |
| `meeting-minutes.docx` | Meeting minutes: attendees, agenda, decisions table |

> The shipped templates are minimal style references. If a template file is
> missing or you need a richer one, build it once with §Generating from scratch
> and drop it into `templates/` for reuse.

### Reference-document workflow

1. Pick the closest template from the table above.
2. Write the body content as Markdown (per the Golden Rule).
3. Render with the template as the reference doc:

```bash
python scripts/md_to_docx.py body.md output.docx --reference templates/memo.docx
```

### Placeholder workflow

For templates with literal tokens like `{{title}}`, `{{date}}` in the docx,
use the token replacer:

```bash
python scripts/fill_template.py templates/contract.docx output.docx \
  --set title="服务采购合同" --set party_a="甲方公司" --set date="2026-06-17"
```

`fill_template.py` performs safe text-run replacement (handles tokens split
across runs) without breaking document structure. It backs up nothing because
it never edits the template in place — it always writes a new `output.docx`.

---

# Part C: Chinese typography

Western-only fonts (e.g. Arial) trigger Word's font fallback for CJK text,
producing inconsistent rendering across macOS / Windows / WPS. When the
document is primarily Chinese, apply the CJK preset.

- **Node renderer:** pass `--cjk` to `md_to_docx.mjs`.
- **Custom docx-js code:** import the preset from `scripts/styles/zh-cn.js`.

The preset sets:

```javascript
// scripts/styles/zh-cn.js (summary)
run:  { font: { ascii: "Arial", eastAsia: "Microsoft YaHei" }, size: 24 } // 12pt
paragraph: {
  spacing: { line: 360, lineRule: "auto" },   // 1.5x line spacing
  indent:  { firstLine: 480 }                  // 2 chars first-line indent
}
// Headings keep eastAsia bold font, black color, no first-line indent
```

Rules for Chinese documents:
- Always declare `eastAsia` explicitly; never rely on `ascii` font alone.
- Body text: 1.5 line spacing, 2-character first-line indent.
- Headings: no first-line indent, bold, black.
- Default heading font: `Microsoft YaHei`; body can use `SimSun`/`宋体` if the
  user prefers a print look — ask if unsure.

---

# Part D: Generating from scratch with docx-js

Produce `.docx` files via JavaScript when no template fits and the layout is
custom. Install: `npm install -g docx`.

### Bootstrap

```javascript
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
        Header, Footer, AlignmentType, PageOrientation, LevelFormat, ExternalHyperlink,
        InternalHyperlink, Bookmark, FootnoteReferenceRun, PositionalTab,
        PositionalTabAlignment, PositionalTabRelativeTo, PositionalTabLeader,
        TabStopType, TabStopPosition, Column, SectionType,
        TableOfContents, HeadingLevel, BorderStyle, WidthType, ShadingType,
        VerticalAlign, PageNumber, PageBreak } = require('docx');

const doc = new Document({ sections: [{ children: [/* content */] }] });
Packer.toBuffer(doc).then(buf => fs.writeFileSync("doc.docx", buf));
```

### Validation

```bash
python scripts/office/validate.py doc.docx
```

If the validator reports issues, unpack, repair the XML, and repackage.

### Page Dimensions

```javascript
// docx-js defaults to A4; US Letter must be set explicitly.
sections: [{
  properties: {
    page: {
      size: { width: 12240, height: 15840 },         // 8.5 × 11 in (DXA)
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }  // 1-inch
    }
  },
  children: [/* body content */]
}]
```

**Paper sizes (DXA; 1440 DXA = 1 inch):**

| Format | Width | Height | Usable width (1 in margins) |
|--------|-------|--------|-----------------------------|
| US Letter | 12 240 | 15 840 | 9 360 |
| A4 (default) | 11 906 | 16 838 | 9 026 |

**Landscape:** Always supply portrait dimensions — docx-js internally transposes them:

```javascript
size: {
  width: 12240,   // short edge
  height: 15840,  // long edge
  orientation: PageOrientation.LANDSCAPE
},
// Effective content width = 15840 − left − right (long edge becomes horizontal)
```

### Heading Styles

Default to Arial for broad compatibility. Keep heading text black.

```javascript
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } },  // 12 pt base
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 } },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Title")] }),
    ]
  }]
});
```

### Lists (NEVER use Unicode bullet characters)

```javascript
// ❌ WRONG — literal bullet glyphs produce broken output
new Paragraph({ children: [new TextRun("• Item")] })   // BAD
new Paragraph({ children: [new TextRun("\u2022 Item")] })  // BAD

// ✅ CORRECT — use LevelFormat.BULLET via numbering configuration
const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ numbering: { reference: "bullets", level: 0 },
        children: [new TextRun("Bullet item")] }),
      new Paragraph({ numbering: { reference: "numbers", level: 0 },
        children: [new TextRun("Numbered item")] }),
    ]
  }]
});

// ⚠️ Same reference → continuous (1,2,3…4,5,6); different references → restart (1,2,3…1,2,3)
```

### Tables

**Both `columnWidths` on Table AND `width` on every TableCell are required.**

```javascript
const borderDef = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const allBorders = { top: borderDef, bottom: borderDef, left: borderDef, right: borderDef };

new Table({
  width: { size: 9360, type: WidthType.DXA },  // always DXA, never PERCENTAGE
  columnWidths: [4680, 4680],                   // must sum to table width
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders: allBorders,
          width: { size: 4680, type: WidthType.DXA },  // must match columnWidths entry
          shading: { fill: "D5E8F0", type: ShadingType.CLEAR },  // CLEAR, never SOLID
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun("Cell")] })]
        })
      ]
    })
  ]
})
```

**Width computation:**

```javascript
// table width = Σ columnWidths = page width − both margins
// US Letter + 1 in margins: 12240 − 2880 = 9360 DXA
width: { size: 9360, type: WidthType.DXA },
columnWidths: [7000, 2360]  // must sum to 9360
```

**Table rules:**
- Always `WidthType.DXA` — `PERCENTAGE` breaks in Google Docs
- Cell `width` must equal its corresponding `columnWidths` entry
- Cell `margins` are inward padding (shrink content area, don't add to cell width)
- Full-width: set width to page width minus both lateral margins

### Images

```javascript
new Paragraph({
  children: [new ImageRun({
    type: "png",  // required; accepted: png, jpg, jpeg, gif, bmp, svg
    data: fs.readFileSync("image.png"),
    transformation: { width: 200, height: 150 },
    altText: { title: "Title", description: "Desc", name: "Name" }  // all three required
  })]
})
```

### Page Breaks

```javascript
// PageBreak MUST live inside a Paragraph
new Paragraph({ children: [new PageBreak()] })

// Alternative: pageBreakBefore
new Paragraph({ pageBreakBefore: true, children: [new TextRun("New page")] })
```

### Hyperlinks

```javascript
// External URL
new Paragraph({
  children: [new ExternalHyperlink({
    children: [new TextRun({ text: "Click here", style: "Hyperlink" })],
    link: "https://example.com",
  })]
})

// In-document cross-reference
// 1. Place bookmark at destination
new Paragraph({ heading: HeadingLevel.HEADING_1, children: [
  new Bookmark({ id: "chapter1", children: [new TextRun("Chapter 1")] }),
]})
// 2. Link to it
new Paragraph({ children: [new InternalHyperlink({
  children: [new TextRun({ text: "See Chapter 1", style: "Hyperlink" })],
  anchor: "chapter1",
})]})
```

### Footnotes

```javascript
const doc = new Document({
  footnotes: {
    1: { children: [new Paragraph("Source: Annual Report 2024")] },
    2: { children: [new Paragraph("See appendix for methodology")] },
  },
  sections: [{
    children: [new Paragraph({
      children: [
        new TextRun("Revenue grew 15%"),
        new FootnoteReferenceRun(1),
        new TextRun(" using adjusted metrics"),
        new FootnoteReferenceRun(2),
      ],
    })]
  }]
});
```

### Tab Stops

```javascript
// Right-aligned text on the same line
new Paragraph({
  children: [new TextRun("Company Name"), new TextRun("\tJanuary 2025")],
  tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
})

// Dot-leader (TOC-style)
new Paragraph({
  children: [
    new TextRun("Introduction"),
    new TextRun({ children: [
      new PositionalTab({
        alignment: PositionalTabAlignment.RIGHT,
        relativeTo: PositionalTabRelativeTo.MARGIN,
        leader: PositionalTabLeader.DOT,
      }),
      "3",
    ]}),
  ],
})
```

### Multi-column Layouts

```javascript
// Evenly spaced columns
sections: [{
  properties: {
    column: { count: 2, space: 720, equalWidth: true, separate: true },
  },
  children: [/* text flows across columns automatically */]
}]

// Custom widths
sections: [{
  properties: {
    column: {
      equalWidth: false,
      children: [new Column({ width: 5400, space: 720 }), new Column({ width: 3240 })],
    },
  },
  children: [/* content */]
}]
```

Explicit column break: add a new section with `type: SectionType.NEXT_COLUMN`.

### Table of Contents

```javascript
// Headings MUST use HeadingLevel — custom paragraph styles are invisible to the TOC.
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" })
```

### Headers and Footers

```javascript
sections: [{
  properties: {
    page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }
  },
  headers: {
    default: new Header({ children: [new Paragraph({ children: [new TextRun("Header")] })] })
  },
  footers: {
    default: new Footer({ children: [new Paragraph({
      children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })]
    })] })
  },
  children: [/* body */]
}]
```

### Essential docx-js Rules

- **Page size:** defaults to A4; US Letter = 12 240 × 15 840 DXA
- **Landscape:** supply portrait dimensions + `PageOrientation.LANDSCAPE`
- **No `\n`:** create separate Paragraph objects
- **No Unicode bullets:** use `LevelFormat.BULLET` via numbering API
- **PageBreak inside Paragraph only**
- **ImageRun requires `type`**
- **Table `width` must use DXA** — `PERCENTAGE` breaks in Google Docs
- **Dual-width rule:** set `columnWidths` on table AND `width` on every cell
- **Table width = Σ columnWidths**
- **Cell margins:** `{ top: 80, bottom: 80, left: 120, right: 120 }` for readable padding
- **Use `ShadingType.CLEAR`** — never SOLID for cell fills
- **Avoid tables as dividers:** use border on Paragraph instead; for side-by-side footer content use tab stops
- **TOC only with HeadingLevel**
- **Override styles by ID:** "Heading1", "Heading2", etc.
- **Provide `outlineLevel`** for TOC (0 = H1, 1 = H2 …)

---

# Part E: Patching existing documents

Execute all three stages in order.

### Stage 1 — Unpack

```bash
python scripts/office/unpack.py document.docx unpacked/
```

Inflates the archive, pretty-prints XML, coalesces adjacent runs, and encodes
typographic quotes as XML entities (`&#x201C;` etc.). Pass `--merge-runs false`
to skip run coalescing.

### Stage 2 — Edit the XML

Work inside `unpacked/word/`. Refer to §XML Patterns below.

**Use "ClerkBox" as the author** for tracked changes and comments, unless the
user specifies otherwise.

**Use the `search_replace` tool for string replacements — do not write Python scripts.**
`search_replace` makes every replacement visible and auditable.

**Use typographic (smart) quotes for new text:**

```xml
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
```

| Entity | Character |
|--------|-----------|
| `&#x2018;` | ' (left single) |
| `&#x2019;` | ' (right single / apostrophe) |
| `&#x201C;` | " (left double) |
| `&#x201D;` | " (right double) |

**Inserting comments** — `comment.py` handles the multi-file boilerplate (text must be XML-escaped):

```bash
python scripts/comment.py unpacked/ 0 "Comment text with &amp; and &#x2019;"
python scripts/comment.py unpacked/ 1 "Reply text" --parent 0
python scripts/comment.py unpacked/ 0 "Text" --author "Custom Author"
```

Then wire markers into document.xml (see §XML Patterns → Comments).

### Stage 3 — Repack

```bash
python scripts/office/pack.py unpacked/ output.docx --original document.docx
```

Validates with automatic repair, condenses XML, produces the final DOCX. Pass
`--validate false` to bypass.

**Auto-repair corrects:**
- `durableId` values ≥ 0x7FFFFFFF (replaced with fresh IDs)
- Missing `xml:space="preserve"` on `<w:t>` with leading/trailing whitespace

**Does NOT fix:** malformed XML, illegal nesting, broken relationships, schema violations.

### Gotchas

- **Swap whole `<w:r>` blocks:** when introducing tracked changes, replace the
  entire run — never splice change-tracking tags inside an existing run.
- **Carry forward `<w:rPr>`:** copy original formatting properties into new
  tracked-change runs.

---

# Part F: XML patterns

### Schema Ordering

- **`<w:pPr>` child order:** `<w:pStyle>` → `<w:numPr>` → `<w:spacing>` → `<w:ind>` → `<w:jc>` → `<w:rPr>` last
- **Whitespace:** attach `xml:space="preserve"` to any `<w:t>` with leading/trailing spaces
- **RSIDs:** 8-character hexadecimal (e.g. `00AB1234`)

### Tracked Changes

**Insertion:**

```xml
<w:ins w:id="1" w:author="ClerkBox" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
```

**Deletion:**

```xml
<w:del w:id="2" w:author="ClerkBox" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

Inside `<w:del>`: use `<w:delText>` instead of `<w:t>`, `<w:delInstrText>` instead of `<w:instrText>`.

**Minimal-footprint edit (change "30 days" to "60 days"):**

```xml
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="ClerkBox" w:date="...">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="ClerkBox" w:date="...">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> days.</w:t></w:r>
```

**Deleting a complete paragraph** — flag the paragraph mark so the empty shell merges with the next paragraph:

```xml
<w:p>
  <w:pPr>
    <w:numPr>...</w:numPr>
    <w:rPr>
      <w:del w:id="1" w:author="ClerkBox" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="ClerkBox" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content being deleted...</w:delText></w:r>
  </w:del>
</w:p>
```

Without the `<w:del/>` in `<w:pPr><w:rPr>`, accepting leaves a blank paragraph.

**Rejecting another author's insertion:**

```xml
<w:ins w:author="Jane" w:id="5">
  <w:del w:author="ClerkBox" w:id="10">
    <w:r><w:delText>their inserted text</w:delText></w:r>
  </w:del>
</w:ins>
```

**Restoring another author's deletion:**

```xml
<w:del w:author="Jane" w:id="5">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
<w:ins w:author="ClerkBox" w:id="10">
  <w:r><w:t>deleted text</w:t></w:r>
</w:ins>
```

### Comments

After calling `comment.py`, add range markers in document.xml. For replies, use
`--parent` and nest child markers inside the parent's range.

**Rule: `<w:commentRangeStart>` and `<w:commentRangeEnd>` are siblings of
`<w:r>` — never inside a run.**

```xml
<!-- Standalone comment -->
<w:commentRangeStart w:id="0"/>
<w:del w:id="1" w:author="ClerkBox" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted</w:delText></w:r>
</w:del>
<w:r><w:t> more text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>

<!-- Comment 0 with nested reply 1 -->
<w:commentRangeStart w:id="0"/>
  <w:commentRangeStart w:id="1"/>
  <w:r><w:t>text</w:t></w:r>
  <w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
```

### Images

1. Drop file into `word/media/`
2. Register relationship in `word/_rels/document.xml.rels`:

```xml
<Relationship Id="rId5" Type=".../image" Target="media/image1.png"/>
```

3. Declare content type in `[Content_Types].xml`:

```xml
<Default Extension="png" ContentType="image/png"/>
```

4. Reference from document.xml:

```xml
<w:drawing>
  <wp:inline>
    <wp:extent cx="914400" cy="914400"/>  <!-- EMUs: 914 400 = 1 inch -->
    <a:graphic>
      <a:graphicData uri=".../picture">
        <pic:pic>
          <pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
```

---

## Common operations

### Converting legacy .doc to .docx

```bash
python scripts/office/soffice.py --headless --convert-to docx document.doc
```

### Extracting text

```bash
# Markdown output preserving tracked-change information
pandoc --track-changes=all document.docx -o output.md

# Direct XML access for fine-grained inspection
python scripts/office/unpack.py document.docx unpacked/
```

### Rendering pages as images

```bash
python scripts/office/soffice.py --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
```

### Accepting all tracked changes

Produces a pristine copy with all revisions resolved (LibreOffice required):

```bash
python scripts/accept_changes.py input.docx output.docx
```

---

## Utility scripts

High-frequency rendering & template:

- `scripts/doctor.py` — detect pandoc / node+docx / soffice / pdftoppm; print
  per-platform install hints. **Run first.**
- `scripts/md_to_docx.py` — pandoc-based Markdown→docx with image/TOC/reference
  handling. **Execute.**
- `scripts/md_to_docx.mjs` — Node fallback Markdown→docx (no pandoc). Supports
  `--cjk`. **Execute.**
- `scripts/fill_template.py` — replace `{{token}}` placeholders in a template
  docx. **Execute.**
- `scripts/preview.py` — render docx pages to JPEG for visual self-check (needs
  LibreOffice). **Execute.**
- `scripts/styles/zh-cn.js` — importable CJK typography preset. **Read/import.**

OOXML / patching / comments:

- `scripts/comment.py` — insert Word comments into an unpacked document.
- `scripts/accept_changes.py` — accept all tracked changes (LibreOffice).
- `scripts/office/unpack.py` — explode a `.docx` into pretty-printed XML.
- `scripts/office/pack.py` — repackage an unpacked tree, with auto-repair.
- `scripts/office/validate.py` — XSD-based schema validation for DOCX/PPTX.
- `scripts/office/soffice.py` — sandboxed LibreOffice wrapper.

## External dependencies

- `pandoc` — preferred Markdown→docx engine (Part A).
- `node` + global `docx` package (`npm install -g docx`) — fallback renderer
  and bespoke generation (Parts A and D).
- `LibreOffice` (`soffice`) — headless conversion, accepting tracked changes,
  preview rendering.
- `pdftoppm` (Poppler) — required by `preview.py` to rasterize PDFs.

## Additional resources

- For deeper Markdown→docx mapping and edge cases, see [reference/pipeline.md](reference/pipeline.md).
- For template authoring and placeholder conventions, see [reference/templates.md](reference/templates.md).
