import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

/**
 * 主进程装配层（index.ts）验收。
 *
 * electron 被整体打桩：这一层要测的是「编排规则」——状态回落、凭据可用性判定、
 * 通道表覆盖、handler 注册完整性——而不是 Electron 本身。
 * 落盘仍用真实临时目录：装配层与 storage 的接缝正是最容易各写一套假设的地方。
 */
const handled = new Map<string, unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: unknown) => {
      handled.set(channel, handler)
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  // makeChannelDeps 会按渠道访问 net.fetch（Telegram 注入）；node 测试环境没有它，
  // 显式给 undefined 让通道回退 globalThis.fetch
  net: undefined,
}))
// 宿主事件出口不牵扯本层逻辑，且 api-proxy 会拉进真的 electron 依赖
vi.mock('../electron/api-proxy', () => ({ startChatStream: vi.fn(), abortChatStream: vi.fn() }))
/**
 * 飞书 SDK 打桩：装配层一旦被喂进一份「可用」的飞书凭据就会真的建长连接，
 * 单测里那是一次真实外网请求 + 一个挂着的 socket。桩的形状对齐 feishu.ts
 * 真正用到的三个成员（EventDispatcher.register / WSClient.start / close）。
 */
vi.mock('@larksuiteoapi/node-sdk', () => ({
  EventDispatcher: class {
    register(): unknown {
      return this
    }
  },
  WSClient: class {
    async start(): Promise<void> {}
    close(): void {}
    getConnectionStatus(): { state: string } {
      return { state: 'connected' }
    }
  },
  Domain: { Feishu: 'https://open.feishu.cn' },
}))

import {
  CHANNELS,
  buildBotListItems,
  credentialIsUsable,
  defaultWorkDirFor,
  disposeImBots,
  imBotsDiagnostics,
  initImBots,
  makeId,
  syncChannels,
} from '../electron/im-bots/index'
import {
  BOT_PROVIDERS,
  BOTS_IPC_CHANNELS,
  credentialRefFor,
  makeActorKey,
  type BotConfig,
  type RuntimeStatus,
} from '../electron/im-bots/types'
import { makeRandomBindCode } from '../electron/im-bots/core'
import { BotsStorage } from '../electron/im-bots/storage'

let base: string
const credentials = new Map<string, string>()

/** 只测装配层，会话存储与管理器都给最小假件 */
function fakeHost(userDataPath: string) {
  return {
    userDataPath,
    store: {
      createSession: vi.fn(async () => {}),
      getAllSessions: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
    } as never,
    manager: {
      inspect: () => [],
      peekRunSettings: () => undefined,
      handleCommand: async () => ({ ok: true }),
      hasLocalSettingsSnapshot: false,
    } as never,
    readCredential: async (id: string) => credentials.get(id) ?? null,
    writeCredential: async (id: string, value: string) => {
      credentials.set(id, value)
    },
    deleteCredential: async (id: string) => {
      credentials.delete(id)
    },
  }
}

function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot1',
    provider: 'weixin',
    name: '我的微信',
    enabled: true,
    credentialRef: credentialRefFor('weixin', 'bot1'),
    ...overrides,
  }
}

beforeEach(async () => {
  handled.clear()
  credentials.clear()
  base = await fs.mkdtemp(path.join(os.tmpdir(), `cb-index-${process.pid}-`))
})

afterEach(async () => {
  await disposeImBots()
  await fs.rm(base, { recursive: true, force: true }).catch(() => {})
})

describe('凭据可用性', () => {
  it('微信要 token + baseUrl，飞书要 appId + appSecret', () => {
    expect(credentialIsUsable('weixin', JSON.stringify({ token: 't', baseUrl: 'https://x' }))).toBe(true)
    expect(credentialIsUsable('weixin', JSON.stringify({ token: 't' }))).toBe(false)
    expect(credentialIsUsable('feishu', JSON.stringify({ appId: 'a', appSecret: 's' }))).toBe(true)
    expect(credentialIsUsable('feishu', JSON.stringify({ appId: 'a' }))).toBe(false)
  })

  it('空值与结构不对的 JSON 一律「未配置」，不拿它去连网络', () => {
    for (const provider of BOT_PROVIDERS) {
      expect(credentialIsUsable(provider, null)).toBe(false)
      expect(credentialIsUsable(provider, '')).toBe(false)
      expect(credentialIsUsable(provider, 'not json')).toBe(false)
      expect(credentialIsUsable(provider, '{"token":123}')).toBe(false)
    }
  })
})

describe('列表装配', () => {
  const statusOf = new Map<string, RuntimeStatus>()

  function items(bots: BotConfig[]) {
    return buildBotListItems({
      bots,
      statusOf: (id) => statusOf.get(id),
      boundOf: () => [],
      hasCredentialOf: () => false,
    })
  }

  it('没有实时状态时按 enabled 回落：停用 bot 不能画成「空闲」', () => {
    statusOf.clear()
    expect(items([bot({ enabled: true })])[0]?.status).toBe('idle')
    expect(items([bot({ enabled: false })])[0]?.status).toBe('disabled')
  })

  it('有实时状态时以它为准，并把 message 带出去（error 态的 message 是用户唯一的排错线索）', () => {
    statusOf.clear()
    statusOf.set('bot1', { botId: 'bot1', state: 'error', message: '登录已过期，请重新扫码' })
    const row = items([bot({ enabled: false })])[0]
    expect(row?.status).toBe('error')
    expect(row?.statusMessage).toBe('登录已过期，请重新扫码')
  })

  it('配置字段原样透传，不吞掉 defaultWorkDir', () => {
    statusOf.clear()
    const row = items([bot({ defaultWorkDir: 'D:/repo-a' })])[0]
    expect(row?.defaultWorkDir).toBe('D:/repo-a')
    expect(row?.credentialRef).toBe('bot-weixin-bot1')
  })
})

describe('通道表', () => {
  it('每个渠道常量都有实现工厂（新增渠道忘了接线要在这里炸）', () => {
    for (const provider of BOT_PROVIDERS) {
      expect(CHANNELS[provider], provider).toBeDefined()
      expect(CHANNELS[provider].provider).toBe(provider)
      expect(typeof CHANNELS[provider].create().send).toBe('function')
    }
  })

  it('通道表不认得之外的渠道', () => {
    expect(Object.keys(CHANNELS).sort()).toEqual([...BOT_PROVIDERS].sort())
  })
})

describe('初始化与 IPC 注册', () => {
  it('常量表里的每条 bots:* 都被真实注册，且不多注册（期望取自常量表本身，加通道不会漏改这里）', async () => {
    initImBots(fakeHost(base))
    expect([...handled.keys()].sort()).toEqual([...Object.values(BOTS_IPC_CHANNELS)].map(String).sort())
  })

  it('重复 init 只装一次（before-quit 之后再 init 也不该长出第二套 handler 与通道池）', async () => {
    initImBots(fakeHost(base))
    const first = handled.size
    initImBots(fakeHost(base))
    expect(handled.size).toBe(first)
  })

  it('启用但没凭据的 bot：置 error 并给出可操作的文案，不起通道', async () => {
    const storage = new BotsStorage(base)
    await storage.writeConfig({ version: 1, bots: [bot()] })
    initImBots(fakeHost(base))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const snapshot = imBotsDiagnostics()
    expect(snapshot.running).toEqual([])
    const status = snapshot.statuses.find((item) => item.botId === 'bot1')
    expect(status?.state).toBe('error')
    expect(status?.message).toContain('扫码')
  })

  it('停用的 bot 状态是 disabled，不是 error', async () => {
    const storage = new BotsStorage(base)
    await storage.writeConfig({ version: 1, bots: [bot({ enabled: false })] })
    initImBots(fakeHost(base))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(imBotsDiagnostics().statuses.find((item) => item.botId === 'bot1')?.state).toBe('disabled')
  })

  it('落盘目录不可用时只放弃机器人，不拖累应用启动', async () => {
    // 把 im-bots 位置占成一个目录，storage 的写入就会失败
    await fs.mkdir(path.join(base, 'im-bots', 'bots-config.json'), { recursive: true })
    initImBots(fakeHost(base))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(imBotsDiagnostics().running).toEqual([])
    expect(handled.size).toBeGreaterThan(0)
  })
})

describe('配置驱动的通道同步', () => {
  it('没有初始化时 syncChannels 是安全的空操作', async () => {
    await expect(syncChannels()).resolves.toBeUndefined()
  })

  it('未配置任何 bot 时不产生通道，也不报错', async () => {
    initImBots(fakeHost(base))
    await syncChannels()
    expect(imBotsDiagnostics().running).toEqual([])
  })
})

/** 调一条已注册的 IPC handler（第一个参数是 Electron 的 event，管理面用不到） */
async function call(channel: keyof typeof BOTS_IPC_CHANNELS, ...args: unknown[]): Promise<any> {
  const name = BOTS_IPC_CHANNELS[channel]
  const handler = handled.get(name) as ((event: unknown, ...rest: unknown[]) => Promise<unknown>) | undefined
  if (!handler) throw new Error(`未注册 ${String(name)}`)
  return handler(null, ...args)
}

describe('bots:upsert 的主键语义', () => {
  it('不带 id 与带空串 id 都是新建，由主进程发号', async () => {
    initImBots(fakeHost(base))
    const created = await call('upsert', { provider: 'feishu', name: '飞书号', enabled: false })
    expect(created.ok).toBe(true)
    expect(created.data.id).toHaveLength(21)
    expect(created.data.credentialRef).toBe(`bot-feishu-${created.data.id}`)
    const blank = await call('upsert', { id: '   ', provider: 'feishu', name: '又一个', enabled: false })
    expect(blank.ok).toBe(true)
    expect(blank.data.id).not.toBe(created.data.id)
    const list = await call('list')
    expect(list).toHaveLength(2)
  })

  it('带一个不存在的 id 来「创建」被拒：否则调用方可以自选主键覆盖已有条目', async () => {
    initImBots(fakeHost(base))
    expect(await call('upsert', { id: 'ghost', provider: 'feishu', name: 'x', enabled: false })).toEqual({
      ok: false,
      error: 'no-such-bot',
    })
  })

  it('已存在的 bot 可以改名字 / 目录，但 credentialRef 与 provider 不动', async () => {
    const storage = new BotsStorage(base)
    await storage.writeConfig({ version: 1, bots: [bot()] })
    initImBots(fakeHost(base))
    const updated = await call('upsert', { id: 'bot1', provider: 'feishu', name: '改名', enabled: true })
    expect(updated).toEqual({ ok: false, error: 'provider-immutable' })
    const ok = await call('upsert', { id: 'bot1', provider: 'weixin', name: '改名', enabled: true, defaultWorkDir: 'D:/x' })
    expect(ok.ok).toBe(true)
    expect(ok.data.credentialRef).toBe('bot-weixin-bot1')
    expect(ok.data.defaultWorkDir).toBe('D:/x')
  })

  it('缺名字 / 渠道不认识的入参一律拒（strict schema 挡住界面漏字段而不是崩在主进程）', async () => {
    initImBots(fakeHost(base))
    expect(await call('upsert', { provider: 'feishu', enabled: true })).toEqual({ ok: false, error: 'invalid-bot-config' })
    // telegram 已是合法渠道（第二轮扩展）；真正不认识的渠道仍然要被 strict 拒掉
    expect(await call('upsert', { provider: 'dingtalk', name: 'x', enabled: true })).toEqual({
      ok: false,
      error: 'invalid-bot-config',
    })
    expect(await call('upsert', null)).toEqual({ ok: false, error: 'invalid-bot-config' })
  })
})

describe('bots:setCredential', () => {
  it('飞书凭据按结构校验后写入，列表侧 hasCredential 随之翻转', async () => {
    const storage = new BotsStorage(base)
    await storage.writeConfig({ version: 1, bots: [bot({ provider: 'feishu', credentialRef: credentialRefFor('feishu', 'bot1') })] })
    initImBots(fakeHost(base))
    expect((await call('list'))[0]?.hasCredential).toBe(false)
    const result = await call('setCredential', 'bot1', { appId: 'cli_x', appSecret: 'sec_y' })
    expect(result).toEqual({ ok: true })
    expect(credentials.get('bot-feishu-bot1')).toBe(JSON.stringify({ appId: 'cli_x', appSecret: 'sec_y' }))
    expect((await call('list'))[0]?.hasCredential).toBe(true)
  })

  it('两个字段必须一起给：半个凭据只会换来一个看不出原因的认证失败', async () => {
    const storage = new BotsStorage(base)
    await storage.writeConfig({ version: 1, bots: [bot({ provider: 'feishu', credentialRef: credentialRefFor('feishu', 'bot1') })] })
    initImBots(fakeHost(base))
    expect(await call('setCredential', 'bot1', { appId: 'cli_x' })).toEqual({ ok: false, error: 'invalid-credential' })
    expect(await call('setCredential', 'bot1', { appId: 'cli_x', appSecret: '' })).toEqual({
      ok: false,
      error: 'invalid-credential',
    })
    expect(await call('setCredential', 'bot1', { appId: 'cli_x', appSecret: 's', extra: 1 })).toEqual({
      ok: false,
      error: 'invalid-credential',
    })
    expect(credentials.has('bot-feishu-bot1')).toBe(false)
  })

  it('微信不接受手填凭据：token 只能来自扫码确认那一步', async () => {
    const storage = new BotsStorage(base)
    await storage.writeConfig({ version: 1, bots: [bot()] })
    initImBots(fakeHost(base))
    expect(await call('setCredential', 'bot1', { appId: 'a', appSecret: 'b' })).toEqual({
      ok: false,
      error: 'weixin-credential-via-qrcode-only',
    })
  })

  it('bot 不存在时不写任何凭据', async () => {
    initImBots(fakeHost(base))
    expect(await call('setCredential', 'ghost', { appId: 'a', appSecret: 'b' })).toEqual({ ok: false, error: 'no-such-bot' })
    expect(credentials.size).toBe(0)
  })
})

describe('bots:resetBot', () => {
  it('清掉上下文、绑定与待用码，保留配置与凭据', async () => {
    const storage = new BotsStorage(base)
    await storage.writeConfig({ version: 1, bots: [bot()] })
    await storage.patchContext(makeActorKey('bot1', 'weixin', 'u1'), { mode: 'task', activeSessionId: 's1' }, () => ({ mode: 'draft' }))
    await storage.addBinding({ actorKey: makeActorKey('bot1', 'weixin', 'u1'), botId: 'bot1', providerUserId: 'u1' })
    await storage.issueBindCode('bot1', 'ABC123')
    credentials.set('bot-weixin-bot1', JSON.stringify({ token: 't', baseUrl: 'https://x' }))
    initImBots(fakeHost(base))
    expect(await call('resetBot', 'bot1')).toEqual({ ok: true })
    const state = await storage.readState()
    expect(state.contexts).toHaveLength(0)
    expect(state.bindings).toHaveLength(0)
    expect(state.pendingBinds).toHaveLength(0)
    expect((await storage.readConfig()).bots).toHaveLength(1)
    expect((await call('list'))[0]?.hasCredential).toBe(true)
  })

  it('未知 id 回 no-such-bot', async () => {
    initImBots(fakeHost(base))
    expect(await call('resetBot', 'ghost')).toEqual({ ok: false, error: 'no-such-bot' })
  })
})

describe('id 与绑定码生成', () => {
  it('bot id 用 21 位 nanoid 字符集（与既有会话 id 同口径，长度够撞不上）', () => {
    for (let i = 0; i < 50; i++) {
      const id = makeId()
      expect(id).toHaveLength(21)
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    }
    expect(new Set(Array.from({ length: 500 }, () => makeId())).size).toBe(500)
  })

  it('绑定码剔除了手机上的形近字', () => {
    for (let i = 0; i < 200; i++) {
      const code = makeRandomBindCode()
      expect(code).toHaveLength(6)
      expect(code).not.toMatch(/[01OIL]/)
    }
  })

  it('默认工作目录与宿主回填的格式一致（home/clerkbox-work/YYYYMMDD-HHmmss）', () => {
    const dir = defaultWorkDirFor(new Date(2026, 9, 2, 9, 8, 7).getTime())
    expect(dir.replace(/\\/g, '/')).toMatch(/\/clerkbox-work\/20261002-090807$/)
    expect(dir.startsWith(os.homedir())).toBe(true)
  })
})
