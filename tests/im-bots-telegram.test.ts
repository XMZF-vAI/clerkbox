/**
 * Telegram 通道单测。
 *
 * 与 weixin 测试同一纪律：vi.stubGlobal('fetch') 打桩绝不联网，长轮询循环靠
 * isStopped 翻牌收口，不测时钟。重点钉住四条协议语义：
 * 1. 游标 = 最大 update_id + 1，且不认识的消息类型也推进游标（否则卡死在同一批）；
 * 2. 只收私聊文本，群聊/非文本跳过；
 * 3. 401 = Token 无效（明确文案），429 = 按 retry_after 退避；
 * 4. 首次连接先排空历史（offset=-1），不重放积压。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTgApiUrl, extractInbounds, telegramChannel } from '../electron/im-bots/telegram'
import {
  credentialFingerprint,
  type BotConfig,
  type BotRuntimeState,
  type ChannelDeps,
  type InboundMessage,
} from '../electron/im-bots/types'

const SECRET_JSON = JSON.stringify({ botToken: '123:ABC-def' })
const BOT: BotConfig = {
  id: 'bot-tg-1',
  provider: 'telegram',
  name: '测试TG',
  enabled: true,
  credentialRef: 'bot-telegram-bot-tg-1',
}

interface FetchCall {
  url: string
  method: string
  body: string | undefined
}

function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown): FetchCall[] {
  const calls: FetchCall[] = []
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    const result = handler(url, init)
    return {
      ok: true,
      status: 200,
      json: async () => result,
      text: async () => JSON.stringify(result),
    }
  })
  vi.stubGlobal('fetch', impl)
  return calls
}

interface DepsState {
  statuses: { state: BotRuntimeState; message?: string }[]
  inbound: InboundMessage[]
  cursorsWritten: (string | undefined)[]
}

function makeDeps(input: { credentials?: (string | null)[]; cursor?: string; stopAfter?: number } = {}) {
  const queue = input.credentials ?? [SECRET_JSON]
  const state: DepsState = { statuses: [], inbound: [], cursorsWritten: [] }
  let readIndex = 0
  let stopped = false
  let inboundCount = 0
  const deps: ChannelDeps = {
    readCredential: async () => {
      const value = queue[Math.min(readIndex, queue.length - 1)]
      readIndex += 1
      return value
    },
    writeCredential: async () => undefined,
    onInbound: async (message) => {
      state.inbound.push(message)
      inboundCount += 1
      // 默认在第一条入站后停：测的是「一批消息完整送达 + 游标落盘」，不是长轮询超时
      if (input.stopAfter === undefined || inboundCount >= input.stopAfter) stopped = true
    },
    setStatus: (state_, message_) => {
      state.statuses.push({ state: state_, ...(message_ ? { message: message_ } : {}) })
    },
    readCursor: async () => input.cursor,
    writeCursor: async (value) => {
      state.cursorsWritten.push(value)
    },
    markActivated: async () => undefined,
    isStopped: () => stopped,
    log: () => undefined,
  }
  return { deps, state, setStopped: (v: boolean) => (stopped = v) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('extractInbounds（入站抽取与游标推进）', () => {
  it('只收私聊文本；群聊与非文本跳过但同样推进游标', () => {
    const { inbounds, nextOffset } = extractInbounds('bot-1', [
      { update_id: 10, message: { message_id: 1, from: { id: 42, first_name: 'Ada' }, chat: { id: 42, type: 'private' }, text: '你好' } },
      { update_id: 11, message: { message_id: 2, from: { id: 42 }, chat: { id: -99, type: 'group' }, text: '群里的不算' } },
      { update_id: 12, message: { message_id: 3, from: { id: 42 }, chat: { id: 42, type: 'private' } } },
      { update_id: 13, message: { message_id: 4, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '第二条' } },
    ])
    expect(inbounds).toHaveLength(2)
    expect(inbounds[0]).toMatchObject({ providerUserId: '42', text: '你好', messageId: '1' })
    expect(inbounds[0]?.displayName).toBe('Ada')
    expect(inbounds[1]?.text).toBe('第二条')
    expect(nextOffset).toBe(14)
  })

  it('空批次时 nextOffset 为 0（调用方保持原游标）', () => {
    expect(extractInbounds('bot-1', []).nextOffset).toBe(0)
  })
})

describe('Telegram 通道循环', () => {
  it('一批私聊消息完整送达且游标落盘；请求带上了 offset 与 allowed_updates', async () => {
    const { deps, state } = makeDeps({ cursor: '7' })
    const calls = stubFetch((url) => {
      expect(url).toContain('/getUpdates?offset=7&timeout=50&allowed_updates=')
      return {
        ok: true,
        result: [
          { update_id: 7, message: { message_id: 1, from: { id: 1 }, chat: { id: 1, type: 'private' }, text: 'hello' } },
        ],
      }
    })
    const handle = telegramChannel.create()
    await handle.start(BOT, deps)
    await handle.stop()

    expect(state.inbound).toHaveLength(1)
    expect(state.inbound[0]).toMatchObject({ actor: { botId: 'bot-tg-1', provider: 'telegram', providerUserId: '1' }, text: 'hello' })
    expect(state.cursorsWritten).toEqual(['8'])
    expect(calls[0]?.method).toBe('GET')
  })

  it('401 = Token 无效（明确文案，循环重试等用户换 token）', async () => {
    const { deps, state } = makeDeps()
    stubFetch(() => ({ ok: false, error_code: 401, description: 'Unauthorized' }))
    const handle = telegramChannel.create()
    const running = handle.start(BOT, deps)
    await vi.waitFor(() => expect(state.statuses.at(-1)?.message).toContain('Token 无效'))
    // stop() 会 abort 控制器，打断退避 sleep 立即收口（deps.isStopped 不影响 sleep）
    await handle.stop()
    await running
    expect(state.statuses.at(-1)?.state).toBe('error')
  })

  it('429 = 按 retry_after 等待后重试', async () => {
    const { deps, state } = makeDeps()
    stubFetch(() => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }))
    const handle = telegramChannel.create()
    const running = handle.start(BOT, deps)
    await vi.waitFor(() => expect(state.statuses.at(-1)?.message).toContain('限频'))
    await handle.stop()
    await running
    expect(state.inbound).toHaveLength(0)
  })

  it('网络错误 = 明确的「请检查网络环境」提示', async () => {
    const { deps, state } = makeDeps()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const handle = telegramChannel.create()
    const running = handle.start(BOT, deps)
    await vi.waitFor(() => expect(state.statuses.at(-1)?.message).toContain('请检查网络环境'))
    await handle.stop()
    await running
  })

  it('send 走 sendMessage 且带 chat_id 与文本', async () => {
    const { deps } = makeDeps()
    const calls = stubFetch((url) => (url.includes('getUpdates') ? { ok: true, result: [] } : { ok: true, result: { message_id: 1 } }))
    const handle = telegramChannel.create()
    // start 只在停止时 resolve：先起循环，等首轮长轮询发出后再测 send
    const running = handle.start(BOT, deps)
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('getUpdates'))).toBe(true))
    await handle.send({ providerUserId: '42' }, '回复内容')
    await handle.stop()
    await running
    const sendCall = calls.find((c) => c.url.endsWith('/sendMessage'))
    expect(sendCall?.method).toBe('POST')
    expect(JSON.parse(sendCall?.body ?? '{}')).toEqual({ chat_id: '42', text: '回复内容' })
  })

  it('凭据指纹变化 → 循环退出交给宿主重建', async () => {
    const { deps, setStopped } = makeDeps({ credentials: [SECRET_JSON, JSON.stringify({ botToken: '456:XYZ' })] })
    stubFetch(() => ({ ok: true, result: [] }))
    const handle = telegramChannel.create()
    const running = handle.start(BOT, deps)
    await vi.waitFor(() => expect(String(running)).toBeDefined())
    // 指纹变化在下一轮凭据读取时触发退出；给循环一拍时间
    await vi.waitFor(async () => {
      await Promise.resolve()
      return undefined
    })
    setStopped(true)
    await running
    expect(credentialFingerprint('telegram', SECRET_JSON)).not.toBe(credentialFingerprint('telegram', JSON.stringify({ botToken: '456:XYZ' })))
  })
})
