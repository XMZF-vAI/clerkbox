/**
 * 企业微信通道（智能机器人 · WebSocket 长连接）。
 *
 * 用官方 `@wecom/aibot-node-sdk`：connect() 自动完成认证帧与心跳，断线由 SDK 内置
 * 指数退避重连（maxReconnectAttempts=-1 表示无限重试，失败的兜底交给本通道的
 * 看门狗与宿主监督循环）。凭据 = 管理后台「智能机器人 → API 模式 → 长连接」的
 * BotID + Secret，手填进界面即可，不需要公网回调地址。
 *
 * 两条官方硬限制（长连接模式）：
 * - 每个机器人同一时间只允许 1 条有效长连接（新连接踢旧连接）——CB 单主进程 +
 *   既有进程锁天然满足；
 * - 回复限频 30 条/分钟、1000 条/小时——出站走 ≥2s 间隔的漏桶（长回复分段时
 *   尤其重要），超限的错误如实上报状态。
 *
 * 实现约定（与 feishu.ts / telegram.ts 相同）：start() 恒 resolve、凭据指纹变化
 * 退出交给宿主重建、deps.isStopped() 为真立即退出。
 */
import type { BotChannelHandle, BotConfig, ChannelDeps, OutboundTarget } from './types'
import { credentialFingerprint } from './types'

/** 出站漏桶间隔：30 条/分钟 = 2s/条，留 100ms 余量 */
const SEND_INTERVAL_MS = 2_100
/** 失败退避 */
const BACKOFF_MS = 5_000
/** 连接建立看门狗：SDK 认证失败会反复重试，超过这个时长整轮退出重建 */
const CONNECT_WATCHDOG_MS = 30_000

/** SDK 的类型在这里只有运行时形状可用（CJS 互导），按官方 d.ts 手写最小截面 */
interface WecomSdk {
  WSClient: new (options: {
    botId: string
    secret: string
    logger?: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void; debug: (...args: unknown[]) => void }
    maxReconnectAttempts?: number
  }) => WecomClient
}

interface WecomClient {
  connect(): unknown
  disconnect(): void
  on(event: 'message.text', handler: (frame: { headers: { req_id: string }; body: WecomTextBody }) => void): unknown
  on(event: 'error', handler: (error: Error) => void): unknown
  sendMessage(chatid: string, body: { msgtype: 'markdown'; markdown: { content: string } }): Promise<unknown>
}

interface WecomTextBody {
  msgid: string
  chattype: 'single' | 'group'
  from: { userid: string }
  text?: { content?: string }
}

let sdkModulePromise: Promise<WecomSdk> | null = null

/** 动态加载官方 SDK：与飞书通道同一模式（懒加载 + 失败信息可读） */
async function loadWecomSdk(): Promise<WecomSdk> {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@wecom/aibot-node-sdk').then((mod) => {
      const sdk = (mod as unknown as { WSClient?: WecomSdk['WSClient'] }).WSClient
      if (typeof sdk !== 'function') throw new Error('SDK 缺少 WSClient 导出')
      return { WSClient: sdk }
    })
  }
  return sdkModulePromise
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

function parseSecret(raw: string): { botId: string; secret: string } | null {
  try {
    const parsed = JSON.parse(raw) as { botId?: unknown; secret?: unknown }
    if (typeof parsed.botId !== 'string' || !parsed.botId.trim()) return null
    if (typeof parsed.secret !== 'string' || !parsed.secret.trim()) return null
    return { botId: parsed.botId.trim(), secret: parsed.secret.trim() }
  } catch {
    return null
  }
}

class WecomChannelHandle implements BotChannelHandle {
  readonly provider = 'wecom'

  private bot: BotConfig | null = null
  private deps: ChannelDeps | null = null
  private controller: AbortController | null = null
  private running: Promise<void> | null = null
  private stopping = false
  private client: WecomClient | null = null
  /** 出站漏桶：上一条发送时刻（30 条/分钟的官方限制） */
  private lastSendAt = 0

  start(bot: BotConfig, deps: ChannelDeps): Promise<void> {
    this.bot = bot
    this.deps = deps
    this.controller = new AbortController()
    this.running = this.loop(deps, this.controller.signal)
    return this.running
  }

  async send(target: OutboundTarget, text: string): Promise<void> {
    const client = this.client
    const deps = this.deps
    if (!client || !deps) throw new Error('企业微信通道尚未连接，无法发送')
    const userid = target.providerUserId?.trim()
    if (!userid) throw new Error('企业微信发送缺少接收者 userid')
    // 30 条/分钟 → 单通道内 ≥2s 一条；分段回复在此天然拉开
    const wait = this.lastSendAt + SEND_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastSendAt = Date.now()
    await client.sendMessage(userid, { msgtype: 'markdown', markdown: { content: text } })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.controller?.abort()
    this.client?.disconnect()
    this.client = null
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
        deps.log('读取企业微信凭据失败', error instanceof Error ? error.message : error)
      }
      const secret = parseSecret(raw ?? '')
      if (!raw || !secret) {
        deps.setStatus('error', raw ? '企业微信凭据格式不正确，需要 {"botId","secret"} 的 JSON' : '未配置企业微信机器人凭据')
        if (!(await sleepCancellable(BACKOFF_MS, signal))) return
        continue
      }
      const fingerprint = credentialFingerprint('wecom', raw)
      if (baselineFingerprint === null) baselineFingerprint = fingerprint
      else if (baselineFingerprint !== fingerprint) return // 凭据变更：交给宿主重建

      const outcome = await this.session(deps, secret, signal)
      if (outcome === 'stopped' || this.stopping || deps.isStopped() || signal.aborted) return
      if (!(await sleepCancellable(BACKOFF_MS, signal))) return
    }
  }

  /**
   * 一轮连接：建 SDK client → 接线事件 → 盯到停止/异常。
   * SDK 内部自带重连，这里只做三件事：入站过滤（仅单聊文本）、错误上报、
   * 连接建立看门狗（认证反复失败时退出整轮，交给宿主退避后重来）。
   */
  private async session(deps: ChannelDeps, secret: { botId: string; secret: string }, signal: AbortSignal): Promise<'stopped' | 'failed'> {
    let sdk: WecomSdk
    try {
      sdk = await loadWecomSdk()
    } catch (error) {
      deps.setStatus('error', `加载企业微信 SDK 失败：${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
    if (this.stopping || deps.isStopped() || signal.aborted) return 'stopped'
    deps.setStatus('connected', '企业微信长连接已发起')

    let lastErrorAt = 0
    let receivedAny = false
    const client = new sdk.WSClient({
      botId: secret.botId,
      secret: secret.secret,
      maxReconnectAttempts: -1,
      logger: {
        error: (...args: unknown[]) => deps.log('[wecom-sdk:error]', ...args),
        warn: (...args: unknown[]) => deps.log('[wecom-sdk:warn]', ...args),
        info: () => undefined,
        debug: () => undefined,
      },
    })
    this.client = client
    client.on('message.text', (frame) => {
      try {
        receivedAny = true
        const body = frame.body
        if (!body || body.chattype !== 'single') return // 群聊本期不收
        const text = (body.text?.content ?? '').trim()
        if (!text) return
        void deps
          .onInbound({
            actor: {
              botId: this.bot?.id ?? '',
              provider: 'wecom',
              providerUserId: body.from.userid,
              chatType: 'private',
            },
            text,
            messageId: body.msgid,
          })
          .catch((error: unknown) => {
            deps.log('处理企业微信入站消息失败:', error instanceof Error ? error.message : error)
          })
      } catch (error) {
        deps.log('企业微信入站帧解析失败:', error instanceof Error ? error.message : error)
      }
    })
    client.on('error', (error) => {
      // SDK 会自己重连；这里把错误摆到界面上并记录时刻，判死交给看门狗
      lastErrorAt = Date.now()
      deps.setStatus('error', `企业微信连接异常：${error instanceof Error ? error.message : String(error)}`)
    })

    client.connect()

    // 连接建立看门狗：SDK 对错误凭据是「无限重试 + 反复 error 事件」，
    // 不设上限的话界面上永远停在重连里。启动超过阈值仍未收到任何消息、
    // 且期间报过错 → 判定凭据/环境有问题，退出整轮交给宿主退避后重来。
    const startedAt = Date.now()
    while (!this.stopping && !deps.isStopped() && !signal.aborted) {
      if (!receivedAny && lastErrorAt > startedAt && Date.now() - startedAt > CONNECT_WATCHDOG_MS) {
        deps.setStatus('error', '企业微信长连接建立失败，请检查 BotID/Secret 与「长连接」模式')
        return 'failed'
      }
      if (!(await sleepCancellable(1_000, signal))) return 'stopped'
    }
    return 'stopped'
  }
}

export const wecomChannel = {
  provider: 'wecom' as const,
  create(): BotChannelHandle {
    return new WecomChannelHandle()
  },
}
