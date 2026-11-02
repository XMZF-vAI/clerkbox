# 工作流 UI 对齐 —— 交接说明（新 agent 从这里接手）

> 交接时间：2026-11-02 上午 · 交出方：ZCode 会话 `sess_263ddd6e-af00-40e0-9e61-e2d660d286f5`
> 本文档是**唯一上下文入口**。接手前请先读完 §1~§3，再看 §7 的 checklist。

---

## 1. 项目与总目标

**ClerkBox（CB）** = `D:\ClerkBox - 副本`，Electron + React + TypeScript 的 AI 工作台。
**ZCode** = `D:\ZCode`，开源项目（zai-org/ZCode，v3.17.1），本项目要对标的对象。

用户的总目标（多轮累积）：

> 「我决心功能和 UI 要全面对齐」——重点是**对话界面**，即 **AI 工具调用这一整个循环的 UI/UX**；
> 外加**系统提示词**、**安全机制（权限档位）**、**工作流（动态工作流）**。

已交付的研究报告在 `D:\ClerkBox - 副本\zcode-research\`（6 个文件夹，每个一份 `研究报告.md`）：

| 文件夹 | 内容 |
|---|---|
| `01-chat-tool-loop-ui/` | **最高优先级**：投影架构、行模型、工具卡状态机、审批 UI、时间线三板斧、CB 差距表、P0/P1/P2 计划 |
| `02-dynamic-workflow/` | **本轮相关**：UX→实现对照表、11 个工具、编译器/沙箱/引擎/journal/hole、生命周期、UI 三件套、最小实现清单与分期 |
| `03-system-prompt/` | 分段模块化、builder 管线、工具描述范例、39 条提醒注册表、双层注入防御 |
| `04-permission-security/` | 6 值枚举/4 个 UI 入口、18 级 waterfall、unbash AST、审批链路、危险命令表 |
| `05-agent-loop-tools/` | turn 生命周期、命令队列、7 个工具 hook、4 路结果、3 层压缩、流式协议 |
| `06-ui-ux-shell/` | shell 分层、office/coding 分离、draft 模型、设置注册表、插件市场、i18n |

---

## 2. 仓库当前状态

```
分支 main，工作树干净（仅未跟踪的 .zcode/ release-verify*/ 三个临时目录）
main 相对 origin/main **ahead 4**（未推送，等用户点头）
```

| 提交 | 内容 |
|---|---|
| `eba79f8` | feat(agent): 子代理编排——后台运行、消息续聊与运行控制 |
| `b661d00` | feat(chat): 对话界面对标 ZCode——机制通电与工具卡状态机 |
| `487a099` | docs(research): ZCode v3.17.1 全面对标研究报告合集 |
| `67f5956` | feat(workflow): 工作流一期——脚本编排子代理小队 |

**基线**：73 个测试文件，1199 通过 / 2 跳过；`npx tsc --noEmit` 干净；`npx vite build` ✓；`npm run build:electron` ✓。

**已做但未推送**：以上 4 笔。新 agent **不要推送**，除非用户明确要求。

### 已完成的三块（本轮不必重做）

1. **P0 通电**（`b661d00`）
   - `src/lib/code-highlighter.ts`：加版本号仓库（`getHighlightVersion` / `subscribeHighlightVersion`），`MarkdownContent` 经 `useSyncExternalStore` 订阅（无 setState）；`src/main.tsx` 启动预载 `loadHighlighter()`。
   - `src/components/chat/MessageList.tsx`：A 批滚动引擎重接（`timeline-scroll-anchor` / `timeline-row-height-cache` / `live-tail-split`）。三个加固：意图 TTL 1.2s capture 捕获、following 中不补偿 `shouldAdjustScrollPositionOnItemSizeChange`、scrollTop 写后回读记账；程序化贴底统一走 `bottomRef.scrollIntoView`（live tail 拆分后 `scrollToIndex` 不再等价）。
2. **D 批工具卡状态机**（`b661d00`）
   - 新模块 `src/lib/tool-card-state.ts`（展开态 Map LRU800 + `userTouched`/`autoActed` 守卫 + 纯函数 `resolveToolCardAutoAction`）；`MessageItem.tsx` 的 ToolRow / ToolRunGroup 接线；300ms 延迟卸载；失败态 `title` 挂结果前 500 字。测试 `tests/tool-card-state.test.ts`（13 例）。
3. **工作流一期**（`67f5956`）—— **本轮在其之上做 UI**

---

## 3. 本轮任务（用户原话 + 已批准方案）

用户晨起原话：**「早安，那工作流 UI 呢，就是鱼皮文章里的截图」**

### 3.1 参考物（已下载到仓库，**先看图**）

鱼皮文章：`https://mp.weixin.qq.com/s/RrPXmnkpnjMNY7TNDjFJxw`（《又一个国产版 Codex 神器，也来卷办公了！》）
截图已存 `zcode-research/02-dynamic-workflow/article-screenshots/`：

| 文件 | 文章里的标题 | 内容 |
|---|---|---|
| `09_eval.png` | 验证分组 | `EvalWorkflowSnippet` 试跑分组 |
| **`10_confirm.png`** | **确认工作流** | **本轮主目标之一**：流程图确认窗 |
| **`11_running.png`** | **运行过程** | **本轮主目标之二**：实时看板 |
| `12_done.png` | 体检完成 | 终态 + 产物（Excel 清单） |

**10_confirm.png 逐项**（对着图看，别凭印象做）：
- 顶部行：左「运行此工作流？ {教程库体检：过时信息·死链·矛盾}」，右「6 个阶段」
- 设置行 1：「子代理运行在 [GLM-5.3-Flash 会话模型 ▾]」
- 设置行 2：「最多 `- 14 +` 个子代理同时运行 · = 默认」
- **流程图**：横向。3~4 条水平轨道（泳道），轨道上有圆点站，轨道之间用直角折线连接（fork/join）。左侧一个圆点站 → 折线向右 → 多条并行线 → 中间圆点站 → `>>>` 箭头（表示"还有更多"）
- 流程图**下方**是阶段名一行（未分组 / 批量检测全库链接并分诊 / 分组通读全库文章，提取... / 联网核实过时信息 / ...，超长截断）
- 阶段名**下方**是子代理药丸列（胶囊形，左侧彩色头像圆点 + 名字）：`>_ 脚本`、`扫描员-…`、`链接分诊员`、`verifier`、`confirmer`、`矛盾交…` 等；同一阶段的多枚药丸竖排
- 再下面：「› 显示完整脚本」折叠
- 最后是编号选项：`1. 允许 仅允许这一次` / `2. 本会话内始终允许` / `3. 拒绝` / `4. 描述这个工作流应该怎么改…` + 底部「使用 Tab / 上下键选择，回车确认」+ 右下「确认」按钮

**11_running.png 逐项**：
- 顶部：「工作流运行中 {教程库体检：过时信息·死链·矛盾}」，右「6 个阶段 · 4 个子代理工作中」+ 三个图标按钮
- 同一张流程图，但灯在动：**绿实心=已完成、橙实心=正在跑、空心=未到**
- 阶段名后带计数：「批量检测全库... ⧗1 · 0/1」「分组通读全... ⧗21 · 0/21」「联网核实过时信息 ⧗1」
- 药丸：跑着的右侧带转圈图标，跑完的是实心头像
- 某阶段药丸超过 5 枚 → 底部一行「还有 16 个 ↗」
- 底部左侧一个产物按钮「体检发现的问题」

### 3.2 CB 现状 vs 文章（已逐行核对源码）

| 能力 | 文章 / ZCode | CB 现状 |
|---|---|---|
| 确认时画流程图 | 有（`WorkflowPermissionBlock` + `buildWorkflowTimeline` 因果图，`D:\ZCode\packages\ui\src\WorkflowPermissionBlock.tsx`） | **没有**。`src/agent-core/loop.ts:1090` 的 workflow-script 门在 renderer 模式（桌面默认）走 **Electron 原生弹窗**（`src/hooks/use-agent.ts` 的 `permission.confirm` → `ipc.confirmDialog`），只有标题+正文两行文字；main 模式走对话内 PermissionCard，但只画等宽脚本头 5 行（`src/lib/permission-preview.ts:198`）。**两处都画不出图** |
| 阶段数 / 并发上限 | 「6 个阶段」「最多 14 个」 | 没有 |
| 运行中实时灯 + 药丸 | 有（`D:\ZCode\packages\ui\src\components\workflow-timeline\`，~50 个文件） | **没有**。工作流是**同步执行**，工具调用期间只有骨架屏；结束后才在卡上列步骤状态，阶段只是 `phases.join(' → ')` 一行文字（`src/components/chat/tool-renderers/WorkflowRenderer.tsx`） |

**结论：文章那两张截图，CB 一张都没有。** 昨晚工作流一期只做到「能跑」，UI 停在 v1 步骤列表。

### 3.3 已批准的实现方案（7 步，用户已批）

1. **新模块 `src/lib/workflow-graph.ts`**（静态因果图分析器，纯函数）
   - ZCode 是 TS AST 编译出因果图；CB v1 的脚本是 JS 字符串，没有编译期 → **源码级静态扫描，不执行脚本**
   - 扫 `phase('名称')` → 阶段（声明序）；扫 `agent('名字', prompt)` → 步骤；括号配平定位 `parallel([...])` 数组范围，落在其中的 agent 归为**同一并行组**
   - 输出 `WorkflowGraph { phases[], totalSteps, maxParallel, source:'static' }`
   - **诚实边界**（写进注释与 UI 文案）：条件分支里的 agent 只在字面路径上可见 → UI 标「静态分析」，运行时用**实况覆盖**预览
2. **新组件 `src/components/chat/tool-renderers/WorkflowGraph.tsx`**
   - 纯 DOM + 一层 SVG（只画轨道），无画布库
   - 横向泳道轨道：每阶段一列，站（圆点）+ 相邻阶段正交连线；并行阶段 fork/join
   - 阶段名下挂药丸（头像圆点 + 名字），最多 5 枚 + 「还有 N 个」溢出行
   - 静态态空心站；运行态灯 = 空心(未到)/橙点脉动(在跑)/绿实心(完成)/红实心(失败)，药丸跑着转圈，阶段计数「N · done/total」
   - 头像色按步骤名散列取 `md-primary/success/warning/tertiary`（复用 `src/components/chat/SubAgentCard.tsx` 的 `AGENT_COLORS`），仅作可读性，**无语义**
3. **`src/lib/permission-preview.ts`**：`create_workflow` 分支产出 `graph` → `PermissionPreview` 加可选字段
4. **`src/components/chat/PermissionCard.tsx`**：工作流专用确认卡（标题「运行此工作流？{名字}」+ 右侧「N 个阶段」+ 并行度行 + 流程图 + 「显示完整脚本」折叠 + 沿用现有编号选项列表，**不破坏键盘 1/2/3 + 上下键 + 回车**语义）
5. **把工作流确认搬进对话内**（否则第 4 步永远画不出来）
   - 给 `AgentPorts.permission` 加可选端口 `confirmInChat(request)`
   - 宿主模式已有 `permission.requested` 事件通道可复用
   - renderer 模式补一条本地通道：`src/stores/permission-store.ts` 加本地待批 + promise resolver，`PermissionApprovalCard` 接线
   - loop 的 workflow-script 门优先走 `confirmInChat`，拿不到就退回原生弹窗（**既有门的行为一字不改**）
6. **实时进度通道**
   - `src/lib/workflow-runtime.ts`：宿主端口加 `onProgress(snapshot)`，每步结算后回调
   - `src/lib/tool-registry.ts`：`ToolContext` 加 `onWorkflowProgress`
   - `src/agent-core/loop.ts`：工具 ctx 接上（工具 ctx 在 loop.ts 约 2150 行，`toolCallId: tc.id` 已在其中）→ renderer 模式直写 store；main 模式走 `ports.emit(new 'workflow.updated' 事件)`
   - `src/agent-core/protocol.ts` + `src/lib/agent-reducer.ts` + `src/lib/agent-event-apply.ts`：新事件与补丁（照抄 `subagent.updated` 既有范式）
   - 新 `src/stores/workflow-runs-store.ts`：按 `sessionId + toolCallId` 存快照
7. **`src/components/chat/tool-renderers/WorkflowRenderer.tsx`**：运行中订阅 store 渲染实时看板；结束后渲染终态图 + 保留现有报告/错误/脚本折叠

再加 i18n（en + zh-CN，约 14 键）与测试。

### 3.4 明确不做（避免范围膨胀）

journal 持久化与 resume、后台 run + 完成通知、`EvalWorkflowSnippet`、Amend/hole、SaveWorkflow 复跑、产物（Excel）导出 —— 属 v2/v3，与这两张截图无关。

---

## 4. 关键代码坐标

### 4.1 工作流一期现有实现（本轮要改/扩）

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/lib/workflow-runtime.ts` | ~430 | 校验（`checkWorkflowScript`）、`new Function` 沙箱执行、facade（`agent/parallel/phase/log`）、步骤簿记、`formatWorkflowRunReport`、`encodeWorkflowRunTail`/`parseWorkflowRunTail` |
| `src/lib/workflow-tools.ts` | ~110 | `create_workflow` 工具契约 + 宿主端口桥接（`ctx.spawnSubAgent('general', prompt)`） |
| `src/lib/tool-registry.ts` | — | `WORKFLOW_TOOLS` 注册、`executeWorkflowTool` 分发（app-tool 之后）、`ToolContext` 定义（约 371 行） |
| `src/agent-core/loop.ts` | 2485 | workflow-script 权限门（**1090 行**）、`SUBAGENT_HIDDEN_TOOLS`、`sideEffectingTools`（**2199 行**含 `create_workflow`）、`mainSpawnSubAgent`（**1610 行**）、工具执行 ctx（**2150 行**） |
| `src/agent-core/ports.ts` | — | `AgentPorts`（**200 行**）、`PermissionReason`（已含 `'workflow-script'`） |
| `src/lib/permission-preview.ts` | — | `buildPermissionPreview`；**`create_workflow` 分支在 198 行**（当前：kind generic / risk warning / reasonKey `chat.permission.reasonWorkflowScript` / grantKey `create_workflow:{name}:{脚本 djb2 指纹}`） |
| `src/components/chat/tool-renderers/WorkflowRenderer.tsx` | 108 | 当前只有：phases 一行文字 + 步骤状态行（图标/名字/耗时/摘要）+ 报告 + 脚本折叠 |
| `src/components/chat/tool-renderers/resolveRenderer.ts` | — | `create_workflow: lazy(() => import('./WorkflowRenderer'))` |

### 4.2 审批 UI 现状

- `src/components/chat/PermissionCard.tsx`
  - `ApprovalOptionList`（编号单选列表，1/2/3 直提，上下键移动，回车确认）
  - `PermissionCard`（外壳：风险图标 + 工具 chip + reasonKeys + 等宽 target 块 + 选项）
  - `HostPermissionCard`（宿主模式，数据来自 `usePermissionStore`，可交互）
  - `PermissionApprovalCard`（挂载点：宿主模式用 hostPending；本地模式是**镜像态** `interactive=false`）
- `src/stores/permission-store.ts`：目前**只服务宿主模式**（`open/settle/clearSession`）
- 宿主模式链路：`electron/agent-host.ts` → `permission.requested` 事件 → `src/lib/agent-reducer.ts`（`open-permission` 补丁）→ `src/lib/agent-event-apply.ts`（应用补丁）
- renderer 模式链路：`src/hooks/use-agent.ts` 的 `permission.confirm` → `ipc.confirmDialog`（**Electron 原生弹窗**，两按钮 Cancel/OK）

### 4.3 事件与状态

- `src/agent-core/protocol.ts`：`AgentEvent` 联合类型（`subagent.updated` 是要照抄的范式）
- `src/lib/agent-reducer.ts`：`planAgentEvent(event) → StorePatch[]`（纯函数，可单测）
- `src/lib/agent-event-apply.ts`：把 `StorePatch` 应用到各 store
- `src/stores/agent-runs-store.ts`：`runsBySession` + `useShallow` 订阅范式（**照抄它的订阅写法**，避免流式期间全量重渲染）
- `src/lib/agent-registry.ts`：`general` 子代理 profile（`color: 'green'`、`model: undefined` → **继承会话模型**）
- `src/components/chat/SubAgentCard.tsx`：`AGENT_COLORS` 四色 token（`md-primary/success/warning/tertiary`）

### 4.4 ZCode 参考实现（只抄机制，不抄文件结构）

- `D:\ZCode\packages\ui\src\WorkflowPermissionBlock.tsx` —— 确认窗的**版式与不变量**（表头问句 + 名字 + 右侧阶段数 → 时间线 → 折叠脚本；权限块通常禁止折叠）
- `D:\ZCode\packages\ui\src\components\workflow-timeline\timeline-model.ts` —— `buildWorkflowTimeline`（纯函数模型：stations/rails/arcs/bands）
- `D:\ZCode\packages\ui\src\components\workflow-timeline\WorkflowTimeline.tsx` —— DOM+SVG 渲染（站宽 168 / 站距 24 / 轨道行 24；药丸最多 5 枚 + 「还有 n 个」）
- `D:\ZCode\packages\ui\src\components\workflow-timeline\workflow-geometry.ts`、`stage-lamps.ts`、`roster-model.ts`

---

## 5. 硬约束（违反即返工）

### 5.1 用户明令（verbatim）

> 「都别忘记了，你让他验证的时候，就是你用电脑操控来测试的时候不要让CB乱动，只读就行。」

→ **电脑/CDP 实测期间，CB 只允许读，不允许写任何文件、不允许执行改状态的命令。** 沿用昨晚的做法：任务本身是只读的（如「读两份报告并对比」），事后审计工具行里 `dangerRows` 必须为空。

### 5.2 `AGENTS.md`（项目工作流，顺序不可跳）

需求复述 → **计划审批（未获批不写代码）** → 全量检查 → 效果演示（起 dev 服务器给用户看）→ 推送（**仅用户明确确认后**）。
本轮的计划**已获批准**（见 §3.3），可以直接实现；但**演示后仍要等用户确认再提交/推送**。

### 5.3 `DESIGN.md`（硬约束）

- §5.1 **禁止新增 `text-[Npx]` 任意字号** → 新代码一律 `text-ui-xs / ui-sm / ui-base`（Tailwind 档位见 `tailwind.config.ts:62-68`）
- §5.2 **禁止字面色**（十六进制 / `rgb()`）→ 一律走 token（`md-*` / `dark-*`）
- §5.3 **vibe 模式必须显式考虑**（白色系降级写法见 `DESIGN.md §5.3`）
- §5.4 **新增用户可见文案必须 i18n 双语**（`src/i18n/locales/en.ts` + `zh-CN.ts`）
- §5.5 图标一律 `lucide-react`
- §5.6 透明度用整数档（`/5 /10 /15 …`），禁 `border-x/[0.06]` 这类任意透明度

### 5.4 观感守卫（`tests/chat-timeline-look.test.ts`）

抄机制不抄视觉。既有四条断言（AI 正文占满整列不带底色 / 思考是时间线一行 / chevron 常显 / 折叠头吃掉整行）+ `chat-composer-pinned`（输入框钉底）——**不许破**。

---

## 6. 踩坑清单（会再踩）

1. **批量改 i18n 用 python 插入时，搜索串别带尾逗号** —— 否则产生 `,,` → TS1136 → 22 个测试文件加载失败。上次踩过。
2. **同一个 effect 不要写两遍**；`setTimeout` 必须在 effect 顶层 + cleanup，不能塞进 `setState` 回调里起。
3. **`new Function` wrapper 必须先解构 facade**（`const {agent,parallel,phase,log} = ctx;`），否则裸标识符全挂。
4. **校验器的语法编译要独立于其他诊断跑**（一次给全所有诊断，模型好自修）。
5. **`'[aborted]'` 哨兵要记入 `abortSeen`** 才能归档 aborted（不是 failed）。
6. **harness-modes 守卫测试会抓工具描述里指向 ZCode 工具名的文案** —— CB 里只能写 `create_workflow`，不能写 `CreateWorkflow`。
7. **dev 并发脚本千万别加 `-k`**：`concurrently -k` 会在 `build:electron`（一次性）退出时把 vite/electron 一起杀掉。
8. **Electron 重启前先 `taskkill` 占着 5175 端口的旧 vite**，否则新实例起不来。
9. **node worker 里没有 `fetch` / `WebSocket`** → CDP 驱动要用 `createRequire` + CB 自带的 `node_modules/ws` + `node:http`。
10. **CDP 端口 9223 报拒绝**多半是旧的 `DevToolsActivePort` 残留 → 重启 Electron 带 `--remote-debugging-port=9223`。
11. **子代理并发上限**：并行派 agent 会偶发 "user concurrency limit exceeded" → **原样重试失败的那个**即可成功。

---

## 7. 验证流程（昨晚已跑通，直接复用）

### 7.1 起 dev 环境

```bash
cd "D:/ClerkBox - 副本"
npx concurrently -n build,vite,app \
  "npm run build:electron" \
  "npx vite --port 5175 --strictPort" \
  "npx wait-on http://localhost:5175 && npx cross-env VITE_DEV_SERVER_URL=http://localhost:5175 npx electron . --remote-debugging-port=9223"
```

> **不要加 `-k`**。`build:electron` 是一次性任务，退出即杀全局。

### 7.2 CDP 只读实测

- `http://localhost:9223/json` 拿 target 列表 → `ws://.../devtools/page/<id>`
- `Runtime.evaluate`（带 `userGesture: true`）驱动 DOM；`Page.captureScreenshot` 截图
- 截图存档目录：`C:\Users\admin\.zcode\v2\visualizations\52ecbf1939294bb97e29045ecbb865a96e46b392d75fb93c1759c5dc5d527e97\`
- 昨晚的存证：`workflow-verify.png`（工作流真实编排 3 步 36.5s/49.5s/32.4s，**零危险工具行**）

### 7.3 本轮验收点

1. 确认卡里出现**流程图**（阶段数、泳道轨道、药丸、阶段名）
2. 运行中卡片**灯在动**、药丸转圈、阶段计数在变
3. **零写入 / 零命令工具行**（审计 `dangerRows` 为空）
4. `npm test` 全量绿 + `npx tsc --noEmit` + `npx vite build` + `npm run build:electron`
5. 演示后等用户确认 → 本地提交（**推送仍等用户点头**）

---

## 8. 接手 checklist

- [ ] 读本文档 + `zcode-research/02-dynamic-workflow/研究报告.md`（§1 用户体验全链路、§9 最小实现清单）
- [ ] **看图**：`zcode-research/02-dynamic-workflow/article-screenshots/10_confirm.png` 与 `11_running.png`
- [ ] 读 `src/lib/workflow-runtime.ts`、`src/lib/workflow-tools.ts`、`src/lib/permission-preview.ts`（198 行附近）、`src/components/chat/PermissionCard.tsx`、`src/components/chat/tool-renderers/WorkflowRenderer.tsx`
- [ ] 读 ZCode 的 `D:\ZCode\packages\ui\src\WorkflowPermissionBlock.tsx` 与 `components/workflow-timeline/`（只抄机制）
- [ ] 写 `src/lib/workflow-graph.ts` + `tests/workflow-graph.test.ts`（先纯函数，先测）
- [ ] 写 `WorkflowGraph.tsx` 组件（静态态 → 运行态）
- [ ] 接 `permission-preview.ts` → `PermissionCard.tsx`（确认卡版式）
- [ ] 接确认入对话（`confirmInChat` 端口 + 本地 permission store）
- [ ] 接实时进度（runtime onProgress → ToolContext → loop → store / protocol 事件 → reducer → apply）
- [ ] 接 `WorkflowRenderer.tsx` 实时看板
- [ ] i18n 双语（en + zh-CN）
- [ ] 全量检查 → dev 只读实测 → 演示 → 等用户确认再提交

---

## 9. 记忆档案（跨会话上下文，已落盘）

`C:\Users\admin\.zcode\cli\memories\projects\clerkbox-adba3e74f2a8df67\memory\`

- `MEMORY.md`（索引）
- `clerkbox-workflow-v1-state.md` ← **本轮最重要**：工作流一期实现面、坑、v2/v3 缺口
- `clerkbox-chat-ui-redesign-plan.md` ← 对话 UI 改造进度与差距清单
- `zcode-v317-full-alignment-research.md` ← 研究报告索引
- `zcode-chat-ui-implementation-map.md` ← ZCode 对话 UI 实现地图
- `clerkbox-disk-full-incident-2026-10.md` ← 磁盘满事故（渲染循环真根因）
- `subagent-parallel-dispatch-limits.md` ← 并行派 agent 的坑
