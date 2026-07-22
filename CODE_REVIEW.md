# ClerkBox 代码审查报告

> 审查时间:2026-07-17
> 审查范围:agent 流程 / IPC 与 electron 主进程 / UI 组件 / 压缩与记忆模块
> 状态:批次 3 已完成，批次 4 待开始

## 一、高优先级 Bug(立即修复)

### 数据完整性

#### B1. `compactSession` DB 数据损坏
- **位置**:`src/stores/chat-store.ts:233-260` + `electron/main.ts:581-597`
- **问题**:
  - `compactSession` 调用 `ipc.dbDeleteMessagesBefore(sessionId, deleteBeforeId)`,其中 `deleteBeforeId = compactionResult.boundaryMessage.id`
  - 但 `boundaryMessage` 是新创建的消息(`compact.ts:485-497`),其 ID 不在 DB 中
  - `dbDeleteMessagesBefore` 实现:`const idx = msgs.findIndex(m => m.id === beforeId); if (idx === -1) return` —— 找不到就直接 return,什么都不删
  - 随后 `compactSession` 对所有 `newMessages`(含已存在于 DB 的 `keptMessages`)调用 `dbAddMessage`,而 `dbAddMessage` 是纯 `push` INSERT,不是 UPSERT
  - 后果:DB 中旧的摘要前消息没被删除、保留消息被复制一份、新消息再追加一份。重启 `loadFromDb` 后会话历史错乱、体积翻倍
- **建议**:`dbAddMessage` 改为 UPSERT;`compactSession` 只写入 `boundary + summary + fileAttachments`,keptMessages 跳过;或先 `dbDeleteAllMessages(sessionId)` 清空再批量写入

#### B2. 主 agent 流式回调无节流,触发 DB 写入风暴
- **位置**:`src/hooks/use-agent.ts:709-716`
- **问题**:主 agent 的 `onContent`/`onThinking` 每个 SSE chunk 都调用 `updateMessage`,而 `updateMessage` 每次都同步写 DB(整个 JSON 文件全量重写)。一次 10K 字符的回答会触发上千次 zustand set + DB write + React re-render
- **对比**:子 agent 的同名回调(`use-agent.ts:1140-1153`)有 50ms 节流。主 agent 缺失节流是不一致的实现
- **建议**:给主 agent 的 `onContent`/`onThinking` 加上与子 agent 相同的 50ms 节流,并在 `onFinish` 时强制 flush 一次最终内容

#### B3. `abort` 与 `sendMessage.finally` 竞态
- **位置**:`src/hooks/use-agent.ts:567-623`(sendMessage)+ `src/hooks/use-agent.ts:1002-1009`(abort)
- **复现路径**:
  1. 用户发消息 A,`abortRef.current = controllerA`
  2. 用户点 abort,`abort()` 立即 `abortRef.current = null`
  3. 用户立刻发消息 B,`abortRef.current = controllerB`(通过了 line 570 的并发检查)
  4. 消息 A 的 `finally` 块执行 `abortRef.current = null`,把 `controllerB` 的引用也清掉了
  5. 此后用户点 abort B 时 `abortRef.current` 为 null,abort 不生效,B 无法中断
- **建议**:`finally` 改为 `if (abortRef.current === controller) abortRef.current = null`;`abort()` 不要主动清 `abortRef.current`,交给 `finally` 处理

#### B4. abort 后 `reactLoop`/`runSubAgent` 仍执行工具调用
- **位置**:`src/hooks/use-agent.ts:736-892`(主 agent)、`use-agent.ts:1172-1260`(子 agent)
- **问题**:`parseStream` 返回后,代码没有检查 `controller.signal.aborted`,直接进入"解析 toolCalls → updateMessage → 并行执行 toolCalls"流程。如果用户在流式中途点 abort,模型已返回但尚未执行的工具调用仍会被执行,包括 `execute_command`、`write_file`、`search_replace` 等有副作用的工具
- **建议**:在 `parseStream` 返回后、解析 toolCalls 之前加 `if (controller.signal.aborted) return`(主 agent)和 `if (subController.signal.aborted) break`(子 agent)

#### B5. 子 agent abort 时状态被标 'completed' 而非 'aborted'
- **位置**:`src/hooks/use-agent.ts:1080-1082, 1262-1266`
- **问题**:`for` 循环开头 `if (subController.signal.aborted) break` 中断后,会掉到循环外的 "达到 maxTurns" 分支,调用 `completeSubAgentRun`,状态被记为 `completed`,并把部分结果当成功结果返回给父 agent
- 同时:`abortSubAgentRun`(`agent-runs-store.ts:96-109`)定义了但全项目从未调用(dead code)
- **建议**:循环 break 后先判断 `if (subController.signal.aborted)`,是则调 `abortSubAgentRun` 并返回 `'[aborted]'`;`catch` 块中判断 `err.name === 'AbortError'` 区分 abort 与真实失败

#### B6. 子 agent 卡片在 `findAgent` 失败时成为永久孤儿
- **位置**:`src/hooks/use-agent.ts:840-857`(spawnSubAgent 回调)+ `use-agent.ts:1042-1045`(runSubAgent 入口)
- **问题**:`spawnSubAgent` 回调先 `addMessage` 把 `isSubAgentCard` 卡片写入 store+DB,再调 `runSubAgent`。但 `runSubAgent` 的 `const agent = await findAgent(...)` 在 try 块外,如果 agent 类型不存在直接 throw,不会执行 `addSubAgentRun`。结果:卡片已持久化到 DB,但 `agent-runs-store` 里没有对应 run,卡片永远无法移除
- **建议**:先 `findAgent` 验证类型存在再插卡片;或在 catch 中把卡片消息从 store/DB 删除

### 安全漏洞

#### S1. `fetchWithBrowser` 关闭 `webSecurity: false`
- **位置**:`electron/main.ts:962-988`
- **风险**:隐藏 BrowserWindow 的同源策略被关闭。`webFetch` IPC handler 直接把 `targetUrl` 透传给 `w.webContents.loadURL(targetUrl)`,且 `targetUrl` 来自渲染进程、AI 工具调用甚至 `web_search` 结果链接,无任何 URL scheme 校验
  - 加载 `file:///C:/...` 时,页面脚本可读取整个文件系统任意文件并外传
  - 加载 `http://192.168.1.1/` 等内网地址时,可对路由器/内网服务发起 SSRF
  - `executeJavaScript` 在该 origin 上下文执行,页面可污染 `document.body.innerText`,形成 prompt injection 链
- **建议**:`webSecurity: true`;显式校验 `targetUrl` 仅允许 `http:`/`https:`;若必须放宽混合内容,用 `allowRunningInsecureContent: true` 而不是关闭整个 webSecurity

#### S2. `removeSkillDir` slug 路径遍历导致任意目录删除
- **位置**:`electron/main.ts:611-616`
- **风险**:`slug` 未做任何清洗。`path.join` 不会规范化 `..`。若 `slug = "../../.."`,`skillDir` 解析为 `projectDir` 的祖先目录,`fs.rmSync(..., { recursive: true, force: true })` 会递归删除整棵目录树
- **建议**:校验 slug 仅匹配 `/^[a-zA-Z0-9_-]+$/`;用 `path.normalize` 后断言结果仍位于 `.clerkbox/skills/` 之内

#### S3. `readFile` / `writeFile` 任意文件读写 + 无大小限制
- **位置**:`electron/main.ts:137-144`
- **风险**:
  - 路径与内容完全由渲染进程控制,无白名单/工作目录约束。XSS 或被妥协渲染进程可读 `~/.ssh/id_rsa`、`%APPDATA%\Microsoft\Credentials\*` 等,可写 `C:\Users\<u>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\evil.bat` 等实现持久化
  - `readFile` 用 `fs.readFileSync` 同步阻塞主进程,且无大小上限,读 10 GB 文件即 OOM 崩溃
  - `writeFile` 无大小上限,可填满磁盘;还会自动 `mkdirSync` 递归创建目录到任意路径
- **建议**:主进程侧校验 `filePath` 必须落在 `session.workingDir` 之内;`readFile` 加 `MAX_READ_LENGTH` 截断;`writeFile` 限制 content 长度

#### S4. `executeCommand` / `executeCommandWithShell` 任意命令执行
- **位置**:`electron/main.ts:156-186`
- **风险**:命令字符串直接拼接到 shell 命令中,经典命令注入模式。`isDangerousCommand` 仅在渲染进程侧生效,被妥协渲染进程可直接 `ipcRenderer.invoke('executeCommandWithShell', 'powershell -enc <base64>')` 绕过所有检查
- **建议**:主进程对 `command` 做基本校验(拒绝 `-enc`、`Invoke-Expression` 等);设置 `maxBuffer` 与 `env` 沙箱;校验 cwd 在 workingDir 之内

#### S5. plan 模式写路径白名单可绕过
- **位置**:`src/hooks/use-agent.ts:957-962`
- **问题**:判断条件 `path.includes('.clerkbox') && path.includes('plan')` 是子串包含,允许写到任何同时含这两个字符串的路径。例如 `D:\project\.clerkbox\plan-evil\malicious.md` 或 `C:\Users\x\.clerkbox\plan\..\other\exploit.md`(经 `..` 拼接后仍含 'plan' 子串),都可绕过"仅允许写 `.clerkbox/plan/`"的限制
- **建议**:用 `path.resolve` 规范化后,严格比较是否落在 `<workingDir>\.clerkbox\plan\` 之下(用 `path.relative` 判断不以 `..` 开头)

#### S6. `openExternal` 无 URL scheme 校验
- **位置**:`electron/main.ts:113-115`
- **风险**:`shell.openExternal(url)` 在 Windows 上接受任意协议处理器。`ms-msdt:`、`search-ms:`、`vbscript:` 等曾多次被 CVE 利用(Follina 等)
- **建议**:校验 `url` 必须以 `http://` 或 `https://` 开头,否则拒绝

#### S7. 主窗口 `sandbox: false`
- **位置**:`electron/main.ts:36`
- **建议**:改为 `sandbox: true`,preload 改用 contextBridge API

#### S8. 主进程无全局 `unhandledRejection` / `uncaughtException` 处理
- **位置**:`electron/main.ts`(全文)
- **建议**:加全局兜底 + dialog 调用前校验 `mainWindow` 非空

#### S9. `fetchSkillMd` 拉取的 SKILL.md 存在 prompt injection 风险
- **位置**:`electron/main.ts:707-760`
- **风险**:`fetchSkillMd` 从 GitHub raw 拉任意内容,验证仅 `content.includes('---') && content.includes('name:')`,验证极弱。该内容会被写入 `.clerkbox/skills/<slug>/SKILL.md`,然后被 AI `read_file` 读入 system prompt
- **建议**:拉取后做更严格的结构校验;UI 上提示用户该 skill 来自外部,需人工审阅 SKILL.md 后再激活

### UI 渲染

#### U1. `MessageItem.tsx` ToolCallBar 违反 Rules of Hooks
- **位置**:`src/components/chat/MessageItem.tsx:218-221`
- **问题**:`ToolCallBar` 在第 220 行 `if (toolCall.name === 'spawn_agent') return null` 早返回,然后在第 221 行才调用 `useState`
- **建议**:把 `useState` 移到早返回之前

#### U2. `MessageItem.tsx` Markdown 表格解析逻辑有 bug
- **位置**:`src/components/chat/MessageItem.tsx:470, 579-585`
- **问题**:`isTableLine` 判断恒为真;`closeTable` 第 470 行跳过前两行,但代码从未校验第 1 行是否真的是 `| --- |` 分隔符,无分隔符的两行表格会丢数据
- **建议**:`isTableLine` 应配合"下一行是分隔符"判断;`closeTable` 应在第 1 行非分隔符时回退为普通段落渲染

#### U3. `MessageList.tsx` 自动滚动会强制把用户拉回底部
- **位置**:`src/components/chat/MessageList.tsx:158-160`
- **问题**:`useEffect(() => { bottomRef.current?.scrollIntoView(...) }, [messages, isStreaming])` 没有"用户是否在底部附近"的判断
- **建议**:在 scrollRef 上监听 scroll 事件,维护 `isNearBottom` ref(距底部 < 100px 才为 true),只在 `isNearBottom` 时执行 scrollIntoView

---

## 二、中等优先级问题

### 逻辑/状态

#### M1. 子 agent 与主 agent 共用 TokenTracker,usage 互相污染
- **位置**:`src/hooks/use-agent.ts:122, 1084, 1169`
- **问题**:同一 `tokenTrackerRef.current` 被主 agent 与子 agent 共用。子 agent 的 `recordUsage(usage)` 会覆盖主 agent 的 `lastUsage`,导致 token 估算严重失真
- **建议**:子 agent 应使用独立的 `new TokenTracker()` 实例

#### M2. 压缩成功后未重置 TokenTracker
- **位置**:`src/hooks/use-agent.ts:670-683`
- **问题**:压缩后 `conversationMessages` 已替换,但 `tokenTrackerRef.current.lastUsage` 仍是压缩前的 `prompt_tokens`,下次迭代 `currentTokenCount > AUTO_COMPACT_THRESHOLD` 仍然成立,再次进入 compactConversation 抛 "Not enough messages to compact"
- **建议**:在 line 676 `sessionReadFilesRef.current = new Map()` 之后追加 `tokenTrackerRef.current.reset()`

#### M3. `agent-runs-store.clearSession` 是 dead code
- **位置**:`src/stores/agent-runs-store.ts:113-118`
- **问题**:子 agent 的完整消息历史通过 `persist` 中间件写入 localStorage,会话一多极易超出 5-10MB 配额
- **建议**:`chat-store.deleteSession` 末尾调 `useAgentRunsStore.getState().clearSession(id)`

#### M4. 应用重启后 `running` 状态的子 agent 永远卡住
- **位置**:`src/stores/agent-runs-store.ts:120-124`
- **建议**:应用启动时把所有 `running` 状态批量改为 `aborted`

#### M5. 子 agent 跳过 `isDangerousCommand` 检查
- **位置**:`src/hooks/use-agent.ts:933-936`
- **问题**:`checkToolPermission` 在检测到 `allowedTools || disallowedTools`(即子 agent 模式)时直接 `return { allowed: true }`,跳过 `isDangerousCommand` 检查
- **建议**:子 agent 模式下仍执行 `isDangerousCommand` 检查

#### M6. `callAPI` 的 120s timeout 会 abort 整个 ReAct 循环的 controller
- **位置**:`src/hooks/use-agent.ts:292-307`
- **建议**:在 `callAPI` 内部创建一个独立的 `AbortController` 用于 timeout,通过 `AbortSignal.any` 组合

#### M7. `compactSession` 重新写入 keptMessages 时丢失 `is_sub_agent_card`/`sub_agent_id` 字段
- **位置**:`src/stores/chat-store.ts:247-260`
- **建议**:`compactSession` 的 `dbAddMessage` 调用补上 `is_sub_agent_card` 和 `sub_agent_id` 字段

#### M8. `permission-engine.checkPermission` 是死代码
- **位置**:`src/lib/permission-engine.ts:39-64`
- **建议**:删除 `checkPermission`,或把 `checkToolPermission` 的核心逻辑迁移到 permission-engine 中

#### M9. `DANGEROUS_PATTERNS` 多个绕过路径
- **位置**:`src/lib/permission-engine.ts:14-33`
- **问题**:fork bomb 正则不匹配 `:(){ :|:& };:`;只拦 `| sh` 不拦 `| bash`、`| python`、`| node`;`Stop-Computer`、`ri -re -fo`、`del /f /s /q` 未匹配;`Invoke-Expression` 别名 `iex` 可绕过
- **建议**:补全危险命令模式;从黑名单改为白名单 + 显式用户确认

#### M10. `dbAddMessage` 无去重 + `dbUpdateMessage` 全表扫描
- **位置**:`electron/main.ts:533-573`
- **建议**:`dbAddMessage` 加 id 去重;维护 `id → {sessionId, idx}` 索引;或迁到 SQLite

#### M11. skills 写盘失败静默
- **位置**:`src/stores/skills-store.ts:76, 81, 173`
- **问题**:`.catch(() => {})` 吞掉所有错误。UI 状态已切换,但磁盘没写成功
- **建议**:catch 里 `console.error` 并回滚 UI 状态;或让 ipc 返回成功/失败标志

#### M12. `updateMemoryIndex` 并发写入竞态
- **位置**:`electron/main.ts:399-430`
- **建议**:为 memory 文件操作也加 `enqueueMemWrite` 序列化队列

#### M13. `webSearch` 用正则解析 cn.bing.com HTML,健壮性差
- **位置**:`electron/main.ts:771-808`
- **建议**:用 `cheerio`/`linkedom` 等真正的 HTML parser,或降级到 DuckDuckGo HTML

#### M14. 子代理没有真正的进程级 / IPC 级隔离
- **位置**:`src/hooks/use-agent.ts:1036-1274`
- **建议**:主进程维护 `{sessionId, agentId, allowedTools}` 映射,IPC handler 入口校验 caller 身份

### 性能

#### P1. `MessageItem` 未 memo,流式时全量重渲染
- **位置**:`src/components/chat/MessageItem.tsx:634`
- **建议**:`export default React.memo(MessageItem)`

#### P2. `MarkdownContent` 未 memo,`renderMarkdown` 每次 render 都重算
- **位置**:`src/components/chat/MessageItem.tsx:440-443`
- **建议**:`useMemo` + `React.memo`

#### P3. `MessageList.groupIntoTurns` 未 memo + `TurnPanel` 未 memo
- **位置**:`src/components/chat/MessageList.tsx:73, 166`
- **建议**:`useMemo` + `React.memo`

#### P4. `ThinkingHeader` 在流式时反复创建/销毁 setInterval
- **位置**:`src/components/chat/MessageItem.tsx:362-398`
- **建议**:拆成两个 effect:状态标记 effect + tick effect

#### P5. `Buffer.concat([data, chunk])` 循环拼接 O(n²)
- **位置**:`electron/main.ts:852-857`
- **建议**:用 `chunks.push + concat` 一次性合并

#### P6. `scanMemoryEntries` 读 200 个文件全文入内存
- **位置**:`electron/main.ts:287-318`
- **建议**:改异步 + 流式读取 + 单文件大小上限

#### P7. token 估算三处重复实现,均不处理 emoji 与扩展 unicode
- **位置**:`src/lib/compact.ts:184-201, 547-552`、`src/lib/token-tracker.ts:52-57`、`src/hooks/use-agent.ts:320-324, 332-346`
- **建议**:抽到 `src/lib/token-estimate.ts` 单一实现;对 emoji 区段单独加权;或集成 `gpt-tokenizer` 走真实 BPE

#### P8. `MAX_REACT_ITERATIONS = 999` 过大
- **位置**:`src/hooks/use-agent.ts:116`
- **建议**:降到 50-100,或按 token 预算退出

---

## 三、低优先级 / 代码质量

- **L1**. `reactLoop` 中 `workingDir` 变量被 shadow(`use-agent.ts:633, 806`)
- **L2**. `buildAPIMessages` 在默认参数中调用 `useSkillsStore.getState()`(`use-agent.ts:433`)
- **L3**. `reactLoop` 可能写入空 assistant 消息(`use-agent.ts:755-765`)
- **L4**. `callAPI` 错误信息把整个响应体塞进 Error.message(`use-agent.ts:309-311`)
- **L5**. `parseFrontmatter` 用单行正则提取字段,不支持 YAML list / multiline string(`main.ts:258-284`)
- **L6**. `Math.random()` 生成 ID(`use-agent.ts:134, 842, 1047`)
- **L7**. `skills-registry.ts` 是死代码,可删除
- **L8**. `model-presets` 中 Claude 3.5 Sonnet 的 baseUrl 不兼容(`/v1` 非 OpenAI 兼容端点)

---

## 四、可优化方案

### 架构层
1. 统一 token 估算 → 抽出 `src/lib/token-estimate.ts` 单一实现,集成 `gpt-tokenizer` 走真实 BPE
2. DB 迁移到 SQLite(`sql.js` 已在依赖却没用)→ 替代 JSON 文件全量读写,加 schema 版本字段、消息 ID 索引
3. `CompactionResult` 增加 `messagesToKeep` 字段,避免调用方重复计算
4. `dbAddMessage` 改为 UPSERT
5. 权限引擎收敛 → 删除 `permission-engine.checkPermission` 死代码,统一维护
6. 子代理 IPC 真隔离 → 主进程维护 `{sessionId, agentId, allowedTools}` 映射

### 性能层
7. 主 agent 流式回调加 50ms 节流 + `onFinish` 强制 flush
8. `callAPI` 用独立 timeout controller + `AbortSignal.any` 组合
9. `finally` 用 controller 身份比对
10. `MessageItem`/`MarkdownContent`/`TurnPanel` 全部 `React.memo` + `useMemo`
11. `groupIntoTurns` 用 `useMemo`
12. `ThinkingHeader` 拆为两个 effect
13. `Buffer.concat` 改用 `chunks.push + concat`
14. `scanMemoryEntries` 改异步 + 只读 frontmatter
15. `callAPI` 错误信息截断到前 500 字符

### 安全层
16. 所有路径型 IPC 入口校验 `path.resolve` 后必须落在 `session.workingDir` 内
17. slug 严格校验 `/^[a-zA-Z0-9_-]+$/`
18. `fetchWithBrowser` 改 `webSecurity: true` + URL scheme 白名单
19. `openExternal` 仅允许 http/https
20. 加 CSP 头 + 全局 `unhandledRejection`/`uncaughtException` 兜底
21. `sandbox: true` + preload 改用 contextBridge
22. `fetchSkillMd` 拉取后做严格结构校验 + UI 提示外部来源
23. `executeCommand*` 主进程侧拒绝 `-enc`/`Invoke-Expression`/`iex` 等
24. `DANGEROUS_PATTERNS` 补全
25. plan 模式白名单用 `path.relative` 判断不以 `..` 开头

---

## 五、可增加的功能

### 核心功能
1. 会话分支(fork):从某条消息分叉出新会话
2. 消息编辑重发:编辑已发出的 user 消息后重新生成
3. 多模型并行对比:同一 prompt 并发发给多个模型
4. 工具调用回放:把一次 ReAct 循环的所有工具调用保存为可复用"工作流"
5. 子代理工作流编辑器:可视化编排多个子代理的依赖关系
6. 断点续传:流式输出中断后可从断点继续
7. 导出会话:Markdown / JSON / PDF 导出
8. 会话搜索:跨会话全文搜索(SQLite FTS5)
9. 变量与模板:用户预设 prompt 模板,支持 `{{variable}}` 占位

### 子代理系统
10. 子代理并行执行:`spawn_agent` 支持批量派生
11. 子代理结果缓存:相同输入的子代理结果缓存复用
12. 子代理取消按钮:在 `SubAgentCard` 上加取消按钮
13. 子代理权限分级:不同 agent 配置不同的 IPC 权限白名单

### Skills 系统
14. Skills 在线市场 UI 增强:评分、评论、版本更新提示
15. Skills 本地签名校验:防止 SKILL.md 被篡改
16. Skills 热重载:编辑 SKILL.md 后自动重新注入 system prompt

### UX 功能
17. 消息收藏与置顶
18. 代码块语法高亮 + 一键复制 + 折叠
19. 思考过程 diff 视图
20. 快捷键体系:Ctrl+K 命令面板、Ctrl+L 清空、Esc 中断等
21. 多窗口:多会话并行(独立 BrowserWindow)
22. 通知系统:长任务完成后系统通知
23. Token 用量仪表盘
24. 暗色/亮色主题切换
25. 国际化 i18n

---

## 六、UI 建议

### 必修(影响功能/可访问性)
1. `SubAgentCard` 改 `<button>` 或加 `role="button" tabIndex={0} onKeyDown`
2. `SubAgentDetailPanel` 固定 480px 改 `w-[min(480px,40vw)]`,主聊天区加 `min-w-0`
3. `VibeCustomizeMenu` 加 `role="dialog" aria-modal="true"` + Escape 关闭 + 焦点陷阱
4. `SubAgentDetailPanel` 加 Escape 关闭 + 焦点移入
5. 所有折叠按钮加 `aria-expanded`/`aria-controls`;图标按钮加 `aria-label`
6. `ChatInput` 下拉菜单加 `role="menu"`/`role="menuitem"` + 方向键导航
7. `ThinkingShimmer` 加 `role="status" aria-live="polite"`
8. `MessageItem` markdown 链接 `rel="noopener noreferrer"`

### 视觉/布局
9. `MessageItem` 消息气泡宽度改 `max-w-[min(90%,80ch)]`
10. `ChatInput` welcome/normal 模式统一 `max-w-3xl` 或加 `transition-all`
11. `VibeMusicPlayer`/`VibeControls` 多个 fixed 改 flex 容器 + gap
12. `VibeBackground` 隐藏 img 用 `sr-only` 替代 `hidden`
13. `FileTree` 文件行去掉 `cursor-pointer` 或加 onClick
14. `FileTree` 跨平台路径分隔符

### 体验优化
15. `MessageList` 自动滚动加 `isNearBottom` 判断
16. 流式时光标动画/打字机效果
17. `SubAgentCard` 状态图标 + 颜色统一规范
18. 加载/错误状态加骨架屏或占位
19. `SubAgentCard` 的 `statusConfig` 提到模块顶层常量
20. 代码块主题跟随 VIBE 模式

---

## 七、修复批次顺序

| 批次 | 内容 | 状态 |
|---|---|---|
| **批次 1**(立即) | B1/B2/B3/B4 + S1/S2/S3/S4/S5/S6 | 已完成 |
| **批次 2**(本周) | B5/B6 + M1/M2/M3/M4/M5/M6/M7 + U1/U2 | 已完成 |
| **批次 3**(下周) | S7/S8/S9 + M8/M9/M11/M12/M13/M14 + U3 + P1-P8 | 已完成 |
| **批次 4**(迭代) | UI 可访问性必修项(U4-U8) + M10 + L1/L3/L4/L7 | 已完成 |
