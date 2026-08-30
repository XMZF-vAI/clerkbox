<div align="center">

<img src="build/icon.png" alt="ClerkBox" width="120" height="120" />

# ClerkBox

**A local-first AI desktop workbench: multi-provider chat, MCP tool ecosystem, sub-agents, skills, workbench, and VIBE immersive mode.**

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2FXMZF-vAI%2Fclerkbox%2Freleases%2Flatest&query=%24.tag_name&label=version&style=flat-square&color=7C5CFC)](https://github.com/XMZF-vAI/clerkbox/releases)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-26A2C3?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-42-47848F?style=flat-square)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)](#download-and-install)

</div>

**English** | [简体中文](README.md)

---

> ClerkBox is a local-first AI desktop workbench. It brings multi-provider chat, a ReAct tool loop, sub-agent orchestration, reusable skills, long-term memory, and VIBE immersive mode together in a native Windows app, so you can search, write, code, and automate from a single panel.

> ClerkBox is built by [XMZF Studio](https://github.com/XMZF-vAI) — the author is a 7th-grade student. Bug reports and ideas are very welcome via Issues.

---

## Table of Contents

- [Highlights](#highlights)
- [Core Capabilities](#core-capabilities)
- [Download and Install](#download-and-install)
- [Build from Source](#build-from-source)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Tool System](#tool-system)
- [Sub-Agents](#sub-agents)
- [Skills System](#skills-system)
- [MCP Servers](#mcp-servers)
- [Long-Term Memory](#long-term-memory)
- [Workbench Panel](#workbench-panel)
- [/goal Mode](#goal-mode)
- [WebUI Remote Access](#webui-remote-access)
- [AGENTS.md Project Instructions](#agentsmd-project-instructions)
- [VIBE Immersive Mode](#vibe-immersive-mode)
- [Theme & Appearance](#theme--appearance)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## Highlights

| Capability | Description |
| --- | --- |
| **Multi-provider presets** | 22 built-in providers (Lunora / OpenAI / Anthropic / Gemini / DeepSeek / Qwen / Zhipu GLM / Ollama, etc.). Each provider pulls its model list from `/models` automatically. Custom endpoints with OpenAI or Anthropic protocol supported. |
| **ReAct tool loop** | Reason → call tools → observe → reason again, up to 100 iterations with an automatic wrap-up summary, abortable at any time. |
| **MCP tool ecosystem** | Connect Model Context Protocol servers and inject external tools into the conversation; one-click install from the MCP Hub China marketplace in the extension store. |
| **Approval modes** | TRAE-style manual / auto / full approval tiers, plus a `/` command menu for the Spec / Plan / Goal workflows. |
| **Sub-agent orchestration** | Built-in read-only Scout and full-tool General assistant, plus custom sub-agents via frontmatter with isolated contexts. |
| **Skills auto-discovery** | Full skill catalog injected into context — the AI discovers and loads skills on demand without manual activation; extension store / MCP Hub / 6 bundled preset skills out of the box. |
| **/goal mode** | Session goals are evaluated every round (in-progress / achieved / impossible) and the agent auto-continues; the AI can proactively produce TodoList plan cards and ask questions on key decisions. |
| **Workbench panel** | Trae-style right-side workbench: file tree / terminal / browser / sub-agents in one place. |
| **Long-term memory** | `user` / `feedback` / `project` / `reference` memory entries persist across sessions. |
| **Thinking & per-model tuning** | Per-model thinking toggle / tiers (low / medium / high), temperature and token limits; model picker groups models by thinking capability. |
| **AGENTS.md project instructions** | Auto-reads `AGENTS.md` from the working directory and injects it into the system prompt; falls back to `CLAUDE.md`. |
| **VIBE immersive mode** | Fullscreen background in three modes (single / slideshow / glass), liquid-glass UI, and a floating music player (system audio supported). |
| **MD3 dynamic theming** | Material Design 3 color engine with light / dark / system modes and custom seed color. |
| **WebUI remote access** | Built-in web server exposes the full UI to any browser; binds to localhost by default, with a one-click LAN toggle and scan-to-connect QR code, real-time data sync between desktop and web, and an auto-switching mobile layout on narrow screens. |
| **Local-first** | All sessions, memory, skills, and config live on disk — no cloud dependency. |

---

## Core Capabilities

### 1. Multi-Provider Chat

`src/lib/provider-catalog.ts` ships **22 provider presets** sorted into 6 groups: official / international / china / aggregator / local / custom.

- Presets only fill in the baseUrl and protocol (OpenAI or Anthropic) when adding a provider
- Model IDs are pulled live from each provider's `/models` endpoint, so the catalog never goes stale
- Switch the current model at any time during a session; the main agent and sub-agents can use different models
- Thinking-capable models are auto-detected by keyword match; unmatched models can be toggled manually in per-model settings
- **Per-model advanced settings**: configure thinking toggle / tiers, temperature, context budget and output limits independently for each model

### 2. ReAct Tool Loop

The main agent uses the standard ReAct (Reasoning + Acting) pattern:

```
User input
   ↓
LLM reasoning (thinking)
   ↓
Tool call (read_file / search_content / execute_command / ...)
   ↓
Tool results flow back
   ↓
Keep reasoning or return the final answer
```

- Streaming output with real-time thinking display
- Hit **Stop** at any time to abort, including force-kill of child processes
- Dangerous commands (`rm -rf`, `format`, `Stop-Computer`, etc.) are auto-blocked and require confirmation
- **Hardened toolchain**: `read_file` pagination with truncation-resume, command timeouts (120s default) with oversized-output spill, ripgrep-accelerated search, doom-loop detection, truncated-response refusal — long sessions stay stable and cheap

### 3. Sub-Agent Orchestration

Complex tasks can spawn sub-agents running in isolated contexts:

| Agent | Type | Capabilities |
| --- | --- | --- |
| `explore` Scout | Read-only | `search_files`, `search_content`, `read_file`, `web_search`, `web_fetch` |
| `general` Assistant | All tools | Inherits all parent-agent tools, runs independently over multiple turns |
| Custom agent | Custom | Configure tools / model / maxTurns / systemPrompt via frontmatter |

Sub-agents only return a **final summary** to the parent agent, so the main context stays clean.

### 4. Skills System

Skills are reusable capability packs (`SKILL.md` + frontmatter) bundled with the installer or installed from the marketplace, complete with scripts and reference material:

- **Auto-discovery**: the full skill catalog is injected into context (with in-budget three-level degradation) — the AI discovers and loads skills on demand, no manual activation needed
- **Bundled preset skills**: six skills (docx / pdf / pptx / xlsx / find-skills / create-skill) ship with the installer and are seeded on first launch
- **Extension store**: a dual-tab marketplace for skills and MCP servers, backed by CocoLoop Hub and MCP Hub China — one-click install, persisted to disk
- **`/slug` direct activation**: type `/skill-name` to activate instantly; trigger-word hits bring a loading reminder
- See [Skills System](#skills-system) and [MCP Servers](#mcp-servers) for details

### 5. MCP Server Ecosystem

Connect external tool servers via the Model Context Protocol; their tools register dynamically into the conversation loop:

- **One-click install**: browse MCP Hub China servers from the MCP tab of the extension store
- **Custom servers**: add manually via stdio / SSE transports
- See [MCP Servers](#mcp-servers) for details

### 6. Long-Term Memory

Memory entries are organized by type under `.clerkbox/memory/`:

| Type | Purpose |
| --- | --- |
| `user` | User preferences, background, tech stack (cross-project) |
| `feedback` | User feedback and corrections |
| `project` | Project-level rules, conventions, decisions |
| `reference` | Reference materials, links, notes |

The agent writes entries via the `save_memory` tool and retrieves them through a frontmatter index.

### 7. AGENTS.md Project Instructions

ClerkBox follows the cross-tool standard: at the start of every session, it auto-reads `AGENTS.md` from the working-directory root and injects it into the system prompt, so the AI immediately knows the project's stack, build commands, and coding conventions.

- **Cross-tool standard**: `AGENTS.md` is the common convention promoted by [agentskills.io](https://agentskills.io) and [agents.md](https://agents.md); natively supported by OpenAI Codex, OpenCode, Qwen Coder, etc.
- **CLAUDE.md fallback**: under **Settings → General**, enable "CLAUDE.md compatibility" to fall back to `CLAUDE.md` when `AGENTS.md` is absent
- **Fully optional**: turn injection off if you don't need it

### 8. VIBE Immersive Mode

One click to enter a focused conversation environment. See [VIBE Immersive Mode](#vibe-immersive-mode) for details.

---

## Download and Install

Download the latest `ClerkBox Setup x.x.x.exe` from [Releases](https://github.com/XMZF-vAI/clerkbox/releases) and double-click to install.

- Installer size: ~200 MB
- Supports Windows 10 / 11 (x64)
- NSIS installer with a built-in EULA page, optional install path, desktop shortcut, and uninstaller

---

## Build from Source

### Requirements

- **Node.js** ≥ 18 (20 LTS recommended)
- **npm** ≥ 9 or **pnpm** ≥ 8
- **Windows 10/11** (currently builds for Windows only)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/XMZF-vAI/clerkbox.git
cd clerkbox

# 2. Install dependencies
npm install

# 3. Start dev mode (Vite + Electron together)
npm run dev

# 4. Build production (compile Electron main + Vite bundle + electron-builder NSIS installer)
npm run build
```

Build artifacts land in `release-out/`:

- `ClerkBox Setup x.x.x.exe` — NSIS installer
- `ClerkBox Setup x.x.x.exe.blockmap` — incremental-update blockmap
- `latest.yml` — electron-updater metadata
- `win-unpacked/` — unpacked directory

### npm scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start dev server (port 5175) and Electron |
| `npm run dev:alt` | Same, using port 5176 (when 5175 is busy) |
| `npm run build:electron` | Compile Electron main-process TypeScript only |
| `npm run build` | Full production build (generates installer) |
| `npm run preview` | Preview the built frontend with Vite |

---

## Quick Start

1. **First launch**: complete the welcome tour, choose a theme and color scheme
2. **Add a provider**: go to **Settings → API Config → Add Provider**, pick one of the 22 presets, and enter your API key. Model IDs auto-populate from the provider's `/models` endpoint.
3. **Pick a working directory**: click the button at the bottom of the sidebar to choose a project folder
4. **(Optional) Add AGENTS.md**: drop an `AGENTS.md` at the working-directory root to describe your project stack and conventions
5. **Start chatting**: type your request, for example:
   - "Refactor the parseDate function in src/utils.ts"
   - "Analyze this project's dependency structure"
   - "Search for all TODO comments and list them"
6. **Spawn sub-agents**: the agent decides automatically whether a sub-agent is needed for complex subtasks
7. **Set a goal and let it run**: type a goal command to enter goal mode — the AI evaluates progress each round and auto-continues until done
8. **Enter VIBE mode**: click the VIBE button in the title bar

---

## Configuration

All configuration is managed through the **Settings panel** and persisted locally.

### App Configuration

- **Theme**: `light` / `dark` / `system`
- **Color scheme**: MD3 palette preset or custom seed color
- **VIBE mode**: background image, music source
- **Working directory**: project directory bound to the current session
- **Data directory**: defaults to `%APPDATA%/ClerkBox`
- **Language**: Chinese (default) / English, switchable at runtime
- **AGENTS.md injection**: auto-read `AGENTS.md` from the working-directory root into the system prompt; optional `CLAUDE.md` fallback
- **Token usage**: total API calls, input/output tokens, cache writes/hits and hit rate (Settings → General)
- **Per-model advanced settings**: configure thinking toggle / tiers, Temperature, context budget and output Max Tokens independently for each model
- **WebUI remote access**: see [WebUI Remote Access](#webui-remote-access)

### Data Directory Layout

```
.clerkbox/
├── memory/              # long-term memory
│   ├── user/
│   ├── feedback/
│   ├── project/
│   └── reference/
├── skills/              # installed skills (incl. seeded preset skills)
│   └── <slug>/
│       └── SKILL.md
├── agents/              # custom agents
│   └── <name>.md
```

> The user home directory also hosts `~/.clerkbox/` (global skill library, oversized command-output spill under `tmp/`, etc.).

---

## Tool System

The agent can call the following tools to get work done:

### File Operations

| Tool | Description |
| --- | --- |
| `read_file` | Paginated file reading (`offset` / `limit`), 50KB max per call, with a resume hint when truncated |
| `write_file` | Write a file (subject to the permission engine and approval mode) |
| `search_replace` | Precise string-match local edit (no line numbers; CRLF normalization, staleness detection, fuzzy-miss suggestions) |
| `list_dir` | List directory contents |
| `search_files` | Search files by glob pattern (ripgrep first, built-in fallback) |
| `search_content` | Search file contents by regex (ripgrep first) |

### Web Tools

| Tool | Description |
| --- | --- |
| `web_search` | Web search (parses cn.bing.com HTML, no API key needed) |
| `web_fetch` | Fetch a webpage, auto-falling back to a hidden BrowserWindow to render SPAs |

### System & Extension Tools

| Tool | Description |
| --- | --- |
| `execute_command` | Execute shell commands (dangerous commands auto-blocked; 120s default timeout, 600s max; output over 50KB spills to a file) |
| `spawn_agent` | Spawn a sub-agent for a subtask |
| `save_memory` | Write a long-term memory entry |
| MCP tools | Tools exposed by connected MCP servers register dynamically and run in the same loop as built-ins |

### Security Mechanisms

- **Approval modes**: manual (confirm each time) / auto (whitelist pass-through) / full (allow all), TRAE-style
- **Dangerous command blocking**: `DANGEROUS_PATTERNS` blacklist covers `rm -rf`, `format`, fork bombs, `Stop-Computer`, etc.
- **Write whitelist**: Plan mode only allows writes under `.clerkbox/plan/`
- **Path validation**: all file operations must stay within the current working directory (cross-platform path comparison unified in `path-safety.ts`)
- **Doom-loop guard**: repeated identical tool calls are refused automatically
- **URL scheme validation**: `openExternal` only allows `http://` / `https://`

---

## Sub-Agents

### Built-in Agents

#### Scout (`explore`)

A read-only recon agent, great for broad searches and multi-file reading:

- Only `read_file` / `list_dir` / `search_files` / `search_content` / `web_search` / `web_fetch`
- Default 30-turn limit
- Never creates, modifies, or deletes any files

#### General (`general`)

A general-purpose sub-task executor:

- Inherits all parent-agent tools
- Default 50-turn limit
- Isolated context, returns only a final summary

### Custom Agents

Create a Markdown file in `.clerkbox/agents/`:

```markdown
---
name: translator
description: Chinese-English translation expert
whenToUse: use when high-quality translation is needed
tools: [read_file, write_file, web_search]
disallowedTools: [execute_command]
model: deepseek-chat
maxTurns: 20
color: purple
---

You are a Chinese-English translation expert. Rules:
- Preserve the original tone and style
- Prefer industry-standard terminology for technical documents
- Output a bilingual comparison when done
```

Field reference:

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Agent type identifier (unique) |
| `description` | No | Display name |
| `whenToUse` | No | When to use this agent |
| `tools` | No | Allowed tools; `[*]` means all |
| `disallowedTools` | No | Disallowed tools |
| `model` | No | Model ID |
| `maxTurns` | No | Max iteration turns |
| `color` | No | Accent color (blue/green/purple/...) |

---

## Skills System

### Skill Format

Each skill is a directory containing a `SKILL.md` file:

```markdown
---
name: code-reviewer
description: Code review expert
version: 1.0.0
---

You are a senior code review expert. When reviewing, focus on:
1. Security vulnerabilities
2. Performance issues
3. Readability
4. Error handling

Output format:
- Severity (high/medium/low)
- Problem description
- Fix suggestion
```

### Installing Skills

- **Preset skills**: six skills (docx / pdf / pptx / xlsx / find-skills / create-skill) ship with the installer and are seeded into `.clerkbox/skills/` on first launch
- **From the extension store**: click "Skills" in the sidebar → skills tab → one-click install (data source: [CocoLoop Hub](https://hub.cocoloop.cn)); installs persist to the local skill library and survive restarts
- **Manually**: put the skill directory into `.clerkbox/skills/<slug>/`
- **From a URL**: the marketplace accepts a GitHub raw URL to pull a remote SKILL.md

### Skill Auto-Discovery

Modeled after Claude Code / Codex, ClerkBox lets the AI use skills without manual activation:

- **Full catalog injection**: every skill's name / description / path is injected as a lightweight catalog (8000-char budget, 250 chars per entry, automatic three-level degradation when over budget); active skills are pinned to the top with a ⚡ marker
- **Smart trigger reminders**: when the conversation hits a skill's `trigger_keywords` or name, a `<system-reminder>` nudges the AI to load it
- **On-demand full load**: the AI reads the full `SKILL.md` via `read_file`; loaded skills show as chips on the message bubble
- **`/slug` direct activation**: type `/skill-name` in the input to activate instantly, with optional trailing prompt; a bare `/slug` only activates
- **Task-shift awareness**: Skill Router guidance tells the AI to re-check for better-matching skills when the task focus changes

### Enable / Disable

Skills can be selectively enabled per session; active skills are pinned in the catalog with guaranteed full-text availability, and can be toggled anytime.

---

## MCP Servers

ClerkBox connects to external tool servers via the [Model Context Protocol](https://modelcontextprotocol.io), so conversations can call the third-party tool ecosystem directly.

### Install & Manage

- **One-click install**: switch to the MCP tab in the Skills panel and browse servers from [MCP Hub China](https://mcp.cocoloop.cn)
- **Custom servers**: add manually via stdio local commands or remote endpoints
- **Toggle per server**: enable / disable each server independently, with live connection status

### How It Works

- Tools from enabled servers register dynamically at session start and run in the same ReAct loop as built-ins (`read_file` / `execute_command`...)
- Tool results flow back in a unified format, with streaming and abort support
- MCP connections are owned by the main process; the renderer accesses them over IPC

---

## Long-Term Memory

The memory system lets the agent keep understanding your projects and preferences across sessions.

### Memory Types

| Type | Directory | Purpose |
| --- | --- | --- |
| `user` | `.clerkbox/memory/user/` | User profile: preferences, background, tech stack, style |
| `feedback` | `.clerkbox/memory/feedback/` | User feedback and corrections |
| `project` | `.clerkbox/memory/project/` | Project-level conventions, architectural decisions, rules |
| `reference` | `.clerkbox/memory/reference/` | Reference materials, links, notes |

### Memory File Format

```markdown
---
name: preferred-stack
description: User's preferred frontend stack
type: user
mtime: 2026-07-20
---

User preferences:
- Framework: React 19 + TypeScript
- State: Zustand
- Styling: Tailwind CSS
- Build: Vite
```

The agent writes entries via the `save_memory` tool, and scans the frontmatter index at session start to quickly load relevant entries.

---

## Workbench Panel

A Trae-style right-side workbench that keeps the agent's working context in one place (WorkbenchPanel):

- **Files**: working-directory file tree with click-to-preview
- **Terminal**: built-in PTY terminal (node-pty) — watch the agent's commands live or step in manually
- **Browser**: embedded web view
- **Sub-agents**: sub-agent run status and output

The panel shares the same working directory as the conversation and can be collapsed.

---

## /goal Mode

Modeled after Claude Code's goal mechanism, long tasks keep moving on their own:

- **Set a goal**: enter a goal via the `/` command menu; a persistent goal banner appears above the input
- **Auto evaluation**: an independent evaluator at the end of each tool loop judges **in-progress / achieved / impossible** and shows its reasoning
- **Auto-continue**: "in-progress" automatically starts the next round until the goal is achieved or confirmed impossible; stop any time
- **Restart-safe**: goal state persists locally and survives app restarts

Companion interactive cards keep the AI communicating proactively:

- **TodoListCard**: the AI proposes a task plan checklist and checks items off as it progresses
- **QuestionCard**: the AI asks the user about key decisions — click an option to answer
- **Skill chips**: loaded skills show as chips on the message bubble

---

## WebUI Remote Access

ClerkBox ships with a built-in web server that exposes the full UI to any browser for remote control — perfect for deploying the app on a server and accessing it from any device.

### How to Start

- **Manual start from desktop**: click the 🌐 icon above the settings button in the sidebar. A dialog shows the tokenized access URL — copy it with one click or open it directly in your default browser. The service can be stopped from the same dialog at any time.
- **LAN access & QR scan**: ticking "Allow LAN access" in the dialog binds the server to all network interfaces and generates a QR code when a LAN IP is detected — scan it with your phone to connect instantly (shown only when LAN access is on and a network adapter address is found; never points to localhost).
- **Auto start for servers**: set the environment variable `CLERKBOX_WEBUI_AUTO=1` before launching the app; the WebUI starts automatically and prints the access URL to the console (auto-start binds to localhost by default — enable LAN access in the desktop app first for remote use).

### Features

- **Full functionality**: chat, tool calls, streaming output (SSE), settings, and skills work the same as on desktop
- **Real-time data sync**: settings, skills, VIBE config, and token usage are synchronized between desktop and web via a shared main-process store; sessions and messages share the same local database
- **Security**: a random token is generated on every start and required for all API requests; the static file server includes path-traversal protection
- **Adaptive UI**: window control buttons (minimize / maximize / close) are automatically hidden in WebUI mode
- **Mobile layout on narrow screens**: the web page switches to a mobile UI (large touch targets, bottom-sheet menus, virtual-keyboard avoidance) for convenient use on phones
- **Browser files**: the local or third-device WebUI can upload one file at a time to the host (10MB per file by default) and choose a host working directory from a directory browser

### Notes

- The WebUI binds to `127.0.0.1` with a random port by default, so it is only reachable from this machine; after ticking "Allow LAN access" it binds to `0.0.0.0` and any device on the same LAN can reach it. For public deployment, use a reverse proxy with HTTPS
- Browser WebUI cannot open the host's native file-picker dialogs, so it uses browser uploads and a host-folder browser instead. Uploads default to 10MB per file and can be adjusted with `CLERKBOX_WEBUI_MAX_UPLOAD_MB` (1-100MB)
- API keys are kept in OS-level encryption (safeStorage) and never enter the shared store in plaintext

---

## VIBE Immersive Mode

Switch to a distraction-free focus environment with one click.

### Features

- **Fullscreen background**: default fullscreen image, custom web or local images supported
- **Liquid-glass UI**: message bubbles, input, and controls use `liquid-glass` frosted-glass effects
- **Music player**: floating controller in the top-right, single track / folder playback
- **Customize menu**: glass menu in the bottom-left to configure background and music
- **Persistence**: all VIBE config persists and auto-restores on launch

### Enter / Exit

- Click the **VIBE** button in the title bar to enter
- Click the **Exit** button in the bottom-right to exit
- Normal UI state is fully preserved after exiting

---

## Theme & Appearance

ClerkBox uses the Material Design 3 color engine with dynamic theme generation.

### Three Modes

- **Light**: bright palette, for daytime
- **Dark**: default mode
- **System**: follows the system theme automatically

### Color Schemes

Built-in MD3 palette presets: Violet (default), Blue, Green, Orange, Pink, Teal, Indigo. Custom seed colors generate a full palette in real time via `@material/material-color-utilities`.

### Visual Details

- **Rounded window**: 12px rounded corners, auto-reset to square when maximized
- **Custom title bar**: frameless window + custom window control buttons
- **Wave animation**: themed triple sine-wave animation at the bottom of empty conversations
- **Liquid glass**: unified frosted-glass visual language in VIBE mode

---

## Project Structure

```
ClerkBox/
├── electron/                    # Electron main process
│   ├── main.ts                  # main entry (IPC, filesystem, command execution, etc.)
│   ├── api-proxy.ts             # model API proxy (streaming chat, connection test)
│   ├── webui-server.ts          # WebUI server (HTTP + SSE + token auth)
│   └── preload.ts               # preload script (contextBridge)
├── src/                         # renderer process (React app)
│   ├── components/
│   │   ├── chat/                # chat-related components
│   │   ├── layout/              # layout components (Sidebar / TitleBar / FileTree)
│   │   ├── onboarding/          # welcome tour
│   │   ├── settings/            # settings panel
│   │   ├── ui/                  # generic UI components
│   │   └── vibe/                # VIBE mode components
│   ├── hooks/
│   │   └── use-agent.ts         # core agent hook (ReAct loop, streaming, tool dispatch)
│   ├── lib/                     # core libraries
│   │   ├── agent-registry.ts    # agent registry
│   │   ├── api-adapters.ts      # multi-protocol adapters
│   │   ├── api-transport.ts     # streaming transport layer
│   │   ├── tool-registry.ts     # tool definitions (incl. dynamic MCP tools)
│   │   ├── permission-engine.ts # permission engine (dangerous command detection)
│   │   ├── provider-catalog.ts  # provider preset catalog
│   │   ├── theme-engine.ts      # MD3 theme engine
│   │   ├── prompts.ts           # system prompt construction (static/dynamic split for prefix caching)
│   │   ├── skill-catalog.ts     # skill catalog rendering (in-budget three-level degradation)
│   │   ├── skill-matcher.ts     # skill trigger matching (trigger_keywords / names)
│   │   ├── path-safety.ts       # cross-platform path comparison & safety
│   │   ├── compact.ts           # long-context compaction
│   │   ├── token-estimate.ts    # token estimation
│   │   ├── token-tracker.ts     # token usage tracking
│   │   ├── memory.ts            # memory system
│   │   ├── ipc-client.ts        # IPC client (Electron / WebUI dual mode)
│   │   └── shared-storage.ts    # cross-mode shared persistence
│   ├── stores/                  # Zustand state
│   ├── types/                   # TypeScript type definitions
│   ├── App.tsx                  # app root component
│   ├── main.tsx                 # renderer entry
│   └── index.css                # global styles (Tailwind)
├── build/                       # build assets (icons, installer EULA license.txt)
├── resources/preset-skills/     # preset skills bundled with the installer
├── public/                      # static assets
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── tsconfig.electron.json
```

electron-builder configuration lives in the `build` field of [package.json](package.json).

---

## Tech Stack

### Frontend

| Technology | Version | Purpose |
| --- | --- | --- |
| [React](https://react.dev/) | 19 | UI framework |
| [TypeScript](https://www.typescriptlang.org/) | 6 | Type system |
| [Vite](https://vitejs.dev/) | 5 | Build tool |
| [Tailwind CSS](https://tailwindcss.com/) | 3 | Atomic CSS |
| [Zustand](https://github.com/pmndrs/zustand) | 5 | State management |
| [lucide-react](https://lucide.dev/) | 1 | Icon library |
| [Vercel AI SDK](https://sdk.vercel.ai/) | 6 | Streaming LLM calls |
| [@material/material-color-utilities](https://github.com/material-foundation/material-color-utilities) | 0.4 | MD3 color engine |
| [cheerio](https://cheerio.js.org/) | 1.2 | HTML parsing (web_search) |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 1.30 | MCP server integration |

### Desktop

| Technology | Version | Purpose |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 42 | Cross-platform desktop framework |
| [electron-builder](https://www.electronjs.org/) | 26 | Packaging tool |
| [node-pty](https://github.com/microsoft/node-pty) | 1.1 | Workbench built-in terminal |

### Data Storage

- Session history: local JSON (one file per session ID)
- App config: Zustand persist + localStorage (cross-mode via main-process KV bridge)
- Long-term memory: Markdown files + frontmatter index
- Skills & agents: Markdown files

---

## Roadmap

### Done

- ReAct tool loop + streaming
- Sub-agent orchestration (built-in + custom)
- Skills marketplace (CocoLoop Hub)
- Long-term memory system
- VIBE immersive mode
- MD3 dynamic theming
- Rounded window + custom title bar
- Welcome tour
- Long-context auto-compaction (compact)
- Token usage tracking and stats panel
- Prefix-cache optimization (static/dynamic system split + frozen memory snapshot + Anthropic dual breakpoints; 90%+ in-session hit rate)
- Dangerous command blocking
- Automatic file write backup
- i18n (Chinese / English)
- AGENTS.md project instruction injection (cross-tool standard, CLAUDE.md fallback)
- Hard-stop tool execution (main-process child-process tracking and termination)
- Multi-provider presets with automatic `/models` fetching
- Thinking control (toggle / tier modes + model picker grouped by thinking capability)
- Per-model advanced settings (independent temperature / thinking tiers / token limits per model)
- WebUI remote access (browser control + dual-mode data sync + server auto-start)
- MCP server integration (external tool ecosystem + MCP Hub China marketplace)
- Extension store (dual-tab marketplace for skills + MCP)
- Trae-style workbench panel (files / terminal / browser / sub-agents)
- TRAE-style approval modes (manual / auto / full) + `/` command menu (Spec / Plan / Goal workflows)
- /goal mode (end-of-round evaluator + auto-continue + restart-safe)
- TodoList / Question interactive cards and loaded-skill chips
- Skill auto-discovery (full catalog injection + trigger reminders + `/slug` + 6 bundled preset skills)
- Hardened toolchain (read_file pagination, command timeout & output spill, ripgrep-first search, doom-loop guard, truncated-response refusal, search_replace hardening)
- Static/dynamic system-prompt split (better prefix-cache hit rate)
- Context usage indicator with manual compaction
- VIBE upgrade (background single / slideshow / glass modes + system audio)
- Skill marketplace search coverage improvements

---

## Contributing

Issues and Pull Requests are welcome.

### Development Flow

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'feat: add amazing feature'`
4. Push the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:` / `fix:` / `refactor:` / `perf:` / `docs:` / `chore:` and friends.

### Code Style

- Strict TypeScript
- React function components + Hooks
- Atomic Tailwind CSS
- Prefer `React.memo` + `useMemo` for streaming render performance
- Main-process IPC handlers must validate path legality

---

## License

This project is open source under the [Apache License, Version 2.0](LICENSE).

```
Apache License 2.0

Copyright 2026 XMZF Studio

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## Acknowledgements

- [Electron](https://www.electronjs.org/) — cross-platform desktop framework
- [React](https://react.dev/) — UI library
- [Vercel AI SDK](https://sdk.vercel.ai/) — unified LLM layer
- [Material Design 3](https://m3.material.io/) — design system
- [Tailwind CSS](https://tailwindcss.com/) — styling utility
- [CocoLoop Hub](https://hub.cocoloop.cn) — Skills community data source

---

<div align="center">

**[Report a Bug](https://github.com/XMZF-vAI/clerkbox/issues)** · **[Feature Request](https://github.com/XMZF-vAI/clerkbox/issues)** · **[Pull Request](https://github.com/XMZF-vAI/clerkbox/pulls)**

Made by **XMZF Studio** · Apache License 2.0

</div>
