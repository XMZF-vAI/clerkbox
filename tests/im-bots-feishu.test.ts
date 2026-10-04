/**
 * 飞书通道单测：只打协议，不联网。
 *
 * 三层覆盖：
 * 1. 纯函数 —— im.message.receive_v1 归一化（p2p 放行 / 群聊丢弃 / text 与 post 两种 content）、message_id 去重；
 * 2. token 缓存 —— 注入假 fetch + 假时钟，验证「剩余不足 30min 才刷新」和「并发只打一次 token 接口」；
 * 3. 通道循环 —— vi.mock 掉 @larksuiteoapi/node-sdk，验证状态机、凭据指纹变化时按约定退出、
 *    stop() 确实把长连接 force close（否则退出时进程挂住）。
 * 生命周期用例通过 feishuTimers 把 1s/30s/5s 的墙钟调小，否则每个用例都要真等几十秒。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MessageIdDedupe,
  createTenantTokenStore,
  feishuChannel,
  feishuTimers,
  isTokenFresh,
  normalizeFeishuReceiveEvent,
  readFeishuPostText,
  readFeishuWsState,
  resolveReceiveIdType,
  splitFeishuText
} from '../electron/im-bots/feishu'
import type { BotRuntimeState, ChannelDeps, InboundMessage } from '../electron/im-bots/types'

// 假 SDK：记录实例、可控连接状态，绝不开真 socket
const sdkDouble = vi.hoisted(() => {
  class FakeEventDispatcher {
    handles: Record<string, (payload: unknown) => unknown> = {}
    register(handles: Record<string, (payload: unknown) => unknown>) {
      Object.assign(this.handles, handles)
      return this
    }
    async emit(key: string, payload: unknown): Promise<unknown> {
      return this.handles[key]?.(payload)
    }
  }
  class FakeWsClient {
    static instances: FakeWsClient[] = []
    dispatcher: FakeEventDispatcher | null = null
    state = 'idle'
    closeCalls: Array<{ force?: boolean }> = []
    startCalls = 0
    constructor(readonly params: Record<string, unknown>) {
      FakeWsClient.instances.push(this)
    }
    async start(input: { eventDispatcher: FakeEventDispatcher }): Promise<void> {
      this.startCalls += 1
      this.dispatcher = input.eventDispatcher
      this.state = 'connected'
    }
    getConnectionStatus(): { state: string } {
      return { state: this.state }
    }
    close(options?: { force?: boolean }): void {
      this.closeCalls.push(options ?? {})
      this.state = 'idle'
    }
  }
  return { FakeEventDispatcher, FakeWsClient }
})

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: sdkDouble.FakeWsClient,
  EventDispatcher: sdkDouble.FakeEventDispatcher,
  Domain: { Feishu: 0, Lark: 1 }
}))

type FakeClient = InstanceType<typeof sdkDouble.FakeWsClient>

const APP_ID = 'cli_0123456789abcdef'
const OTHER_APP_ID = 'cli_fedcba9876543210'
const BASE = 'https://open.feishu.cn'

function feishuCredential(appId = APP_ID, appSecret = 'secret-1'): string {
  return JSON.stringify({ appId, appSecret })
}

/**
 * 一条最小可用的 im.message.receive_v1（事件体形状对齐 SDK 推给 handler 的 payload）。
 * message / sender 单独开覆盖位，避免整块 event 覆盖掉 message 的默认字段导致断言失真；
 * flat=true 给「SDK 把 event 摊平到顶层」的那一类版本。
 */
function receiveEvent(
  options: { message?: Record<string, unknown>; sender?: Record<string, unknown>; flat?: boolean } = {}
): Record<string, unknown> {
  const event = {
    sender: options.sender ?? { sender_id: { open_id: 'ou_user_1', user_id: '', union_id: '' } },
    message: {
      message_id: 'om_msg_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我看下今天的待办' }),
      ...(options.message ?? {})
    }
  }
  return options.flat ? event : { schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event }
}

interface FakeDeps extends ChannelDeps {
  statuses: Array<{ state: BotRuntimeState; message?: string }>
  inbound: InboundMessage[]
  activated: number
  stopped: boolean
  credential: string | null
}

function createDeps(credential: string | null = feishuCredential()): FakeDeps {
  const deps: FakeDeps = {
    statuses: [],
    inbound: [],
    activated: 0,
    stopped: false,
    credential,
    async readCredential() {
      return deps.credential
    },
    async writeCredential(value: string) {
      deps.credential = value
    },
    async onInbound(message) {
      deps.inbound.push(message)
    },
    setStatus(state, message) {
      deps.statuses.push({ state, message })
    },
    async readCursor() {
      return undefined
    },
    async writeCursor() {
      /* 飞书不用游标 */
    },
    async markActivated() {
      deps.activated += 1
    },
    isStopped() {
      return deps.stopped
    },
    log() {
      /* 单测不打印主进程日志 */
    }
  }
  return deps
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

function jsonResponse(
  payload: unknown,
  init: { ok?: boolean; status?: number; logId?: string } = {}
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    async text() {
      return JSON.stringify(payload)
    },
    headers: { get: () => init.logId ?? null }
  } as unknown as Response
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 入站归一化
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeFeishuReceiveEvent', () => {
  it('放行 p2p 文本消息并映射成 InboundMessage', () => {
    const messages = normalizeFeishuReceiveEvent('bot-1', receiveEvent())
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({
      actor: { botId: 'bot-1', provider: 'feishu', providerUserId: 'ou_user_1', chatType: 'private' },
      text: '帮我看下今天的待办',
      messageId: 'om_msg_1'
    })
  })

  /**
   * 只认 p2p，反向排除不够：chat_type 缺失或飞书新增一种会话类型时，
   * 「不是 group」就等于收下了，而我们整个安全前提是「只认私聊」。
   */
  it('丢弃群聊以外的所有会话类型（含缺失与未知）', () => {
    for (const chatType of ['group', 'group_chat', '', 'team', 'shared', undefined, null]) {
      expect(
        normalizeFeishuReceiveEvent('bot-1', receiveEvent({ message: { chat_type: chatType } })),
        String(chatType)
      ).toEqual([])
    }
  })

  it('兼容 SDK 把 event 摊平到顶层的形状', () => {
    const messages = normalizeFeishuReceiveEvent('bot-1', receiveEvent({ flat: true }))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('帮我看下今天的待办')
  })

  it('解析 post（富文本）content：标题一行、正文按行拼接、@ 提醒不产出文本', () => {
    const post = {
      title: '会议通知',
      content: [
        [
          { tag: 'text', text: '明天 10 点开会' },
          { tag: 'a', text: '文档', href: 'https://example.cn/doc' }
        ],
        [{ tag: 'at', user_id: 'ou_2', name: '张三' }]
      ]
    }
    const messages = normalizeFeishuReceiveEvent(
      'bot-1',
      receiveEvent({ message: { message_type: 'post', content: JSON.stringify(post) } })
    )
    // 同行 token 直接相连（源码口径：feishuProvider.ts:573 的 join("")），链接按「文本 空格 href」
    expect(messages[0]?.text).toBe('会议通知\n明天 10 点开会文档 https://example.cn/doc')
    expect(readFeishuPostText(post)).toBe('会议通知\n明天 10 点开会文档 https://example.cn/doc')
  })

  it('content 已被摊成对象、以及 zh_cn 语种的 post 都能取值', () => {
    const objectContent = { post: { zh_cn: { content: [[{ tag: 'text', text: '带对象的富文本' }]] } } }
    const messages = normalizeFeishuReceiveEvent(
      'bot-1',
      receiveEvent({ message: { message_type: 'post', content: objectContent } })
    )
    expect(messages[0]?.text).toBe('带对象的富文本')
  })

  it('去掉 @ 机器人的占位符但不误伤邮箱', () => {
    const messages = normalizeFeishuReceiveEvent(
      'bot-1',
      receiveEvent({ message: { content: JSON.stringify({ text: '@_user_1 联系 me@example.com' }) } })
    )
    expect(messages[0]?.text).toBe('联系 me@example.com')
  })

  it('纯媒体消息（无文本）与缺发送者的消息都不产出入站', () => {
    expect(
      normalizeFeishuReceiveEvent(
        'bot-1',
        receiveEvent({ message: { message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }) } })
      )
    ).toEqual([])
    expect(normalizeFeishuReceiveEvent('bot-1', receiveEvent({ sender: {} }))).toEqual([])
    expect(normalizeFeishuReceiveEvent('bot-1', { event: { message: '不是对象' } })).toEqual([])
    expect(normalizeFeishuReceiveEvent('bot-1', null)).toEqual([])
  })

  it('非法 content JSON 不抛异常', () => {
    expect(normalizeFeishuReceiveEvent('bot-1', receiveEvent({ message: { content: '{坏掉的' } }))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 去重
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageIdDedupe', () => {
  it('同一 message_id 只放行一次（长连接重连会重投）', () => {
    const dedupe = new MessageIdDedupe()
    expect(dedupe.mark('om_1', 1_000)).toBe(true)
    expect(dedupe.mark('om_1', 2_000)).toBe(false)
    expect(dedupe.mark('om_2', 2_000)).toBe(true)
  })

  it('超出 TTL 窗口后不再拦', () => {
    const dedupe = new MessageIdDedupe(60_000)
    expect(dedupe.mark('om_1', 0)).toBe(true)
    expect(dedupe.mark('om_1', 61_000)).toBe(true)
  })

  it('容量上限生效：不会无界增长', () => {
    const dedupe = new MessageIdDedupe(10_000_000, 3)
    for (const id of ['a', 'b', 'c', 'd']) dedupe.mark(id, 0)
    expect(dedupe.size).toBe(3)
    expect(dedupe.mark('d', 0)).toBe(false) // d 还在表里
    expect(dedupe.mark('a', 0)).toBe(true) // 最早那条被淘汰，重新算首次
  })

  it('缺 message_id 时放行（宁可重复也不吞消息）', () => {
    expect(new MessageIdDedupe().mark('', 0)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. tenant_access_token 缓存
// ─────────────────────────────────────────────────────────────────────────────

describe('tenant_access_token', () => {
  let clock: number
  let tokenCalls: number

  beforeEach(() => {
    clock = 1_700_000_000_000
    tokenCalls = 0
  })

  /** 第 n 次请求发第 n 个 token，这样「复用缓存」在断言里是可见的 */
  const tokenPayload = (index: number, expireSeconds = 7200) => ({
    code: 0,
    msg: 'ok',
    tenant_access_token: `token-${index}`,
    expire: expireSeconds
  })

  function makeFetch(handler?: (body: Record<string, unknown>, index: number) => unknown) {
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const index = tokenCalls
      tokenCalls += 1
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return jsonResponse(handler ? handler(body, index) : tokenPayload(index))
    }) as unknown as typeof fetch
  }

  function store(fetchImpl: typeof fetch) {
    return createTenantTokenStore({ fetchImpl, now: () => clock })
  }

  it('isTokenFresh：剩余不足 30min 判定为要刷新', () => {
    const token = { token: 't', expiresAt: clock + 2 * 60 * 60_000 }
    expect(isTokenFresh(token, clock)).toBe(true)
    expect(isTokenFresh(token, clock + 89 * 60_000)).toBe(true)
    // 1h31m 后剩余 29min < 30min 提前量 → 刷
    expect(isTokenFresh(token, clock + 91 * 60_000)).toBe(false)
    expect(isTokenFresh({ token: 't', expiresAt: clock - 1 }, clock)).toBe(false)
  })

  it('token 请求走 internal 端点且只带 app_id/app_secret', async () => {
    const record: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      record.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      return jsonResponse(tokenPayload(0))
    }) as unknown as typeof fetch
    await store(fetchImpl).get(APP_ID, 'secret-1')
    expect(record).toHaveLength(1)
    expect(record[0]?.url).toBe(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`)
    expect(record[0]?.body).toEqual({ app_id: APP_ID, app_secret: 'secret-1' })
  })

  it('命中缓存不重复请求，到 30min 提前量才刷新', async () => {
    const fetchImpl = makeFetch()
    const tokenStore = store(fetchImpl)
    expect(await tokenStore.get(APP_ID, 'secret')).toBe('token-0')
    expect(await tokenStore.get(APP_ID, 'secret')).toBe('token-0')
    expect(tokenCalls).toBe(1)

    clock += 90 * 60_000 - 1 // 剩余 30min + 1s：仍在窗口内
    expect(await tokenStore.get(APP_ID, 'secret')).toBe('token-0')
    expect(tokenCalls).toBe(1)

    clock += 2 // 剩余 29min59s → 触发刷新
    expect(await tokenStore.get(APP_ID, 'secret')).toBe('token-1')
    expect(tokenCalls).toBe(2)
  })

  it('按服务端 expire 记账，不写死 2h', async () => {
    const fetchImpl = makeFetch((_body, index) => tokenPayload(index, 60))
    const tokenStore = store(fetchImpl)
    await tokenStore.get(APP_ID, 'secret')
    expect(tokenStore.peek(APP_ID, 'secret')?.expiresAt).toBe(clock + 60_000)
    // 短租期下剩余已不足 30min，下一次取值立刻刷新
    expect(await tokenStore.get(APP_ID, 'secret')).toBe('token-1')
    expect(tokenCalls).toBe(2)
  })

  it('并发只打一次 token 接口（飞书侧有频控），且共享同一个在途 promise', async () => {
    // 用对象持有 resolve：TS 不跟踪闭包里的赋值，直接 let + ?.() 会被窄化成 never
    const gate: { release: ((value: Response) => void) | null } = { release: null }
    let requested = 0
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          requested += 1
          gate.release = resolve
        })
    ) as unknown as typeof fetch
    const tokenStore = createTenantTokenStore({ fetchImpl, now: () => clock })
    const all = Promise.all([tokenStore.get(APP_ID, 'secret'), tokenStore.get(APP_ID, 'secret'), tokenStore.get(APP_ID, 'secret')])
    await waitFor(() => requested === 1)
    gate.release?.(jsonResponse(tokenPayload(0)))
    const tokens = await all
    expect(tokens).toEqual(['token-0', 'token-0', 'token-0'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('换凭据即换缓存条目，不会复用旧 App 的 token', async () => {
    const fetchImpl = makeFetch()
    const tokenStore = store(fetchImpl)
    expect(await tokenStore.get(APP_ID, 'secret-a')).toBe('token-0')
    expect(await tokenStore.get(APP_ID, 'secret-b')).toBe('token-1')
    expect(await tokenStore.get(APP_ID, 'secret-a')).toBe('token-0')
    expect(tokenCalls).toBe(2)
  })

  it('请求失败不留挂在途 promise，下一次调用能重试', async () => {
    const fetchImpl = makeFetch((_body, index) =>
      index === 0 ? { code: 100, msg: 'app_secret invalid' } : tokenPayload(index)
    )
    const tokenStore = store(fetchImpl)
    await expect(tokenStore.get(APP_ID, 'secret')).rejects.toThrow(/app_secret invalid/)
    expect(await tokenStore.get(APP_ID, 'secret')).toBe('token-1')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('HTTP 非 2xx 报错带 code/msg/log_id，便于排查', async () => {
    const fetchImpl = vi.fn(
      async () =>
        jsonResponse({ code: 1123, msg: 'bad gateway', error: { log_id: 'LOG-1' } }, {
          ok: false,
          status: 502,
          logId: 'RESP-1'
        })
    ) as unknown as typeof fetch
    await expect(store(fetchImpl).get(APP_ID, 'secret')).rejects.toThrow(/HTTP 502.*code=1123.*msg=bad gateway.*log_id=LOG-1/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. 出站协议形状
// ─────────────────────────────────────────────────────────────────────────────

describe('出站参数', () => {
  it('receive_id_type 按前缀判定', () => {
    expect(resolveReceiveIdType('ou_user_1')).toBe('open_id')
    expect(resolveReceiveIdType('oc_chat_1')).toBe('chat_id')
  })

  it('长文本切条，空串也发一条', () => {
    expect(splitFeishuText('', 4)).toEqual([''])
    expect(splitFeishuText('123456789', 4)).toEqual(['1234', '5678', '9'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 通道生命周期（假 SDK + 假 fetch）
// ─────────────────────────────────────────────────────────────────────────────

describe('feishuChannel 循环', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const savedTimers = { ...feishuTimers }

  const bot = {
    id: 'bot-feishu-1',
    provider: 'feishu' as const,
    name: '飞书遥控',
    enabled: true,
    credentialRef: 'bot-feishu-1'
  }

  beforeEach(() => {
    sdkDouble.FakeWsClient.instances = []
    Object.assign(feishuTimers, { statePollMs: 20, credentialPollMs: 40, backoffMs: 40 })
    fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 'token-x', expire: 7200 })
      }
      return jsonResponse({ code: 0, msg: 'ok', data: { message_id: 'om_out' } })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    Object.assign(feishuTimers, savedTimers)
    vi.unstubAllGlobals()
  })

  function tokenCallCount(): number {
    return fetchMock.mock.calls.filter((call) => String(call[0]).includes('tenant_access_token')).length
  }

  it('starting → connected，重复事件只投递一次，send 走 im/v1/messages 且 content 是字符串', async () => {
    const deps = createDeps()
    const handle = feishuChannel.create()
    const started = handle.start(bot, deps)

    await waitFor(() => deps.statuses.some((item) => item.state === 'connected'))
    expect(deps.statuses[0]?.state).toBe('starting')

    const client = sdkDouble.FakeWsClient.instances[0] as FakeClient
    expect(client.startCalls).toBe(1)
    expect(client.params).toMatchObject({ appId: APP_ID, appSecret: 'secret-1' })
    // 不 import SDK 的类型，但 domain 必须显式给国内飞书，否则 SDK 按默认值走也是同一个
    expect(client.params.domain).toBe(0)

    // 同一条 message_id 重投两次：只应有一条入站
    await client.dispatcher?.emit('im.message.receive_v1', receiveEvent())
    await client.dispatcher?.emit('im.message.receive_v1', receiveEvent())
    expect(deps.inbound).toHaveLength(1)
    expect(deps.activated).toBe(1)

    // 群聊事件在进 handler 之前就被归一化丢弃
    await client.dispatcher?.emit('im.message.receive_v1', receiveEvent({ message: { chat_type: 'group' } }))
    expect(deps.inbound).toHaveLength(1)

    await handle.send({ providerUserId: 'ou_user_1' }, '已完成')
    const sendCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/im/v1/messages')) as
      | [string, RequestInit]
      | undefined
    expect(sendCall).toBeTruthy()
    const [url, init] = sendCall as [string, RequestInit]
    expect(url).toBe(`${BASE}/open-apis/im/v1/messages?receive_id_type=open_id`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token-x')
    expect(JSON.parse(String(init.body))).toEqual({
      receive_id: 'ou_user_1',
      msg_type: 'text',
      content: JSON.stringify({ text: '已完成' })
    })

    // 第二次发送复用 token（并发/连发都只应打一次 token 接口）
    await handle.send({ providerUserId: 'ou_user_1' }, '再来一条')
    expect(tokenCallCount()).toBe(1)

    await handle.stop()
    await started
    // stop() 立刻 force close（不等状态轮询下一拍），session 收尾再兜一次；两次都必须是 force
    expect(client.closeCalls.length).toBeGreaterThanOrEqual(1)
    expect(client.closeCalls.every((call) => call.force === true)).toBe(true)
  })

  it('业务 code !== 0 时 send 抛错并带上 code/msg', async () => {
    const deps = createDeps()
    const handle = feishuChannel.create()
    const started = handle.start(bot, deps)
    await waitFor(() => deps.statuses.some((item) => item.state === 'connected'))
    fetchMock.mockImplementation(async () =>
      jsonResponse({ code: 99991672, msg: 'no permission' }, { ok: false, status: 400 })
    )
    await expect(handle.send({ providerUserId: 'ou_user_1' }, 'hi')).rejects.toThrow(/code=99991672.*no permission/)
    await handle.stop()
    await started
  })

  it('未启动就 send 直接报错，不猜凭据', async () => {
    const handle = feishuChannel.create()
    await expect(handle.send({ providerUserId: 'ou_user_1' }, 'hi')).rejects.toThrow(/尚未启动/)
  })

  it('凭据指纹变化：start() 按约定 resolve，旧连接已 force close，由宿主重建 handle', async () => {
    const deps = createDeps()
    const handle = feishuChannel.create()
    const started = handle.start(bot, deps)
    await waitFor(() => deps.statuses.some((item) => item.state === 'connected'))

    deps.credential = feishuCredential(OTHER_APP_ID, 'secret-2')
    await started
    const first = sdkDouble.FakeWsClient.instances[0] as FakeClient
    expect(first.closeCalls.every((call) => call.force === true)).toBe(true)
    // 不在本 handle 里偷偷重连：新 App 必须由宿主 create() 新实例
    expect(sdkDouble.FakeWsClient.instances).toHaveLength(1)
    expect(deps.statuses.at(-1)?.message).toMatch(/凭据已变更/)
  })

  it('凭据缺失时置 error 且不建连接；填好后自动接上', async () => {
    const deps = createDeps(null)
    const handle = feishuChannel.create()
    const started = handle.start(bot, deps)
    await waitFor(() => deps.statuses.some((item) => item.state === 'error'), 3_000)
    expect(sdkDouble.FakeWsClient.instances).toHaveLength(0)

    deps.credential = feishuCredential()
    await waitFor(() => deps.statuses.some((item) => item.state === 'connected'), 3_000)
    await handle.stop()
    await started
  })

  it('非法 App ID：置 error，不交给 SDK 静默失败；stop() 能打断退避', async () => {
    const deps = createDeps(JSON.stringify({ appId: 'not-a-valid-id', appSecret: 's' }))
    const handle = feishuChannel.create()
    const started = handle.start(bot, deps)
    await waitFor(() => deps.statuses.some((item) => item.state === 'error'), 3_000)
    expect(deps.statuses.at(-1)?.message).toMatch(/App ID 格式不正确/)
    expect(sdkDouble.FakeWsClient.instances).toHaveLength(0)
    await handle.stop()
    await started
  })

  it('isStopped() 为真时停连且不再重连', async () => {
    const deps = createDeps()
    const handle = feishuChannel.create()
    const started = handle.start(bot, deps)
    await waitFor(() => deps.statuses.some((item) => item.state === 'connected'))
    deps.stopped = true
    await started
    const client = sdkDouble.FakeWsClient.instances[0] as FakeClient
    expect(client.closeCalls.every((call) => call.force === true)).toBe(true)
    expect(sdkDouble.FakeWsClient.instances).toHaveLength(1)
  })

  it('SDK 报错（重连耗尽）时销毁旧连接并退避重建', async () => {
    const deps = createDeps()
    const handle = feishuChannel.create()
    const started = handle.start(bot, deps)
    await waitFor(() => deps.statuses.some((item) => item.state === 'connected'))

    const first = sdkDouble.FakeWsClient.instances[0] as FakeClient
    first.state = 'failed'
    await waitFor(() => sdkDouble.FakeWsClient.instances.length > 1, 3_000)
    const second = sdkDouble.FakeWsClient.instances[1] as FakeClient
    expect(first.closeCalls.every((call) => call.force === true)).toBe(true)
    expect(second.startCalls).toBe(1)
    expect(deps.statuses.some((item) => item.state === 'error')).toBe(true)
    await handle.stop()
    await started
  })

  it('getConnectionStatus 缺失时退回 readyState 探测（^1.64 下限版本）', () => {
    expect(readFeishuWsState({ wsConfig: { getWSInstance: () => ({ readyState: 1 }) } } as never)).toBe('connected')
    expect(readFeishuWsState({ wsConfig: { getWSInstance: () => null }, isConnecting: true } as never)).toBe('connecting')
    expect(readFeishuWsState({ wsConfig: {}, isConnecting: false } as never)).toBe('unknown')
    expect(readFeishuWsState({ getConnectionStatus: () => ({ state: 'reconnecting' }) } as never)).toBe('reconnecting')
  })
})
