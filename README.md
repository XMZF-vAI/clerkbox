<div align="center">

<img src="build/icon.png" alt="ClerkBox" width="120" height="120" />

# ClerkBox

**Single AI Agent Desktop Workbench — 把 AI 工程师装进你的桌面**

[![Version](https://img.shields.io/badge/version-1.6.0-7C5CFC?style=flat-square)](https://github.com/XMZF-Studio/ClerkBox)
[![License: MIT](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-42-47848F?style=flat-square)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=flat-square)](https://vitejs.dev/)
[![Tailwind](https://img.shields.io/badge/Tailwind-3-38BDF8?style=flat-square)](https://tailwindcss.com/)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square)](#下载与安装)

</div>

---

> ClerkBox 是一个面向开发者与知识工作者的本地 AI 桌面工作台。它把**多模型对话**、**可调度的工具调用**、**子 Agent 编排**、**Skills 技能市场**、**长期记忆**与一套沉浸式的 **VIBE 氛围模式**整合进一个原生 Windows 应用，让你在同一个工作面板里完成搜索、写作、编码、自动化与思考。

---

## 目录

- [亮点速览](#亮点速览)
- [核心能力](#核心能力)
- [界面预览](#界面预览)
- [下载与安装](#下载与安装)
- [从源码构建](#从源码构建)
- [快速开始](#快速开始)
- [配置](#配置)
- [工具系统](#工具系统)
- [子 Agent](#子-agent)
- [Skills 技能系统](#skills-技能系统)
- [长期记忆](#长期记忆)
- [VIBE 沉浸模式](#vibe-沉浸模式)
- [主题与外观](#主题与外观)
- [项目结构](#项目结构)
- [技术栈](#技术栈)
- [路线图](#路线图)
- [贡献](#贡献)
- [许可证](#许可证)
- [致谢](#致谢)

---

## 亮点速览

| 能力 | 描述 |
| --- | --- |
| **多模型即插即用** | 内置 DeepSeek、OpenAI GPT-4o、Claude 3.5 Sonnet、通义千问 Max、智谱 GLM-4 等模型预设，支持自定义任意 OpenAI 兼容端点 |
| **ReAct 工具循环** | Agent 自主推理 → 工具调用 → 观察结果 → 继续推理，最多 999 轮迭代，可在任意时点中止 |
| **子 Agent 编排** | 内置"侦察兵"（只读）与"通用助手"（全工具），支持自定义子 Agent，独立上下文隔离执行 |
| **Skills 技能市场** | 一键安装来自社区的可复用提示词模板，自动注入 system prompt |
| **长期记忆系统** | 自动维护 user / feedback / project / reference 四类记忆条目，跨会话延续上下文 |
| **VIBE 沉浸模式** | 全屏背景图 + 液态玻璃 UI + 内置音乐播放器，专注对话本身 |
| **MD3 动态主题** | 基于 Material Design 3 色彩引擎，浅色 / 深色 / 跟随系统三种模式，支持自定义种子色 |
| **原生圆角窗口** | 自绘标题栏 + 12px 圆角，最大化时自动恢复直角，细节考究 |
| **本地优先** | 所有数据存储在本地 SQLite/JSON，零云端依赖，完全离线可用 |
| **MIT 开源** | 完全自由使用、修改、分发 |

---

## 核心能力

### 1. 多模型对话

ClerkBox 不绑定任何单一模型供应商。在 **设置 → 模型** 中：

- 从内置预设选择模型（DeepSeek、OpenAI、Anthropic、阿里通义、智谱 GLM）
- 添加任意 OpenAI 兼容的自定义端点（baseUrl + apiKey + model）
- 一键切换当前会话使用的模型
- 主 Agent 与子 Agent 可使用不同模型

### 2. ReAct 工具循环

主 Agent 采用标准 ReAct（Reasoning + Acting）模式：

```
用户输入
   ↓
LLM 推理（thinking）
   ↓
工具调用（read_file / search_content / execute_command / ...）
   ↓
工具结果回流
   ↓
继续推理或返回最终答案
```

- 流式输出，思考过程实时显示
- 任意时刻可点 **停止** 按钮中止
- 危险命令（`rm -rf`、`format`、`Stop-Computer` 等）自动拦截并要求确认
- 文件写入前自动创建 `.clerkbox-bak` 备份

### 3. 子 Agent 编排

复杂任务可派生子 Agent 在独立上下文中执行：

| Agent | 类型 | 能力 |
| --- | --- | --- |
| `explore` 侦察兵 | 只读 | `search_files`、`search_content`、`read_file`、`web_search`、`web_fetch` |
| `general` 通用助手 | 全工具 | 继承父 Agent 全部能力，独立多轮执行 |
| 自定义 Agent | 自定义 | 通过 frontmatter 配置 tools / model / maxTurns / systemPrompt |

子 Agent 完成后仅把**最终总结**回传给父 Agent，主上下文不被污染。

### 4. Skills 技能系统

Skills 是可复用的提示词模板（`SKILL.md` + frontmatter），存放在 `.clerkbox/skills/` 目录。

- **技能市场**：内置推荐技能，一键安装
- **自定义**：在 `.clerkbox/skills/<slug>/SKILL.md` 编写自己的技能
- **自动注入**：激活后的技能会在会话开始时注入 system prompt
- **热切换**：会话中可随时启用 / 禁用技能

### 5. 长期记忆

`.clerkbox/memory/` 目录下按类型组织记忆条目：

| 类型 | 用途 |
| --- | --- |
| `user` | 用户偏好、背景、技术栈（跨项目） |
| `feedback` | 用户反馈与修正 |
| `project` | 项目级规则、约定、决策 |
| `reference` | 参考资料、链接、笔记 |

Agent 通过 `save_memory` 工具主动写入，通过 frontmatter 索引快速检索。

### 6. VIBE 沉浸模式

一键进入专注模式：

- 全屏背景图（默认 Pexels，可自定义网络图或本地图片）
- 液态玻璃风格消息气泡（`liquid-glass` 系列 class）
- 右上角悬浮音乐播放器（支持单曲 / 音乐文件夹）
- 左下角定制菜单（背景 / 音乐 / 文件夹）
- 配置持久化，退出后普通界面状态保持

---

## 界面预览

```
┌──────────────────────────────────────────────────────────┐
│ ◉ ◉ ◉   ClerkBox                              [─][□][✕] │  ← 自绘圆角标题栏
├──────────┬───────────────────────────────────────────────┤
│          │  模型: deepseek-chat     [VIBE]  [设置]        │
│  会话 1   ├───────────────────────────────────────────────┤
│  会话 2   │                                               │
│  会话 3   │   用户: 帮我重构这个函数                      │
│          │                                               │
│  ─────   │   助手: 我先读取文件...                        │
│  新建会话 │   [read_file] src/utils.ts                    │
│          │   [search_replace] src/utils.ts                │
│  Skills  │   已完成重构，主要改动：                       │
│  设置     │   • 拆分了职责                                │
│          │   • 添加了类型注解                             │
│          │                                               │
│          ├───────────────────────────────────────────────┤
│          │  [输入消息...]                              [↑]│
└──────────┴───────────────────────────────────────────────┘
```

---

## 下载与安装

### 方式一：直接下载安装包（推荐）

前往 [Releases](https://github.com/XMZF-Studio/ClerkBox/releases) 下载最新的 `ClerkBox-Setup-x.x.x.exe`，双击安装即可。

- 安装包大小：约 90 MB
- 支持 Windows 10 / 11 (x64)
- NSIS 安装器，可选安装路径、创建桌面快捷方式

### 方式二：便携版

下载 `ClerkBox-portable-x.x.x.zip`，解压后直接运行 `ClerkBox.exe`，无需安装。

---

## 从源码构建

### 环境要求

- **Node.js** ≥ 18（推荐 20 LTS）
- **npm** ≥ 9 或 **pnpm** ≥ 8
- **Windows 10/11**（当前仅构建 Windows 目标）

### 步骤

```bash
# 1. 克隆仓库
git clone https://github.com/XMZF-Studio/ClerkBox.git
cd ClerkBox

# 2. 安装依赖
npm install

# 3. 启动开发模式（Vite + Electron 同时启动）
npm run dev

# 4. 构建生产版本（编译 Electron + Vite 打包 + electron-builder 生成 NSIS 安装包）
npm run build
```

构建产物位于 `release/` 目录下，包含：

- `ClerkBox-Setup-x.x.x.exe` — NSIS 安装包
- `ClerkBox-x.x.x-win.zip` — 便携版
- `win-unpacked/` — 解压版目录

### npm scripts

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动开发服务器与 Electron |
| `npm run build:electron` | 仅编译 Electron 主进程 TypeScript |
| `npm run electron` | 编译并启动 Electron |
| `npm run build` | 完整生产构建（生成安装包） |
| `npm run preview` | Vite 预览构建后的前端 |

---

## 快速开始

1. **首次启动**：完成欢迎页引导，选择主题与颜色方案
2. **配置模型**：进入 **设置 → 模型**，填入你的 API Key
3. **选择工作目录**：点击侧边栏底部按钮，选择一个项目文件夹作为 Agent 的工作目录
4. **开始对话**：在输入框输入你的需求，例如：
   - "帮我重构 src/utils.ts 里的 parseDate 函数"
   - "分析这个项目的依赖结构"
   - "搜索所有 TODO 注释并列出来"
5. **派生子 Agent**：Agent 会自动判断是否需要派生子 Agent 处理复杂子任务
6. **进入 VIBE 模式**：点击标题栏 VIBE 按钮进入沉浸模式

---

## 配置

所有配置通过 **设置面板** 管理，持久化在本地。

### 模型配置

```typescript
interface ModelConfig {
  label: string         // 显示名称
  model: string         // 模型 ID
  baseUrl: string       // OpenAI 兼容端点
  apiKey: string        // 密钥（加密存储）
}
```

### 应用配置

- **主题**：`light` / `dark` / `system`
- **颜色方案**：MD3 色板预设或自定义种子色
- **VIBE 模式**：背景图、音乐源
- **工作目录**：当前会话绑定的项目目录
- **数据目录**：默认 `%APPDATA%/ClerkBox`

### 数据目录结构

```
.clerkbox/
├── memory/              # 长期记忆
│   ├── user/
│   ├── feedback/
│   ├── project/
│   └── reference/
├── skills/              # 已安装技能
│   └── <slug>/
│       └── SKILL.md
├── agents/              # 自定义 Agent
│   └── <name>.md
├── plan/                # Plan 模式产物
└── *.clerkbox-bak       # 文件修改前备份
```

---

## 工具系统

Agent 可调用以下工具完成实际任务：

### 文件操作

| 工具 | 说明 |
| --- | --- |
| `read_file` | 读取指定路径文件，返回带行号的完整文本 |
| `write_file` | 写入文件（自动备份原文件到 `.clerkbox-bak`） |
| `search_replace` | 精确字符串匹配的局部编辑（无需行号） |
| `list_dir` | 列出目录内容 |
| `search_files` | 按 glob 模式搜索文件 |
| `search_content` | 按正则搜索文件内容 |

### 网络工具

| 工具 | 说明 |
| --- | --- |
| `web_search` | 联网搜索（HTML 解析 cn.bing.com，无需 API Key） |
| `web_fetch` | 抓取网页，自动降级到隐藏 BrowserWindow 渲染 SPA |

### 系统工具

| 工具 | 说明 |
| --- | --- |
| `execute_command` | 执行 shell 命令（危险命令自动拦截） |
| `spawn_agent` | 派生子 Agent 处理子任务 |
| `save_memory` | 写入长期记忆条目 |

### 安全机制

- **危险命令拦截**：`DANGEROUS_PATTERNS` 黑名单覆盖 `rm -rf`、`format`、`fork bomb`、`Stop-Computer` 等
- **写入白名单**：Plan 模式仅允许写入 `.clerkbox/plan/` 目录
- **路径校验**：所有文件操作路径必须在当前工作目录内
- **URL scheme 校验**：`openExternal` 仅允许 `http://` / `https://`
- **沙箱模式**：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`

---

## 子 Agent

### 内置 Agent

#### 侦察兵 (`explore`)

只读侦察专家，适合大面积搜索与多文件阅读：

- 仅允许 `read_file` / `list_dir` / `search_files` / `search_content` / `web_search` / `web_fetch`
- 默认 30 轮上限
- 严禁创建、修改、删除任何文件

#### 通用助手 (`general`)

通用子任务执行者：

- 继承父 Agent 全部工具
- 默认 50 轮上限
- 独立上下文，仅返回最终总结

### 自定义 Agent

在 `.clerkbox/agents/` 目录下创建 Markdown 文件：

```markdown
---
name: translator
description: 中英互译专家
whenToUse: 需要高质量中英翻译时使用
tools: [read_file, write_file, web_search]
disallowedTools: [execute_command]
model: deepseek-chat
maxTurns: 20
color: purple
---

你是一个中英互译专家。规则：
- 保持原文语气与风格
- 技术文档优先使用行业通用术语
- 翻译完成后输出双语对照
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | Agent 类型标识符（唯一） |
| `description` | 否 | 显示名称 |
| `whenToUse` | 否 | 何时使用此 Agent |
| `tools` | 否 | 允许的工具列表，`[*]` 表示全部 |
| `disallowedTools` | 否 | 禁用的工具列表 |
| `model` | 否 | 指定模型 ID |
| `maxTurns` | 否 | 最大迭代轮数 |
| `color` | 否 | 标识颜色（blue/green/purple/...） |

---

## Skills 技能系统

### 技能格式

每个 Skill 是一个目录，包含 `SKILL.md` 文件：

```markdown
---
name: code-reviewer
description: 代码审查专家
version: 1.0.0
author: XMZF
---

你是一个资深代码审查专家。审查时请关注：
1. 安全漏洞
2. 性能问题
3. 可读性
4. 错误处理

输出格式：
- 严重程度（高/中/低）
- 问题描述
- 修复建议
```

### 安装技能

- **从技能市场安装**：侧边栏点击 "Skills" → 浏览推荐 → 一键安装
- **手动安装**：将技能目录放入 `.clerkbox/skills/<slug>/`
- **从 URL 安装**：技能市场支持输入 GitHub raw URL 拉取远程 SKILL.md

### 启用 / 禁用

每个会话开始时可选择性启用技能，激活的技能会自动注入 system prompt。

---

## 长期记忆

记忆系统让 Agent 跨会话保持对你的项目与偏好的理解。

### 记忆类型

| 类型 | 目录 | 用途 |
| --- | --- | --- |
| `user` | `.clerkbox/memory/user/` | 用户档案：偏好、背景、技术栈、常用风格 |
| `feedback` | `.clerkbox/memory/feedback/` | 用户反馈与修正记录 |
| `project` | `.clerkbox/memory/project/` | 项目级约定、架构决策、规范 |
| `reference` | `.clerkbox/memory/reference/` | 参考资料、链接、笔记 |

### 记忆文件格式

```markdown
---
name: preferred-stack
description: 用户偏好的前端技术栈
type: user
mtime: 2026-07-20
---

用户偏好：
- 框架：React 19 + TypeScript
- 状态：Zustand
- 样式：Tailwind CSS
- 构建：Vite
- 测试：Vitest
```

Agent 通过 `save_memory` 工具自动写入，会话开始时扫描 frontmatter 索引快速加载相关条目。

---

## VIBE 沉浸模式

一键切换到无干扰的专注对话环境。

### 功能

- **全屏背景**：默认 Pexels 高质量图片，支持自定义网络图或本地图片
- **液态玻璃 UI**：消息气泡、输入框、控件均采用 `liquid-glass` 毛玻璃效果
- **音乐播放器**：右上角悬浮控制器，支持单曲 / 文件夹播放，白色进度条
- **定制菜单**：左下角玻璃菜单，配置背景与音乐
- **持久化**：所有 VIBE 配置持久化，启动时自动恢复

### 进入 / 退出

- 点击标题栏 **VIBE** 按钮进入
- 点击右下角 **退出** 按钮退出
- 普通界面状态在退出后完整保留

### 默认音乐

内置默认背景音乐 `https://xmzf.space/bj.mp3`，可在定制菜单中替换。

---

## 主题与外观

ClerkBox 采用 Material Design 3 色彩引擎，支持动态主题生成。

### 三种模式

- **浅色**：明亮配色，适合白天
- **深色**：默认模式，护眼
- **跟随系统**：根据系统主题自动切换

### 颜色方案

内置 MD3 色板预设：

- Violet（默认紫色调）
- Blue / Green / Orange / Pink / Teal / Indigo
- **自定义种子色**：通过 `@material/material-color-utilities` 实时生成完整色板

### 视觉细节

- **圆角窗口**：12px 圆角，最大化时自动恢复直角
- **自绘标题栏**：无边框窗口 + 自定义窗口控制按钮
- **波浪动画**：空会话时底部显示主题色三重正弦波动画
- **液态玻璃**：VIBE 模式下统一的毛玻璃视觉语言

---

## 项目结构

```
ClerkBox/
├── electron/                    # Electron 主进程
│   ├── main.ts                  # 主进程入口（IPC、文件系统、命令执行等）
│   └── preload.ts               # 预加载脚本（contextBridge）
├── src/                         # 渲染进程（React 应用）
│   ├── components/
│   │   ├── chat/                # 聊天相关组件
│   │   │   ├── ChatPage.tsx
│   │   │   ├── ChatInput.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageItem.tsx
│   │   │   ├── SkillStore.tsx
│   │   │   ├── SubAgentCard.tsx
│   │   │   ├── SubAgentDetailPanel.tsx
│   │   │   ├── ThemeWaves.tsx
│   │   │   └── ThinkingShimmer.tsx
│   │   ├── layout/              # 布局组件（Sidebar / TitleBar / FileTree）
│   │   ├── onboarding/          # 欢迎页引导
│   │   ├── settings/            # 设置面板
│   │   ├── ui/                  # 通用 UI 组件
│   │   └── vibe/                # VIBE 模式组件
│   ├── hooks/
│   │   └── use-agent.ts         # 核心 Agent Hook（ReAct 循环、流式、工具调度）
│   ├── lib/                     # 核心库
│   │   ├── agent-registry.ts    # Agent 注册表
│   │   ├── tool-registry.ts     # 工具定义
│   │   ├── permission-engine.ts # 权限引擎（危险命令检测）
│   │   ├── theme-engine.ts      # MD3 主题引擎
│   │   ├── compact.ts           # 长上下文压缩
│   │   ├── token-estimate.ts    # Token 估算
│   │   ├── token-tracker.ts     # Token 用量追踪
│   │   ├── model-presets.ts     # 模型预设
│   │   ├── memory.ts            # 记忆系统
│   │   └── ipc-client.ts        # IPC 客户端
│   ├── stores/                  # Zustand 状态管理
│   │   ├── chat-store.ts
│   │   ├── settings-store.ts
│   │   ├── skills-store.ts
│   │   ├── agent-runs-store.ts
│   │   ├── ui-store.ts
│   │   └── vibe-store.ts
│   ├── types/                   # TypeScript 类型定义
│   ├── App.tsx                  # 应用根组件
│   ├── main.tsx                 # 渲染进程入口
│   └── index.css                # 全局样式（Tailwind）
├── build/                       # 构建资源（图标）
├── public/                      # 静态资源
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── tsconfig.electron.json
└── electron-builder 配置见 package.json
```

---

## 技术栈

### 前端

| 技术 | 版本 | 用途 |
| --- | --- | --- |
| [React](https://react.dev/) | 19 | UI 框架 |
| [TypeScript](https://www.typescriptlang.org/) | 6 | 类型系统 |
| [Vite](https://vitejs.dev/) | 5 | 构建工具 |
| [Tailwind CSS](https://tailwindcss.com/) | 3 | 原子化 CSS |
| [Zustand](https://github.com/pmndrs/zustand) | 5 | 状态管理 |
| [lucide-react](https://lucide.dev/) | 1 | 图标库 |
| [recharts](https://recharts.org/) | 3 | 图表（Token 用量等） |
| [Vercel AI SDK](https://sdk.vercel.ai/) | 6 | 流式 LLM 调用 |
| [@material/material-color-utilities](https://github.com/material-foundation/material-color-utilities) | 0.4 | MD3 色彩引擎 |
| [cheerio](https://cheerio.js.org/) | 1.2 | HTML 解析（web_search） |

### 桌面端

| 技术 | 版本 | 用途 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 42 | 跨平台桌面框架 |
| [electron-builder](https://www.electronjs.org/) | 26 | 打包工具 |

### 数据存储

- 会话历史：本地 JSON（按会话 ID 分文件）
- 应用配置：Zustand persist + localStorage
- 长期记忆：Markdown 文件 + frontmatter 索引
- 技能与 Agent：Markdown 文件

---

## 路线图

### 已完成 (v1.5.x)

- [x] ReAct 工具循环 + 流式输出
- [x] 子 Agent 编排（内置 + 自定义）
- [x] Skills 技能市场
- [x] 长期记忆系统
- [x] VIBE 沉浸模式
- [x] MD3 动态主题
- [x] 圆角窗口 + 自绘标题栏
- [x] 欢迎页引导
- [x] 长上下文自动压缩（compact）
- [x] Token 用量追踪
- [x] 危险命令拦截
- [x] 文件修改自动备份

### 计划中 (v1.6+)

- [ ] 会话分支（fork）：从某条消息分叉新会话
- [ ] 消息编辑重发
- [ ] 多模型并行对比
- [ ] 工具调用回放（保存为可复用工作流）
- [ ] 子 Agent 工作流可视化编排
- [ ] 流式断点续传
- [ ] 会话导出（Markdown / JSON / PDF）
- [ ] 跨会话全文搜索（SQLite FTS5）
- [ ] Prompt 模板与变量系统
- [ ] 子 Agent 并行执行
- [ ] Skills 评分与评论
- [ ] Skills 本地签名校验
- [ ] 命令面板（Ctrl+K）
- [ ] 多窗口多会话
- [ ] Token 用量仪表盘
- [ ] 国际化（i18n）
- [ ] macOS / Linux 支持

---

## 贡献

欢迎提交 Issue 与 Pull Request。

### 开发流程

1. Fork 仓库
2. 创建特性分支：`git checkout -b feature/amazing-feature`
3. 提交更改：`git commit -m 'feat: add amazing feature'`
4. 推送分支：`git push origin feature/amazing-feature`
5. 提交 Pull Request

### 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

- `feat:` 新功能
- `fix:` Bug 修复
- `refactor:` 重构
- `perf:` 性能优化
- `docs:` 文档
- `chore:` 杂项

### 代码风格

- TypeScript 严格模式
- React 函数组件 + Hooks
- Tailwind CSS 原子化样式
- 优先 `React.memo` + `useMemo` 优化流式渲染性能
- 主进程 IPC handler 入口必须校验路径合法性

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

```
MIT License

Copyright (c) 2026 XMZF Studio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 致谢

- [Electron](https://www.electronjs.org/) — 跨平台桌面应用框架
- [React](https://react.dev/) — UI 库
- [Vercel AI SDK](https://sdk.vercel.ai/) — 统一的 LLM 调用层
- [Material Design 3](https://m3.material.io/) — 设计系统
- [Tailwind CSS](https://tailwindcss.com/) — 样式工具
- 所有模型供应商：DeepSeek、OpenAI、Anthropic、阿里通义、智谱 AI
- 所有开源贡献者与社区反馈者

---

<div align="center">

**[报告 Bug](https://github.com/XMZF-Studio/ClerkBox/issues)** · **[功能建议](https://github.com/XMZF-Studio/ClerkBox/issues)** · **[Pull Request](https://github.com/XMZF-Studio/ClerkBox/pulls)**

Made with care by **XMZF Studio** · Released under the MIT License

</div>
