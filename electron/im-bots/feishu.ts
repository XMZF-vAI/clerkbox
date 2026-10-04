/**
 * 飞书通道（Lark 开放平台「长连接」订阅）：收 im.message.receive_v1、发 im/v1/messages。
 *
 * 协议形态（逐条对齐 ZCode `packages/services/src/bots/providers/feishuProvider.ts`，出处见行内注释）：
 * - 收：`WSClient({appId, appSecret}).start({eventDispatcher})` 由本机主动出站建 WS，
 *   因此**不需要公网回调地址**，家用网络/NAT 直接可用；只放行 `chat_type === 'p2p'`。
 * - 发：`POST /open-apis/im/v1/messages?receive_id_type=open_id`，`msg_type: 'text'`，
 *   `content` 是 JSON 序列化后的**字符串**（不是对象——这是飞书接口最常见的写错处）。
 * - 鉴权：`tenant_access_token` 走 `/auth/v3/tenant_access_token/internal`，名义 2h，
 *   剩余不足 30min 提前换；并发请求共享同一次刷新（飞书 token 接口有频控，
 *   打两次会拿到两个 token 并让前一个进入失效流程）。
 * - 重投：长连接重连后飞书会把同一条 `im.message.receive_v1` 再推一遍，必须按 `message_id` 幂等，
 *   否则「一句 hello 跑两轮任务」。
 *
 * 与宿主（index.ts）的两条约定，改这里之前先读：
 * 1. **凭据指纹变化 = 退出 start()**。每轮重读凭据，指纹与启动时不同就让 start() 的 promise
 *    resolve（不抛）。宿主按「start 非异常退出」判定要 `create()` 一个新 handle 重建：连接态、
 *    去重表、扫码激活记录都在实例里，换 App 后继续复用旧实例等于带着旧应用的上下文跑。
 * 2. **退出终态由宿主决定**，通道自己不上报 disabled/idle——否则 setEnabled(false) 之后
 *    通道退出时的 setStatus 会把宿主刚写的 'disabled' 覆盖成 'idle'。
 */
import {
  credentialFingerprint,
  parseFeishuSecret,
  simpleHash,
  type BotChannelFactory,
  type BotChannelHandle,
  type BotConfig,
  type ChannelDeps,
  type InboundMessage,
  type OutboundTarget,
} from './types'

// ─────────────────────────────────────────────────────────────────────────────
// 协议常量
// ─────────────────────────────────────────────────────────────────────────────

/** 国内飞书；国际版 Lark 是 https://open.larksuite.com（feishuProvider.ts:512-516）。
 *  本期 BOT_PROVIDERS 只有一个 feishu 值，没有渠道可选国际版，故基址写死并在报告里记为契约缺口。 */
const FEISHU_BASE_URL = 'https://open.feishu.cn'
const TENANT_TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
const SEND_MESSAGE_PATH = '/open-apis/im/v1/messages'

/** 自建应用 App ID 形如 cli_ + 16 位十六进制（feishuProvider.ts:30）。
 *  SDK 的 start() 对非法 appId 只 logger.error 后静默 return（node-sdk lib/index.js:102791），
 *  不预检就会变成「界面显示连接中、实际什么都没连」，所以先自己判。 */
const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/

/** tenant_access_token 名义有效期 2h（响应里的 expire 字段是秒）；缺字段时按 2h 兜底 */
const TOKEN_DEFAULT_TTL_MS = 2 * 60 * 60_000
/** 剩余不足 30min 就提前换。ZCode 用「缓存 90min」（feishuProvider.ts:1127）表达同一条策略，
 *  这里改成按服务端 expire 判定：租期一旦调短（飞书做过），提前量仍然成立。 */
const TOKEN_REFRESH_SKEW_MS = 30 * 60_000

/** 单次 HTTP 上限（providerRequest.ts:1）。飞书侧偶发挂请求，必须有界，否则发送队列整条卡死 */
const REQUEST_TIMEOUT_MS = 15_000
/** 长连接彻底重建前的退避（规格 §6：5s） */
const WS_RECONNECT_BACKOFF_MS = 5_000
/** 首连握手看门狗（feishuProvider.ts:31 用的也是 20s）：超时即销毁 client 重来 */
const WS_START_TIMEOUT_MS = 20_000
/** 连接状态轮询间隔：SDK 的 onReady 一类回调在 ^1.64 的下限版本上不存在，只能看状态 */
const WS_STATE_POLL_MS = 1_000
/** 连上之后失联多久判定为「SDK 自己没救回来」，交给外层销毁重建 */
const WS_LOST_FAIL_MS = 30_000
/** 连接期间多久复查一次凭据指纹：不复查的话「换了 App」要等到下次断线才生效 */
const CREDENTIAL_POLL_MS = 30_000
/** message_id 去重窗口与容量（feishuProvider.ts 的重投去重在 botsService.ts:672，TTL 2min） */
const DEDUPE_TTL_MS = 2 * 60_000
const DEDUPE_MAX_ENTRIES = 2_000
/** 飞书单条文本的长度上限留足余量，长回复切多条（feishuProvider.ts:1083-1090 同口径） */
const TEXT_CHUNK_LIMIT = 1_900

const WEBSOCKET_OPEN_READY_STATE = 1

// ─────────────────────────────────────────────────────────────────────────────
// SDK 的结构化类型：只用 WSClient / EventDispatcher 两个构造器，
// 不 import 它的类型（那份 d.ts 32 万行，且 ^1.64 区间内的 API 面会变），
// 所有可选成员都在运行时探测，缺了就退回「轮询 + 超时」这条老路径。
// ─────────────────────────────────────────────────────────────────────────────

type FeishuWsState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'unknown'

type FeishuEventHandler = (payload: unknown) => unknown | Promise<unknown>

interface FeishuEventDispatcher {
  register(handles: Record<string, FeishuEventHandler>): unknown
}

interface FeishuWsClient {
  start(params: { eventDispatcher: FeishuEventDispatcher }): Promise<void>
  close(params?: { force?: boolean }): void
  getConnectionStatus?(): { state?: FeishuWsState }
}

interface FeishuSdkModule {
  WSClient: new (params: Record<string, unknown>) => FeishuWsClient
  EventDispatcher: new (params: Record<string, unknown>) => FeishuEventDispatcher
  Domain?: { Feishu?: unknown }
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：payload 归一化（可直接单测，不碰网络与 SDK）
// ─────────────────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === 'string' ? value : ''
}

/** 飞书的 message.content 在不同事件版本里既可能是 JSON 串也可能已被 SDK 摊成对象 */
export function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 去掉 @ 机器人留下的痕迹。刻意不复用 ZCode 的 `@\S+`（feishuProvider.ts:547-552）：
 * 那条正则在私聊里会把 `me@example.com` 剪成 `me`，而私聊本来就不会以 @_user_1 之外的形式 @ 人。
 */
export function stripFeishuMentions(text: string): string {
  return text
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/giu, '')
    .replace(/@_user_\d+/gu, '')
    .replace(/@_all/gu, '')
    .trim()
}

function readPostLocaleContent(content: Record<string, unknown>): unknown {
  const post = isRecord(content.post) ? content.post : null
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null
  return content.content ?? zhCn?.content ?? enUs?.content
}

function readPostLocaleTitle(content: Record<string, unknown>): string {
  const post = isRecord(content.post) ? content.post : null
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null
  return readString(content, 'title') || readString(zhCn, 'title') || readString(enUs, 'title')
}

/**
 * 富文本（msg_type=post）的递归取值，形状对齐 feishuProvider.ts:568-596。
 * 飞书客户端里「看起来就是普通文字」但带链接/格式的消息会以 post 推送，
 * 只读 content.text 的话这类消息解析成空文本被丢掉，用户侧表现为「发了消息但 ClerkBox 没反应」。
 */
function formatPostToken(token: unknown): string {
  if (typeof token === 'string') return token
  if (Array.isArray(token)) return token.map(formatPostToken).filter(Boolean).join('')
  if (!isRecord(token)) return ''
  const tag = readString(token, 'tag')
  // @ 提醒不带正文
  if (tag === 'at') return ''
  const nested = token.content ?? token.children ?? token.elements
  const nestedText = Array.isArray(nested) ? nested.map(formatPostToken).filter(Boolean).join('') : ''
  const text =
    readString(token, 'text') ||
    readString(token, 'un_escape_text') ||
    readString(token, 'name') ||
    nestedText
  if (tag === 'a') {
    const href = readString(token, 'href')
    if (href && href !== text) return text ? `${text} ${href}` : href
  }
  return text
}

/** post 消息正文：每行取文本再拼接，标题单独一行（feishuProvider.ts:598-614） */
export function readFeishuPostText(content: Record<string, unknown> | null): string {
  if (!content) return ''
  const postContent = readPostLocaleContent(content)
  const lines = Array.isArray(postContent)
    ? postContent.map((line) => formatPostToken(line).trim()).filter(Boolean)
    : []
  const title = readPostLocaleTitle(content).trim()
  const body = lines.join('\n').trim()
  if (title && body) return `${title}\n${body}`
  return body || title
}

/** 一条 im.message.receive_v1 的正文：text 与 post 两种 content 都要能出字（feishuProvider.ts:678-683） */
export function readFeishuMessageText(event: Record<string, unknown>, message: Record<string, unknown>): string {
  const content = parseJsonRecord(message.content)
  const rawText =
    readString(content, 'text') ||
    readFeishuPostText(content) ||
    readString(event, 'text_without_at_bot') ||
    readString(event, 'text')
  return stripFeishuMentions(rawText)
}

/**
 * 事件 payload → InboundMessage[]。
 * 群聊、缺发送者、纯媒体（本期不收附件）一律归一化成空数组——「不收」不是错误，不抛。
 * 返回数组而不是单条，是因为 SDK 在部分版本会把 event 字段摊平到顶层（feishuProvider.ts:667-669），
 * 两种形状都要能吃；同时给「一条事件多消息」留出余地。
 */
export function normalizeFeishuReceiveEvent(botId: string, payload: unknown): InboundMessage[] {
  if (!isRecord(payload)) return []
  const event = isRecord(payload.event) ? payload.event : payload
  const message = isRecord(event.message) ? event.message : null
  if (!message) return []

  const chatType = readString(message, 'chat_type') || readString(event, 'chat_type')
  /**
   * 正向只认 p2p，而不是反向排除 group。
   * 规格 §6/§11 写的就是「仅处理 chat_type=p2p」：反向排除时，一旦飞书新增一种会话类型
   * 或者事件里 chat_type 缺失，这条消息就会被当成私聊收下——而我们的整个安全前提
   * 是「只认私聊」。认不认识得出来不重要，不认识就不收才是 fail-closed。
   * 判定口径同 feishuProvider.ts:528-530。
   */
  if (chatType !== 'p2p') return []

  const sender = isRecord(event.sender) ? event.sender : null
  const senderId = isRecord(sender?.sender_id) ? sender.sender_id : null
  // 出站用 receive_id_type=open_id，所以这里优先 open_id（feishuProvider.ts:684-690）
  const providerUserId =
    readString(senderId, 'open_id') ||
    readString(senderId, 'user_id') ||
    readString(senderId, 'union_id')
  if (!providerUserId) return []

  const text = readFeishuMessageText(event, message)
  if (!text) return []

  const messageId = readString(message, 'message_id')
  return [
    {
      actor: {
        botId,
        provider: 'feishu',
        providerUserId,
        chatType: 'private',
      },
      text,
      ...(messageId ? { messageId } : {}),
    },
  ]
}

/** 飞书按前缀区分收信方类型（feishuProvider.ts:1132-1134）。私聊回包是 open_id，oc_ 分支留给未来放开群聊 */
export function resolveReceiveIdType(receiveId: string): 'chat_id' | 'open_id' {
  return receiveId.startsWith('oc_') ? 'chat_id' : 'open_id'
}

/** 长文本切条（feishuProvider.ts:1083-1090）：空串也要发一条，避免「回了个空」 */
export function splitFeishuText(text: string, limit = TEXT_CHUNK_LIMIT): string[] {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit))
  }
  return chunks.length > 0 ? chunks : [text]
}

// ─────────────────────────────────────────────────────────────────────────────
// 去重
// ─────────────────────────────────────────────────────────────────────────────

/**
 * message_id 幂等表：TTL + 容量双限制。
 * 放在 handle 实例上而不是进程级，是因为换 App（重建 handle）之后旧 message_id 不会再重投；
 * 反过来「重连风暴」期间的重复只在同一实例里，实例级正好够用。
 */
export class MessageIdDedupe {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly ttlMs = DEDUPE_TTL_MS,
    private readonly maxEntries = DEDUPE_MAX_ENTRIES
  ) {}

  /** 首次出现返回 true（应当处理）；无 id 时无法判重，放行 */
  mark(messageId: string, now = Date.now()): boolean {
    this.prune(now)
    if (!messageId) return true
    if (this.seen.has(messageId)) return false
    this.seen.set(messageId, now)
    // Map 按插入序迭代，超限时淘汰最早一条：宁可漏去重（重投是低频事件），
    // 也不能让一条常驻内存的表在长跑的主进程里无界增长
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next()
      if (!oldest.done) this.seen.delete(oldest.value)
    }
    return true
  }

  get size(): number {
    return this.seen.size
  }

  private prune(now: number): void {
    for (const [key, at] of this.seen) {
      if (now - at >= this.ttlMs) this.seen.delete(key)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────

interface JsonReply<T> {
  ok: boolean
  status: number
  payload?: T
  logId?: string
}

export interface FeishuFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/**
 * 有界的 JSON 请求：收到响应头不等于请求完成，响应体也必须在同一个 deadline 与 signal 下读完，
 * 否则服务端在 headers 之后停滞就会永久堵住发送路径（providerRequest.ts:34-36 的修复原因）。
 */
export async function requestFeishuJson<T>(
  url: string,
  init: FeishuFetchInit,
  fetchImpl: typeof fetch,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<JsonReply<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`飞书请求超时 ${timeoutMs}ms`)), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal } as RequestInit)
    const text = await response.text()
    let payload: T | undefined
    if (text) {
      try {
        payload = JSON.parse(text) as T
      } catch (error) {
        // 2xx 却解析不出 JSON 属于真异常，要抛；非 2xx 时错误体本来就可能是 HTML
        if (response.ok) throw error
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      payload,
      logId: response.headers.get('x-tt-logid') ?? undefined,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 飞书的业务错误码：HTTP 200 也可能 code !== 0，错误信息要带 code/msg/log_id 才好排查（feishuProvider.ts:1136-1156） */
function feishuApiError(operation: string, reply: JsonReply<{ code?: number; msg?: string; error?: { log_id?: string } }>): Error {
  const payload = reply.payload ?? {}
  const details = [
    typeof payload.code === 'number' ? `code=${payload.code}` : null,
    payload.msg ? `msg=${payload.msg}` : null,
    payload.error?.log_id || reply.logId ? `log_id=${payload.error?.log_id ?? reply.logId}` : null,
  ].filter((item): item is string => Boolean(item))
  return new Error(`飞书${operation}失败: HTTP ${reply.status}${details.length > 0 ? `, ${details.join(', ')}` : ''}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// tenant_access_token 缓存
// ─────────────────────────────────────────────────────────────────────────────

interface TenantTokenResponse {
  code?: number
  msg?: string
  tenant_access_token?: string
  expire?: number
}

export interface TenantToken {
  token: string
  expiresAt: number
}

/** 剩余可用时间不足提前量就要刷新（含已过期） */
export function isTokenFresh(token: TenantToken, now: number, skewMs = TOKEN_REFRESH_SKEW_MS): boolean {
  return token.expiresAt - now > skewMs
}

export interface TenantTokenStore {
  get(appId: string, appSecret: string): Promise<string>
  peek(appId: string, appSecret: string): TenantToken | undefined
}

/**
 * 凭据指纹进缓存 key：appSecret 换过之后旧 token 必须失效。
 * 只取摘要不取原文——缓存可能被写进诊断日志，不能让 secret 顺路泄漏。
 */
export function tenantTokenCacheKey(appId: string, appSecret: string): string {
  return `${appId}:${simpleHash(appSecret)}`
}

/**
 * token 缓存 + 并发合流。
 * 刻意不接受调用方的 AbortSignal：在途刷新是多方共享的，
 * 谁被取消都不能让别人的 await 跟着炸（取消只影响自己等多久，不影响请求本身）。
 */
export function createTenantTokenStore(options: {
  fetchImpl?: typeof fetch
  now?: () => number
  baseUrl?: string
  timeoutMs?: number
} = {}): TenantTokenStore {
  // 每次调用时再取 globalThis.fetch：主进程里 fetch 的可用性在模块加载期不定，
  // 而单测靠替换全局 fetch 来保证「绝不联网」——早绑定会让测试真的打到 open.feishu.cn
  const doFetch = (): typeof fetch => options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? (() => Date.now())
  const baseUrl = options.baseUrl ?? FEISHU_BASE_URL
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const cache = new Map<string, TenantToken>()
  const pending = new Map<string, Promise<string>>()

  async function load(key: string, appId: string, appSecret: string): Promise<string> {
    const reply = await requestFeishuJson<TenantTokenResponse>(
      `${baseUrl}${TENANT_TOKEN_PATH}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
      doFetch(),
      timeoutMs
    )
    const payload = reply.payload ?? {}
    if (!reply.ok) throw feishuApiError('获取 tenant_access_token', reply)
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(payload.msg || `飞书 tenant_access_token 获取失败 (code=${payload.code})`)
    }
    const ttl = typeof payload.expire === 'number' && payload.expire > 0 ? payload.expire * 1000 : TOKEN_DEFAULT_TTL_MS
    cache.set(key, { token: payload.tenant_access_token, expiresAt: now() + ttl })
    return payload.tenant_access_token
  }

  return {
    async get(appId: string, appSecret: string): Promise<string> {
      const key = tenantTokenCacheKey(appId, appSecret)
      const cached = cache.get(key)
      if (cached && isTokenFresh(cached, now())) return cached.token
      const inflight = pending.get(key)
      if (inflight) return await inflight
      const task = load(key, appId, appSecret)
      pending.set(key, task)
      // 成功与失败都要摘掉在途 promise：漏删会让一次网络抖动永久卡住之后所有发送
      void task
        .catch(() => undefined)
        .then(() => {
          if (pending.get(key) === task) pending.delete(key)
        })
      return await task
    },
    peek(appId: string, appSecret: string): TenantToken | undefined {
      return cache.get(tenantTokenCacheKey(appId, appSecret))
    },
  }
}

/** 进程级共享：同 App 的多个 bot（或重建 handle 之后）复用同一个 token，少打一次频控接口 */
const sharedTokenStore = createTenantTokenStore()

// ─────────────────────────────────────────────────────────────────────────────
// SDK 加载与连接状态探测
// ─────────────────────────────────────────────────────────────────────────────

let sdkPromise: Promise<FeishuSdkModule> | null = null

/**
 * dynamic import：整包 SDK 解析 + 建连只发生在「确实有启用的飞书 bot」时，
 * 主进程启动路径不背这份开销（ZCode 同样在 feishuProvider.ts:1514 才 import）。
 * tsconfig.electron.json 是 module=CommonJS，`await import()` 会被 tsc 降级成
 * `Promise.resolve().then(() => require(...))`；SDK 的 package.json main 指向 lib/index.js（CJS），
 * require 直接拿到顶层 WSClient/EventDispatcher（无 default），因此两种导出形状都兼容。
 */
export async function loadFeishuSdk(): Promise<FeishuSdkModule> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const mod = (await import('@larksuiteoapi/node-sdk')) as unknown as FeishuSdkModule & {
        default?: FeishuSdkModule
      }
      const sdk = mod.WSClient ? mod : mod.default
      if (!sdk?.WSClient || !sdk?.EventDispatcher) {
        throw new Error('@larksuiteoapi/node-sdk 导出形状不符合预期（缺少 WSClient / EventDispatcher）')
      }
      return sdk
    })().catch((error) => {
      // 加载失败（打包缺依赖、磁盘忙）不能永久缓存住失败结果，否则重启通道也修不好
      sdkPromise = null
      throw error
    })
  }
  return sdkPromise
}

/**
 * 读连接状态：新版 SDK 有 getConnectionStatus()，^1.64 下限版本没有，
 * 退化到直接看真实 WebSocket 的 readyState（feishuProvider.ts:1569-1603 就是这么做的）。
 * 探不到就返回 'unknown'，由首连超时兜底，绝不猜「已连接」。
 */
export function readFeishuWsState(client: FeishuWsClient): FeishuWsState {
  const status = client.getConnectionStatus?.()
  if (status && typeof status.state === 'string') return status.state
  const socket = (
    client as unknown as { wsConfig?: { getWSInstance?(): { readyState?: number } | null } }
  ).wsConfig?.getWSInstance?.()
  if (socket?.readyState === WEBSOCKET_OPEN_READY_STATE) return 'connected'
  const isConnecting = (client as unknown as { isConnecting?: boolean }).isConnecting
  if (isConnecting === true) return 'connecting'
  return 'unknown'
}

/** 可取消 sleep：返回 true 表示「等完了」，false 表示被中止。全程不用 setInterval 裸跑 */
export function cancellableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 时间常量里唯一可被改写的三项，默认就是上面的生产口径。
 * 存在的理由只有一个：单测要验证「凭据轮换会被检测到」「失败后会退避重建」，
 * 而这两条各自要等 30s / 5s 的墙钟。生产代码路径不要动它（改了就是把长连接状态轮询调到 1s 以内）。
 */
export const feishuTimers = {
  statePollMs: WS_STATE_POLL_MS,
  credentialPollMs: CREDENTIAL_POLL_MS,
  backoffMs: WS_RECONNECT_BACKOFF_MS,
}

// ─────────────────────────────────────────────────────────────────────────────
// 通道实现
// ─────────────────────────────────────────────────────────────────────────────

/** 一次连接尝试的结局 */
type SessionOutcome = 'stopped' | 'credential-changed' | 'failed'

class FeishuChannelHandle implements BotChannelHandle {
  readonly provider = 'feishu'

  private bot: BotConfig | null = null
  private deps: ChannelDeps | null = null
  private controller: AbortController | null = null
  /** 当前持有的长连接 client：stop() 直接 force close，不等状态轮询下一拍 */
  private client: FeishuWsClient | null = null
  private running: Promise<void> | null = null
  private stopping = false
  private readonly dedupe = new MessageIdDedupe()
  /** markActivated 每个发送者只报一次：core 侧要落盘，每条消息都调等于刷状态文件 */
  private readonly activatedActors = new Set<string>()

  start(bot: BotConfig, deps: ChannelDeps): Promise<void> {
    this.bot = bot
    this.deps = deps
    this.controller = new AbortController()
    this.running = this.loop(bot, deps, this.controller.signal)
    return this.running
  }

  async send(target: OutboundTarget, text: string): Promise<void> {
    const deps = this.deps
    if (!deps) throw new Error('飞书通道尚未启动，无法发送')
    const receiveId = target.providerUserId?.trim()
    if (!receiveId) throw new Error('飞书发送缺少接收者 open_id')
    const secret = parseFeishuSecret((await deps.readCredential()) ?? '')
    if (!secret) throw new Error('飞书凭据未配置或格式不正确，无法发送')
    // 每次发送重读凭据：换了 App Secret 的下一条回复立刻用新 token（缓存 key 含指纹），
    // 不等长连接重建，避免「界面已改但回复仍发到旧应用」
    const token = await sharedTokenStore.get(secret.appId, secret.appSecret)
    for (const chunk of splitFeishuText(text)) {
      await this.sendTextChunk(receiveId, token, chunk, deps)
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.controller?.abort()
    // force：graceful close 要等对端应答（最长 30s），退出路径不能挂在上面
    this.client?.close({ force: true })
    const running = this.running
    this.running = null
    await running?.catch(() => undefined)
  }

  // ── 连接循环 ────────────────────────────────────────────────────────────────

  /**
   * 每轮重读凭据 → 建连 → 观察状态 → 失败退避 5s 重来。
   * 'stopped' / 指纹变化都是正常收尾（resolve），只有前者留在循环里、后者直接退出交给宿主重建。
   */
  private async loop(bot: BotConfig, deps: ChannelDeps, signal: AbortSignal): Promise<void> {
    let baselineFingerprint: string | null = null
    while (!this.stopping && !deps.isStopped() && !signal.aborted) {
      let raw: string | null = null
      try {
        raw = await deps.readCredential()
      } catch (error) {
        deps.log('读取飞书凭据失败', messageText(error))
      }
      const secret = parseFeishuSecret(raw ?? '')
      if (!raw || !secret) {
        // 没凭据不是崩溃条件：主进程先于用户配置起来是常态。置 error 后低频重试，
        // 用户填好 App ID/Secret 即自动接上，不需要重启应用。
        deps.setStatus('error', raw ? '飞书凭据格式不正确，需要 {"appId","appSecret"} 的 JSON' : '未配置飞书应用凭据')
        if (!(await cancellableSleep(feishuTimers.backoffMs, signal))) return
        continue
      }
      if (!FEISHU_APP_ID_PATTERN.test(secret.appId)) {
        deps.setStatus('error', `App ID 格式不正确（应形如 cli_ 加 16 位十六进制）：${secret.appId}`)
        if (!(await cancellableSleep(feishuTimers.backoffMs, signal))) return
        continue
      }

      const fingerprint = credentialFingerprint('feishu', raw)
      if (baselineFingerprint === null) {
        baselineFingerprint = fingerprint
      } else if (baselineFingerprint !== fingerprint) {
        // 见文件头约定 1：不在此处热重建，退出让宿主 create() 新 handle
        deps.setStatus('starting', '飞书凭据已变更，正在重启通道')
        return
      }

      const outcome = await this.session(deps, secret, fingerprint, signal)
      if (outcome === 'credential-changed') {
        // 连接期间的凭据轮换同样「退出交给宿主重建」：appSecret 只在握手时用，
        // 在旧实例里热换会让去重表与已激活身份跟着旧应用继续跑
        deps.setStatus('starting', '飞书凭据已变更，正在重启通道')
        return
      }
      if (outcome === 'stopped' || this.stopping || deps.isStopped() || signal.aborted) return
      if (!(await cancellableSleep(feishuTimers.backoffMs, signal))) return
    }
  }

  /** 一轮连接尝试：建 client → 起长连接 → 盯状态直到需要收尾。必定 close，不遗留句柄 */
  private async session(
    deps: ChannelDeps,
    secret: { appId: string; appSecret: string },
    fingerprint: string,
    signal: AbortSignal
  ): Promise<SessionOutcome> {
    let sdk: FeishuSdkModule
    try {
      sdk = await loadFeishuSdk()
    } catch (error) {
      deps.setStatus('error', `加载飞书 SDK 失败：${messageText(error)}`)
      return 'failed'
    }
    // 迟到的模块不能再建连：否则「点停用 → SDK 才加载完」会凭空多出一条长连接
    if (signal.aborted || this.stopping || deps.isStopped()) return 'stopped'
    deps.setStatus('starting', '正在建立飞书长连接')

    const dispatcher = new sdk.EventDispatcher({})
    dispatcher.register({
      'im.message.receive_v1': async (payload: unknown) => {
        await this.handleEventPayload(deps, payload)
      },
      // 机器人自己产生的 reaction 会被推回长连接；不注册 handler 时 SDK 持续打 warn 干扰排查（feishuProvider.ts:1467）
      'im.message.reaction.created_v1': async () => undefined,
    })

    /** onError 由 SDK 在重连耗尽/致命错误时触发；下一拍轮询（默认 1s）就会转成 error 状态并重建 */
    let failure: Error | null = null
    const client = new sdk.WSClient({
      appId: secret.appId,
      appSecret: secret.appSecret,
      domain: sdk.Domain?.Feishu,
      // 本期只做国内飞书：国际版是 open.larksuite.com + Domain.Lark，
      // 需要 provider 多一个取值，已在报告里记为契约缺口
      source: 'ClerkBox',
      handshakeTimeoutMs: WS_START_TIMEOUT_MS,
      // SDK 的 info 级日志每次启动都刷一大段「去后台开长连接」的说明，主进程日志会被淹；
      // warn 以上转 deps.log，状态一律由 setStatus 上报，保证界面与日志同一个口径
      logger: {
        error: (...args: unknown[]) => deps.log('[lark-ws:error]', ...args),
        warn: (...args: unknown[]) => deps.log('[lark-ws:warn]', ...args),
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
      },
      onError: (error: Error) => {
        failure = error
      },
    })
    this.client = client

    let connectedOnce = false
    let lostSince = 0
    const startedAt = Date.now()
    let lastCredentialCheck = startedAt

    try {
      try {
        await client.start({ eventDispatcher: dispatcher })
      } catch (error) {
        failure = error instanceof Error ? error : new Error(messageText(error))
      }

      while (!this.stopping && !deps.isStopped() && !signal.aborted) {
        if (failure) {
          deps.setStatus('error', `飞书长连接失败：${messageText(failure)}`)
          return 'failed'
        }
        const state = readFeishuWsState(client)
        if (state === 'failed') {
          deps.setStatus('error', '飞书长连接已断开（SDK 重连耗尽）')
          return 'failed'
        }
        if (state === 'connected') {
          if (!connectedOnce) {
            connectedOnce = true
            deps.setStatus('connected')
          }
          lostSince = 0
        } else if (connectedOnce) {
          deps.setStatus('starting', '飞书长连接重连中')
          lostSince ||= Date.now()
          // SDK 的重连有次数上限且参数由服务端下发；这里加一层看门狗，
          // 失联超过阈值就销毁整个 client 重来，而不是相信它一定能自愈
          if (Date.now() - lostSince > WS_LOST_FAIL_MS) {
            deps.setStatus('error', '飞书长连接重连超时，正在重建连接')
            return 'failed'
          }
        } else if (Date.now() - startedAt > WS_START_TIMEOUT_MS) {
          // SDK 的 start() 对非法 appId 是静默 return（见文件头），握手卡住也不 reject，
          // 所以首连必须有看门狗，否则会永远停在「连接中」而实际上一条消息都收不到
          deps.setStatus('error', `飞书长连接握手超时（${WS_START_TIMEOUT_MS / 1000}s），请检查 App ID/Secret 与「长连接」订阅方式`)
          return 'failed'
        }

        // 连接期间也要盯凭据：appSecret 只在握手时用，SDK 不会自己换凭据，
        // 不复查的话「换了 App」要等到下次断线才生效
        if (Date.now() - lastCredentialCheck >= feishuTimers.credentialPollMs) {
          lastCredentialCheck = Date.now()
          const changed = await this.credentialChanged(deps, fingerprint)
          if (changed) return 'credential-changed'
        }

        await cancellableSleep(feishuTimers.statePollMs, signal)
      }
      return 'stopped'
    } finally {
      this.client = null
      try {
        client.close({ force: true })
      } catch (error) {
        deps.log('关闭飞书长连接异常', messageText(error))
      }
    }
  }

  private async credentialChanged(deps: ChannelDeps, fingerprint: string): Promise<boolean> {
    try {
      const raw = await deps.readCredential()
      if (!raw) return true // 凭据被清空：留在旧连接上只会持续鉴权失败，交给宿主重建后报 error
      return credentialFingerprint('feishu', raw) !== fingerprint
    } catch (error) {
      deps.log('复查飞书凭据失败', messageText(error))
      return false
    }
  }

  /** 事件入口：归一化 → 去重 → 交给 core.handleInbound。任何异常都吞在这里，不能打断长连接 */
  private async handleEventPayload(deps: ChannelDeps, payload: unknown): Promise<void> {
    const bot = this.bot
    if (!bot) return
    let messages: InboundMessage[] = []
    try {
      messages = normalizeFeishuReceiveEvent(bot.id, payload)
    } catch (error) {
      deps.log('飞书事件解析失败', messageText(error))
      return
    }
    for (const message of messages) {
      const messageId = message.messageId ?? ''
      if (!this.dedupe.mark(messageId)) {
        deps.log('忽略重复的飞书消息', messageId)
        continue
      }
      if (!this.activatedActors.has(message.actor.providerUserId)) {
        this.activatedActors.add(message.actor.providerUserId)
        try {
          await deps.markActivated()
        } catch (error) {
          deps.log('记录激活时刻失败', messageText(error))
        }
      }
      try {
        await deps.onInbound(message)
      } catch (error) {
        deps.log('飞书入站处理失败', messageText(error))
      }
    }
  }

  // ── 出站 ────────────────────────────────────────────────────────────────────

  private async sendTextChunk(
    receiveId: string,
    token: string,
    text: string,
    deps: ChannelDeps
  ): Promise<void> {
    const receiveIdType = resolveReceiveIdType(receiveId)
    const reply = await requestFeishuJson<{ code?: number; msg?: string; error?: { log_id?: string } }>(
      `${FEISHU_BASE_URL}${SEND_MESSAGE_PATH}?receive_id_type=${receiveIdType}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: 'text',
          // content 必须是序列化后的字符串，直接放对象会被飞书以 9490 参数错误拒掉
          content: JSON.stringify({ text }),
        }),
      },
      globalThis.fetch
    )
    const payload = reply.payload ?? {}
    // HTTP 200 + code !== 0 是飞书的常态（权限未开通、限流都走这条），不能只看 ok
    if (!reply.ok || payload.code !== 0) {
      const error = feishuApiError('发送消息', reply)
      deps.log(messageText(error))
      throw error
    }
  }
}

export const feishuChannel: BotChannelFactory = {
  provider: 'feishu',
  create(): BotChannelHandle {
    return new FeishuChannelHandle()
  },
}
