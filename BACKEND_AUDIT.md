# 主进程 / 后端待修复清单

- 检查日期：2026-11-06；项目版本 3.5.1。
- 检查基线：`main` / `bf1ea3ed265b718e20e5bafd454b037a901cbb04`。
- 来源：[第一阶段审查报告](PHASE1_UI_UX_BACKEND_AUDIT.md)。本文独立整理后端部分，源码行号对应检查基线。
- **6 项问题：P1 4 项、P2 2 项。已于 2026-11-08 全部修复，实施记录与验证见 [第二阶段修复记录](PHASE2_BACKEND_LICENSE_README_FIXES.md)。本文保留原始发现与证据，作为修复前的基线。**
- 证据来自本地静态检查与既有基础测试；未攻击服务、操作用户数据库、调用付费模型或上传源码。以下「建议」为修复前的原始判断，实际实现可能与之略有出入，以第二阶段记录为准。

## BE-01 · P1 · 远程黑名单遗漏本机文件和 MCP 能力

**证据：** [IPC 自动注册](electron/main.ts#L886)、[远程过滤和分派](electron/webui-server.ts#L618)、[Base64 文件读取](electron/main.ts#L1022)、[通用文件读写](electron/main.ts#L1369)、[MCP 入口](electron/main.ts#L2600)、[工具执行](electron/mcp-manager.ts#L266)。

- 前提：WebUI 可达且调用方持有效 token；MCP 还需本机已经连接并启用对应工具。不是无认证公网远程执行。
- 根因：所有 ipcMain.handle 自动进入远程注册表，过滤后直接调用 handler；黑名单没有 readFile、readFileBase64、writeFile、mcpCallTool。
- 影响：可读取应用权限范围内的明文文件、覆盖可写文件，或直接调用已有 MCP 工具而不经过 Agent 审批。禁止专用凭据/命令 API 没有封住等价能力。
- 已有保护：assertSafePath 限制 NUL、UNC、ADS、设备名等，但不把绝对路径限制在授权目录；文件大小限制也不等于授权。本项不声称已破解 safeStorage。
- 判定依据：现有 WebUI 威胁模型要求 token 泄漏不能直接导致本机执行能力和凭据失守。
- 最小建议：按威胁模型默认拒绝这些通用能力，对必要预览/上传通过明确能力和受控路径授权开放；不要机械封禁并破坏合法功能。
- 后续验证：替身 handler 确认请求在文件/MCP 操作之前被拒绝；合法预览和本地受授权操作不回归。

## BE-02 · P1 · SQLite → JSON → SQLite 恢复形成数据分叉

**证据：** [旧 JSON 快照恢复](electron/db.ts#L173)、[SQLite 初始化/迁移](electron/db.ts#L886)、[JSON 降级入口](electron/db.ts#L962)。

- 前提：已有非空 SQLite，WASM 加载失败后降级到可写 JSON；降级期间有新消息；之后 WASM 恢复。
- 根因：降级恢复迁移时的旧 JSON，而不是当前 SQLite；恢复 SQLite 时只在空库导入 JSON，不合并降级期间写入的数据。
- 影响：SQLite 新历史在降级时不可见，JSON 新消息在恢复后不可见。这是数据分叉/可见性丢失，不是已物理删除全部数据。
- 已有保护：旧库、备份、原子写和迁移仍存在。既有迁移测试不覆盖“降级继续写入再恢复”的闭环。
- 最小建议：不要静默把旧快照切成可写主库；明确降级状态、恢复选择与两边增量识别。冲突策略须先确认，不直接覆盖任一库。
- 后续验证：临时目录执行“SQLite 写 A → 无 WASM 降级写 B → 恢复”，核对 A/B 都保留，并覆盖修改/删除冲突。

## BE-03 · P1 · 手动压缩与新运行没有共用互斥

**证据：** [startRun](electron/agent-host.ts#L861)、[manualCompact](electron/agent-host.ts#L963)、[整段替换消息](electron/db.ts#L568)。

- 适用：main 宿主，已有运行设置快照的会话。
- 触发：压缩正等待摘要，IM/另一窗口等入口同时提交新运行。
- 根因：manualCompact 只检查 s.run，但不占用运行互斥；startRun 仍可受理。压缩结束用旧 messages 生成替换内容，先删除再重插同会话消息。
- 影响：压缩期间新增的用户/助手消息可能被旧快照覆盖；事务原子性不能证明快照仍最新。
- 最小建议：压缩与 run 共用会话锁或队列，提交时复核版本。前端禁用发送按钮不能代替宿主跨入口控制。
- 后续验证：暂停摘要 Promise，压缩期间提交新任务，应明确排队/拒绝或安全合并，不能静默丢消息。

## BE-04 · P1 · 会话级事件序号与客户端全局去重冲突

**证据：** [独立计数器](electron/agent-host.ts#L200)、[序号生成](electron/agent-host.ts#L230)、[广播](electron/agent-host.ts#L249)、[全局缓冲/游标](src/lib/agent-client.ts#L69)、[去重](src/lib/agent-client.ts#L169)、[单例](src/lib/agent-client.ts#L236)、[补发](electron/agent-host.ts#L1007)。

- 根因：每个 HostSession 有独立 seq，广播不转换；单例客户端只有一个 lastSeq 和以 number 为键的 pending，不区分 sessionId。
- 触发示例：A 把客户端游标推进到 100，B 的 1～100 被当成重复丢掉；同序号也会发生 pending 键冲突。
- 影响：消息、运行状态、审批事件漏收，任务在跑但界面不更新或审批不可见；snapshot 同样复用一个 sinceSeq，不能可靠补回。
- 最小建议：统一为端到端全局单调序号，或按 sessionId 分别维护游标、缓冲和补发；不能只跳过去重判断。
- 后续验证：两会话交错 1/1/2/2 全送达；A 高序号后启动 B；断线补发；重复事件只应用一次。
- 范围说明：虽然消费方位于 src/lib，此项属于跨端协议修复，本轮不改。

## BE-05 · P2 · 桌面刷新会中止其他渠道后台流

**证据：** [窗口清理绑定](electron/main.ts#L779)、[宿主同用流代理](electron/agent-host.ts#L116)、[共享 inflight](electron/api-proxy.ts#L415)、[全局中止与 done](electron/api-proxy.ts#L511)。

- 触发：宿主/IM/WebUI 正在生成时，桌面主窗口刷新或销毁。
- 根因：所有渠道共享 inflight；窗口清理调用 abortAllApiRequests，不识别归属，并把请求标为 userAborted。
- 影响：应独立存活的任务也被截断；返回 done 可能使调用方误认不完整结果为正常结束。
- 最小建议：记录请求拥有者，窗口只清自己的请求，应用退出再全局清理；区分主动停止和意外中断。
- 后续验证：两类拥有者并发，刷新一个窗口只结束它的流，其他请求继续收到内容和正确结束信号。

## BE-06 · P2 · 删除待批/待答会话没有兑现等待 Promise

**证据：** [删除调用链（基线）](src/stores/chat-store.ts#L640)、[审批等待](electron/agent-host.ts#L576)、[问题等待](electron/agent-host.ts#L663)、[dropSession](electron/agent-host.ts#L1035)、[等待审批](src/agent-core/loop.ts#L969)。

- 适用：main 宿主；正在等待权限确认或问题答案时删除会话。
- 根因：dropSession abort 运行、清 timer、移除会话，却不调用 pending.resolve；等待 Promise 没接 abort，超时兜底也被清除。
- 影响：异步等待无法收尾。侧栏和 Map 删除不等于实际运行完成，闭包/外部等待者仍可能挂起。
- 最小建议：显式拒绝待批、空答案结束待答，再收尾移除；阻止迟到回调重建会话或写入消息。
- 后续验证：分别在待批/待答时删除，断言 Promise settle、timer 清理、数据库无迟到重建，而非只检查 Map。

## 待验证项（不计入六项）

[WebUI SSE 清理](electron/webui-server.ts#L668)部分使用 req.close。请求体结束与响应断开不等价，应基于当前 Electron/Node 版本模拟断连核实 res.close/连接归属。本轮未复现，不作为第七个确定缺陷。

## 已有验证和边界

第一阶段两套 tsc 通过，12 文件/132 用例通过，包含 db、webui-blocklist、webui-resync、agent-host-permission、preload-bridge。详细命令与数量见原报告第 4 节；这些测试通过不证明上述缺陷已消失，本轮前端修复也不构成后端验收。

观察到一次 `sqlite persist failed: ENOENT`：定时写盘与测试临时目录清理相撞的嫌疑，见 [测试清理](tests/db.test.ts#L21)。记为测试生命周期警告，未确认生产故障；WASM 缺失、拒绝审批及超时日志属于主动测试路径。

后续建议顺序：BE-01 能力边界 → BE-04 事件语义 → BE-03/06/05 并发与生命周期；BE-02 单独先确定恢复冲突策略。没有对后端实施修复、提交或推送。
