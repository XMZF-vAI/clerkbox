#!/usr/bin/env node
/**
 * Markdown -> .docx fallback renderer (no pandoc required).
 * Uses the global `docx` npm package (same dependency as the base docx skill).
 *
 * Usage:
 *   node md_to_docx.mjs input.md output.docx [--cjk] [--title "Doc Title"]
 *
 * Supported Markdown:
 *   - headings #..######
 *   - unordered (-,*,+) and ordered (1.) lists, single level
 *   - pipe tables
 *   - bold (double asterisk or underscore), italic (single), inline code
 *   - fenced code blocks
 *   - blockquotes >
 *   - images ![alt](path)
 *   - horizontal rule ---
 *   - links [text](url)
 *
 * Follows base-skill hard rules: tables use DXA widths with columnWidths +
 * per-cell width; lists use the numbering API (no literal bullet glyphs);
 * images use ImageRun with required `type` and altText.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Resolve `docx` from local or global node_modules.
let docx;
try {
  docx = require("docx");
} catch {
  try {
    const { execSync } = require("node:child_process");
    const root = execSync("npm root -g").toString().trim();
    docx = require(path.join(root, "docx"));
  } catch (e) {
    console.error("ERROR: cannot find the `docx` npm package.");
    console.error("Install it with: npm install -g docx");
    process.exit(2);
  }
}

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageBreak,
} = docx;

// ---- args ----
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const getFlagVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const inputPath = positional[0];
const outputPath = positional[1];
const CJK = flags.has("--cjk");
const docTitle = getFlagVal("--title");

if (!inputPath || !outputPath) {
  console.error("Usage: node md_to_docx.mjs input.md output.docx [--cjk] [--title \"...\"]");
  process.exit(2);
}
if (!fs.existsSync(inputPath)) {
  console.error("ERROR: input not found:", inputPath);
  process.exit(2);
}

const mdDir = path.dirname(path.resolve(inputPath));
const md = fs.readFileSync(inputPath, "utf8");

// ---- CJK preset ----
const baseFont = CJK ? { ascii: "Arial", eastAsia: "Microsoft YaHei" } : "Arial";
const bodyParaProps = CJK
  ? { spacing: { line: 360, lineRule: "auto", after: 120 }, indent: { firstLine: 480 } }
  : { spacing: { after: 120 } };

// ---- inline parsing: bold / italic / code / link ----
function parseInline(text) {
  const runs = [];
  // tokenizer over **bold**, *italic*, `code`, [text](url)
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0, m;
  const push = (t, opts = {}) => {
    if (t) runs.push(new TextRun({ text: t, font: baseFont, ...opts }));
  };
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index));
    if (m[2] || m[3]) push(m[2] || m[3], { bold: true });
    else if (m[4] || m[5]) push(m[4] || m[5], { italics: true });
    else if (m[6]) runs.push(new TextRun({ text: m[6], font: "Consolas" }));
    else if (m[7]) push(`${m[7]} (${m[8]})`, { style: "Hyperlink" });
    last = re.lastIndex;
  }
  push(text.slice(last));
  return runs.length ? runs : [new TextRun({ text: "", font: baseFont })];
}

const headingLevels = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

// Usable width for US Letter / A4 with 1-inch margins ~ 9026-9360; use 9026 (A4).
const PAGE_WIDTH = 9026;

function makeTable(headerCells, bodyRows) {
  const cols = headerCells.length;
  const colW = Math.floor(PAGE_WIDTH / cols);
  const colWidths = Array(cols).fill(colW);
  const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const mkRow = (cells, header) =>
    new TableRow({
      children: cells.map((c, i) =>
        new TableCell({
          borders,
          width: { size: colWidths[i], type: WidthType.DXA },
          shading: header ? { fill: "D5E8F0", type: ShadingType.CLEAR } : undefined,
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: parseInline(c.trim()) })],
        })
      ),
    });
  return new Table({
    width: { size: PAGE_WIDTH, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [mkRow(headerCells, true), ...bodyRows.map((r) => mkRow(r, false))],
  });
}

// ---- block parsing ----
const lines = md.split(/\r?\n/);
const children = [];
let i = 0;

if (docTitle) {
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: docTitle, font: baseFont })] }));
}

while (i < lines.length) {
  let line = lines[i];

  // fenced code block
  if (/^```/.test(line)) {
    i++;
    const buf = [];
    while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
    i++; // closing fence
    for (const code of buf) {
      children.push(new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
        children: [new TextRun({ text: code || " ", font: "Consolas", size: 20 })],
      }));
    }
    continue;
  }

  // horizontal rule
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    children.push(new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } },
      children: [new TextRun("")],
    }));
    i++;
    continue;
  }

  // heading
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const lvl = h[1].length - 1;
    children.push(new Paragraph({
      heading: headingLevels[lvl],
      children: parseInline(h[2].trim()),
    }));
    i++;
    continue;
  }

  // pipe table: header row + separator row
  if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[-: |]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
    const splitRow = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
    const header = splitRow(line);
    i += 2;
    const body = [];
    while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
      body.push(splitRow(lines[i]));
      i++;
    }
    children.push(makeTable(header, body));
    children.push(new Paragraph({ children: [new TextRun("")] }));
    continue;
  }

  // image (own line)
  const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
  if (img) {
    const alt = img[1] || "image";
    let p = img[2].trim();
    if (!path.isAbsolute(p)) p = path.join(mdDir, p);
    if (fs.existsSync(p)) {
      const ext = path.extname(p).slice(1).toLowerCase().replace("jpeg", "jpg");
      const typeMap = { png: "png", jpg: "jpg", gif: "gif", bmp: "bmp", svg: "svg" };
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({
          type: typeMap[ext] || "png",
          data: fs.readFileSync(p),
          transformation: { width: 480, height: 320 },
          altText: { title: alt, description: alt, name: alt },
        })],
      }));
    } else {
      children.push(new Paragraph({ children: [new TextRun({ text: `[missing image: ${p}]`, font: baseFont, italics: true })] }));
    }
    i++;
    continue;
  }

  // blockquote
  if (/^>\s?/.test(line)) {
    const text = line.replace(/^>\s?/, "");
    children.push(new Paragraph({
      indent: { left: 480 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: "CCCCCC", space: 8 } },
      children: parseInline(text),
    }));
    i++;
    continue;
  }

  // unordered list
  if (/^\s*[-*+]\s+/.test(line)) {
    const text = line.replace(/^\s*[-*+]\s+/, "");
    children.push(new Paragraph({
      numbering: { reference: "ul", level: 0 },
      children: parseInline(text),
    }));
    i++;
    continue;
  }

  // ordered list
  if (/^\s*\d+\.\s+/.test(line)) {
    const text = line.replace(/^\s*\d+\.\s+/, "");
    children.push(new Paragraph({
      numbering: { reference: "ol", level: 0 },
      children: parseInline(text),
    }));
    i++;
    continue;
  }

  // blank line
  if (line.trim() === "") {
    i++;
    continue;
  }

  // normal paragraph
  children.push(new Paragraph({ ...bodyParaProps, children: parseInline(line.trim()) }));
  i++;
}

// ---- styles ----
const headingRun = CJK ? { font: { ascii: "Arial", eastAsia: "Microsoft YaHei" } } : { font: "Arial" };
const doc = new Document({
  styles: {
    default: { document: { run: { font: baseFont, size: 24 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, color: "000000", ...headingRun },
        paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, color: "000000", ...headingRun },
        paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, color: "000000", ...headingRun },
        paragraph: { spacing: { before: 120, after: 120 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "ul",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "ol",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ],
  },
  sections: [{ children }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(outputPath, buf);
  console.log(`OK: wrote ${outputPath}`);
  console.log("Next: validate + preview");
  console.log(`  python scripts/office/validate.py ${outputPath}`);
  console.log(`  python scripts/preview.py ${outputPath} --pages 1,2,last`);
}).catch((e) => {
  console.error("ERROR generating docx:", e.message);
  process.exit(1);
});
