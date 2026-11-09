# 第一阶段检查：UI / UX 与主进程、后端

- 检查日期：2026-11-06。
- 代码基线：`main`，`bf1ea3ed265b718e20e5bafd454b037a901cbb04`。
- 项目版本：3.5.1。
- 本阶段授权：检查 UI 设计、交互体验和主进程/后端；仅做基础验证；详细记录到根目录，记录完成后停止。
- 本阶段不做：业务代码修复、配置/权限变更、依赖升级、生产数据操作、完整打包、浏览器/桌面端完整验收、Git 提交和推送。
- 检查方法：按核心链路定向阅读代码，核对调用方和已有保护；运行现有小范围测试及无文件输出的样式计算。不是逐文件穷举，也不等于全部功能验收通过。

## 1. 结论口径

本轮记录 **17 项有代码证据的问题：UI/UX 11 项，主后端 6 项；其中 P1 5 项、P2 11 项、P3 1 项**。另列待实测风险和 1 次测试日志警告，不混入已确认问题数量。

基础验证结果：**两套 TypeScript 检查通过，12 个测试文件的 132 个用例通过**。仅新增本报告，未实施修复；“检查完成”不代表这些问题已经解决，也不代表实际 UI 已验收。

| 优先关注 | 直接影响 |
|---|---|
| UI-06：审批焦点与提交目标不一致 | 拒绝意图可能变成允许 |
| BE-01：远程能力黑名单缺口 | 持 token 调用方越过预期本机能力边界 |
| BE-04：跨会话事件序号域不一致 | 消息、运行状态、审批卡漏更新 |
| BE-03：压缩与新运行并发 | 新消息被旧快照覆盖 |
| BE-02：数据库降级再恢复 | 两份历史分叉，正常界面无法完整呈现 |

优先级：P1 = 应优先处理的数据/权限或核心流程问题；P2 = 明确影响操作正确性、反馈或可访问性；P3 = 视觉一致性、维护性或低频体验改进。证据等级分别写明“静态确认”“计算验证”“测试观察”；没有实际启动 UI 的项目，不写成实测复现。

建议保持既有 Material 3 主题和组件体系，不先做全站换皮。优先修复有明确触发条件的问题，再处理字号、间距和信息密度；不要为了少点一步而减少必要审批，也不要用新增架构代替局部修复。

## 2. UI / UX 检查明细

### UI-01 · P2 · 暗色主题危险按钮文字对比度不足

- **证据等级：静态确认 + 计算验证。**
- **位置：** [ConfirmDialog.tsx:119-122](src/components/ui/ConfirmDialog.tsx#L119)、[McpSection.tsx:562](src/components/settings/McpSection.tsx#L562)、[theme-engine.ts:86-87](src/lib/theme-engine.ts#L86)。
- **触发：** 暗色主题下打开删除、重置等危险操作确认框。
- **根因：** 背景使用会随主题变化的 `bg-md-error`，前景却写死 `text-white`，没有配对 `text-md-onError`。
- **影响：** 关键危险按钮文字偏淡，视觉层级和可读性不符合正文 4.5:1 对比度要求。
- **计算结果：** 使用实际主题引擎对 7 个预设分别计算深浅两种主题。浅色 error=`186 26 26`，白字对比度 **6.46:1**；暗色 error=`255 180 171`，白字仅 **1.70:1**；暗色正确 onError=`105 0 5`，配对对比度 **7.72:1**。7 个预设结果一致。计算不等于截图验收。
- **最小建议：** 只替换危险实色按钮的前景 token；不要全局替换所有白色文本，VIBE、品牌图标和其他语义另行判断。
- **后续最小验证：** 同一危险确认框深浅主题各一次，检查正常、悬停、键盘焦点状态及对应颜色配对。

### UI-02 · P2 · 设置页与二次确认框同时处理 Escape

- **证据等级：静态确认。**
- **位置：** [SettingsPage.tsx:70-108](src/components/settings/SettingsPage.tsx#L70)、[SettingsPage.tsx:945-971](src/components/settings/SettingsPage.tsx#L945)、[ConfirmDialog.tsx:34-64](src/components/ui/ConfirmDialog.tsx#L34)。移动设置的同类处理见 [MSettingsPage.tsx:82-98](src/components/settings/MSettingsPage.tsx#L82)。
- **触发：** 设置页打开“重置设置”或“从云端下载覆盖本地”的二次确认，然后按 Escape。
- **根因：** 设置页与 ConfirmDialog 都在 document 注册键盘监听。设置页不检查顶层弹窗状态，ConfirmDialog 仅 preventDefault，未形成统一的最上层响应机制。
- **影响：** 本应只取消二次确认，却连设置页一并关闭；移动详情页可能连带退回列表。桌面设置页与确认框也各自实现 Tab 焦点循环，存在跨层争抢。
- **已有保护及缺口：** [Modal.tsx:18-36](src/components/ui/Modal.tsx#L18) 已有弹窗栈与 overlay lock，但 SettingsPage/ConfirmDialog 这条路径没有统一接入。不能据此断言所有弹窗都坏了；供应商目录另有捕获阶段键盘处理。
- **最小建议：** 统一“仅最上层弹窗响应键盘”的规则；底层设置页在子确认框存在时让出 Escape/Tab，关闭后恢复触发点焦点。
- **后续最小验证：** 设置页 → 重置确认 → Escape 只取消确认；Tab/Shift+Tab 留在确认框；再按 Escape 才关闭设置页。

### UI-03 · P2 · 提供商连接测试在通信异常后可能一直显示“测试中”

- **证据等级：静态确认。**
- **位置：** [ProvidersSection.tsx:186-199](src/components/settings/ProvidersSection.tsx#L186)、[ProvidersSection.tsx:430-444](src/components/settings/ProvidersSection.tsx#L430)、[ipc-client.ts:118-134](src/lib/ipc-client.ts#L118)、[ipc-client.ts:520-524](src/lib/ipc-client.ts#L520)。
- **触发：** 在提供商卡片点击“测试连接”，同时 WebUI 断网、会话失效或 IPC 调用直接 reject。
- **根因：** testConnection 先设置 testing，随后直接 await；它只处理成功兑现后的 `{ error }`，没有处理 Promise reject。WebUI invoke 在网络失败或非成功状态时确实会抛错。
- **影响：** 卡片没有可见失败信息，测试按钮因 testing 持续禁用，用户需要重开界面才能恢复。
- **已有保护及缺口：** 设置页顶部连接测试已有 try/catch，但提供商卡片没有复用这一失败处理。
- **最小建议：** 在该外部通信边界补失败状态收尾，确保按钮可重试；不必修改全局 IPC 错误契约。
- **后续最小验证：** 分别模拟返回 `{ error }` 和直接 reject，均显示原因并可再次测试。

### UI-04 · P2 · 图片能力探测的旧结果可能覆盖期间编辑的模型列表

- **证据等级：静态确认。**
- **位置：** [ProvidersSection.tsx:186-249](src/components/settings/ProvidersSection.tsx#L186)、[ProvidersSection.tsx:252-264](src/components/settings/ProvidersSection.tsx#L252)、[settings-store.ts:210-217](src/stores/settings-store.ts#L210)。
- **触发：** 有已启用模型时测试连接；图片探测尚未完成期间，新增/删除模型或调整模型配置；随后旧探测结果至少改变一个 supportsImages 值。
- **根因：** Promise.allSettled 和 updatedModels 使用测试开始时闭包中的 provider.models；完成后 setProviderModels 用整份旧列表覆盖当前列表。连通性成功后立即 setTestStatus('ok')，图片探测仍在跑，既没有版本校验，也没有阻止再次启动探测。
- **影响：** 刚新增的模型可能消失、删除的模型可能重新出现，其他模型配置也可能回退；多轮探测后到的旧结果可能覆盖新结果。
- **最小建议：** 按提供商/请求版本校验结果，只向当前仍存在且配置未变的模型合并 supportsImages 字段，不整表写回旧快照；区分连通性完成与探测仍在进行。
- **后续最小验证：** 用延迟响应制造“探测 → 编辑模型 → 旧响应返回”，检查新增、删除、参数修改均保留；再测两轮请求反序返回。

### UI-05 · P3 · 设置页的 `/8` 透明度类没有生成 CSS

- **证据等级：静态确认 + 实际样式编译验证。**
- **位置：** [ProvidersSection.tsx:284](src/components/settings/ProvidersSection.tsx#L284)、[SettingsPage.tsx:219](src/components/settings/SettingsPage.tsx#L219)、[MSettingsPage.tsx:245](src/components/settings/MSettingsPage.tsx#L245)、[TokenUsageStats.tsx:30](src/components/settings/TokenUsageStats.tsx#L30)。
- **触发：** 显示当前提供商、当前模型摘要或使用量主色卡片。
- **根因：** 这些位置使用 `bg-md-primary/8`，当前 Tailwind 配置没有这一透明度档。
- **验证：** 载入项目真实 Tailwind 配置，以 PostCSS 在内存生成候选类 CSS；`/10`、`/15`、`/[0.08]` 均生成规则，`/8` 没有规则。
- **影响：** 代码宣称的淡主色背景实际不存在，选中态只剩边框/文字差异；属于局部视觉层级缺失，不是整个卡片不显示。
- **最小建议：** 使用项目已支持的透明度档，或用合法的任意透明度语法；不要为四处用法引入新的主题引擎。
- **后续最小验证：** 检查 CSS 产物包含目标规则，并在深浅主题核对选中与未选中的区别。

### UI-06 · P1 · 审批焦点在“拒绝”时，Enter 可能提交“允许一次”

- **证据等级：静态确认，优先修复。**
- **位置：** [PermissionCard.tsx:212-252](src/components/chat/PermissionCard.tsx#L212)。
- **触发：** 新审批默认 selected 为第一个允许选项，用户使用 Tab 将真实键盘焦点移到“拒绝”按钮，然后按 Enter。
- **根因：** 每个选项按钮都进入 Tab 顺序，但焦点变化不更新 selected；父容器捕获 Enter 后 preventDefault，调用 commit(selected)，而不是提交当前聚焦的按钮。
- **影响：** 用户意图拒绝，实际却可能向宿主发送允许决策。这是交互与权限语义不一致，不只是焦点样式问题；现有后端审批守卫不会识别这种由合法 UI 生成的错误用户决策。
- **最小建议：** 统一焦点、选中状态和提交目标；选用完整的单一 Tab 入口/方向键模式，或保留原生按钮提交语义。不能只补一个焦点边框，也不能通过放宽后端规则解决。
- **后续最小验证：** 聚焦拒绝后 Enter 必须只产生 deny；分别覆盖方向键、数字键、鼠标操作及请求更换。

### UI-07 · P2 · 发送请求未受理，输入内容和附件已被清空

- **证据等级：静态确认。**
- **位置：** [ChatInput.tsx:569-577](src/components/chat/ChatInput.tsx#L569)、[ChatPage.tsx:92-100](src/components/chat/ChatPage.tsx#L92)、[use-agent.ts:274-315](src/hooks/use-agent.ts#L274)。
- **触发：** 缺少模型连接配置、当前会话并发守卫拒绝，或宿主拒绝本轮请求时发送消息。
- **根因：** sendMessage 明确返回 false，但 handleSend 丢弃返回值；输入框调用 onSend 后立即清空文字、任务模式与附件。
- **影响：** 消息没有进入历史，用户却失去长文本和附件草稿；展示错误横幅并不能恢复这些输入。
- **最小建议：** 定义“已受理”的明确返回契约，受理后只清理对应版本的草稿；不要简单等完整模型运行结束再清空，因为 renderer 的 sendMessage Promise 还承担整个运行周期。
- **后续最小验证：** 返回拒绝时完整保留草稿；受理后正常清空；等待受理期间新增的输入不能被迟到响应清掉。

### UI-08 · P2 · 草稿没有按会话隔离，切换可能串入或丢失

- **证据等级：静态确认。**
- **位置：** [ChatInput.tsx:178-189](src/components/chat/ChatInput.tsx#L178)、[ChatPage.tsx:143-199](src/components/chat/ChatPage.tsx#L143)。
- **触发：** 在已有消息的 A 会话输入未发送草稿，再切到已有消息的 B；或者从 A 切到新建空会话。
- **根因：** 草稿属于 ChatInput 本地 state；消息列表按 sessionId 设置 key，但输入框在同类布局切换时复用，而欢迎布局和常规布局又会导致输入框卸载。
- **影响：** A 的草稿可能出现在 B 并被误发送；切到空会话后原草稿又可能丢失。
- **最小建议：** 按会话保存并恢复文字、附件、任务模式等完整草稿。仅给 ChatInput 加 key 会把串会话变成必然丢草稿，不是完整修复。
- **后续最小验证：** A→B→A、A→新建空会话→A，分别核对文字与附件；同时验证多个会话后台运行。

### UI-09 · P2 · 后续问题卡可继承旧答案，提交不属于当前问题的选项

- **证据等级：静态确认。**
- **位置：** [QuestionCard.tsx:8-25](src/components/chat/QuestionCard.tsx#L8)、[ChatPage.tsx:196](src/components/chat/ChatPage.tsx#L196)、[tool-registry.ts:1262-1277](src/lib/tool-registry.ts#L1262)。
- **触发：** 连续问题请求重复使用题目 ID，例如 q1，但题目或选项已经变化；也可发生在切会话后组件被复用时。
- **根因：** selected/other 用 question.id 作为索引，却没有按 sessionId + pending.id 隔离或重置。pending 为空时 return null 不会清除组件 state；answered 仅校验答案非空，不校验是否属于当前选项。
- **影响：** 新问题可能显示已有作答数量，甚至没有可见选中项仍能提交旧答案。
- **最小建议：** 按请求隔离表单状态，提交前验证当前选项归属及“其他”文本；保留同一请求正常展开/折叠时的草稿。
- **后续最小验证：** 两次同题目 ID、不同选项的请求，第二次必须零已答且不可直接提交；再测跨会话同题目 ID。

### UI-10 · P2 · 编辑排队消息时可能夹带另一份草稿的附件

- **证据等级：静态确认。**
- **位置：** [ChatInput.tsx:419-426](src/components/chat/ChatInput.tsx#L419)。
- **触发：** 输入框已有附件，点击编辑一条不带附件的排队消息，然后发送。
- **根因：** 编辑操作覆盖文字和任务模式，但仅在 item.attachments 非空时更新附件列表，空列表没有覆盖旧附件。
- **影响：** 原本纯文本的排队消息意外附带当前草稿中的文件，可能把文件发给非预期任务；本阶段没有实际发送文件验证。
- **最小建议：** 完整恢复排队项的草稿字段，附件为空也要覆盖；覆盖前保护已有未发送草稿。
- **后续最小验证：** 带附件草稿→编辑纯文本排队项，最终发送载荷中不能含原草稿附件。

### UI-11 · P2 · 后台会话错误可能出现在当前会话，重试目标随之错位

- **证据等级：静态确认，适用于 renderer 运行路径。**
- **位置：** [use-agent.ts:119-125](src/hooks/use-agent.ts#L119)、[use-agent.ts:365-382](src/hooks/use-agent.ts#L365)、[use-agent.ts:750](src/hooks/use-agent.ts#L750)、[ChatPage.tsx:104-139](src/components/chat/ChatPage.tsx#L104)。
- **触发：** A 正在本地运行时切换到已有消息、空闲的 B，随后 A 的旧异步回调报告可重试错误。
- **根因：** 宿主错误已按 sessionId 保存，但本地 error 是共享 hook state；旧回调 setError 后，当前 ChatPage 用 B 的 sessionId、lastUserMessage 生成横幅及重试操作。
- **影响：** B 显示 A 的错误，点击重试却作用于 B 的最后一条用户消息。
- **最小建议：** 本地错误也按来源会话隔离；重试显式绑定产生错误的会话和轮次，不只读取当前活动会话。
- **后续最小验证：** A 后台失败时 B 不出现 A 的错误；回到 A 后才可重试 A；宿主模式既有隔离保持不变。

### UI 待验证项与低优先级设计债务

以下不计入已确认故障，避免将静态风险夸大成视觉实测结论：

- 命令菜单的方向键/Escape 与中文输入法候选可能冲突，需检查真实组合输入；普通消息 Enter 已有组合输入保护。
- 长问题卡、移动端软键盘与小窗口的组合场景可能裁切提交区；问题卡不同于已设置内部滚动的工作流审批卡，需测量 DOM。
- 长会话测高缓存初始化及恢复是否导致跳位，需要浏览器运行证据，不能由 ref 初值直接认定性能故障。
- 移动设置页有 aria-modal，但没有像桌面页那样处理 Tab 循环，需补窄窗口键盘/屏幕阅读器验证。
- 设置区仍有固定 10/11px 字号，例如 [ProvidersSection.tsx:511](src/components/settings/ProvidersSection.tsx#L511) 的参数标签；它们不会随根 rem 字号变化。应先处理重要说明/操作标签，不机械地把所有徽标同时放大。
- 减弱动态效果已覆盖部分入场/工具动画，但 thinking-shimmer、agent-status-label 等仍需完整核对；此阶段没有进行动画体感或屏幕阅读器验收。

## 3. 主进程 / 后端检查明细

### BE-01 · P1 · 远程黑名单遗漏等价的本机读写和 MCP 调用能力

- **证据等级：静态确认；未发起攻击请求。**
- **位置：** [main.ts:886-893](electron/main.ts#L886)、[webui-server.ts:26-36](electron/webui-server.ts#L26)、[webui-server.ts:618-659](electron/webui-server.ts#L618)、[main.ts:1022-1033](electron/main.ts#L1022)、[main.ts:1369-1431](electron/main.ts#L1369)、[main.ts:2600-2604](electron/main.ts#L2600)、[mcp-manager.ts:266-281](electron/mcp-manager.ts#L266)。
- **触发前提：** WebUI 服务可达且调用方持有有效 token。MCP 影响还要求本机已连接并启用了相应工具。此问题不是无认证互联网远程执行。
- **根因：** 所有 ipcMain.handle 自动进入远程调用注册表，黑名单过滤后直接执行同一 handler；当前名单没有 readFile、readFileBase64、writeFile、mcpCallTool。
- **影响：** 通用文件 API 允许绝对路径，可读应用权限可读的明文文件、覆盖应用权限可写的文件；mcpCallTool 能直接调用已连接工具，而不经过 Agent 审批路径。禁止专用凭据 API/命令执行 API 并没有封住这些等价能力。
- **为何已有保护不足：** assertSafePath 限制 NUL、UNC、ADS、设备名及部分路径形式，但没有将绝对路径约束到已授权目录；大小上限不是访问授权。这里不声称 safeStorage 加密已被破解。
- **依据：** WebUI 自己的威胁模型明确规定 token 泄漏不应足以窃取密钥或获得本机执行能力，因此不是把“远程控制工具本来就能读文件”随意列成漏洞。
- **最小建议：** 按现有威胁模型补齐远程默认拒绝范围；对确需保留的文件预览/上传功能，通过明确能力和受控路径授权开放，而非暴露通用任意路径 API。更长期再考虑显式远程 allowlist，不必同时重写 IPC。
- **后续最小验证：** 用替身 handler 验证请求在实际文件/MCP 操作前被拒绝；合法预览仍可用；本地桌面受授权能力不回归。

### BE-02 · P1 · SQLite 降级到 JSON 后恢复，会形成两份不自动合并的数据

- **证据等级：静态确认；未操作用户数据库。**
- **位置：** [db.ts:173-185](electron/db.ts#L173)、[db.ts:886-906](electron/db.ts#L886)、[db.ts:962-969](electron/db.ts#L962)。
- **触发：** 已有非空 SQLite；一次 WASM 加载失败触发 JSON 降级；降级期间新增消息；之后 WASM 恢复并重新启用 SQLite。
- **根因：** 降级读取/恢复的是迁移时的旧 JSON 快照，不是当前 SQLite 内容；恢复 SQLite 时只在 SQLite 空库时导入 JSON，已有非空库不会合并降级期间写入的数据。
- **影响：** SQLite 的新历史在降级期间不可见；降级新增的 JSON 消息在恢复后又不可见。文件保留不代表用户能通过正常界面找回这些消息；这是数据分叉/可见性丢失，不应描述成已物理删除所有数据。
- **已有保护：** 旧库、备份未被直接删除，迁移与原子写已有保护；本次既有迁移测试通过，但没有证明“降级继续写入再恢复”这条完整闭环成立。
- **最小建议：** 存在已有 SQLite 时，不静默把旧快照作为可写主库；引入明确降级状态和恢复选择，保证恢复时可识别并处理两边新增数据。具体合并策略需后续确认，不直接覆盖任何一份库。
- **后续最小验证：** 在临时数据目录中执行“SQLite 写 A → 无 WASM 降级写 B → 恢复”，核对 A/B 都能被保留并正确呈现，同时验证删除/修改冲突策略。

### BE-03 · P1 · 宿主手动压缩与新运行没有共用互斥状态

- **证据等级：静态确认，适用于 main 宿主。**
- **位置：** [agent-host.ts:861-879](electron/agent-host.ts#L861)、[agent-host.ts:963-987](electron/agent-host.ts#L963)、[db.ts:568-577](electron/db.ts#L568)。
- **触发：** 已有运行设置快照的会话执行手动压缩，正在等待摘要；与此同时另一路入口，例如 IM/另一窗口，向同一会话提交新运行。
- **根因：** manualCompact 只在进入时检查 s.run，却没有占用运行互斥状态；startRun 仍看到空闲并接受新任务。压缩结束按最初读取的 messages 生成 newMessages，再通过 compactMessages 删除该会话消息后整段重插。
- **影响：** 摘要返回前新增的用户/助手消息可能被旧快照覆盖。数据库事务保证本次替换原子，不保证参与替换的快照仍然最新。
- **最小建议：** 压缩和 run 共享会话级互斥或队列；压缩提交再核对版本。前端禁用一个发送按钮不能替代宿主跨入口的并发控制。
- **后续最小验证：** 使用可暂停的摘要 Promise，压缩期间提交新任务；新任务应排队/被明确拒绝，或安全合并，不能静默丢消息。

### BE-04 · P1 · 宿主使用会话级序号，客户端却用全局序号去重

- **证据等级：静态确认；生产者、广播、消费者和补发链路均已核对。**
- **位置：** [agent-host.ts:200-206](electron/agent-host.ts#L200)、[agent-host.ts:230-233](electron/agent-host.ts#L230)、[agent-host.ts:249-260](electron/agent-host.ts#L249)、[agent-client.ts:69-79](src/lib/agent-client.ts#L69)、[agent-client.ts:169-177](src/lib/agent-client.ts#L169)、[agent-client.ts:236-237](src/lib/agent-client.ts#L236)、[agent-host.ts:1007-1028](electron/agent-host.ts#L1007)。
- **触发：** 同一客户端收到多个宿主会话的事件，尤其 A 已产生较多事件，再运行 B。
- **根因：** 每个 HostSession 有独立 seq，广播时未转换为全局序号；单例 agentClient 只有一个 lastSeq 和以 number 为键的 pending。它直接忽略 seq <= lastSeq 的事件，不区分 sessionId。
- **示例：** A 已推进全局客户端游标到 100，B 从 1 开始的事件会被误当成重复；两会话相同序号也会在 pending 中冲突。
- **影响：** 运行状态、消息与审批事件被漏收，出现“任务在跑但界面没更新”“看不到审批”等体验问题。snapshot 又对各会话使用同一个 sinceSeq，不能可靠修复这个序号域冲突。
- **最小建议：** 要么端到端采用全局单调序号，要么客户端/补发接口都按 sessionId 分别维护游标和缓冲；必须一致修改协议含义，不能只绕过去重条件。
- **后续最小验证：** 两会话交错发送 1/1/2/2，全部准确送达；A 高序号后启动 B；断线补发；重复事件仍只应用一次。

### BE-05 · P2 · 刷新桌面窗口会中止不属于该窗口的后台流

- **证据等级：静态确认。**
- **位置：** [main.ts:779-780](electron/main.ts#L779)、[agent-host.ts:116-117](electron/agent-host.ts#L116)、[api-proxy.ts:415-422](electron/api-proxy.ts#L415)、[api-proxy.ts:511-546](electron/api-proxy.ts#L511)。
- **触发：** 宿主/IM 或 WebUI 正在通过同一 API 代理生成响应，桌面主窗口发生刷新或销毁。
- **根因：** 所有渠道共用 inflight；窗口导航/销毁回调执行 abortAllApiRequests，不区分请求归属。清理又将这些请求标记为 userAborted，使异常收尾返回 done。
- **影响：** 应当独立于渲染窗口存活的任务也被截断，调用方还可能把不完整结果理解为正常结束。
- **最小建议：** 在请求注册时明确窗口、宿主或远程连接归属；窗口刷新只清理该窗口拥有的流，应用退出再做全局清理；区分主动停止与意外中止。
- **后续最小验证：** 两类拥有者并行请求，刷新一个窗口只结束它的流；宿主及其他远程连接继续收到内容和正确结束信号。

### BE-06 · P2 · 删除待审批/待回答的会话，只清计时器而不结束等待

- **证据等级：静态确认，适用于 main 宿主。**
- **位置：** [chat-store.ts:640-657](src/stores/chat-store.ts#L640)、[agent-host.ts:576-589](electron/agent-host.ts#L576)、[agent-host.ts:663-674](electron/agent-host.ts#L663)、[agent-host.ts:1035-1045](electron/agent-host.ts#L1035)、[loop.ts:969-974](src/agent-core/loop.ts#L969)。
- **触发：** 主宿主任务正等待权限确认或问题答案，用户删除该会话。
- **根因：** dropSession 对 run 的 controller 调用 abort，随后清除 pendingPermissions/pendingQuestions 的 timer 并移除会话，但未调用 pending.resolve；这些等待 Promise 自身没有接入 abort，超时兜底也被清除了。
- **影响：** 异步等待不再收尾。Map 被移除、侧栏会话消失不能证明底层运行已经完成清理；外部等待者和后续资源回收可能持续挂起。
- **最小建议：** 删除流程显式拒绝所有待批并用空答案结束待答，再收尾运行/移除会话；同时防止收尾异步回调在已删除会话中写回消息。
- **后续最小验证：** 分别在待批和待答时删除会话，验证原等待 Promise 已 settle、计时器被清理、数据库不被迟到回调重建，而不只断言 sessions Map 为空。

### 后端待验证项

WebUI 的部分 SSE 清理使用 req.close，位置包括 [webui-server.ts:668](electron/webui-server.ts#L668) 附近的流式处理。请求体完成与响应真正断连的时序不等价；是否错过清理或误中止上游，需要用本项目 Electron/Node 版本模拟响应断连确认。本阶段不把它作为已复现故障，后续优先验证 res.close/连接关闭的正确归属。

## 4. 已完成的基础验证

### 4.1 环境与类型检查

实际执行环境：Windows / Git Bash，Node **v24.14.1**，npm **11.11.0**；以本次命令输出为准，而非启动上下文中的版本快照。

| 命令 | 结果 | 说明 |
|---|---|---|
| `./node_modules/.bin/tsc --noEmit --pretty false` | 通过，退出码 0 | 当前 tsconfig 包含 src、electron、tests |
| `./node_modules/.bin/tsc -p tsconfig.electron.json --noEmit --pretty false` | 通过，退出码 0 | 核对主进程 CommonJS 编译配置，不生成构建产物 |

### 4.2 小范围既有测试

命令：

```bash
./node_modules/.bin/vitest run tests/chat-row.test.ts tests/chat-error.test.ts tests/message-list-virtual.test.ts tests/chat-composer-pinned.test.ts tests/permission-preview.test.ts tests/permission-flow.test.ts tests/db.test.ts tests/webui-blocklist.test.ts tests/webui-resync.test.ts tests/agent-host-permission.test.ts tests/preload-bridge.test.ts tests/i18n-keys.test.ts --reporter=dot
```

结果：**12 个测试文件、132 个测试用例全部通过；退出码 0；Vitest 报告总耗时 3.88 秒。**

| 测试文件 | 用例数 | 覆盖主题 |
|---|---:|---|
| tests/chat-row.test.ts | 8 | 消息/会话行映射 |
| tests/chat-error.test.ts | 6 | 错误分类与呈现数据 |
| tests/message-list-virtual.test.ts | 35 | 虚拟列表与滚动恢复纯逻辑 |
| tests/chat-composer-pinned.test.ts | 4 | 输入区布局结构约束 |
| tests/permission-preview.test.ts | 23 | 审批预览数据 |
| tests/permission-flow.test.ts | 3 | 审批基础流程 |
| tests/db.test.ts | 17 | SQLite/JSON 迁移与数据操作 |
| tests/webui-blocklist.test.ts | 15 | 远程通道限制 |
| tests/webui-resync.test.ts | 5 | 远程事件重同步 |
| tests/agent-host-permission.test.ts | 7 | 宿主审批、拒绝和超时 |
| tests/preload-bridge.test.ts | 6 | preload 桥接约束 |
| tests/i18n-keys.test.ts | 3 | 翻译键检查 |

**不能据此宣称 UI 已验收。** [vitest.config.ts:3-8](vitest.config.ts#L3) 使用 node 环境，测试不会操作真实 Electron 窗口、验证 DOM 焦点、中文输入法或手机软键盘。

### 4.3 测试日志中的警告

- 缺失 wasm 的几条日志是测试主动构造的降级场景，测试通过；不能当成当前实际安装缺少 wasm。
- 无可用窗口拒绝危险操作、审批超时拒绝也是预期的安全路径。
- **另外观察到 1 次非断言失败的 `sqlite persist failed: ENOENT`**：300ms 定时落盘尝试写已不存在的测试临时目录。测试的 afterEach 直接删除临时目录，见 [tests/db.test.ts:21-25](tests/db.test.ts#L21)，测试实例未统一 dispose/关闭，说明存在清理顺序与延时写任务相撞的嫌疑。
- 此项记录为**测试生命周期警告，原因仍需单独确认**，不据此断言生产数据库已损坏或本次 132 项测试失败。后续可在测试清理前统一 flush/dispose，并验证计时器清理；本阶段没有修改测试。

### 4.4 样式基础计算

- 通过项目既有 esbuild 将 theme-engine 打包到内存，执行真实 applyColorScheme 收集 token，并按 WCAG 相对亮度公式计算对比度，得到 UI-01 的 14 组主题结果。
- 通过项目既有 esbuild、PostCSS、Tailwind，载入真实配置，在内存编译 4 个透明度候选类，得到 UI-05 的结果。
- 首次尝试直接用 Node ESM 导入主题引擎时，依赖内部扩展名解析报 ERR_MODULE_NOT_FOUND；改用项目已经依赖的打包器完成计算。此为辅助检查脚本与包的原生 ESM 解析兼容问题，**没有作为应用构建故障计入**，也没有修改依赖。

## 5. 尚未执行的验收

遵照本阶段“最基础验证即可”的要求，没有启动开发服务器或 Electron，没有运行完整构建、全量测试、视觉截图、跨设备/跨系统测试、真实模型付费调用、网络攻防或负载测试，也没有将源码发送给外部代码审查服务。

后续真正修复 UI 时，最小人工检查仍应覆盖：普通发送/停止、切换会话、二次审批取消、长消息滚动、设置失败重试、深浅主题和小窗口。涉及主后端修复时再针对具体失败边界增加小范围测试，不应现在扩展为全项目重构。

## 6. 下一阶段的最小修复顺序（尚未实施）

1. **先校正审批与远程边界：UI-06、BE-01。** 分别修正前端决策目标和远程能力授权；保留必要确认，不因省工序而降低安全要求。
2. **集中处理宿主一致性：BE-04、BE-03、BE-06、BE-05。** 先确定事件序号域，再处理同会话 run/compact 互斥和取消/销毁收尾。agent-host 由同一修改批次统筹，避免多人并行改同一文件造成契约冲突。
3. **单独确定数据恢复方案：BE-02。** 这是唯一需要先明确冲突处理策略的持久化改动，先在临时数据库测试闭环，不对真实用户库试错。
4. **合并草稿与会话状态修复：UI-07～UI-11。** 按会话/请求隔离状态，统一草稿受理、排队编辑与错误重试的归属，不分五次重复改输入区。
5. **收尾设置与公共视觉：UI-01～UI-05。** 修复弹窗栈、失败反馈、异步旧结果覆盖和 token/透明度；固定小字号、移动端点击范围及动画只按实际可见问题继续收敛。

每批只补针对问题的回归用例，集中跑类型检查与相关测试。涉及界面行为的修改必须再进行对应的最小实际操作验证，但不预先承诺整站验收或没有依据的提速百分比。

## 7. 覆盖范围与已有基础

| 检查面 | 本轮实际范围 | 覆盖界限 |
|---|---|---|
| 聊天与导航 | ChatPage、ChatInput、MessageList、Sidebar、PermissionCard、QuestionCard、错误横幅及相关 store/hook | 定向静读关键组件/函数；没有实际点击、中文输入法或长会话压测 |
| 设置与设计 | SettingsPage、MSettingsPage、ProvidersSection、McpSection、Modal、ConfirmDialog、theme-engine、index.css、Tailwind 配置和 DESIGN 约束 | 主题/透明度做了计算；未做整页截图与所有控件逐项测量 |
| 主进程与后端 | main、preload、webui-server、db、agent-host、api-proxy，追踪 MCP、事件客户端、删除、压缩和审批调用方 | 重点路径检查，不是所有 IPC、插件、IM 协议、更新器和系统控制模块的完整安全审计 |
| 基础验证 | 两套 tsc、12 文件/132 用例、主题颜色和 Tailwind 内存编译 | 未覆盖全部测试文件；通过不代表上列缺陷不存在 |

已有基础应保留，避免重复建设：

- Material 3 语义 token、主题切换、根字号缩放、全局键盘焦点兜底已经存在，不需要重新引入一套设计系统。
- 消息列表已有虚拟化、会话滚动记忆和用户阅读意图区分；普通 Enter 已避让组合输入，Shift+Enter 支持换行。
- WebUI 已有默认回环、随机 token、请求鉴权及敏感通道限制；主宿主有远程审批拒绝、无窗口拒绝和审批超时拒绝。BE-01 是现有边界覆盖不完整，而不是“整个项目没有鉴权”。
- 数据库已有参数化 SQL、事务、原子文件写、防抖上限、失败重试和旧库备份。BE-02/BE-03 是恢复与并发语义问题，不应靠替换数据库解决。
- preload 有固定 API 暴露及事件退订，窗口有既有隔离设置；本轮没有把这些保护推翻或调整。

**第一阶段本报告记录的问题中，UI/UX 11 项已在第二阶段修复（见下节）；主进程/后端 6 项亦已于 2026-11-08 全部修复，实施记录见 [第二阶段修复记录](PHASE2_BACKEND_LICENSE_README_FIXES.md)（原始发现保留在 [BACKEND_AUDIT.md](BACKEND_AUDIT.md)）。本轮未提交、未推送。**

## 8. 第二阶段：前端 11 项修复记录（2026-11-06）

范围授权原话：「你把UIux修了 把后端的单独写一份文档，你只做前端哦」。改动只落在 `src/**` 组件、store、hook 与 `tests/**`；`electron/**`、`src/agent-core/**`、事件协议、构建配置一律未改。

### 8.1 逐项落地

| 项 | 改法 | 位置 |
|---|---|---|
| UI-01 · P2 | 危险实色按钮前景从写死白字改成语义配对 `text-md-onError`，不再动 VIBE 与其余白色样式 | [ConfirmDialog.tsx:92](src/components/ui/ConfirmDialog.tsx#L92)、[McpSection.tsx:559](src/components/settings/McpSection.tsx#L559) |
| UI-02 · P2 | 把原先只服务于 Modal 的「弹窗栈 + 覆盖锁」抽成共享 hook，统一在 document 捕获阶段只让栈顶响应 Escape/Tab，并在关闭后归还触发焦点；设置页、移动设置页、确认框、MCP 编辑/导入/删除确认、Modal 基座全部接入同一份实现 | [use-modal-accessibility.ts](src/hooks/use-modal-accessibility.ts)、[Modal.tsx:54](src/components/ui/Modal.tsx#L54)、[SettingsPage.tsx:56](src/components/settings/SettingsPage.tsx#L56)、[MSettingsPage.tsx:69](src/components/settings/MSettingsPage.tsx#L69) |
| UI-03 · P2 | 连接测试补 `try/catch`：`/api/invoke` reject、断网等通信异常一律落到 `error` 态并显示原因，不再永久停在「测试中」 | [use-provider-connection-test.ts:55](src/hooks/use-provider-connection-test.ts#L55) |
| UI-04 · P2 | 探测改为请求身份保护：连接参数变化或被删/被重加的模型会被标记失效，旧结果直接作废；只把 `supportsImages` 合并进**当前**模型列表，不再整表回写旧快照；探测期间保持 `testing`，并用 ref 守卫挡住重入 | [use-provider-connection-test.ts:20](src/hooks/use-provider-connection-test.ts#L20) |
| UI-05 · P3 | `bg-md-primary/8` 等无效透明度改为可编译的 `/[0.08]` | [ProvidersSection.tsx:169](src/components/settings/ProvidersSection.tsx#L169)、[SettingsPage.tsx:180](src/components/settings/SettingsPage.tsx#L180)、[MSettingsPage.tsx:231](src/components/settings/MSettingsPage.tsx#L231)、[TokenUsageStats.tsx:30](src/components/settings/TokenUsageStats.tsx#L30) |
| UI-06 · P1 | 提交目标改为**真实焦点项**：按钮保持原生 Tab 可达，`onFocus` 同步选中，Enter/Space 走原生 click（`detail === 0` 判定），父层不再 `preventDefault` 提交旧的 `selected`；鼠标仍是「一次选中、再点提交」（用 `pointerdown` 记录点击前选择，抵消 focus 抢先）；数字键扩到 1–9 且只提交可见选项；补 `focus-visible` 环形焦点；两处列表按 `request.id` 重挂载，杜绝跨请求继承选择 | [PermissionCard.tsx:198](src/components/chat/PermissionCard.tsx#L198) |
| UI-07 · P2 | 「受理」与「跑完」拆开：`sendMessage` 在宿主受理/本地起循环后即返回布尔，输入区只在返回 `true` 时清草稿，未受理（会话占用、缺 baseUrl/Key、抛错）保留原文并把错误按会话回灌；等待期间的新输入不会被迟到响应清掉（比对草稿对象身份） | [use-agent.ts:274](src/hooks/use-agent.ts#L274)、[ChatInput.tsx:447](src/components/chat/ChatInput.tsx#L447)、[ChatPage.tsx:92](src/components/chat/ChatPage.tsx#L92) |
| UI-08 · P2 | 草稿（文字/附件/任务档/压缩档）移入 `chatStore.drafts[sessionId]`，切会话不再串草稿也不因欢迎页重挂载丢草稿；带草稿的空会话不再被自动清理回收 | [chat-store.ts:93](src/stores/chat-store.ts#L93)、[ChatInput.tsx:180](src/components/chat/ChatInput.tsx#L180) |
| UI-09 · P2 | 问题卡拆成外层订阅 + 以 `sessionId + pending.id` 为 key 的表单，答案改存「选项/其它」判别类型；提交前校验选项仍属于当前题目、其它文本非空，同请求折叠保留填写内容 | [QuestionCard.tsx:8](src/components/chat/QuestionCard.tsx#L8) |
| UI-10 · P2 | 排队消息编辑改为整份覆盖（附件为空也清空），并在当前草稿非空时先弹一次替换确认，不再夹带上一条草稿的附件 | [ChatInput.tsx:421](src/components/chat/ChatInput.tsx#L421) |
| UI-11 · P2 | 本地异步循环的错误不再写组件内 `useState`，改按来源会话进 `sessionErrors[sessionId]`，与宿主回灌同一数据源；撤回/重试对话框按 `sessionId + messageId` 绑定，切走会话不会残留或错重发 | [use-agent.ts:118](src/hooks/use-agent.ts#L118)、[ChatPage.tsx:108](src/components/chat/ChatPage.tsx#L108) |

新增 i18n 文案：`chat.queuedEditReplaceTitle` / `chat.queuedEditReplaceBody`（中英双份，[zh-CN.ts:740](src/i18n/locales/zh-CN.ts#L740)、[en.ts:740](src/i18n/locales/en.ts#L740)）。

### 8.2 本阶段验证结果

| 检查 | 结果 |
|---|---|
| `tsc --noEmit --pretty false`（含 src/electron/tests） | 通过，退出码 0 |
| `vitest run`（11 个前端相关测试文件） | **124 用例全部通过**，其中新增 `tests/chat-approval-forms.test.ts` 20 例、`tests/chat-draft-isolation.test.ts` 8 例 |
| `vitest run`（全量） | **87 个测试文件、1355 用例通过、2 跳过，退出码 0**，耗时 23.12 秒；未见因本轮改动新增的失败 |
| 浏览器实测（本机 Vite + 真实 Tailwind/PostCSS + 真实 `theme-engine`，仅渲染真实 `Modal`/`ConfirmDialog`） | 两层弹窗打开时：第一次 Escape 只关最上层确认框（外层 Modal 仍在），第二次 Escape 才关外层并把焦点还给触发按钮；Tab 在顶层面板内循环；暗色危险按钮实测 `color: rgb(105,0,5)` / `bg: rgb(255,180,171)`，对比度 **7.72:1**（修复前白字为 1.70:1）；`bg-md-primary/[0.08]` 实测得到 `rgba(101,85,143,0.08)`，而 `bg-md-primary/8` 为 `rgba(0,0,0,0)` |

验证用的临时探针页面（`ui-probe.html`、`src/ui-probe.tsx`）验证完即删除，不在仓库里。

### 8.3 明确未做的验收

- **没有在真实 Electron 窗口里点过**：WebUI 浏览器模式缺少主进程 `/api/invoke` 后端，直接开页面拿不到会话数据；因此审批卡在真实对话流中的表现、切会话草稿表现、移动端软键盘与中文输入法候选、长会话滚动、屏幕阅读器播报均未实测。
- 上述键盘/焦点结论来自「真实组件 + 真实样式管线」的合成页面，键盘事件由脚本按真实传播路径派发（非 CDP 物理按键）；`focus-visible` 环只在无 `:focus-visible` 时读到 `box-shadow: none`，未做视觉截图核对。
- UI-02 的「焦点在弹窗外时按 Tab 拉回栈内」这一支未取到正向证据（原实现也没有该行为），保留实现但记为待复核。
- 未跑完整构建、全量测试、打包、真实模型调用；未修改后端，也未提交/推送。
