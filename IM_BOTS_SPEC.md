# IM Bots（微信 / 飞书遥控）实施规格

> 状态：已批准实施（2026-10-02）。首发渠道：**微信 + 飞书**。
> 参考实现：ZCode v3.14.3 开源码（Apache-2.0，本地 `D:\ZCode\packages\services\src\bots\`），本文中的协议细节均已与其互证。

## 1. 目标与非目标

**目标**：在 ClerkBox 桌面端接入微信（iLink/ClawBot 官方接口）与飞书（开放平台长连接）两条 IM 通道。用户在 IM 里与 bot 私聊，即可远程驱动 ClerkBox 的会话：发任务、收结果、切换会话/工作目录、忙时自动排队。全程**不需要任何自建服务器**（两通道均为客户端出站长连接/长轮询）。

**非目标（本期不做）**：群聊（ZCode 同样只支持私聊）；Telegram/Webhook/Discord/企业微信/钉钉；飞书流式卡片（CardKit）；IM 内审批权限请求（本期只做「等待审批」通知）；会话列表渠道徽标（P2）；自动化任务结果回推。

## 2. 总体架构

```
渲染层                          主进程（electron/）
┌──────────────────┐   IPC   ┌─────────────────────────────────────────┐
│ RemoteAccessDialog│ ──────→ │ im-bots/index.ts   服务生命周期+IPC 注册   │
│  ├ 左：WebUI 卡片 │         │   ├ core.ts        路由/绑定/命令/状态机   │
│  └ 右：IM 渠道卡  │ ←────── │   ├ session-bridge.ts  会话桥(→agent-host)│
│     (微信/飞书)   │ bots:事件│   ├ weixin.ts      iLink 协议+长轮询      │
│ BotsDialog       │         │   ├ feishu.ts      Lark SDK WS 长连接     │
│  (主从管理界面)   │         │   └ storage.ts     config/state 文件      │
└──────────────────┘         └─────────────────────────────────────────┘
                                       │
                    AgentSessionManager.handleCommand / registerAgentEventSink
                                       │
                                    SQLite 会话（与桌面端/WebUI 同一套）
```

## 3. 数据模型

### 3.1 配置文件 `userData/im-bots/bots-config.json`（zod strict，version 1）

```ts
BotConfig = {
  id: string                  // nanoid
  provider: 'weixin' | 'feishu'
  name: string                // 显示名
  enabled: boolean
  credentialRef: string       // clerkbox-credentials.json 中的 key（safeStorage 加密）
  // weixin: { botToken }；feishu: { appId, appSecret }
  defaultWorkDir?: string     // 绑定的工作目录（空 = 首次 /workspace 或用最近会话目录）
}
BotsConfigFile = { version: 1, bots: BotConfig[] }
```

凭据复用 main.ts 既有 `readCredentialStore/writeCredentialStore`（`electron/main.ts:542`，safeStorage 加密）。credential id 命名 `bot-<provider>-<botId>`，符合既有 `assertCredentialId` 白名单 `[A-Za-z0-9._-]`，**无需改动该函数**。

### 3.2 状态文件 `userData/im-bots/bots-state.json`（zod strict，version 1）

```ts
ActorKey = `${botId}:${provider}:${providerUserId}:${chatType}`   // chatType 恒为 'private'
ChatContext = {
  actorKey: string
  mode: 'draft' | 'task'
  activeSessionId?: string      // 对应 ZCode activeTaskId
  workDir?: string              // 当前绑定工作目录（本聊天身份可单独 /workspace 切换）
  weixinGetUpdatesBuf?: string  // 微信长轮询游标
  weixinActivatedAt?: number
  updatedAt: number
}
BindCode = { code: string; botId: string; expiresAt: number }    // TTL 30s，单条有效
RuntimeStatus = { botId: string; state: 'idle'|'starting'|'polling'|'connected'|'error'|'disabled'; message?: string }
BotsStateFile = { version: 1, contexts: ChatContext[], pendingBinds: BindCode[], bindings: {actorKey, botId, providerUserId, displayName?}[] }
```

两文件读写统一走 `storage.ts`：原子写（tmp + rename）、损坏时备份 `.bak` 后重建、启动时静默迁移。

## 4. 会话桥（`session-bridge.ts`，对接 agent-host）

复用 `AgentSessionManager` 与 `ChatStore`，**不做 IM 专属会话存储**：

1. **建会话**：入站消息在 draft 态 → `store.createSession(row)`（id=nanoid、title='新会话'、working_dir=default_work_dir=绑定的 workDir、created_at/updated_at=now）→ 渲染层经既有刷新机制自然可见。
2. **发消息**：`manager.handleCommand({ type:'run', sessionId, content, settings }, { remote:false })`。
3. **settings 供给**：宿主不持有全局设置（靠渲染层 run 指令快照）。改动：`AgentSessionManager.startRun` 在 `!meta.remote` 时额外记录 `lastLocalSettings`（新增私有字段 + 只读 getter）。bot 建 run 时优先用该快照；冷启动还没有任何快照时，bot 回复「请先在桌面端完成一次对话以初始化模型配置」。**实施修正（2026-10-03）**：宿主默认 `mode=renderer`（P6 未切），桌面本地 run 不经过主进程，上述挂载点收不到快照——新增 `agent:push-settings` 通道：渲染层 settings-store 在凭据水合完成与任何设置变更时把 AgentSettings 子集推给主进程（`noteLocalSettings`）；远程界面推送被黑名单 + handler 内 `event===null` 拒收双重防御。main 模式下 startRun 挂载点继续兜底，两来源同字段。
4. **完成感知**：`registerAgentEventSink` 订阅全量事件，过滤本桥接会话：`run.completed` / `run.aborted` / `run.status(status:'idle')` → 取该会话最新 assistant 消息（`store.getMessages` 尾部）回推 IM。长文按 3500 字符分段发送。
5. **忙时排队**：会话 `s.run` 存在（用 `manager.inspect()` 或 run 指令自动并入队列的既有语义）→ 直接 `handleCommand({type:'queue.enqueue', item})`，复用宿主 FIFO 与渲染层排队 UI，**零额外实现**。
6. **abort 语义**：`/new` 在运行中→拒绝（提示先停止或稍后）；本期 IM 不提供停止命令（P2）。

## 5. 微信通道（`weixin.ts`，移植 ZCode `weixinProvider.ts` + `weixinRegistration.ts`）

- 端点基址 `https://ilinkai.weixin.qq.com`，协议前缀 `/ilink/bot`，`channel_version: '2.0.0'`；媒体 AES-128-ECB/PKCS7（node:crypto）；请求超时 90s。
- **登录**：`/get_bot_qrcode?bot_type=3` → 展示二维码 → `/get_qrcode_status` 长轮询（wait/scanned/confirmed/expired 四态）→ confirmed 拿 `bot_token` + `baseurl`（登录态可能重定向 baseurl）→ bot_token 存 credential store。
- **收**：`/getupdates` 长轮询（~35s 服务端挂起），游标 `get_updates_buf` 持久化在 state；`ret:-14` 会话过期 → 置 error 状态提示重新扫码。
- **发**：`/sendmessage`，文本放 `msg.item_list`；**必须原样回传入站消息携带的 `context_token`**；bot 不能主动发起会话（激活=用户发首条消息）。
- 轮询循环带凭据指纹（provider+token 摘要）变更检测：指纹变了自动重启轮询；多窗口防双跑用进程内单例（CB 主进程唯一）+ 简单文件锁（userData/im-bots/locks/<botId>.lock，PID 存活校验）。

## 6. 飞书通道（`feishu.ts`，裁剪移植 ZCode `feishuProvider.ts`）

- 依赖新增：`@larksuiteoapi/node-sdk@^1.64.0`（ZCode 同款，dynamic import）。
- **MVP 凭据方式**：用户在飞书开放平台手动创建「企业自建应用」并粘贴 App ID/App Secret（UI 提供带截图说明的引导链接）。ZCode 的「扫码创建应用」依赖其云端配合，列为 P2。
- **收**：`Lark.WSClient({appId, appSecret}).start({eventDispatcher})` 长连接，订阅 `im.message.receive_v1`；仅处理 `chat_type=p2p`；按 `message_id` 去重。
- **发**：`POST /open-apis/im/v1/messages?receive_id_type=open_id`，msg_type=text（content 为 JSON 序列化串），用 `tenant_access_token/internal`（2h，<30min 时自动刷新）。
- 断线重连退避 5s；同一 bot 凭据指纹变更自动重启 WS。
- 权限需求写入 UI 引导文案：`im:message.p2p_msg:readonly`（收）、`im:message:send_as_bot`（发）。

## 7. 入站路由（`core.ts`，对齐 ZCode 语义）

`handleInbound(actor, text)` 按序：

1. **绑定检查**：actor 未绑定 → 若有匹配该 bot 的有效绑定码且文本 `/bind <code>` → 绑定（存 bindings）→ 回欢迎语+命令清单；否则回「请先在桌面端生成绑定码」。已绑定直接放行。
2. **命令解析**（`/` 开头，不区分大小写）：
   - `/bind <code>`、`/help`、`/status`（工作目录 + 当前会话标题 + 忙/闲 + 排队数）
   - `/new`：task 态且闲 → 回 draft（提示发消息开新会话）；运行中拒绝
   - `/workspace`：列出候选（bot.defaultWorkDir + 最近 10 个会话的 distinct working_dir）带序号，回复序号切换（draft 态才可切）
   - `/task`：列出绑定目录最近 10 个会话带序号，回复序号把 activeSessionId 切到该会话（闲时）
3. **普通消息状态机**（与 ZCode 一致，忙时改进为排队）：
   - draft → 建会话 + run（标题由宿主 deriveSessionTitle 自动派生）→ mode=task
   - task 且闲 → `resume` 语义：直接对该会话发 run
   - task 且运行中 → `queue.enqueue`（CB 差异化：ZCode 此处直接拒收）
4. **等待审批通知**：sink 观察到 `run.status('awaiting')` → 推「会话正在等待权限审批，请在桌面端处理」。

## 8. IPC 面（`index.ts` + preload）

主进程 handler（对齐既有 camelCase 风格）：`bots:list` / `bots:upsert` / `bots:remove` / `bots:setEnabled` / `bots:runtimeStatus` / `bots:generateBindCode` / `bots:unbindActor` / `bots:resetActor` / `bots:weixinQrStart` / `bots:weixinQrPoll`。
事件推送（webContents.send）：`bots:changed`（配置变化）、`bots:status`（RuntimeStatus 变化）、`bots:weixinQr`（扫码状态机）。
启动：main.ts `app.whenReady` 后 `initImBots()`，`before-quit` 时 `disposeImBots()`。所有 run 相关 handler 在 WebUI handler 注册表（monkey-patch 自动同步）中天然可用，WebUI 端暂不做 bot 管理 UI。

## 9. UI

### 9.1 入口改造（Sidebar）

- 按钮「启动 WebUI」→「远程访问」（i18n `sidebar.remoteAccess`，en "Remote Access"），点击打开 `RemoteAccessDialog`。
- `Sidebar.tsx:563` 起的内嵌 WebUI 面板整体迁入弹窗左栏；启动/停止/复制/二维码/局域网开关逻辑原样搬运，state 移入弹窗组件。

### 9.2 RemoteAccessDialog（布局 A：桌面左右两栏，窄屏堆叠）

- 宽 `max-w-[680px]`，grid `md:grid-cols-2`。
- **左栏「手机访问（WebUI）」**：未启动→启动按钮+说明；已启动→URL+复制+打开浏览器+二维码（168px）+停止。
- **右栏「IM 机器人」**：渠道卡两张（微信/飞书：品牌 logo、一句描述、「配置 →」），点击打开 BotsDialog 并定位到该渠道新建流程（ZCode `entryProvider` 模式）；下方「管理机器人」次要按钮。

### 9.3 BotsDialog（主从）

- 左列表：bot 行 = 渠道 logo + 名称 + 状态点（对齐 RuntimeStatus）；底部「新建机器人」。
- 右详情：
  - **微信**：扫码卡片（QrCode 组件 + 四态：等待扫码/已扫码/成功/过期，过期可重扫）→「发任意微信消息激活」提示条；
  - **飞书**：App ID/Secret 表单 + 开放平台引导链接 + 权限清单提示；
  - **通用**：绑定管理（生成绑定码，显示 `/bind XXXXXX` + 复制 + 30s 倒计时；已绑定账号列表+解绑）、默认工作目录、启停开关、重置状态、删除（确认弹窗）。
- 组件放 `src/components/bots/`：`BotsDialog.tsx`、`WeixinSetupCard.tsx`、`FeishuSetupCard.tsx`、`BindPanel.tsx`、`channelIcons.tsx`。轻量 Modal 基座新建 `src/components/ui/Modal.tsx`（对齐 ConfirmDialog 的 fixed/portal 模式）。

## 10. i18n

`src/i18n/locales/zh-CN.ts` / `en.ts` 新增 `sidebar.remoteAccess*`、`remoteAccess.*`、`bots.*`（文案大量改写自 ZCode 中文 i18n，已备草稿）。zh-CN 为源语言优先校对。

## 11. 安全

- 只认私聊；未绑定不响应任何内容；绑定码 30s 单次有效。
- 凭据 safeStorage 加密，配置文件只存 credentialRef。
- IM 不下发权限审批（`permission.resolve` 仅本地窗口可达，与 WebUI 同级安全边界）；remote 语义禁用项对 bot 同样适用（bot 调 run 用 `meta.remote:false` 是因为 settings 快照机制，但 bot 自身在主进程内，等同本地用户操作，其输入已过绑定白名单）。
- 发送到 IM 的内容不包含 apiKey/token 等敏感值（回复前过滤）。

## 12. 实施顺序与验收

| 步骤 | 内容 | 验收 |
|---|---|---|
| D1 | storage + 类型 + IPC 骨架 + preload | 单测：config/state 读写、损坏恢复、绑定码 TTL |
| D2 | session-bridge + core 路由 | 单测：draft/task 状态机、忙时入队、/new //task /workspace 路由 |
| D3 | weixin 通道 | 单测：协议加密/游标；手动：真机扫码收发 |
| D4 | feishu 通道 + 新依赖 | 手动：自建应用收发、断线重连 |
| D5 | Sidebar 改造 + RemoteAccessDialog | 手动：WebUI 功能无回归 |
| D6 | BotsDialog 全套 + i18n | 手动：新建/绑定/启停/删除全流程 |
| D7 | 全量检查 | `tsc` 0 错、`npm run build` 通过、既有测试全绿 |

**风险**：微信 iLink 无公开协议文档，跟随 ZCode 实现但存在腾讯单方变更风险（置 error 提示重扫即可恢复）；飞书长连接每应用 50 连接上限（单用户无碍）；`@larksuiteoapi/node-sdk` 与 Electron 打包兼容性需 D4 首验（external 处理，参考既有 node-pty 配置）。

## 13. 通道扩展：Telegram / 企业微信（2026-10-04 已实施）

框架改动四处：`BOT_PROVIDERS` 枚举 +4 渠道中的两个、`BotCredentialInputSchema` 改为按渠道的三支 union（serializeBotCredential 校验渠道与字段形状匹配）、`CHANNELS` 工厂表、`ChannelDeps.fetchImpl` 可注入。绑定/命令/会话桥/凭据加密/文件锁零改动。

**Telegram（`telegram.ts`）**：getUpdates 长轮询（服务端挂 50s、硬超时 70s），offset 游标复用通用游标槽位；首次连接先 `offset=-1` 排空历史积压（防重放）；只收私聊文本；空批退避 1s（防微任务热循环）。401=Token 无效、409=被其他轮询客户端占用、429=按 retry_after 退避。出站 sendMessage，单聊 1 msg/s 漏桶（分段间隔 1.1s）。**网络**：主进程注入 Electron `net.fetch`（走 Chromium 网络栈，系统代理自动生效，TUN 兼容），刻意不做应用内代理配置——TG 用户自备网络环境。

**企业微信（`wecom.ts`）**：官方 `@wecom/aibot-node-sdk`（WSClient 长连接，maxReconnectAttempts=-1 无限重连 + 本通道 30s 建连看门狗：启动超阈值且从未收到消息且期间报过错 → 判死交宿主重建）。只收单聊文本；出站走 `sendMessage`（markdown，主动推送无 5s 被动窗口），**官方限频 30 条/分钟 → ≥2.1s 漏桶**。

测试：`im-bots-telegram.test.ts`（8 用例：游标语义/私聊过滤/401/429/网络错误/send 形状/指纹变更）、`im-bots-wecom.test.ts`（4 用例：单聊过滤/send 形状/断开/凭据缺失）。
