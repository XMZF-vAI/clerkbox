# ClerkBox 项目架构深度研究报告

> 仓库路径：`d:\ClerkBox - 副本`；当前版本：v1.6.0。本报告基于源码静态阅读，未做任何修改。

## 1. 项目整体架构

**顶层目录**：
- `electron/`：仅 `main.ts`（~1500 行）+ `preload.ts`，无 services 子目录
- `src/`：React 渲染层，含 `App.tsx`、`main.tsx`、`index.css` + 9 个子目录
- `build/`、`public/`：图标资源
- `release/`：electron-builder 输出（含 NSIS 安装包与 win-unpacked）
- 配置文件：`vite.config.ts`、`tsconfig.json`、`tailwind.config.ts`、`postcss.config.js`、`tsconfig.electron.json`、`tsconfig.node.json`

**package.json**（v1.6.0）：
- 依赖：`react 19.2.7`、`zustand 5.0.14`、`@material/material-color-utilities 0.4`（MD3 HCT 配色）、`cheerio 1.2`（Bing 搜索 HTML 解析）、`lucide-react 1.17`、`recharts 3.8`、`sql.js 1.14`（**声明但实际未用，DB 走 JSON 文件**）、`ai 6.0.195`（Vercel AI SDK，**声明但 use-agent.ts 用原生 fetch**）、`tailwind-merge`、`tailwindcss-animate`
- devDeps：`electron 42.3.2`、`electron-builder 26.8.1`、`vite 5.4.21`、`typescript 6.0.3`、`tailwindcss 3.4.17`、`concurrently`、`cross-env`、`wait-on`
- scripts：`dev`（vite + electron 并发）、`build:electron`（tsc + 写 dist-electron/package.json）、`build`（build:electron + vite build + electron-builder --win）
- **electron-builder 配置直接内嵌 package.json**（无独立 electron-builder.yml）：appId `com.xmzf.clerkbox`，NSIS target，`publish: null`（**未启用自动更新**，尽管有 `electronUpdaterCompatibility` 字段）

**vite.config.ts**：端口 5175，alias `@` → `src`、`@electron` → `electron`，base `./`，host `0.0.0.0`

**tsconfig.json**：target ES2022，strict，bundler moduleResolution，paths `@/*` + `@electron/*`

**tailwind.config.ts**：`darkMode: 'class'`，MD3 颜色 token（`md.primary/surface/...`）通过 CSS 变量 + `<alpha-value>` 支持，dark 主题镜像 token，自定义 `md3-xs/sm/md/lg/xl` 圆角，`fade-in/slide-up/pulse-soft` 动画，`tailwindcss-animate` 插件

## 2. Electron 主进程（`electron/main.ts`）

**窗口**：frameless + transparent + `backgroundColor: '#00000000'`，1200×800，`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`。监听 maximize/unmaximize 向渲染层同步状态（用于切换圆角）。**无托盘、无 updater.ts**。

**IPC 模块**：
- **文件系统**：`selectFolder/selectImageFile/selectAudioFile/selectMusicFolder/selectSkillFile`、`readFile/writeFile/listDir/fileExists`（含 `assertSafePath` 路径遍历防护 + 10MB 大小限制）
- **Shell**：`executeCommand`、`executeCommandWithShell`（cmd/powershell），主进程侧 `checkDangerousCommand` 拒绝 `-enc`、`Invoke-Expression`、`iex`、管道执行解释器、fork bomb、shutdown 等
- **Web**：`webSearch`（Bing HTML + cheerio 解析）、`webFetch`（HTTP fetch + 隐藏 BrowserWindow 渲染 SPA + SPA 预渲染数据提取，scheme 白名单只允许 http/https）
- **Memory**：`scanMemory/readMemoryIndex/writeMemoryFile/updateMemoryIndex/searchMemoryFiles`，序列化写入队列 `enqueueMemWrite`
- **DB**：**JSON 文件** `userData/clerkbox-db.json` + `enqueueDbWrite` 串行化，UPSERT 语义
- **Skills**：`initClerkbox/writeSkillMd/removeSkillDir`（`assertSafeSlug` + path.relative 二次校验）、`skillsSearch`（SkillHub API `skillhub.proclaw.cc`）、`fetchSkillMd`（多 CDN 源：jsDelivr + raw.githubusercontent + GitHub API Contents，并行 + 8s 超时）、`parseSkillFile`（.skill 直读 / .zip 用 PowerShell Expand-Archive 解压后递归查找 SKILL.md）
- **Skill 文件解析**：YAML frontmatter（name/description/icon/category）+ 回退到第一级 Markdown 标题
- **全局异常兜底**：`uncaughtException`/`unhandledRejection` + `dialog.showErrorBox`，Windows `setAppUserModelId` 让任务栏识别应用身份

**preload.ts**：`contextBridge.exposeInMainWorld('clerkbox', {...})` 暴露完整 ClerkBoxAPI 接口，同步 IPC 取 `platform/homeDir`（sandbox 下 preload 无法 require os）

## 3. 渲染层（`src/`）

**`main.tsx`**：`StrictMode` + `createRoot`，仅引入 `index.css`

**`App.tsx`**：
- `ThemeProvider`：监听 zustand persist 水合，按 `theme` (light/dark/system) 切 `.dark` class，调 `applyColorScheme(resolveSeed(...))` 写 CSS 变量，跟随系统主题变化
- 三种渲染分支：未完成 onboarding → `OnboardingFlow`；VIBE 模式 → `VibeBackground + VibeMusicPlayer + ChatPage(vibe) + VibeControls`；正常模式 → `Sidebar + TitleBar + (ChatPage | SkillStore) + SettingsPage`
- 圆角窗口：`rounded-xl [transform:translateZ(0)]`，最大化时取消圆角与边框

**`index.css`**：
- MD3 CSS 变量（light/dark 两套：primary/secondary/tertiary/surface×6/onSurface/outline/error/success/warning/info）
- `.markdown-body` 系列样式（标题/列表/引用/表格/code-block/inline-code）
- `.markdown-body.md-vibe` 覆盖（VIBE 下用半透明深色块）
- `@keyframes shimmer` + `.thinking-shimmer`（思考流光效果）
- **liquid-glass 四件套**：`.liquid-glass`（blur 40px + saturate 180%）、`.liquid-glass-strong`、`.liquid-glass-subtle`、`.liquid-glass-btn`（hover/active 状态）
- 透明 body + 全屏取消圆角 + 自定义滚动条

## 4. 状态管理（zustand 5，无 Redux/Context）

**stores/**：
- `chat-store.ts`：sessions/activeSessionId/streamingSessionId/sessionStatus（working/error/confirm-danger），`loadFromDb`/`createSession`/`addMessage`/`updateMessage`/`compactSession`（清空再重写策略），自动清理空"新会话"，title 从首条 user 消息截取
- `settings-store.ts`（persist `clerkbox-settings`）：apiKey/baseUrl/model/temperature/maxTokens/theme/colorScheme/customSeedColor/permissionMode/enableThinking/thinkingBudget/customModels/activeCustomModelId/hasCompletedOnboarding；`upsertCustomModel/removeCustomModel/activateCustomModel`；`seedCustomModelsIfEmpty` 老用户迁移
- `skills-store.ts`（persist v2 `clerkbox-skills`，migrate 清除 preset）：`toggleSessionSkill`（同步写盘 + 失败回滚）、`installOnlineSkill`/`uninstallOnlineSkill`/`installCustomSkill`、`loadRecommended`
- `vibe-store.ts`（persist `clerkbox-vibe`）：isVibeMode/background/music/musicFolder
- `ui-store.ts`：showTaskPanel/showSkillStore
- `agent-runs-store.ts`（**不 persist**，注释说明流式期间 ~20fps set 会导致 localStorage 阻塞）：sessionId → SubAgentRun[] + selectedRunId

**lib/**：
- `compact.ts`：`EFFECTIVE_CONTEXT_WINDOW=120K`、`AUTO_COMPACT_THRESHOLD=100K`、`KEEP_RECENT_COUNT=6`，`compactConversation` 调 LLM 生成摘要（PTL 重试截断 20% groups），`createPostCompactFileAttachments` 恢复最近 5 个文件（每文件 5K token 上限、总 50K 预算），`findKeepBoundaryIndex` 保证 tool_calls ↔ tool 配对完整
- `memory.ts`：`buildMemoryPrompt` 双层（全局 ~/.clerkbox/memory 全量注入 ≤8K 字符 + 项目级 MEMORY.md 索引注入），4 类记忆类型规范
- `notify.ts`：`notifyIfNotViewing`（done/error/confirm-danger），仅当 `document.hidden` 或非当前会话时发桌面通知，点击切换会话 + 窗口聚焦
- `ipc-client.ts`：typed 包装 `window.clerkbox`
- `agent-registry.ts`：`BUILTIN_AGENTS`（explore 只读侦察 / general 通用）+ `loadCustomAgents`（从 `.clerkbox/agents/*.md` 解析 frontmatter）+ `getAllAgents`（自定义覆盖同名内置）
- `tool-registry.ts`：singleton `ToolRegistry`，10 个内置工具
- `permission-engine.ts`：`isDangerousCommand` 25+ 正则
- `theme-engine.ts`：7 个马卡龙预设（classic/sakura/mint/lavender/sky/peach/cream）+ custom seed，`applyColorScheme` 用 `SchemeTonalSpot` 生成 MD3 配色写 CSS 变量
- `token-estimate.ts` / `token-tracker.ts`：CJK 字符 /1.5 + 其他字符 /4 启发式，TokenTracker 优先用 API usage
- `model-presets.ts`：DeepSeek/GPT-4o/Claude 3.5/Qwen/GLM-4 预设

## 5. 类型系统（`src/types/`）

**`agent.ts`**：
- `Message`：含 `thinkingContent`、`toolCalls`、`toolResults`、`streamingToolCalls`（瞬态）、`collapsed`、`isCompactSummary`、`compactMetadata`、`_isStreaming`、`subAgentId`、`isSubAgentCard`
- `ToolCall/ToolResult/StreamingToolCall/CompactMetadata/ToolDefinition/CompactionResult`
- `Session`、`CustomModel`、`AppSettings`（含 permissionMode: 'craft'|'ask'|'plan'）
- `StreamDelta/StreamChunk/TokenUsage`（OpenAI 兼容）
- `MemoryEntry/MemoryType`（user/feedback/project/reference）
- `AgentDefinition`（agentType/name/whenToUse/description/tools/disallowedTools/systemPrompt/model/maxTurns/source/color）
- `SubAgentRun`（status: running/completed/failed/aborted）

**`ipc.ts`**：`FileEntry/SessionRow/MessageRow/WebSearchResult`、完整 `ClerkBoxAPI` 接口、`ParseSkillFileResult`，`declare global { Window.clerkbox }`

**`skills.ts`**：`SkillDefinition`（source: preset/online/custom，category: document/automation/development/online/custom）、`SkillsMPSkill/SkillsMPSearchResult`

## 6. UI/UX 设计

- **无 shadcn/ui、Radix、Headless UI**，全部自研 + Tailwind + lucide-react
- **VIBE 模式**：4 个 liquid-glass class 实现 Apple Liquid Glass 规范（backdrop blur + saturate + 顶部高光描边 + 柔和投影）；VibeBackground 支持本地/URL 图片，加载失败回退默认；VibeMusicPlayer/VibeControls/VibeCustomizeMenu
- **主题系统**：light/dark/system + 7 马卡龙预设 + custom seed，MD3 HCT 算法动态生成配色，所有 token 通过 CSS 变量切换
- **欢迎页**（OnboardingFlow）：3 步（欢迎 → 主题选择 → 启程），MD3 filled 按钮，自带窗口控制（无 TitleBar）
- **空状态波浪**（ThemeWaves）：Canvas 三层波浪，运行时读取 `--md-primary/tertiary/secondary-rgb` CSS 变量，MutationObserver 监听色系切换，支持 prefers-reduced-motion
- **Session 侧边栏状态指示器**：sessionStatus (working/error/confirm-danger) 驱动 loading 圈与图标
- **Markdown 渲染**：自研（`renderMarkdown`），支持代码块/标题/列表/表格/引用/链接，链接 sanitize 防 XSS

## 7. Agent / LLM 调用（`src/hooks/use-agent.ts`，~1400 行）

- **LLM Provider**：仅 OpenAI-compatible（`POST {baseUrl}/chat/completions` + `Bearer` token），原生 `fetch`，未用 Vercel AI SDK
- **流式响应**：手动 SSE 解析（`data: ` 前缀 + `[DONE]` 终止符），按 `tool_calls.index` 累积，支持 `reasoning_content`（DeepSeek/GLM）与 `thinking_content`，120s 独立 timeout AbortController
- **ReAct 循环**：`MAX_REACT_ITERATIONS=100`，每轮检查 auto-compact（>100K tokens），`buildAPIMessages` 后处理确保 tool_calls ↔ tool 配对完整（孤立 tool 消息丢弃、未响应 tool_call 补占位），`truncateMessages` 120K 输入预算
- **Thinking 模式**：按模型名分支（reasoner/r1 不加参数、glm 用 `thinking: {type:'enabled', clear_thinking:false}`、其他用 `enable_thinking + thinking_budget`）
- **Plan 模式**：检测 `[PLAN_COMPLETE]` 标记自动切 craft 模式，注入 plan.md 作为 system 消息
- **子 agent**（`runSubAgent`）：独立 controller（父 abort 联动）、独立 tokenTracker、独立 readFileState、独立 systemPrompt 覆盖、独立 maxTurns，支持 auto-compact
- **节流**：流式 UI 更新 50ms 节流，`onFinish` 强制 flush
- **abort 安全**：B3/B4/B5/B6 修复后（CODE_REVIEW.md 记录），abortRef.current 身份比对清理，abort 后跳过工具执行，子 agent abort 标 aborted 而非 completed，spawn_agent 先 findAgent 验证再插卡片

## 8. 工具系统（`src/lib/tool-registry.ts`）

10 个内置工具：
- **文件**：`read_file`（带行号格式化 + 100K 字符截断 + readFileState 跟踪）、`write_file`（自动 `.clerkbox-bak` 备份）、`search_replace`（行尾符归一化匹配 + 多匹配报错列位置 + replace_all）、`list_dir`、`search_files`（PowerShell `Get-ChildItem -Recurse`）、`search_content`（PowerShell `Select-String -Recurse`）
- **Shell**：`execute_command`（cmd/powershell，输出 50K 截断）
- **Web**：`web_search`（Bing，最多 10 条）、`web_fetch`（HTTP + SPA BrowserWindow 兜底）
- **Memory**：`save_memory`（scope: user/project）、`search_memory`（双 scope 检索）
- **Agent**：`spawn_agent`（并行派生）

**工具调用 UI**（`MessageItem.tsx`）：
- `ToolCallBar`：紧凑横条，可展开参数+结果，按工具类型选图标，失败/完成状态徽章
- `WriteFilePreviewCard`：流式 write_file 预览，自动滚到底，行数显示
- `SearchReplacePreviewCard`：流式 diff 预览（- 旧/+ 新）
- `EditFilePreviewCard`：**dead code**，edit_file 工具未注册（仅 UI 残留）
- `spawn_agent` 工具不显示原始 ToolCallBar，由 `SubAgentCard` 单独渲染

## 9. Skill 系统

- `SkillDefinition`：source 三类（preset/online/custom），preset 已在 v2 migrate 中清除
- `skills-store`：persist installed skills + sessionSkillIds，`toggleSessionSkill` 同步 `.clerkbox/skills/<slug>/SKILL.md` 写盘
- **Skills 是 prompt-only**：不动态注册工具，AI 通过 `read_file` 读 SKILL.md 后遵循其指令
- **Marketplace**：SkillHub API 搜索 + GitHub 多 CDN 源下载 SKILL.md（jsDelivr + raw.github + GitHub API Contents 并行）
- **自定义 skill**：支持 `.skill`（直读）和 `.zip`（PowerShell Expand-Archive 解压后递归找 SKILL.md）
- **`skills-registry.ts` 在 `d:/cb` 中存在但在副本中已被移除**（改用纯在线 marketplace）

## 10. 权限系统

- **3 模式**：craft（全权，危险命令需 confirm）/ ask（只读+web+memory）/ plan（只读 + 仅写 `.clerkbox/plan/`）
- **Plan 模式路径白名单**：S5 修复后用 `path.resolve` + `path.relative` 严格判断落在 `<workingDir>/.clerkbox/plan/` 之下，防 `..` 绕过
- **危险命令确认**：`isDangerousCommand` 25+ 正则（rm -rf、mkfs、dd、fork bomb、curl|bash、Stop-Computer、Invoke-Expression、powershell -enc、vssadmin delete shadows 等），主进程二次校验
- **系统目录写入确认**：`/etc/`、`C:\Windows\`、`C:\Program Files` 写入弹 confirm
- **子 agent 权限**：allowedTools/disallowedTools 白/黑名单，不弹 confirm 但仍检危险命令与系统目录
- **系统通知**：`notifyIfNotViewing` 三类（done/error/confirm-danger），仅当 `document.hidden` 或非当前会话时触发，Notification.permission 自动请求

## 11. 项目现状评估

**已实现**：完整 ReAct 流式 agent、多会话 JSON-DB、auto-compact + 文件恢复、子 agent 派生（内置 2 + 自定义）、10 工具并行执行、3 权限模式 + plan 自动切换、双层结构化记忆、skill marketplace（在线 + 自定义）、VIBE 液态玻璃模式、MD3 动态主题、欢迎引导、桌面通知、路径遍历/危险命令/scheme 安防。CODE_REVIEW.md 记录的 B1-B6、S1-S9、U1-U3 大多已在副本代码中修复（见内联注释 S2/S3/S4/S5/S6/S7/S8、B2/B3/B4/B5/B6、U1/U2）。

**未实现/不完善**：
- **无自动更新**（`publish: null`，无 updater.ts）
- **sql.js 声明但未用**，DB 是单 JSON 文件，并发与规模受限
- **无托盘**（用户描述有但代码无）
- **`skills-registry.ts` 预设目录已移除**，完全依赖在线 marketplace
- **`ErrorBoundary`、`SkillLoader` 在 d:/ClerkBox 或 d:/cb 存在但副本缺失**
- **`edit_file` UI 残留但工具未注册**（dead code）
- **`ai` (Vercel AI SDK) 声明但未用**
- **无测试文件**
- **无 macOS/Linux 打包**（仅 NSIS win）

## 12. 与 Claude Code / OpenCode 对比的劣势

**缺失关键模块**：
- **无 git 工具**（git_diff/commit/status/log），必须走 execute_command
- **无语义代码搜索**（无 embedding 索引，仅 PowerShell regex）
- **无 AST 感知编辑**（search_replace 是纯字符串匹配）
- **无 MCP（Model Context Protocol）支持**
- **无多文件 diff 预览/撤销**
- **无图片/语音输入**（ChatInput 仅文本）
- **无命令面板/快捷键系统**
- **无工作区/项目概念**（仅 workingDir）
- **无代码库索引**
- **无多窗口**
- **子 agent 状态不持久化**（agent-runs-store 纯内存，重启丢失）

**架构不足**：
- 单一 OpenAI-compatible provider（无原生 Anthropic/Google API）
- DB 走 JSON 文件（sql.js 闲置），会话多了启动慢
- `electron/main.ts` 1500 行单体，无 services 分层（d:/ClerkBox 有 `electron/services/db.ts` 但副本没有）
- 工具系统无动态注册（skills 是 prompt-only，不能像 MCP 那样扩展工具）
- 主进程无工作目录沙箱（readFile/writeFile 仅防 `..` 跳层，未限制到 workingDir）
- 仅 Windows 打包

**可改进方向**：引入 MCP、加 git 工具集、改用 sqlite（sql.js 已在依赖中）、AST 编辑工具、代码库索引、子 agent 持久化、主进程 services 分层、跨平台打包、命令面板、多模态输入。

---

**关键文件路径索引**：
- 主进程：`d:\ClerkBox - 副本\electron\main.ts`、`electron\preload.ts`
- 入口：`src\main.tsx`、`src\App.tsx`、`src\index.css`
- Agent 核心：`src\hooks\use-agent.ts`、`src\lib\tool-registry.ts`、`src\lib\compact.ts`、`src\lib\agent-registry.ts`、`src\lib\permission-engine.ts`
- 状态：`src\stores\*.ts`（6 个）
- 类型：`src\types\agent.ts|ipc.ts|skills.ts`
- UI：`src\components\chat\*.tsx`、`src\components\vibe\*.tsx`、`src\components\layout\*.tsx`
- 配置：`package.json`、`vite.config.ts`、`tsconfig.json`、`tailwind.config.ts`
- 审查记录：`CODE_REVIEW.md`、`.workbuddy\memory\2026-06-12.md`
