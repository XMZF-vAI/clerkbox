#!/usr/bin/env python3
"""Replace {{token}} placeholders in a template .docx and write a new file.

Handles tokens that Word has split across multiple runs (a very common cause of
naive find-and-replace failing). Never edits the template in place.

Supported features:
  - Paragraph/table-cell/header/footer token replacement
  - Dynamic table-row expansion from array data (rows:KEY syntax)
  - Missing fields auto-cleared to empty string with log

Usage:
  python fill_template.py templates/contract.docx output.docx \
      --set title="服务采购合同" --set party_a="甲方公司" --set date="2026-06-17" \
      --set-json '{"items": [{"name": "商品A", "qty": "10"}, {"name": "商品B", "qty": "5"}]}'

Placeholders in the template look like: {{title}} {{party_a}} {{date}}
For array expansion, mark a table row with {{rows:items}} and use {{name}} {{qty}} in cells.
"""
import argparse
import copy
import glob
import json
import os
import pathlib
import re
import sys
import zipfile
import shutil
import tempfile
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
ET.register_namespace("w", W_NS)
TEXT_TAG = f"{{{W_NS}}}t"
RUN_TAG = f"{{{W_NS}}}r"
PARA_TAG = f"{{{W_NS}}}p"
ROW_TAG = f"{{{W_NS}}}tr"
TBL_TAG = f"{{{W_NS}}}tbl"

# 用于匹配表格行扩展标记 {{rows:KEY}}
ROWS_RE = re.compile(r"\{\{rows:(\w+)\}\}")
# 用于匹配所有 {{token}} 占位符
TOKEN_RE = re.compile(r"\{\{(\w+)\}\}")


def _safe_extractall(zf, target_dir):
    """解压 zip 时校验路径，防止 Zip Slip（目录遍历）攻击。"""
    target = pathlib.Path(target_dir).resolve()
    for member in zf.infolist():
        member_path = pathlib.Path(member.filename)
        if member_path.is_absolute() or ".." in member_path.parts:
            raise ValueError(f"Unsafe path in zip entry: {member.filename}")
        dest = (target / member_path).resolve()
        if not str(dest).startswith(str(target) + os.sep) and dest != target:
            raise ValueError(f"Path escapes target dir: {member.filename}")
        zf.extract(member, target_dir)


def parse_sets(pairs):
    mapping = {}
    for p in pairs:
        if "=" not in p:
            print(f"WARNING: ignoring malformed --set '{p}' (need key=value)", file=sys.stderr)
            continue
        k, v = p.split("=", 1)
        mapping[k.strip()] = v
    return mapping


def _get_row_text(row):
    """获取表格行的完整文本内容（用于检测 rows: 标记）。"""
    texts = []
    for t in row.iter(TEXT_TAG):
        if t.text:
            texts.append(t.text)
    return "".join(texts)


def _expand_table_rows(root, arrays):
    """处理表格行动态扩展：找到包含 {{rows:KEY}} 的行，按数组数据复制。"""
    expanded = 0
    for tbl in root.iter(TBL_TAG):
        rows = list(tbl.findall(ROW_TAG))
        for row in rows:
            row_text = _get_row_text(row)
            match = ROWS_RE.search(row_text)
            if not match:
                continue
            array_key = match.group(1)
            data_rows = arrays.get(array_key, [])
            if not isinstance(data_rows, list):
                continue

            # 找到模板行在表格中的位置
            row_idx = list(tbl).index(row)

            # 移除原始模板行中的 {{rows:KEY}} 标记
            # 然后为数组中每条数据复制一行并填充
            for i, row_data in enumerate(data_rows):
                new_row = copy.deepcopy(row)
                # 替换行内所有 token（包括 rows:KEY 标记本身）
                for t_node in new_row.iter(TEXT_TAG):
                    if t_node.text and "{{" in t_node.text:
                        text = t_node.text
                        # 先清除 {{rows:KEY}} 标记
                        text = ROWS_RE.sub("", text)
                        # 再替换行内数据 token
                        if isinstance(row_data, dict):
                            for k, v in row_data.items():
                                text = text.replace("{{" + k + "}}", str(v))
                        t_node.text = text
                tbl.insert(row_idx + 1 + i, new_row)
                expanded += 1

            # 移除原始模板行
            tbl.remove(row)

    return expanded


def fill_paragraph(para, mapping):
    """Merge run texts in a paragraph, replace tokens, then write back to the
    first run while clearing the rest. Preserves the first run's formatting."""
    text_nodes = [t for r in para.findall(RUN_TAG) for t in r.findall(TEXT_TAG)]
    if not text_nodes:
        return 0
    full = "".join(t.text or "" for t in text_nodes)
    if "{{" not in full:
        return 0

    replaced = full
    count = 0
    for key, val in mapping.items():
        token = "{{" + key + "}}"
        if token in replaced:
            count += replaced.count(token)
            replaced = replaced.replace(token, val)

    if replaced == full:
        return 0

    # put everything into the first text node, clear the others
    text_nodes[0].text = replaced
    text_nodes[0].set(f"{{http://www.w3.org/XML/1998/namespace}}space", "preserve")
    for t in text_nodes[1:]:
        t.text = ""
    return count


def _clear_remaining_tokens(root):
    """将未被填充的 {{token}} 替换为空字符串，返回被清除的 token 名称集合。"""
    cleared = set()
    for t_node in root.iter(TEXT_TAG):
        if t_node.text and "{{" in t_node.text:
            found = TOKEN_RE.findall(t_node.text)
            if found:
                cleared.update(found)
                t_node.text = TOKEN_RE.sub("", t_node.text)
    return cleared


def _process_xml(xml_path, mapping, arrays):
    """处理单个 XML 文件中的占位符替换，返回 (替换数, 清除的token集合)。"""
    if not os.path.isfile(xml_path):
        return 0, set()

    tree = ET.parse(xml_path)
    root = tree.getroot()
    total = 0

    # 1. 先做表格行扩展
    if arrays:
        total += _expand_table_rows(root, arrays)

    # 2. 替换所有段落中的 token
    for para in root.iter(PARA_TAG):
        total += fill_paragraph(para, mapping)

    # 3. 将剩余未填充的 token 清除为空字符串
    cleared = _clear_remaining_tokens(root)

    tree.write(xml_path, xml_declaration=True, encoding="UTF-8", default_namespace=None)
    return total, cleared


def main():
    ap = argparse.ArgumentParser(description="Fill {{token}} placeholders in a docx template")
    ap.add_argument("template", help="template .docx (not modified)")
    ap.add_argument("output", help="output .docx")
    ap.add_argument("--set", action="append", default=[], metavar="key=value",
                    help="placeholder value, repeatable")
    ap.add_argument("--set-json", default=None, metavar="JSON",
                    help="JSON object with string values and/or array values for row expansion")
    args = ap.parse_args()

    if not os.path.isfile(args.template):
        print(f"ERROR: template not found: {args.template}", file=sys.stderr)
        return 2

    mapping = parse_sets(args.set)
    arrays = {}  # key -> list[dict] 用于表格行扩展

    # 解析 --set-json 参数
    if args.set_json:
        try:
            json_data = json.loads(args.set_json)
            if isinstance(json_data, dict):
                for k, v in json_data.items():
                    if isinstance(v, list):
                        arrays[k] = v
                    else:
                        mapping[k] = str(v)
        except json.JSONDecodeError as e:
            print(f"ERROR: invalid --set-json: {e}", file=sys.stderr)
            return 2

    if not mapping and not arrays:
        print("ERROR: no --set key=value or --set-json provided", file=sys.stderr)
        return 2

    # 确保输出目录存在
    output_dir = os.path.dirname(os.path.abspath(args.output))
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    workdir = tempfile.mkdtemp(prefix="docxpro_")
    try:
        with zipfile.ZipFile(args.template) as z:
            _safe_extractall(z, workdir)

        # 收集所有需要处理的 XML 文件：document.xml + header*.xml + footer*.xml
        word_dir = os.path.join(workdir, "word")
        xml_targets = [os.path.join(word_dir, "document.xml")]
        xml_targets.extend(glob.glob(os.path.join(word_dir, "header*.xml")))
        xml_targets.extend(glob.glob(os.path.join(word_dir, "footer*.xml")))

        if not os.path.isfile(xml_targets[0]):
            print("ERROR: word/document.xml not found in template", file=sys.stderr)
            return 2

        total = 0
        all_cleared = set()
        for xml_path in xml_targets:
            count, cleared = _process_xml(xml_path, mapping, arrays)
            total += count
            all_cleared.update(cleared)

        # 防止覆盖模板
        if os.path.abspath(args.output) == os.path.abspath(args.template):
            print("ERROR: refusing to overwrite the template", file=sys.stderr)
            return 2

        # 重新打包：替换所有处理过的 XML 文件
        modified_parts = set()
        for xml_path in xml_targets:
            if os.path.isfile(xml_path):
                rel = os.path.relpath(xml_path, workdir).replace(os.sep, "/")
                modified_parts.add(rel)

        with zipfile.ZipFile(args.template) as zin, \
             zipfile.ZipFile(args.output, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.namelist():
                if item in modified_parts:
                    local_path = os.path.join(workdir, item.replace("/", os.sep))
                    with open(local_path, "rb") as f:
                        zout.writestr(item, f.read())
                else:
                    zout.writestr(item, zin.read(item))

        print(f"OK: replaced {total} placeholder(s) -> {args.output}")
        if all_cleared:
            print(f"NOTE: cleared {len(all_cleared)} unfilled token(s) to empty: {sorted(all_cleared)}")
        return 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
