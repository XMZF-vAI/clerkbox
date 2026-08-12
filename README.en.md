<div align="center">

<img src="build/icon.png" alt="ClerkBox" width="120" height="120" />

# ClerkBox

**Single AI Agent Desktop Workbench — put an AI engineer on your desktop**

[![Version](https://img.shields.io/badge/version-1.7.0-7C5CFC?style=flat-square)](https://github.com/XMZF-Studio/ClerkBox)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-26A2C3?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-42-47848F?style=flat-square)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=flat-square)](https://vitejs.dev/)
[![Tailwind](https://img.shields.io/badge/Tailwind-3-38BDF8?style=flat-square)](https://tailwindcss.com/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)](#download-and-install)

</div>

**English** | [简体中文](README.md)

---

> Hi there! I'm a 7th-grade student from XMZF Studio, and I built this project myself.
> I'm still in middle school, so the code may not be perfect, but every line is written with care.
> I hope you enjoy it — feedback and contributions are always welcome!

---

> ClerkBox is a local AI desktop workbench for developers and knowledge workers. It brings **multi-model chat**, **schedulable tool calling**, **sub-agent orchestration**, **a Skills marketplace**, **long-term memory**, and an immersive **VIBE mode** together in a native Windows app, letting you search, write, code, automate, and think in one panel.

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
- [Long-Term Memory](#long-term-memory)
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
| **Plug-and-play models** | Built-in presets for DeepSeek, OpenAI GPT-4o, Claude 3.5 Sonnet, Qwen Max, Zhipu GLM-4, plus any custom OpenAI-compatible endpoint |
| **ReAct tool loop** | Agent reasons → calls tools → observes results → keeps reasoning, up to 999 iterations, abortable at any time |
| **Sub-agent orchestration** | Built-in "Scout" (read-only) and "General" (all tools) agents, plus custom sub-agents with isolated contexts |
| **Skills marketplace** | One-click install of reusable prompt templates from the community, auto-injected into the system prompt |
| **Long-term memory** | Maintains `user` / `feedback` / `project` / `reference` memory entries across sessions |
| **VIBE immersive mode** | Fullscreen background + liquid-glass UI + built-in music player for focused conversations |
| **MD3 dynamic theming** | Material Design 3 color engine, light / dark / system modes, customizable seed color |
| **Native rounded window** | Custom title bar + 12px rounded corners, auto-resets to square when maximized |
| **Local-first** | All data stored locally in SQLite/JSON, zero cloud dependency, fully offline |
| **Apache 2.0 open source** | Free to use, modify, and distribute; includes patent grant, derivative works may choose their own license |

---

## Core Capabilities

### 1. Multi-Model Chat

ClerkBox is not tied to any single model provider. Under **Settings → Models**:

- Pick a model from built-in presets (DeepSeek, OpenAI, Anthropic, Alibaba Qwen, Zhipu GLM)
- Add any OpenAI-compatible custom endpoint (baseUrl + apiKey + model)
- Switch the model used by the current session with one click
- Main agent and sub-agents can use different models

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
- Hit **Stop** at any time to abort
- Dangerous commands (`rm -rf`, `format`, `Stop-Computer`, etc.) are auto-blocked and require confirmation
- A `.clerkbox-bak` backup is created before any file write

### 3. Sub-Agent Orchestration

Complex tasks can spawn sub-agents running in isolated contexts:

| Agent | Type | Capabilities |
| --- | --- | --- |
| `explore` Scout | Read-only | `search_files`, `search_content`, `read_file`, `web_search`, `web_fetch` |
| `general` Assistant | All tools | Inherits all parent-agent tools, runs independently over multiple turns |
| Custom agent | Custom | Configure tools / model / maxTurns / systemPrompt via frontmatter |

Sub-agents only return a **final summary** to the parent agent, so the main context stays clean.

### 4. Skills System

Skills are reusable prompt templates (`SKILL.md` + frontmatter) stored in `.clerkbox/skills/`.

- **Marketplace**: built-in recommended skills, one-click install
- **Custom**: write your own skills in `.clerkbox/skills/<slug>/SKILL.md`
- **Auto-injection**: active skills are injected into the system prompt at session start
- **Hot toggle**: enable / disable skills anytime during a session

### 5. Long-Term Memory

Memory entries are organized by type under `.clerkbox/memory/`:

| Type | Purpose |
| --- | --- |
| `user` | User preferences, background, tech stack (cross-project) |
| `feedback` | User feedback and corrections |
| `project` | Project-level rules, conventions, decisions |
| `reference` | Reference materials, links, notes |

The agent writes entries via the `save_memory` tool and retrieves them quickly through a frontmatter index.

### 6. VIBE Immersive Mode

Enter a distraction-free focus mode with one click:

- Fullscreen background (Pexels by default; custom web or local images supported)
- Liquid-glass message bubbles (`liquid-glass` classes)
- Floating music player in the top-right (single track / music folder)
- Customize menu in the bottom-left (background / music / folder)
- Config persists; normal UI state is preserved after exiting

---

## Download and Install

### Option 1: Installer (recommended)

Download the latest `ClerkBox-Setup-x.x.x.exe` from [Releases](https://github.com/XMZF-Studio/ClerkBox/releases) and double-click to install.

- Installer size: ~90 MB
- Supports Windows 10 / 11 (x64)
- NSIS installer with optional install path and desktop shortcut

### Option 2: Portable

Download `ClerkBox-portable-x.x.x.zip`, unzip it, and run `ClerkBox.exe` directly — no installation required.

---

## Build from Source

### Requirements

- **Node.js** ≥ 18 (20 LTS recommended)
- **npm** ≥ 9 or **pnpm** ≥ 8
- **Windows 10/11** (currently builds for Windows only)

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/XMZF-Studio/ClerkBox.git
cd ClerkBox

# 2. Install dependencies
npm install

# 3. Start dev mode (Vite + Electron together)
npm run dev

# 4. Build production (compile Electron + Vite bundle + electron-builder NSIS installer)
npm run build
```

Build artifacts are placed in `release/`:

- `ClerkBox-Setup-x.x.x.exe` — NSIS installer
- `ClerkBox-x.x.x-win.zip` — portable version
- `win-unpacked/` — unpacked directory

### npm scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start dev server and Electron |
| `npm run build:electron` | Compile Electron main-process TypeScript only |
| `npm run electron` | Compile and launch Electron |
| `npm run build` | Full production build (generates installer) |
| `npm run preview` | Preview the built frontend with Vite |

---

## Quick Start

1. **First launch**: complete the welcome tour, choose a theme and color scheme
2. **Configure models**: go to **Settings → Models** and enter your API key
3. **Pick a working directory**: click the button at the bottom of the sidebar to choose a project folder
4. **Start chatting**: type your request, for example:
   - "Refactor the parseDate function in src/utils.ts"
   - "Analyze this project's dependency structure"
   - "Search for all TODO comments and list them"
5. **Spawn sub-agents**: the agent decides automatically whether a sub-agent is needed for complex subtasks
6. **Enter VIBE mode**: click the VIBE button in the title bar

---

## Configuration

All configuration is managed through the **Settings panel** and persisted locally.

### Model Configuration

```typescript
interface ModelConfig {
  label: string         // display name
  model: string         // model ID
  baseUrl: string       // OpenAI-compatible endpoint
  apiKey: string        // key (stored encrypted)
}
```

### App Configuration

- **Theme**: `light` / `dark` / `system`
- **Color scheme**: MD3 palette preset or custom seed color
- **VIBE mode**: background image, music source
- **Working directory**: project directory bound to the current session
- **Data directory**: defaults to `%APPDATA%/ClerkBox`

### Data Directory Layout

```
.clerkbox/
├── memory/              # long-term memory
│   ├── user/
│   ├── feedback/
│   ├── project/
│   └── reference/
├── skills/              # installed skills
│   └── <slug>/
│       └── SKILL.md
├── agents/              # custom agents
│   └── <name>.md
├── plan/                # Plan mode outputs
└── *.clerkbox-bak       # backups before file modification
```

---

## Tool System

The agent can call the following tools to get work done:

### File Operations

| Tool | Description |
| --- | --- |
| `read_file` | Read a file at the given path, returning full text with line numbers |
| `write_file` | Write a file (auto-backs up the original to `.clerkbox-bak`) |
| `search_replace` | Precise string-match local edit (no line numbers needed) |
| `list_dir` | List directory contents |
| `search_files` | Search files by glob pattern |
| `search_content` | Search file contents by regex |

### Web Tools

| Tool | Description |
| --- | --- |
| `web_search` | Web search (parses cn.bing.com HTML, no API key needed) |
| `web_fetch` | Fetch a webpage, auto-falling back to a hidden BrowserWindow to render SPAs |

### System Tools

| Tool | Description |
| --- | --- |
| `execute_command` | Execute shell commands (dangerous commands auto-blocked) |
| `spawn_agent` | Spawn a sub-agent for a subtask |
| `save_memory` | Write a long-term memory entry |

### Security Mechanisms

- **Dangerous command blocking**: `DANGEROUS_PATTERNS` blacklist covers `rm -rf`, `format`, fork bombs, `Stop-Computer`, etc.
- **Write whitelist**: Plan mode only allows writes under `.clerkbox/plan/`
- **Path validation**: all file operations must stay within the current working directory
- **URL scheme validation**: `openExternal` only allows `http://` / `https://`
- **Sandbox**: `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`

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
author: XMZF
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

- **From the marketplace**: click "Skills" in the sidebar → browse recommendations → one-click install
- **Manually**: put the skill directory into `.clerkbox/skills/<slug>/`
- **From a URL**: the marketplace accepts a GitHub raw URL to pull a remote SKILL.md

### Enable / Disable

Skills can be selectively enabled at the start of each session; active skills are auto-injected into the system prompt.

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
- Testing: Vitest
```

The agent writes entries via the `save_memory` tool, and scans the frontmatter index at session start to quickly load relevant entries.

---

## VIBE Immersive Mode

Switch to a distraction-free focus environment with one click.

### Features

- **Fullscreen background**: high-quality Pexels image by default; custom web or local images supported
- **Liquid-glass UI**: message bubbles, input, and controls use `liquid-glass` frosted-glass effects
- **Music player**: floating controller in the top-right, single track / folder playback, white progress bar
- **Customize menu**: glass menu in the bottom-left to configure background and music
- **Persistence**: all VIBE config persists and auto-restores on launch

### Enter / Exit

- Click the **VIBE** button in the title bar to enter
- Click the **Exit** button in the bottom-right to exit
- Normal UI state is fully preserved after exiting

### Default Music

Built-in default background track `https://xmzf.space/bj.mp3`, replaceable in the customize menu.

---

## Theme & Appearance

ClerkBox uses the Material Design 3 color engine with dynamic theme generation.

### Three Modes

- **Light**: bright palette, for daytime
- **Dark**: default mode, easy on the eyes
- **System**: follows the system theme automatically

### Color Schemes

Built-in MD3 palette presets:

- Violet (default)
- Blue / Green / Orange / Pink / Teal / Indigo
- **Custom seed color**: generate a full palette in real time via `@material/material-color-utilities`

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
│   └── preload.ts               # preload script (contextBridge)
├── src/                         # renderer process (React app)
│   ├── components/
│   │   ├── chat/                # chat-related components
│   │   │   ├── ChatPage.tsx
│   │   │   ├── ChatInput.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageItem.tsx
│   │   │   ├── SkillStore.tsx
│   │   │   ├── SubAgentCard.tsx
│   │   │   ├── SubAgentDetailPanel.tsx
│   │   │   ├── ThemeWaves.tsx
│   │   │   └── ThinkingShimmer.tsx
│   │   ├── layout/              # layout components (Sidebar / TitleBar / FileTree)
│   │   ├── onboarding/          # welcome tour
│   │   ├── settings/            # settings panel
│   │   ├── ui/                  # generic UI components
│   │   └── vibe/                # VIBE mode components
│   ├── hooks/
│   │   └── use-agent.ts         # core agent hook (ReAct loop, streaming, tool dispatch)
│   ├── lib/                     # core libraries
│   │   ├── agent-registry.ts    # agent registry
│   │   ├── tool-registry.ts     # tool definitions
│   │   ├── permission-engine.ts # permission engine (dangerous command detection)
│   │   ├── theme-engine.ts      # MD3 theme engine
│   │   ├── compact.ts           # long-context compaction
│   │   ├── token-estimate.ts    # token estimation
│   │   ├── token-tracker.ts     # token usage tracking
│   │   ├── model-presets.ts     # model presets
│   │   ├── memory.ts            # memory system
│   │   └── ipc-client.ts        # IPC client
│   ├── stores/                  # Zustand state
│   │   ├── chat-store.ts
│   │   ├── settings-store.ts
│   │   ├── skills-store.ts
│   │   ├── agent-runs-store.ts
│   │   ├── ui-store.ts
│   │   └── vibe-store.ts
│   ├── types/                   # TypeScript type definitions
│   ├── App.tsx                  # app root component
│   ├── main.tsx                 # renderer entry
│   └── index.css                # global styles (Tailwind)
├── build/                       # build assets (icons)
├── public/                      # static assets
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── tsconfig.electron.json
└── electron-builder config in package.json
```

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

### Desktop

| Technology | Version | Purpose |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 42 | Cross-platform desktop framework |
| [electron-builder](https://www.electronjs.org/) | 26 | Packaging tool |

### Data Storage

- Session history: local JSON (one file per session ID)
- App config: Zustand persist + localStorage
- Long-term memory: Markdown files + frontmatter index
- Skills & agents: Markdown files

---

## Roadmap

### Done (current version)

- [x] ReAct tool loop + streaming
- [x] Sub-agent orchestration (built-in + custom)
- [x] Skills marketplace
- [x] Long-term memory system
- [x] VIBE immersive mode
- [x] MD3 dynamic theming
- [x] Rounded window + custom title bar
- [x] Welcome tour
- [x] Long-context auto-compaction (compact)
- [x] Token usage tracking
- [x] Anthropic Prompt Caching (static system-prefix caching + hit-rate display)
- [x] Dangerous command blocking
- [x] Automatic file write backup
- [x] i18n (Chinese / English)

### Planned (v1.8+)

- [ ] Session forking: branch a new session from a message
- [ ] Message edit & resend
- [ ] Parallel multi-model comparison
- [ ] Tool-call replay (save as reusable workflow)
- [ ] Visual sub-agent workflow orchestration
- [ ] Streaming resumption
- [ ] Session export (Markdown / JSON / PDF)
- [ ] Cross-session full-text search (SQLite FTS5)
- [ ] Prompt template & variable system
- [ ] Parallel sub-agent execution
- [ ] Skills rating & comments
- [ ] Skills local signature verification
- [ ] Command palette (Ctrl+K)
- [ ] Multi-window multi-session
- [ ] Token usage dashboard
- [ ] macOS / Linux support

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

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `refactor:` refactor
- `perf:` performance
- `docs:` documentation
- `chore:` misc

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
- All model providers: DeepSeek, OpenAI, Anthropic, Alibaba Qwen, Zhipu AI
- All open-source contributors and community feedback

---

<div align="center">

**[Report a Bug](https://github.com/XMZF-Studio/ClerkBox/issues)** · **[Feature Request](https://github.com/XMZF-Studio/ClerkBox/issues)** · **[Pull Request](https://github.com/XMZF-Studio/ClerkBox/pulls)**

Made with care by **XMZF Studio** · Released under the Apache License 2.0

</div>