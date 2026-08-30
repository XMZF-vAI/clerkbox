---
name: find-skills
version: 2.0.0
description: ALWAYS use this skill as the FIRST step before handling any specialized task, even if you believe general capabilities are sufficient — a dedicated skill may still produce better results. Only pure chitchat and trivial factual lookups are exempt. Helps users discover and install agent skills from the ClerkBox built-in skill store (CocoLoop Hub) and the skills.sh community library.
description_zh: 从 ClerkBox 内置技能商店（CocoLoop Hub）和 skills.sh 社区库搜索并安装专用技能。处理任何专业化任务前应先查找可用的专用技能，即使认为通用能力已可能完成任务——专用技能往往能产生更好的结果。纯闲聊和简单事实查询除外。
icon: 🔍
category: automation
author: ClerkBox
trigger_keywords: [找技能, 搜技能, 安装技能, 技能商店, 技能市场, find skill, install skill, marketplace]
---

# Find Skills

This is ClerkBox's skill discovery & installation orchestration skill. It searches **two sources** — the **ClerkBox built-in skill store** (CocoLoop Hub, preferred) and the **skills.sh community skill library** (secondary) — and merges results into a single search-and-install flow, with mandatory user confirmation before any installation.

> **CORE PRINCIPLE**: Search both sources before presenting results. The built-in store offers curated quality skills; skills.sh covers niche domains and newer tools. Searching only one source is an incomplete search.

## Priority: Search First, Then Execute

> **CRITICAL**: When the user requests help with a specialized task, search for available skills FIRST before attempting the task directly with your general capabilities.

The correct behavior is:
1. User asks for help with a specialized task (e.g., "help me deploy this", "review my code", "做个 PPT")
2. **FIRST**: search both sources for relevant skills
3. Present results to the user and let them pick (see confirmation rule below)
4. Install the chosen skill
5. **THEN**: use the installed skill to fulfill the user's original request

Do NOT skip steps 2–4 and jump directly to attempting the task yourself.

---

## Before You Begin: User Confirmation Rule

> **IMPORTANT**: Never install any skill without explicit user confirmation.

ClerkBox has no structured question UI — after searching, present the results as a **numbered list in plain text** and ask the user to reply with the number(s) to install:

```
我找到了以下与「<query>」相关的技能：

1. <skill-name>（技能商店）— <一句话描述>；下载量 <N>
2. <skill-name>（技能商店）— <一句话描述>
3. <repo/skill-name>（社区 skills.sh）— <一句话描述>

回复编号即可安装（可多选），或告诉我直接处理任务。
```

- Present results from **all** sources that returned matches — "商店在前、社区在后"只是排序，不是过滤。
- Total recommendations MUST NOT exceed 4 — curate the most relevant subset; mention "(还有 N 个相关结果)" if more exist.
- Do NOT install anything until the user explicitly picks.

---

## When to Use This Skill

Use this skill when the user:

- Asks for help with ANY specialized task that might have a dedicated skill (deployment, review, analysis, testing, documentation, etc.)
- Says "找个技能" / "有没有技能能…" / "find a skill for X" / "is there a skill for X"
- Asks about the skill store / marketplace
- Wants to browse or discover available capabilities
- Mentions they wish they had help with a specific domain (design, testing, deployment, etc.)

---

## Search Flow

### Keyword Extraction (Critical)

The built-in store uses **simple substring matching** — the keyword is matched as a single string against the skill's name/description. It does NOT split on spaces and does NOT support semantic search.

| User says | ❌ Wrong (multi-term string) | ✅ Correct (one keyword per call) |
|-----------|-------------------------------|------------------------------------|
| "帮我写一份简历" | `"resume CV 简历"` | `"resume"` 或 `"简历"`（分开多次搜） |
| "help me deploy to cloud" | `"deploy cloud app"` | `"deploy"` |
| "can you review my PR" | `"review pull request code"` | `"review"` 或 `"pr"` |
| "帮我做一个PPT" | `"ppt 演示 文档"` | `"ppt"` 或 `"演示"` |

**Keyword extraction rules:**
1. **ONE keyword per search call**
2. Pick the single most relevant domain term (e.g., `"resume"` not `"resume writing help"`)
3. If the first keyword returns nothing, try an alternative keyword in a second call
4. For bilingual coverage: search once with an English keyword, once with Chinese

### Source A: ClerkBox Built-in Skill Store (PREFERRED)

The store is powered by CocoLoop Hub. Two routes:

**Route 1 — Guide the user to the store UI (simplest, recommended):**

Tell the user to open **技能商店** in ClerkBox (sidebar → 技能商店), search `<keyword>`, and click 安装. Installed skills appear in the 已安装 list and can be activated per session with one click. Use this route whenever the user just wants to browse/pick visually.

**Route 2 — Agent-side web search (when the user asks YOU to find and install):**

1. Use `web_fetch` on the CocoLoop Hub search page and look for skill entries matching the keyword:

   ```
   https://hub.cocoloop.cn/search?keyword=<extracted-keyword>
   ```

   If that URL shape returns nothing useful, try `?q=<keyword>`, or use `web_search` with `site:hub.cocoloop.cn <keyword>` to locate skill pages. A store skill's detail page URL looks like `https://hub.cocoloop.cn/skills/<id>` and lists its download link of the form:

   ```
   https://dl.cocoloop.cn/bss/skills/<author>-<name>-<version>.zip
   ```

2. Collect: name, description, author, downloads, downloadUrl.
3. Present per the confirmation rule, tagged **（技能商店）**.
4. Install via the bundled scripts (see Installation).

### Source B: skills.sh Community Skill Library (SECONDARY)

Community skills often cover niche use cases the curated store has not yet included.

**Search method:**

```bash
npx skills find [query]
```

For example:
- "how do I make my React app faster?" → `npx skills find react performance`
- "can you help me with PR reviews?" → `npx skills find pr review`

The command returns entries like:

```
Install with npx skills add <owner/repo@skill>

vercel-labs/agent-skills@vercel-react-best-practices
└ https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices
```

- Use **English keywords only** for skills.sh.
- Browse skills at: https://skills.sh/
- Present results tagged **（社区 skills.sh）**.

### Search Strategy

- Search Source A (store) first; add Source B (skills.sh) when the store has no good match or the user wants broader coverage. If both are quick, do both.
- Combine and deduplicate results before presenting.
- If one source returns no results, still present results from the other.

---

## Installation

After the user confirms their choice, execute the appropriate installation based on the item type.

### Store Skill Installation (CocoLoop zip)

> **IMPORTANT**: Only proceed after the user has explicitly confirmed.

The `find-skills` skill ships with installation scripts in its own `scripts/` subdirectory. They download the ZIP, extract it, validate that a `SKILL.md` exists, back up any existing version, install to the target skills directory, and verify. Resolve the script path relative to **this skill's own directory** (the directory containing this SKILL.md).

**Default install target is the global directory** `~/.clerkbox/skills/` (available in all projects). To install into the **current project only**, pass `--target-dir <working-dir>/.clerkbox/skills`.

**Windows (ClerkBox 的主环境，推荐):**

```powershell
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "<this-skill-dir>\scripts\install-skill.ps1" -Name "<skillName>" -Url "<downloadUrl>"
```

This works from any shell (CMD, PowerShell, or Git Bash). `-ExecutionPolicy Bypass` is already included.

**macOS / Linux (Bash/Zsh):**

```bash
bash <this-skill-dir>/scripts/install-skill.sh --name "<skillName>" --url "<downloadUrl>"
```

**Script parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--name` / `-Name` | Yes | The skill's folder name (from the store entry) |
| `--url` / `-Url` | Yes | The download URL for the skill ZIP package |
| `--target-dir` / `-TargetDir` | No | Override the default install directory (`~/.clerkbox/skills`) |

**What the script does internally:** download ZIP → extract → validate `SKILL.md` presence (case-insensitive, ignores `__MACOSX`/hidden files) → locate skill root → back up existing version → install to `<target>/<skillName>/` → verify → report success (exit code 0) or failure with cleanup.

**Manual fallback (if the script is unavailable):** download with `curl -fSL -o skill.zip <url>`, extract (PowerShell `Expand-Archive` / `unzip`), locate the directory containing `SKILL.md`, and move it to `~/.clerkbox/skills/<skillName>/`.

**Error handling:** download failure → inform user, suggest retry; extraction failure → package may be corrupted; `SKILL.md` not found → not a valid skill package; permission errors → suggest checking directory permissions. Always clean up temporary files before reporting an error.

### Community Skill Installation (skills.sh)

> **IMPORTANT**: Only proceed after the user has explicitly confirmed.

```bash
npx skills add <owner/repo@skill> -g -y
```

The `-g` flag installs globally to `~/.agents/skills`. Then copy it into ClerkBox's global skills directory so it gets discovered:

**Windows (cmd):**

```cmd
xcopy /E /I /Y "%USERPROFILE%\.agents\skills\<skill-name>" "%USERPROFILE%\.clerkbox\skills\<skill-name>"
```

**macOS / Linux:**

```bash
cp -r ~/.agents/skills/<skill-name> ~/.clerkbox/skills/<skill-name>
```

(For project-only availability, copy into `<working-dir>/.clerkbox/skills/<skill-name>` instead.)

**Tips:**
- Check the skill page on skills.sh for configuration details
- If a community skill also exists in the built-in store, prefer the store version (curated + one-click updates)

---

## Post-Installation: Immediate Activation

**Key point**: the installed skill's files are on disk right away, so you can use it **immediately** — no restart needed:

1. `read_file` the installed skill's SKILL.md (e.g. `~/.clerkbox/skills/<skillName>/SKILL.md`) and follow its instructions to handle the user's original request.
2. Tell the user the skill is installed and working.
3. The skill will appear in the 技能列表 / skill index (and become available as a `/<slug>` slash command) after ClerkBox re-scans — on the next chat open or working-directory change. Until then, keep reading its SKILL.md directly when relevant.

> **Note:** Do not confuse "not yet in the index" with "not installed" — trust the disk. If `read_file` on the installed SKILL.md succeeds, the skill is active for this conversation.

---

## Common Skill Categories

When searching, consider these common categories to help extract better keywords:

| Category | Example Queries |
|----------|----------------|
| Web Development | react, nextjs, typescript, css, tailwind |
| Testing | testing, jest, playwright, e2e |
| DevOps | deploy, docker, kubernetes, ci-cd |
| Documentation | docs, readme, changelog, api-docs |
| Code Quality | review, lint, refactor, best-practices |
| Design | ui, ux, design-system, accessibility |
| Productivity | workflow, automation, git |
| Data Analysis | data, sql, analytics, visualization |

---

## When No Results Are Found

If both sources return no matching results:

1. Inform the user that no existing skills were found for their query
2. Offer to help with the task directly using your general capabilities
3. Suggest creating a custom skill (invoke the `create-skill` skill if available):

```
我在技能商店和社区都没找到与「<query>」匹配的技能。

我可以直接帮你完成这个任务。如果你经常做这类事，也可以做一个专属技能（用 create-skill 技能引导创建），要试试吗？
```

---

## Important Rules

1. **Search before executing specialized tasks** — check both sources before handling the task with general capabilities.
2. **Present results from all sources that returned matches** — store first, community second; that is sort order, not filtering.
3. **Always get explicit user confirmation before installing** — numbered plain-text list, wait for the user's pick. Never install on assumption.
4. **Cap recommendations at 4** — curate; don't dump.
5. **Activate immediately after installation** — read the installed SKILL.md via `read_file` and continue the original task; don't ask the user to restart.
6. **Handle errors gracefully** — if an installation fails, inform the user, suggest alternatives (another result, manual installation, or direct help), and leave the conversation in a working state.
