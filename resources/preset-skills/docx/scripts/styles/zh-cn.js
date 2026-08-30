/**
 * Chinese (CJK) typography preset for docx-js.
 *
 * Import this into custom docx-js generation code to get consistent Chinese
 * rendering across macOS / Windows / WPS. Western-only fonts trigger Word's
 * font fallback and look inconsistent, so we always declare an `eastAsia` font.
 *
 * Usage:
 *   const { cjkStyles, cjkNumbering, cjkBodyParagraph } = require('./styles/zh-cn.js');
 *   const doc = new Document({ styles: cjkStyles, numbering: cjkNumbering, sections: [...] });
 *   // body paragraphs:
 *   new Paragraph({ ...cjkBodyParagraph, children: [new TextRun({ text: "正文", font: cjkFont })] });
 */
const { AlignmentType, LevelFormat } = require("docx");

const cjkFont = { ascii: "Arial", eastAsia: "Microsoft YaHei" };
const cjkSerifFont = { ascii: "Times New Roman", eastAsia: "SimSun" };

// Body paragraph: 1.5 line spacing + 2-character first-line indent.
const cjkBodyParagraph = {
  spacing: { line: 360, lineRule: "auto", after: 120 },
  indent: { firstLine: 480 }, // ~2 Chinese chars at 12pt
};

const headingBase = (size, before, after, outline) => ({
  run: { size, bold: true, color: "000000", font: cjkFont },
  paragraph: { spacing: { before, after }, outlineLevel: outline }, // no first-line indent
});

const cjkStyles = {
  default: { document: { run: { font: cjkFont, size: 24 } } }, // 12pt body
  paragraphStyles: [
    { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
      ...headingBase(32, 240, 240, 0) },
    { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
      ...headingBase(28, 180, 180, 1) },
    { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
      ...headingBase(26, 120, 120, 2) },
  ],
};

const cjkNumbering = {
  config: [
    { reference: "ul",
      levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    { reference: "ol",
      levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
  ],
};

module.exports = { cjkFont, cjkSerifFont, cjkStyles, cjkNumbering, cjkBodyParagraph };
