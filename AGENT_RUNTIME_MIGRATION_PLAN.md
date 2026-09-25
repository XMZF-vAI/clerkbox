# ClerkBox Agent 运行时迁移方案（批次 B）

> 目标读者：负责实施的 AI/工程师。本文档是完整交底，包含现状锚点、目标架构、事件协议、
> 分阶段计划、验收标准与回滚策略。行号锚点基于 commit `744338d`，实施时以符号搜索为准。
>
> **前置约束（AGENTS.md 五阶段流程）**：本文档即「计划」阶段产物。实施者须按阶段推进，
> 每阶段独立提交、全量自检（tsc + 92 单测 + vite build）、演示通过后才可推送。

---

## 1. 背景与目标

### 1.1 问题

Agent ReAct 主循环目前运行在**渲染进程**（浏览器窗口层）：

- 核心文件 `src/hooks/use-agent.ts`（约 2547 行），`useAgent(sessionId)` hook。
- 挂载点：`src/components/chat/ChatPage.tsx:31`（主界面）、`src/components/scheduled/TaskRunHost.tsx:70`（定时任务）。
- ReAct 主循环：`use-agent.ts:1445` 的 `for (let iteration = 0; ; iteration++)`，上限 `MAX_REACT_ITERATIONS = 100`（`use-agent.ts:89`）。

由此产生四个硬伤：

1. **窗口崩溃/F5 重载 = 任务死亡**（`electron/updater.ts:27` 注释自认"渲染挂了 agent 必死"）。
2. **关窗到托盘是假后台**：窗口销毁后 agent 随之消亡；macOS 关窗即销毁。
3. **WebUI 远程模式同样脆弱**：浏览器标签页一关任务即断。
4. **UI 与计算挤在一个进程**：流式密集时渲染掉帧。

### 1.2 目标

把 Agent 编排逻辑迁出渲染进程，UI 退化为**纯视图 + 指令下发器**：

- 渲染进程崩溃/刷新/关闭，任务在主进程继续跑；重连后可看到进行中的任务。
- WebUI 标签页关闭后任务继续；重开页面可回放。
- 关窗到托盘 = 真正的后台 agent；定时任务（TaskRunHost）不再依赖窗口存活。
- 为多窗口/多 agent 并行、权限审批三段式（C2）、模型轨迹面板打下协议地基。

### 1.3 非目标（本批次不做）

- 不引入 utilityProcess/多子进程泳道（后续优化项，见 §7）。
- 不改工具功能语义、不改 db* 存储契约、不改 i18n 文案。
- 不做多窗口、不做 agent 并行调度。

---

## 2. 现状架构（必须先读懂再动手）

### 2.1 数据流（当前）

```
ChatPage ── useAgent(sessionId).sendMessage()
   ├─ 构造请求：系统提示词/技能/记忆/附件/token 预算（use-agent.ts 300~940 行的纯逻辑段）
   ├─ 模型流式：ipc.apiChatStream(cfg, body)          [src/lib/api-transport.ts:121]
   │     └─ 主进程 electron/api-proxy.ts 合批分片 → 'apiChunk' 事件推回渲染层
   │        （WebUI 模式走 ipc-client.ts webChatStream → POST /api/chat-stream SSE）
   ├─ 渲染层解析流：parseEvent / flushParserState（use-agent.ts:377~418）
   ├─ ReAct 循环（use-agent.ts:1445）：
   │     ├─ 工具执行：toolRegistry.execute(name, args, ctx)   [use-agent.ts:1872；子 agent :2492]
   │     │     └─ src/lib/tool-registry.ts（1192 行导出单例；执行面大半本就走主进程 IPC）
   │     ├─ 危险命令审批：isDangerousCommand（src/lib/permission-engine.ts）
   │     │     + approvalMode（settings，use-agent.ts:286）→ QuestionCard/确认流（~2076）
   │     ├─ 子 agent：spawn_agent 工具 → ctx.spawnSubAgent → runSubAgent（同文件内第二循环）
   │     │     状态：src/stores/agent-runs-store.ts（runsBySession）
   │     └─ 状态推进：chat-store.setStreaming / setSessionStatus / addMessage / updateMessage
   ├─ 消息持久化：chat-store → db* IPC → electron/db.ts（A3 后为 SQLite）
   └─ 排队消息：chat-store queuedMessages（308~331）+ use-agent flush（1059~1108）
        abort：chat-store.sessionAbortControllers Map（~671，删会话时 abort + 杀 shell）
```

### 2.2 关键耦合点清单（迁移时逐个处理）

| # | 耦合点 | 位置 | 说明 |
|---|---|---|---|
| 1 | React hook 形态 | `useAgent` 内 useState/useRef/useCallback | 逻辑与 React 生命周期绑死 |
| 2 | 会话级 ref 状态 | `use-agent.ts:303~318` | tokenTracker、readFiles 快照、memory 注入标记、taskMode、staticSystemHash |
| 3 | 全局注册表 | `sessionAgentRegistry`（`use-agent.ts:43~53`） | 暴露 manualCompact/getUsage 给 UI |
| 4 | 模型流解析 | `parseEvent`/`flushParserState`（377~418） | 目前在渲染层解析 api-proxy 分片 |
| 5 | UI 耦合工具 | QuestionCard 提问、TodoList、技能提醒、SubAgent 卡片 | 需要"UI 回执"，不能只返回结果 |
| 6 | 权限审批 | `isDangerousCommand` + approvalMode + 确认弹窗 | 迁移后必须**主进程 fail-closed**，绝不能因 UI 不在线而放行 |
| 7 | 排队/abort | chat-store 与 use-agent 各持一半 | 语义要整体搬到宿主侧 |
| 8 | WebUI 双模式 | `ipc-client.ts` 的 webInvoke/webChatStream | 新增 agent 事件通道同样要双模式 |
| 9 | TaskRunHost | `src/components/scheduled/TaskRunHost.tsx:70` | 定时任务也调 sendMessage |
| 10 | chat-store 并发写 | 运行期 renderer 与 host 都可能写库 | 需明确"运行期消息谁写库"（见 §3.3 / P3） |

### 2.3 可复用的既有资产

- **主进程已有能力**：`electron/api-proxy.ts`（startChatStream/abortChatStream，主进程内直调不经 IPC）、`electron/terminal.ts`（node-pty）、`electron/mcp-manager.ts`、`executeCommand` IPC、`electron/webui-server.ts`（SSE 桥 + `/api/invoke` + handlerRegistry monkey-patch，`main.ts:799~806`）。
- **协议参照**：ZCode 的分层协议与 Delivery Profile（`d:\zcode-compare\01-zcode-architecture.md` §5.6~5.8）、权限三段式（fail-closed broker → 协议事件 → UI 纯函数预览）。
- **工程底座**：vitest 92 单测 + CI 门禁（A2）、结构化日志（A1）、SQLite 存储（A3，`electron/db.ts` 的 `ChatStore` 接口可被宿主直接复用）。

---

## 3. 目标架构

### 3.1 进程模型

```
┌─ 主进程
│   AgentHost（新，electron/agent-host.ts）
│     ├─ AgentSession 表：sessionId → 运行态（循环、队列、abort、快照缓冲）
│     ├─ agent-core（新，src/agent-core/：从 use-agent 抽出的纯编排，注入端口）
│     ├─ Ports：ModelPort（直调 api-proxy）/ ToolPort（tool-registry 迁入或桥接）
│     │         / StorePort（直调 ChatStore SQLite）/ PermissionPort / EventSink
│     └─ 事件环形缓冲：每会话最近 N 条事件 + turn 快照，供重连回放
├─ preload：agent:command / agent:event / agent:snapshot 三通道
└─ 渲染进程（纯视图）
      ├─ agent-client（新，src/lib/agent-client.ts）：发指令、订阅事件、断线重连
      ├─ chat-store：消费事件流归并状态（运行期持久化已由宿主完成）
      └─ UI 组件（ChatPage/MessageList/QuestionCard…）：接口不变，数据源换轨
```

**宿主选型决策**：P3 先放**主进程**（最小改动，已能解决 §1.1 全部四个问题；主进程自身崩溃率极低）。utilityProcess 隔离列为后续优化（§7），不在本批次。

### 3.2 事件协议（落地文件 `src/agent-core/protocol.ts`）

```ts
// ── 渲染层 → 宿主（invoke 'agent:command'）──
export type AgentCommand =
  | { type: 'run'; sessionId: string; content: string;
      attachments?: MessageAttachment[]; taskMode?: TaskMode; skills?: MessageSkillSnapshot[] }
  | { type: 'abort'; sessionId: string }
  | { type: 'queue.enqueue'; sessionId: string; item: QueuedMessageItem }
  | { type: 'queue.remove'; sessionId: string; id: string }
  | { type: 'queue.flush'; sessionId: string }          // 立即发送队首
  | { type: 'permission.resolve'; sessionId: string; requestId: string; approved: boolean }
  | { type: 'question.resolve'; sessionId: string; requestId: string; payload: unknown }
  | { type: 'manual.compact'; sessionId: string; instructions?: string }

// ── 宿主 → 渲染层（push 'agent:event'，带单调 seq）──
export type AgentEvent =
  | { type: 'run.started';      sessionId: string; runId: string; ts: number }
  | { type: 'message.added';    sessionId: string; message: Message }   // 落库完成后
  | { type: 'message.updated';  sessionId: string; messageId: string; updates: Partial<Message> }
  | { type: 'stream.delta';     sessionId: string; messageId: string; text: string } // 合批 16~32ms
  | { type: 'stream.ended';     sessionId: string; messageId: string }
  | { type: 'tool.started';     sessionId: string; messageId: string; callId: string; name: string; args: unknown }
  | { type: 'tool.finished';    sessionId: string; callId: string; result: string; isError: boolean }
  | { type: 'permission.requested'; sessionId: string; requestId: string;
      preview: string;   // UI 纯函数渲染命令/文件预览（参照 ZCode permission-request-preview）
      risk: 'dangerous' | 'normal'; mode: 'manual' | 'auto' | 'full' }
  | { type: 'question.requested'; sessionId: string; requestId: string; question: unknown } // QuestionCard
  | { type: 'queue.snapshot';   sessionId: string; items: QueuedMessageItem[] }
  | { type: 'run.status';       sessionId: string; status: 'working' | 'awaiting' | 'idle'; error?: string }
  | { type: 'run.completed';    sessionId: string; runId: string }
  | { type: 'run.aborted';      sessionId: string; runId: string; byUser: boolean }
  | { type: 'subagent.updated'; sessionId: string; run: SubAgentRun }
  | { type: 'usage.updated';    sessionId: string; usage: ContextUsageInfo }

// ── 重连回放（invoke 'agent:snapshot' 或 attach 返回）──
export interface AgentSnapshot {
  activeRuns: Array<{ sessionId: string; runId: string; status: 'working' | 'awaiting' }>
  queue: Record<string, QueuedMessageItem[]>
  pendingPermissions: AgentEvent[]   // 未决审批/提问，重连即恢复弹窗
  lastSeq: number
}
```

**通道约定**：
- Electron：`ipcMain.handle('agent:command')` + `webContents.send('agent:event', {seq, event})`。
  handler 走 patchedHandle → 自动进 handlerRegistry → WebUI `/api/invoke` 直接可用
  （注意 `REMOTE_INVOKE_BLOCKLIST` 不要误封 agent 通道；`run` 允许远程，`permission.resolve` 允许但写审计日志）。
- WebUI：新增 SSE `GET /api/agent/events?since=seq`（复用 webui-server 现有 SSE 封装）。
- **回放语义**：`seq` 缺口即断线；渲染层带 `sinceSeq` 补发；环形缓冲上限 500 条/会话，
  超限回退 `resync` 信号，渲染层整会话重拉 db。

### 3.3 权限 fail-closed（安全红线）

- 宿主执行**任何**副作用工具前先过 `PermissionPort.evaluate`：
  - `full`：危险命令仍被 `isDangerousCommand` 拦截（语义与现状一致，判定移入主进程）；
  - `manual`：发 `permission.requested` 挂起等待 `permission.resolve`，**超时（120s）或 UI 离线 → 默认拒绝**；
  - WebUI 远程审批同语义，审批记录写主进程日志。
- 渲染层只做展示与回执，**绝不能成为放行条件**（ZCode 三段式核心）。


---

## 4. 分阶段实施计划

> 每阶段：独立分支完成 → 全量自检（tsc 双端 + 92 单测 + vite build）→ 冒烟演示 → 提交推送。
> 阶段间保持可回滚；P3 起必须实际演练一次回滚。

### P1 抽核（无行为变化，纯重构）

**目标**：把 `use-agent.ts` 的编排逻辑抽成与 React/进程无关的 `src/agent-core/`，渲染层仍作为宿主，行为等价。

1. 新建 `src/agent-core/`：
   - `protocol.ts`：§3.2 类型（先只落类型与 seq 工具）。
   - `ports.ts`：
     ```ts
     interface AgentPorts {
       model: { stream(body: unknown, onDelta: (t: string) => void, signal: AbortSignal)
                  : Promise<{ finishReason?: string; usage?: TokenUsage }> }   // 包 api-transport
       tools: { definitions(harnessMode: HarnessMode): ToolDefinition[];
                execute(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> }
       store: { getMessages(sid: string): Message[]; addMessage(sid: string, m: Message): void;
                updateMessage(id: string, u: Partial<Message>): void;
                setStatus(sid: string, s: SessionStatus | null): void;
                compact(sid: string, msgs: Message[], beforeId: string): void }
       permission: { evaluate(args: unknown): Promise<{ approved: boolean; preview?: string }> }
       ui: { askQuestion(q: unknown): Promise<unknown>; notify(kind: string): void }  // UI 耦合工具回执
       emit(e: AgentEvent): void
     }
     ```
   - `loop.ts`：搬 ReAct 主循环（`use-agent.ts:1445` 起）+ 提示词构造（300~940 纯逻辑段）
     + 重试（已导出的 `runWithRetry`/`isContextOverflowError` 等，204~271）
     + 流解析（`parseEvent`/`flushParserState`，377~418）+ doom-loop/compact 衔接。
   - `session-context.ts`：会话级 ref 状态（303~318 的 Map）改为普通类字段。
2. `use-agent.ts` 瘦身为**端口装配器**：把 zustand store、api-transport、toolRegistry、
   QuestionCard 回调接成 ports 后调 `runLoop()`；导出面
   （`sendMessage/abort/manualCompact/isCompacting/error/sendQueuedNow/requestQueuedFlush`，2546 行）保持不变。
3. **验收**：tsc 零错误；92 单测全绿；手动冒烟（发消息/工具/中断/排队/子 agent/定时任务/压缩）
   与改前无差异；`git diff` 中 UI 组件零改动。

### P2 测试加固（给迁移上保险）

1. 假端口测试 `tests/agent-core.test.ts`：
   - 黄金序列：fake model 脚本化响应 → 断言事件序列
     `run.started → message.added → stream.delta* → tool.started → tool.finished → run.completed`。
   - 异常路径：模型 500/超时/PTL 重试、中途 abort、danger 拒绝、question 超时默认拒绝。
   - 排队 FIFO、compact 衔接、doom-loop 截断。
2. P1 搬走的纯函数回归：提示词构造快照测试、`parseEvent` openai/anthropic 分片拼装。
3. **验收**：新增测试 ≥ 40 例，CI 全绿。此后所有阶段以此为回归基线。

### P3 宿主迁移（核心手术）

1. 新建 `electron/agent-host.ts`：
   - `AgentSessionManager`：sessionId → { runId, abortController, queue, pendingPermissions, eventRing, lastSeq }。
   - 端口实现：ModelPort 直调 `startChatStream`（主进程内零 IPC 往返）；
     StorePort 直调 `ChatStore`（**运行期消息由宿主直接落库，渲染层运行期不再写库**）；
     ToolPort 优先把 `tool-registry` 迁入主进程（其执行面大半本就走主进程 IPC，迁移后反而少一跳），
     工作量超预期时允许"主进程执行 + 渲染层回执"桥接过渡（UI 耦合工具回渲染层执行，带超时 fail-closed）。
2. preload 三通道：`agentCommand`（invoke）、`onAgentEvent`（订阅，返回退订函数）、`agentSnapshot`（invoke）。
3. 运行模式开关（回滚保命）：`CLERKBOX_AGENT_HOST=main|renderer`（环境变量或 `clerkbox-kv.json`），
   **P3/P4/P5 期间默认 `renderer`**，P6 才切 `main`。
4. **验收**：开关切 `main` 后 P2 全绿 + 手动冒烟全项通过；切回 `renderer` 立即恢复旧路径（回滚演练必须实做一次）。

### P4 渲染层薄客户端

1. 新增 `src/lib/agent-client.ts`：发命令、订阅事件、指数退避重连、`sinceSeq` 补发、attach 快照。
2. chat-store 改造：运行期状态（streaming/sessionStatus/增量消息）改为消费事件流；
   持久化写路径仅存于 renderer 开关内；`sessionAbortControllers` 降级为 renderer 模式兼容层。
3. UI 接线：QuestionCard/权限弹窗/排队条/SubAgent 卡片改由事件驱动（props 形态尽量不变，只换数据源）。
4. **验收**：P2 全绿 + 手动冒烟；**新增关键验收**：任务运行中 F5 → 重连后任务继续、流式恢复；
   窗口最小化到托盘再恢复，状态一致。

### P5 WebUI / 后台续跑 / 定时任务

1. webui-server 增加 `GET /api/agent/events`（SSE）与 attach 快照；`ipc-client.ts` 增加同款双模式封装。
2. 关窗到托盘：窗口隐藏/销毁不再影响宿主（P3 后天然成立），验证 macOS 关窗场景日志。
3. TaskRunHost 改为薄客户端（定时任务调 `agentCommand run`）。
4. **验收**：浏览器开 WebUI → 发任务 → 关标签页 → 重开回放续看；托盘隐藏期间任务完成并落库。

### P6 切换默认与清理

1. 默认 `main`；renderer 路径保留一个版本号后删除（旧循环、旧 streaming 写路径）。
2. 文档更新（README/.trae/specs 补运行模式说明）；本文件追加实施记录。
3. **验收**：新用户冷启动全功能可用；升级用户历史会话/排队/压缩行为不变。
3. **验收**：新用户冷启动全功能可用；升级用户历史会话/排队/压缩行为不变。

---

## 5. 不可破坏的既有契约（红线清单）

1. **db\* IPC 契约**（`electron/db.ts` handler 名/参数/返回）——WebUI `/api/invoke` 与渲染层都在用。
2. **92 个单测 + CI/release 门禁**必须始终全绿；tsc 双端零错误。
3. **权限 fail-closed**：任何模式下 UI 离线不得放行危险操作。
4. **中断语义**：abort 必须同时停模型流、杀本会话 shell 子进程（chat-store:671 现行为）、清 streaming 状态。
5. **i18n**：不硬编码用户可见文案；新文案补 zh-CN/en 两份。
6. **日志**：宿主侧关键节点用 `console.*`（A1 已落盘），便于诊断导出覆盖。
7. **不 force push**；按阶段分组 Conventional Commits。

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 事件风暴拖垮渲染（delta 高频） | 高 | delta 合批 16~32ms（对齐 api-proxy 现有参数）；`stream.delta` 只带增量文本 |
| 运行期双写数据库导致状态错位 | 高 | P3 起宿主独占运行期写入；渲染层写路径仅存在于 renderer 开关内 |
| 权限弹窗在 UI 离线时悬挂 | 高 | 超时拒绝 + pendingPermissions 进快照，重连恢复 |
| 迁移破坏子 agent / 定时任务 | 中 | P2 黄金序列覆盖 spawn_agent；TaskRunHost 单独冒烟项 |
| seq 回放丢事件 | 中 | 缓冲超限发 `resync` 信号整会话重拉；环形缓冲与 seq 同锁更新 |
| 双模式长期分叉难维护 | 中 | P6 限期删除 renderer 路径；开关只存活一个版本 |
| tool-registry 迁移工作量失控 | 中 | 允许 P3 用"桥接过渡"降级方案，验收标准不变 |

## 7. 后续优化（本批次不做，留接口）

- utilityProcess 独立宿主 + ZCode 式泳道隔离（宿主与主进程崩溃互不影响）。
- 多 agent 并行调度、跨窗口共享宿主。
- 模型轨迹面板（C 系列）直接消费 `agent:event` 流——协议已预留。

## 8. 交付物与验收总表

- [ ] `src/agent-core/`（protocol/ports/loop/session-context）
- [ ] `tests/agent-core.test.ts` 等新增 ≥ 40 例，CI 全绿
- [ ] `electron/agent-host.ts` + preload 三通道 + WebUI SSE
- [ ] `src/lib/agent-client.ts` + chat-store 运行期写路径换轨
- [ ] 运行模式开关与回滚演练记录
- [ ] 手动验收：发消息/工具/中断/排队/子agent/压缩/权限弹窗/定时任务/WebUI 断线重连/F5 续跑/托盘后台
- [ ] 分阶段 commit + push（不合大提交）

---

## 9. 并行协作边界（重要：C/D 批次由另一 agent 同期实施）

本批次 B 与 **C 系列（权限审批 UI、虚拟滚动、错误横幅、工具渲染器）、D（DESIGN.md/字号体系）** 并行开发，两者共享同一 `main` 分支。**改文件前先 `git status`，推送前 `git pull --rebase` 并跑全量测试。**

| 归属 | 独占文件（另一方勿动，确需改动先沟通） |
|---|---|
| **B（本文档实施者）** | `src/hooks/use-agent.ts`、`src/agent-core/**`（新建）、`electron/agent-host.ts`（新建）、`electron/preload.ts`、`electron/api-proxy.ts`、`electron/webui-server.ts`、`src/lib/ipc-client.ts`、`src/lib/agent-client.ts`（新建）、`src/stores/chat-store.ts` 的运行期/streaming 写路径、`src/components/scheduled/TaskRunHost.tsx` |
| **C/D（另一 agent）** | `src/components/chat/**`（MessageList/MessageItem/QuestionCard/工具渲染器）、`src/components/**` 的外观样式、`tailwind.config.ts`、`src/index.css`、`DESIGN.md`（新建）、`src/lib/permission-engine.ts` 的 UI 预览辅助（如 C2 需要） |
| **共享（改动最小化、只追加不重排）** | `src/i18n/locales/*.ts`、`src/types/agent.ts`、`src/stores/chat-store.ts` 非运行期部分、`package.json` |

**接口约定**：C2 权限审批 UI 依赖本协议的 `permission.requested` / `permission.resolve`；C2 可先按协议类型做纯 UI（本期仍走旧渲染层权限路径），B 的 P3 落地后只需换数据源。C/D 不得改动 §3.2 协议字段语义；如需扩展事件字段，以"只增不改"方式追加。


