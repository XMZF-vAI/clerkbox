/**
 * IM Bots（微信 / 飞书遥控）数据模型与通道契约。
 *
 * 两块内容：
 * 1. 落盘模型 —— bots-config.json（机器人定义）与 bots-state.json（聊天上下文 / 绑定 / 绑定码）。
 *    两者都是 zod strict：多写字段一律拒绝，读到时按损坏处理并备份重建。strict 不是洁癖，
 *    而是防止「上一个版本写的字段被下一版静默沿用」——凭据引用与游标错位都是能导致
 *    「消息发到别人手机上」的错法。
 * 2. 通道契约 —— BotChannelHandle / ChannelDeps。微信与飞书各自实现一份，宿主（core + index）
 *    只认这个接口，于是新增渠道不需要碰路由与会话桥。
 *
 * 本文件不 import electron：它要能被 vitest 在纯 node 环境下加载。
 */
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// 渠道标识
// ─────────────────────────────────────────────────────────────────────────────

/** 本期只做这两条通道；群聊一律不收（两家的私聊判定见各自通道实现）。 */
export const BOT_PROVIDERS = ['weixin', 'feishu'] as const
export type BotProvider = (typeof BOT_PROVIDERS)[number]

export function isBotProvider(value: unknown): value is BotProvider {
  return typeof value === 'string' && (BOT_PROVIDERS as readonly string[]).includes(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置文件：userData/im-bots/bots-config.json
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单个机器人。凭据**不落在这里**，只存 credentialRef（指向 safeStorage 加密的
 * clerkbox-credentials.json 条目），于是配置文件可以随手拷贝、日志里可以直接打印。
 */
export const BotConfigSchema = z.strictObject({
  id: z.string().min(1).max(64),
  provider: z.enum(BOT_PROVIDERS),
  /** 界面显示名，与渠道侧的真实身份无关 */
  name: z.string().min(1).max(64),
  enabled: z.boolean(),
  /** 命名规则 bot-<provider>-<id>，落在既有 assertCredentialId 白名单 [A-Za-z0-9._-] 内 */
  credentialRef: z.string().min(1).max(160),
  /** 绑定的工作目录；空 = 首次用 /workspace 选择，或沿用最近会话的目录 */
  defaultWorkDir: z.string().max(1024).optional(),
})
export type BotConfig = z.infer<typeof BotConfigSchema>

export const BotsConfigFileSchema = z.strictObject({
  version: z.literal(1),
  bots: z.array(BotConfigSchema),
})
export type BotsConfigFile = z.infer<typeof BotsConfigFileSchema>

/**
 * 新建 / 更新机器人时渲染层能提交的形状：id 可选（不带＝主进程发号）。
 * 刻意不含 credentialRef——那是主进程按 bot-<provider>-<id> 生成的凭据命名空间，
 * 让外部指定等于允许覆盖别人的 API Key 条目。
 *
 * 空串 id 由 upsertBot 归一成「不带」（新建）：界面从空表单提交时写 `id: ''` 比造一个
 * undefined 字段更自然。归一放在处理侧而不是 schema 里加 transform，是因为 transform
 * 会把推断出的类型变成「必填但可为 undefined」，渲染层每次新建都得显式写 id。
 */
export const NewBotSchema = z.strictObject({
  id: z.string().max(64).optional(),
  provider: z.enum(BOT_PROVIDERS),
  name: z.string().min(1).max(64),
  enabled: z.boolean(),
  defaultWorkDir: z.string().max(1024).optional(),
})
export type NewBot = z.infer<typeof NewBotSchema>

export function emptyBotsConfig(): BotsConfigFile {
  return { version: 1, bots: [] }
}

/** credentialRef 的唯一生成点：写入与读取两侧必须同一个函数，否则凭据找不回来 */
export function credentialRefFor(provider: BotProvider, botId: string): string {
  return `bot-${provider}-${botId}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态文件：userData/im-bots/bots-state.json
// ─────────────────────────────────────────────────────────────────────────────

/** 聊天类型恒为 private：本期不收群消息，字段留着是为了让「以后放开群」不必改 key 结构。 */
export const BOT_CHAT_TYPES = ['private'] as const
export type BotChatType = (typeof BOT_CHAT_TYPES)[number]

/**
 * 一个「聊天身份」的稳定标识。为什么带上 chatType 与 botId：
 * 同一个人可以绑两个微信 bot，换 bot 就是换上下文（工作目录、当前会话都不该跟过去）。
 */
export function makeActorKey(
  botId: string,
  provider: BotProvider,
  providerUserId: string,
  chatType: BotChatType = 'private'
): string {
  return `${botId}:${provider}:${providerUserId}:${chatType}`
}

export const ChatContextSchema = z.strictObject({
  actorKey: z.string().min(1),
  /** draft = 等一条消息来开新会话；task = 已绑定到一个具体会话 */
  mode: z.enum(['draft', 'task']),
  /** mode=task 时指向的 ClerkBox 会话 id（对应 ZCode 的 activeTaskId） */
  activeSessionId: z.string().max(64).optional(),
  /** 本聊天身份单独选定的工作目录，优先于 bot.defaultWorkDir */
  workDir: z.string().max(1024).optional(),
  /** 微信长轮询游标：丢了就会重收历史消息，所以它进状态文件而不是内存 */
  weixinGetUpdatesBuf: z.string().max(4096).optional(),
  /**
   * 最近一次入站消息携带的 context_token。
   * 必须落盘：run 完成时用户往往早就停止发消息了，而 iLink 只认「原样回传入站消息里的 token」，
   * 内存态一旦通道重启就再也回推不出结果——这正是「跑完却收不到答案」的那类 bug。
   */
  weixinContextToken: z.string().max(4096).optional(),
  /** 首次收到该身份消息的时刻（微信侧「激活」＝用户主动发第一条） */
  weixinActivatedAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int(),
})
export type ChatContext = z.infer<typeof ChatContextSchema>

/** 绑定码：桌面端生成、IM 侧核销，30 秒单次有效。 */
export const BIND_CODE_TTL_MS = 30_000

export const BindCodeSchema = z.strictObject({
  code: z.string().length(6),
  botId: z.string().min(1),
  expiresAt: z.number().int(),
})
export type BindCode = z.infer<typeof BindCodeSchema>

/** 已绑定的 IM 账号。actorKey 与 ChatContext 同一口径，解绑时两边一起清。 */
export const BindingSchema = z.strictObject({
  actorKey: z.string().min(1),
  botId: z.string().min(1),
  providerUserId: z.string().min(1).max(256),
  displayName: z.string().max(128).optional(),
  boundAt: z.number().int().optional(),
})
export type Binding = z.infer<typeof BindingSchema>

export const BotsStateFileSchema = z.strictObject({
  version: z.literal(1),
  contexts: z.array(ChatContextSchema),
  pendingBinds: z.array(BindCodeSchema),
  bindings: z.array(BindingSchema),
})
export type BotsStateFile = z.infer<typeof BotsStateFileSchema>

export function emptyBotsState(): BotsStateFile {
  return { version: 1, contexts: [], pendingBinds: [], bindings: [] }
}

/** 绑定码是否仍然有效（过期即视为不存在，不做延迟清理） */
export function bindCodeIsLive(code: BindCode, now = Date.now()): boolean {
  return code.expiresAt > now
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行状态
// ─────────────────────────────────────────────────────────────────────────────

export const BOT_RUNTIME_STATES = [
  'idle',
  'starting',
  'polling',
  'connected',
  'error',
  'disabled',
] as const
export type BotRuntimeState = (typeof BOT_RUNTIME_STATES)[number]

export interface RuntimeStatus {
  botId: string
  state: BotRuntimeState
  /** 面向用户的短消息（错误原因、重试提示）；不进日志的原始堆栈另有去处 */
  message?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 凭据：一份 credentialRef 背后的实际内容
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 两家都存成 JSON 文本（safeStorage 加密后落 clerkbox-credentials.json）。
 * 用 JSON 而不是拼接串：飞书要两个字段，微信登录后要三个（token 还会换 baseUrl）。
 */
export const WeixinSecretSchema = z.strictObject({
  /** iLink get_qrcode_status confirmed 下发的 bot_token */
  token: z.string().min(1),
  /** 登录态可能重定向到新域名，之后所有请求都用它 */
  baseUrl: z.string().min(1).max(512),
  /** 长轮询要带上的机器人标识（iLink bot id） */
  instanceId: z.string().min(1).max(256).optional(),
})
export type WeixinSecret = z.infer<typeof WeixinSecretSchema>

export const FeishuSecretSchema = z.strictObject({
  appId: z.string().min(1).max(128),
  appSecret: z.string().min(1).max(256),
})
export type FeishuSecret = z.infer<typeof FeishuSecretSchema>

export function parseWeixinSecret(raw: string): WeixinSecret | null {
  try {
    return WeixinSecretSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function parseFeishuSecret(raw: string): FeishuSecret | null {
  try {
    return FeishuSecretSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 凭据指纹：内容变了就要重启通道（否则会出现「换了 App 却还连在旧应用上」）。 */
export function credentialFingerprint(provider: BotProvider, raw: string): string {
  return `${provider}:${simpleHash(`${provider}|${raw}`)}`
}

/**
 * 非加密 FNV-1a 摘要。这里只需要「内容变了没有」的判据与日志脱敏，不需要抗碰撞，
 * 因此不引 crypto —— 引了反而让本文件在浏览器测试环境里加载不了。
 */
export function simpleHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * bots:setCredential 的入参形状。
 *
 * 只有飞书走这条路：它的应用凭据是「用户去开放平台手动建好再粘回来」，两个字段一起给才有意义
 * （分两次写会出现 appId 已换、appSecret 还是旧的中间态）。
 * 微信不接受手填凭据——token 只能来自扫码确认那一步，放开手填等于开一条绕过登录流程的路，
 * 拿到的还是一个必然失效的 token。
 */
export const BotCredentialInputSchema = z.strictObject({
  appId: z.string().min(1).max(128),
  appSecret: z.string().min(1).max(256),
})
export type BotCredentialInput = z.infer<typeof BotCredentialInputSchema>

/** 该渠道的凭据能不能由界面直接写入（微信＝否，只能扫码） */
export function providerAcceptsManualCredential(provider: BotProvider): boolean {
  return provider === 'feishu'
}

/** 凭据写入的唯一序列化点：与 parseFeishuSecret / parseWeixinSecret 对偶 */
export function serializeFeishuCredential(input: BotCredentialInput): string {
  return JSON.stringify({ appId: input.appId, appSecret: input.appSecret })
}

// ─────────────────────────────────────────────────────────────────────────────
// 通道契约
// ─────────────────────────────────────────────────────────────────────────────

/** 一条入站消息的发送者身份（已经过「只认私聊」过滤）。 */
export interface InboundActor {
  botId: string
  provider: BotProvider
  /** 渠道侧的用户 id：微信是加密后的 openid 串，飞书是 open_id */
  providerUserId: string
  chatType: BotChatType
  displayName?: string
}

export interface InboundMessage {
  actor: InboundActor
  text: string
  /** 渠道侧消息 id：飞书用它去重（长连接重连会重投） */
  messageId?: string
  /**
   * 微信专用回传令牌：iLink 要求回复原样带回入站消息携带的 context_token，
   * 且 bot 不能主动发起会话。飞书不用，留空。
   */
  contextToken?: string
}

/** 出站目标：从 ChatContext/Binding 复原，不要求通道自己记账。 */
export interface OutboundTarget {
  providerUserId: string
  contextToken?: string
}

/**
 * 通道向宿主索取的服务。刻意做成接口而不是 import：
 * 通道模块因此不依赖 electron 与 db，可以在 vitest 里直接实例化跑协议逻辑。
 */
export interface ChannelDeps {
  /** 读当前凭据（明文）。没有凭据回 null，通道应置 error 而不是抛。 */
  readCredential(): Promise<string | null>
  /** 写凭据：微信扫码登录后由通道自己写入（feishu 用不到） */
  writeCredential(value: string): Promise<void>
  /** 入站消息唯一入口：core.handleInbound 负责绑定检查与路由 */
  onInbound(message: InboundMessage): Promise<void>
  /** 运行状态上报表，宿主负责去抖与广播 */
  setStatus(state: BotRuntimeState, message?: string): void
  /** 长轮询游标读写（微信 get_updates_buf）；不用游标的通道可以忽略 */
  readCursor(): Promise<string | undefined>
  writeCursor(value: string | undefined): Promise<void>
  /** 首次收到用户消息时记录激活时刻 */
  markActivated(): Promise<void>
  /** 该 bot 是否应当继续运行：enabled 被关掉时循环要自己退出 */
  isStopped(): boolean
  log(...args: unknown[]): void
}

/**
 * 一个 bot 对应一个 handle 实例（长轮询 / 长连接的连接状态都在实例里）。
 * 生命周期：create() → start() →（send\*）→ stop()。start 的 promise 在通道退出时 resolve，
 * 宿主 await 它来感知「非异常退出」，从而区分「用户停用」与「协议挂了」。
 */
export interface BotChannelHandle {
  readonly provider: BotProvider
  start(bot: BotConfig, deps: ChannelDeps): Promise<void>
  send(target: OutboundTarget, text: string): Promise<void>
  stop(): Promise<void>
}

export interface BotChannelFactory {
  readonly provider: BotProvider
  create(): BotChannelHandle
}

// ─────────────────────────────────────────────────────────────────────────────
// 跨进程面（preload ↔ 渲染层）
// ─────────────────────────────────────────────────────────────────────────────

/** 渲染层看到的 bot 行 = 配置 + 实时状态（凭据内容永不出主进程，只出「有没有」）。 */
export interface BotListItem extends BotConfig {
  status: BotRuntimeState
  statusMessage?: string
  /** 是否已持有可用凭据：微信＝已扫码，飞书＝已填 App ID/Secret */
  hasCredential: boolean
  boundActors: Binding[]
}

/** 生成绑定码的回执 */
export interface BindCodeResult {
  ok: boolean
  code?: string
  expiresAt?: number
  error?: 'no-such-bot'
}

/**
 * 管理面统一回执。
 * data 可选：绝大多数写操作（启用 / 停用 / 解绑 / 删除）没有返回体，
 * 强制它们编造一个 `data: null` 只会让渲染层多一层「这个 null 是什么意思」的猜测。
 */
export type BotsIpcResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string }

/** 微信扫码登录的状态机（与 iLink get_qrcode_status 四态一一对应） */
export const WEIXIN_QR_STATES = ['waiting', 'scanned', 'confirmed', 'expired', 'error'] as const
export type WeixinQrState = (typeof WEIXIN_QR_STATES)[number]

export interface WeixinQrEvent {
  /** 本次扫码会话 id（bots:weixinQrStart 返回） */
  session: string
  botId?: string
  state: WeixinQrState
  /** waiting/scanned 时的二维码内容，渲染层本地画码 */
  qrUrl?: string
  message?: string
}

/**
 * 微信扫码会话（weixin.ts 实现，index.ts 编排）。
 *
 * 为什么是「主进程自己转 + 渲染层按需 peek」而不是纯事件推送：
 * get_qrcode_status 是长轮询，状态只在服务端挂着的 30 秒里连续变化；
 * 窗口销毁 / 事件漏发会让界面永远停在「等待扫码」。因此每次状态变化照常广播，
 * 同时保留一个同步可查的快照，渲染层重开弹窗时 peek 一下就能回到正确的那一态。
 */
export interface WeixinQrSession {
  id: string
  botId: string
  state: WeixinQrState
  /** 二维码承载的内容（iLink 的扫码链接），由渲染层本地画成码图 */
  qrUrl?: string
  message?: string
  /** 已出结果（confirmed / expired / error）：主进程据此停止轮询 */
  finished: boolean
  createdAt: number
}

/** WeixinQrLogin 向宿主索取的服务 */
export interface WeixinQrLoginDeps {
  readCredential(): Promise<string | null>
  writeCredential(value: string): Promise<void>
  /** 状态变化广播（内部长轮询在任意时刻回调，不能靠返回值） */
  onEvent(event: WeixinQrEvent): void
  log(...args: unknown[]): void
}

/** 一次性的扫码登录编排器：一个实例管多个并发会话（用户可以反复点「重新扫码」） */
export interface WeixinQrLogin {
  /** 起一个扫码会话：拿二维码并开始后台状态轮询。失败回 { ok: false, error } */
  start(botId: string): Promise<{ ok: true; session: WeixinQrSession } | { ok: false; error: string }>
  /** 取当前快照（渲染层重开界面时对齐状态） */
  peek(sessionId: string): WeixinQrSession | null
  /** 用户关弹窗 / 换码：停掉该会话的长轮询 */
  stop(sessionId: string): void
  /** 应用退出：回收全部会话的挂起请求 */
  dispose(): void
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC 通道名单：三处（main 注册、preload 暴露、黑名单守卫）共用一份常量，
// 避免「加了 handler 忘了进黑名单」——tests/webui-blocklist.test.ts 会按这份名单逐条校验。
// ─────────────────────────────────────────────────────────────────────────────

export const BOTS_IPC_CHANNELS = {
  list: 'bots:list',
  upsert: 'bots:upsert',
  remove: 'bots:remove',
  setEnabled: 'bots:setEnabled',
  runtimeStatus: 'bots:runtimeStatus',
  generateBindCode: 'bots:generateBindCode',
  unbindActor: 'bots:unbindActor',
  resetActor: 'bots:resetActor',
  resetBot: 'bots:resetBot',
  setCredential: 'bots:setCredential',
  weixinQrStart: 'bots:weixinQrStart',
  weixinQrPoll: 'bots:weixinQrPoll',
  weixinQrStop: 'bots:weixinQrStop',
} as const

export type BotsIpcChannel = (typeof BOTS_IPC_CHANNELS)[keyof typeof BOTS_IPC_CHANNELS]

/** 主进程 → 渲染层的事件通道 */
export const BOTS_EVENT_CHANNELS = {
  changed: 'bots:changed',
  status: 'bots:status',
  weixinQr: 'bots:weixinQr',
} as const

export type BotsEventChannel = (typeof BOTS_EVENT_CHANNELS)[keyof typeof BOTS_EVENT_CHANNELS]
