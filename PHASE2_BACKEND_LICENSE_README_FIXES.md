# 第二阶段修复记录：主后端 + 安装器协议 + README

- 记录日期：2026-11-08；项目版本 3.5.1。
- 基线：`main` / `bf1ea3e`（第一阶段审查时的提交）+ 第一阶段前端修复的未提交改动。
- 上游文档：[第一阶段报告](PHASE1_UI_UX_BACKEND_AUDIT.md)、[后端缺陷清单](BACKEND_AUDIT.md)。
- 本轮范围：BE-01～BE-06 六项后端缺陷全部实施修复；另核实并修复 1 项待验证项（BE-07）；安装器使用协议修乱码并更新内容；README 中英文双份刷新。
- **未提交、未推送**；未运行真实安装包安装流程，未做真实 Electron 窗口点击验收（见第 6 节）。

---

## 1. 后端六项缺陷：改了什么、为什么这么改

### BE-01 · P1 · 远程黑名单遗漏本机文件和 MCP 能力

**根因**：`ipcMain.handle` 被 monkey-patch 后所有 handler 自动进入 `handlerRegistry`，`/api/invoke` 过滤黑名单后直接调用；黑名单没有 `readFile` / `readFileBase64` / `writeFile` / `mcpCallTool`。

**改法**（`electron/webui-server.ts` + 配套链路）：

| 通道 | 处理 | 理由 |
| --- | --- | --- |
| `writeFile` | 进黑名单 | 远程视图不跑渲染层 Agent（Key 从不下发），没有正当调用方；封掉 `deleteFile` 之后再留它等于开了一扇「覆盖任意可写文件」的门 |
| `mcpCallTool` | 进黑名单 | 直接执行本机已连接的 MCP 工具，绕过 Agent 审批链，等价于「持 token 即可以用户身份执行任意已启用工具」 |
| `readFile` / `readFileBase64` / `readImageFileBase64` / `listDir` / `fileExists` | 不进黑名单，改为**默认拒绝 + 显式授权**（`REMOTE_FILE_CHANNELS` + `remoteFileAccess` 开关） | 工作台文件面板（`desktopOnly: false`）、VIBE 壁纸、审批变更预览在浏览器端确实要用这些通道，一刀切会砍掉既有功能；但这些通道接受任意绝对路径，`assertSafePath` 只挡 NUL/UNC/ADS/设备名，令牌泄漏即等于交出凭据文件 |

授权入口：桌面端「远程访问」弹窗新增「允许远程浏览本机文件」开关（与「允许局域网访问」并列），**默认关**；切换后重启 WebUI 生效（与局域网开关同一条重启路径）。服务器部署用 `CLERKBOX_WEBUI_ALLOW_FILE_ACCESS=1` 授权，默认不授权。

涉及文件：`electron/webui-server.ts`、`electron/main.ts`、`electron/preload.ts`、`src/lib/ipc-client.ts`、`src/types/ipc.ts`、`src/types/agent.ts`、`src/stores/settings-store.ts`、`src/components/remote/RemoteAccessDialog.tsx`、`src/i18n/locales/{en,zh-CN}.ts`。

### BE-02 · P1 · SQLite → JSON → SQLite 恢复形成数据分叉

**根因**：WASM 加载失败降级到 JSON 时，用的是迁移期留下的旧快照；恢复后只在「空库」时导入 JSON，降级期间的新增内容彻底看不见。

**改法**（`electron/db.ts`）：

1. **降级打标**：进入 JSON 引擎时算出降级元信息（降级时刻、进入降级时的 revision、当时 SQLite 文件的存在性/大小/mtime）。标记**不在降级那一刻写文件**——降级路径的既有不变量是「有现成的 JSON 就绝不碰它」（`tests/db.test.ts` 逐字节比对），标记随第一次真实写入才落盘；一次写入都没发生的降级没有增量要合并，也就不需要标记。
2. **删除留墓碑**：JSON 引擎的删除路径（删会话 / `deleteMessagesBefore` / `deleteMessagesFrom` / `clearMessages` / `compactMessages` 整段替换）把被删的 session id 与 message id 记进 `degradedTombstones`，否则恢复时无法区分「SQLite 有而 JSON 没有」是删掉的还是 SQLite 侧新增的。
3. **恢复时合并而不是只在空库导入**：`mergeDegradedJsonIntoSqlite()` 在 SQLite 打开后立即执行。两侧都是完整行集合，合并 = 按 id 取并集：SQLite 侧有、JSON 侧没有的（降级前写入的新历史）原样保留；只有同 id 冲突才比新旧（`updated_at` / `timestamp` 新者胜出），落败的一侧整行进冲突备份文件。墓碑在并集之后生效（墓碑优先），降级期间删掉的行不会在 SQLite 里复活。
4. **不丢任何文件**：合并前把原 JSON 原样复制成 `*.reconciled-<ts>.bak`；有冲突时另写 `*.conflicts-<ts>.json`；合并后把合并结果回写 JSON（让下一次降级拿到的不是更旧的快照）。任何一步抛错都 `ROLLBACK`，两侧文件都不删不改。
5. 合并失败不阻断启动：记日志后继续，SQLite 文件原地保留，下次启动重试。

### BE-03 · P1 · 手动压缩与新运行没有共用互斥

**根因**：`manualCompact` 只检查 `s.run`，压缩期间 `startRun` 仍可受理；压缩结束用开头的消息快照整段替换本会话消息，把压缩期间的新消息覆盖掉。

**改法**（`electron/agent-host.ts`）：

- `HostSession` 新增 `compacting` 标志，压缩与 run **共用同一把会话锁**：`startRun` 在 `s.run || s.compacting` 时按既有语义入队；`flushQueue` 在压缩期间不取队首，压缩结束时由 `manualCompact` 的 `finally` 放行。
- **提交前复核快照**：摘要生成完、落盘前重新读一次会话消息，与开头那份快照比对（`sameMessageSet`）；不一致（撤回、回滚、外部写入）就放弃这次压缩并提示，不拿旧快照覆盖。锁是主防线，复核是兜底。

### BE-04 · P1 · 会话级事件序号与客户端全局去重冲突

**根因**：宿主的 seq 是每个 `HostSession` 各自从 1 数起的，客户端却只有一个全局 `lastSeq` 和一张以 `number` 为键的 pending 表。A 会话把游标推到 100 之后，B 会话的 1~100 全被 `seq <= lastSeq` 判成重复丢掉。

**改法**（`src/lib/agent-client.ts`，宿主协议不动）：客户端改为**按 sessionId 分域维护游标、缓冲与补发**。每条 `AgentEvent` 都带 `sessionId`（见 `src/agent-core/protocol.ts`），分域有依据。带 sessionId 的补发用该会话自己的游标；不带 sessionId 的补发整环重放（`sinceSeq=0`），多会话下靠各会话自己的去重挡掉重复。退避重试会接着补同一个会话，不换目标。

选「分域」而不是「端到端全局单调序号」的理由：宿主的事件环是**按会话**维护的（`HostSession.ring`），全局序号要改动环裁剪、snapshot 补发与 pending 权限重发三处协议，跨端一致性风险大；分域只改客户端一侧，宿主协议零变更。

### BE-05 · P2 · 桌面刷新会中止其他渠道流

**根因**：所有渠道共用一张 `inflight` 表；窗口销毁/reload 调 `abortAllApiRequests()` 一刀切，并把请求标成 `userAborted`，于是接收端没了的请求回 `done`，调用方把半截回答当正常结束。

**改法**（`electron/api-proxy.ts` + 调用点）：

- `inflight` 的值改为 `{ controller, owner }`。归属：`wc:<webContents id>`（桌面窗口）、`host`（宿主/IM）、`webui`（SSE）。
- `abortApiRequestsForOwner(owner)` 只结束该归属的流；`bindApiProxyCleanup(win)` 只收这个窗口自己发起的流。
- **意外中断与主动停止分开**：归属清理不写 `userAborted`，于是 catch 分支回 `{error}` 而不是 `{done:true}`；只有用户主动 `abortChatStream` 才回 `done`。
- `abortAllApiRequests()` 保留给应用退出时的全局清理（当前无调用点，进程退出本身会收尾）。

### BE-06 · P2 · 删除待批/待答会话没有兑现等待 Promise

**根因**：`dropSession` 只 abort 运行、清 timer、删 Map，不调 `pending.resolve`；等待审批的 Promise 永不返回，ReAct 循环闭包与外部等待者一起悬挂；迟到的回调还会把用户删掉的会话复活。

**改法**（`electron/agent-host.ts`）：

- `dropSession` 先置 `s.dropped = true`（立碑），然后**显式兑现**：待批按拒绝 `resolve({approved:false, scope:'once'})`，待答按空答案 `resolve({})`，并清掉全部 timer。
- `emit` / `persistMessage` / `setQueue` / `startRun` / `flushQueue` 全部检查 `s.dropped`：会话已删后不再写库、不再广播、不再受理新运行——否则迟到的回调会把用户删掉的会话复活。
- 待批/待答不走 `settlePermission`，因此不会为已删会话写审计消息。

---

## 2. BE-07（原「待验证项」升格为确认缺陷）· P1 · SSE 断连不中止上游请求

第一阶段列过一条待验证项：WebUI 的 SSE 清理用 `req.close` 而不是响应关闭。

**实测结论（Node 24，Electron 42 的运行时）**：客户端断开时触发的是 `res` 的 `'close'`，`req` 的 `'close'` 不触发。两条 `/api/agent/events` 与 `/api/chat-stream` 都挂在 `req.on('close')` 上，等于**浏览器关掉标签页后上游模型请求继续跑完并计费**。

- 实测记录（一次性 Node 脚本，客户端 `destroy()` 后观察服务端事件）：`res close at +504ms`，`req close` 未触发。
- 改法：两处改挂 `res.on('close')`。

---

## 3. 安装器使用协议：乱码根因与内容更新

### 3.1 乱码根因（已实测定位，不是猜测）

- `build/license.txt` 与 `build/license.txt.tmpl` 是 **GBK 字节流、无 BOM**（`validUTF8=false`，GBK 解码正常）。
- electron-builder 的 `computeLicensePage` 只有**多语言**分支（`license_*.txt`）才会调 `convertFileToUtf8WithBOMSync` 补 BOM；自动探测到的**单文件** `build/license.txt` 原样交给 `MUI_PAGE_LICENSE`，不做任何转码。
- NSIS 靠 BOM 判定许可文本编码：无 BOM 时按**构建机 ANSI 代码页**解码。也就是说同一份协议在代码页 936 的机器上正常、在别的代码页（或开了「使用 Unicode UTF-8 提供全球语言支持」的 Windows）上就是乱码——换台机器打包就复现。

### 3.2 验证方法（真实编译 NSIS 安装器并比对字节）

用 electron-builder 缓存里的 `makensis.exe`（NSIS 3.0.4.1）编译一个只含 `LicenseData` 的探针安装器（`SetCompress off` 让数据块不压缩），再从 exe 里抠出许可文本那段字节、按 UTF-16LE 解码，与源文件逐字比对：

```
license.txt: bom=true validUTF8=true crlf=true bytes=6884
embedded head offset 55190
embedded chars 2719 expected chars 2719
FULL TEXT MATCH = true
replacement chars in embedded: 0
```

即：安装器里嵌进去的 2719 字协议与源文件**逐字相同**，零个替换字符（乱码的 U+FFFD）。

### 3.3 改动

- `build/license.txt.tmpl`：**GBK → UTF-8 with BOM**，内容按 3.5 的 Apache-2.0 口径重写（授权范围 / 第三方组件 / AI 与自动化特别声明 / 数据与隐私 / 免责声明 / 更新与终止 / 适用法律七节）。
- `scripts/sync-version.mjs`：生成管线从「latin1 字节替换」改成「读 UTF-8 → 替换版本号 → 统一 CRLF → 写 UTF-8 with BOM」。BOM 必须由这里写：electron-builder 的单文件分支不补。
- `build/license.txt`（生成物，不入版本库）已按新管线重新生成。
- `package.json` 的 `build` 增加 `extraResources`，把完整 `LICENSE` 随安装包分发。

内容上保留并补齐的是**安装时确实该讲清楚、而 Apache-2.0 不管**的部分：

- 第四段「AI 与自动化功能特别声明」：写审批的**有效期分档**（仅本次 / 本会话 / 本项目）、子 Agent 与工作流/定时任务/目标模式的**自主连续执行**、IM 与 WebUI 远程下发任务时**令牌与账号由用户自行保管**、不提供需专业资质的决策服务。
- 第五段「数据与隐私」：**可选的账号云同步**（端到端加密、密码仅存本地、密码丢失云端密文不可恢复、未启用则不上传）、WebUI 远程访问的暴露面提示、以及「版本迁移与存储引擎降级时会尽力保留既有文件副本，但不构成数据恢复承诺」——这一条正对应本轮修的 BE-02。
- 第六段免责声明补上数据丢失 / 文件被改 / 命令执行后果 / 凭据泄露等具体形态。
- 第七段补自动更新行为（会下载并运行安装程序、安装阶段需关闭正在运行的实例）。
- 落款日期从 2026年8月改为 2026年11月。

### 3.5 Apache-2.0 与安装器协议的矛盾：已按开源口径统一（2026-11-08 老板拍板）

仓库 `LICENSE` 是 **Apache-2.0**，`package.json` 的 `license` 字段与 README 徽章同为 Apache-2.0；但安装器里原来的协议写的是「仅限个人非商业用途、不得逆向工程、知识产权全部归 XMZF Studio」——**专有条款与同一份代码的 Apache-2.0 授权互相矛盾**。

老板口径：**都开源了，商业使用当然允许**。据此已把安装器协议改成 Apache-2.0 口径：

- 删除「仅限个人非商业用途」「不得逆向工程」「知识产权全部归 XMZF Studio」三条专有限制；
- 开篇直接写明「本软件以 Apache License, Version 2.0 开源授权发布」，并在第一节写清 Apache-2.0 授予的 复制 / 修改 / 合并 / 发布 / 分发 / 再许可 / 销售 各项权利，**商业使用无需另行申请**；
- 保留安装时必须让用户知道的产品条款（第三方组件、AI 与自动化特别声明、数据与隐私、免责声明、更新与终止、适用法律）——这些是 Apache-2.0 不管、但安装时确实该讲清楚的部分；
- 补第 1.5 条：向本项目提交贡献即按 Apache-2.0 授权；
- 商标按 Apache-2.0 第 6 条如实写：「本许可不授予「ClerkBox」等商标的使用权」，而不是自创一条禁止条款。

配套：`package.json` 的 `build` 增加 `extraResources`，把完整的 `LICENSE`（11KB 全文）随安装包分发到安装目录的 `resources/LICENSE`，让协议里「完整许可文本随安装包分发」这句话真的兑现——否则用户离线时拿不到 Apache-2.0 全文。

改后再次做字节级验证：安装器内嵌 **2344 字逐字一致，0 个 U+FFFD**，且含「商业使用无需另行申请」与 Apache-2.0 授权句。

---

## 4. README 刷新（中英文双份）

### 4.1 核实过的陈旧点（每一处都对着代码核过）

| 原文 | 现状（证据） | 处理 |
| --- | --- | --- |
| ReAct 循环「最多 100 轮」 | `MAX_REACT_ITERATIONS = 500`（`src/agent-core/loop.ts`） | 改为 500 轮 |
| 「内置 23 家供应商」 | `PROVIDER_PRESETS` 共 23 条，其中 `custom` 是自定义端点 | 改为「22 家供应商预设 + 自定义端点」 |
| 「定时任务：cron / 间隔双形态」 | 周期实为每天 / 工作日 / 每周 / 每月（`src/lib/scheduled-task.ts`） | 改正 |
| 「Harness 兼容：Codex / grok-build / DeepSeek」 | `HarnessMode = 'default' \| 'codex' \| 'grok-build' \| 'dsh' \| 'dsh-minimal' \| 'zcode'` | 补 Grok Build / ZCode，说明 dsh |
| 「会话历史：本地 JSON（按会话 ID 分文件）」 | 早已是 SQLite（sql.js）主库 + JSON 降级 | 改为 SQLite 描述 |
| 「路径校验：所有文件操作路径必须在当前工作目录内」 | `resolveToolPath()` 对绝对路径原样返回，`assertSafePath` 只挡穿越/UNC/ADS/设备名 | **按事实改正**（跨目录读写仍受权限引擎与审批模式约束） |
| 工具清单缺 6 个 | `read_image` / `search_memory` / `send_message_to_agent` / `question` / `todowrite` 都在 `src/lib/tool-registry.ts` 里注册 | 补齐并写明用途 |
| 平台徽章只写 Windows | `build.win` / `build.mac` / `build.linux` 三套目标都在 | 改为 Windows / macOS / Linux |
| 缺工作流编排、IM 机器人遥控两节 | 两项功能已上线 | 中文新增两节并补目录项；英文补齐 |
| 英文版缺 8 个章节（Git / 桌面操控 / 撤回回滚 / 界面模式 / 定时任务 / Harness / 工作流 / IM） | 对应中文都有 | 英文补齐并同步目录 |
| 路线图「已完成」缺 6 项新能力 | SQLite 化 / 权限规则持久化 / 工作流 / IM 等已上线 | 补齐（中英文） |

### 4.2 顺带补上的两条能力说明（都对着代码核过）

- **工作流编排**：工具面是 `create_workflow` / `save_workflow` / `resume_workflow`，脚本原语 `agent()` / `parallel()` / `phase()` / `log()`，脚本存 `<工作目录>/.clerkbox/workflows/`，续跑从 journal 复用已完成步骤。
- **IM 机器人遥控**：微信 / 飞书 / Telegram / 企业微信；凭据走 safeStorage；**手机端可以批准危险命令**（`electron/im-bots/index.ts` 的 `approval.resolve` 走 `{ remote: false }`，与 WebUI 的「远程不能批准」不是一回事），但批准范围只到「仅本次」。

### 4.3 WebUI 章节补的能力边界（与 BE-01 的实现一致）

- 远程默认不读本机文件，需显式打开「允许远程浏览本机文件」，并说明这条通道能按任意路径读文件。
- 远程不能替你在本机跑 Agent：编排、危险命令审批、撤回回滚、MCP 执行、Git 写操作全部桌面端专属；WebUI 也不下发 API Key。
- 服务器部署的两个环境变量：`CLERKBOX_WEBUI_AUTO=1`（自动启动）、`CLERKBOX_WEBUI_ALLOW_FILE_ACCESS=1`（授予远程文件读取，默认不授予）。

### 4.4 保密口径

两份 README 均未写入任何成本 / 毛利口径，也没有新增未经代码验证的功能描述、统计数字或徽章数据。

---

## 5. 本轮验证（都真跑了）

| 项目 | 命令 / 方法 | 结果 |
| --- | --- | --- |
| 主进程类型检查 | `npx tsc -p tsconfig.electron.json --noEmit` | 通过，无输出 |
| 应用与测试类型检查 | `npx tsc -p tsconfig.json --noEmit` | 通过，无输出 |
| 全量测试 | `npx vitest run` | **90 个文件 / 1375 通过 + 2 跳过**（1377 条），20.5s，退出码 0 |
| 新增用例 | `tests/db-degradation.test.ts` 5 条、`tests/agent-host-lifecycle.test.ts` 4 条、`tests/api-stream-ownership.test.ts` 4 条 | 全绿 |
| 扩充用例 | `tests/agent-client.test.ts` +4（多会话交错 / 高序号不吞低序号 / 去重语义不变）、`tests/webui-blocklist.test.ts` +4（写与 MCP 进黑名单 / 读通道受授权表约束 / 两道门互不覆盖） | 全绿 |
| 安装协议字节级验证 | `makensis.exe` 编译探针安装器 + 抠出数据块比对 | 2344 字逐字一致，0 个 U+FFFD（含「商业使用无需另行申请」与 Apache-2.0 授权句） |
| SSE 断连语义 | Node 24 一次性脚本（客户端 `destroy()`） | `res 'close'` 触发、`req 'close'` 不触发 |

已知噪声（非本轮引入）：`tests/db.test.ts` 偶发 `sqlite persist failed: ENOENT`（定时写盘与临时目录清理相撞）；computer-coordinates 自带 11 条 unhandled rejection。

---

## 6. 明确没做 / 未验收的事

- **未提交、未推送**：工作树停在未提交状态，等老板确认。
- **未跑真实安装包安装流程**：NSIS 探针验证的是「协议文本在安装器里被正确嵌入并解码」，没有真装一遍看许可页版面。
- **未做真实 Electron 窗口点击验收**：终检时已用独立配置目录（`--user-data-dir` 隔离，不抢用户实例的单实例锁、不碰用户数据库）真实启动了一个演示实例，日志确认 `ClerkBox v3.5.1 / chat store engine: sqlite / agent-host ready / im-bots ready`；并核对构建产物确实含新代码（`dist-electron/electron/preload.js` 含 `fileAccess`、`webui-server.js` 含文件授权门、`api-proxy.js` 含 `abortApiRequestsForOwner`），Vite 也在下发新的 i18n key。但「允许远程浏览本机文件」开关本身没有在窗口里点过，WebUI 文件面板在关闭该开关时的实际表现也未在浏览器里跑过。
- **未验证 IM 机器人在真实聊天账号上的端到端链路**：审批与提问的手机端通路读的是代码，未实机连。
- **未做多平台打包**：只验证了 Windows NSIS 的协议编码，macOS dmg / Linux AppImage 的许可页没有对应产物可比对。
- **BE-02 的合并策略**按「不丢任何一侧」设计，但**没有在真实用户数据上跑过迁移**（用的是临时目录构造的闭环）。
- 前一阶段遗留的界面验收项（真实窗口点击、中文输入法、软键盘、屏幕阅读器、focus-visible 环视觉）仍未做。

---

## 7. 改了什么文件（后端 + 协议 + 文档）

后端：`electron/webui-server.ts`、`electron/main.ts`、`electron/preload.ts`、`electron/api-proxy.ts`、`electron/agent-host.ts`、`electron/db.ts`、`src/lib/agent-client.ts`、`src/lib/ipc-client.ts`、`src/types/ipc.ts`、`src/types/agent.ts`、`src/stores/settings-store.ts`、`src/components/remote/RemoteAccessDialog.tsx`、`src/i18n/locales/en.ts`、`src/i18n/locales/zh-CN.ts`

协议与脚本：`build/license.txt.tmpl`、`scripts/sync-version.mjs`、`package.json`（新增 `extraResources` 分发完整 LICENSE；`build/license.txt` 为生成物，不入版本库）

文档：`README.md`、`README.en.md`、本文件

测试：新增 `tests/db-degradation.test.ts`、`tests/agent-host-lifecycle.test.ts`、`tests/api-stream-ownership.test.ts`；扩充 `tests/agent-client.test.ts`、`tests/webui-blocklist.test.ts`
