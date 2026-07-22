# ClerkBox 改进建议报告

> 生成时间：2026-07-21
> 基于 OpenCode、Claude Code、ClerkBox 三项目深度研究（见 01/02/03 号报告）
> 本报告仅为建议，未修改任何源码

## 改进总原则

ClerkBox 当前是一个"能用"的桌面 AI 助手，但与 OpenCode/Claude Code 相比，在**架构解耦、生态开放、可扩展性、可观察性**四个维度差距巨大。改进应遵循以下原则：

1. **不破坏现有体验**：VIBE/MD3/Skill Marketplace 等已实现特色应保留
2. **渐进式重构**：优先引入低侵入的高价值模块（MCP、git 工具），再考虑大改（CQRS、Effect）
3. **借鉴而非照搬**：OpenCode 的 Effect 体系学习曲线高，不建议直接迁移；Claude Code 的 monolithic harness 也不适合 Electron 项目。应借鉴**思想**而非**实现**
4. **优先补齐"生态接口"**：MCP > Plugin > 多 Provider > git 工具 > LSP > 多模态

---

## 一、短期改进（1-2 周，低风险高收益）

### 1.1 主进程 services 分层（重构 main.ts）

**问题**：`electron/main.ts` 1500 行单体，IPC handler、业务逻辑、安全校验全混在一起。`d:\ClerkBox\electron\services\db.ts` 已有分层雏形但副本缺失。

**建议**：拆分为 `electron/services/` 目录：
```
electron/
├── main.ts              # 仅窗口创建 + IPC 注册
├── preload.ts
└── services/
    ├── db.ts            # JSON-DB 操作（enqueueDbWrite）
    ├── file.ts          # 文件系统 IPC（readFile/writeFile/listDir...）
    ├── shell.ts         # executeCommand + checkDangerousCommand
    ├── web.ts           # webSearch + webFetch
    ├── memory.ts        # scanMemory/writeMemoryFile...
    ├── skills.ts        # skillsSearch/fetchSkillMd/parseSkillFile
    ├── safety.ts        # assertSafePath + assertSafeSlug + 危险命令规则
    └── updater.ts       # 自动更新（新增）
```

**收益**：可维护性大幅提升，每个 service 可独立测试，新增功能不再挤压 main.ts。

**参考**：Claude Code 的 `services/` 目录（api/oauth/lsp/mcp/voice/vcr）就是这种分层。

### 1.2 启用 sql.js 替换 JSON-DB

**问题**：`sql.js 1.14` 已在 package.json 但未用，DB 走单 JSON 文件，会话多了启动慢、并发受限。

**建议**：用 sql.js 把 `clerkbox-db.json` 改为 `clerkbox.db`（SQLite），表结构：
- `sessions(id, title, created_at, updated_at, working_dir, status)`
- `messages(id, session_id, role, content_json, created_at)`
- `memory_files(path, scope, type, mtime)`（索引）
- `permission_saved(action, resource, effect)`（为 1.3 准备）

**收益**：启动不再读全量 JSON，按 session_id 查询走索引，支持并发写入（WAL 模式）。

**参考**：OpenCode 用 `@effect/sql-sqlite-bun` + Drizzle + WAL；ClerkBox 可直接用 sql.js 简化版。

### 1.3 危险命令"always allow"持久化

**问题**：当前每次危险命令都弹 confirm，用户重复操作体验差。

**建议**：参考 OpenCode 的 `PermissionSaved` 表 + Claude Code 的 `alwaysAllowRules`：
- 用户选"始终允许"时写 `permission_saved` 表
- `checkDangerousCommand` 先查表，命中则跳过 confirm
- Settings 页加"权限规则"管理界面（查看/删除已保存规则）

**收益**：用户体验大幅提升，与 Claude Code 的"4 级权限 + 持久化 grant"对齐。

### 1.4 移除 dead code + 依赖清理

**问题**：
- `EditFilePreviewCard` UI 残留但 `edit_file` 工具未注册
- `ai` (Vercel AI SDK) 声明但未用
- `skills-registry.ts` 已移除但相关 import 残留可能存在

**建议**：清理 `EditFilePreviewCard`（或补齐 `edit_file` 工具注册），从 package.json 移除 `ai` 依赖或正式启用。

### 1.5 补齐 ErrorBoundary

**问题**：`d:\ClerkBox` 有 `ErrorBoundary` 但副本缺失，渲染层错误会白屏。

**建议**：从 `d:\ClerkBox` 移植 `ErrorBoundary` 组件，包裹 `App.tsx` 的三个渲染分支。

---

## 二、中期改进（1-2 月，中等风险高价值）

### 2.1 引入 MCP（Model Context Protocol）支持 ★★★★★

**这是最重要的改进**。MCP 是 AI 工具生态的事实标准（Claude Desktop、Cursor、Cline 都支持），不支持 MCP 等于生态封闭。

**建议架构**：
```
electron/services/mcp.ts           # 主进程 MCP 客户端管理
src/lib/mcp-registry.ts            # 渲染层 MCP 工具注册
src/types/mcp.ts                   # MCP 类型定义
```

**实现要点**（参考 Claude Code `services/mcp/`）：
- 用 `@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport` / `StreamableHTTPClientTransport`
- 配置文件：`.clerkbox/mcp.json`（或扩展 settings-store）
- MCP server 的工具自动转换为 ClerkBox 工具（动态注册到 `tool-registry`）
- 工具名加前缀 `mcp__<server>__<tool>` 防冲突
- OAuth 2.0 + PKCE 支持远程 MCP server（参考 Claude Code `auth.ts`）
- Settings 页加 "MCP Servers" 管理（添加/删除/查看状态）

**收益**：瞬间接入整个 MCP 生态（文件系统、GitHub、Slack、数据库、浏览器...），用户可无限扩展能力。

### 2.2 工具系统重构：支持动态注册

**问题**：当前 `tool-registry.ts` 是 singleton + 静态注册，MCP 工具无法注入。

**建议**（参考 OpenCode `tool/registry.ts` + Claude Code `Tool` 接口）：
```ts
interface Tool {
  name: string
  description: string
  inputSchema: JSONSchema
  isReadOnly?: boolean
  isDestructive?: boolean
  isConcurrencySafe?: boolean
  maxResultSizeChars?: number
  execute: (input, context) => Promise<ToolResult>
  renderToolUse?: (input) => ReactNode   // 自定义 UI
  renderToolResult?: (output) => ReactNode
}

class ToolRegistry {
  register(tool: Tool): () => void  // 返回注销函数
  unregister(name: string): void
  materialize(permissions): ToolDefinition[]
  settle(call, context): Promise<Settlement>
}
```

**关键设计**：
- 工具注册返回注销函数（参考 React useEffect 模式）
- 工具元数据扩展（isReadOnly/isDestructive/isConcurrencySafe/maxResultSizeChars）
- `materialize` 按 permissions 过滤工具
- 工具可带自定义 React 渲染器

**收益**：为 MCP、Plugin、LSP 工具动态注册打基础；UI 可根据元数据决定渲染样式（只读工具不弹 confirm）。

### 2.3 多 Provider 支持

**问题**：仅 OpenAI-compatible，无法用 Anthropic 原生 API（cache、thinking、files API）、Google、Bedrock。

**建议**（参考 OpenCode `plugin/provider/*.ts` + Claude Code `services/api/client.ts`）：
```
src/lib/providers/
├── openai-compatible.ts   # 现有逻辑
├── anthropic.ts           # 新增：Anthropic Messages API
├── google.ts              # 新增：Gemini API
├── bedrock.ts             # 新增：AWS Bedrock
└── index.ts               # Provider 注册中心
```

**实现要点**：
- 每个 provider 实现 `stream(request): AsyncGenerator<StreamChunk>` 接口
- Anthropic provider 支持 `cache_control`（prompt cache）、`thinking`（extended thinking）、`files API`
- 配置：settings-store 加 `provider: 'openai-compatible' | 'anthropic' | 'google' | 'bedrock'`
- 模型选择 UI 按 provider 动态加载

**收益**：用户可用 Claude 原生 API 的 cache（降本 90%）+ thinking（更强推理）。

### 2.4 git 工具集

**问题**：无 git 原语，必须走 execute_command，无 diff 预览/撤销。

**建议**：新增 4 个内置工具（参考 Claude Code `tools/` + OpenCode `tool/builtins.ts`）：
- `git_diff`：显示工作区/staged diff，返回 unified diff 文本
- `git_commit`：提交（message 参数），自动检测未 staged 文件
- `git_status`：返回 modified/staged/untracked 文件列表
- `git_log`：返回最近 N 条 log

**UI**：
- `GitDiffPreviewCard`：diff 高亮预览（+ 绿 / - 红）
- `GitStatusCard`：文件状态列表

**实现**：主进程 `electron/services/git.ts` 用 `simple-git` 或直接调 `git` CLI。

### 2.5 命令面板 + 快捷键系统

**问题**：无命令面板，UX 远不如 Claude Code 的 slash + Vim。

**建议**（参考 Claude Code `commands/` + OpenCode `command/`）：
- `Ctrl+P` / `Cmd+P` 打开命令面板
- 内置命令：`/clear`、`/compact`、`/export`、`/theme`、`/model`、`/agent`、`/skill`、`/settings`
- 用户自定义命令：`.clerkbox/commands/*.md`（frontmatter + prompt）
- 命令可触发：JSX 渲染 / prompt 注入 / 本地函数

**快捷键**：
- `Ctrl+K`：清空当前会话
- `Ctrl+Shift+P`：命令面板
- `Ctrl+,`：设置
- `Escape`：停止生成

**收益**：UX 对齐 Claude Code，高级用户效率提升。

### 2.6 子 Agent 状态持久化

**问题**：`agent-runs-store` 纯内存，重启丢失。

**建议**：用 1.2 的 SQLite 表存储：
- `sub_agent_runs(id, session_id, parent_message_id, agent_name, status, started_at, completed_at, result_summary)`
- 启动时从 DB 加载，恢复 UI 展示
- 流式更新时 throttled 写 DB（参考 OpenCode `EventV2.publish`）

### 2.7 自动更新

**问题**：`publish: null`，无自动更新，用户需手动重装。

**建议**（参考 OpenCode `packages/desktop`）：
- `electron-updater` + GitHub Releases
- `electron/services/updater.ts`：检查更新、下载、安装
- Settings → About 加"检查更新"按钮
- 启动时后台检查，有更新时通知栏提示

---

## 三、长期改进（3-6 月，战略级）

### 3.1 事件系统 + CQRS（可选，高投入）

**问题**：无事件系统，流式中断后无法恢复，多窗口/多端不可能。

**建议**（参考 OpenCode `event.ts` + `SessionProjector`）：
- 引入 `EventLog`（SQLite 表）：所有 mutation 写事件
- `SessionProjector`：事件 → 读模型表
- 流式响应可中断恢复（读 event log 重建状态）
- 多窗口订阅同一 session（SSE / IPC 广播）

**风险**：重构量大，建议在 2.1-2.7 稳定后再考虑。

**收益**：支持多窗口、中断恢复、会话 share、多端同步。

### 3.2 Plugin 系统

**问题**：无插件系统，所有功能必须改主代码。

**建议**（参考 OpenCode `plugin/` + Claude Code 三层模型）：
- `.clerkbox/plugins/<name>/`：插件目录
- `plugin.json`：插件元数据（name/version/permissions）
- `index.ts`：插件入口，导出 `hooks`
- Hooks：`tool.register` / `command.register` / `agent.transform` / `provider.create` / `mcp.server`
- 插件市场：扩展 SkillHub 为 "ClerkBox Hub"（skills + plugins）

**收益**：第三方可扩展，生态繁荣。

### 3.3 LSP 集成

**问题**：无 LSP，编辑无类型感知，无 diagnostics 反馈。

**建议**（参考 Claude Code `services/lsp/`）：
- `electron/services/lsp.ts`：LSP 客户端管理
- 支持 TypeScript / Python / Rust / Go 等 LSP server
- `lsp_diagnostics` 工具：返回当前文件的 diagnostics
- 编辑后自动查 diagnostics，反馈给 LLM

### 3.4 代码库索引 + 语义搜索

**问题**：仅 PowerShell regex 搜索，无语义搜索。

**建议**（参考 Cursor embeddings + OpenCode `ripgrep.ts`）：
- 可选启用：项目级 embedding 索引（用本地 embedding 模型或 API）
- `semantic_search` 工具：返回相关代码片段
- 索引存储：SQLite 向量扩展或单独的 `.clerkbox/index.db`

### 3.5 多模态输入

**问题**：仅文本输入。

**建议**：
- ChatInput 支持图片粘贴/拖拽
- 图片转 base64 发送给支持 vision 的模型
- 语音输入：Web Speech API 或 Whisper API

### 3.6 跨平台打包

**问题**：仅 Windows NSIS。

**建议**：
- macOS：dmg + 签名（参考 OpenCode `packages/desktop`）
- Linux：AppImage / deb
- electron-builder 配置多 target

### 3.7 可观察性 + 遥测

**问题**：无遥测，线上问题难诊断。

**建议**（参考 OpenCode `observability/otlp.ts` + Claude Code 双通道）：
- 本地遥测：写 `~/.clerkbox/logs/`（按日期轮转）
- 可选远程遥测（用户同意）：Sentry / 自建
- Token usage 统计面板（已有 token-tracker，扩展为持久化）
- 错误上报：主进程 `uncaughtException` + 渲染层 ErrorBoundary

### 3.8 远程控制（可选，差异化）

**问题**：无远程控制。

**建议**（参考 Claude Code `bridge/`）：
- 可选启用：手机/网页远程驱动桌面 ClerkBox
- WebSocket 长连接 + JWT 认证
- 二维码扫码配对
- 这是 ClerkBox 相对 Claude Code 的差异化机会（Claude Code 的 Bridge 仅限 claude.ai）

---

## 四、优先级矩阵

| 改进项 | 价值 | 难度 | 优先级 | 建议时间 |
|---|---|---|---|---|
| 1.1 main.ts 分层 | 中 | 低 | ★★★★ | 第 1 周 |
| 1.2 sql.js 替换 JSON | 中 | 低 | ★★★★ | 第 1-2 周 |
| 1.3 always allow 持久化 | 高 | 低 | ★★★★★ | 第 1 周 |
| 1.4 dead code 清理 | 低 | 低 | ★★★ | 第 1 周 |
| 1.5 ErrorBoundary | 中 | 低 | ★★★★ | 第 1 周 |
| 2.1 MCP 支持 | 极高 | 中 | ★★★★★ | 第 2-4 周 |
| 2.2 工具系统重构 | 高 | 中 | ★★★★★ | 第 2-3 周（与 2.1 同步） |
| 2.3 多 Provider | 高 | 中 | ★★★★ | 第 3-5 周 |
| 2.4 git 工具集 | 高 | 低 | ★★★★ | 第 2 周 |
| 2.5 命令面板 | 中 | 中 | ★★★ | 第 4-6 周 |
| 2.6 子 Agent 持久化 | 中 | 低 | ★★★ | 第 2 周 |
| 2.7 自动更新 | 中 | 低 | ★★★★ | 第 2 周 |
| 3.1 事件系统 CQRS | 极高 | 极高 | ★★★ | 第 2-4 月 |
| 3.2 Plugin 系统 | 高 | 高 | ★★★★ | 第 2-3 月 |
| 3.3 LSP 集成 | 中 | 高 | ★★★ | 第 3-4 月 |
| 3.4 语义搜索 | 中 | 高 | ★★ | 第 4-5 月 |
| 3.5 多模态 | 中 | 中 | ★★★ | 第 3 月 |
| 3.6 跨平台 | 中 | 中 | ★★★ | 第 2-3 月 |
| 3.7 可观察性 | 中 | 低 | ★★★★ | 第 1-2 月 |
| 3.8 远程控制 | 中 | 极高 | ★★ | 第 5-6 月 |

---

## 五、不建议做的事

1. **不要迁移到 Effect**：OpenCode 的 Effect 体系学习曲线极高，团队小项目不建议。React + Zustand 足够。
2. **不要自研 TUI**：Claude Code 自研 Ink 是因为终端场景必须；ClerkBox 是 GUI，没必要。
3. **不要照搬 Claude Code 的 monolithic harness**：132K 行单包不适合小团队，保持模块化。
4. **不要引入 SolidJS**：OpenCode 用 Solid 是为了 Web/TUI 共用 reconciler；ClerkBox 已用 React，切换成本远大于收益。
5. **不要追求 40+ 内置工具**：Claude Code 的工具数是历史积累，ClerkBox 应聚焦核心工具 + MCP 扩展。
6. **不要在客户端做 feature flag 隐藏敏感逻辑**：Claude Code 的源码泄露已证明 DCE 不是安全边界。

---

## 六、差异化机会

ClerkBox 相对 Claude Code / OpenCode 的独特优势：

1. **VIBE 液态玻璃模式**：Claude Code/OpenCode 都没有，是 Apple Liquid Glass 规范的桌面实现，可作为视觉差异化卖点
2. **MD3 HCT 动态配色**：比 Claude Code 的静态 theme 强，比 OpenCode 的 Kobalte 更轻
3. **Skill Marketplace 已成型**：SkillHub API + 多 CDN 源，OpenCode 没有市场
4. **桌面原生体验**：frameless + transparent + 圆角 + 系统通知，比 CLI 工具更亲民
5. **中文场景优化**：Bing 搜索 + 中文 memory + 中文 onboarding，国内用户友好

**建议**：在补齐 MCP + 多 Provider + git 工具后，重点打磨 VIBE 模式 + MD3 主题 + Skill Marketplace 作为差异化卖点，而不是跟 Claude Code 拼工具数量。

---

## 七、执行建议

### 第一阶段（第 1 周）：基础卫生
- 1.1 main.ts 分层
- 1.2 sql.js 替换 JSON
- 1.3 always allow 持久化
- 1.4 dead code 清理
- 1.5 ErrorBoundary
- 2.7 自动更新
- 2.6 子 Agent 持久化

### 第二阶段（第 2-4 周）：生态开放
- 2.1 MCP 支持（核心）
- 2.2 工具系统重构（与 2.1 同步）
- 2.4 git 工具集
- 3.7 可观察性（本地日志）

### 第三阶段（第 5-8 周）：能力扩展
- 2.3 多 Provider（Anthropic + Google）
- 2.5 命令面板 + 快捷键
- 3.5 多模态（图片输入）
- 3.6 跨平台打包（macOS）

### 第四阶段（第 3-6 月）：架构升级
- 3.2 Plugin 系统
- 3.3 LSP 集成
- 3.1 事件系统 CQRS（可选）

---

## 总结

ClerkBox 当前最大的问题是**生态封闭**（无 MCP/Plugin）和**架构耦合**（main.ts 单体 + JSON-DB + 单 Provider）。短期应聚焦基础卫生（分层 + SQLite + 权限持久化），中期必须补齐 MCP + 工具系统重构 + 多 Provider + git 工具，长期可考虑 Plugin + LSP + 事件系统。

**最关键的一步是 MCP 支持**——它能让 ClerkBox 从"封闭桌面应用"变成"开放生态平台"，瞬间接入整个 AI 工具生态。这比任何其他改进都重要。

VIBE 模式 + MD3 主题 + Skill Marketplace 是 ClerkBox 的差异化优势，应在补齐生态后继续打磨，而非为了追平 Claude Code 而放弃。
