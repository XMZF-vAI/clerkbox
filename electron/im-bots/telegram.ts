/**
 * Telegram 通道（Bot API getUpdates 长轮询）。
 *
 * 传输是纯出站 HTTPS：应用挂起式轮询 api.telegram.org 拉取更新，回复走 sendMessage——
 * 与微信/飞书一样不需要任何公网入口。offset 游标复用 ChannelDeps 的通用游标槽位
 * （bots-state 里的 weixinGetUpdatesBuf 字段），重启不会重收历史消息。
 *
 * 网络环境：api.telegram.org 在中国大陆被阻断。本通道用 deps.fetchImpl（主进程注入
 * Electron net.fetch，走 Chromium 网络栈：用户开了系统代理就自动生效，TUN 模式天然
 * 兼容），刻意不做应用内代理配置——用 Telegram 的用户自己懂自己的网络环境。
 *
 * 实现约定（与 feishu.ts 相同的三条）：
 * 1. start() 恒 resolve：可预期故障全部先经 setStatus 上报，宿主不给 start 挂 catch；
 * 2. 凭据指纹变化 → 退出交给宿主重建，不热切换；
 * 3. deps.isStopped() 为真立即退出且不再发请求。
 */
import type { BotChannelHandle, BotConfig, ChannelDeps, OutboundTarget } from './types'
import { credentialFingerprint } from './types'

const TG_API_BASE = 'https://api.telegram.org/bot'
/** getUpdates 的服务端挂起时长：50s 是官方文档推荐的长轮询上限区间 */
const LONG_POLL_TIMEOUT_S = 50
/** 单次 HTTP 请求的硬超时：必须明显大于长轮询挂起时长 */
const REQUEST_TIMEOUT_MS = 70_000
/** 失败退避 */
const BACKOFF_MS = 5_000
/** Telegram 单聊限频 1 msg/s：分段回复之间至少隔这么多 */
const SEND_INTERVAL_MS = 1_100

interface TgUpdate {
  update_id: number
  message?: TgMessage
}

interface TgMessage {
  message_id: number
  from?: { id: number; first_name?: string; last_name?: string; username?: string }
  chat: { id: number; type: string }
  text?: string
}

interface TgApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

export function buildTgApiUrl(token: string, method: string): string {
  return `${TG_API_BASE}${encodeURIComponent(token)}/${method}`
}

/** 从一批 update 里抽出「私聊文本消息」并算出下一个 offset；非私聊/非文本一律跳过 */
export function extractInbounds(
  botId: string,
  updates: TgUpdate[]
): { inbounds: Array<{ updateId: number; providerUserId: string; displayName?: string; messageId: string; text: string }>; nextOffset: number } {
  let nextOffset = 0
  const inbounds: Array<{ updateId: number; providerUserId: string; displayName?: string; messageId: string; text: string }> = []
  for (const update of updates) {
    // offset 语义 = 收到的最大 update_id + 1；不认识的消息类型也要推进游标，否则会卡死在同一批
    nextOffset = Math.max(nextOffset, update.update_id + 1)
    const message = update.message
    if (!message || message.chat.type !== 'private') continue
    const text = (message.text ?? '').trim()
    if (!text) continue
    const sender = message.from
    if (!sender) continue
    inbounds.push({
      updateId: update.update_id,
      providerUserId: String(sender.id),
      displayName: [sender.first_name, sender.last_name].filter(Boolean).join(' ') || undefined,
      messageId: String(message.message_id),
      text,
    })
  }
  return { inbounds, nextOffset }
}

async function tgFetch<T>(fetchImpl: typeof fetch, token: string, method: string, init?: RequestInit): Promise<TgApiResponse<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Telegram 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`)), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(buildTgApiUrl(token, method), {
      ...init,
      signal: controller.signal,
    })
    const body = (await response.json().catch(() => null)) as TgApiResponse<T> | null
    if (!body || typeof body.ok !== 'boolean') {
      throw new Error(`Telegram 响应无法解析（HTTP ${response.status}）`)
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

function describeTgError(body: TgApiResponse<unknown>): { message: string; retryAfterMs?: number } {
  const description = body.description?.trim() || '未知错误'
  if (body.error_code === 401) return { message: 'Telegram Bot Token 无效，请重新粘贴' }
  if (body.error_code === 409) return { message: 'Token 已被其他轮询客户端占用（重复启动或残留 webhook）' }
  if (body.error_code === 429 && body.parameters?.retry_after) {
    return { message: `触发 Telegram 限频：${description}`, retryAfterMs: body.parameters.retry_after * 1000 }
  }
  return { message: description }
}

class TelegramChannelHandle implements BotChannelHandle {
  readonly provider = 'telegram'

  private bot: BotConfig | null = null
  private deps: ChannelDeps | null = null
  private controller: AbortController | null = null
  private running: Promise<void> | null = null
  private stopping = false
  /** 上一次 outbound 发送时刻：单聊 1 msg/s 的漏桶 */
  private lastSendAt = 0

  start(bot: BotConfig, deps: ChannelDeps): Promise<void> {
    this.bot = bot
    this.deps = deps
    this.controller = new AbortController()
    this.running = this.loop(deps, this.controller.signal)
    return this.running
  }

  async send(target: OutboundTarget, text: string): Promise<void> {
    const deps = this.deps
    if (!deps) throw new Error('Telegram 通道尚未启动，无法发送')
    const chatId = target.providerUserId?.trim()
    if (!chatId) throw new Error('Telegram 发送缺少接收者 chat id')
    const secret = parseSecret((await deps.readCredential()) ?? '')
    if (!secret) throw new Error('Telegram 凭据未配置或格式不正确，无法发送')
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch
    // 1 msg/s 的漏桶：分段回复天然被拉开，长回复也不会触发 429
    const wait = this.lastSendAt + SEND_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastSendAt = Date.now()
    const body = await tgFetch<unknown>(fetchImpl, secret.botToken, 'sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    if (!body.ok) {
      throw new Error(`Telegram 发送失败：${describeTgError(body).message}`)
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.controller?.abort()
    const running = this.running
    this.running = null
    await running?.catch(() => undefined)
  }

  private async loop(deps: ChannelDeps, signal: AbortSignal): Promise<void> {
    let baselineFingerprint: string | null = null
    while (!this.stopping && !deps.isStopped() && !signal.aborted) {
      let raw: string | null = null
      try {
        raw = await deps.readCredential()
      } catch (error) {
        deps.log('读取 Telegram 凭据失败', error instanceof Error ? error.message : error)
      }
      const secret = parseSecret(raw ?? '')
      if (!raw || !secret) {
        deps.setStatus('error', raw ? 'Telegram 凭据格式不正确，需要 {"botToken"} 的 JSON' : '未配置 Telegram Bot Token')
        if (!(await sleepCancellable(BACKOFF_MS, signal))) return
        continue
      }
      const fingerprint = credentialFingerprint('telegram', raw)
      if (baselineFingerprint === null) baselineFingerprint = fingerprint
      else if (baselineFingerprint !== fingerprint) return // 凭据变更：交给宿主重建

      deps.setStatus('polling')
      const outcome = await this.pollSession(deps, secret.botToken, signal)
      if (outcome === 'stopped' || this.stopping || deps.isStopped() || signal.aborted) return
      if (!(await sleepCancellable(BACKOFF_MS, signal))) return
    }
  }

  /**
   * 一轮长轮询会话：循环 getUpdates 直到停止/指纹变化/不可恢复错误。
   * 每批处理完才推进游标（at-least-once，index.ts 按 message_id 去重兜底）。
   */
  private async pollSession(deps: ChannelDeps, botToken: string, signal: AbortSignal): Promise<'stopped' | 'failed' | 'retry'> {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch
    // 游标 = 下一次要请求的 offset；没有持久化游标时先做一次「排空」预取
    // （offset=-1 只回最后一条，不处理），避免换 token / 重绑后把 24h 内的历史积压
    // 当成新消息重放——用户重新扫码绑定的场景里，那些旧消息全是噪声。
    const stored = await deps.readCursor()
    let offset = stored && stored.trim() ? Number.parseInt(stored, 10) : 0
    if (!Number.isFinite(offset) || offset < 0) offset = 0
    if (offset === 0) {
      try {
        const skipped = await tgFetch<TgUpdate[]>(fetchImpl, botToken, 'getUpdates?offset=-1&timeout=0')
        const last = skipped.ok ? (skipped.result ?? []).at(-1) : undefined
        if (last) {
          offset = last.update_id + 1
          await deps.writeCursor(String(offset))
        }
      } catch (error) {
        deps.log('Telegram 历史排空失败（忽略，从 0 开始）:', error instanceof Error ? error.message : error)
      }
    }

    while (!this.stopping && !deps.isStopped() && !signal.aborted) {
      let body: TgApiResponse<TgUpdate[]>
      try {
        body = await tgFetch<TgUpdate[]>(fetchImpl, botToken, `getUpdates?offset=${offset}&timeout=${LONG_POLL_TIMEOUT_S}&allowed_updates=${encodeURIComponent('["message"]')}`)
      } catch (error) {
        if (this.stopping || deps.isStopped() || signal.aborted) return 'stopped'
        deps.setStatus('error', `Telegram 网络请求失败：${error instanceof Error ? error.message : String(error)}（请检查网络环境）`)
        return 'retry'
      }
      if (!body.ok) {
        const described = describeTgError(body)
        deps.setStatus('error', described.message)
        if (described.retryAfterMs && !(await sleepCancellable(described.retryAfterMs, signal))) return 'stopped'
        return 'retry'
      }

      const updates = Array.isArray(body.result) ? body.result : []
      const { inbounds, nextOffset } = extractInbounds(this.bot?.id ?? '', updates)
      for (const item of inbounds) {
        if (this.stopping || deps.isStopped() || signal.aborted) return 'stopped'
        try {
          await deps.onInbound({
            actor: {
              botId: this.bot?.id ?? '',
              provider: 'telegram',
              providerUserId: item.providerUserId,
              chatType: 'private',
              ...(item.displayName ? { displayName: item.displayName } : {}),
            },
            text: item.text,
            messageId: item.messageId,
          })
        } catch (error) {
          // 单条入站失败不能打断整批：游标已推进，重投也拿不回这条，记日志即可
          deps.log('处理 Telegram 入站消息失败:', error instanceof Error ? error.message : error)
        }
      }
      if (nextOffset > 0) {
        await deps.writeCursor(String(nextOffset))
      }
      offset = nextOffset > 0 ? nextOffset : offset
      // 空批退避：正常长轮询由服务端挂 50s，但「对端秒回空数组」的异常服务/测试桩
      // 会把 while 变成纯微任务热循环（既不 yield 也不 GC）。空批一律歇 1s。
      if (inbounds.length === 0 && !(await sleepCancellable(1_000, signal))) return 'stopped'
    }
    return 'stopped'
  }
}

function parseSecret(raw: string): { botToken: string } | null {
  try {
    const parsed = JSON.parse(raw) as { botToken?: unknown }
    return typeof parsed.botToken === 'string' && parsed.botToken.trim() ? { botToken: parsed.botToken.trim() } : null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 可取消的 sleep：返回 false 表示期间被停止，调用方应立即退出循环 */
async function sleepCancellable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export const telegramChannel = {
  provider: 'telegram' as const,
  create(): BotChannelHandle {
    return new TelegramChannelHandle()
  },
}
