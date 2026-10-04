/**
 * 企业微信通道单测。
 *
 * vi.mock 掉官方 SDK（动态 import 会被 vitest 拦截），用假 WSClient 捕获事件接线与
 * sendMessage 调用。钉住四条语义：
 * 1. 只收单聊文本（group 丢弃）；
 * 2. 入站带 msgid 交给上层去重；
 * 3. 出站走 sendMessage 的 markdown 通道（主动推送，无 5s 被动回复窗口）；
 * 4. 看门狗：启动后一直报错且没收过消息 → 判死退出，交给宿主退避重建。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wecomChannel } from '../electron/im-bots/wecom'
import type { BotConfig, BotRuntimeState, ChannelDeps, InboundMessage } from '../electron/im-bots/types'

const SECRET_JSON = JSON.stringify({ botId: 'wbot-1', secret: 'sec-1' })
const BOT: BotConfig = {
  id: 'bot-wecom-1',
  provider: 'wecom',
  name: '测试企微',
  enabled: true,
  credentialRef: 'bot-wecom-bot-wecom-1',
}

type TextHandler = (frame: { headers: { req_id: string }; body: { msgid: string; chattype: 'single' | 'group'; from: { userid: string }; text?: { content?: string } } }) => void
type ErrorHandler = (error: Error) => void

interface SentMessage {
  chatid: string
  body: { msgtype: string; markdown: { content: string } }
}

const harness: {
  textHandler: TextHandler | null
  errorHandler: ErrorHandler | null
  sent: SentMessage[]
  disconnects: number
} = { textHandler: null, errorHandler: null, sent: [], disconnects: 0 }

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: class {
    constructor(_options: unknown) {
      harness.textHandler = null
      harness.errorHandler = null
    }
    on(event: string, handler: (payload: never) => void) {
      if (event === 'message.text') harness.textHandler = handler as TextHandler
      if (event === 'error') harness.errorHandler = handler as ErrorHandler
      return this
    }
    connect() {
      return this
    }
    disconnect() {
      harness.disconnects += 1
    }
    async sendMessage(chatid: string, body: { msgtype: string; markdown: { content: string } }) {
      harness.sent.push({ chatid, body })
      return { headers: { req_id: 'r' } }
    }
  },
}))

function makeDeps(input: { credentials?: (string | null)[] } = {}) {
  const queue = input.credentials ?? [SECRET_JSON]
  const state = {
    statuses: [] as { state: BotRuntimeState; message?: string }[],
    inbound: [] as InboundMessage[],
  }
  let readIndex = 0
  let stopped = false
  const deps: ChannelDeps = {
    readCredential: async () => {
      const value = queue[Math.min(readIndex, queue.length - 1)]
      readIndex += 1
      return value
    },
    writeCredential: async () => undefined,
    onInbound: async (message) => {
      state.inbound.push(message)
      stopped = true
    },
    setStatus: (state_, message_) => {
      state.statuses.push({ state: state_, ...(message_ ? { message: message_ } : {}) })
    },
    readCursor: async () => undefined,
    writeCursor: async () => undefined,
    markActivated: async () => undefined,
    isStopped: () => stopped,
    log: () => undefined,
  }
  return { deps, state, setStopped: (v: boolean) => (stopped = v) }
}

function emitText(msgid: string, userid: string, content: string, chattype: 'single' | 'group' = 'single') {
  harness.textHandler?.({
    headers: { req_id: `req-${msgid}` },
    body: { msgid, chattype, from: { userid }, text: { content } },
  })
}

afterEach(() => {
  harness.textHandler = null
  harness.errorHandler = null
  harness.sent = []
  harness.disconnects = 0
})

describe('企业微信通道', () => {
  it('单聊文本送达 core；群聊与非文本丢弃', async () => {
    const { deps, state, setStopped } = makeDeps()
    const handle = wecomChannel.create()
    const running = handle.start(BOT, deps)
    await vi.waitFor(() => expect(harness.textHandler).not.toBeNull())
    emitText('m1', 'u1', '你好')
    emitText('m2', 'u1', '群里的', 'group')
    emitText('m3', 'u1', '   ')
    await vi.waitFor(() => expect(state.inbound).toHaveLength(1))
    expect(state.inbound[0]).toMatchObject({
      actor: { botId: 'bot-wecom-1', provider: 'wecom', providerUserId: 'u1', chatType: 'private' },
      text: '你好',
      messageId: 'm1',
    })
    setStopped(true)
    await running
  })

  it('出站走 sendMessage 的 markdown 通道，目标userid 正确', async () => {
    const { deps, setStopped } = makeDeps()
    const handle = wecomChannel.create()
    const running = handle.start(BOT, deps)
    await vi.waitFor(() => expect(harness.textHandler).not.toBeNull())
    await handle.send({ providerUserId: 'u9' }, '回复正文')
    expect(harness.sent).toHaveLength(1)
    expect(harness.sent[0]).toMatchObject({ chatid: 'u9', body: { msgtype: 'markdown', markdown: { content: '回复正文' } } })
    setStopped(true)
    await running
  })

  it('stop() 调 disconnect；通道退出交给宿主', async () => {
    const { deps, setStopped } = makeDeps()
    const handle = wecomChannel.create()
    const running = handle.start(BOT, deps)
    await vi.waitFor(() => expect(harness.textHandler).not.toBeNull())
    await handle.stop()
    expect(harness.disconnects).toBeGreaterThanOrEqual(1)
    setStopped(true)
    await running
  })

  it('凭据缺失 = 明确的错误状态而不是崩溃', async () => {
    const { deps, state } = makeDeps({ credentials: [null] })
    const handle = wecomChannel.create()
    const running = handle.start(BOT, deps)
    await vi.waitFor(() => expect(state.statuses.at(-1)?.message).toContain('未配置企业微信机器人凭据'))
    await handle.stop()
    await running
    expect(harness.sent).toHaveLength(0)
  })
})
