---
name: pptx
version: 2.0.0
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
description_zh: "当 .pptx 文件以任何方式涉及时使用此技能——无论是作为输入、输出还是两者兼有。包括：创建幻灯片、演示文稿或路演材料；读取、解析或提取任何 .pptx 文件中的文本（即使提取的内容将用于其他地方，如邮件或摘要）；编辑、修改或更新现有演示文稿；合并或拆分幻灯片文件；使用模板、布局、演讲者备注或批注。当用户提及\"幻灯片\"、\"演示文稿\"、\"PPT\"或引用 .pptx 文件名时触发，无论他们计划如何使用内容。只要需要打开、创建或操作 .pptx 文件，就使用此技能。"
icon: 📽️
category: document
author: ClerkBox
trigger_keywords: [PPT, pptx, 幻灯片, 演示文稿, slides, deck, 路演, 汇报, 演讲]
---

# PPTX Pro 2.0 — Fast Path

## Core principle

Generate a polished, professional `.pptx` in 6–10 minutes by following a single five-step fast path:

1. **Gather material** — collect the topic, audience, deck length, and any user-supplied source content.
2. **Ensure environment** — verify Python + `python-pptx`; install if missing.
3. **Write generator** — produce a single `generate.py` script with inline overflow safeguards.
4. **Execute & self-correct** — run, fix any P0 issues in place, rerun.
5. **Deliver** — output the `.pptx` to the current working directory with a one-paragraph QA note.

This skill uses Python + python-pptx as the unified engine for all PPTX operations. Quality bars stay the same; the delivery path is faster and more predictable.

## When to use

Use this skill for any task involving `.pptx` files:

- **From scratch generation** — follow the five-step fast path in this file.
- **Editing an existing .pptx** — follow the three-step path in `references/editing.md` (read structure → write modify script → markitdown verify). Same python-pptx engine, no XML unpacking.
- **Read-only inspection / text extraction** — run `python -m markitdown deck.pptx` directly, or use the structured-read snippet at the top of `references/editing.md`.

## Step 1 — Gather material

Ask only what is genuinely missing. Do not run mandatory multi-round clarification. The minimum context needed is:

- **Topic** — what the deck is about.
- **Audience and tone** — executive, technical, sales, training, internal review.
- **Length** — slide count target, default 6–8.
- **Source content** — paste, file path, or "use public knowledge."

If the user already gave clear instructions, skip the question round and proceed.

## Step 2 — Ensure environment

Run probes. If they succeed, skip install:

```bash
python -c "import pptx; print(pptx.__version__)"
python -m markitdown --help >NUL 2>&1
```

If they fail:

```bash
python -m pip install --quiet python-pptx "markitdown[pptx]"
```

If Python itself is unavailable, note this to the user and suggest installing Python first. Do not attempt to silently install Python.

If `markitdown` cannot be installed, fall back to the pure python-pptx inspection snippet from `references/editing.md` Step 1.

### Optional visual QA tools

For the optional visual check in Step 4:

- **LibreOffice** (`soffice`) — for PPTX → PDF conversion
- **Poppler** (`pdftoppm`) — for PDF → image rendering

If these are not available, skip the visual check and state this explicitly in the QA note at delivery.

## Step 3 — Write the generator

Produce a single self-contained `generate.py` in the workspace. The script must:

- Use `python-pptx` exclusively.
- Define a small palette object (one dominant, one or two supporting, one accent) chosen for the topic. Never default to generic blue unless the topic is genuinely blue-coded.
- Use a recurring visual motif across slides (e.g., side accent bar, numbered chip, soft card with subtle border).
- Set `text_frame.word_wrap = True` and `MSO_AUTO_SIZE.NONE` on every text box, then check `len(text)` against a per-box character budget. If a string would clearly overflow, truncate or rebalance before render — do not rely on a post-process script.
- Use `Inches`, `Pt`, and `RGBColor` for measurements.
- For CJK content, set both `font.name` and the `<a:ea>` East Asian font (see `references/python_pptx_recipes.md`) and prefer Source Han Sans / Microsoft YaHei / PingFang SC.
- After building all slides, call `save_pptx(prs, path)` (defined in `references/python_pptx_skeleton.py`) instead of `prs.save(path)`. This wrapper saves the file and automatically strips the blank placeholder thumbnail that python-pptx inherits from its built-in template. **Never call `prs.save()` directly** — if you do, the file preview will show a white image instead of a text summary.

Name the output file descriptively based on the topic and save it in the current working directory (e.g., `AI趋势分析.pptx`, `Q3-Sales-Review.pptx`). Do not use generic names like `output.pptx`. On delivery, report the final file's absolute path to the user.

A ready-to-adapt template lives at `references/python_pptx_skeleton.py`. Common patterns (cover, two-column, stat callout, comparison, timeline, closing) live at `references/python_pptx_recipes.md`.

## Step 4 — Execute & self-correct

Run the generator:

```bash
python generate.py
```

Then run a tight inline QA pass — no separate gate scripts:

- **Open check** — confirm the file exists and is non-empty.
- **Content check** — `python -m markitdown <output>.pptx` and scan for the topic's key terms, leftover `xxxx`/`Lorem`, and obvious typos.
- **Overflow check** — re-read the script's per-box character budgets; if any string exceeded the budget, fix and rerun.
- **Visual check (when worth the cost)** — for ≥8 slide decks or when the deck is high-stakes, convert via `soffice` + `pdftoppm` and spot-check the cover, one dense slide, and the closer. Skip for short, low-risk decks.

P0 issues (overflow, file corruption, missing user content, invented numbers, typos, orphan CJK breaks) block delivery. Fix and rerun. P1 (weak hierarchy, repeated layouts, generic icons) should be fixed unless explicitly out of scope. P2 (minor alignment, spacing drift) is polish.

Never claim the deck is done while a P0 remains.

## Step 5 — Deliver

Deliver the generated `.pptx` by reporting its absolute path in the reply. Then write a one-paragraph QA note listing which checks ran and any non-blocking caveats (e.g., "visual spot-check skipped for a 6-slide internal deck"). Do not write a long postamble.

## Design quick reference

One dominant color (60–70% weight), one or two support tones, one sharp accent. Commit to a motif: side accent bar, numbered chip, framed image, or recurring data card. Keep heading font and body font distinct. Default safe pairs:

- Latin: Calibri / Calibri Light, Arial / Arial Narrow, Georgia / Calibri.
- CJK: Microsoft YaHei / Microsoft YaHei Light, Source Han Sans Bold / Source Han Sans Regular, PingFang SC Semibold / PingFang SC Regular.

Avoid AI-slop patterns: thin accent lines under titles, fully centered body text, identical 2×2 card grids on every slide, pure-color circular pseudo-icons, generic gradient blobs, orphan CJK characters at line ends, dense bullet slides without any visual structure.

## python-pptx essentials

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_AUTO_SIZE, PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)

slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank

tb = slide.shapes.add_textbox(Inches(0.6), Inches(0.5), Inches(12.1), Inches(1.1))
tf = tb.text_frame
tf.word_wrap = True
tf.auto_size = MSO_AUTO_SIZE.NONE
p = tf.paragraphs[0]
p.alignment = PP_ALIGN.LEFT
r = p.add_run()
r.text = "Slide title"
r.font.name = "Calibri"
r.font.size = Pt(36)
r.font.bold = True
r.font.color.rgb = RGBColor(0x1E, 0x27, 0x61)

save_pptx(prs, "Your-Topic-Name.pptx")  # 根据主题命名，存到当前工作目录
```

> `save_pptx(prs, path)` 定义在 `references/python_pptx_skeleton.py`，生成脚本中必须复制该函数。禁止直接调用 `prs.save()`。

The correct import for `RGBColor` is `from pptx.dml.color import RGBColor`. Use `MSO_AUTO_SIZE.NONE` + `word_wrap=True` to keep text boxes the size you defined, then enforce length budgets in the script itself.

## References

- `references/python_pptx_skeleton.py` — a working starter generator with palette, motif, cover, content, stat-callout, and closing slides.
- `references/python_pptx_recipes.md` — copy-paste recipes: two-column, comparison, timeline, stat grid, chart, CJK typography.
- `references/editing.md` — the three-step path for editing existing `.pptx` files: read structure → write modify script → markitdown verify.

## Delivery standard

Report the final `.pptx` path to the user, then write a one-paragraph QA note. Never deliver a deck with P0 issues. State explicitly which inline QA checks ran and which were skipped.
