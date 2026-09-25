# ClerkBox 批次 C：聊天体验强化实施计划（C2~C5）

> 目标读者：实施 C 系列的 AI/工程师。与批次 B（`AGENT_RUNTIME_MIGRATION_PLAN.md`，Agent 运行时迁移）
> 并行开发，共享 `main` 分支。**改文件前 `git status`，推送前 `git pull --rebase` + 全量测试。**
> 行号锚点基于 commit `744338d`，实施时以符号搜索为准。
>
> 对标来源：`d:\zcode-compare\02-zcode-uiux.md`（ZCode UI/UX 借鉴清单 #4/#7/#8/#11/#14）。

## 范围与顺序建议

| 子批次 | 内容 | 规模 | 顺序 |
|---|---|---|---|
| C4 | 结构化错误横幅 | 小 | ① 最先（见效快、零依赖） |
| C2 | 权限审批三段式 UI | 中 | ②（UI 先行，B 落地后换数据源） |
| C5 | 工具调用专属渲染器 | 中 | ③ |
| C3 | 消息列表虚拟滚动 | 中大 | ④ 最后（性能敏感、需实测） |

---

## C4：结构化错误横幅

### 现状
- 错误显示是两处内联 div：`src/components/chat/ChatPage.tsx:134`（桌面）与 `:158`（移动分支），
  `role="alert"` + 纯文本，无分类无操作。
- 错误源：`useAgent` 的 `error` state（现属 `src/agent-core/` 端口装配，原 `use-agent.ts:315`）。
- **已有错误分类可复用**：`src/agent-core/loop.ts` 的 `isContextOverflowError`（:183）、
  `isRetryableError`（:191）、`extractRetryAfterMs`（约 :214）——直接消费，不重复实现。
- A1 已把错误落盘（`%APPDATA%\clerkbox\logs\main.log`），可联动。

### 目标设计（参照 ZCode ChatErrorBanner）
新建 `src/components/chat/ChatErrorBanner.tsx` 替换两处内联 div：

1. **错误分类 → 错误码**：`rate_limit` / `auth` / `context_overflow` / `network` / `retryable` / `unknown`，
   按码 i18n（新命名空间 `chat.error.*`，zh-CN/en 双份）。
2. **操作区**：
   - `context_overflow` → 「立即压缩」（调 `manualCompact`，现有能力）；
   - `rate_limit`/`network` → 「重试」（重发最后一条用户消息）+ `retryAfterMs` 倒计时；
   - `auth` → 「去设置」直达 API 页（`pendingSettingsTab` 现类型仅 `'account'|'mcp'`，
     `settings-store.ts:12`，需扩联合类型）；
   - 全部错误 → 「复制诊断」（错误码 + 时间戳 + 摘要入剪贴板，联动 A1 诊断导出提示）。
3. **视觉**：`bg-md-error/10 border-md-error/20 text-md-error` 语义（对齐 SkillStore.tsx:723 模式）；
   vibe 分支降级白色半透明底（消除现有两分支样式差异）。

### 验收
- [ ] 断网 / 错误 key / 超长上下文 / 429 四类错误各显示正确码与操作按钮
- [ ] 两处内联 div 删除仅剩单一组件；i18n 双语；92 单测 + tsc 全绿

---

## C2：权限审批三段式 UI

### 现状
- **判定层（两道）**：渲染层 `src/lib/permission-engine.ts`（42 行、26 条 `DANGEROUS_PATTERNS`，
  已有 36 例单测）；主进程兜底 `electron/main.ts:1350` `checkDangerousCommand`。
- **档位**：`approvalMode: 'manual'|'auto'|'full'`（`src/types/agent.ts:279`），默认 `'auto'`
  （`settings-store.ts:39`），旧版迁移回落 manual（:238）。
- **选择 UI**：`ChatInput.tsx` 约 1765~1785 审批档位菜单（`chat.approval*`）。
- **确认流转**：原 `use-agent.ts:2076`，现属 `src/agent-core/`（B 独占区）。
- **B 协议依赖**：B 文档 §3.2 `permission.requested`/`permission.resolve` + §3.3 fail-closed。

### 目标设计
1. **新组件 `PermissionCard.tsx`**（对话流内卡片）：风险图标 + 等宽命令原文（可横滚）+ 来源工具名
   + 三按钮「拒绝 / 本次允许 / 本会话始终允许」。
2. **纯函数预览**：新增 `src/lib/permission-preview.ts`，从工具 input 提取可读命令/文件预览
   （参照 ZCode permission-request-preview；纯函数，**单测 ≥ 8 例**）。
3. **颜色语义**：`ask`（待审批）/ `confirmation`（危险）两组 token——**由批次 D 定义**，
   C2 只消费；D 未落地前用 `md-error` 现有值占位，收敛在一处常量便于替换。
4. **两阶段数据源**：
   - 阶段一（当前）：仍走渲染层现有确认流，只换 UI，行为不变；
   - 阶段二（B P3 后）：改订阅 `permission.requested` + 发 `permission.resolve`，
     超时/离线由宿主 fail-closed，C 侧只展示「已超时拒绝」态。
5. 审批结果以可折叠 system 行插入对话流（轻量审计留痕）。

### 验收
- [ ] manual 危险命令出卡片：拒绝 → 工具返回被拒；允许 → 执行
- [ ] full 档危险命令仍被两道拦截；auto 档不回归
- [ ] permission-preview 单测 ≥ 8 例；换数据源时组件 props 接口不变

---

## C5：工具调用专属渲染器

### 现状
- 工具结果渲染集中在 `src/components/chat/MessageItem.tsx`：折叠壳（展开明细 grid-rows 过渡，约 :184）
  + 通用 `toolPreview` i18n 命名空间（如 `toolPreview.executionFailed`，:182）。
- 已有专属渲染先例：`spawn_agent` → `SubAgentCard` + `SubAgentDetailPanel`——模式可行，只是未泛化。
- 工具全集定义在 `src/lib/tool-registry.ts`（单例 :1192）。

### 目标设计
1. **resolver 架构**（参照 ZCode `ToolCallBlocks/renderers/resolveRenderer`）：
   - 新建 `src/components/chat/tool-renderers/`：`resolveRenderer.ts`（工具名 → 渲染器注册表，
     miss 走通用回退）+ `ToolShell.tsx`（统一折叠壳/状态角标/耗时，复用现有折叠交互）；
   - 渲染器签名 `(props: { call, result, isError, args }) => ReactNode`，**lazy import 控制包体**。
2. **首批渲染器**（按 tool-registry 高频优先）：
   | 工具 | 渲染要点 |
   |---|---|
   | `execute_command` | 等宽命令块 + exitCode 角标 + stdout 前 20 行预览 + 复制 |
   | `read_file` | 路径头部 + 行号区间 + 内容代码块（复用现有 markdown 高亮） |
   | `write_file` | 路径 + diff 角标（增删行数，MessageItem :180 已有 diff meta 先例） |
   | `edit_file`/patch | 内联红绿 diff，可折叠 |
   | `web_search` | 标题 + snippet + 外链图标 |
   | `web_fetch` | URL + 字节数 + 正文折叠 |
   | `mcp__*` | 服务器徽标 + 工具名 + 结果 JSON 折叠 |
   | `spawn_agent` | 接入 SubAgentCard 统一入口 |
3. **通用回退**：未注册工具走 MessageItem 现有渲染，行为逐像素不回归。

### 验收
- [ ] 各渲染器流式未齐时显示骨架态；isError 显示错误角标
- [ ] 注册表 miss = 原路径；为 C3 虚拟滚动预留（纯展示组件，无滚动容器假设）

---

## C3：消息列表虚拟滚动

### 现状
- `src/components/chat/MessageList.tsx:174`：`groupIntoTurns`（:22）→ `TurnPanel` memo（:96）→ 全量渲染；
  滚动靠 `scrollRef` + `bottomRef.scrollIntoView`（rAF 节流 :176~214）、「回到底部」悬浮（:216+）、
  `THRESHOLD` 粘底判定。长会话全量 DOM 是主要卡顿源。

### 目标设计
1. **依赖**：`@tanstack/react-virtual`（**新依赖，需用户批准后 install**）。
2. **按 turn 虚拟化**（粒度 = TurnPanel，避开单条消息的行高测量地狱）：
   - `useVirtualizer` 包裹 turns；估算行高 + `measureElement` 动态修正；
   - 粘底语义保留：`isNearBottomRef` 改用 `scrollToIndex('end')`；
   - **流式尾部隔离**：正在流式的最后一 turn 永不回收，防打字闪烁；
   - **滚动记忆**：按 sessionId 记忆 offset（参照 ZCode chatSessionScrollMemory）；
   - TurnPanel memo 边界不动，虚拟化只改容器层。
3. **降级**：turn 数 < 30 走原有全量渲染路径，小会话零风险。

### 验收
- [ ] 1000+ 消息长会话滚动无长帧；粘底/回到底部/流式跟随/折叠/切会话记忆全部与现状一致
- [ ] react-virtual 体积增量（~5KB gzip）可解释

---

## 共享红线与协作边界

1. **始终全绿**：92+ 单测、tsc 双端、vite build；i18n 双语。
2. **与批次 B**（详见 B 文档 §9）：B 独占 `use-agent.ts`、`src/agent-core/**`、`electron/agent-host.ts`、
   preload、`ipc-client.ts`、`chat-store` 运行期路径、`webui-server.ts`——C 不改；
   协议字段 `permission.*` 只可**只增不改**。
3. **与批次 D**：颜色 token（ask/confirmation）、字号度量由 D 定义与维护，C 只消费，
   不新增魔法色值。
4. **共享文件**（`i18n/locales`、`types/agent.ts`、`package.json`）只追加、不重排。
5. 每个子批次独立 commit + push；新依赖（react-virtual）单独成 commit 便于回滚。

