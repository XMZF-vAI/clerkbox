# Template authoring & placeholder reference

How `docx-pro` uses templates, and how to add your own.

## Two ways to use a template

### 1. Reference-document styling (recommended for prose)

Pass a `.docx` as `--reference` to `md_to_docx.py`. pandoc copies that file's
styles (fonts, heading styles, margins, header/footer) and pours your Markdown
content into them. The reference doc's *body text is ignored* — only its styles
and section setup are used.

```bash
python scripts/md_to_docx.py body.md out.docx --reference templates/report-standard.docx
```

Best for: reports, memos, letters where the structure comes from your Markdown
and you just want consistent house styling.

### 2. Placeholder replacement (recommended for fixed forms)

For documents with a fixed layout and a few variable fields (contracts, cover
pages), put literal `{{token}}` placeholders in the template and fill them:

```bash
python scripts/fill_template.py templates/contract.docx out.docx \
    --set title="服务采购合同" --set party_a="甲方公司" \
    --set party_b="乙方公司" --set date="2026-06-17"
```

`fill_template.py` merges runs within each paragraph before replacing, so it
works even when Word has split a token like `{{title}}` across multiple runs
(a common reason naive replacement fails). It writes a new file and never
edits the template in place.

## Placeholder conventions

- Use `{{snake_case}}` tokens: `{{title}}`, `{{party_a}}`, `{{effective_date}}`.
- One token = one logical field. Don't embed formatting inside a token.
- Keep tokens on their own run/line where possible for cleanest replacement.
- After filling, the script reports any **unfilled** tokens still present —
  treat that as a checklist, not a silent pass.

## Shipped templates

| File | Layout | Typical tokens |
|------|--------|----------------|
| `report-standard.docx` | cover + TOC + H1–H3 + header/footer + page numbers | `{{title}}`, `{{author}}`, `{{date}}` |
| `memo.docx` | To / From / Subject / Date block + body | `{{to}}`, `{{from}}`, `{{subject}}`, `{{date}}` |
| `letter.docx` | letterhead + body + signature | `{{recipient}}`, `{{sender}}`, `{{date}}` |
| `contract.docx` | numbered clauses + signature area | `{{title}}`, `{{party_a}}`, `{{party_b}}`, `{{date}}` |
| `meeting-minutes.docx` | attendees + agenda + decisions table | `{{meeting_title}}`, `{{date}}`, `{{attendees}}` |

> The repository ships these as lightweight style references. If a template is
> absent or you need a richer design, generate one **once** with the base
> `docx` skill (docx-js), then save it into `templates/` so future runs reuse
> it. This is the intended way to grow the template library.

## Creating a new template

1. Build the document with the base `docx` skill (full control over styles,
   header/footer, tables).
2. Where a field should be variable, insert a literal `{{token}}` as plain
   text in its own run.
3. Save the `.docx` into `templates/`.
4. Document its tokens in the table above (or in your own notes).
5. Use it via `fill_template.py` (tokens) or `--reference` (styling).

## CJK templates

For Chinese templates, build them with the base skill using the preset in
`scripts/styles/zh-cn.js` so heading/body fonts declare `eastAsia`. This keeps
rendering consistent across macOS / Windows / WPS.
