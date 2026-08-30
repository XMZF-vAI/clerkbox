# 编辑现有 .pptx（pptx-pro-2.0 编辑章节）

> 三步流程：读取结构 → 写修改脚本 → markitdown 验证。基于 python-pptx，无需解压 XML。

```
┌──────────┐    ┌────────────────┐    ┌────────────────┐
│ 1. 读取   │───▶│ 2. 修改脚本     │───▶│ 3. markitdown  │
│  探索结构 │    │  原地改文本/图  │    │   文本验证      │
└──────────┘    └────────────────┘    └────────────────┘
```

## Step 1 — 读取并探索结构

先用 python-pptx 遍历一遍，弄清楚有哪些 slide、每张 slide 上有哪些 shape、文本在哪里。

```python
from pptx import Presentation

prs = Presentation("input.pptx")
print(f"slides={len(prs.slides)} size={prs.slide_width}x{prs.slide_height}")
for i, slide in enumerate(prs.slides, 1):
    print(f"--- Slide {i} (layout: {slide.slide_layout.name}) ---")
    for shape in slide.shapes:
        info = f"[{shape.shape_type}] {shape.name} @({shape.left},{shape.top}) {shape.width}x{shape.height}"
        if shape.has_text_frame:
            info += f" text={shape.text_frame.text[:40]!r}"
        print(info)
```

需要纯文本快速浏览时用 markitdown：

```bash
python -m markitdown input.pptx
```

## Step 2 — 写修改脚本

把所有改动写进一个 `modify.py`，从 `Presentation("input.pptx")` 开始、`prs.save("output.pptx")` 结束。常用片段：

**逐 run 替换文本（保留格式）**

```python
def replace_text(prs, old, new):
    for slide in prs.slides:
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for para in shape.text_frame.paragraphs:
                for run in para.runs:
                    if old in run.text:
                        run.text = run.text.replace(old, new)
```

**设置某页标题**

```python
def set_title(slide, new_title):
    for shape in slide.shapes:
        if not getattr(shape, "is_placeholder", False):
            continue
        if shape.placeholder_format.idx == 0 and shape.has_text_frame:
            shape.text_frame.paragraphs[0].text = new_title
            return
```

**按形状名替换图片**

```python
def replace_picture(slide, shape_name, image_path):
    for shape in slide.shapes:
        if shape.name == shape_name and shape.shape_type == 13:
            left, top, width, height = shape.left, shape.top, shape.width, shape.height
            shape._element.getparent().remove(shape._element)
            slide.shapes.add_picture(image_path, left, top, width, height)
            return True
    return False
```

**添加 / 删除 / 重排 slide**

```python
def add_slide(prs, layout_index=6):
    return prs.slides.add_slide(prs.slide_layouts[layout_index])

def delete_slide(prs, idx):
    rId = prs.slides._sldIdLst[idx].rId
    prs.part.drop_rel(rId)
    del prs.slides._sldIdLst[idx]

def move_slide(prs, from_idx, to_idx):
    lst = prs.slides._sldIdLst
    el = lst[from_idx]
    del lst[from_idx]
    lst.insert(to_idx, el)
```

**完整脚本骨架**

```python
# -*- coding: utf-8 -*-
from pptx import Presentation

INPUT, OUTPUT = "input.pptx", "output.pptx"

def main():
    prs = Presentation(INPUT)
    replace_text(prs, "旧标题", "新标题")
    set_title(prs.slides[0], "全新标题")
    # delete_slide(prs, len(prs.slides) - 1)
    prs.save(OUTPUT)
    print(f"saved {OUTPUT}")

if __name__ == "__main__":
    main()
```

## Step 3 — markitdown 验证

```bash
python -m markitdown output.pptx
```

逐项对照修改前后：替换是否到位、有无残留占位符（`xxxx` / `Lorem` / `TODO`）、slide 数量与顺序是否符合预期。需要更细的结构核对就再跑一次 Step 1 的遍历代码对比。

## 已知限制

| 限制 | 替代方案 |
|---|---|
| SmartArt 不能直接改 | 解压后操作 XML |
| 动画 / 切换效果不可读写 | 直接动 `slide._element` XML，或保留不动 |
| 修改主题色不自动传播到各形状 | 逐形状手动设色 |
| 母版深度修改支持有限 | 让源文件先在 PowerPoint 里改好母版 |

碰到这些限制时降级到 XML 操作：

```python
from pptx.oxml.ns import qn
slide_xml = slide._element  # 直接对 lxml 元素动手
```

## Step 4 — 交付（复用 PPTX Pro 2.0 标准）

编辑完成后，建议复用 SKILL.md 中 Step 4 & Step 5 的交付标准：

1. 对 `output.pptx` 跑一遍 P0 检查（文件可打开、残留占位符、文本溢出）
2. 在回复中告知最终文件的完整路径，完成交付
3. 附上一段简短 QA 说明，列出执行了哪些检查、跳过了哪些
