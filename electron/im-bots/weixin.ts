/**
 * 微信 iLink / ClawBot 通道：扫码登录 + 长轮询收发文本。
 *
 * 协议权威来源是 ZCode v3.14.3（Apache-2.0）的
 * `packages/services/src/bots/providers/weixinProvider.ts` 与 `weixinRegistration.ts`：
 * 端点路径、请求/响应字段名、超时、四态语义都逐条对齐真实代码（关键处标了「文件:行号」），
 * 本文件只把它的抽象层换成 ClerkBox 的通道契约（BotChannelHandle / ChannelDeps / WeixinQrLogin），
 * 不 import 任何 `@zcode/*`，也不 import electron —— 于是协议逻辑能在 vitest 纯 node 环境里直接跑。
 *
 * 与 index.ts 的接线约定（改这里之前先读三遍）：
 * 1. **start() 的 promise 表示通道生命周期，正常退出与异常退出都 resolve，不 reject。**
 *    所有可预期故障（无凭据 / 凭据损坏 / 网络错误 / ret=-14 会话过期）都已经先经
 *    `deps.setStatus('error', 原因)` 上报，宿主不必给 start() 挂 catch —— 漏一个 catch 就是
 *    unhandledRejection 直接干掉主进程，比"宿主看不到异常"严重得多。
 *    循环退出后的补报状态也包了 try/catch —— 宿主 dispose 时可能先把 deps 拆了，
 *    那种竞态不该变成一条没人 catch 的 rejection。唯一会 reject 的路径是同一实例重复 start()。
 * 2. **凭据指纹变更即退出，通道不自己重启**：循环每轮 `deps.readCredential()` 重读，
 *    指纹与本轮启动时的基准不同就 return，由 index.ts 在 start() resolve 后用新凭据重建 handle。
 *    （ZCode 等价做法是 reconcile() 里 stopPolling + startPolling，weixinChannelRuntime.ts:283-291。）
 *    为什么不热替换 secret：旧循环闭包里的游标和新凭据的游标不是同一条队列，交错推进 = 丢消息。
 * 3. **deps.isStopped() 为真时立刻退出且不再发请求**，且此时不上报状态：宿主自己知道停的原因
 *    （disabled / removed），通道再写一次 idle 会把它的状态冲掉。
 * 4. 游标只在**本批消息全部交给 onInbound 之后**才落盘（weixinChannelRuntime.ts:159-163 的 bugfix）。
 *    中途抛错就不推进游标，服务端下一轮重投 —— 宁可 at-least-once 让宿主去重，也不能静默丢消息。
 * 5. context_token 以宿主经 OutboundTarget 传来的为准（types.ts:243-247「不要求通道自己记账」）。
 *    handle 内只另存一张 providerUserId → 最近一条 token 的兜底表：ChatContext 目前没有任何
 *    字段能存它，core 侧只能在内存里记；进程重启或 core 漏传时，这张表保证回信还送得出去。
 */
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomInt, randomUUID } from 'node:crypto'
import {
  credentialFingerprint,
  parseWeixinSecret,
  type BotChannelFactory,
  type BotChannelHandle,
  type BotConfig,
  type ChannelDeps,
  type InboundMessage,
  type OutboundTarget,
  type WeixinQrEvent,
  type WeixinQrLogin,
  type WeixinQrLoginDeps,
  type WeixinQrSession,
  type WeixinQrState,
  type WeixinSecret,
} from './types'

// ─────────────────────────────────────────────────────────────────────────────
// 协议常量（逐条对到源码行号，别凭印象改）
// ─────────────────────────────────────────────────────────────────────────────

/** weixinProvider.ts:13 —— iLink 是内置通道地址，绝不能复用 bot 的 webhook 类字段 */
export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** weixinProvider.ts:14 */
export const WEIXIN_BOT_API_PREFIX = '/ilink/bot'
/** weixinProvider.ts:15，作为 base_info.channel_version 随每个 POST 上行（:114-122） */
export const WEIXIN_CHANNEL_VERSION = '2.0.0'
/** weixinProvider.ts:16 —— message_type=2 是 bot 自己发出的消息回流，收侧必须丢掉（:489） */
const WEIXIN_MESSAGE_TYPE_BOT = 2
/** weixinProvider.ts:17 */
const WEIXIN_MESSAGE_STATE_FINISH = 2
/** weixinProvider.ts:622 —— item_list 里文本项的 type */
const WEIXIN_ITEM_TYPE_TEXT = 1
/** weixinProvider.ts:18 —— CDN 附件是 AES-128-ECB + PKCS7（Node 的默认 autoPad 就是 PKCS#7） */
const WEIXIN_CDN_AES_ALGORITHM = 'aes-128-ecb'
/** weixinProvider.ts:19 —— getupdates 服务端会挂约 35s，超时给 90s */
export const WEIXIN_GET_UPDATES_TIMEOUT_MS = 90_000
/** providerRequest.ts:1 —— 其余业务请求（sendmessage 等）走 15s 默认值。
 *  刻意不跟着 getupdates 放大到 90s：发送挂在半路会占住回复串行队列 90 秒。 */
export const WEIXIN_REQUEST_TIMEOUT_MS = 15_000
/** weixinRegistration.ts:59 —— 扫码接口也是长等待，但比 getupdates 短 */
export const WEIXIN_LOGIN_REQUEST_TIMEOUT_MS = 30_000
/** weixinRegistration.ts:57 串行轮询间隔（秒） */
export const WEIXIN_LOGIN_INTERVAL_SECONDS = 3
/** weixinRegistration.ts:58 二维码默认有效期（秒），服务端给了 expires_in 就以服务端为准（:138） */
export const WEIXIN_LOGIN_EXPIRE_SECONDS = 120
/** 会话过期：唯一恢复手段是重新扫码。ZCode 未点名该码，语义来自 IM_BOTS_SPEC.md:84 */
export const WEIXIN_RET_SESSION_EXPIRED = -14

/** 退避：首轮 1s，翻倍，封顶 30s（长轮询本身已经被服务端挂住，再快没意义） */
const POLL_BACKOFF_INITIAL_MS = 1_000
export const POLL_BACKOFF_MAX_MS = 30_000
/** 扫码会话连续失败上限：超过就置 error 收尾，避免界面永远停在"等待扫码" */
const QR_MAX_CONSECUTIVE_FAILURES = 3
/** 已出结果的扫码会话保留多久（给渲染层 peek 留窗口，之后回收） */
const QR_SESSION_RETAIN_MS = 5 * 60_000
/** context_token 兜底表的条数上限：一个私聊 bot 面对的用户数远小于这个量级，超了就淘汰最旧的 */
const CONTEXT_TOKEN_LIMIT = 256

/** 面向用户的短消息：走 setStatus 上到界面，措辞改了要同步 i18n（D6 统一收） */
const MSG_NO_CREDENTIAL = '尚未扫码登录微信，请在「IM 机器人」里扫码'
const MSG_BAD_CREDENTIAL = '微信凭据内容无效，请重新扫码登录'
const MSG_CREDENTIAL_READ_FAILED = '读取微信凭据失败，请检查系统钥匙串/凭据文件'
const MSG_SESSION_EXPIRED = '微信登录已过期，请重新扫码'
const MSG_POLLING = '微信长轮询运行中'
const MSG_STOPPED = '微信长轮询已停止'

// ─────────────────────────────────────────────────────────────────────────────
// 错误类型
// ─────────────────────────────────────────────────────────────────────────────

export class WeixinApiError extends Error {
  readonly path: string
  readonly ret: number | null
  /** true = 登录态失效（ret=-14），只有重新扫码能救，循环必须退出而不是退避重试 */
  readonly sessionExpired: boolean

  constructor(
    message: string,
    init: { path: string; ret?: number | null; sessionExpired?: boolean }
  ) {
    super(message)
    this.name = 'WeixinApiError'
    this.path = init.path
    this.ret = init.ret ?? null
    this.sessionExpired = init.sessionExpired === true
  }
}

/** 有界超时被打断（不是网络失败，扫码轮询据此把"服务端还在挂"和"请求出错"分开处理） */
export class WeixinTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`微信 iLink ${path} 请求超时（${Math.round(timeoutMs / 1000)}s）`)
    this.name = 'WeixinTimeoutError'
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯协议函数：URL 拼装 / 请求体构造 / 响应归一化（单测直接打这几个）
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 微信的 id 字段有数字也有字符串，统一成字符串（weixinProvider.ts:54-60） */
function readNumberOrString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key]
  if (typeof value === 'string') return value
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function firstString(record: Record<string, unknown> | null | undefined, keys: string[]): string {
  for (const key of keys) {
    const value = readString(record, key)
    if (value) return value
  }
  return ''
}

/** baseUrl 归一：去掉结尾斜杠，非 http(s) 一律回落内置地址（脏凭据不该把请求带出协议） */
export function normalizeWeixinBaseUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/u, '')
  if (!/^https?:\/\//iu.test(trimmed)) return WEIXIN_DEFAULT_BASE_URL
  return trimmed
}

/** path 一律以 '/' 开头，可以自带 query（weixinRegistration.ts:87 的拼法） */
export function buildWeixinApiUrl(path: string, baseUrl?: string | null): string {
  return `${normalizeWeixinBaseUrl(baseUrl)}${WEIXIN_BOT_API_PREFIX}${path}`
}

/** 取码请求：bot_type=3 是微信 bot 的固定值（weixinRegistration.ts:132） */
export function buildWeixinQrBeginUrl(baseUrl?: string | null): string {
  return buildWeixinApiUrl('/get_bot_qrcode?bot_type=3', baseUrl)
}

/** 状态长轮询：qrcode 必须 encode，二维码串里有 URL 保留字符（weixinRegistration.ts:155） */
export function buildWeixinQrStatusUrl(qrCode: string, baseUrl?: string | null): string {
  return buildWeixinApiUrl(`/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`, baseUrl)
}

/** X-WECHAT-UIN：随机 uin 的 base64（weixinProvider.ts:101-103），服务端拿它做请求侧标识 */
export function buildWeixinUin(): string {
  return Buffer.from(String(randomInt(0, 0x1_0000_0000)), 'utf8').toString('base64')
}

/** 鉴权头（weixinProvider.ts:105-112）：AuthorizationType 少了它服务端直接拒 */
export function buildWeixinApiHeaders(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': buildWeixinUin(),
  }
}

/** base_info 恒在最外层（weixinProvider.ts:114-122）。键序也照抄源码：base_info 在前，
 *  业务体里真出现同名字段时以业务体为准 —— 我们不传它，保持同序只是为了行为不漂。 */
export function withWeixinBaseInfo(body: Record<string, unknown>): Record<string, unknown> {
  return { base_info: { channel_version: WEIXIN_CHANNEL_VERSION }, ...body }
}

/**
 * 出站文本换行归一（weixinProvider.ts:482-486 的 bugfix）：
 * iLink 客户端对裸 LF 的处理不一致，/status 这类多行回复会被折叠成一行，统一成 CRLF 才是硬换行。
 */
export function normalizeWeixinOutboundText(text: string): string {
  return text.replace(/\r\n|\r|\n/gu, '\r\n')
}

/** 发消息体（weixinProvider.ts:613-628）：文本进 msg.item_list，context_token 原样回传 */
export function buildWeixinSendBody(input: {
  secret: WeixinSecret
  target: OutboundTarget
  text: string
  clientId?: string
}): Record<string, unknown> {
  const contextToken = input.target.contextToken?.trim() ?? ''
  return {
    msg: {
      // from_user_id = 机器人自己的 iLink bot id；ZCode 存在 providerUserId，我们存在凭据的 instanceId
      from_user_id: input.secret.instanceId ?? '',
      to_user_id: input.target.providerUserId,
      client_id: input.clientId ?? `clerkbox-weixin-${randomUUID()}`,
      message_type: WEIXIN_MESSAGE_TYPE_BOT,
      message_state: WEIXIN_MESSAGE_STATE_FINISH,
      ...(contextToken ? { context_token: contextToken } : {}),
      item_list: [{ type: WEIXIN_ITEM_TYPE_TEXT, text_item: { text: normalizeWeixinOutboundText(input.text) } }],
    },
  }
}

/** 收消息体（weixinProvider.ts:576-579）：只有游标，首轮回空串 */
export function buildWeixinUpdatesBody(buf: string | undefined): Record<string, unknown> {
  return { get_updates_buf: buf ?? '' }
}

/** 服务端可能把结果裹一层 data（weixinProvider.ts:160-168） */
function unwrapWeixinData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {}
  if ('data' in payload) return isRecord(payload.data) ? payload.data : {}
  return payload
}

/** 消息数组的字段名各家版本不一，按 ZCode 的兜底顺序取（weixinProvider.ts:442-452） */
function readWeixinMessageList(payload: unknown): Record<string, unknown>[] {
  const container = unwrapWeixinData(payload)
  const rawMessages =
    container.msgs ?? container.messages ?? container.updates ?? container.items ?? container.list
  if (Array.isArray(rawMessages)) return rawMessages.filter(isRecord)
  if (isRecord(rawMessages)) return [rawMessages]
  return []
}

/** 下一轮游标的兜底字段名（weixinProvider.ts:454-465） */
export function readWeixinNextBuf(payload: unknown): string | undefined {
  const container = unwrapWeixinData(payload)
  return (
    firstString(container, [
      'get_updates_buf',
      'buf',
      'next_buf',
      'nextBuf',
      'getUpdatesBuf',
      'syncKey',
    ]) || undefined
  )
}

function readWeixinInner(record: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(record.msg) ? record.msg : isRecord(record.message) ? record.message : null
}

function readWeixinItemList(record: Record<string, unknown>): unknown[] {
  const inner = readWeixinInner(record)
  if (Array.isArray(record.item_list)) return record.item_list
  if (inner && Array.isArray(inner.item_list)) return inner.item_list
  return []
}

/** 文本项取值顺序（weixinProvider.ts:175-181） */
function readWeixinTextItem(item: unknown): string {
  if (!isRecord(item)) return ''
  const textItem = isRecord(item.text_item) ? item.text_item : null
  return readString(textItem, 'text') || readString(item, 'text') || readString(item, 'content')
}

/** 正文：顶层字段优先，其次拼 item_list（weixinProvider.ts:343-351） */
export function readWeixinMessageText(record: Record<string, unknown>): string {
  const direct = readString(record, 'text') || readString(record, 'content') || readString(record, 'message')
  if (direct) return direct
  const inner = readWeixinInner(record)
  const fromItems = readWeixinItemList(record)
    .map(readWeixinTextItem)
    .filter(Boolean)
    .join('\n')
  return fromItems || (inner ? readString(inner, 'text') || readString(inner, 'content') : '')
}

/** 发送者 id 的兜底字段名（weixinProvider.ts:371-387） */
function readWeixinUserId(record: Record<string, unknown>): string {
  const from = isRecord(record.from) ? record.from : null
  const sender = isRecord(record.sender) ? record.sender : null
  return (
    firstString(record, [
      'from_user_id',
      'from',
      'from_user',
      'fromUser',
      'user',
      'user_id',
      'userId',
    ]) ||
    firstString(from, ['id', 'wxid']) ||
    firstString(sender, ['id', 'wxid'])
  )
}

/** 群判定：有 room/chat 即为群聊（weixinProvider.ts:389-399，:508 据此分 private/group） */
function readWeixinChatId(record: Record<string, unknown>): string | undefined {
  return (
    firstString(record, ['room', 'room_id', 'roomId', 'chat', 'chat_id', 'chatId']) || undefined
  )
}

function readWeixinDisplayName(record: Record<string, unknown>): string | undefined {
  const from = isRecord(record.from) ? record.from : null
  const sender = isRecord(record.sender) ? record.sender : null
  const inner = readWeixinInner(record)
  return (
    firstString(record, ['name', 'displayName', 'nickname']) ||
    firstString(from, ['name', 'nickname']) ||
    firstString(sender, ['name', 'nickname']) ||
    (inner ? readString(inner, 'sender_name') || undefined : undefined)
  )
}

function readWeixinMessageId(record: Record<string, unknown>): string | undefined {
  const inner = readWeixinInner(record)
  const direct =
    firstString(record, ['id', 'msgid', 'msgId']) ||
    readNumberOrString(record, 'message_id') ||
    (inner
      ? firstString(inner, ['id', 'msgid', 'msgId']) || readNumberOrString(inner, 'message_id')
      : '')
  if (direct) return direct
  // 微信的数字 msgid 也要能当去重键用（weixinProvider.ts:432-439）
  const numeric =
    readNumber(record, 'id') ??
    readNumber(record, 'msgid') ??
    readNumber(record, 'msgId') ??
    (inner ? readNumber(inner, 'id') ?? readNumber(inner, 'msgid') ?? readNumber(inner, 'msgId') : null)
  return numeric === null ? undefined : String(numeric)
}

/** context_token 的兜底字段名（weixinProvider.ts:467-476） */
function readWeixinContextToken(record: Record<string, unknown>): string | undefined {
  const inner = readWeixinInner(record)
  return (
    firstString(record, ['context_token', 'contextToken', 'context']) ||
    (inner ? readString(inner, 'context_token') || undefined : undefined)
  )
}

/**
 * 单条原始消息 → InboundMessage；不合格的不返回 message，只回丢弃原因（日志统计用）。
 * 丢弃规则：
 * - message_type=2：bot 自己发出的消息回流（回复自己 = 死循环）；
 * - 有 room/chat：群消息，本期不收（IM_BOTS_SPEC.md:10 列为非目标，:147 是安全边界）；
 * - 无发送者 id：没法回目标；
 * - 文本为空：本期不处理附件，附件消息宁可不回（P2 再接）。
 * 注意 context_token 缺失**不**丢弃：消息内容是用户真实输入，吞掉比回不出去更糟；
 * 交给 core 决定怎么处理，通道只保证"原样带上它有的东西"。
 */
export function normalizeWeixinMessage(
  botId: string,
  raw: Record<string, unknown>
): { message?: InboundMessage; drop?: 'self' | 'group' | 'noUser' | 'emptyText' } {
  if (readNumber(raw, 'message_type') === WEIXIN_MESSAGE_TYPE_BOT) return { drop: 'self' }
  const providerUserId = readWeixinUserId(raw).trim()
  if (!providerUserId) return { drop: 'noUser' }
  if (readWeixinChatId(raw)) return { drop: 'group' }
  const text = readWeixinMessageText(raw).trim()
  if (!text) return { drop: 'emptyText' }
  const displayName = readWeixinDisplayName(raw)
  const messageId = readWeixinMessageId(raw)
  const contextToken = readWeixinContextToken(raw)
  return {
    message: {
      actor: {
        botId,
        provider: 'weixin',
        providerUserId,
        chatType: 'private',
        ...(displayName ? { displayName } : {}),
      },
      text,
      ...(messageId ? { messageId } : {}),
      ...(contextToken ? { contextToken } : {}),
    },
  }
}

export interface WeixinUpdatesResult {
  messages: InboundMessage[]
  /** 下一轮游标：服务端没给就沿用本轮传入的（weixinProvider.ts:590） */
  buf?: string
  rawCount: number
  drops: { self: number; group: number; noUser: number; emptyText: number }
}

/** getupdates 响应 → InboundMessage[]（纯函数，单测直接喂 JSON） */
export function normalizeWeixinUpdates(
  payload: unknown,
  botId: string,
  currentBuf?: string
): WeixinUpdatesResult {
  const rawMessages = readWeixinMessageList(payload)
  const messages: InboundMessage[] = []
  const drops = { self: 0, group: 0, noUser: 0, emptyText: 0 }
  for (const raw of rawMessages) {
    const normalized = normalizeWeixinMessage(botId, raw)
    if (normalized.message) {
      messages.push(normalized.message)
      continue
    }
    if (normalized.drop === 'self') drops.self += 1
    else if (normalized.drop === 'group') drops.group += 1
    else if (normalized.drop === 'noUser') drops.noUser += 1
    else if (normalized.drop === 'emptyText') drops.emptyText += 1
  }
  const nextBuf = readWeixinNextBuf(payload)
  return { messages, buf: nextBuf ?? currentBuf, rawCount: rawMessages.length, drops }
}

// ─────────────────────────────────────────────────────────────────────────────
// 媒体加解密（AES-128-ECB / PKCS7）
// 本期 IM 只收发文本，通道里不接下载链路（P2），但实现必须先长好并被单测锁住：
// 密钥解析有 hex / base64 / base64(十六进制串) 三种形态，没有真机样本根本发现不了。
// ─────────────────────────────────────────────────────────────────────────────

/** 密钥解析三试：32 位 hex → 直接当 16 字节；base64 解出 16 字节；base64 解出的是 hex 串（weixinProvider.ts:62-80） */
export function parseWeixinAesKey(value: string): Buffer | null {
  const trimmed = value.trim()
  if (/^[a-f0-9]{32}$/iu.test(trimmed)) return Buffer.from(trimmed, 'hex')
  try {
    const decoded = Buffer.from(trimmed, 'base64')
    if (decoded.length === 16) return decoded
    const decodedText = decoded.toString('utf8').trim()
    if (/^[a-f0-9]{32}$/iu.test(decodedText)) return Buffer.from(decodedText, 'hex')
  } catch {
    return null
  }
  return null
}

function weixinMediaCipher(key: string, mode: 'encrypt' | 'decrypt', data: Uint8Array): Uint8Array {
  const parsed = parseWeixinAesKey(key)
  if (!parsed) throw new Error('微信附件 AES 密钥格式无效')
  // ECB 没有 IV；autoPad 保持默认 true —— Node 的默认填充就是 PKCS#7，
  // 显式关掉会得到少一个 padding 段的坏文件（微信 CDN 的密文是带 padding 的整块）。
  const cipher =
    mode === 'encrypt'
      ? createCipheriv(WEIXIN_CDN_AES_ALGORITHM, parsed, null)
      : createDecipheriv(WEIXIN_CDN_AES_ALGORITHM, parsed, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** 解密 CDN 密文（weixinProvider.ts:82-90） */
export function decryptWeixinMediaBytes(data: Uint8Array, aesKey: string): Uint8Array {
  return weixinMediaCipher(aesKey, 'decrypt', data)
}

/** 加密待上传字节：P2 出站附件用，本期只随单测保活 */
export function encryptWeixinMediaBytes(data: Uint8Array, aesKey: string): Uint8Array {
  return weixinMediaCipher(aesKey, 'encrypt', data)
}

// ─────────────────────────────────────────────────────────────────────────────
// 扫码状态四态归一（weixinRegistration.ts:104-128 + :165-183）
// ─────────────────────────────────────────────────────────────────────────────

export interface WeixinQrStatusResult {
  state: WeixinQrState
  /** confirmed 时服务端下发的 bot_token */
  token?: string
  /** iLink bot id，发送时要当 from_user_id 用 */
  instanceId?: string
  /** confirmed 时服务端可以重定向到新域名，后续所有请求都要用它 */
  baseUrl?: string
  message?: string
}

function mapWeixinQrStatus(status: unknown): WeixinQrState {
  if (typeof status === 'number') {
    if (status === 0) return 'waiting'
    if (status === 1) return 'scanned'
    if (status === 2) return 'confirmed'
    if (status === 3 || status === 4) return 'expired'
    return 'waiting'
  }
  if (typeof status !== 'string') return 'waiting'
  const normalized = status.toLowerCase()
  if (['confirmed', 'confirm', 'authorized', 'success', 'ok'].includes(normalized)) return 'confirmed'
  if (['scaned', 'scanned', 'scan', 'confirmed_wait'].includes(normalized)) return 'scanned'
  if (['expired', 'timeout', 'cancel', 'cancelled', 'canceled'].includes(normalized)) return 'expired'
  if (['error', 'failed', 'fail'].includes(normalized)) return 'error'
  // 未知状态一律当"还在等"：四态之外还冒出别的值时，把码判死等于把用户的扫码作废
  return 'waiting'
}

/** get_qrcode_status 响应 → 四态 + 凭据料（入参是已经展开过 data 的对象） */
export function normalizeWeixinQrStatus(payload: Record<string, unknown>): WeixinQrStatusResult {
  const state = mapWeixinQrStatus(payload.status ?? payload.qrcode_status ?? payload.qr_status)
  if (state === 'confirmed') {
    const token = readString(payload, 'bot_token') || readString(payload, 'token')
    if (!token) {
      // 服务端说成功但没给 token：这是协议异常，不能当成功写坏凭据
      return { state: 'error', message: '微信登录成功但未返回 bot_token，请重新扫码' }
    }
    const instanceId = readString(payload, 'ilink_bot_id') || readString(payload, 'bot_id')
    const baseUrl = readString(payload, 'baseurl') || readString(payload, 'base_url')
    return {
      state: 'confirmed',
      token,
      ...(instanceId ? { instanceId } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    }
  }
  if (state === 'expired') return { state: 'expired', message: '二维码已过期，请重新扫码' }
  if (state === 'error') {
    return { state: 'error', message: readString(payload, 'errmsg') || '微信登录失败，请重新扫码' }
  }
  return { state }
}

/** 取码响应 → 二维码内容（weixinRegistration.ts:132-144）；拿不到码回 null */
export function parseWeixinQrBegin(
  payload: Record<string, unknown>,
  now = Date.now()
): { qrCode: string; qrUrl: string; intervalSeconds: number; expiresAt: number } | null {
  const qrCode = readString(payload, 'qrcode') || readString(payload, 'qr_code')
  // 画码用的是 qrcode_img_content / qrcode_url，两者都没有时二维码串本身就是可扫内容
  const qrUrl =
    readString(payload, 'qrcode_img_content') || readString(payload, 'qrcode_url') || qrCode
  if (!qrCode || !qrUrl) return null
  const expireSeconds = readNumber(payload, 'expires_in') ?? WEIXIN_LOGIN_EXPIRE_SECONDS
  return {
    qrCode,
    qrUrl,
    // 轮询间隔是写死的 3 秒（weixinRegistration.ts:141 传的就是常量），
    // 服务端并不下发 interval，读它的字段等于依赖一个不存在的契约
    intervalSeconds: WEIXIN_LOGIN_INTERVAL_SECONDS,
    expiresAt: now + Math.max(1, expireSeconds) * 1000,
  }
}

/** 凭据落盘内容：WeixinSecretSchema 的 JSON 串（strictObject，多写字段会被自己拒掉） */
export function buildWeixinSecretJson(result: WeixinQrStatusResult): string {
  const secret: WeixinSecret = {
    token: String(result.token ?? ''),
    baseUrl: normalizeWeixinBaseUrl(result.baseUrl),
    ...(result.instanceId ? { instanceId: result.instanceId } : {}),
  }
  return JSON.stringify(secret)
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP 层
// ─────────────────────────────────────────────────────────────────────────────

interface WeixinFetchInit {
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * 单次请求：外超时 + 外部 signal + 响应体消费，三者共用一个 controller
 * （providerRequest.ts:15-41 的关键点：收到响应头不等于请求结束，headers 之后停滞
 * 一样能把长轮询循环永久钉住，所以 body 必须在同一个 signal 下读完）。
 * 返回状态码与 JSON，交给调用方判业务错误码。
 */
async function weixinRequest(
  url: string,
  path: string,
  init: WeixinFetchInit
): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController()
  const external = init.signal
  const onExternalAbort = (): void => controller.abort(external?.reason)
  if (external?.aborted) onExternalAbort()
  else external?.addEventListener('abort', onExternalAbort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new WeixinTimeoutError(path, init.timeoutMs)),
    init.timeoutMs
  )
  timer.unref?.()
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      })
    } catch (error) {
      const reason = controller.signal.reason
      if (reason instanceof WeixinTimeoutError) throw reason
      throw error
    }
    const text = await response.text()
    let payload: unknown = null
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        if (response.ok) throw new WeixinApiError(`微信 iLink ${path} 返回了非 JSON 响应`, { path })
      }
    }
    return { status: response.status, payload }
  } finally {
    clearTimeout(timer)
    if (external) external.removeEventListener('abort', onExternalAbort)
  }
}

/** ret / errcode 非 0 即失败；-14 单独打标记（weixinProvider.ts:150-157） */
function assertWeixinRet(payload: unknown, path: string): void {
  const top = isRecord(payload) ? payload : null
  const data = unwrapWeixinData(payload)
  for (const source of [top, data]) {
    if (!source) continue
    const ret = readNumber(source, 'ret')
    const errcode = readNumber(source, 'errcode')
    const bad = (ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)
    if (!bad) continue
    const code = ret ?? errcode
    const message =
      readString(source, 'errmsg') || readString(source, 'message') || `ret=${ret ?? ''} errcode=${errcode ?? ''}`
    throw new WeixinApiError(`微信 iLink ${path} 失败：${message}`, {
      path,
      ret: code,
      sessionExpired: code === WEIXIN_RET_SESSION_EXPIRED,
    })
  }
}

/** 带凭据的 POST（业务请求全部走这一个出口） */
export async function weixinApiPost(
  path: string,
  secret: WeixinSecret,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = WEIXIN_REQUEST_TIMEOUT_MS
): Promise<unknown> {
  const token = secret.token.trim()
  if (!token) throw new WeixinApiError(MSG_NO_CREDENTIAL, { path })
  const { status, payload } = await weixinRequest(buildWeixinApiUrl(path, secret.baseUrl), path, {
    method: 'POST',
    headers: buildWeixinApiHeaders(token),
    body: JSON.stringify(withWeixinBaseInfo(body)),
    timeoutMs,
    signal,
  })
  if (status < 200 || status >= 300) {
    throw new WeixinApiError(`微信 iLink ${path} 失败：HTTP ${status}`, { path })
  }
  assertWeixinRet(payload, path)
  return payload
}

/** 扫码接口是免鉴权的 GET，只多一个客户端版本头（weixinRegistration.ts:87-91） */
async function weixinLoginGet(
  path: string,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const { status, payload } = await weixinRequest(buildWeixinApiUrl(path), path, {
    method: 'GET',
    headers: { 'iLink-App-ClientVersion': '1' },
    timeoutMs,
    signal,
  })
  if (status < 200 || status >= 300) {
    throw new WeixinApiError(`微信登录 ${path} 失败：HTTP ${status}`, { path })
  }
  assertWeixinRet(payload, path)
  // 登录响应把字段放在 data 里，展平到顶层再读（weixinRegistration.ts:79-84）
  const data = isRecord(payload) && isRecord(payload.data) ? { ...payload, ...payload.data } : payload
  return isRecord(data) ? data : {}
}

/**
 * 长轮询收消息：服务端约 35s 挂起，超时给 90s。
 * botId 由调用方传入 ClerkBox 侧的 id（渠道侧的 iLink bot id 只当 from_user_id 用，
 * 不能拿来拼 actorKey，否则换号后同一批人会挂到不同上下文上）。
 */
export async function getWeixinUpdates(input: {
  botId: string
  secret: WeixinSecret
  buf?: string
  signal?: AbortSignal
}): Promise<WeixinUpdatesResult> {
  const payload = await weixinApiPost(
    '/getupdates',
    input.secret,
    buildWeixinUpdatesBody(input.buf),
    input.signal,
    WEIXIN_GET_UPDATES_TIMEOUT_MS
  )
  return normalizeWeixinUpdates(payload, input.botId, input.buf)
}

// ─────────────────────────────────────────────────────────────────────────────
// 通道实现
// ─────────────────────────────────────────────────────────────────────────────

/** 可被 abort 打断的 sleep：绝不能用 setInterval 裸跑长任务，否则 stop() 要等到下一个 tick */
function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 指数退避：1s → 2s → 4s …… 封顶 30s */
export function weixinBackoffMs(failures: number): number {
  const safe = Math.max(1, Math.min(failures, 10))
  return Math.min(POLL_BACKOFF_MAX_MS, POLL_BACKOFF_INITIAL_MS * 2 ** (safe - 1))
}

class WeixinChannelHandle implements BotChannelHandle {
  readonly provider = 'weixin' as const

  private deps: ChannelDeps | null = null
  private controller: AbortController | null = null
  private loop: Promise<void> | null = null
  private stopRequested = false
  /** 「激活」= 用户主动发第一条；每个 handle 实例只记一次（游标丢了也不重复记） */
  private activated = false
  /**
   * providerUserId → 最近一次入站的 context_token。**只是兜底**：契约规定 token 由宿主经
   * OutboundTarget 传（types.ts:243-247「不要求通道自己记账」），而 ChatContext 里目前没有
   * 存它的字段，core 忘了回传就是「收得到、回不出」。这张表让通道至少能把话送回去，
   * 代价是进程重启后要靠首条入站消息重建 —— 所以 target 带了 token 时一律以 target 为准。
   */
  private lastTokens = new Map<string, string>()

  /**
   * 语义见文件头「接线约定 1」：生命周期正常结束与异常结束都 resolve（原因已经走 setStatus），
   * 只有同一实例重复 start() 才抛 —— 那是接线错误，必须响。
   */
  async start(bot: BotConfig, deps: ChannelDeps): Promise<void> {
    if (this.loop) throw new Error('weixin channel already started：一个 handle 只允许 start 一次')
    this.deps = deps
    this.stopRequested = false
    const controller = new AbortController()
    this.controller = controller
    deps.setStatus('starting', '正在启动微信长轮询')
    const done = this.runLoop(bot, deps, controller.signal).then(() => {
      // 只有"被要求停"才补报 idle；isStopped 为真说明宿主已经写了 disabled/别的状态。
      // 整段包 try/catch：dispose 时 deps 可能先被拆掉，别让一条没人 catch 的 rejection 干掉主进程。
      try {
        if (this.stopRequested && !deps.isStopped()) deps.setStatus('idle', MSG_STOPPED)
      } catch (error) {
        deps.log('[weixin] 退出状态上报失败', errorText(error))
      }
    })
    this.loop = done
    return done
  }

  private async runLoop(bot: BotConfig, deps: ChannelDeps, signal: AbortSignal): Promise<void> {
    let baselineFingerprint: string | null = null
    let failures = 0
    while (!signal.aborted && !deps.isStopped()) {
      // 每轮重读凭据：重新扫码会换掉 token/baseUrl，指纹比对同时兼作「换号即重启」的判据。
      // 读失败是宿主侧存储出问题，退避重试没意义，直接带原因退出交给 index.ts 决策。
      let raw: string | null = null
      try {
        raw = await deps.readCredential()
      } catch (error) {
        deps.setStatus('error', `${MSG_CREDENTIAL_READ_FAILED}：${errorText(error)}`)
        return
      }
      if (signal.aborted || deps.isStopped()) return
      if (raw === null) {
        deps.setStatus('error', MSG_NO_CREDENTIAL)
        return
      }
      const secret = parseWeixinSecret(raw)
      if (!secret) {
        deps.setStatus('error', MSG_BAD_CREDENTIAL)
        return
      }
      const fingerprint = credentialFingerprint('weixin', raw)
      if (baselineFingerprint === null) {
        baselineFingerprint = fingerprint
      } else if (fingerprint !== baselineFingerprint) {
        // 不处理这条新凭据、也不改状态：新 handle 会用新 token 重新起一条循环（文件头约定 2）
        deps.log(`[weixin] bot=${bot.id} 凭据指纹变化，退出当前轮询循环，等待宿主重建 handle`)
        return
      }

      try {
        const cursor = await deps.readCursor()
        const result = await getWeixinUpdates({ botId: bot.id, secret, buf: cursor, signal })
        if (signal.aborted) return
        failures = 0
        for (const message of result.messages) {
          if (signal.aborted || deps.isStopped()) return
          // 先记下这条消息的回信凭据再交给宿主：onInbound 抛了也不影响"至少还能回话"
          this.rememberContextToken(message)
          // onInbound 抛出 → 整批不写游标 → 服务端下一轮重投；宿主负责按 messageId 去重
          await deps.onInbound(message)
          if (!this.activated) {
            this.activated = true
            await deps.markActivated()
          }
        }
        if (result.buf && result.buf !== cursor) {
          await deps.writeCursor(result.buf)
        }
        const dropped =
          result.drops.self + result.drops.group + result.drops.noUser + result.drops.emptyText
        if (dropped > 0) {
          // 只记字段计数，不记正文：原始消息里可能夹着用户的私人内容
          deps.log(
            `[weixin] bot=${bot.id} raw=${result.rawCount} inbound=${result.messages.length} dropped=${JSON.stringify(result.drops)}`
          )
        }
        // 每轮都报一次 polling：宿主负责去抖与广播，界面才知道循环还活着
        deps.setStatus('polling', MSG_POLLING)
      } catch (error) {
        if (signal.aborted || deps.isStopped()) return
        if (error instanceof WeixinApiError && error.sessionExpired) {
          // ret=-14：服务端登录态没了。继续退避重试只会白耗请求，退出让用户重扫
          deps.setStatus('error', MSG_SESSION_EXPIRED)
          return
        }
        failures += 1
        const delay = weixinBackoffMs(failures)
        // 第一次失败不报 error：网络抖动会自动恢复，把状态打成「连接异常」会诱导用户
        // 去重新扫码——那解决不了抖动，还白白丢掉登录态。连续失败才升级为 error。
        if (failures >= 2) {
          deps.setStatus('error', `微信长轮询失败：${errorText(error)}（${Math.round(delay / 1000)}s 后重试）`)
        } else {
          deps.setStatus('polling', '网络波动，正在重试')
        }
        deps.log(`[weixin] bot=${bot.id} 轮询失败 attempt=${failures} retryIn=${delay}ms`, errorText(error))
        await cancellableSleep(delay, signal)
      }
    }
  }

  async send(target: OutboundTarget, text: string): Promise<void> {
    const deps = this.deps
    if (!deps) throw new Error('weixin channel not started：请先 start 再 send')
    const raw = await deps.readCredential()
    if (raw === null) throw new Error(MSG_NO_CREDENTIAL)
    const secret = parseWeixinSecret(raw)
    if (!secret) throw new Error(MSG_BAD_CREDENTIAL)
    const providerUserId = target.providerUserId.trim()
    if (!providerUserId) throw new Error('微信发送缺少 to_user_id')
    // token 一律以宿主传来的 OutboundTarget 为准，只有它没带才回退到本实例记的那一条
    const fromTarget = target.contextToken?.trim() ?? ''
    const contextToken = fromTarget || (this.lastTokens.get(providerUserId) ?? '')
    if (!contextToken) {
      deps.log('[weixin] 出站没有 context_token，服务端可能直接拒（bot 不能主动发起会话，得用户先发一条）')
    } else if (!fromTarget) {
      deps.log('[weixin] OutboundTarget 未带 context_token，回退用最近一次入站的记录')
    }
    await weixinApiPost(
      '/sendmessage',
      secret,
      buildWeixinSendBody({
        secret,
        target: { providerUserId, ...(contextToken ? { contextToken } : {}) },
        text,
      })
    )
  }

  /**
   * 记下这条入站消息的回信凭据（见 lastTokens 字段注释：只作兜底，不替代 OutboundTarget）。
   * 记在 onInbound 之前，因为宿主处理失败时我们也该保有把话送回去的能力。
   */
  private rememberContextToken(message: InboundMessage): void {
    const token = message.contextToken?.trim()
    const user = message.actor.providerUserId
    if (!token || !user) return
    // Map 的插入顺序就是新鲜度顺序：先删再塞把这条顶到最新，超限时淘汰最早的一条
    this.lastTokens.delete(user)
    this.lastTokens.set(user, token)
    if (this.lastTokens.size > CONTEXT_TOKEN_LIMIT) {
      const oldest = this.lastTokens.keys().next()
      if (!oldest.done) this.lastTokens.delete(oldest.value)
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    this.controller?.abort()
    const loop = this.loop
    if (!loop) return
    try {
      await loop
    } catch (error) {
      // 状态已经在 start 的链路上报过，这里只留日志，不把异常再抛给宿主造成双份噪音
      this.deps?.log('[weixin] stop 时轮询循环异常退出', errorText(error))
    }
  }
}

export const weixinChannel: BotChannelFactory = {
  provider: 'weixin',
  create(): BotChannelHandle {
    return new WeixinChannelHandle()
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 扫码登录编排器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 微信扫码登录（IM_BOTS_SPEC.md 第 9.3 节的四态状态机）。
 *
 * 为什么要"主进程自己转 + 渲染层按需 peek"：get_qrcode_status 是长轮询，状态只在服务端
 * 挂住的那 30 秒里连续变化，窗口销毁或事件漏发会让界面永远停在「等待扫码」。
 * 所以每次变化都广播，同时留一份同步可查的快照。
 *
 * 串行轮询而不是 setInterval：状态接口会长时间挂起，定时器会让请求堆叠、多个结果互相覆盖
 * （ZCode 在同一处也踩过这个坑，BotsDialog.tsx:608-610）。
 */
export function createWeixinQrLogin(deps: WeixinQrLoginDeps): WeixinQrLogin {
  interface Entry {
    session: WeixinQrSession
    qrCode: string
    intervalMs: number
    expiresAt: number
    controller: AbortController
  }

  const entries = new Map<string, Entry>()

  function emit(entry: Entry): void {
    const event: WeixinQrEvent = {
      session: entry.session.id,
      botId: entry.session.botId,
      state: entry.session.state,
      ...(entry.session.qrUrl ? { qrUrl: entry.session.qrUrl } : {}),
      ...(entry.session.message ? { message: entry.session.message } : {}),
    }
    deps.onEvent(event)
  }

  /** 只在状态或提示文案真的变了时才广播，避免 3 秒一次的 waiting 刷屏 */
  function update(entry: Entry, patch: { state?: WeixinQrState; message?: string }): void {
    const changed =
      (patch.state !== undefined && patch.state !== entry.session.state) ||
      (patch.message !== undefined && patch.message !== entry.session.message)
    if (patch.state !== undefined) entry.session.state = patch.state
    if (patch.message !== undefined) entry.session.message = patch.message
    if (changed) emit(entry)
  }

  function finish(entry: Entry, state: WeixinQrState, message?: string): void {
    entry.session.finished = true
    update(entry, { state, ...(message ? { message } : {}) })
    entry.controller.abort()
  }

  function prune(): void {
    const now = Date.now()
    for (const [id, entry] of entries) {
      if (entry.session.finished && now - entry.session.createdAt > QR_SESSION_RETAIN_MS) {
        entries.delete(id)
      }
    }
  }

  async function run(entry: Entry): Promise<void> {
    const signal = entry.controller.signal
    let failures = 0
    while (!signal.aborted) {
      if (Date.now() >= entry.expiresAt) {
        finish(entry, 'expired', '二维码已过期，请重新扫码')
        return
      }
      try {
        const payload = await weixinLoginGet(
          `/get_qrcode_status?qrcode=${encodeURIComponent(entry.qrCode)}`,
          signal,
          WEIXIN_LOGIN_REQUEST_TIMEOUT_MS
        )
        if (signal.aborted) return
        const result = normalizeWeixinQrStatus(payload)
        failures = 0
        if (result.state === 'confirmed') {
          // 先落凭据再广播 confirmed：渲染层收到 confirmed 就会去刷新 bot 列表，
          // 顺序反过来会让列表读到"已登录但没凭据"的中间态。
          await deps.writeCredential(buildWeixinSecretJson(result))
          if (signal.aborted) return
          deps.log(`[weixin-qr] session=${entry.session.id} 扫码确认，凭据已写入`)
          finish(entry, 'confirmed', '登录成功，去微信发一条消息激活')
          return
        }
        if (result.state === 'error') {
          finish(entry, 'error', result.message ?? '微信登录失败，请重新扫码')
          return
        }
        if (result.state === 'expired') {
          finish(entry, 'expired', result.message ?? '二维码已过期，请重新扫码')
          return
        }
        update(entry, { state: result.state })
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof WeixinTimeoutError) {
          // 状态接口本来就会长挂：超时不代表登录失败，当"还在等"继续串轮（weixinRegistration.ts:157-163）
          deps.log(`[weixin-qr] session=${entry.session.id} 状态轮询超时，按等待处理`)
        } else if (error instanceof WeixinApiError && error.sessionExpired) {
          finish(entry, 'expired', '二维码已失效，请重新扫码')
          return
        } else {
          failures += 1
          deps.log(`[weixin-qr] session=${entry.session.id} 状态轮询失败 ${failures}/${QR_MAX_CONSECUTIVE_FAILURES}`, errorText(error))
          if (failures >= QR_MAX_CONSECUTIVE_FAILURES) {
            finish(entry, 'error', `微信登录查询失败：${errorText(error)}`)
            return
          }
        }
      }
      await cancellableSleep(entry.intervalMs, signal)
    }
  }

  return {
    async start(botId: string) {
      prune()
      // 同一个 bot 只留最后一次扫码：用户点「重新扫码」时旧会话的长轮询必须先撤，
      // 否则两串 qrcode 同时在转，后到的 confirmed 会覆盖先到的凭据。
      for (const [id, old] of entries) {
        if (old.session.botId === botId) {
          old.controller.abort()
          old.session.finished = true
          entries.delete(id)
        }
      }
      // 已有凭据时允许直接覆盖（重扫就是换号的正规路径），只在日志里留痕，
      // 「是否需要先重置」属于界面策略，交给 index.ts / BotsDialog 决定。
      try {
        const existing = await deps.readCredential()
        if (existing) deps.log(`[weixin-qr] bot=${botId} 已有凭据，本次扫码将覆盖`)
      } catch (error) {
        deps.log(`[weixin-qr] bot=${botId} 读取旧凭据失败（不影响扫码）`, errorText(error))
      }

      const controller = new AbortController()
      let begin: ReturnType<typeof parseWeixinQrBegin>
      let qrPayload: Record<string, unknown>
      try {
        qrPayload = await weixinLoginGet('/get_bot_qrcode?bot_type=3', controller.signal, WEIXIN_LOGIN_REQUEST_TIMEOUT_MS)
        begin = parseWeixinQrBegin(qrPayload)
      } catch (error) {
        controller.abort()
        return { ok: false as const, error: `获取微信二维码失败：${errorText(error)}` }
      }
      if (!begin) {
        controller.abort()
        return { ok: false as const, error: '微信未返回二维码，请稍后重试' }
      }
      const session: WeixinQrSession = {
        id: `wq-${randomUUID()}`,
        botId,
        state: 'waiting',
        qrUrl: begin.qrUrl,
        finished: false,
        createdAt: Date.now(),
      }
      const entry: Entry = {
        session,
        qrCode: begin.qrCode,
        intervalMs: Math.max(1, begin.intervalSeconds) * 1000,
        expiresAt: begin.expiresAt,
        controller,
      }
      entries.set(session.id, entry)
      emit(entry)
      // 后台转，不等结果：start 只负责"出码"，四态靠事件与 peek
      void run(entry).catch((error: unknown) => {
        deps.log(`[weixin-qr] session=${session.id} 轮询循环异常`, errorText(error))
        finish(entry, 'error', `微信登录异常：${errorText(error)}`)
      })
      return { ok: true as const, session: { ...session } }
    },

    peek(sessionId: string) {
      const entry = entries.get(sessionId)
      return entry ? { ...entry.session } : null
    },

    stop(sessionId: string) {
      const entry = entries.get(sessionId)
      if (!entry) return
      entry.session.finished = true
      entry.controller.abort()
      entries.delete(sessionId)
    },

    dispose() {
      for (const entry of entries.values()) {
        entry.session.finished = true
        entry.controller.abort()
      }
      entries.clear()
    },
  }
}
