---
name: create-skill
version: 2.0.0
description: Guides users through creating effective Agent Skills for ClerkBox. Use when the user wants to create, write, or author a new skill, or asks about skill structure, best practices, SKILL.md format, or the .clerkbox/skills directory.
description_zh: 引导用户为 ClerkBox 创建有效的 Agent 技能。当用户想要创建、编写或制作新技能，或询问技能结构、最佳实践、SKILL.md 格式或 .clerkbox/skills 目录时使用。
icon: 🛠️
category: development
author: ClerkBox
trigger_keywords: [创建技能, 新建技能, 写技能, skill, SKILL.md, 技能格式, 技能规范, 自定义技能]
---

# Creating Skills in ClerkBox

This skill guides you through creating effective Agent Skills for ClerkBox. Skills are markdown files that teach the agent how to perform specific tasks: reviewing PRs using team standards, generating commit messages in a preferred format, querying database schemas, or any specialized workflow.

## How ClerkBox Uses Skills (read this first)

ClerkBox uses **progressive loading**: the system prompt only contains a lightweight skill index (slug, name, description, trigger_keywords, path). The agent reads a skill's SKILL.md via `read_file` **only when it matches the current task**. Therefore:

1. **`description` + `trigger_keywords` are the routing signal** — they decide whether your skill ever gets read. Make them specific.
2. The user can also activate a skill explicitly by typing `/<skill-slug>` at the start of a message.
3. `chains_to` can chain a skill to successor skills (advisory) — after the main action completes, the agent may load a listed successor whose description matches the new state.

## Before You Begin: Gather Requirements

Before creating a skill, gather essential information from the user (ask conversationally, one short round):

1. **Purpose and scope**: What specific task or workflow should this skill help with?
2. **Trigger scenarios**: When should the agent automatically apply this skill?
3. **Key domain knowledge**: What specialized information does the agent need that it wouldn't already know?
4. **Output format preferences**: Are there specific templates, formats, or styles required?
5. **Existing patterns**: Are there existing examples or conventions to follow?

### Inferring from Context

If you have previous conversation context, infer the skill from what was discussed. You can create skills based on workflows, patterns, or domain knowledge that emerged in the conversation.

---

## Skill File Structure

### Directory Layout

Skills are stored as directories containing a `SKILL.md` file:

```
skill-name/
├── SKILL.md              # Required - main instructions
├── reference.md          # Optional - detailed documentation
├── examples.md           # Optional - usage examples
└── scripts/              # Optional - utility scripts
    ├── validate.py
    └── helper.sh
```

### Storage Location

| Scope | Path | 发现时机 |
|-------|------|---------|
| 项目级 | `<working-dir>/.clerkbox/skills/<slug>/` | ClerkBox 打开/切换该工作目录时自动发现 |
| 全局 | `~/.clerkbox/skills/<slug>/` | 所有会话可用 |
| Claude 兼容 | `<working-dir>/.claude/skills/` 或 `~/.claude/skills/` | 与 .clerkbox 路径同机制兼容 |

- 目录名即技能 `slug`（小写字母/数字/连字符），SKILL.md 必须直接位于 `<slug>/` 根下。
- 默认创建**项目级**技能（随项目走、可随仓库分发）；用户明确说"全局/所有项目都能用"时放 `~/.clerkbox/skills/`。
- 技能内引用其他文件时使用相对路径（如 `references/api.md`、`scripts/x.py`），保持一层深度。

### SKILL.md Structure

Every skill requires a `SKILL.md` file with YAML frontmatter and markdown body:

```markdown
---
name: your-skill-name
description: Brief description of what this skill does and when to use it
---

# Your Skill Name

## Instructions
Clear, step-by-step guidance for the agent.

## Examples
Concrete examples of using this skill.
```

### Frontmatter Fields (ClerkBox)

| Field | Required | Rules |
|-------|----------|-------|
| `name` | ✅ | Max 64 chars, lowercase letters/numbers/hyphens only; 与目录名(slug)一致 |
| `description` | ✅ | Max ~1024 chars, non-empty; 决定技能是否被路由命中 |
| `description_zh` | Optional | 中文描述，便于中文用户在商店/列表里理解 |
| `icon` | Recommended | 一个 emoji（默认 ⚡），显示在技能列表 |
| `category` | Recommended | `document` / `automation` / `development` / `online` / `custom`（默认 custom） |
| `trigger_keywords` | Recommended | YAML 字符串数组，如 `[Word, 报告, 合同]`；与 description 一起参与路由 |
| `version` | Optional | 语义化版本，如 `1.0.0` |
| `author` | Optional | 作者名 |
| `chains_to` | Optional | YAML 字符串数组，声明后继技能 slug 列表 |

解析校验提示：`name`/`description` 缺失会被 ClerkBox 标记 warning；`trigger_keywords`、`chains_to` 若存在必须是字符串或字符串数组，否则校验失败。

**Full example:**

```yaml
---
name: contract-review
version: 1.0.0
description: Reviews contract documents for risky clauses, missing terms, and non-standard language against company standards. Use when the user asks to review, check, or redline a contract or agreement.
description_zh: 按公司标准审查合同中的风险条款、缺失条款与非标准表述。当用户要求审查、检查或标注合同/协议时使用。
icon: 📑
category: document
author: your-team
trigger_keywords: [合同, 审查, contract, 协议, 法务]
---
```

---

## Writing Effective Descriptions

The description is **critical** for skill discovery. The agent uses it (with trigger_keywords) to decide when to read your skill.

### Description Best Practices

1. **Write in third person** (the description is injected into the system prompt index):
   - Good: "Processes Excel files and generates reports"
   - Avoid: "I can help you process Excel files"
   - Avoid: "You can use this to process Excel files"

2. **Be specific and include trigger terms**:
   - Good: "Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction."
   - Vague: "Helps with documents"

3. **Include both WHAT and WHEN**:
   - WHAT: What the skill does (specific capabilities)
   - WHEN: When the agent should use it (trigger scenarios)

4. **Mirror the user's language**: 用户多用中文说"做个 PPT"，trigger_keywords 里就要有 `PPT`、`幻灯片`；双语场景各给几个。

---

## Core Authoring Principles

### 1. Concise is Key

The context window is shared with conversation history, other skills, and requests. Every token competes for space.

**Default assumption**: The agent is already very smart. Only add context it doesn't already have.

**Good (concise)**:

```markdown
## Extract PDF text

Use pdfplumber for text extraction:

```python
import pdfplumber

with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
```

**Bad (verbose)**: 解释"PDF 是一种常见文件格式，包含文本和图片，我们需要选择一个库……"——这些 agent 都知道。

### 2. Keep SKILL.md Under 500 Lines

For optimal performance, the main SKILL.md file should be concise. Use progressive disclosure for detailed content.

### 3. Progressive Disclosure

Put essential information in SKILL.md; detailed reference material in separate files that the agent reads only when needed.

```markdown
## Additional resources
- For complete API details, see [reference.md](reference.md)
- For usage examples, see [examples.md](examples.md)
```

**Keep references one level deep** — link directly from SKILL.md to reference files. Deeply nested references may result in partial reads.

### 4. Respect ClerkBox Size Caps

| 限制 | 值 |
|------|-----|
| 单文件 | ≤ 512 KB |
| 单技能文件数 | ≤ 50（超出部分不会被索引） |
| 技能目录总体积 | ≤ 2 MB |

超限文件会被截断或跳过——技能保持精简，大数据用脚本生成而不是随技能携带。

### 5. Set Appropriate Degrees of Freedom

| Freedom Level | When to Use | Example |
|---------------|-------------|---------|
| **High** (text instructions) | Multiple valid approaches, context-dependent | Code review guidelines |
| **Medium** (pseudocode/templates) | Preferred pattern with acceptable variation | Report generation |
| **Low** (specific scripts) | Fragile operations, consistency critical | Database migrations |

---

## Common Patterns

### Template Pattern

Provide output format templates (report structure with fixed sections, placeholders in brackets).

### Examples Pattern

For skills where output quality depends on seeing examples, show 2–3 concrete input → output pairs (e.g., commit message format).

### Workflow Pattern

Break complex operations into clear steps with checklists the agent can copy and track:

```markdown
Task Progress:
- [ ] Step 1: Analyze the form
- [ ] Step 2: Create field mapping
- [ ] Step 3: Fill the form
- [ ] Step 4: Verify output
```

### Conditional Workflow Pattern

Guide through decision points: "Creating new content? → workflow A. Editing existing? → workflow B."

### Feedback Loop Pattern

For quality-critical tasks, implement validation loops:

```markdown
1. Make your edits
2. **Validate immediately**: `python scripts/validate.py output/`
3. If validation fails: fix the issues and run validation again
4. **Only proceed when validation passes**
```

### Utility Scripts

Pre-made scripts are more reliable than generated code, save tokens and time, and ensure consistency. Make clear whether the agent should **execute** the script (most common) or **read** it as reference. Document required packages and error behavior.

---

## Anti-Patterns to Avoid

### 1. Windows-Style Paths
- Use: `scripts/helper.py`
- Avoid: `scripts\helper.py`

### 2. Too Many Options
Provide a default with an escape hatch ("Use pdfplumber. For scanned PDFs requiring OCR, use pdf2image + pytesseract instead.") rather than listing five libraries.

### 3. Time-Sensitive Information
Write "Current method / Old patterns (deprecated)" sections instead of "before August 2025 use the old API".

### 4. Inconsistent Terminology
Choose one term and use it throughout ("API endpoint", not mixing "URL"/"route"/"path").

### 5. Vague Skill Names
- Good: `processing-pdfs`, `analyzing-spreadsheets`
- Avoid: `helper`, `utils`, `tools`

### 6. References That Assume Other Platforms
不要引用 ClerkBox 没有的工具（如结构化提问 UI、产物面板、特定 MCP）。ClerkBox agent 的工具集：`read_file` / `write_file` / `search_replace` / `execute_command`（cmd/PowerShell）/ 文件搜索 / `web_search` / `web_fetch`。需要用户选择时，用文本列出编号选项等待回复。

---

## Skill Creation Workflow

### Phase 1: Discovery
Gather purpose, trigger scenarios, requirements, and reference patterns (see "Before You Begin").

### Phase 2: Design
1. Draft the slug (lowercase, hyphens, max 64 chars)
2. Write a specific, third-person description + trigger_keywords
3. Pick icon and category
4. Outline the main sections; identify supporting files/scripts

### Phase 3: Implementation
1. Create `<working-dir>/.clerkbox/skills/<slug>/`
2. Write the SKILL.md file with frontmatter
3. Create any supporting reference files (one level deep)
4. Create any utility scripts if needed

### Phase 4: Verification
1. YAML frontmatter 可解析，`name`/`description` 非空，`trigger_keywords`/`chains_to` 类型正确
2. SKILL.md under 500 lines；目录 ≤ 50 文件且 ≤ 2MB
3. Description is specific, includes trigger terms, WHAT + WHEN, third person
4. All file references are one level deep and use forward slashes
5. No references to tools ClerkBox doesn't have
6. 告知用户：新技能在 ClerkBox 重新打开会话/切换工作目录后出现在技能列表；也可立即用 `read_file` 读入测试，或直接 `/<slug>` 激活验证

---

## Complete Example

**Directory structure:**
```
code-review/
├── SKILL.md
├── STANDARDS.md
└── examples.md
```

**SKILL.md:**
```markdown
---
name: code-review
version: 1.0.0
description: Reviews code for quality, security, and maintainability following team standards. Use when reviewing pull requests, examining code changes, or when the user asks for a code review.
icon: 🔍
category: development
author: your-team
trigger_keywords: [代码审查, review, CR, 评审]
---

# Code Review

## Quick Start
1. Check for correctness and potential bugs
2. Verify security best practices
3. Assess code readability and maintainability
4. Ensure tests are adequate

## Review Checklist
- [ ] Logic is correct and handles edge cases
- [ ] No security vulnerabilities (SQL injection, XSS, etc.)
- [ ] Code follows project style conventions
- [ ] Error handling is comprehensive
- [ ] Tests cover the changes

## Providing Feedback
- **Critical**: Must fix before merge
- **Suggestion**: Consider improving
- **Nice to have**: Optional enhancement

## Additional Resources
- For detailed coding standards, see [STANDARDS.md](STANDARDS.md)
- For example reviews, see [examples.md](examples.md)
```

---

## Packaging & Sharing

- **随仓库分发**：技能放在项目的 `.clerkbox/skills/<slug>/`，提交到 git 即可随项目共享。
- **打包导入**：把 `<slug>/` 目录打成 zip（根级含 `SKILL.md`，可命名为 `<slug>.skill`），在 ClerkBox 技能商店用"本地导入"安装。
- **发布到商店**：参照 ClerkBox 技能商店（CocoLoop Hub）的技能包格式上传。

---

## Summary Checklist

Before finalizing a skill, verify:

### Core Quality
- [ ] Description is specific and includes key terms (WHAT + WHEN, third person)
- [ ] trigger_keywords 覆盖中英文高频说法
- [ ] icon / category / version / author 已填写
- [ ] SKILL.md body is under 500 lines
- [ ] Consistent terminology throughout
- [ ] Examples are concrete, not abstract

### Structure
- [ ] Slug 与目录名一致，SKILL.md 位于技能目录根
- [ ] File references are one level deep
- [ ] Directory ≤ 50 files, ≤ 2 MB, single file ≤ 512 KB
- [ ] No time-sensitive information
- [ ] No references to tools ClerkBox lacks

### If Including Scripts
- [ ] Scripts solve problems rather than punt
- [ ] Required packages are documented
- [ ] Error handling is explicit and helpful
- [ ] No Windows-style paths
