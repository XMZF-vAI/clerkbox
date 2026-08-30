# Markdown → docx pipeline reference

Detailed mapping and edge cases for the `docx-pro` Markdown pipeline. Read this
when the default conversion output is not what you expected.

## Engine selection recap

| Condition | Engine | Command |
|-----------|--------|---------|
| pandoc installed | pandoc (preferred) | `python scripts/md_to_docx.py in.md out.docx` |
| no pandoc, node+docx | Node fallback | `node scripts/md_to_docx.mjs in.md out.docx` |
| neither | — | install one, or use base `docx` skill |

Run `python scripts/doctor.py` to decide.

## Markdown element support (Node fallback)

| Markdown | Rendered as | Notes |
|----------|-------------|-------|
| `# … ######` | Heading 1–6 | Mapped to `HeadingLevel`, so TOC works |
| `- / * / +` | bullet list | via numbering API, never literal glyph |
| `1.` | ordered list | DECIMAL numbering |
| `**bold**`, `__bold__` | bold run | |
| `*italic*`, `_italic_` | italic run | |
| `` `code` `` | inline code | Consolas font |
| ```` ``` ```` | code block | shaded paragraph, Consolas |
| `> quote` | blockquote | left border + indent |
| `\| a \| b \|` | table | DXA widths, header shading |
| `![alt](path)` | image | ImageRun with `type` + altText |
| `---` | horizontal rule | bottom-bordered paragraph |
| `[text](url)` | inline link text | rendered as `text (url)` |

### Known limitations of the Node fallback

- **Single-level lists only.** Nested lists render flat. For deep nesting,
  prefer pandoc, or post-edit via the base `docx` skill.
- **Tables must be pipe tables** with a separator row (`|---|---|`).
- **No footnotes / definition lists / task lists.** Use pandoc for these.
- **Links** become `text (url)` rather than clickable hyperlinks (keeps the
  fallback dependency-free). pandoc produces real hyperlinks.

When richer fidelity matters, install pandoc and use `md_to_docx.py`.

## Images

- Relative image paths are resolved against the **Markdown file's directory**,
  not the current working directory. Keep images next to the `.md`, or use
  absolute paths.
- Supported types: png, jpg/jpeg, gif, bmp, svg. Default display size is
  480×320 px in the Node fallback; edit the `transformation` if needed.
- A missing image becomes an italic `[missing image: …]` placeholder so the
  document still builds — check the log for these.

## Table of Contents

- pandoc: pass `--toc` (and optionally `--toc-depth N`). The TOC field updates
  when the user opens the document in Word and chooses "update field", or
  automatically in many viewers.
- Node fallback: does not emit a TOC field. If you need one, either use pandoc
  or build the document with the base `docx` skill's `TableOfContents`.

## Page size

- pandoc uses the reference document's section properties. Supply a
  `--reference` doc sized to your target (A4 vs US Letter).
- Node fallback defaults to docx-js A4. For US Letter, post-process with the
  base skill or add explicit section `page.size` in custom code.

## Post-generation checklist

```
- [ ] python scripts/office/validate.py out.docx           (schema OK)
- [ ] python scripts/preview.py out.docx --pages 1,2,last  (visual OK)
- [ ] tables not squeezed / no margin overflow
- [ ] CJK text renders with the intended font (no tofu boxes)
- [ ] TOC populated (if requested)
```

Validation passing is necessary but NOT sufficient — always eyeball a render
for any non-trivial document.
