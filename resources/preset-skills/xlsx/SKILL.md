---
name: xlsx
version: 1.0.1
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \"the xlsx in my downloads\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."
description_zh: "当电子表格文件是主要输入或输出时使用此技能。包括：打开、读取、编辑或修复现有的 .xlsx、.xlsm、.csv 或 .tsv 文件（如添加列、计算公式、格式化、图表、清洗数据）；从零或其他数据源创建新电子表格；在表格文件格式之间转换。当用户提及电子表格文件名或路径时触发——即使是随意提及（如\"下载文件夹里的 xlsx\"）——并希望对其进行操作或生成电子表格。也适用于将混乱的表格数据文件（格式错误的行、错位的表头、垃圾数据）清理重组为规范的电子表格。交付物必须是电子表格文件。当主要交付物是 Word 文档、HTML 报告、独立 Python 脚本、数据库管道或 Google Sheets API 集成时，即使涉及表格数据也不要触发。"
license: Proprietary. LICENSE.txt has complete terms
icon: 📊
category: document
author: ClerkBox
trigger_keywords: [Excel, xlsx, xlsm, csv, tsv, 电子表格, 表格, 公式, 图表, 数据透视表, 数据分析]
---

# Spreadsheet Creation, Editing, and Analysis

You have access to multiple tools and workflows for working with `.xlsx` files — from reading and analysing data, through programmatic creation and editing, to formula recalculation and error checking.

## Tooling Primer

| Library | Best for |
|---------|----------|
| **pandas** | Bulk data manipulation, statistical analysis, quick CSV↔XLSX conversion |
| **openpyxl** | Cell-level formatting, Excel formulas, charts, conditional formatting |

## ⛔ CRITICAL — Use Formulas, Never Hardcode Calculations

> **🚨 MANDATORY RULE — ZERO EXCEPTIONS 🚨**
>
> **Every computed value must be an Excel formula, not a Python-calculated literal.**
> This keeps the workbook dynamic and self-updating.
> Violations will produce stale, non-updating spreadsheets.

```python
# ── WRONG — baking Python results into cells ──
total = df['Sales'].sum()
ws['B10'] = total          # static 5000

growth = (df.iloc[-1]['Revenue'] - df.iloc[0]['Revenue']) / df.iloc[0]['Revenue']
ws['C5'] = growth          # static 0.15

avg = sum(vals) / len(vals)
ws['D20'] = avg            # static 42.5
```

```python
# ── RIGHT — let Excel do the maths ──
ws['B10'] = '=SUM(B2:B9)'
ws['C5']  = '=(C4-C2)/C2'
ws['D20'] = '=AVERAGE(D2:D19)'
```

This rule applies to **all** calculations — sums, ratios, percentages, differences, etc.

## Step-by-Step Workflow

1. **Pick a library** — pandas for data; openpyxl for formatting / formulas.
2. **Open or create** the workbook.
3. **Modify** — add/edit data, formulas, and styles.
4. **Save** to disk.
5. **Recalculate** (mandatory when formulas are present):
   ```bash
   python scripts/recalc.py output.xlsx
   ```
6. **Inspect the JSON output** and fix any errors:
   - `status: "errors_found"` → see `error_summary` for types and locations.
   - Common errors: `#REF!` (bad reference), `#DIV/0!` (zero denominator), `#VALUE!` (type mismatch), `#NAME?` (unknown function).

## Reading & Analysing Data

```python
import pandas as pd

df = pd.read_excel('file.xlsx')                        # first sheet
sheets = pd.read_excel('file.xlsx', sheet_name=None)   # all sheets → dict

df.head(); df.info(); df.describe()                    # quick overview

df.to_excel('result.xlsx', index=False)                # write back
```

## Building New Workbooks

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
ws = wb.active

ws['A1'] = 'Header'
ws.append(['Row', 'of', 'data'])
ws['B2'] = '=SUM(A1:A10)'

ws['A1'].font = Font(bold=True, color='FF0000')
ws['A1'].fill = PatternFill('solid', start_color='FFFF00')
ws['A1'].alignment = Alignment(horizontal='center')
ws.column_dimensions['A'].width = 20

wb.save('output.xlsx')
```

## Modifying Existing Files

```python
from openpyxl import load_workbook

wb = load_workbook('existing.xlsx')
ws = wb.active                           # or wb['SheetName']

for name in wb.sheetnames:
    print("Sheet: {}".format(name))

ws['A1'] = 'Updated'
ws.insert_rows(2)
ws.delete_cols(3)

extra = wb.create_sheet('Extra')
extra['A1'] = 'New data'

wb.save('modified.xlsx')
```

## Formula Recalculation

Workbooks produced by openpyxl contain formula *strings* but no cached results.  Use the bundled helper to populate those values:

```bash
python scripts/recalc.py <excel_file> [timeout_seconds]
```

**What it does:**
- Deploys a LibreOffice Basic macro (first run only)
- Invokes LibreOffice headless to recalculate every formula
- Scans all cells for Excel error markers
- Emits structured JSON

**Prerequisite:** LibreOffice must be installed.  The helper handles first-run configuration automatically, including sandboxed environments where Unix sockets are restricted (via `scripts/office/soffice.py`).

### Interpreting the Output

```json
{
  "status": "success",
  "total_errors": 0,
  "total_formulas": 42,
  "error_summary": {}
}
```

When `status` is `"errors_found"`, `error_summary` lists each error type with count and cell locations (up to 20 per type).

---

# Output Quality Standards

## General — All Workbooks

| Area | Requirement |
|------|-------------|
| **Typography** | Use a single professional typeface (Arial, Times New Roman, …) throughout, unless the user specifies otherwise |
| **Error-free delivery** | Zero formula errors — no `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, `#NAME?` |
| **Template fidelity** | When editing an existing file, study and replicate its formatting conventions exactly; never impose a different style on an already-patterned workbook |

## Financial Models

### Colour Conventions (override only when the user or template says otherwise)

| Element | RGB | Hex | Meaning |
|---------|-----|-----|---------|
| Blue text | `(0,0,255)` | `#0000FF` | Hard-coded inputs / scenario toggles |
| Black text | `(0,0,0)` | `#000000` | All formulas and calculated values |
| Green text | `(0,128,0)` | `#008000` | Cross-sheet references within the same workbook |
| Red text | `(255,0,0)` | `#FF0000` | External links to other files |
| Yellow fill | `(255,255,0)` | `#FFFF00` | Key assumptions or cells requiring review |

### Number Formatting

| Data Type | Excel Format Code | Display Example | Notes |
|-----------|-------------------|-----------------|-------|
| Calendar years | _(plain text)_ | `2024` | Never `2,024` — no thousands separator |
| Currency | `$#,##0` | `$1,250` | Always label units in headers, e.g. _Revenue ($mm)_ |
| Zero values | `$#,##0;($#,##0);-` | `-` | Custom three-section format |
| Percentages | `0.0%` | `12.5%` | One decimal place |
| Multiples | `0.0x` | `3.2x` | For EV/EBITDA, P/E, etc. |
| Negatives | `(#,##0)` | `(123)` | Parenthesised, never `-123` |

### Formula Best Practices

- **Centralise assumptions** — growth rates, margins, multiples belong in labelled assumption cells; formulas should reference those cells, not embed literals.
  ```
  =B5*(1+$B$6)   ✓
  =B5*1.05        ✗
  ```
- **Prevent errors** — verify references, check range boundaries, confirm consistent formulas across projection periods, test edge cases.
- **No circular references** — unless explicitly designed and documented.
- **Document hard-codes** — add a cell comment or adjacent note:
  `Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]`

## Formula Verification Checklist

- Spot-check 2–3 references before building the full model.
- Confirm column mapping (column 64 → BL, not BK).
- Remember row offsets (DataFrame row 5 = Excel row 6).
- Guard against `NaN` — use `pd.notna()`.
- Test far-right columns (FY data often sits in column 50+).
- Handle multiple matches — search all occurrences, not just the first.

### Testing Strategy

1. Validate formulas on a small range first.
2. Verify every referenced cell exists.
3. Include zero, negative, and very large values.

## Code Style

When generating Python that manipulates spreadsheets:
- Keep code concise — no verbose names, no gratuitous comments.
- Skip unnecessary `print()` calls.

For the workbook itself:
- Comment cells that contain complex formulas or key assumptions.
- Cite data sources for every hard-coded figure.
- Add section headers and notes for major model blocks.

## Library Tips

### openpyxl

- Indices are **1-based** — `(row=1, column=1)` is cell A1.
- `data_only=True` reads cached values; **warning:** saving afterward strips all formulas permanently.
- For large files: `read_only=True` (reading) or `write_only=True` (writing).
- Formulas are stored as strings and require `scripts/recalc.py` to populate values.

### pandas

- Specify dtypes to avoid inference surprises: `pd.read_excel('f.xlsx', dtype={'id': str})`.
- Limit columns on large files: `usecols=['A', 'C', 'E']`.
- Parse dates explicitly: `parse_dates=['date_column']`.
