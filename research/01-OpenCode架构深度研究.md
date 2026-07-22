# OpenCode 项目架构深度研究报告

> 仓库路径：`d:/opencode`；当前版本：`1.18.4`；默认分支：`dev`。本报告基于源码静态阅读，未做任何修改。

## 1. 项目整体架构

### 1.1 Monorepo 结构

OpenCode 是一个由 Bun workspace + Turborepo 管理的 monorepo。根 `package.json` 通过 `workspaces.packages` 声明所有子包，使用 **catalog** 机制统一版本（effect 4.0、solid-js 1.9、@ai-sdk/* 3.0 等）。关键包：

| 包 | 职责 |
|---|---|
| `packages/core` | `@opencode-ai/core` — 领域核心（Session、Agent、Tool、Provider、Permission、Skill、Plugin、Event、Catalog 等），全是 Effect 服务 |
| `packages/opencode` | `opencode` CLI（yargs 入口），`bin/opencode` 真正的可执行入口 |
| `packages/tui` | 基于 `@opentui/solid` 的终端 UI（SolidJS + Ink-like renderer） |
| `packages/app` | 基于 Vite + SolidJS + SolidStart 的 Web/Desktop 应用 |
| `packages/desktop` | Electron 外壳，加载 `@opencode-ai/app` |
| `packages/llm` | `@opencode-ai/llm` — LLM 抽象层，Route/Protocol/Transport/Provider 等 |
| `packages/schema` | 所有 Effect Schema 数据类型，无业务逻辑 |
| `packages/sdk` (js) | HTTP SDK（OpenAPI 生成），`/v2` 是新版 |
| `packages/server` | HttpApi 路由 + handler，把 Protocol 暴露为 HTTP |
| `packages/protocol` | `HttpApi`/`HttpApiGroup` 定义，与 Server 解耦 |
| `packages/plugin` | 对外插件 SDK（v1 + v2/effect），暴露给 TUI 和外部插件 |
| `packages/client` | 给插件用的 generated effect client |
| `packages/codemode` | Rune/code mode 工具 |
| `packages/ui` | 共享 UI 组件、i18n、theme（给 app/tui 用） |
| `packages/web` | Astro 静态官网 |
| `packages/console`, `packages/stats`, `packages/enterprise` | 内部 SaaS / 控制 Plane |
| `packages/slack` | Slack bot |
| `packages/sdk-next` | 实验 SDK，整合 client+core+server |

### 1.2 技术栈

- **Bun 1.3.14** 作为 runtime / 包管理 / 测试；`bunfig.toml` 启用 `minimumReleaseAge = 3 天` 以避免踩坏版本。
- **TypeScript 5.8** + `@typescript/native-preview` (tsgo) 做类型检查（`tsgo --noEmit`）。
- **Effect 4.0 (beta.83)** 是整个后端的核心：所有 `Service`/`Layer`/`Schema`/`Stream`/`Effect.fn` 都基于 Effect。
- **Drizzle ORM** + **SQLite**（`@effect/sql-sqlite-bun` + 自研 `@opencode-ai/effect-drizzle-sqlite`），WAL 模式，存 event log 和 projections。
- **SST 4.13** + Cloudflare/AWS 做云部署（`sst.config.ts` + `infra/`）。
- **SolidJS 1.9** 是 Web/App/TUI 共用的渲染层（patchedDependencies 中有 `solid-js@1.9.10.patch`）。
- **@opentui/solid + @opentui/core** 用于 TUI（Yoga 布局 + 自定义 renderer，类似 Ink 但用 Solid reconciler）。
- **@ai-sdk/\* + @openrouter/ai-sdk-provider + gitlab-ai-provider + venice-ai-sdk-provider** — LLM provider SDK 集合。
- **@modelcontextprotocol/sdk** — MCP 客户端。
- **electron 42 + electron-vite + electron-builder** — Desktop 壳。
- **flake.nix** 提供 Nix 开发环境与构建 overlay。
- **turbo.json** — 极简任务编排，仅声明 `typecheck`/`build` 与几个测试任务的依赖。

### 1.3 顶层配置文件作用

- `turbo.json`：仅声明 `typecheck`/`build`/`test` 任务依赖。
- `bunfig.toml`：固定版本 + 3 天最低发布龄；测试根目录禁止运行。
- `sst.config.ts`：定义 `opencode` app（cloudflare home）+ AWS providers，按 stage 决定是否部署 lake/stats/console。
- `flake.nix`：为 Nix 用户提供 bun/node_20/openssl/git devShell，并 overlay 输出 `opencode`/`opencode-desktop`。
- `.opencode/`：OpenCode 自身使用自己产品的 dogfooding 目录：
  - `opencode.jsonc` — 项目配置（`provider`/`permission`/`mcp`/`tools`/`references`）
  - `agent/` — 自定义 agent（如 `triage.md`）
  - `command/` — slash commands（`commit.md`, `issues.md`, `learn.md` 等）
  - `skills/effect/SKILL.md` — 一个 Skill 示例
  - `plugins/tui-smoke.tsx` — TUI 插件示例
  - `tool/github-triage.ts` — 自定义工具
  - `glossary/`、`themes/`、`env.d.ts`、`tui.json`

## 2. 核心包 `packages/core` 分析

`packages/core/src` 是一个完全用 Effect 重新设计的 V2 体系（与 `v1/` 子目录里旧实现并存，通过 `ConfigMigrateV1` 迁移）。

### 2.1 模块设计与"分层节点"模式

最值得借鉴的设计是 **`effect/layer-node.ts` + `effect/app-node.ts`**（路径：`packages/core/src/effect/`）。它定义了 `Node` 和 `Tag`：

- `tags = LayerNode.tags({ location: ["global"], global: [] })` 声明两类 Layer：`global`（进程级单例）和 `location`（按"工作目录"绑定）。
- `makeGlobalNode` / `makeLocationNode` 工厂把一个 `Layer` + 依赖列表打包成不可变 `Node`。
- `LayerNode.compile(root, replacements)` 在运行时把节点 DAG 编译成一个 `Layer`，可在 `AppNodeBuilder.build` 中替换节点（如把 `SessionExecution.node` 换成 `SessionExecutionLocal.node`）。
- `LayerNode.unbound(Service, tag)` 表示"占位节点"，需要由上层绑定（如 `Location.node` 是 unbound，等 `Location.boundNode(ref)` 注入）。

每个领域模块都遵循统一形态：
1. 在 `*.ts` 中定义 `Interface`（描述服务能力）和 `Service extends Context.Service<Service, Interface>()("@opencode/v2/Xxx")`。
2. 用 `Layer.effect(Service, Effect.gen(...))` 实现。
3. 导出 `node = makeGlobalNode/makeLocationNode({ service, layer, deps: [...] })`，让其他模块通过 `deps` 静态声明依赖。
4. 顶层用 `LayerNode.group([...])` 把所有节点组合，再交给 `AppNodeBuilder.build` 编译。

这种"节点 + 标签 + 替换"机制让 OpenCode 能在 server 中按需替换实现（如把本地执行换成 noop），同时保留类型安全。

### 2.2 各核心模块

- **`session.ts` + `session/`**（`@opencode/v2/Session`）：Session 是顶层聚合服务。`Interface` 暴露 `list/create/get/messages/message/context/events/history/prompt/shell/skill/compact/wait/active/resume/interrupt/revert`。实现通过 `SessionStore`（投影读取）、`SessionExecution`（驱动 runner）、`SessionRunner`（一个 turn 的执行）、`SessionProjector`（事件 → 投影表）协作。Session 自己只做编排，不实现 LLM 调用。
- **`agent.ts`**（`@opencode/v2/Agent`）：维护 `Map<ID, Info>`。`Info` 来自 `@opencode-ai/schema/agent`，含 `model/variant/system/description/mode(primary|subagent|all)/hidden/color/steps/permissions`。`select` 默认选 `build` agent 或第一个非 subagent。Agent 是 `State.Transformable<Draft>` — 支持插件以 draft 形式注册/修改。
- **`tool/`**（见 §3）
- **`provider.ts` / `model.ts` / `catalog.ts`**（见 §5）
- **`permission.ts`**（见 §3.3）
- **`auth`**：不在 core 单独模块，而是通过 `Integration` + `Credential` + `OAuth` 实现（如 `plugin/provider/openai.ts` 中实现 OAuth PKCE + 本地 callback 服务器）。
- **`skill.ts` + `skill/`**（见 §7）
- **`plugin.ts` + `plugin/`**（见 §6）
- **`catalog.ts`**：Provider/Model 注册中心。`State.Transformable<Draft>`，draft 暴露 `provider.update/remove` 和 `model.update/remove/default.set`。`finalize` 时根据 `Policy` 过滤掉 deny 的 provider。`projectModel` 把 provider-level 和 model-level 的 `api/request` 合并。`available()` 过滤掉没凭据也没 integration 的 provider。
- **`event.ts`**（`@opencode/Event`）：事件总线。`publish` 把 durable event 写 SQLite `EventTable` + PubSub 广播；`subscribe`/`all`/`durable` 暴露 Stream；`project` 让 `SessionProjector` 等订阅者单独投影；`readAggregate` 按 manifest 读取聚合事件流；`replay/replayAll/claim/remove` 支持 durable replay。
- **`database/`**：SQLite + Drizzle，`makeGlobalNode` 在 layer 中执行 PRAGMA（WAL/foreign_keys 等）+ `DatabaseMigration.apply`。
- **`location.ts`** + **`location-service-map.ts`**：Location 是 location-scoped 服务的"钥匙"。`Location.node` 是 `unbound`，由 `boundNode(ref)` 在打开某工作目录时绑定。`LocationServiceMap` 维护 `Map<LocationRef, Layer>`，让同一进程能同时承载多个 location-scoped runtime（如多目录 server）。
- **`system-context/`**：把 system prompt 拆成多个可独立刷新的 `Source<A>`（如 `core/environment`、`core/date`、`core/skills`、`core/references`），用 `SystemContext.combine` 组合。每个 source 有 `baseline`（首次注入）和 `update`（增量更新）两个文本生成器，配合 `SessionContextEpoch` 做"上下文版本化"——LLM 看到的 system baseline 与一次 turn 内的"update"分开，便于压缩和回放。
- **`snapshot.ts`**：基于 git tree 的内容寻址快照系统，支持 `capture/files/diff/preview/restore/checkout`，用于 revert/undo。
- **`session/compaction.ts`**：上下文溢出时的总结器，使用模板让 LLM 产出结构化 Markdown 摘要。
- **`session/runner/llm.ts`**：SessionRunner 的核心，一个 provider turn 的完整流程（见 §4）。
- **`aisdk.ts`**：把 `@ai-sdk/*` 集成进 V2 的桥接层，通过 `hook.sdk` / `hook.language` 让插件能在创建 SDK 实例时介入（如 Anthropic 插件注入 beta header）。

### 2.3 `packages/opencode` 与 core 的关系

`packages/opencode/src/index.ts` 用 yargs 注册了 ~25 个子命令（`run/serve/mcp/agent/web/pr/session/db/plug/acp/attach/...`）。每个命令通过 `effectCmd({ instance, directory, builder, handler })` 模板声明"是否需要 project instance"和"工作目录解析"，再返回一个 `Effect`。CLI 直接 import `@opencode-ai/core/*` 子路径（如 `core/installation/version`），不经过 server。`opencode serve` 启动 `Server.listen`（Hono + HttpApi），其余命令大多通过 `createOpencodeClient` 调用本地 server。

## 3. 工具系统设计

### 3.1 统一接口 `tool/tool.ts`

`Tool.make(config)` 接受：

```ts
{
  description: string
  input: Schema.Codec<Input, any, never, never>
  output: Schema.Codec<Output, any, never, never>
  structured?: Schema  // 可选：模型看到的结构化输出（可与 output 不同）
  toStructuredOutput?: ({ input, output }) => Structured
  execute: (input, context) => Effect<Output, ToolFailure>
  toModelOutput?: ({ input, output }) => Content[]
}
```

返回的 `Definition` 是一个**不可变空对象**，runtime 通过 `WeakMap<AnyTool, Runtime>` 关联：

- `definition(name)` 懒构建 `ToolDefinition`（含 JSON Schema），按 name 缓存。
- `settle(call, context)` 把 LLM 返回的 `ToolCall` decode → `execute` → encode → 可选 `toStructuredOutput` → 可选 `toModelOutput`（生成模型可见的 text/file content）。
- `withPermission(tool, permName)` 返回带 permission 标签的装饰版本。
- `validateName`：`/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`。

这种"空对象 + WeakMap"模式让 tool 是值类型，可作为 Map key 跨服务传递，而 runtime 状态对外不可见。

### 3.2 工具注册与执行 `tool/registry.ts`

- **`ApplicationTools`**（`makeGlobalNode`）：进程级"已注册工具表"，插件用 `Tools.Service.register({...})` 写入。
- **`ToolRegistry`**（`makeLocationNode`）：location 级，merge `ApplicationTools.entries` + 本 location 的 `local` 注册。`materialize(permissions)` 返回 `Materialization`：
  - `definitions: ToolDefinition[]` — 发给 LLM 的工具 schema 列表。
  - `settle(input) => Settlement` — 执行某个 tool call。
  - 通过 `whollyDisabled(action, rules)` 过滤被 permission 全 deny 的工具。
- **`register`** 使用 `Effect.addFinalizer` 实现 scope-aware 注册：插件 Scope 关闭时自动注销，避免"stale tool call"。
- **`settle`** 还通过 `ToolOutputStore.bound(...)` 把输出存到磁盘（`tool-output/`），返回 `outputPaths`，让大输出不进入 message context。

### 3.3 内置工具 `tool/builtins.ts`

`builtins.ts` 把 12 个内置工具节点组合：`bash/edit/glob/grep/read/write/skill/todowrite/webfetch/websearch/question/apply-patch`。每个工具都是独立的 `makeLocationNode`，依赖 `ToolRegistry.node` 和它需要的 location 服务（如 `BashTool` 依赖 `LocationMutation`、`AppProcess`、`PermissionV2`）。

每个工具文件结构高度一致：
1. `name`、`Input`、`Output`、`description`、可选 `toModelOutput`。
2. `Layer.effectDiscard` 中 `tools.register({ [name]: Tool.make({...}) })`。
3. `execute` 内部先 `permission.assert({ action, resources, save, sessionID, agent, source })`，再调底层服务。
4. `node = makeLocationNode({ name, layer, deps })`。

### 3.4 权限系统 `permission.ts`

- 数据模型：`Rule = { action: string, resource: string, effect: "allow"|"deny"|"ask" }`，`Ruleset = Rule[]`。
- `evaluate(action, resource, ...rulesets)`：用 `Wildcard.match` 找**最后一个匹配的 rule**，默认 `{ effect: "ask" }`。
- `assert(input)` 流程：
  1. `configured(sessionID, agentID)` 取 agent 的 permissions（缺省 deny-all）。
  2. 若任一 resource 命中 deny → 抛 `BlockedError`。
  3. 合并 `savedRules()`（用户之前选过 "always allow" 的）。
  4. 若任一 resource 是 "ask" → 通过 `events.publish(Event.Asked, request)` 发起询问，`Deferred` 等用户回复。
  5. 用户回复 `once`/`always`/`reject` → `Event.Replied` → `Deferred.succeed` 或 `fail(DeclinedError|CorrectedError)`。
- "always" 会被持久化到 `PermissionSaved` 表，下次同 action+resource 自动 allow。
- 与 agent 解耦：permission rule 存在 agent 上，所以不同 agent 可有不同权限。

这种"event-driven ask + persisted grant"模式值得借鉴：把询问从工具执行中解耦，让 TUI/Web 都能成为 permission UI。

## 4. Agent 与 Session 模型

### 4.1 Session 运行时（`session/runner/llm.ts`）

`SessionRunner` 一个 turn 的完整流程：

1. `getSession(sessionID)` 校验 location 一致（防止跨 location 残留 fiber）。
2. `agents.select(session.agent)` 取 agent（带 `Info`）。
3. `SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)` — 准备 system baseline + 增量 epoch（避免每 turn 重发完整 system）。
4. `models.resolve(session)` → `Model`（@opencode-ai/llm）。
5. `SessionHistory.entriesForRunner(...)` 加载历史消息。
6. `tools.materialize(agent.permissions)` 得到工具定义集合；若是最后一步（`agent.steps`），把 `toolChoice` 设为 `"none"` 并附 `MAX_STEPS_PROMPT`。
7. 构建 `LLM.request({ model, system, messages, tools, toolChoice, providerOptions })`，其中 `openai.promptCacheKey` 用 session ID 做缓存键。
8. `compaction.compactIfNeeded` 判断是否要先压缩。
9. `snapshots.capture()` 拍当前文件系统快照。
10. `llm.stream(request)` — 启动流式生成。
11. **流处理**：对每个 `LLMEvent`：
    - `providerError`、`assistantText`、`reasoning`、`toolCall`、`step-finish`、`usage` 等通过 `publisher.publish(event, outputPaths)` 串行化写入 `EventV2`。
    - 若是 `toolCall` 且 `providerExecuted === false`：用 `toolMaterialization.settle(...)` 异步执行工具，`FiberSet.run(toolFibers)` 不阻塞流。
    - 工具完成后 `publish(LLMEvent.toolResult(...))` 写回结果。
12. 流结束后 `awaitToolFibers(toolFibers)` 等所有工具完成。
13. 若有 `needsContinuation`（有本地工具调用）→ 回到步骤 1 跑下一个 turn；否则结束。
14. 中断处理：`isUserDeclined` 检查 cause，如果用户拒绝了 permission/question，则停止 loop。
15. 上下文溢出：`isContextOverflowFailure` → 触发 `compaction.compactAfterOverflow` → 用 `TurnTransitionError` 抛出，外层 catch 后重新跑 turn。

设计要点：
- **Durable 优先**：每个 LLM event 都即时写 SQLite，所以"中断恢复"= 读 event log 重建 projection。
- **Tool 并行**：工具执行用 `FiberSet`，不阻塞流；但 `publisher.publish` 用 `Semaphore(1)` 串行化写事件，避免乱序。
- **可中断**：`Effect.uninterruptibleMask` 保护关键段，`Effect.interrupt` 用于跨 location 失效。
- **Agent steps 限制**：到达上限时禁用工具 + 注入 `MAX_STEPS_PROMPT`，让模型自然收尾。

### 4.2 SubAgent / 多 Agent

`Agent.mode` 三种：`primary`（默认顶层）、`subagent`（不在默认列表，被父 agent 调用）、`all`（既可顶层也可被调）。`Agent.selectable` 过滤掉 `subagent` 和 `hidden`。

`.opencode/agent/triage.md` 是 subagent 示例：`mode: primary, hidden: true, tools: { "*": false, "github-triage": true }`，专门用于 GitHub triage。

SubAgent 调用机制：当前 V2 runner 没看到显式的"subagent tool"，更像是通过 permission 配置 + agent 定义让 LLM 选择 agent。`ConfigAgent` 允许在 `opencode.jsonc` 中通过 `agents: { "my-agent": { mode: "subagent", ... } }` 定义。`.opencode/command/commit.md` 中的 `subtask: true` 体现的是 slash command 触发的子任务模式。

### 4.3 消息流与事件系统

- **写入侧**：所有 mutation 都通过 `EventV2.publish(definition, data)`，写 `EventTable`（durable, 有 `seq`）+ PubSub 广播。
- **投影侧**：`SessionProjector` 订阅 `SessionEvent.*`，把 event 应用到 `SessionTable/SessionMessageTable/PartTable` 等"读模型"。这是 **CQRS/Event Sourcing** 模式。
- **读取侧**：SDK 通过 SSE 订阅 `events.durable({ aggregateID: sessionID })`，TUI/App 实时收到增量。
- **回放**：`replay/replayAll` 支持把外部 event log 重放到新机器（用于 share / migrate）。

## 5. Provider 抽象

### 5.1 三层模型

1. **`@opencode-ai/schema/provider`**：纯数据 schema — `Provider.ID/Info/Api(Native|AISDK)/Request/Event` 等。
2. **`packages/core/src/provider.ts`**（10 行）：仅 re-export schema + `MutableInfo` 类型。
3. **`packages/core/src/plugin/provider/*.ts`**（30 个文件）：每个 provider 一个插件，通过 `define({ id, effect })` 注册。如 `anthropic.ts`：
   - 监听 `catalog.transform` 把 `@ai-sdk/anthropic` 的 provider header 加上 `anthropic-beta`。
   - 监听 `aisdk.sdk` 事件，当 `evt.package === "@ai-sdk/anthropic"` 时 `import("@ai-sdk/anthropic")` 并 `createAnthropic(options)`。
4. **`packages/core/src/aisdk.ts`**：`AISDK` 服务通过 `hook.sdk` / `hook.language` 这两个 hook 让插件介入 SDK 实例创建。
5. **`packages/core/src/catalog.ts`**：合并 provider + model 的 `api/request` 字段，处理 `baseURL → api.url` 标准化。
6. **`packages/core/src/models-dev.ts`**：从 `https://models.dev/api.json` 拉取所有 provider/model 元信息（cost/limits/capabilities），5 分钟 TTL 缓存到磁盘。
7. **`packages/core/src/session/runner/model.ts`**：把 catalog `ModelV2.Info` 转成 `@opencode-ai/llm` 的 `Model`，目前只支持三种 route：`OpenAIResponses.route`、`AnthropicMessages.route`、`OpenAICompatibleChat.route`。

### 5.2 LLM 抽象层 `packages/llm`

`DESIGN.md` 明确了"四层渐进式 API"：`generate/stream` → `generateTurn/streamTurn` → 自定义 model defaults → authoring providers。关键概念：

- **`Route<Body, Prepared>`**：一个 provider 协议的完整描述 — `id/provider/protocol/endpoint/auth/transport/framing/defaults/body`。`Route.model(input)` 生成可执行 `Model`。
- **`Protocol<Body, Frame, Event, State>`**：协议层（如 OpenAI Chat、Anthropic Messages、OpenAI Responses），负责 body 构造、stream 解码。
- **`Transport`**：HTTP / WebSocket；`Framing`：SSE/NDJSON；`Auth`：bearer/header/value/none。
- **`LLMClient`** Service：`prepare/stream/generate`。`stream(request)` 返回 `Stream<LLMEvent, LLMError>`，事件包括 `text-delta/reasoning-delta/tool-call/tool-result/usage/step-finish/provider-error`。
- **`generateObject`**：通过强制一个 synthetic tool call 来获得结构化输出，避免 provider-native JSON 模式的不一致（非常值得借鉴的设计）。

### 5.3 配置格式 `opencode.jsonc`

见 `packages/core/src/config.ts` 和 `customize-opencode.md`。关键字段：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-6",
  "default_agent": "build",
  "share": "manual|auto|disabled",
  "autoupdate": true|false|"notify",
  "snapshots": true,
  "permissions": [{ "action": "edit", "resource": "*.env", "effect": "deny" }],
  "agents": { "my-agent": { "mode": "subagent", "steps": 5, ... } },
  "mcp": { "servers": { "name": { "type": "local", "command": ["..."], "timeout": {...} } } },
  "skills": ["./.opencode/skills", "https://example.com/skills/"],
  "commands": { "name": { "description": "...", "model": "...", "subtask": true } },
  "instructions": ["AGENTS.md"],
  "references": { "effect": { "repository": "github.com/...", "description": "..." } },
  "plugins": ["pkg-name", { "package": "pkg", "options": {} }],
  "providers": { "openai": { "models": { "gpt-4": { ... } } } },
  "experimental": { ... }
}
```

配置加载流程（`config.ts`）：
1. 从 `global.config`（`~/.config/opencode/opencode.json`）开始。
2. 从 `location.directory` 向上搜索 `.opencode/`、`opencode.json(.c)` 直到 `project.directory`。
3. 越靠近 cwd 的优先级越高（`toReversed()`）。
4. V1 配置会被 `ConfigMigrateV1.migrate` 转换。
5. 通过插件（`ConfigAgentPlugin`、`ConfigSkillPlugin`、`ConfigProviderPlugin` 等）把 config 应用到 `Agent/Skill/Catalog/...` 各 service。

## 6. MCP 与 Plugin 支持

### 6.1 MCP

- 配置 schema：`packages/core/src/config/mcp.ts` 定义 `Local`（`command + cwd + env + timeout`）和 `Remote`（`url + headers + oauth`）。
- MCP 客户端：`packages/opencode/src/cli/cmd/mcp.ts` 用 `@modelcontextprotocol/sdk` 的 `Client + StreamableHTTPClientTransport`，OAuth 走 `McpOAuthProvider`。
- CLI 子命令：`mcp add/list/remove/auth/login/logout/transport`。
- MCP 工具被自动转换成 OpenCode 工具（通过 V1 MCP runtime；V2 中 TODO 表明还未完全迁移）。

### 6.2 Plugin 系统

#### 6.2.1 V2 插件（`packages/core/src/plugin/`）

- `PluginV2.Service` 接口：`add(id, effect)` / `remove(id)` / `wait(id)`。
- `add` 用 `KeyedMutex<ID>` 保证同一插件串行加载，`Scope.fork(scope)` 给每个插件独立 scope，加载失败 `Scope.close(child, exit)`。
- `PluginHost.make(service)` 返回 `PluginContext`，暴露：
  - `agent/catalog/command/integration/reference/skill` 的 `transform(reload)` 让插件改这些 service 的 draft。
  - `aisdk.sdk/language` hook 拦截 SDK 实例创建。
  - `plugin.add/remove` 支持插件加载插件。
  - `provider.tool.register({...})` 注册工具。
- 内置插件（`plugin/internal.ts`）：`ConfigReferencePlugin`、`AgentPlugin`（定义 build/explore/compaction/title 等内置 agent）、`CommandPlugin`、`SkillPlugin`（注入 customize-opencode skill）、`ModelsDevPlugin`（从 models.dev 拉数据填 catalog）、`ConfigAgentPlugin`/`ConfigSkillPlugin`/`ConfigProviderPlugin`/`ConfigExternalPlugin`（从 config.jsonc 应用配置）、`VariantPlugin`、所有 `ProviderPlugins`（30 个 provider 注册插件）。

#### 6.2.2 V1 插件（`packages/plugin/`，对外 SDK）

`packages/plugin/src/index.ts` 导出 `Plugin = (input: PluginInput, options?) => Promise<Hooks>`，`Hooks` 包含 `tool/registerTool/auth/toolPermission/postMessage/onFinish/...`。`tool.ts` 用 Zod 定义 `tool({ description, args, execute })` — 与 V2 Effect Schema 版本并存。

V2 的 `@opencode-ai/plugin/v2/effect` 是新的 Effect-native 插件契约，通过 `PluginContext` 暴露全部 service 能力。

### 6.3 动态加载

`ConfigExternalPlugin` 处理 `opencode.jsonc` 中的 `plugins: [...]`：通过 `Npm` service 安装 npm 包，`import()` 加载，调用其 `effect(ctx)`。`PluginV2.add/remove/wait` 让插件可热加载、热卸载。

## 7. Skill 系统

### 7.1 设计（`packages/core/src/skill.ts`）

- `Source` 三种：`DirectorySource`（本地路径）、`UrlSource`（远程 URL，通过 `SkillDiscovery.pull` 拉取）、`EmbeddedSource`（内置）。
- 加载流程：`load(source)` → `fs.glob("{*.md,**/SKILL.md}")` → 读文件 → `ConfigMarkdown.parseOption` 解析 frontmatter → `Frontmatter { name, description, slash }` → 返回 `Info { name, description, slash, location, content }`。
- `list()` 用 `Map<name, Info>` 去重，最后按 name 返回。
- `available(skills, agent)` 用 `PermissionV2.evaluate("skill", name, agent.permissions)` 过滤。
- `SkillPlugin`（`plugin/skill.ts`）注册 `customize-opencode` 内置 skill。

### 7.2 SKILL.md 格式

```markdown
---
name: effect
description: Work with Effect v4 / effect-smol TypeScript code in this repo
slash: true  # 是否可作为 slash command
---

# Skill body

任意 Markdown 内容，可以引用同目录下的脚本/文件。
```

### 7.3 Skill Tool（`tool/skill.ts`）

LLM 通过 `skill` 工具按需加载 skill 内容。工具返回 `<skill_content>` XML 包裹的 skill body + 同目录文件列表（最多 10 个），让 LLM 知道还能读哪些辅助文件。

### 7.4 `.opencode/skills/` 约定

- 项目级：`.opencode/skill(s)/<name>/SKILL.md` 或 `.opencode/skill(s)/<name>.md`
- 全局：`~/.config/opencode/skill(s)/<name>/SKILL.md`
- 外部目录自动加载：`~/.claude/skills/`, `~/.agents/skills/`
- 远程：`skills: ["https://example.com/.well-known/skills/"]`

## 8. TUI/App 实现

### 8.1 TUI（`packages/tui`）

- 框架：**`@opentui/solid` + `@opentui/core` + `@opentui/keymap`** — 自研的 TUI 渲染器，用 **SolidJS reconciler** 把 Solid 组件树渲染到终端（Yoga flex 布局 + 自定义 cells）。它不是 Ink，但概念类似。
- 入口：`packages/tui/src/index.tsx` → `app.tsx` 的 `run(input)`。`run` 用 `Effect.gen` + `Effect.acquireRelease` 管理 renderer 生命周期：
  - `createCliRenderer({ useMouse, consoleOptions })`
  - `createDefaultOpenTuiKeymap(renderer)` + `registerOpencodeKeymap`
  - `render(() => <Providers>...</Providers>)` 挂载 Solid 树。
- **状态管理**：纯 SolidJS—`createSignal/createStore/createMemo/createResource`。`context/` 下大量 `createSimpleContext` 工厂包装 `createContext`，每个 provider 注入 `useXxx` hook。
- **SDK 接入**：`context/sdk.tsx` 创建 `createOpencodeClient({ baseUrl, directory })`，通过 SSE 长连接订阅 `sdk.global.event()`，事件按 16ms 批处理 `batch(() => emitter.emit(...))` 防止抖动。
- **路由**：`routes/home.tsx`、`routes/session.tsx` 自定义路由（`RouteProvider`），不是 Solid Router。
- **插件**：`plugin/runtime.tsx` 提供 `createPluginRuntime()`，通过 `Slot` API 让 TUI 插件能注入组件、注册命令、注册路由。
- **键位**：`keymap.tsx` + `@opentui/keymap` 提供模式化键位（modal/insert/normal 等）。

### 8.2 Web/Desktop App（`packages/app` + `packages/desktop`）

- 框架：**Vite + SolidJS + SolidStart Router + TanStack Query**。
- UI 库：`@opencode-ai/ui`（共享组件，Tailwind 4 + Kobalte + corvu/drawer）+ `@opencode-ai/session-ui`。
- 状态管理：纯 Solid + `@tanstack/solid-query` + `@solid-primitives/storage`。
- 入口：`app.tsx` 组装多层 Provider（`ServerProvider/SDKProvider/SettingsProvider/TabsProvider/CommandProvider/...`），用 `@solidjs/router` 定义 `/:serverKey/:id`、`/new-session` 等路由。
- 多服务器：`TargetServerRoute` + `x-opencode-directory` / `x-opencode-workspace` header 支持同时连多个 server，包括 WSL 远端。
- Desktop：`packages/desktop` 是 Electron 外壳（`electron-vite` + `electron-builder`），main process 启动一个本地 `opencode serve` sidecar，渲染进程加载 `@opencode-ai/app` 的 Vite 产物。集成 auto-updater、context-menu、window-state、deep links、IPC、WSL sidecar。

### 8.3 Server / HTTP API（`packages/server` + `packages/protocol`）

- 用 Effect 的 `HttpApi`/`HttpApiGroup`/`HttpApiBuilder`，OpenAPI 自动生成 `/openapi.json`。
- `packages/protocol/src/api.ts` 把 17 个 group（`Health/Location/Agent/Session/Message/Model/Provider/Integration/Credential/Permission/FileSystem/Command/Skill/Event/Pty/Question/Reference/ProjectCopy`）合成一个 `HttpApi.make("server")`，加 `Authorization` + `SchemaErrorMiddleware` 中间件。
- `packages/server/src/routes.ts` 把 `applicationServices` 节点组（Database/Event/Credential/Session/...）编译，提供 `handlers/sessionLocationLayer/authorizationLayer`，最后 `HttpRouter.toWebHandler` 转 Node.js handler。
- 中间件 `LocationMiddleware` 从 `x-opencode-directory` header 解析 location，给每个 location-scoped 请求"挂载"对应的 location runtime（来自 `LocationServiceMap`，按需懒构建）。

### 8.4 SDK（`packages/sdk/js`）

- `gen/` 是 OpenAPI 生成的 client/types/sdk.gen。
- `createOpencodeClient({ baseUrl, directory })` 注入 `x-opencode-directory` header + 拦截器（错误包装、HTML 响应拒绝）。
- `createOpencodeServer()` 是 in-process server（用于嵌入式场景，如 Desktop sidecar、CLI `opencode run` 非交互模式）。
- `v2/` 是新版（与 V2 core 对齐）。

## 9. 可借鉴的设计模式

### 9.1 给 AI Coding Agent 项目的参考

1. **LayerNode DAG + 标签替换**（`packages/core/src/effect/layer-node.ts`）：把 Effect `Layer` 提升为可声明的节点，依赖关系静态类型检查（`Missing<...>` 类型推导），运行时可替换。比手写 `Layer.provide` 链清晰得多。
2. **CQRS + Event Sourcing for Session**：所有变更走 event log，projection 表只读。原生支持中断恢复、share、replay、多客户端订阅。
3. **`State.Transformable<Draft>` 模式**：插件能以"事务性 draft"修改 service 状态，scope 关闭自动回滚。比传统 "register callback" 模型更适合插件化。
4. **SystemContext 可组合 source**：把 system prompt 拆成多个独立 source（env/date/skills/references），每个有自己的 baseline/update 文本生成器，配合 epoch 实现"上下文版本化"。
5. **Tool = 不可变值 + WeakMap runtime**：让 tool 定义可作 Map key、可被 `withPermission` 装饰而不污染原对象。
6. **Scope-aware 工具注册**：插件 Scope 关闭时自动注销工具，避免 stale tool call。
7. **Permission = event + persisted grant**：询问通过 event 暴露给任意 UI（TUI/Web/CLI），用户选 "always" 持久化到 DB。
8. **`generateObject` 用强制 tool call**：避免 provider-native JSON 模式差异，行为统一。
9. **Provider 作为插件**：每个 provider 一个独立 `define({ id, effect })`，按需 `import()` npm 包，避免启动时全加载。
10. **catalog 的 `projectModel` 合并**：provider-level 和 model-level 的 api/headers/request 字段透明合并，normalize `baseURL → api.url`。
11. **Durable prompt admission**：用户输入先 `SessionInput.admit`（写 event log），再 `execution.wake` 触发 runner。即使 runner 没启动，prompt 也不会丢。
12. **ToolOutputStore bound**：大输出写磁盘，message 中只保留引用 + 摘要，避免上下文爆炸。
13. **`MAX_STEPS_PROMPT` + 末步禁用工具**：让 agent 自然收尾而不是被硬截断。
14. **Snapshot 用于 revert**：基于 git tree 的内容寻址快照，支持选择性 restore/checkout。
15. **`models.dev` 外部元数据源**：cost/limits/capabilities 不写死在代码，从社区维护的 JSON 拉。
16. **MCP 集成**：MCP server 自动转工具，OAuth 流程统一。

### 9.2 给 Electron + React 桌面 AI 助手的参考

1. **Sidecar 模式**：Electron main 启动本地 `opencode serve`，渲染进程通过 HTTP/SSE 通信—这样核心逻辑与 UI 完全解耦，CLI/Web/Desktop 共享同一后端。
2. **多服务器/多目录**：`x-opencode-directory` header + `LocationServiceMap` 让一个 server 进程能同时承载多个工作目录的会话，UI 用 server key 路由。Electron 多 tab 场景直接复用。
3. **Effect 作为后端运行时**：类型安全的 service/layer/schema 体系，对异步、错误、并发有原生支持。如果项目规模较大，比手写 Promise 链可维护得多。
4. **SolidJS + Vite**：OpenCode 的 Web 和 TUI 都用 Solid，同一套组件思路（@opencode-ai/ui 共享）。React 项目可借鉴 `createSimpleContext` 模式（封装 `createContext + useXxx`）。
5. **TUI 的 Solid reconciler 思路**：如果需要终端 UI，`@opentui/solid` 证明 Solid reconciler 可以驱动非 DOM renderer。
6. **SDK 双版本（v1/v2）共存**：通过 `gen/` 自动生成 + 手写 wrapper，新功能走 v2，老插件走 v1，平滑迁移。
7. **Deep link + IPC + WSL sidecar**：Desktop 支持 `opencode://` 深链、IPC 跨进程、WSL 远端 sidecar—这些是 Windows 跨子系统场景的标准做法。
8. **Config 优先级与发现**：从 global → 向上搜到 project root，越近越优先，支持 `.opencode/` 目录聚合（agent/command/skill/plugin/tool/theme/glossary）—这种"分层 + 目录约定"配置模型对桌面应用也适用。
9. **可观测性**：`observability/otlp.ts` + `@effect/opentelemetry` + Sentry，进程级 trace + error 上报，是生产级桌面应用的标配。
10. **SessionProjector 模式**：event → 多张读模型表（SessionTable/SessionMessageTable/PartTable），让 UI 查询永远走索引好的投影表而不是 event log。

---

## 总结

OpenCode 是一个**高度模块化、Effect-native、CQRS 架构**的 AI Coding Agent 平台。其核心设计哲学可归纳为：

1. **一切皆 Effect Service**：每个领域概念都是 `Context.Service + Layer + Node`，依赖关系静态类型化，运行时可替换。
2. **Durable-first**：Session/Message/ToolCall/Permission 全部走 event log → projection，天然支持中断恢复、share、replay、多客户端。
3. **插件化一切**：Provider、Agent、Skill、Command、Tool、Permission 都可被插件（V1 函数式 / V2 Effect）扩展，通过 `State.Transformable<Draft>` 提供事务性修改。
4. **多端共享后端**：CLI/TUI/Web/Desktop 通过同一个 HTTP/SSE server 通信，SDK 自动生成，UI 可换。
5. **配置即代码**：`opencode.jsonc` + `.opencode/` 目录约定 + V1 自动迁移，让用户深度定制。
6. **渐进式 API**：LLM 层从 `LLM.stream` 到 `Route + Protocol + Transport` 四层渐进，普通用户简单用，高级用户能替换每个环节。

代码组织高度一致（每个模块都是 `Interface + Service + layer + node` 四件套），但学习曲线不低—需要熟悉 Effect 的 `Layer/Context/Schema/Stream/Effect.fn` 概念。对于想构建生产级 AI Agent 项目的团队，**LayerNode DAG、CQRS Session、SystemContext epoch、Tool WeakMap runtime、Permission event-driven ask** 这五个设计最值得参考。
