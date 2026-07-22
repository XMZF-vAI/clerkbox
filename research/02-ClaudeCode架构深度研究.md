# Claude Code CLI 源码架构深度分析报告

> 仓库路径：`d:/claude-code-source`；基于 v2.1.88 反混淆源码；约 1,884 文件、132K 行 TypeScript。本报告基于源码静态阅读，未做任何修改。

## 1. 项目整体架构

### 1.1 `source/src/` 目录组织

源码按"功能内聚"原则划分目录，每个目录大致对应一个独立子系统：

| 目录 | 职责 |
|------|------|
| `bootstrap/` | 进程级单例状态（cwd、session ID、模型覆盖、teleport 信息等） |
| `bridge/` | 远程控制（claude.ai 手机/网页远程驱动 CLI） |
| `buddy/` | BUDDY 实验性 AI 伴侣精灵（动画 + 通知） |
| `cli/` | CLI 子模式（handlers、print 模式、remoteIO、structuredIO） |
| `commands/` | 60+ 斜杠命令实现（每命令一个目录） |
| `components/` | REPL UI 组件（App.tsx、Message、TextInput、TaskListV2 等） |
| `constants/` | 编译期常量（apiLimits、betas、keys、prompts、xml、tools） |
| `context/` | React Context Providers（mailbox、notifications、voice、stats、modal） |
| `coordinator/` | COORDINATOR_MODE 多 Worker 编排 |
| `entrypoints/` | 三个入口：`cli.tsx`、`init.ts`、`mcp.ts` |
| `hooks/` | React Hooks + useCanUseTool、useTasksV2、useReplBridge、useVimInput 等 |
| `ink/` | 完整自研 Ink 实现（components/events/hooks/layout/termio） |
| `keybindings/` | 快捷键匹配、解析、schema、template |
| `memdir/` | 自动 Memory 系统（memdir、memoryAge、memoryScan、paths、teamMem*） |
| `migrations/` | 配置迁移（Fennec→Opus、Sonnet 4.5→4.6、bypassPermissions→settings） |
| `plugins/` | 内置插件（bundled/index.ts、builtinPlugins.ts） |
| `query/` | 查询循环辅助（config、deps、stopHooks、tokenBudget） |
| `schemas/` | hooks schema |
| `screens/` | Doctor.tsx、REPL.tsx（顶层屏幕） |
| `server/` | directConnect 服务端 |
| `services/` | API/OAuth/LSP/MCP/voice/notifier/vcr/preventSleep/awaySummary |
| `skills/` | bundled skills（batch、debug、loop、stuck、verify 等）+ loadSkillsDir |
| `state/` | AppState、AppStateStore、selectors、store |
| `tasks/` | Task 类型（pillLabel、stopTask、types） |
| `tools/` | 40+ 工具，每工具一目录（AgentTool、BashTool、MCPTool 等） |
| `types/` | 共享类型（command、hooks、ids、permissions、plugin、message） |
| `upstreamproxy/` | 上游代理 relay |
| `utils/` | 海量工具函数（bash、git、model、plugins、settings、tasks、telemetry 等） |
| `vim/` | Vim 模式（motions、operators、textObjects、transitions） |
| `voice/` | 语音输入/输出（VOICE_MODE 实验特性） |

### 1.2 顶层文件职责

- **`main.tsx`**（~785KB，编译产物）：CLI 真正入口。前几行就启动 side-effect（profileCheckpoint、MDM 配置预读、macOS 钥匙串预取并行化）。然后用 Commander 解析 CLI flags、加载 settings、迁移配置、初始化 GrowthBook/analytics/MCP/LSP、注册 bundled skills & plugins、启动 REPL 或一次性 print 模式。`feature('COORDINATOR_MODE')`、`feature('KAIROS')` 等通过 `bun:bundle` 实现编译期 dead-code 消除。
- **`QueryEngine.ts`**：一个 class，"每会话一个实例"。`submitMessage()` 开始一个 turn。持有 `mutableMessages`、`abortController`、`permissionDenials`、`totalUsage`、`discoveredSkillNames` 等会话级状态。它把 `ask()` 的核心逻辑抽出来，可被 headless/SDK 和（未来）REPL 共用。
- **`Task.ts`**：定义 7 种 TaskType（`local_bash`、`local_agent`、`remote_agent`、`in_process_teammate`、`local_workflow`、`monitor_mcp`、`dream`）和 TaskStatus。`generateTaskId()` 用 8 字节随机数 + 36 字符表生成抗暴力枚举 ID（前缀 b/a/r/t/w/m/d）。Task 接口只暴露 `kill()`（spawn/render 从未多态调用—已在 #22546 删除）。
- **`Tool.ts`**：工具系统顶层抽象（详见第 2 节）。
- **`query.ts`**：核心查询循环 `query()` / `queryLoop()`（async generator）。维护可变状态 `State`：messages、toolUseContext、autoCompactTracking、maxOutputTokensRecoveryCount、turnCount、transition。集成 reactive compact、context collapse、history snip、streaming tool executor、token budget。
- **`commands.ts`**：注册并分发所有命令。`COMMANDS()` 是 memoized 数组，`getCommands(cwd)` 合并内置命令 + skill 目录命令 + 插件命令 + 工作流命令 + 动态 skills，按 `meetsAvailabilityRequirement` 和 `isCommandEnabled` 过滤。还提供 `getSkillToolCommands`、`getSlashCommandToolSkills`、`getMcpSkillCommands` 给 SkillTool 列举可用技能。
- **`context.ts`**：构建 system prompt 上下文。`getSystemContext()` 包含 git status（branch、main branch、最近 5 条 log、user.name）、`getUserContext()` 包含 CLAUDE.md + 项目级 instructions。`setSystemPromptInjection()` 用于 ant-only 临时调试注入。
- **`tasks.ts`**：任务管理 facade。
- **`history.ts`**：消息历史。
- **`ink.ts`**：导出 ink 实例。
- **`tools.ts`**：注册 40+ 内置工具。

### 1.3 `source/analysis/` 文档要点

- **`remote-control.md`**：远程管理双轨架构—`/api/claude_code/settings` 1 小时轮询（ETag 缓存、SHA256 校验、fail-open）+ GrowthBook 实时 flag。6+ killswitch（`tengu_frond_boric` 关闭 analytics、`tengu_auto_mode_config` 自动模式、Statsig gate 禁用 bypassPermissions、`tengu_bridge_poll_interval_config` 调整轮询频率等）。企业设置变更需用户确认（securityCheck.tsx）。
- **`roadmap.md`**：基于可量化指标（文件数、LOC、跨文件引用）评估未发布特性。Tier 1：KAIROS（210 文件引用，最深）、Voice Mode（38 文件，6 平台原生二进制已编译）。Tier 2：Coordinator Mode（45 引用，独立 system prompt）。Tier 3：Buddy（14 文件、1,298 行）。108 个模块在 npm 构建中被 dead-code 消除，仅存于内部 monorepo。
- **`telemetry.md`**：双通道遥测—First-Party `api.anthropic.com/api/event_logging/batch`（640+ 事件类型）+ Datadog `us5.datadoghq.com`（64 白名单事件）+ BigQuery metrics 60 秒批量。隐私保护：MCP 工具名匿名化为 `mcp_tool`、文件路径只记扩展名、`user_bucket = SHA256(userId) % 30`、用户 prompt 默认不记录（需 `OTEL_LOG_USER_PROMPTS=1`）。`DISABLE_TELEMETRY=1` 或 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 可禁用。

### 1.4 `source/architecture/` 文档要点

- **`multi-agent.md`**：子代理类型表（general-purpose、Explore、Plan、60+ 内置 + 自定义）；模型路由优先级链：`CLAUDE_CODE_SUBAGENT_MODEL` env > 工具指定 > 代理配置 > 继承父级（同家族匹配避免降级）；Coordinator 多 Worker 编排用 priority-1 system prompt；Worktree 隔离给子代理独立仓库副本；KAIROS 自主模式有 Tick 机制、SleepTool、终端焦点感知、Brief 检查点。
- **`tool-system.md`**：40+ 工具按 6 类分（文件 6、执行 2、代理 4、网络 2、交互 3、计划/状态 3）；4 级权限模型（0 自动允许、1 首次确认、2 每次确认、3 阻止+警告）；4 模式（Default/Plan/Auto/Bypass）。

### 1.5 `source/comparison/` 对比要点

- **vs Cursor**：Claude Code 是 CLI-first Unix 工具，Cursor 是 GUI-first IDE。Claude Code 无索引按需搜索（最大 1M context），Cursor 预建 AST + embeddings（~272K RAG）。Claude Code 子代理无硬上限，Cursor 8 个并行。Claude Code 4 级权限，Cursor 隐式信任。Claude Code 有持久 memory + CLAUDE.md + 87 feature flags + KAIROS + Voice + Hooks。
- **vs Cline**：Cline 是 Apache 2.0 开源 VS Code 插件，任意 OpenAI-compatible 模型；Claude Code 专有，仅 Claude。Claude Code 是 monolithic agent harness（QueryEngine 单 46K 行），Cline 是 lean 单循环 + per-action 审批。Cline 无子代理、无持久 memory。Cline 优势：模型灵活性 + 本地模型 = $0 + 完全可审计。

## 2. 工具系统

### 2.1 `source/src/tools/` 目录结构

每个工具一个目录，标准模式：

```
tools/AgentTool/
  ├── UI.tsx          # 工具调用与结果的 React 渲染
  ├── prompt.ts       # 工具描述 + 模型 prompt
  ├── AgentTool.ts    # 主实现（部分工具有）
  ├── constants.ts    # 工具名等常量
  └── loadAgentsDir.ts  # 子模块
```

观察到的工具：AgentTool、BashTool、BriefTool、ConfigTool、FileEditTool、FileReadTool、GlobTool、GrepTool、LSPTool、MCPTool、SkillTool、SleepTool、TaskStopTool、WebFetchTool（README 还提到 FileWriteTool、NotebookEdit、WebSearchTool、AskUserQuestionTool、EnterPlanModeTool、ExitPlanModeTool、TodoWriteTool、SendMessageTool、ToolSearchTool、ListMcpResourcesTool、ReadMcpResourceTool、McpAuthTool、SyntheticOutputTool、WorkflowTool、REPLTool 等）。

### 2.2 UI.tsx + prompt.ts 设计模式

- **`prompt.ts`**：导出 `DESCRIPTION`、`PROMPT`、`getName()`、`getDescription()`，常含 `getXxxPrompt()` 函数。例如 `BashTool/prompt.ts` 含 `getDefaultTimeoutMs`、`getMaxTimeoutMs`、`getBackgroundUsageNote`、`getCommitAndPRInstructions`（含 undercover 防护），动态拼接 prompt。
- **`UI.tsx`**：导出 `renderToolUseMessage`、`renderToolResultMessage`、`renderToolUseProgressMessage`、`userFacingName`、`getToolUseSummary` 等 React 组件/函数。例如 `FileEditTool/UI.tsx` 的 `userFacingName` 根据 input 返回 `'Create' | 'Update' | 'Updated plan'`；`AgentTool/UI.tsx` 用 `SubAgentProvider` + `CtrlOToExpand` 实现可展开子代理视图。
- **`MCPTool/MCPTool.ts`**：用 `buildTool({...} satisfies ToolDef)` 注册一个"占位"工具，所有方法在 `mcpClient.ts` 里按 server 动态覆盖。`maxResultSizeChars: 100_000`。

### 2.3 `Tool.ts` 顶层抽象

`Tool<Input, Output, P>` 接口（300+ 行），关键字段/方法：

- 元数据：`name`、`aliases`、`searchHint`、`isMcp`、`isLsp`、`shouldDefer`、`alwaysLoad`、`mcpInfo`、`maxResultSizeChars`、`strict`。
- 行为查询：`isConcurrencySafe(input)`、`isReadOnly(input)`、`isDestructive(input)`、`interruptBehavior()`（`'cancel' | 'block'`）、`isOpenWorld(input)`、`isSearchOrReadCommand(input)`、`requiresUserInteraction()`、`isTransparentWrapper()`、`isEnabled()`。
- 生命周期：`call(args, context, canUseTool, parentMessage, onProgress)` 是核心执行函数；`validateInput?` → `checkPermissions` → `call`。
- 渲染：`renderToolResultMessage`、`extractSearchText`、`getToolUseSummary`、`getActivityDescription`、`userFacingName`、`userFacingNameBackgroundColor`。
- Schema：`inputSchema`（zod）、`outputSchema`、`inputJSONSchema`（MCP 直传 JSON Schema）、`inputsEquivalent`、`mapToolResultToToolResultBlockParam`。
- 权限：`preparePermissionMatcher`（为 hooks `if` 条件预编译匹配器）、`getPath`。
- 缓存优化：`backfillObservableInput` 在观察者看到 input 前补字段（幂等、不动 API-bound input 以保 cache）。

`ToolUseContext` 是巨型上下文对象（50+ 字段）：`options`（commands、tools、mcpClients、agentDefinitions、maxBudgetUsd）、`abortController`、`getAppState/setAppState`、`setAppStateForTasks`（子代理可达根 store）、`handleElicitation`、`setToolJSX`、`addNotification`、`appendSystemMessage`、`sendOSNotification`、`messages`、`fileReadingLimits`、`globLimits`、`toolDecisions`、`queryTracking`、`requestPrompt`、`contentReplacementState`、`renderedSystemPrompt`（fork subagent 共享父 prompt cache）、`localDenialTracking` 等。

`ToolPermissionContext`：`mode`、`additionalWorkingDirectories`、`alwaysAllowRules/DenyRules/AskRules`（按 source 分层）、`isBypassPermissionsModeAvailable`、`isAutoModeAvailable`、`strippedDangerousRules`、`shouldAvoidPermissionPrompts`（后台代理）、`awaitAutomatedChecksBeforeDialog`（coordinator workers）、`prePlanMode`。

## 3. 命令系统

### 3.1 命令目录结构

每个命令目录标准模式：
```
commands/add-dir/
  ├── index.ts   # 声明命令 metadata + 懒加载入口
  └── add-dir.ts # 实际实现（按需 import）
```

`index.ts` 通常只是：
```ts
const addDir = {
  type: 'local-jsx',
  name: 'add-dir',
  description: 'Add a new working directory',
  argumentHint: '<path>',
  load: () => import('./add-dir.js'),
} satisfies Command
export default addDir
```

`type` 三种：`'local'`（无 UI）、`'local-jsx'`（返回 React 节点）、`'prompt'`（返回给模型的 prompt 内容，即 Skill）。`load()` 懒加载避免启动时拉满 1300+ 模块。

### 3.2 命令注册与分发

`commands.ts` 顶部 `import` 所有命令模块，按 `feature()` 条件 require 实验命令（`proactive`、`briefCommand`、`assistantCommand`、`bridge`、`remoteControlServerCommand`、`voiceCommand`、`forceSnip`、`workflowsCmd`、`webCmd`、`subscribePr`、`ultraplan`、`torch`、`peersCmd`、`forkCmd`、`buddy`）。

`COMMANDS()` memoized 数组展开所有内置命令 + 条件命令。`INTERNAL_ONLY_COMMANDS` 数组：当 `USER_TYPE === 'ant' && !IS_DEMO` 时加入。

`getCommands(cwd)` 是分发入口：
1. `loadAllCommands(cwd)` memoized：合并 `bundledSkills`、`builtinPluginSkills`、`skillDirCommands`、`workflowCommands`、`pluginCommands`、`pluginSkills`、`COMMANDS()`。
2. 按 `meetsAvailabilityRequirement`（`'claude-ai' | 'console'`）和 `isCommandEnabled` 过滤。
3. 注入 `getDynamicSkills()`（文件操作期间发现的 skills）。

`getSkillToolCommands` / `getSlashCommandToolSkills` 进一步过滤出 SkillTool 可调用的 prompt 命令。`clearCommandMemoizationCaches` 和 `clearCommandsCache` 提供 cache 失效。

`Command` 类型（`types/command.ts`）：`PromptCommand`（含 `getPromptForCommand`、`allowedTools`、`hooks`、`context: 'inline' | 'fork'`、`agent`、`effort`、`paths` glob）、`LocalCommand`、`LocalJSXCommand`（含 `load()` 懒加载）。公共字段：`availability`、`isEnabled`、`isHidden`、`aliases`、`whenToUse`、`loadedFrom`、`immediate`、`isSensitive`、`disableModelInvocation`。

## 4. Bridge / Remote Control 架构

### 4.1 `bridge/` 文件清单与职责

- **`bridgeConfig.ts`**：共享 auth/URL 解析。两层：`getBridgeTokenOverride()` / `getBridgeBaseUrlOverride()` 返回 ant-only `CLAUDE_BRIDGE_OAUTH_TOKEN` / `CLAUDE_BRIDGE_BASE_URL`；非 Override 版本降级到 OAuth keychain。
- **`bridgeApi.ts`**：HTTP 客户端、`BridgeFatalError`、`validateBridgeId`、`isExpiredErrorType`、`isSuppressible403`。
- **`bridgeMain.ts`**：`runBridgeLoop()`—长轮询主循环。维护 `activeSessions`、`sessionStartTimes`、`sessionWorkIds`、`sessionCompatIds`、`sessionIngressTokens`、`sessionTimers`、`completedWorkIds`、`sessionWorktrees`、`timedOutSessions`、`titledSessions`、`capacityWake`。退避配置 `DEFAULT_BACKOFF`：连接初始 2s、cap 2 分钟、放弃 10 分钟；通用 500ms / 30s / 10 分钟。`SPAWN_SESSIONS_DEFAULT = 32`。`isMultiSessionSpawnEnabled` 通过 `tengu_ccr_bridge_multi_session` gate 控制多会话模式。`pollSleepDetectionThresholdMs = connCapMs × 2` 检测系统休眠。
- **`bridgeMessaging.ts`**：处理入站消息、服务器控制请求、生成结果消息、`isEligibleBridgeMessage`、`extractTitleText`、`BoundedUUIDSet`。
- **`bridgePointer.ts`** / **`bridgeUI.ts`**：UI 桥接、`createBridgeLogger`。
- **`capacityWake.ts`**：信号量唤醒机制，让 at-capacity 睡眠在新会话完成时提前唤醒。
- **`codeSessionApi.ts`**：CCR v2 HTTP 包装器，`createCodeSession(baseUrl, accessToken, title, tags)` POST `/v1/code/sessions`，返回 `cse_*` session ID。独立文件以避免 SDK /bridge 子路径引入 CLI 重依赖。
- **`createSession.ts`**：`createBridgeSession`、`archiveBridgeSession`、`updateBridgeSessionTitle`。
- **`initReplBridge.ts`**：REPL 专用包装，从 bootstrap state 读取 cwd/session ID/git/OAuth/title，调 `initBridgeCore`。被 `useReplBridge`（自动启动）和 `print.ts`（SDK -p 模式）通过 dynamic import 调用。
- **`jwtUtils.ts`**：`createTokenRefreshScheduler`—会话 ingress JWT 心跳认证。
- **`pollConfig.ts`** / `pollConfigDefaults.ts`：轮询配置 `PollIntervalConfig`：`poll_interval_ms_not_at_capacity: 2000`、`poll_interval_ms_at_capacity: 600000`、`session_keepalive_interval_v2_ms: 120000`、`reclaim_older_than_ms: 5000`。
- **`replBridge.ts`**：`ReplBridgeHandle`（writeMessages、writeSdkMessages、sendControlRequest/Response、sendResult、teardown）+ `initBridgeCore`（无 bootstrap 依赖的核心）+ `BridgeState`（ready/connected/reconnecting/failed）+ `HybridTransport`（v1/v2 传输切换）。
- **`sessionIdCompat.ts`**：`toCompatSessionId` / `toInfraSessionId`—CSE shim 兼容层。
- **`sessionRunner.ts`**：`createSessionSpawner`、`safeFilenameId`—派生子 claude 进程。`spawnScriptArgs()` 区分 bundled 二进制 vs npm install（node + cli.js）。
- **`trustedDevice.ts`**：`getTrustedDeviceToken`。
- **`workSecret.ts`**：`decodeWorkSecret`、`buildSdkUrl`、`buildCCRv2SdkUrl`、`registerWorker`、`sameSessionId`。
- **`flushGate.ts`**：刷新门控，防 UUID 重复。
- **`inboundMessages.ts`** / **`bridgeDebug.ts`** / **`debugUtils.ts`** / **`bridgeEnabled.ts`**：调试和门控。

### 4.2 Bridge 系统目的

Bridge 是 **Anthropic claude.ai 网页/手机端远程驱动本地 CLI 的双向实时通道**。其工作流：

1. CLI 启动后通过 `initReplBridge` 创建一个 code session（`cse_*`），获得 environment ID + ingress URL。
2. `bridgeMain` 长轮询服务器获取新任务（用户在 claude.ai 输入的 prompt）。
3. `sessionRunner` 派生子 claude 进程在本地 cwd 执行任务，把 SDK 消息流回传给服务器。
4. 用户在 claude.ai 看到实时消息、可发送控制请求（permission、interrupt、setModel、setPermissionMode）。
5. JWT 心跳维持会话；ETag/SHA256 保证配置完整性；fail-open 保证远端不可用时本地仍工作。

文档 `analysis/en/remote-control.md` 详细列出 Bridge 相关 killswitch（`tengu_bridge_poll_interval_config`、`tengu_bridge_min_version`、`tengu_sessions_elevated_auth_enforcement`）。

## 5. Query Engine 与 Task 系统

### 5.1 `QueryEngine.ts` 设计

`QueryEngine` class 包装 `query()` generator。`QueryEngineConfig` 字段：cwd、tools、commands、mcpClients、agents、canUseTool、getAppState/setAppState、initialMessages、readFileCache、customSystemPrompt、appendSystemPrompt、userSpecifiedModel、fallbackModel、thinkingConfig、maxTurns、maxBudgetUsd、taskBudget、jsonSchema、replayUserMessages、handleElicitation、includePartialMessages、setSDKStatus、orphanedPermission、`snipReplay`（HISTORY_SNIP gate 内注入，避免 feature-gated 字符串泄漏到 QueryEngine）。

实例字段：`mutableMessages`、`abortController`、`permissionDenials`、`totalUsage`、`hasHandledOrphanedPermission`、`readFileState`、`discoveredSkillNames`（turn 内累积，turn 间清空防膨胀）、`loadedNestedMemoryPaths`。

`submitMessage()` 是 turn 入口：处理用户输入 → 构建 system prompt → 调 `query()` → 处理 stream events → 累积 usage → 触发 autoCompact。

### 5.2 `Task.ts` 设计

7 种 TaskType + 5 种 TaskStatus（pending/running/completed/failed/killed）。`isTerminalTaskStatus` 用于阻止向死任务注入消息、清理孤儿任务。`Task` 接口只暴露 `kill(taskId, setAppState)`—spawn/render 从未多态。`TASK_ID_PREFIXES` 给 ID 加前缀（b/a/r/t/w/m/d）。

### 5.3 `tasks/` 与 `useTasksV2.ts`

`tasks/types.ts` 定义具体 TaskState 联合类型（DreamTaskState、InProcessTeammateTaskState、LocalAgentTaskState、LocalShellTaskState、LocalWorkflowTaskState、MonitorMcpTaskState、RemoteAgentTaskState）。`isBackgroundTask` 判断是否显示在后台任务指示器（status running/pending 且未被显式前台化）。

`hooks/useTasksV2.ts` 用 `useSyncExternalStore` 实现的 `TasksV2Store` 单例：持有 `#tasks`、`#watcher`（fs.watch）、`#hideTimer`、`#debounceTimer`、`#pollTimer`（5000ms 兜底）、`#changed` 信号。多 hook 实例订阅一个共享 store，避免 Spinner mount/unmount 触发的 watch churn。`#hidden` 在所有任务完成 5 秒后置 true。

## 6. 状态管理

### 6.1 `state/` 自定义轻量 store

```ts
export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}
```

`createStore(initialState, onChange)`：极简实现，`Object.is` 比较避免无效更新，`onChange` 回调在 listener 通知前调用。

**未使用 zustand/jotai**—纯手写 store + React `useSyncExternalStore`。`AppStateStore.ts` 定义 `AppState`（`DeepImmutable<...>` & 部分 mutable 字段如 `tasks`、`agentNameRegistry: Map`、`mcp`、`plugins`、`companionReaction`、`notifications` 等）。

`AppState` 关键字段：
- 设置：`settings`、`verbose`、`mainLoopModel`、`mainLoopModelForSession`
- UI 状态：`expandedView`、`isBriefOnly`、`selectedIPAgentIndex`、`coordinatorTaskIndex`、`viewSelectionMode`、`footerSelection`、`spinnerTip`、`agent`
- 模式标志：`kairosEnabled`、`remoteSessionUrl`、`remoteConnectionStatus`、`remoteBackgroundTaskCount`
- Bridge 状态：`replBridgeEnabled/Explicit/OutboundOnly/Connected/SessionActive/Reconnecting/ConnectUrl/SessionUrl/EnvironmentId/SessionId/Error/InitialName`、`showRemoteCallout`
- 权限：`toolPermissionContext`
- 任务：`tasks`、`foregroundedTaskId`、`viewingAgentTaskId`、`agentNameRegistry`
- MCP：`mcp.{clients,tools,commands,resources,pluginReconnectKey}`
- 插件：`plugins.{enabled,disabled,commands,errors,installationStatus}`
- 伴侣：`companionReaction`、`companionPetAt`
- `SpeculationState`：`idle` 或 `active`（含 id、abort、messagesRef、writtenPathsRef、boundary、pipelinedSuggestion）

`AppState.tsx` 提供 `AppStateProvider`（React Context），内嵌 `MailboxProvider` 和条件 `VoiceProvider`（DCE for external builds）。`useSettingsChange` 监听设置变更调 `applySettingsChange`。

`selectors.ts` 提供 pure 选择器：`getViewedTeammateTask`、`getActiveAgentForInput`（返回 `{type:'leader'|'viewed'|'named_agent'}`）。

### 6.2 `context/` Provider

- `mailbox.tsx`：`MailboxProvider` 单例 `Mailbox`。
- `notifications.tsx`：通知队列（low/medium/high/immediate 优先级 + `invalidates` + `fold`）。
- `voice.tsx`：独立 store（`createStore(DEFAULT_STATE)`），`useVoiceState(selector)` 用 `useSyncExternalStore`。
- `stats.tsx` / `fpsMetrics.tsx`：统计与 FPS。
- `modalContext.tsx`：模态对话框。

## 7. Ink / TUI 实现

### 7.1 `ink/` 完整自研

Vadim Demedes 的 ink 库被 Anthropic 整体 fork 并大幅扩展。目录：

- `components/`：App、Box、Button、Link、Spacer、Text（基础元素）。还有 CursorDeclarationContext、ErrorOverview、StdinContext、TerminalFocusContext、TerminalSizeContext、ClockContext、AppContext。
- `events/`：click-event、focus-event、input-event、keyboard-event、dispatcher、emitter、event（自研 DOM 事件系统）。
- `hooks/`：use-app、use-input、use-interval、use-stdin。
- `layout/`：engine、geometry、node、yoga—Yoga 布局适配层，`YogaLayoutNode implements LayoutNode` 包装 `YogaNode`，映射 Edge/Gutter/Justify/FlexDirection 等。
- `termio/`：ansi、csi、dec、esc、osc、sgr、parser、tokenize、types—完整 ANSI 流式 parser，处理 SGR、CSI、DEC private modes、OSC 8 hyperlinks、grapheme segmentation、East Asian width、emoji。

顶层文件：`Ansi.tsx`（解析 ANSI 字符串渲染为 Text 组件）、`reconciler.ts`（基于 `react-reconciler` 的 custom reconciler，处理 DOM 节点 append/insert/remove/setAttribute/setStyle）、`renderer.ts`（`createRenderer` 把 yoga layout + DOM 树渲染到 Screen，diff prevFrame/backFrame）、`dom.ts`（虚拟 DOM）、`output.ts`（输出 buffer）、`screen.ts`（`createScreen`、`StylePool`、`CharPool`、`HyperlinkPool`）、`selection.ts`（文本选择）、`searchHighlight.ts`、`hit-test.ts`（点击 hit-test）、`frame.ts`（Frame 类型）、`instances.ts`、`log-update.ts`、`measure-element.ts`、`measure-text.ts`、`optimizer.ts`、`parse-keypress.ts`、`render-border.ts`、`render-to-screen.ts`、`render-node-to-output.ts`、`stringWidth.ts`、`tabstops.ts`、`terminal.ts`、`terminal-querier.ts`、`wrap-text.ts`、`wrapAnsi.ts`、`bidi.ts`（双向文本）。

`ink.tsx` 是核心类 `Ink`：持有 `terminal`、`log: LogUpdate`、`container: FiberRoot`、`focusManager: FocusManager`、`renderer`、`stylePool`、`charPool`、`hyperlinkPool`、`frontFrame`/`backFrame`（双缓冲）、`selection: SelectionState`、`searchHighlightQuery`、`searchPositions`、`hoveredNodes`、`altScreenActive`。`scheduleRender` 节流到 `FRAME_INTERVAL_MS`。`onExit` 注册 `signal-exit` 清理。

### 7.2 自研 Ink 的意义

1. **性能**：自研 charPool/hyperlinkPool/StylePool 池化减少 GC；双缓冲 frame diff；`optimizer.ts` 优化渲染。
2. **功能**：支持文本选择（vim 风格）、鼠标点击/hover、OSC 8 超链接、alt-screen 模式、Kitty keyboard protocol、focus events、search highlight、grapheme-aware 宽度计算、East Asian 宽度。
3. **可靠性**：`termio/` 流式 parser 正确处理 ANSI 边界，tmux/SSH detach-attach 后 `STDIN_RESUME_GAP_MS = 5000` 触发终端模式重新断言。
4. **集成**：与 React reconciler 深度集成，`useSyncExternalStore` 桥接外部 store；`ClockProvider`/`TerminalFocusProvider` 等多个 Context。
5. **可控性**：Anthropic 可自由扩展而无需上游 PR，已加 1300+ 行自定义代码。

## 8. Skills 与 Plugins

### 8.1 `skills/` 系统

- **`bundled/`**：内置 skill，每个文件 export `registerXxxSkill()`。`initBundledSkills()` 在启动时注册：updateConfig、keybindings、verify、debug、loremIpsum、skillify、remember、simplify、batch、stuck，条件注册 dream（KAIROS/KAIROS_DREAM）、hunter（REVIEW_ARTIFACT）、loop（AGENT_TRIGGERS）、scheduleRemoteAgents（AGENT_TRIGGERS_REMOTE）、claudeApi（BUILDING_CLAUDE_APPS）、claudeInChrome（auto）、runSkillGenerator（RUN_SKILL_GENERATOR）。
- **`bundledSkills.ts`**：`registerBundledSkill(definition: BundledSkillDefinition)` 注册到内部数组。`BundledSkillDefinition` 字段：`name`、`description`、`whenToUse`、`allowedTools`、`model`、`disableModelInvocation`、`userInvocable`、`isEnabled`、`hooks`、`context: 'inline' | 'fork'`、`agent`、`files: Record<string, string>`（首次调用时解压到磁盘的附加参考文件）、`getPromptForCommand`。`getBundledSkills()` 转 Command 数组。
- **`loadSkillsDir.ts`**：从磁盘加载 skills（`~/.claude/skills/`、项目 `.claude/skills/`、managed 路径）。`LoadedFrom` 类型：`'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'`。解析 frontmatter（含 `allowed-tools`、`model`、`hooks`、`paths` glob、`context: fork`、`agent`），支持 shell frontmatter 执行。
- **batch skill**：并行编排大型可并行变更。Phase 1 进 Plan Mode 分解为 5–30 个独立单元（每单元可在隔离 worktree 实现+合并），Phase 2 用 `AGENT_TOOL_NAME` 启动 worker，每 worker 跑 simplify → 测试 → e2e → commit/push/PR → 报告 `PR: <url>`。
- **verify skill**：ant-only，验证代码变更确实有效（运行应用）。

### 8.2 `plugins/` 系统

- **`bundled/index.ts`**：`initBuiltinPlugins()` 目前空—为未来迁移 bundled skill 到可切换 built-in plugin 做脚手架。
- **`builtinPlugins.ts`**：`BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition>`。`registerBuiltinPlugin(definition)`。`pluginId` 格式 `{name}@builtin`（区别于 marketplace 插件 `{name}@{marketplace}`）。`getBuiltinPlugins()` 按 user settings + `defaultEnabled` 拆分 enabled/disabled。

### 8.3 `utils/plugins/` 管理

- **`refresh.ts`**：三层模型—Layer 1 intent（settings）→ Layer 2 物化（`~/.claude/plugins/`，`reconcileMarketplaces`）→ Layer 3 活跃组件（AppState，本文件 `refreshActivePlugins`）。返回 `RefreshActivePluginsResult`：`enabled_count`、`disabled_count`、`command_count`、`agent_count`、`hook_count`、`mcp_count`、`lsp_count`、`error_count`、`agentDefinitions`、`pluginCommands`。调用方：`/reload-plugins`、`print.ts refreshPluginState`、`performBackgroundPluginInstallations`。
- **`schemas.ts`**：`ALLOWED_OFFICIAL_MARKETPLACE_NAMES`（`claude-code-marketplace`、`anthropic-marketplace` 等 7 个保留名），`isMarketplaceAutoUpdate`（官方 marketplace 默认 auto-update，`NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES` 例外如 `knowledge-work-plugins`）。
- 还有 `pluginLoader.ts`、`loadPluginCommands.ts`、`loadPluginHooks.ts`、`loadPluginMcpServers.ts`、`loadPluginLspServers.ts`、`cacheUtils.ts`、`installedPluginsManager.ts`、`managedPlugins.ts`、`pluginDirectories.ts`、`orphanedPluginFilter.ts`、`mcpPluginIntegration.ts`、`lspPluginIntegration.ts`、`zipCache.ts`。

插件可提供：commands、agents、hooks、MCP servers、LSP servers，全部经 `refreshActivePlugins` 注入 AppState 和 LSP/MCP manager。

## 9. MCP 服务

### 9.1 `services/mcp/` 文件职责

- **`client.ts`**：MCP 客户端核心。用 `@modelcontextprotocol/sdk` 的 `Client` + 多种 Transport（`StdioClientTransport`、`SSEClientTransport`、`StreamableHTTPClientTransport`、`WebSocketTransport`、`SdkControlClientTransport`）。`ClaudeAuthProvider` 实现 `OAuthClientProvider`。处理 `CallToolResultSchema`、`ListToolsResultSchema`、`ListPromptsResultSchema`、`ListResourcesResultSchema`、`ListRootsRequestSchema`、`ElicitRequestSchema`。`UnauthorizedError` 检测、401 触发 OAuth refresh、image resize、binary blob 持久化、`getContentSizeEstimate` + `truncateMcpContentIfNeeded`、`mcpContentNeedsTruncation`、unicode sanitization、MCP skills（`fetchMcpSkillsForClient`，feature-gated）。
- **`config.ts`**：从多 source 加载 MCP 配置（global config、project config、settings.json 的 `mcpServers`、`getEnterpriseMcpFilePath()` = `<managed>/managed-mcp.json`、plugin MCP、claude.ai org configs）。`McpServerConfig` 类型：`McpStdioServerConfig | McpSSEServerConfig | McpHTTPServerConfig | McpWebSocketServerConfig`。`addScopeToServers` 给每个 server 加 `scope: ConfigScope`。
- **`auth.ts`**：完整 OAuth 2.0 + PKCE 实现。`discoverAuthorizationServerMetadata` / `discoverOAuthServerInfo` 自动发现。处理 `InvalidGrantError`、`OAuthError`、`ServerError`、`TemporarilyUnavailableError`、`TooManyRequestsError`。`MCPRefreshFailureReason` 枚举（`metadata_discovery_failed`、`no_client_info`、`no_tokens_returned`、`invalid_grant`、`transient_retries_exhausted`、`request_failed`）。用 `xss` 库防 XSS、`lockfile` 防并发、secure storage 存 token。
- **`claudeai.ts`**：从 Claude.ai org 配置拉取 MCP server 列表（`mcp-servers-2025-12-04` beta header）。memoized 一次会话只拉一次。`ClaudeAIMcpServer` 类型（id、display_name、url、created_at）。
- **`xaa.ts`**：Cross-App Access / SEP-990—无浏览器同意屏取 MCP token：RFC 8693 token exchange（id_token → ID-JAG）+ RFC 7523 JWT bearer grant（ID-JAG → access_token）。`makeXaaFetch` 用 `AbortSignal.any` 合并 timeout + 用户 cancel。
- **`oauthPort.ts`**：找可用端口给 OAuth redirect。Windows 用 39152–49151（避开 49152–65535 动态端口保留区），其他平台 49152–65535，fallback 3118。随机选择 100 次尝试。
- **`utils.ts`**：`filterToolsByServer`（前缀 `mcp__<server>__`）、`commandBelongsToServer`（prompts 是 `mcp__<server>__<prompt>`，skills 是 `<server>:<skill>`）、`getEnterpriseMcpFilePath`。
- **`types.ts`**：MCP 配置和连接类型定义。

### 9.2 MCP 客户端工作流

1. 启动时 `getAllMcpConfigs()` 合并所有 source 的 server 配置。
2. 按 `filterMcpServersByPolicy` 过滤（企业策略、`isMcpServerDisabled`、`areMcpConfigsAllowedWithEnterpriseMcpConfig`）。
3. 对每个 server 创建 `Client` + Transport，调 `client.connect()`。
4. `ListTools` → 每个 tool 包成 `MCPTool`（`buildTool` + 在 `mcpClient.ts` 覆盖 `name`/`description`/`prompt`/`call`/`checkPermissions`/`mcpInfo`）。
5. `ListPrompts` → 转 `Command`（type 'prompt'）。
6. `ListResources` → 存 `ServerResource[]`。
7. 工具调用时按需 OAuth refresh、image resize、binary 持久化、content truncation。
8. `MCP_SKILLS` gate 开启时还可发现 MCP skills。

## 10. Memory 系统

### 10.1 `memdir/` 设计

- **`memdir.ts`**：核心。`ENTRYPOINT_NAME = 'MEMORY.md'`、`MAX_ENTRYPOINT_LINES = 200`、`MAX_ENTRYPOINT_BYTES = 25_000`。`truncateEntrypointContent` 同时按行和字节截断，附 warning。`buildMemoryPrompt` 构建主 prompt。条件导入 `teamMemPaths`（TEAMMEM feature gate）。
- **`paths.ts`**：`isAutoMemoryEnabled()` 优先级链：`CLAUDE_CODE_DISABLE_AUTO_MEMORY` env > `CLAUDE_CODE_SIMPLE` (--bare) > CCR 无持久存储 > `autoMemoryEnabled` settings > 默认 true。`isExtractModeActive()` 检查 `tengu_passport_quail`（extraction gate）+ `tengu_slate_thimble`（非交互场景 gate）。`getAutoMemPath()` 返回基础目录。
- **`memoryScan.ts`**：`scanMemoryFiles(memoryDir)` 用 `readdir({recursive: true})` 扫 `.md`（排除 MEMORY.md），`readFileInRange` 读 frontmatter（最多 30 行），返回 `MemoryHeader[]` 按 mtime 倒序，cap 200。
- **`memoryTypes.ts`**：4 种 closed taxonomy：`user`、`feedback`、`project`、`reference`。明确定义"code patterns、architecture、git history、file structure 不应存为 memory（可从代码/git/CLAUDE.md 派生）"。`TYPES_SECTION_COMBINED` 和 `TYPES_SECTION_INDIVIDUAL` 故意重复（便于 per-mode 编辑）。
- **`memoryAge.ts`**：`memoryAgeDays`、`memoryAge`（"today"/"yesterday"/"N days ago"）、`memoryFreshnessText`/`memoryFreshnessNote`—对 >1 天的 memory 加 staleness caveat（防止 file:line 引用过期代码）。
- **`teamMemPaths.ts`**：团队 memory 路径解析 + `PathTraversalError`（防 null byte、URL-encoded `..`、Unicode NFKC 归一化攻击）。
- **`teamMemPrompts.ts`**：`buildCombinedMemoryPrompt` 合并 private + team memory，含 `<scope>` 标签指导每类型存哪个目录。

### 10.2 个人 vs 团队 Memory

- **个人 memory**：默认 `~/.claude/memory/`（或 `CLAUDE_CODE_REMOTE_MEMORY_DIR` for CCR）。
- **团队 memory**：`getTeamMemPath()`，存项目共享路径（git 仓库内或共享目录）。
- 类型作用域：`user` 永远 private；`feedback` 默认 private（除非项目级约定）；`project` 倾向 team；`reference` 视情况。
- 防护：路径遍历攻击防御（null byte、URL encoding、Unicode NFKC）；mtime 标注 staleness；`MAX_MEMORY_FILES = 200` 防膨胀。
- 提取机制：`isExtractModeActive()` gate 控制 `extractMemories` 后台 agent（在 turn 末 fork 出来扫对话抽 memory，主代理已写则跳过该范围）。

## 11. Services 层

### 11.1 `services/api/`

- **`bootstrap.ts`**：`fetchBootstrapAPI()` GET `/api/claude_cli/bootstrap`，返回 `client_data` 和 `additional_model_options`（model/name/description）。OAuth 首选（需 `user:profile` scope），fallback API key。3P provider 跳过，`isEssentialTrafficOnly` 跳过。
- **`claude.ts`**：核心 API 调用层。导入 `@anthropic-ai/sdk` beta messages 类型。处理 cache scope、`splitSysPromptPrefix`、`toolToAPISchema`、`getMergedBetas`/`getModelBetas`/`getBedrockExtraBodyParamsBetas`、`computeFingerprintFromMessages`、`normalizeMessagesForAPI`、`ensureToolResultPairing`、`getModelMaxOutputTokens`、`CAPPED_DEFAULT_MAX_TOKENS`、`getSonnet1mExpTreatmentEnabled`、`resolveAppliedEffort`、`configureTaskBudgetParams`（task-budgets-2026-03-13 beta）。
- **`client.ts`**：构造 `Anthropic` SDK 实例。支持 Direct API、AWS Bedrock（`AWS_REGION`、`ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION`）、Vertex AI（`getVertexRegionForModel`）、Azure Foundry（`ANTHROPIC_FOUNDRY_RESOURCE` / `ANTHROPIC_FOUNDRY_BASE_URL` / `ANTHROPIC_FOUNDRY_API_KEY`）。代理、mTLS、API key helper。
- **`errors.ts`**：`classifyAPIError`、`categorizeRetryableAPIError`、`isPromptTooLongMessage`、`PROMPT_TOO_LONG_ERROR_MESSAGE`、`REPEATED_529_ERROR_MESSAGE`、`getRateLimitErrorMessage`、`OverageDisabledReason`。
- **`withRetry.ts`**：重试策略。`DEFAULT_MAX_RETRIES = 10`、`MAX_529_RETRIES = 3`、`BASE_DELAY_MS = 500`、`FLOOR_OUTPUT_TOKENS = 3000`。区分前台 query source（用户阻塞，重试 529）vs 后台（title/summary/classifier，立即放弃，避免级联放大）。处理 `handleFastModeOverageRejection`、`handleFastModeRejectedByAPI`、`isFastModeCooldown`、`triggerFastModeCooldown`、`isMockRateLimitError`、`disableKeepAlive` on connection errors。
- **`logging.ts`**：`EMPTY_USAGE`、`accumulateUsage`、`updateUsage`、`addToTotalDurationState`、`logOTelEvent`、`endLLMRequestSpan`、`isBetaTracingEnabled`、`Span`、`GlobalCacheStrategy: 'tool_based' | 'system_prompt' | 'none'`、`sanitizeToolNameForAnalytics`。
- **`filesApi.ts`**：Anthropic Public Files API（beta `files-api-2025-04-14,oauth-2025-04-20`）。`parseFileSpecs('--file=<id>:<path>')`、`downloadSessionFiles`。
- **`grove.ts`**：Grove 设置（domain excluded notice），24h cache。
- **`referral.ts`**：`fetchReferralEligibility`（`claude_code_guest_pass` campaign），`fetchReferralRedemptions`，5s timeout，24h cache。
- **`usage.ts`**：用量查询。

### 11.2 `services/oauth/`

- **`index.ts`**：`OAuthService` class，PKCE 流程。`startOAuthFlow` 支持 automatic（浏览器 + localhost listener）和 manual（用户复制粘贴 code）双路径。`skipBrowserOpen` 给 SDK control protocol 用。
- **`client.ts`**：`buildAuthUrl`（claude.ai authorize URL 或 console authorize URL）、`shouldUseClaudeAIAuth`（检查 `CLAUDE_AI_INFERENCE_SCOPE`）、`parseScopes`、`getOauthProfileFromOauthToken`、`OAuthProfileResponse`、`OAuthTokenExchangeResponse`、`RateLimitTier`、`SubscriptionType`、`UserRolesResponse`。
- **`crypto.ts`**：`generateCodeVerifier`（32 random bytes base64url）、`generateCodeChallenge`（SHA256）、`generateState`（32 random bytes）。

### 11.3 `services/lsp/`

- **`LSPClient.ts`**：基于 `vscode-jsonrpc/node.js` 的 LSP 客户端。`createLSPClient(serverName, onCrash)` 返回 `{capabilities, isInitialized, start, initialize, sendRequest, sendNotification, onNotification, onRequest, stop}`。spawn 子进程，stdio 通信，`Trace` 支持。
- **`manager.ts`**：`LSPServerManager` 单例。`getLspServerManager()` / `getInitializationStatus()` / `reinitializeLspServerManager()`（plugin 刷新时调）。generation counter 防止 stale init promise 污染 state。
- **`config.ts`**：LSP server 配置（按 file type）。
- 还有 `LSPServerManager.ts`、`passiveFeedback.ts`（注册 notification handlers 把 LSP diagnostic 喂回模型）。

### 11.4 `services/` 其他

- **`notifier.ts`**：OS 通知。多 channel：`iterm2`、`iterm2_with_bell`、`kitty`、`auto`（自动选择）、bell。`executeNotificationHooks` 调用户 hooks。`preferredNotifChannel` 来自 global config。
- **`preventSleep.ts`**：macOS `caffeinate` 包装。`CAFFEINATE_TIMEOUT_SECONDS = 300`（5 分钟自动退出，防 SIGKILL 孤儿），`RESTART_INTERVAL_MS = 4 分钟`（提前重启）。引用计数 `refCount`。
- **`vcr.ts`**：测试 fixture 录制/回放（仅 ant + `FORCE_VCR` 或 `NODE_ENV=test`）。SHA1 hash 输入 → fixtures 文件名。
- **`voice.ts`**：原生 audio capture（`audio-capture-napi`，跨平台 .node 文件）+ SoX/arecord 兜底。16kHz 单声道。silence detection 2 秒 3% 阈值。lazy load 避免冷启动阻塞。
- **`awaySummary.ts`**：用户离开回归后用 small fast model 生成 1–3 句 recap。`RECENT_MESSAGE_WINDOW = 30`，含 session memory。
- **`voiceKeyterms.ts`**：语音关键词。

## 12. 可借鉴的设计

针对 Electron + React 桌面 AI 助手，以下设计最有借鉴价值：

### 12.1 解耦思路

1. **三层 Plugin 模型**（intent → materialization → active components）：设置变更不直接修改运行时，先物化到磁盘再 refresh 到 AppState。Electron 主进程可借鉴这种"配置 → 缓存 → 运行时"分层。
2. **Tool / Command / Skill / MCP 四正交系统**：
   - Tool：模型可调用的能力（zod schema + 权限 + UI 渲染）
   - Command：用户斜杠命令（local / local-jsx / prompt 三种 type + 懒加载 load()）
   - Skill：模型可发现的 prompt 命令（含 fork sub-agent、hooks、files 资源）
   - MCP：外部动态工具/资源/prompts，通过统一 adapter 注入

   这套解耦让"加一个能力"只需在一个目录加文件 + 注册，Electron 应用可借鉴实现插件化扩展。
3. **Tool 接口的丰富元数据**：`isConcurrencySafe`、`isReadOnly`、`isDestructive`、`interruptBehavior`、`isOpenWorld`、`isSearchOrReadCommand`、`maxResultSizeChars`、`shouldDefer`、`alwaysLoad`、`searchHint`—这些字段让调度器、UI、权限系统、缓存系统都能按需查询而不耦合具体工具。
4. **PermissionContext 4 模式 × 4 级**：Default/Plan/Auto/Bypass 模式 × Level 0–3 危险度。`alwaysAllowRules/DenyRules/AskRules` 按 source（user/project/managed）分层。Electron 桌面 AI 同样需要这种细粒度权限模型。
5. **QueryEngine + query() 分层**：QueryEngine 持有会话状态、`query()` 是无状态 generator。一个会话一个 QueryEngine，多 turn 共享 messages/cache/usage。便于多窗口/多会话隔离。
6. **Task 系统 7 种类型 + kill-only 接口**：任务类型多样化（local/remote/in-process teammate/workflow/monitor/dream）但公共接口只有 `kill()`，spawn/render 各自实现。Electron 可借鉴实现统一的"后台任务"抽象。
7. **Bridge 远程控制**：claude.ai 网页远程驱动本地 CLI 的设计—code session (`cse_*`) + JWT 心跳 + 长轮询 + 双向消息 + 派生子进程。Electron 桌面助手可借鉴实现"手机/网页远程控制桌面 AI"。
8. **自研 Ink 的池化 + 双缓冲**：charPool/hyperlinkPool/StylePool 减少 GC，frontFrame/backFrame diff 减少 redraw。Electron 渲染进程高频更新 UI 时可借鉴。
9. **Memory 系统 4 类 + staleness**：user/feedback/project/reference taxonomy + mtime-based staleness caveat + path traversal 防御 + 私有/团队作用域。桌面 AI 助手的长期记忆系统可直接借鉴。
10. **5 层 system prompt 优先级 + cache boundary**：Override > Coordinator > Agent > Custom > Default，`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 分割静态/动态部分最大化 cache 命中。
11. **`bun:bundle` feature() 编译期 DCE**：同一份源码编译出 public npm（移除 ant-only 和实验特性）vs internal monorepo 版本，靠 `feature('KAIROS')` 等编译期常量。Electron 应用可借鉴实现 free/pro/enterprise 多版本构建。
12. **`tengu_*` 混淆 flag 名**：用 `tengu_frond_boric` 等随机词对命名 runtime flag，故意隐藏用途—既是逆向防护也提醒开发者这些是内部开关。桌面应用同样需要"对外可配置但内部命名不暴露意图"的机制。

### 12.2 关键陷阱

- **dead code elimination 不是安全边界**：源码暴露后所有内部特性（KAIROS、Coordinator、Voice、Buddy）都被发现。Electron 应用慎用客户端 feature flag 隐藏敏感逻辑。
- **遥测 fail-open**：远程设置不可用时继续工作—方便但意味着 killswitch 失效时无法远程禁用。
- **路径遍历攻击面**：memory 系统需防 null byte、URL encoding、Unicode NFKC 归一化—任何让用户写文件名的功能都要防。
- **UUID 重复 poisoning**：Bridge 重复 flush 相同 UUID 会导致服务器 kill WS—`flushGate` + `previouslyFlushedUUIDs` Set 是必要的。

---

## 总结

Claude Code 是一个 **CLI-first、React+Ink 驱动、高度可扩展的 monolithic agent harness**。其设计哲学可概括为：

1. **类型驱动 + DeepImmutable**：AppState、Tool、Command、Task 全部强类型，`DeepImmutable` 强制不可变更新。
2. **编译期 feature flag + 运行期 GrowthBook 双层控制**：`bun:bundle feature()` 做 DCE，`tengu_*` 做 runtime gate。
3. **懒加载极致**：Command `load()` 动态 import、`insights.ts` 113KB shim、MCP tool 在 connect 时才覆写、Skill 在调用时才解压 files。
4. **缓存分层 + memoize**：commands、skills、settings、OAuth、bootstrap 全部 memoize；prompt cache 用 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 静态/动态分割。
5. **权限纵深**：4 模式 × 4 级 × 按 source 分层 allow/deny/ask rules + Hooks matcher + auto classifier + undercover mode。
6. **多 agent 隔离**：fresh context subagent + worktree 隔离 + 模型路由优先级链 + fork subagent 共享父 prompt cache。
7. **远程可控但 fail-open**：1 小时 polling + ETag + SHA256 + 用户确认，但远端不可用时继续工作。
8. **自研基础设施**：Ink、store、ANSI parser、Yoga layout adapter、shell parser 全部自研以获得控制权和性能。

这套架构的复杂度（132K 行 TS、1884 文件）远超普通 CLI 工具，更接近一个"终端原生的 AI 开发平台"。其解耦思路、权限模型、Memory 系统、Plugin 三层模型对 Electron + React 桌面 AI 助手有直接借鉴价值。
