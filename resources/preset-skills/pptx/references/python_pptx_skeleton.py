"""
python_pptx_skeleton.py — pptx-pro-2.0 starter generator.

Adapt the PALETTE, MOTIF, and slide builders to the topic. Keep the
inline overflow guard (CHAR_BUDGET) in place — it replaces post-process
overflow scripts.

Run:  python python_pptx_skeleton.py
Output: <topic-name>.pptx (根据实际主题命名)
"""

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_AUTO_SIZE, PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE


# ---------- Topic-informed palette ----------
PALETTE = {
    "dominant":  RGBColor(0x1E, 0x27, 0x61),  # navy
    "support1":  RGBColor(0xCA, 0xDC, 0xFC),  # ice blue
    "support2":  RGBColor(0xF2, 0xF2, 0xF2),  # off-white
    "accent":    RGBColor(0xF9, 0x61, 0x67),  # coral
    "ink":       RGBColor(0x21, 0x21, 0x21),
    "muted":     RGBColor(0x6B, 0x6B, 0x6B),
}

# Latin + CJK font pair. Override per locale.
FONT_HEAD = "Calibri"
FONT_BODY = "Calibri"
FONT_HEAD_EA = "Microsoft YaHei"
FONT_BODY_EA = "Microsoft YaHei"

# Per-box character budgets — overflow defense without external scripts.
CHAR_BUDGET = {
    "cover_title":   60,
    "cover_subtitle": 90,
    "slide_title":   55,
    "section_head":  40,
    "body_line":     90,
    "stat_label":    24,
    "footer":        80,
}


def guard(text: str, key: str) -> str:
    """Hard truncate before render so we never paint overflowing text."""
    limit = CHAR_BUDGET[key]
    if len(text) <= limit:
        return text
    # Truncate at last word boundary under the limit when possible.
    cut = text[: limit - 1]
    sp = cut.rfind(" ")
    return (cut[:sp] if sp > 0 else cut) + "…"


def add_text(slide, text, x, y, w, h, *,
             size=14, bold=False, color=None, align=PP_ALIGN.LEFT,
             font=None, font_ea=None, budget_key=None):
    if budget_key:
        text = guard(text, budget_key)
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = Inches(0.05)
    tf.margin_right = Inches(0.05)
    tf.margin_top = Inches(0.02)
    tf.margin_bottom = Inches(0.02)
    p = tf.paragraphs[0]
    p.alignment = align
    r = p.add_run()
    r.text = text
    r.font.name = font or FONT_BODY
    r.font.size = Pt(size)
    r.font.bold = bold
    if color is not None:
        r.font.color.rgb = color
    # Set East Asian font via low-level XML.
    rPr = r._r.get_or_add_rPr()
    from pptx.oxml.ns import qn
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = rPr.makeelement(qn("a:ea"), {"typeface": font_ea or FONT_BODY_EA})
        rPr.append(ea)
    else:
        ea.set("typeface", font_ea or FONT_BODY_EA)
    return tb


def add_rect(slide, x, y, w, h, fill, line=None):
    shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                 Inches(x), Inches(y), Inches(w), Inches(h))
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill
    if line is None:
        shp.line.fill.background()
    else:
        shp.line.color.rgb = line
    shp.shadow.inherit = False
    return shp


def motif_side_bar(slide):
    """Recurring visual motif: thin coral bar along the left edge."""
    add_rect(slide, 0, 0, 0.18, 7.5, PALETTE["accent"])


# ---------- Slide builders ----------
def build_cover(prs, title, subtitle, footer=""):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_rect(s, 0, 0, 13.333, 7.5, PALETTE["dominant"])
    add_rect(s, 0, 5.6, 13.333, 0.05, PALETTE["accent"])
    add_text(s, title, 0.8, 2.6, 11.7, 1.6,
             size=44, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF),
             font=FONT_HEAD, font_ea=FONT_HEAD_EA, budget_key="cover_title")
    add_text(s, subtitle, 0.8, 4.3, 11.7, 1.0,
             size=20, color=PALETTE["support1"],
             font=FONT_BODY, font_ea=FONT_BODY_EA, budget_key="cover_subtitle")
    if footer:
        add_text(s, footer, 0.8, 6.8, 11.7, 0.4,
                 size=11, color=PALETTE["support1"], budget_key="footer")
    return s


def build_content(prs, title, bullets):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    motif_side_bar(s)
    add_text(s, title, 0.6, 0.5, 12.1, 0.9,
             size=30, bold=True, color=PALETTE["dominant"],
             font=FONT_HEAD, font_ea=FONT_HEAD_EA, budget_key="slide_title")
    y = 1.8
    for i, b in enumerate(bullets):
        # Numbered chip
        add_rect(s, 0.6, y, 0.45, 0.45, PALETTE["dominant"])
        add_text(s, str(i + 1), 0.6, y, 0.45, 0.45,
                 size=14, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF),
                 align=PP_ALIGN.CENTER, budget_key="stat_label")
        add_text(s, b, 1.2, y - 0.02, 11.5, 0.7,
                 size=16, color=PALETTE["ink"], budget_key="body_line")
        y += 0.85
    return s


def build_stat_callout(prs, big_number, label, context):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    motif_side_bar(s)
    add_text(s, big_number, 0.6, 1.4, 12.1, 2.4,
             size=140, bold=True, color=PALETTE["dominant"],
             font=FONT_HEAD, font_ea=FONT_HEAD_EA,
             align=PP_ALIGN.CENTER, budget_key="cover_title")
    add_text(s, label, 0.6, 4.2, 12.1, 0.7,
             size=22, color=PALETTE["accent"], align=PP_ALIGN.CENTER,
             font=FONT_HEAD, font_ea=FONT_HEAD_EA, budget_key="section_head")
    add_text(s, context, 1.6, 5.1, 10.1, 1.5,
             size=14, color=PALETTE["muted"], align=PP_ALIGN.CENTER,
             budget_key="body_line")
    return s


def build_closing(prs, message, footer=""):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    add_rect(s, 0, 0, 13.333, 7.5, PALETTE["dominant"])
    add_text(s, message, 1.0, 3.0, 11.3, 2.0,
             size=40, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF),
             align=PP_ALIGN.CENTER,
             font=FONT_HEAD, font_ea=FONT_HEAD_EA, budget_key="cover_title")
    if footer:
        add_text(s, footer, 1.0, 6.9, 11.3, 0.4,
                 size=11, color=PALETTE["support1"],
                 align=PP_ALIGN.CENTER, budget_key="footer")
    return s


# ---------- Save helper (必须使用) ----------
def save_pptx(prs, path):
    """保存 PPTX 并自动清理 python-pptx 模板自带的空白占位缩略图。

    ⚠️ 始终使用 save_pptx(prs, path) 代替 prs.save(path)。
    python-pptx 的内置模板包含一张全白 docProps/thumbnail.jpeg，若不移除，
    文件管理器/预览面板会显示白色空图而不是文字摘要。

    同时清理 [Content_Types].xml 中对缩略图的引用，避免 PowerPoint
    检测到引用与实际文件不一致而触发修复提示。
    """
    prs.save(path)
    # 移除模板占位缩略图 + 清理 [Content_Types].xml 中的悬空引用
    import zipfile as _zf
    import os as _os
    import re as _re
    tmp = path + ".tmp"
    try:
        with _zf.ZipFile(path, "r") as zin, _zf.ZipFile(tmp, "w") as zout:
            for item in zin.infolist():
                # 跳过缩略图文件本身
                if item.filename.lower().startswith("docprops/thumbnail"):
                    continue
                data = zin.read(item.filename)
                # 清理 [Content_Types].xml 中对 thumbnail 的 Override 条目
                if item.filename == "[Content_Types].xml":
                    content = data.decode("utf-8")
                    content = _re.sub(
                        r'<Override[^>]*PartName="/docProps/thumbnail[^"]*"[^>]*/?>',
                        '',
                        content,
                        flags=_re.IGNORECASE
                    )
                    data = content.encode("utf-8")
                # 清理 _rels/.rels 中对 thumbnail 的 Relationship 条目
                if item.filename == "_rels/.rels":
                    content = data.decode("utf-8")
                    content = _re.sub(
                        r'<Relationship[^>]*Target="docProps/thumbnail[^"]*"[^>]*/?>',
                        '',
                        content,
                        flags=_re.IGNORECASE
                    )
                    data = content.encode("utf-8")
                zout.writestr(item, data)
        _os.replace(tmp, path)
    except Exception as e:
        print("warning: failed to strip template thumbnail:", e)
        try:
            if _os.path.exists(tmp):
                _os.remove(tmp)
        except Exception:
            pass


# ---------- Compose ----------
def main():
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    build_cover(prs,
                title="Your Deck Title Goes Here",
                subtitle="A short, descriptive subtitle that frames the audience and the goal",
                footer="Prepared by ClerkBox  •  2026")

    build_content(prs,
                  title="Three things to remember",
                  bullets=[
                      "First key point, kept under ninety characters for clean wrap.",
                      "Second key point — concrete, specific, no filler language.",
                      "Third key point that closes the section and sets up the next.",
                  ])

    build_stat_callout(prs,
                       big_number="73%",
                       label="Faster than the legacy path",
                       context="Average time-to-deliver across recent internal benchmarks.")

    build_closing(prs,
                  message="Thank you",
                  footer="Questions welcome")

    out = "Your-Topic-Name.pptx"  # 根据实际主题命名，存到当前工作目录
    save_pptx(prs, out)  # ☸️ 不要用 prs.save()，必须用 save_pptx()
    print("wrote", out)


if __name__ == "__main__":
    main()
