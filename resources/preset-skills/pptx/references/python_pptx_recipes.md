# python-pptx Recipes for pptx-pro-2.0

Copy-paste patterns. Adapt palette, sizes, and content to the topic.

## Slide canvas

```python
prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)        # 16:9 wide
# Use prs.slide_layouts[6] for a blank canvas you fully control.
```

## CJK typography

`python-pptx` does not expose East Asian font directly. Set both Latin and EA fonts via XML:

```python
from pptx.oxml.ns import qn

def set_fonts(run, latin, ea):
    run.font.name = latin
    rPr = run._r.get_or_add_rPr()
    ea_el = rPr.find(qn("a:ea"))
    if ea_el is None:
        ea_el = rPr.makeelement(qn("a:ea"), {"typeface": ea})
        rPr.append(ea_el)
    else:
        ea_el.set("typeface", ea)
```

Recommended pairs for Chinese decks: Microsoft YaHei / YaHei Light, Source Han Sans Bold / Regular, PingFang SC Semibold / Regular.

Avoid orphan single CJK characters at line ends — re-break the source string with a half-width space or shorten the line.

## Two-column layout

```python
# Left text, right content card.
add_text(s, "Section title", 0.6, 0.5, 12.1, 0.9, size=30, bold=True,
         color=PALETTE["dominant"], budget_key="slide_title")

add_text(s, body_paragraph, 0.6, 1.7, 6.0, 5.0,
         size=15, color=PALETTE["ink"], budget_key="body_line")

add_rect(s, 7.0, 1.7, 5.7, 5.0, PALETTE["support2"])
add_text(s, card_title, 7.3, 1.9, 5.1, 0.6, size=18, bold=True,
         color=PALETTE["dominant"], budget_key="section_head")
add_text(s, card_body, 7.3, 2.6, 5.1, 3.9,
         size=14, color=PALETTE["ink"], budget_key="body_line")
```

## Comparison (before / after)

```python
columns = [("Before", before_items, PALETTE["muted"]),
           ("After",  after_items,  PALETTE["accent"])]
col_w, gap, left = 5.8, 0.5, 0.6
for i, (head, items, c) in enumerate(columns):
    x = left + i * (col_w + gap)
    add_rect(s, x, 1.5, col_w, 0.7, c)
    add_text(s, head, x, 1.55, col_w, 0.6, size=20, bold=True,
             color=RGBColor(0xFF,0xFF,0xFF), align=PP_ALIGN.CENTER,
             budget_key="section_head")
    y = 2.4
    for item in items:
        add_text(s, "• " + item, x + 0.2, y, col_w - 0.4, 0.6,
                 size=14, color=PALETTE["ink"], budget_key="body_line")
        y += 0.65
```

## Stat grid (2×2)

```python
stats = [("73%", "Faster delivery"),
         ("5", "Steps in the fast path"),
         ("10 min", "Median time to first draft"),
         ("0", "Separate QA scripts to run")]
w, h, gap = 5.8, 2.3, 0.4
for i, (num, label) in enumerate(stats):
    x = 0.6 + (i % 2) * (w + gap)
    y = 1.6 + (i // 2) * (h + gap)
    add_rect(s, x, y, w, h, PALETTE["support2"])
    add_text(s, num, x, y + 0.2, w, 1.2, size=54, bold=True,
             color=PALETTE["dominant"], align=PP_ALIGN.CENTER,
             budget_key="cover_title")
    add_text(s, label, x, y + 1.5, w, 0.6, size=14,
             color=PALETTE["muted"], align=PP_ALIGN.CENTER,
             budget_key="stat_label")
```

## Timeline / numbered steps

```python
steps = ["Gather", "Install", "Generate", "Self-correct", "Deliver"]
x0, y, w, gap = 0.6, 3.2, 2.3, 0.2
for i, label in enumerate(steps):
    x = x0 + i * (w + gap)
    add_rect(s, x, y, w, 1.0, PALETTE["dominant"])
    add_text(s, str(i + 1), x, y, w, 1.0, size=22, bold=True,
             color=PALETTE["accent"], align=PP_ALIGN.CENTER,
             budget_key="stat_label")
    add_text(s, label, x, y + 1.1, w, 0.5, size=14,
             color=PALETTE["ink"], align=PP_ALIGN.CENTER,
             budget_key="section_head")
```

## Chart (native, editable)

```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

cd = CategoryChartData()
cd.categories = ["Q1", "Q2", "Q3", "Q4"]
cd.add_series("Revenue", (1.2, 1.6, 1.9, 2.4))

chart_shape = s.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    Inches(0.8), Inches(1.6), Inches(11.7), Inches(5.2), cd)
chart = chart_shape.chart
chart.has_legend = False
chart.has_title = False
```

Keep at most one chart per slide. Label data points directly when there are fewer than six bars; skip the legend.

## Image with rounded corners

```python
pic = s.shapes.add_picture(path, Inches(0.6), Inches(1.6),
                           width=Inches(6.0))
# Round the corners by switching the shape to a rounded rectangle clip.
from pptx.oxml.ns import qn
sppr = pic._element.spPr
prstGeom = sppr.find(qn("a:prstGeom"))
if prstGeom is not None:
    prstGeom.set("prst", "roundRect")
```

## Footer with page number

```python
def add_footer(slide, idx, total, label=""):
    add_text(slide, label, 0.6, 7.05, 8.0, 0.35, size=10,
             color=PALETTE["muted"], budget_key="footer")
    add_text(slide, f"{idx}/{total}", 11.5, 7.05, 1.2, 0.35, size=10,
             color=PALETTE["muted"], align=PP_ALIGN.RIGHT,
             budget_key="footer")
```

## Inline overflow defense

Always set on every text frame:

```python
tf.word_wrap = True
tf.auto_size = MSO_AUTO_SIZE.NONE
```

Then enforce the budget at render time via `guard(text, key)` from the skeleton. This eliminates the need for `overflow_test.py` as a separate gate.

## What to avoid

- Centering body paragraphs and bullet lists. Center titles only.
- Thin horizontal lines under every title.
- Identical card grids on every slide — vary at least one of: column count, accent placement, or imagery.
- Pure-color circles used as stand-in icons. Either use a real icon or skip it.
- Reading bullets at 12pt or smaller. Body text floor is 14pt.
- Three or more font weights on a single slide.
