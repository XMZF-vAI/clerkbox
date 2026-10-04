/**
 * 微信 iLink 通道单测（IM_BOTS_SPEC.md 第 5 节 · D3）。
 *
 * 全程 vi.stubGlobal('fetch') 打桩，绝不联网：真机的 getupdates 会在服务端挂约 35 秒，
 * 扫码状态接口能挂 30 秒，任何"顺手等一下"都会把测试拖成分钟级。
 * 需要长轮询循环自己收口的地方，一律靠 deps 的 isStopped 翻牌或 handle.stop() 打断，
 * 不靠等待超时 —— 那样测的是时钟而不是逻辑。
 */
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WEIXIN_BOT_API_PREFIX,
  WEIXIN_CHANNEL_VERSION,
  WEIXIN_DEFAULT_BASE_URL,
  WEIXIN_RET_SESSION_EXPIRED,
  buildWeixinApiHeaders,
  buildWeixinApiUrl,
  buildWeixinQrBeginUrl,
  buildWeixinQrStatusUrl,
  buildWeixinSecretJson,
  buildWeixinSendBody,
  buildWeixinUpdatesBody,
  createWeixinQrLogin,
  decryptWeixinMediaBytes,
  encryptWeixinMediaBytes,
  normalizeWeixinOutboundText,
  normalizeWeixinQrStatus,
  normalizeWeixinUpdates,
  parseWeixinAesKey,
  parseWeixinQrBegin,
  weixinBackoffMs,
  weixinChannel,
} from '../electron/im-bots/weixin'
import {
  credentialFingerprint,
  parseWeixinSecret,
  type BotConfig,
  type BotRuntimeState,
  type ChannelDeps,
  type InboundMessage,
  type WeixinQrEvent,
} from '../electron/im-bots/types'

// ─────────────────────────────────────────────────────────────────────────────
// 测试替身
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = { token: 'tok-1', baseUrl: WEIXIN_DEFAULT_BASE_URL, instanceId: 'inst-1' }
const SECRET_JSON = JSON.stringify(SECRET)
const BOT: BotConfig = {
  id: 'bot-wx-1',
  provider: 'weixin',
  name: '测试微信',
  enabled: true,
  credentialRef: 'bot-weixin-bot-wx-1',
}

interface FetchCall {
  url: string
  method: string
  body: string | undefined
  headers: Record<string, string>
}

/** 打桩 fetch 并记录调用；handler 返回对象即 JSON 响应，抛错即网络错误 */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown): FetchCall[] {
  const calls: FetchCall[] = []
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    if (init?.headers) Object.assign(headers, init.headers as Record<string, string>)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined, headers })
    const result = handler(url, init)
    return {
      ok: true,
      status: 200,
      text: async () => (typeof result === 'string' ? result : JSON.stringify(result)),
    }
  })
  vi.stubGlobal('fetch', impl)
  return calls
}

function bodyOf(call: FetchCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.body ?? '{}')) as Record<string, unknown>
}

interface DepsState {
  statuses: { state: BotRuntimeState; message?: string }[]
  inbound: InboundMessage[]
  cursorsWritten: (string | undefined)[]
  activated: number
  credentialReads: number
  /** 关键动作的顺序：游标必须在 onInbound 之后落盘，否则中途崩就永久丢消息 */
  events: string[]
}

/**
 * ChannelDeps 替身。stopOnPolling 默认 true：报出 polling 就把 isStopped 翻真，
 * 于是循环正好跑一轮长轮询后在 while 顶部退出 —— 测的是"停得下来"，不是等超时。
 */
function makeDeps(input: {
  credentials?: (string | null)[]
  cursor?: string
  stopOnPolling?: boolean
} = {}) {
  const queue = input.credentials ?? [SECRET_JSON]
  const state: DepsState = {
    statuses: [],
    inbound: [],
    cursorsWritten: [],
    activated: 0,
    credentialReads: 0,
    events: [],
  }
  let readIndex = 0
  let stopped = false
  const deps: ChannelDeps = {
    readCredential: async () => {
      state.credentialReads += 1
      const value = queue[Math.min(readIndex, queue.length - 1)]
      readIndex += 1
      state.events.push('readCredential')
      return value
    },
    writeCredential: async () => {
      state.events.push('writeCredential')
    },
    onInbound: async (message) => {
      state.events.push(`onInbound:${message.text}`)
      state.inbound.push(message)
    },
    setStatus: (next, message) => {
      state.statuses.push({ state: next, message })
      state.events.push(`setStatus:${next}`)
      if (input.stopOnPolling !== false && next === 'polling') stopped = true
    },
    readCursor: async () => {
      state.events.push('readCursor')
      return input.cursor
    },
    writeCursor: async (value) => {
      state.events.push('writeCursor')
      state.cursorsWritten.push(value)
    },
    markActivated: async () => {
      state.events.push('markActivated')
      state.activated += 1
    },
    isStopped: () => stopped,
    log: () => {},
  }
  return { deps, state, stop: () => { stopped = true } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─────────────────────────────────────────────────────────────────────────────
// 协议拼装：端点、鉴权头、请求体
// ─────────────────────────────────────────────────────────────────────────────

describe('微信 iLink 协议拼装', () => {
  it('基址 + /ilink/bot 前缀 + 端点路径；登录后的新域名照用', () => {
    expect(buildWeixinApiUrl('/getupdates')).toBe(
      `${WEIXIN_DEFAULT_BASE_URL}${WEIXIN_BOT_API_PREFIX}/getupdates`
    )
    expect(buildWeixinApiUrl('/sendmessage', 'https://ilink-new.weixin.qq.com/')).toBe(
      'https://ilink-new.weixin.qq.com/ilink/bot/sendmessage'
    )
  })

  it('脏 baseUrl 回落内置地址：不能让凭据里的串把请求带出协议', () => {
    expect(buildWeixinApiUrl('/getupdates', 'javascript:alert(1)')).toContain(WEIXIN_DEFAULT_BASE_URL)
    expect(buildWeixinApiUrl('/getupdates', '')).toContain(WEIXIN_DEFAULT_BASE_URL)
  })

  it('取码与状态接口：bot_type=3，qrcode 必须转义', () => {
    expect(buildWeixinQrBeginUrl()).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3')
    expect(buildWeixinQrStatusUrl('a/b?c=1')).toBe(
      'https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=a%2Fb%3Fc%3D1'
    )
  })

  it('鉴权头四件套（缺 AuthorizationType 服务端直接拒）', () => {
    const headers = buildWeixinApiHeaders('tok-1')
    expect(headers.AuthorizationType).toBe('ilink_bot_token')
    expect(headers.Authorization).toBe('Bearer tok-1')
    expect(headers['content-type']).toBe('application/json')
    const uin = Number(Buffer.from(headers['X-WECHAT-UIN'], 'base64').toString('utf8'))
    expect(Number.isInteger(uin)).toBe(true)
    expect(uin).toBeGreaterThanOrEqual(0)
  })

  it('每个 POST 都带 base_info.channel_version=2.0.0', () => {
    expect(buildWeixinUpdatesBody(undefined)).toEqual({ get_updates_buf: '' })
    const merged = { ...bodyOf(undefined), ...buildWeixinUpdatesBody('buf-1') }
    expect(merged).toEqual({ get_updates_buf: 'buf-1' })
    // 通道自己发请求时 base_info 在最外层，这里直接验拼装结果
    const text = JSON.stringify({ base_info: { channel_version: WEIXIN_CHANNEL_VERSION }, ...merged })
    expect(JSON.parse(text)).toEqual({ base_info: { channel_version: '2.0.0' }, get_updates_buf: 'buf-1' })
  })

  it('发消息体：文本进 msg.item_list，context_token 原样回传，换行归一成 CRLF', () => {
    const body = buildWeixinSendBody({
      secret: SECRET,
      target: { providerUserId: 'user-1', contextToken: 'ctx-9' },
      text: '第一行\n第二行\r\n第三行',
      clientId: 'fixed-client',
    }) as { msg: Record<string, unknown> }
    expect(body.msg.message_type).toBe(2)
    expect(body.msg.message_state).toBe(2)
    expect(body.msg.to_user_id).toBe('user-1')
    expect(body.msg.from_user_id).toBe('inst-1')
    expect(body.msg.client_id).toBe('fixed-client')
    expect(body.msg.context_token).toBe('ctx-9')
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: '第一行\r\n第二行\r\n第三行' } }])
    expect(normalizeWeixinOutboundText('a\nb')).toBe('a\r\nb')
  })

  it('没有 context_token 就不带上这个字段（空串等于对服务端撒谎）', () => {
    const body = buildWeixinSendBody({
      secret: SECRET,
      target: { providerUserId: 'u' },
      text: 'x',
      clientId: 'c',
    }) as { msg: Record<string, unknown> }
    expect('context_token' in body.msg).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getupdates 响应归一化
// ─────────────────────────────────────────────────────────────────────────────

function rawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 1234,
    from_user_id: 'user-1',
    context_token: 'ctx-1',
    sender: { name: '老板' },
    msg: { item_list: [{ type: 1, text_item: { text: '帮我整理周报' } }] },
    ...overrides,
  }
}

describe('getupdates 归一化', () => {
  it('只留私聊文本消息，并按 data 里的游标推进', () => {
    const payload = {
      ret: 0,
      data: {
        msgs: [
          rawMessage(),
          rawMessage({ message_id: 1235, room_id: 'room-1' }), // 群聊：本期不收
          rawMessage({ message_id: 1236, message_type: 2 }), // bot 自己的回显：丢
          rawMessage({ message_id: 1237, from_user_id: '' }), // 没有发送者：没法回
          rawMessage({ message_id: 1238, msg: { item_list: [{ type: 3 }] } }), // 无文本（附件）：本期不做
        ],
        get_updates_buf: 'buf-2',
      },
    }
    const result = normalizeWeixinUpdates(payload, BOT.id, 'buf-1')
    expect(result.rawCount).toBe(5)
    expect(result.drops).toEqual({ self: 1, group: 1, noUser: 1, emptyText: 1 })
    expect(result.buf).toBe('buf-2')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      actor: {
        botId: BOT.id,
        provider: 'weixin',
        providerUserId: 'user-1',
        chatType: 'private',
        displayName: '老板',
      },
      text: '帮我整理周报',
      messageId: '1234',
      contextToken: 'ctx-1',
    })
  })

  it('服务端没给新游标时沿用当前游标（写回空游标等于把历史消息再倒一遍）', () => {
    expect(normalizeWeixinUpdates({ data: { msgs: [] } }, BOT.id, 'buf-keep').buf).toBe('buf-keep')
    expect(normalizeWeixinUpdates({ data: { msgs: [] } }, BOT.id, undefined).buf).toBeUndefined()
  })

  it('缺 context_token 的消息照常投递：吞掉用户输入比回不出去更糟', () => {
    const result = normalizeWeixinUpdates({ data: { msgs: [rawMessage({ context_token: undefined })] } }, BOT.id)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.contextToken).toBeUndefined()
  })

  it('顶层 text 与字符串 msgid 也认（不同客户端版本字段位置不一样）', () => {
    const result = normalizeWeixinUpdates(
      { data: { messages: [{ id: 'm-9', from_user_id: 'u', text: '  带空白的正文  ' }] } },
      BOT.id
    )
    expect(result.messages[0]).toEqual({
      actor: { botId: BOT.id, provider: 'weixin', providerUserId: 'u', chatType: 'private' },
      text: '带空白的正文',
      messageId: 'm-9',
    })
  })

  it('非对象载荷不炸；单条对象也当一条处理', () => {
    expect(normalizeWeixinUpdates(null, BOT.id).messages).toEqual([])
    expect(normalizeWeixinUpdates({ data: { msgs: { from_user_id: 'u', text: 'x' } } }, BOT.id).messages).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 媒体加解密（本期只收发文本，实现先长好并被单测锁住）
// ─────────────────────────────────────────────────────────────────────────────

describe('微信 CDN 媒体 AES-128-ECB/PKCS7', () => {
  const HEX_KEY = '0123456789abcdef0123456789abcdef'

  it('密钥三种形态都解得开：32 位 hex / base64(16 字节) / base64(hex 串)', () => {
    expect(parseWeixinAesKey(HEX_KEY)).toEqual(Buffer.from(HEX_KEY, 'hex'))
    expect(parseWeixinAesKey(Buffer.from(HEX_KEY, 'hex').toString('base64'))).toEqual(Buffer.from(HEX_KEY, 'hex'))
    expect(parseWeixinAesKey(Buffer.from(HEX_KEY, 'utf8').toString('base64'))).toEqual(Buffer.from(HEX_KEY, 'hex'))
    expect(parseWeixinAesKey('not-a-key')).toBeNull()
  })

  it('加密 → 解密往返一致（含中文、空串与 1KB）', () => {
    for (const text of ['周报已生成 ✅', '', 'x'.repeat(1024)]) {
      const plain = Buffer.from(text, 'utf8')
      expect(Buffer.from(decryptWeixinMediaBytes(encryptWeixinMediaBytes(plain, HEX_KEY), HEX_KEY)).toString('utf8')).toBe(
        text
      )
    }
  })

  it('16 字节明文密文是 32 字节：PKCS#7 补齐整块，autoPad 不能被关掉', () => {
    const cipher = encryptWeixinMediaBytes(Buffer.alloc(16, 7), HEX_KEY)
    expect(cipher).toHaveLength(32)
    expect(Buffer.from(cipher).equals(Buffer.alloc(16, 7))).toBe(false)
  })

  it('密钥无效时报错而不是回一段乱码（写坏附件比抛错难查得多）', () => {
    expect(() => decryptWeixinMediaBytes(Buffer.alloc(16), 'bad-key')).toThrow('AES 密钥格式无效')
    expect(() => encryptWeixinMediaBytes(Buffer.alloc(16), 'bad-key')).toThrow('AES 密钥格式无效')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 扫码四态
// ─────────────────────────────────────────────────────────────────────────────

describe('微信扫码四态', () => {
  it('数字与字符串两套 status 都归一到 waiting/scanned/confirmed/expired', () => {
    expect(normalizeWeixinQrStatus({ status: 0 })).toEqual({ state: 'waiting' })
    expect(normalizeWeixinQrStatus({ status: 'waiting' })).toEqual({ state: 'waiting' })
    expect(normalizeWeixinQrStatus({ qrcode_status: 'scaned' })).toEqual({ state: 'scanned' })
    expect(normalizeWeixinQrStatus({ status: 3 })).toEqual({ state: 'expired', message: '二维码已过期，请重新扫码' })
    expect(normalizeWeixinQrStatus({ qr_status: 'cancel' }).state).toBe('expired')
    // 没见过的值一律当"还在等"：把码判死等于把用户这次扫码作废
    expect(normalizeWeixinQrStatus({ status: 'whatever' }).state).toBe('waiting')
  })

  it('confirmed 必须带 bot_token，且把重定向 baseUrl 与 iLink bot id 一起收下来', () => {
    expect(
      normalizeWeixinQrStatus({
        status: 'confirmed',
        bot_token: 'tok-new',
        ilink_bot_id: 'inst-new',
        baseurl: 'https://ilink-new.weixin.qq.com',
      })
    ).toEqual({ state: 'confirmed', token: 'tok-new', instanceId: 'inst-new', baseUrl: 'https://ilink-new.weixin.qq.com' })
    // 服务端说成功却没给 token：这是协议异常，绝不能写成一份坏凭据
    expect(normalizeWeixinQrStatus({ status: 'success' })).toMatchObject({ state: 'error' })
  })

  it('凭据 JSON 恰好是 WeixinSecretSchema 的形状（strictObject，多写字段会自己把自己拒掉）', () => {
    const json = buildWeixinSecretJson({
      state: 'confirmed',
      token: 'tok-new',
      instanceId: 'inst-new',
      baseUrl: 'https://ilink-new.weixin.qq.com/',
    })
    expect(parseWeixinSecret(json)).toEqual({
      token: 'tok-new',
      baseUrl: 'https://ilink-new.weixin.qq.com',
      instanceId: 'inst-new',
    })
    // 没给 baseUrl 时回落内置地址，而不是写进一份没法用的凭据
    expect(parseWeixinSecret(buildWeixinSecretJson({ state: 'confirmed', token: 't' }))).toEqual({
      token: 't',
      baseUrl: WEIXIN_DEFAULT_BASE_URL,
    })
  })

  it('二维码内容优先 qrcode_img_content，两者都没有时二维码串自己就是可画内容', () => {
    expect(parseWeixinQrBegin({ qrcode: 'RAW', qrcode_img_content: 'https://qr/1' })).toMatchObject({
      qrCode: 'RAW',
      qrUrl: 'https://qr/1',
      intervalSeconds: 3,
    })
    expect(parseWeixinQrBegin({ qr_code: 'RAW' })?.qrUrl).toBe('RAW')
    // 默认有效期 120 秒；服务端给了 expires_in 就以它为准
    expect(parseWeixinQrBegin({ qrcode: 'RAW' }, 1_700_000_000_000)?.expiresAt).toBe(1_700_000_000_000 + 120_000)
    expect(parseWeixinQrBegin({ qrcode: 'RAW', expires_in: 30 }, 1_700_000_000_000)?.expiresAt).toBe(
      1_700_000_000_000 + 30_000
    )
    expect(parseWeixinQrBegin({ qrcode_img_content: 'https://qr/1' })).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 退避
// ─────────────────────────────────────────────────────────────────────────────

describe('网络错误退避', () => {
  it('1s 起翻倍，封顶 30s', () => {
    expect(weixinBackoffMs(1)).toBe(1_000)
    expect(weixinBackoffMs(5)).toBe(16_000)
    expect(weixinBackoffMs(6)).toBe(30_000)
    expect(weixinBackoffMs(999)).toBe(30_000)
    expect(weixinBackoffMs(0)).toBe(1_000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 长轮询循环
// ─────────────────────────────────────────────────────────────────────────────

describe('长轮询循环', () => {
  it('一轮收消息：游标在本批 onInbound 之后才落盘，首条额外记激活', async () => {
    const calls = stubFetch(() => ({
      ret: 0,
      data: { msgs: [rawMessage()], get_updates_buf: 'buf-2' },
    }))
    const { deps, state } = makeDeps({ cursor: 'buf-1' })
    const handle = weixinChannel.create()
    expect(handle.provider).toBe('weixin')

    // start() 的 promise 表示通道生命周期：宿主让 isStopped 翻牌后它就 resolve
    await handle.start(BOT, deps)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/getupdates')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers.Authorization).toBe('Bearer tok-1')
    expect(bodyOf(calls[0])).toEqual({ base_info: { channel_version: '2.0.0' }, get_updates_buf: 'buf-1' })
    expect(state.inbound.map((m) => m.text)).toEqual(['帮我整理周报'])
    expect(state.cursorsWritten).toEqual(['buf-2'])
    expect(state.activated).toBe(1)
    // 顺序即正确性：先 onInbound 再 writeCursor，中途崩了服务端会重投这一批
    expect(state.events).toEqual([
      'setStatus:starting',
      'readCredential',
      'readCursor',
      'onInbound:帮我整理周报',
      'markActivated',
      'writeCursor',
      'setStatus:polling',
    ])
    expect(state.statuses.map((s) => s.state)).toEqual(['starting', 'polling'])
    await handle.stop()
  })

  it('游标没变就不写盘（每条空轮询都改写状态文件是白给磁盘压力）', async () => {
    stubFetch(() => ({ ret: 0, data: { msgs: [], get_updates_buf: 'buf-1' } }))
    const { deps, state } = makeDeps({ cursor: 'buf-1' })
    const handle = weixinChannel.create()
    await handle.start(BOT, deps)
    expect(state.cursorsWritten).toEqual([])
    await handle.stop()
  })

  it('ret=-14 映射为 error 状态并停止本轮循环，不做退避重试', async () => {
    const calls = stubFetch(() => ({ ret: WEIXIN_RET_SESSION_EXPIRED, errmsg: 'session expired' }))
    const { deps, state } = makeDeps()
    const handle = weixinChannel.create()
    await handle.start(BOT, deps)

    expect(calls.filter((c) => c.url.includes('/getupdates'))).toHaveLength(1)
    const error = state.statuses.find((s) => s.state === 'error')
    expect(error?.message).toContain('微信登录已过期')
    expect(error?.message).toContain('重新扫码')
    expect(state.inbound).toHaveLength(0)
    expect(state.statuses.at(-1)?.state).toBe('error')
    await handle.stop()
  })

  it('没有凭据时置 error 而不是抛（start 的 promise 仍然 resolve）', async () => {
    const calls = stubFetch(() => ({ ret: 0 }))
    const { deps, state } = makeDeps({ credentials: [null] })
    const handle = weixinChannel.create()
    await handle.start(BOT, deps)
    expect(state.statuses.map((s) => s.state)).toEqual(['starting', 'error'])
    expect(state.statuses[1]?.message).toContain('尚未扫码登录微信')
    expect(calls).toHaveLength(0)
    await handle.stop()
  })

  it('凭据内容损坏时置 error 并给出可操作提示', async () => {
    const { deps, state } = makeDeps({ credentials: ['{"appid":"x"}'] })
    const handle = weixinChannel.create()
    await handle.start(BOT, deps)
    expect(state.statuses[1]?.state).toBe('error')
    expect(state.statuses[1]?.message).toContain('凭据内容无效')
    await handle.stop()
  })

  it('凭据指纹变更：本轮末尾直接退出且不再发请求，交给 index.ts 重建 handle', async () => {
    const calls = stubFetch(() => ({ ret: 0, data: { msgs: [], get_updates_buf: 'buf-2' } }))
    const nextSecret = JSON.stringify({ token: 'tok-2', baseUrl: WEIXIN_DEFAULT_BASE_URL, instanceId: 'bot-2' })
    expect(credentialFingerprint('weixin', nextSecret)).not.toBe(credentialFingerprint('weixin', SECRET_JSON))
    // stopOnPolling:false —— 否则第一轮就退出，测不到第二轮的指纹比对
    const { deps, state } = makeDeps({ credentials: [SECRET_JSON, nextSecret], stopOnPolling: false })
    const handle = weixinChannel.create()
    await handle.start(BOT, deps)

    // 只发了一次请求：新凭据那条循环归新 handle 管，旧循环不许拿新 token 继续跑
    expect(calls.filter((c) => c.url.includes('/getupdates'))).toHaveLength(1)
    expect(state.credentialReads).toBe(2)
    expect(state.statuses.map((s) => s.state)).toEqual(['starting', 'polling'])
    expect(state.statuses.some((s) => s.state === 'error')).toBe(false)
    await handle.stop()
  })

  it('isStopped() 为真时立刻退出，且退出时不覆盖宿主写的状态', async () => {
    const calls = stubFetch(() => ({ ret: 0, data: { msgs: [] } }))
    const { deps, state, stop } = makeDeps({ stopOnPolling: false })
    const handle = weixinChannel.create()
    stop() // 用户已经把它关了：循环一次请求都不该发
    await handle.start(BOT, deps)
    expect(calls).toHaveLength(0)
    // 只报了 starting：通道不再补一条 idle，否则会把宿主写的 disabled 冲掉
    expect(state.statuses.map((s) => s.state)).toEqual(['starting'])
    expect(state.events).toEqual(['setStatus:starting'])
    await handle.stop()
  })

  it('网络错误：首次保持 polling（网络波动，正在重试），连续失败才升级 error；stop() 立刻打断等待', async () => {
    let attempts = 0
    stubFetch(() => {
      attempts += 1
      throw new Error('ECONNRESET simulated')
    })
    // stopOnPolling: false——首次失败现在就是 polling 状态，不能让测试桩在那时翻停，
    // 否则「连续失败升级 error」这条路径根本走不到
    const { deps, state } = makeDeps({ stopOnPolling: false })
    const handle = weixinChannel.create()
    const started = handle.start(BOT, deps)
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(1))
    // 第一次失败：不报 error（瞬时抖动自动恢复，报「连接异常」会诱导用户白扫一次码）
    expect(state.statuses.at(-1)?.state).toBe('polling')
    expect(state.statuses.at(-1)?.message).toContain('网络波动')
    // 第二次失败：升级为 error 并给出退避提示（第二次退避 2s，放宽等待窗口）
    await vi.waitFor(() => expect(state.statuses.at(-1)?.state).toBe('error'), { timeout: 4000 })
    expect(state.statuses.at(-1)?.message).toContain('ECONNRESET')
    await handle.stop()
    await expect(started).resolves.toBeUndefined()
    // stop() 打断的是退避 sleep，所以最后一条状态一定是 idle
    expect(state.statuses.at(-1)?.state).toBe('idle')
    expect(state.statuses.at(-1)?.message).toContain('已停止')
  })

  it('同一实例重复 start 直接抛（接线错误必须响）', async () => {
    stubFetch(() => ({ ret: 0, data: { msgs: [] } }))
    const { deps } = makeDeps()
    const handle = weixinChannel.create()
    await handle.start(BOT, deps)
    await expect(handle.start(BOT, deps)).rejects.toThrow('already started')
    await handle.stop()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 出站发送
// ─────────────────────────────────────────────────────────────────────────────

describe('sendmessage', () => {
  it('用凭据里的 baseUrl 与 instanceId，并原样回传 context_token', async () => {
    const calls = stubFetch((url) => (url.includes('/getupdates') ? { ret: 0, data: { msgs: [] } } : { ret: 0 }))
    const { deps } = makeDeps()
    const handle = weixinChannel.create()
    await handle.start(BOT, deps) // 跑一轮就退出，只为拿到 deps 句柄
    await handle.send({ providerUserId: 'user-1', contextToken: 'ctx-9' }, '周报好了\n请查收')

    const send = calls.find((c) => c.url.endsWith('/sendmessage'))
    expect(send?.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/sendmessage')
    expect(send?.headers.Authorization).toBe('Bearer tok-1')
    const msg = bodyOf(send).msg as Record<string, unknown>
    expect(msg.to_user_id).toBe('user-1')
    expect(msg.from_user_id).toBe('inst-1')
    expect(msg.context_token).toBe('ctx-9')
    expect(msg.item_list).toEqual([{ type: 1, text_item: { text: '周报好了\r\n请查收' } }])
    await handle.stop()
  })

  it('宿主没带 context_token 时回退用最近一次入站的记录（收得到就该回得出话）', async () => {
    let delivered = true
    const calls = stubFetch((url) => {
      if (url.includes('/getupdates')) {
        if (!delivered) return { ret: 0, data: { msgs: [] } }
        delivered = false
        return { ret: 0, data: { msgs: [rawMessage()], get_updates_buf: 'buf-2' } }
      }
      return { ret: 0 }
    })
    const { deps } = makeDeps()
    const handle = weixinChannel.create()
    await handle.start(BOT, deps) // 这一轮收到的消息带着 ctx-1
    await handle.send({ providerUserId: 'user-1' }, '补一条回复')

    const msg = bodyOf(calls.find((c) => c.url.endsWith('/sendmessage'))).msg as Record<string, unknown>
    expect(msg.context_token).toBe('ctx-1')
    await handle.stop()
  })

  it('服务端错误码要冒到调用方（发送失败必须能被会话桥看见）', async () => {
    stubFetch((url) => (url.includes('/sendmessage') ? { errcode: 40001, errmsg: 'invalid token' } : { ret: 0, data: { msgs: [] } }))
    const { deps } = makeDeps()
    const handle = weixinChannel.create()
    await handle.start(BOT, deps)
    await expect(handle.send({ providerUserId: 'user-1', contextToken: 'ctx' }, 'x')).rejects.toThrow('invalid token')
    await handle.stop()
  })

  it('没 start 过就 send：直接拒绝，不发请求', async () => {
    const calls = stubFetch(() => ({ ret: 0 }))
    const handle = weixinChannel.create()
    await expect(handle.send({ providerUserId: 'u' }, 'x')).rejects.toThrow('请先 start')
    expect(calls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 扫码登录编排器
// ─────────────────────────────────────────────────────────────────────────────

function makeQrDeps() {
  const written: string[] = []
  const events: WeixinQrEvent[] = []
  const deps = {
    readCredential: async () => null as string | null,
    writeCredential: async (value: string) => {
      written.push(value)
    },
    onEvent: (event: WeixinQrEvent) => {
      events.push(event)
    },
    log: () => {},
  }
  return { deps, written, events }
}

describe('createWeixinQrLogin', () => {
  it('出码即广播 waiting，确认后写凭据并广播 confirmed（重定向 baseUrl 一起存）', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('/get_bot_qrcode')) {
        return { ret: 0, data: { qrcode: 'QR-1', qrcode_img_content: 'https://qr.example/1' } }
      }
      return {
        ret: 0,
        data: {
          status: 'confirmed',
          bot_token: 'tok-new',
          ilink_bot_id: 'inst-new',
          baseurl: 'https://ilink-new.weixin.qq.com',
        },
      }
    })
    const { deps, written, events } = makeQrDeps()
    const login = createWeixinQrLogin(deps)
    const result = await login.start(BOT.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.state).toBe('waiting')
    expect(result.session.qrUrl).toBe('https://qr.example/1')
    expect(events[0]).toEqual({ session: result.session.id, botId: BOT.id, state: 'waiting', qrUrl: 'https://qr.example/1' })

    await vi.waitFor(() => expect(events.some((e) => e.state === 'confirmed')).toBe(true))
    expect(parseWeixinSecret(written[0] ?? '')).toEqual({
      token: 'tok-new',
      baseUrl: 'https://ilink-new.weixin.qq.com',
      instanceId: 'inst-new',
    })
    // 取码是免鉴权 GET，只带客户端版本头；状态查询串行跟一次，不堆请求
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.headers['iLink-App-ClientVersion']).toBe('1')
    expect(calls[0]?.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3')
    expect(calls[1]?.url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=QR-1')
    const snapshot = login.peek(result.session.id)
    expect(snapshot?.finished).toBe(true)
    expect(snapshot?.state).toBe('confirmed')
    login.dispose()
  })

  it('expired 会被广播出来并且不再继续轮询', async () => {
    const calls = stubFetch((url) =>
      url.includes('/get_bot_qrcode')
        ? { data: { qrcode: 'QR-2', qrcode_url: 'https://qr.example/2' } }
        : { data: { status: 'expired' } }
    )
    const { deps, events, written } = makeQrDeps()
    const login = createWeixinQrLogin(deps)
    const result = await login.start(BOT.id)
    if (!result.ok) throw new Error('start failed')
    await vi.waitFor(() => expect(events.some((e) => e.state === 'expired')).toBe(true))
    expect(calls.filter((c) => c.url.includes('/get_qrcode_status'))).toHaveLength(1)
    expect(written).toHaveLength(0)
    login.dispose()
  })

  it('取码失败回 {ok:false,error}，不留下半开的会话', async () => {
    stubFetch(() => {
      throw new Error('ENOTFOUND')
    })
    const { deps, events } = makeQrDeps()
    const login = createWeixinQrLogin(deps)
    const result = await login.start(BOT.id)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('获取微信二维码失败')
    expect(events).toHaveLength(0)
    login.dispose()
  })

  it('同一 bot 重复扫码会撤掉旧会话的长轮询；stop() 之后 peek 回 null', async () => {
    stubFetch((url) => {
      if (url.includes('/get_bot_qrcode')) return { data: { qrcode: `QR-${Date.now()}${Math.random()}` } }
      // 状态一律回 waiting：让两个会话都挂在轮询上，才能验证旧的被撤
      return { data: { status: 'waiting' } }
    })
    const { deps } = makeQrDeps()
    const login = createWeixinQrLogin(deps)
    const first = await login.start(BOT.id)
    if (!first.ok) throw new Error('start failed')
    const second = await login.start(BOT.id)
    if (!second.ok) throw new Error('start failed')
    expect(second.session.id).not.toBe(first.session.id)
    expect(login.peek(first.session.id)).toBeNull()
    expect(login.peek(second.session.id)?.finished).toBe(false)
    login.stop(second.session.id)
    expect(login.peek(second.session.id)).toBeNull()
    login.dispose()
  })
})
