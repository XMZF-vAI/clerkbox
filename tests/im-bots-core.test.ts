import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { BotsStorage } from '../electron/im-bots/storage'
import type { UserQuestion } from '../src/types/agent'
import {
  BotsCore,
  makeRandomBindCode,
  parseActorKey,
  parseApprovalAnswer,
  parseCommand,
  parseQuestionAnswer,
  pickFromList,
  type DeliverInput,
} from '../electron/im-bots/core'
import type { BridgeSessionRow, DispatchResult } from '../electron/im-bots/session-bridge'
import { credentialRefFor, makeActorKey, type BotConfig, type InboundMessage } from '../electron/im-bots/types'

/**
 * D2 路由验收：绑定门禁、命令解析、draft/task 状态机、忙时入队、结果回推。
 *
 * 桥用假实现（BridgeSurface 是 Pick 出来的公共面，不含私有成员，所以能替），
 * storage 用真实临时目录——落盘层与路由层之间的接缝正是最容易各写一套假设的地方。
 */

interface FakeSession {
  id: string
  title: string
  workingDir?: string
  updatedAt?: number
}

class FakeBridge {
  sessions = new Map<string, FakeSession>()
  /** sessionId → 是否正在跑（由用例显式摆，dispatch 不自动改：忙闲是被测语义的一部分） */
  busy = new Set<string>()
  queued = new Map<string, number>()
  dispatches: Array<{ sessionId: string; actorKey: string; content: string }> = []
  watches: Array<{ sessionId: string; actorKey: string; on: boolean }> = []
  answers = new Map<string, string>()
  /** 模拟「桌面一次对话都没发生过」：第一轮 run 必然被宿主挡下 */
  settingsReady = true
  workDirs: string[] = []
  created: BridgeSessionRow[] = []
  private seq = 0

  async createSessionForActor(workDir: string | undefined): Promise<{ sessionId: string; workDir: string }> {
    this.seq += 1
    const id = `s${this.seq}`
    const dir = workDir || 'D:/fallback'
    const row: BridgeSessionRow = {
      id,
      title: '新会话',
      created_at: Date.now(),
      updated_at: Date.now(),
      working_dir: dir,
    }
    this.created.push(row)
    this.sessions.set(id, { id, title: `会话 ${id}`, workingDir: dir, updatedAt: Date.now() })
    return { sessionId: id, workDir: dir }
  }

  async dispatch(sessionId: string, actorKey: string, content: string): Promise<DispatchResult> {
    if (!this.settingsReady) return { ok: false, error: 'missing-settings' }
    this.dispatches.push({ sessionId, actorKey, content })
    if (this.busy.has(sessionId)) this.queued.set(sessionId, (this.queued.get(sessionId) ?? 0) + 1)
    return { ok: true }
  }

  isBusy(sessionId: string): boolean {
    return this.busy.has(sessionId)
  }

  queuedCount(sessionId: string): number {
    return this.queued.get(sessionId) ?? 0
  }

  async findSession(sessionId: string): Promise<FakeSession | null> {
    return this.sessions.get(sessionId) ?? null
  }

  async recentSessionsIn(workDir: string, limit = 10): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    return [...this.sessions.values()]
      .filter((item) => item.workingDir === workDir)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit)
      .map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt ?? 0 }))
  }

  async distinctWorkDirs(): Promise<string[]> {
    return this.workDirs
  }

  async latestAnswer(sessionId: string): Promise<string> {
    return this.answers.get(sessionId) ?? ''
  }

  prepareOutbound(text: string): string[] {
    // 分段与脱敏本身在 session-bridge 的单测里验；这里只保留「可能拆多条」的形状
    return text ? [text] : []
  }

  watch(sessionId: string, actorKey: string): void {
    this.watches.push({ sessionId, actorKey, on: true })
  }

  unwatch(sessionId: string, actorKey: string): void {
    this.watches.push({ sessionId, actorKey, on: false })
  }

  unwatchSession(sessionId: string): void {
    this.watches.push({ sessionId, actorKey: '*', on: false })
  }
}

let base: string
let storage: BotsStorage
let bridge: FakeBridge
let core: BotsCore
let delivered: DeliverInput[]
/** 审批通道假件：记录续等待与答复，答复结果可编程 */
let approvals: {
  extended: Array<{ sessionId: string; requestId: string }>
  resolved: Array<{ sessionId: string; requestId: string; approved: boolean }>
  nextResult: { ok: boolean; error?: string }
}
/** 提问通道假件：记录送回答复与可编程结果 */
let questions: {
  resolved: Array<{ sessionId: string; requestId: string; answers: Record<string, string[]> }>
  nextResult: { ok: boolean; error?: string }
}

function makeApprovals() {
  return {
    extended: [] as Array<{ sessionId: string; requestId: string }>,
    resolved: [] as Array<{ sessionId: string; requestId: string; approved: boolean }>,
    nextResult: { ok: true } as { ok: boolean; error?: string },
  }
}

const BOT: BotConfig = {
  id: 'bot1',
  provider: 'weixin',
  name: '我的微信',
  enabled: true,
  credentialRef: credentialRefFor('weixin', 'bot1'),
  defaultWorkDir: 'D:/repo-a',
}

function actor(userId = 'u1'): InboundMessage['actor'] {
  return { botId: BOT.id, provider: BOT.provider, providerUserId: userId, chatType: 'private' }
}

function inbound(text: string, userId = 'u1', extra: Partial<InboundMessage> = {}): InboundMessage {
  return { actor: actor(userId), text, messageId: `m-${Math.random()}`, contextToken: 'CTX-1', ...extra }
}

function parseReplyLine(line: string): { key: string; vars?: Record<string, string | number> } {
  const at = line.indexOf(' ')
  return at < 0 ? { key: line } : { key: line.slice(0, at), vars: JSON.parse(line.slice(at + 1)) }
}

/** 最近一条出站消息的末行（/status 这类多行回复的末行才是状态） */
function lastReply(): { key: string; vars?: Record<string, string | number> } {
  const item = delivered[delivered.length - 1]
  if (!item) throw new Error('没有发出任何消息')
  return parseReplyLine(item.text.split('\n').pop() ?? '')
}

/** 最近一条出站消息的所有「文案行」（多行拼装的状态 / 清单，逐行解析 key 与变量） */
function lastReplyLines(): Array<{ key: string; vars?: Record<string, string | number> }> {
  const item = delivered[delivered.length - 1]
  if (!item) return []
  return item.text
    .split('\n')
    .filter((line) => line.startsWith('bots.'))
    .map(parseReplyLine)
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), `cb-core-${process.pid}-`))
  storage = new BotsStorage(base)
  await storage.ensureReady()
  await storage.writeConfig({ version: 1, bots: [BOT] })
  bridge = new FakeBridge()
  delivered = []
  approvals = makeApprovals()
  const ports: ConstructorParameters<typeof BotsCore>[0] = {
    storage,
    bridge: bridge as unknown as ConstructorParameters<typeof BotsCore>[0]['bridge'],
    deliver: async (input) => {
      delivered.push(input)
    },
    text: (key, vars) => (vars && Object.keys(vars).length > 0 ? `${key} ${JSON.stringify(vars)}` : key),
    makeBindCode: () => 'ABC123',
    now: () => Date.now(),
    log: () => {},
  }
  ports.approval = {
      extendWait: (sessionId, requestId) => {
        approvals.extended.push({ sessionId, requestId })
        return true
      },
      resolve: async (sessionId, requestId, approved) => {
        approvals.resolved.push({ sessionId, requestId, approved })
        return approvals.nextResult
      },
  }
  questions = { resolved: [], nextResult: { ok: true } }
  ports.question = {
    resolve: async (sessionId, requestId, answers) => {
      questions.resolved.push({ sessionId, requestId, answers })
      return questions.nextResult
    },
  }
  core = new BotsCore(ports)
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true }).catch(() => {})
})

/** 走完「桌面生成码 → IM 侧 /bind」的握手，返回可直接发消息的 actorKey */
async function bindMe(userId = 'u1'): Promise<string> {
  const issued = await core.generateBindCode(BOT.id)
  const key = makeActorKey(BOT.id, BOT.provider, userId)
  await core.handleInbound(inbound(`/bind ${issued?.code}`, userId))
  expect(await storage.isBound(key)).toBe(true)
  return key
}

describe('绑定门禁', () => {
  it('未绑定的私聊不响应任何内容，只回一句去桌面生成绑定码', async () => {
    await core.handleInbound(inbound('帮我改一下 README'))
    expect(bridge.dispatches).toHaveLength(0)
    expect(lastReply().key).toBe('bots.reply.notBound')
  })

  it('未绑定时发命令同样不响应（/status 不得泄露本机目录与会话标题）', async () => {
    await core.handleInbound(inbound('/status'))
    await core.handleInbound(inbound('/workspace'))
    await core.handleInbound(inbound('/task'))
    expect(delivered.every((item) => item.text.startsWith('bots.reply.notBound'))).toBe(true)
    expect(bridge.sessions.size).toBe(0)
  })

  it('/bind 正确码即建立绑定并回欢迎语与 draft 上下文', async () => {
    const issued = await core.generateBindCode(BOT.id)
    expect(issued).not.toBeNull()
    await core.handleInbound(inbound(`/bind ${issued?.code}`))
    const key = makeActorKey(BOT.id, BOT.provider, 'u1')
    expect(await storage.isBound(key)).toBe(true)
    expect(lastReply().key).toBe('bots.reply.welcome')
    expect(await storage.getContext(key)).toMatchObject({ mode: 'draft' })
  })

  it('绑定码单次有效：同一码第二次核销失败', async () => {
    const issued = await core.generateBindCode(BOT.id)
    await core.handleInbound(inbound(`/bind ${issued?.code}`))
    await core.handleInbound(inbound(`/bind ${issued?.code}`, 'u2'))
    expect(lastReply().key).toBe('bots.reply.bindCodeInvalid')
    expect(await storage.isBound(makeActorKey(BOT.id, BOT.provider, 'u2'))).toBe(false)
  })

  it('码可以小写发来（大小写不敏感），核销仍按同一份记录', async () => {
    const issued = await core.generateBindCode(BOT.id)
    await core.handleInbound(inbound(`/bind ${issued?.code.toLowerCase()}`))
    expect(await storage.isBound(makeActorKey(BOT.id, BOT.provider, 'u1'))).toBe(true)
  })

  it('过期码不可用', async () => {
    await storage.issueBindCode(BOT.id, 'EXP123', -1)
    await core.handleInbound(inbound('/bind EXP123'))
    expect(lastReply().key).toBe('bots.reply.bindCodeInvalid')
  })

  it('已绑定后再发 /bind 被拒绝，不会悄悄换掉绑定关系', async () => {
    await bindMe()
    const issued = await core.generateBindCode(BOT.id)
    await core.handleInbound(inbound(`/bind ${issued?.code}`))
    expect(lastReply().key).toBe('bots.reply.alreadyBound')
  })

  it('生成绑定码要求 bot 真实存在', async () => {
    expect(await core.generateBindCode('nope')).toBeNull()
  })

  it('随机绑定码是 6 位且不含形近字符（手机上抄码会抄错）', () => {
    for (let i = 0; i < 200; i++) {
      const code = makeRandomBindCode()
      expect(code).toHaveLength(6)
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
    }
  })
})

describe('命令解析', () => {
  it('表驱动：命令名、参数、大小写与多余空格', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help' })
    expect(parseCommand(' /HELP ')).toEqual({ name: 'help' })
    expect(parseCommand('/Bind   abc123  ')).toEqual({ name: 'bind', code: 'abc123' })
    expect(parseCommand('/workspace')).toEqual({ name: 'workspace', arg: undefined })
    expect(parseCommand('/workspace  D:/x  ')).toEqual({ name: 'workspace', arg: 'D:/x' })
    expect(parseCommand('/task 2')).toEqual({ name: 'task', arg: '2' })
    expect(parseCommand('/new')).toEqual({ name: 'new' })
    expect(parseCommand('/status')).toEqual({ name: 'status' })
  })

  it('非命令回 null，未知命令回 unknown', () => {
    expect(parseCommand('普通消息')).toBeNull()
    expect(parseCommand('')).toBeNull()
    expect(parseCommand('/nope')).toEqual({ name: 'unknown', raw: '/nope' })
    expect(parseCommand('/bind')).toEqual({ name: 'unknown', raw: '/bind' })
  })

  it('正文里出现 /new 不算命令（只看首 token）', async () => {
    await bindMe()
    await core.handleInbound(inbound('帮我看看 /new 目录'))
    expect(bridge.dispatches).toHaveLength(1)
    expect(lastReply().key).toBe('bots.reply.started')
  })

  it('未知命令回提示，不进会话', async () => {
    await bindMe()
    await core.handleInbound(inbound('/whatever'))
    expect(bridge.dispatches).toHaveLength(0)
    expect(lastReply()).toEqual({ key: 'bots.reply.unknownCommand', vars: { command: '/whatever' } })
  })
})

describe('draft / task 状态机', () => {
  it('draft 首条消息：建会话、下发 run、回标题并转 task 态', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('把 README 里的版本号改成 3.3'))
    expect(bridge.created).toHaveLength(1)
    expect(bridge.created[0]?.working_dir).toBe('D:/repo-a')
    expect(bridge.dispatches).toEqual([{ sessionId: 's1', actorKey: key, content: '把 README 里的版本号改成 3.3' }])
    expect(lastReply().key).toBe('bots.reply.started')
    expect(await storage.getContext(key)).toMatchObject({ mode: 'task', activeSessionId: 's1', workDir: 'D:/repo-a' })
  })

  it('入站消息的 context_token 落盘（否则跑完发不回微信）', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条', 'u1', { contextToken: 'CTX-9' }))
    expect((await storage.getContext(key))?.weixinContextToken).toBe('CTX-9')
  })

  it('task 且空闲：继续同一会话', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    delivered = []
    await core.handleInbound(inbound('第二条'))
    expect(bridge.dispatches).toHaveLength(2)
    expect(bridge.dispatches[1]?.sessionId).toBe('s1')
    expect(lastReply().key).toBe('bots.reply.running')
    expect((await storage.getContext(key))?.activeSessionId).toBe('s1')
  })

  it('task 且运行中：入队而不是拒收（与 ZCode 的差异化点）', async () => {
    await bindMe()
    await core.handleInbound(inbound('第一条'))
    bridge.busy.add('s1')
    delivered = []
    await core.handleInbound(inbound('插一条'))
    expect(bridge.dispatches).toHaveLength(2)
    expect(bridge.queued.get('s1')).toBe(1)
    expect(lastReply()).toEqual({ key: 'bots.reply.queued', vars: { position: 1 } })
    // 排队之后当前任务不变：不能因为插了一条就把上下文切走
    expect((await storage.getContext(makeActorKey(BOT.id, BOT.provider, 'u1')))?.activeSessionId).toBe('s1')
  })

  it('桌面从未初始化模型配置时，bot 明确回提示而不是发一条必然失败的 run', async () => {
    bridge.settingsReady = false
    await bindMe()
    await core.handleInbound(inbound('任何任务'))
    expect(lastReply().key).toBe('bots.reply.settingsMissing')
    expect(bridge.dispatches).toHaveLength(0)
  })

  it('task 态但会话已被桌面删除：退回 draft 另开新会话，而不是把这条消息丢掉', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    bridge.sessions.delete('s1')
    delivered = []
    await core.handleInbound(inbound('第二条'))
    expect(bridge.created).toHaveLength(2)
    expect(bridge.dispatches[1]?.sessionId).toBe('s2')
    expect((await storage.getContext(key))?.activeSessionId).toBe('s2')
  })

  it('两个绑定用户各走各的会话（同 bot 不同身份不串台）', async () => {
    await bindMe('u1')
    await bindMe('u2')
    await core.handleInbound(inbound('甲的任务', 'u1'))
    await core.handleInbound(inbound('乙的任务', 'u2'))
    const ctx1 = await storage.getContext(makeActorKey(BOT.id, BOT.provider, 'u1'))
    const ctx2 = await storage.getContext(makeActorKey(BOT.id, BOT.provider, 'u2'))
    expect(ctx1?.activeSessionId).not.toBe(ctx2?.activeSessionId)
    expect(bridge.dispatches.map((item) => item.actorKey)).toEqual([ctx1?.actorKey, ctx2?.actorKey])
  })

  /**
   * 并发入站是真实路径：飞书长连接会并发回调，微信一次 getupdates 也可能捎带多条。
   * 两条都读到 draft 态就会各建一个会话、各起一个 run——用户看到的是
   * 「我发了一句，它开了两个任务」。
   */
  it('同一身份的两条消息并发到达也只开一个会话', async () => {
    const key = await bindMe()
    await Promise.all([core.handleInbound(inbound('第一条')), core.handleInbound(inbound('第二条'))])
    expect(bridge.created).toHaveLength(1)
    expect(bridge.dispatches).toHaveLength(2)
    expect(bridge.dispatches.every((item) => item.sessionId === 's1')).toBe(true)
    expect((await storage.getContext(key))?.activeSessionId).toBe('s1')
  })

  it('不同身份并发不互相排队（串行化是按聊天身份，不是全局一把锁）', async () => {
    await bindMe('u1')
    await bindMe('u2')
    await Promise.all([core.handleInbound(inbound('甲的任务', 'u1')), core.handleInbound(inbound('乙的任务', 'u2'))])
    expect(bridge.created).toHaveLength(2)
    expect(bridge.dispatches).toHaveLength(2)
  })

  it('一条入站处理失败不会卡死该身份后续的入站', async () => {
    const key = await bindMe()
    const original = bridge.dispatch.bind(bridge)
    bridge.dispatch = async (sessionId: string, actorKey: string, content: string) => {
      if (content === '会炸') throw new Error('宿主不可用')
      return original(sessionId, actorKey, content)
    }
    // dispatch 抛异常不再向上传播：就地回滚 draft + 回复 runRejected，
    // 让用户知道这条没发出去，而不是静默吞掉（链的完整性由上一层的 catch 保证）
    await core.handleInbound(inbound('会炸'))
    expect(lastReply().key).toBe('bots.reply.runRejected')
    expect((await storage.getContext(key))?.mode).toBe('draft')
    const result = await core.handleInbound(inbound('正常的一条'))
    expect(result).toBeUndefined()
    expect(bridge.dispatches.some((item) => item.content === '正常的一条')).toBe(true)
    expect((await storage.getContext(key))?.mode).toBe('task')
  })
})

describe('/new', () => {
  it('draft 态再发 /new：仍然提示发消息开新会话', async () => {
    await bindMe()
    await core.handleInbound(inbound('/new'))
    expect(lastReply().key).toBe('bots.reply.newDraftHint')
  })

  it('task 且空闲 → 回 draft，并解除对旧会话的结果关注', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    delivered = []
    await core.handleInbound(inbound('/new'))
    expect(lastReply().key).toBe('bots.reply.newDraftHint')
    const after = await storage.getContext(key)
    expect(after?.mode).toBe('draft')
    // 指针必须真的清掉（不是留个空字符串）：否则下一条消息还会发回旧会话
    expect(after?.activeSessionId).toBeUndefined()
    expect(bridge.watches.some((item) => item.sessionId === 's1' && !item.on)).toBe(true)
    // 回 draft 后的下一条消息开的是新会话
    delivered = []
    await core.handleInbound(inbound('新任务'))
    expect(bridge.created).toHaveLength(2)
  })

  it('运行中拒绝（本期 IM 不提供停止命令）', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    bridge.busy.add('s1')
    delivered = []
    await core.handleInbound(inbound('/new'))
    expect(lastReply().key).toBe('bots.reply.newBlockedRunning')
    expect((await storage.getContext(key))?.mode).toBe('task')
  })
})

describe('/status', () => {
  it('draft 态：报工作目录与「还没有进行中的任务」', async () => {
    await bindMe()
    delivered = []
    await core.handleInbound(inbound('/status'))
    // 状态是多行拼装成的一条消息，逐行才是各项信息
    expect(delivered).toHaveLength(1)
    const lines = lastReplyLines()
    expect(lines.map((line) => line.key)).toEqual(['bots.reply.statusWorkDir', 'bots.reply.statusDraft'])
    expect(lines[0]?.vars).toEqual({ dir: 'D:/repo-a' })
  })

  it('task 且运行中：报会话标题、忙、排队数', async () => {
    await bindMe()
    await core.handleInbound(inbound('第一条'))
    bridge.busy.add('s1')
    await core.handleInbound(inbound('插一条'))
    delivered = []
    await core.handleInbound(inbound('/status'))
    const lines = lastReplyLines()
    expect(lines.map((line) => line.key)).toEqual([
      'bots.reply.statusWorkDir',
      'bots.reply.statusSession',
      'bots.reply.statusBusy',
    ])
    expect(lines[2]?.vars).toEqual({ queued: 1 })
  })

  it('task 但空闲：报 idle', async () => {
    await bindMe()
    await core.handleInbound(inbound('第一条'))
    delivered = []
    await core.handleInbound(inbound('/status'))
    expect(lastReply().key).toBe('bots.reply.statusIdle')
  })

  it('没有可用工作目录时直接说明，不报空目录', async () => {
    await storage.writeConfig({ version: 1, bots: [{ ...BOT, defaultWorkDir: undefined }] })
    await bindMe()
    delivered = []
    await core.handleInbound(inbound('/status'))
    expect(lastReply().key).toBe('bots.reply.statusNoWorkDir')
  })
})

describe('/workspace', () => {
  it('列出 bot 默认目录与最近会话目录，带序号且去重', async () => {
    bridge.workDirs = ['D:/repo-b', 'D:/repo-a']
    await bindMe()
    delivered = []
    await core.handleInbound(inbound('/workspace'))
    const text = delivered[0]?.text ?? ''
    // 默认目录排第一；D:/repo-a 同时来自默认值与历史，只能出现一次
    expect(text).toContain('1. D:/repo-a\n2. D:/repo-b')
    expect(text).toContain('bots.reply.pickNumberHint')
  })

  it('带参直接切换，不必先列一遍（draft 态）', async () => {
    bridge.workDirs = ['D:/repo-b']
    await bindMe()
    delivered = []
    // 清单恒为 [默认 D:/repo-a, D:/repo-b]，所以 2 才是 repo-b；
    // 这条同时锁住「/workspace 2」与「列完再回 2」等价——挂问是内存态，重启后不能失效
    await core.handleInbound(inbound('/workspace 2'))
    expect(lastReply()).toEqual({ key: 'bots.reply.workspaceSet', vars: { dir: 'D:/repo-b' } })
    expect((await storage.getContext(makeActorKey(BOT.id, BOT.provider, 'u1')))?.workDir).toBe('D:/repo-b')
  })

  it('列完清单后直接回数字即可选择', async () => {
    bridge.workDirs = ['D:/repo-b', 'D:/repo-c']
    await bindMe()
    await core.handleInbound(inbound('/workspace'))
    delivered = []
    await core.handleInbound(inbound('3'))
    expect(lastReply()).toEqual({ key: 'bots.reply.workspaceSet', vars: { dir: 'D:/repo-c' } })
  })

  it('直接给一个没列出来的路径也认（绑定后的对端与桌面用户同级）', async () => {
    await bindMe()
    delivered = []
    await core.handleInbound(inbound('/workspace D:/新仓库'))
    expect(lastReply()).toEqual({ key: 'bots.reply.workspaceSet', vars: { dir: 'D:/新仓库' } })
  })

  it('数字超出清单范围时不切，并提示重发', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('/workspace 7'))
    expect(lastReply().key).toBe('bots.reply.choiceInvalid')
    expect((await storage.getContext(key))?.workDir).toBeUndefined()
  })

  it('task 态不允许切目录（正在跑的东西不能被换到别的仓库里继续）', async () => {
    await bindMe()
    await core.handleInbound(inbound('第一条'))
    delivered = []
    await core.handleInbound(inbound('/workspace D:/other'))
    expect(lastReply().key).toBe('bots.reply.workspaceBusy')
  })

  it('一个候选目录都没有时给明确提示', async () => {
    await storage.writeConfig({ version: 1, bots: [{ ...BOT, defaultWorkDir: undefined }] })
    bridge.workDirs = []
    await bindMe()
    await core.handleInbound(inbound('/workspace'))
    expect(lastReply().key).toBe('bots.reply.workspaceEmpty')
  })

  it('挂问过期后裸数字不再被当成选择（回归普通消息）', async () => {
    let clock = Date.now()
    core = new BotsCore({
      storage,
      bridge: bridge as unknown as ConstructorParameters<typeof BotsCore>[0]['bridge'],
      deliver: async (input) => {
        delivered.push(input)
      },
      text: (key, vars) => (vars && Object.keys(vars).length > 0 ? `${key} ${JSON.stringify(vars)}` : key),
      makeBindCode: () => 'ABC123',
      now: () => clock,
      log: () => {},
    })
    await bindMe()
    await core.handleInbound(inbound('/workspace'))
    clock += 6 * 60_000
    delivered = []
    await core.handleInbound(inbound('1'))
    // 挂问过期后这条数字就是普通消息：开一个新会话把「1」当任务发出去
    expect(bridge.dispatches.length).toBeGreaterThan(0)
    expect(lastReply().key).toBe('bots.reply.started')
  })
})

describe('/task', () => {
  /** 造两个同目录会话：新的在前（清单按 updated_at 倒序，与侧栏同一个顺序） */
  function seedSessions(): void {
    bridge.sessions.set('s-old', { id: 's-old', title: '更早的会话', workingDir: 'D:/repo-a', updatedAt: 1000 })
    bridge.sessions.set('s-new', { id: 's-new', title: '最近的会话', workingDir: 'D:/repo-a', updatedAt: 2000 })
  }

  it('列出绑定目录下最近会话，序号按更新时间倒序', async () => {
    seedSessions()
    await bindMe()
    delivered = []
    await core.handleInbound(inbound('/task'))
    const text = delivered[0]?.text ?? ''
    expect(text).toContain('1. 最近的会话\n2. 更早的会话')
    expect(text).toContain('D:/repo-a')
  })

  it('回序号即切换当前任务并登记结果关注', async () => {
    const key = await bindMe()
    seedSessions()
    delivered = []
    await core.handleInbound(inbound('/task 2'))
    expect(lastReply().key).toBe('bots.reply.taskSet')
    expect((await storage.getContext(key))?.activeSessionId).toBe('s-old')
    expect(bridge.watches.some((item) => item.sessionId === 's-old' && item.on)).toBe(true)
    // 切过去之后，普通消息进的就是这个会话而不是新开的
    delivered = []
    await core.handleInbound(inbound('接着做'))
    expect(bridge.dispatches[0]).toMatchObject({ sessionId: 's-old', content: '接着做' })
    expect(lastReply().key).toBe('bots.reply.running')
  })

  it('列完清单后回裸数字同样生效', async () => {
    const key = await bindMe()
    seedSessions()
    await core.handleInbound(inbound('/task'))
    delivered = []
    await core.handleInbound(inbound('1'))
    expect((await storage.getContext(key))?.activeSessionId).toBe('s-new')
  })

  it('当前会话正在跑时不许切走（切了也没人收结果）', async () => {
    await bindMe()
    await core.handleInbound(inbound('第一条')) // 建出 s1 并作为当前任务
    bridge.busy.add('s1')
    seedSessions()
    delivered = []
    await core.handleInbound(inbound('/task 2'))
    expect(lastReply().key).toBe('bots.reply.taskBusy')
    expect((await storage.getContext(makeActorKey(BOT.id, BOT.provider, 'u1')))?.activeSessionId).toBe('s1')
  })

  it('目录下没有会话时说明清楚是哪个目录', async () => {
    await bindMe()
    delivered = []
    await core.handleInbound(inbound('/task'))
    expect(lastReply().key).toBe('bots.reply.taskEmpty')
    expect(lastReply().vars).toMatchObject({ dir: 'D:/repo-a' })
  })

  it('序号越界不切', async () => {
    const key = await bindMe()
    seedSessions()
    delivered = []
    await core.handleInbound(inbound('/task 9'))
    expect(lastReply().key).toBe('bots.reply.choiceInvalid')
    expect((await storage.getContext(key))?.activeSessionId).toBeUndefined()
  })

  /**
   * 带参命令每次重算清单，删掉的会话自然不在里面；
   * 但裸数字走的是上次清单留下的挂问——那才是 findSession 复核真正要挡的窗口：
   * 列完到回序号这几秒里，用户完全可能在桌面上把那条删了。
   */
  it('挂问里的会话在切之前被桌面删了：回提示而不是把上下文指向幽灵会话', async () => {
    const key = await bindMe()
    seedSessions()
    delivered = []
    await core.handleInbound(inbound('/task'))
    bridge.sessions.delete('s-new')
    delivered = []
    await core.handleInbound(inbound('1'))
    expect(lastReply().key).toBe('bots.reply.taskGone')
    expect((await storage.getContext(key))?.activeSessionId).toBeUndefined()
  })

  it('别的目录里的会话不会出现在清单里', async () => {
    bridge.sessions.set('s-other', { id: 's-other', title: '别的项目', workingDir: 'D:/repo-z', updatedAt: 3000 })
    await bindMe()
    delivered = []
    await core.handleInbound(inbound('/task'))
    expect(lastReply().key).toBe('bots.reply.taskEmpty')
  })

  it('没有工作目录时提示先选目录', async () => {
    await storage.writeConfig({ version: 1, bots: [{ ...BOT, defaultWorkDir: undefined }] })
    await bindMe()
    delivered = []
    await core.handleInbound(inbound('/task'))
    expect(lastReply().key).toBe('bots.reply.taskNoWorkDir')
  })
})

describe('结果回推', () => {
  it('run 完成：把最新答案分段发给正在等的聊天身份，并带回 context_token', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    bridge.answers.set('s1', '这是答案')
    delivered = []
    await core.handleOutcome({ sessionId: 's1', kind: 'completed', actorKeys: [key] })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.text).toBe('这是答案')
    expect(delivered[0]?.providerUserId).toBe('u1')
    expect(delivered[0]?.contextToken).toBe('CTX-1')
  })

  it('等待审批：只催一句「回电脑处理」', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    delivered = []
    await core.handleOutcome({ sessionId: 's1', kind: 'awaiting', actorKeys: [key] })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.text).toBe('bots.reply.approvalWaiting')
  })

  it('被中断：回一句中止提示而不是把半成品当答案发出去', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    bridge.answers.set('s1', '写到一半')
    delivered = []
    await core.handleOutcome({ sessionId: 's1', kind: 'aborted', actorKeys: [key] })
    expect(delivered[0]?.text).toBe('bots.reply.aborted')
  })

  it('空结果也要吭一声，不能让任务在手机上无声消失', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    delivered = []
    await core.handleOutcome({ sessionId: 's1', kind: 'completed', actorKeys: [key] })
    expect(delivered[0]?.text).toBe('bots.reply.emptyResult')
  })

  it('actorKey 被桌面重置（上下文没了）时静默丢弃，不抛给通道循环', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    await storage.resetContext(key)
    delivered = []
    await expect(core.handleOutcome({ sessionId: 's1', kind: 'completed', actorKeys: [key] })).resolves.toBeUndefined()
    expect(delivered).toHaveLength(0)
  })

  it('无人关注的会话（桌面自己跑的）不发任何消息', async () => {
    await core.handleOutcome({ sessionId: 's9', kind: 'completed', actorKeys: [] })
    expect(delivered).toHaveLength(0)
  })

  it('投递失败不得冒泡：通道正等在回调里，抛出去会打断整条链路', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    bridge.answers.set('s1', '答案')
    const failing = new BotsCore({
      storage,
      bridge: bridge as unknown as ConstructorParameters<typeof BotsCore>[0]['bridge'],
      deliver: async () => {
        throw new Error('网络断了')
      },
      text: (key2) => key2,
      makeBindCode: () => 'ABC123',
      now: () => Date.now(),
      log: () => {},
    })
    await expect(failing.handleOutcome({ sessionId: 's1', kind: 'completed', actorKeys: [key] })).resolves.toBeUndefined()
  })
})

describe('IM 内审批', () => {
  /** 走一遍「发消息 → 宿主挂起审批」，返回发出去的那条问句 */
  async function askApproval(sessionId = 's1', requestId = 'q1'): Promise<string> {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    delivered = []
    await core.handleOutcome({
      sessionId,
      kind: 'awaiting',
      approval: { requestId, preview: 'rm -rf D:/repo/dist', risk: 'dangerous', tool: 'execute_command' },
      actorKeys: [key],
    })
    return delivered[0]?.text ?? ''
  }

  it('问句里带要执行的原文、风险与答复方式', async () => {
    const text = await askApproval()
    expect(text).toContain('rm -rf D:/repo/dist')
    expect(text).toContain('bots.reply.approvalTool')
    expect(text).toContain('execute_command')
    expect(text).toContain('bots.reply.approvalAskTail')
    // 风险词单独成行，危险 / 常规在手机上要一眼分得开
    expect(text).toContain('bots.reply.approvalAskHead')
  })

  it('发问即续一次等待时间（120s 原表会把手机上已经同意的那步静默拒掉）', async () => {
    await askApproval()
    expect(approvals.extended).toEqual([{ sessionId: 's1', requestId: 'q1' }])
  })

  it('回复「确定」放行这一次，并回执一句已放行', async () => {
    await askApproval()
    delivered = []
    await core.handleInbound(inbound('确定'))
    expect(approvals.resolved).toEqual([{ sessionId: 's1', requestId: 'q1', approved: true }])
    expect(delivered[0]?.text).toBe('bots.reply.approvalApproved')
  })

  it('回复「拒绝」取消这一步', async () => {
    await askApproval()
    delivered = []
    await core.handleInbound(inbound('拒绝'))
    expect(approvals.resolved[0]?.approved).toBe(false)
    expect(delivered[0]?.text).toBe('bots.reply.approvalDenied')
  })

  it('答复只兑现一次：同一条审批不会被第二次「确定」重复放行', async () => {
    await askApproval()
    await core.handleInbound(inbound('确定'))
    delivered = []
    await core.handleInbound(inbound('确定'))
    expect(approvals.resolved).toHaveLength(1)
    // 第二句落到普通消息路径，成了给当前任务的新内容
    expect(bridge.dispatches).toHaveLength(2)
  })

  it('审批已经收尾时如实告知没有生效，而不是假装批准了', async () => {
    await askApproval()
    approvals.nextResult = { ok: false, error: 'stale-request' }
    delivered = []
    await core.handleInbound(inbound('确定'))
    expect(delivered[0]?.text).toBe('bots.reply.approvalStale')
  })

  it('一轮跑完后待批自动作废：之后的「确定」只是普通消息', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    await core.handleOutcome({
      sessionId: 's1',
      kind: 'awaiting',
      approval: { requestId: 'q1', preview: 'p', risk: 'normal' },
      actorKeys: [key],
    })
    await core.handleOutcome({ sessionId: 's1', kind: 'completed', actorKeys: [key] })
    approvals.resolved.length = 0
    delivered = []
    await core.handleInbound(inbound('确定'))
    expect(approvals.resolved).toHaveLength(0)
    expect(bridge.dispatches).toHaveLength(2)
  })

  it('没有审批通道时退回「请回电脑端处理」，不影响别的回复', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    // 换一个不带 approval 端口的 core：这是「通道还没接上」的形态（老配置 / 未来某渠道不支持）
    core = new BotsCore({
      storage,
      bridge: bridge as unknown as ConstructorParameters<typeof BotsCore>[0]['bridge'],
      deliver: async (input) => {
        delivered.push(input)
      },
      text: (k, vars) => (vars && Object.keys(vars).length > 0 ? `${k} ${JSON.stringify(vars)}` : k),
      makeBindCode: () => 'ABC123',
      now: () => Date.now(),
      log: () => {},
    })
    delivered = []
    await core.handleOutcome({
      sessionId: 's1',
      kind: 'awaiting',
      approval: { requestId: 'q1', preview: 'p', risk: 'dangerous' },
      actorKeys: [key],
    })
    expect(delivered[0]?.text).toBe('bots.reply.approvalWaiting')
    // 此时任何正文都不该被当成答复
    delivered = []
    await core.handleInbound(inbound('确定'))
    expect(approvals.resolved).toHaveLength(0)
    expect(bridge.dispatches).toHaveLength(2)
  })

  it('问句只发给正在等这个会话的人，未绑定与别人收不到', async () => {
    const key = await bindMe()
    await bindMe('u2')
    await core.handleInbound(inbound('第一条', 'u1')) // 只有 u1 的上下文指向 s1
    delivered = []
    await core.handleOutcome({
      sessionId: 's1',
      kind: 'awaiting',
      approval: { requestId: 'q1', preview: 'secret command', risk: 'dangerous' },
      actorKeys: [key, makeActorKey(BOT.id, BOT.provider, 'u2')],
    })
    // u2 的当前任务不是 s1（还在草稿态），推不到它手机上
    expect(delivered.map((item) => item.providerUserId)).toEqual(['u1'])
  })

  it('/new 回草稿之后，这个会话的后续结果不再推给手机', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    await core.handleInbound(inbound('/new'))
    delivered = []
    await core.handleOutcome({ sessionId: 's1', kind: 'completed', actorKeys: [key] })
    expect(delivered).toHaveLength(0)
    // 桥那边的关注关系也确实被解除，不会一直挂着
    expect(bridge.watches.some((item) => item.sessionId === 's1' && !item.on)).toBe(true)
  })

  it('排队的那条跑完照样回推（终态不再顺手清空关注）', async () => {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    bridge.busy.add('s1')
    await core.handleInbound(inbound('第二条'))
    bridge.busy.delete('s1')
    bridge.answers.set('s1', '第一件事的答案')
    await core.handleOutcome({ sessionId: 's1', kind: 'completed', actorKeys: [key] })
    delivered = []
    bridge.answers.set('s1', '第二件事的答案')
    await core.handleOutcome({ sessionId: 's1', kind: 'completed', actorKeys: [key] })
    expect(delivered[0]?.text).toBe('第二件事的答案')
  })

  it('表驱动：只有整句等于词表才算答复', () => {
    expect(parseApprovalAnswer('确定')).toBe('approve')
    expect(parseApprovalAnswer(' 确定 。')).toBe('approve')
    expect(parseApprovalAnswer('YES')).toBe('approve')
    expect(parseApprovalAnswer('ok')).toBe('approve')
    expect(parseApprovalAnswer('拒绝')).toBe('deny')
    expect(parseApprovalAnswer('不同意')).toBe('deny')
    expect(parseApprovalAnswer('no')).toBe('deny')
    // 包含匹配会替用户点头：这两句都含有肯定词
    expect(parseApprovalAnswer('我不确定这样对不对')).toBeNull()
    expect(parseApprovalAnswer('确定要删吗？')).toBeNull()
    expect(parseApprovalAnswer('继续跑')).toBeNull()
    expect(parseApprovalAnswer('')).toBeNull()
  })
})

describe('清单选择解析', () => {
  const options = ['D:/repo-a', 'D:/repo-b']
  it('序号从 1 起算，越界回 null', () => {
    expect(pickFromList(options, '1')).toBe('D:/repo-a')
    expect(pickFromList(options, ' 2 ')).toBe('D:/repo-b')
    expect(pickFromList(options, '3')).toBeNull()
    expect(pickFromList(options, '0')).toBeNull()
    expect(pickFromList([], '1')).toBeNull()
  })

  it('字面量优先命中清单里的同一项（忽略大小写），不在清单里也放行', () => {
    expect(pickFromList(options, 'd:/REPO-B')).toBe('D:/repo-b')
    // 绑定后的对端与桌面用户同级：桌面能选任意目录，手机上就该能直接给路径
    expect(pickFromList(options, 'D:/新仓库')).toBe('D:/新仓库')
    expect(pickFromList(options, 'D')).toBeNull() // 短于 2 位不成其为路径
  })
})

describe('IM 内答提问', () => {
  const oneQuestion: UserQuestion[] = [
    { id: 'q1', header: '分支', question: '要在哪个分支上做？', options: [{ label: 'main', description: '主干' }, { label: 'dev', description: '' }] },
  ]
  const twoQuestions: UserQuestion[] = [
    oneQuestion[0] as UserQuestion,
    { id: 'q2', header: '范围', question: '要一起提交吗？', options: [{ label: '是', description: '' }, { label: '否', description: '' }] },
  ]

  async function ask(items: typeof oneQuestion): Promise<string> {
    const key = await bindMe()
    await core.handleInbound(inbound('第一条'))
    delivered = []
    await core.handleOutcome({
      sessionId: 's1',
      kind: 'question',
      question: { requestId: 'qq1', items },
      actorKeys: [key],
    })
    return delivered[0]?.text ?? ''
  }

  it('单题：问句带序号选项，回一个序号就答上', async () => {
    const text = await ask(oneQuestion)
    expect(text).toContain('要在哪个分支上做？')
    expect(text).toContain('1) main')
    expect(text).toContain('questionAskTailSingle')
    delivered = []
    await core.handleInbound(inbound('2'))
    expect(questions.resolved[0]?.answers).toEqual({ q1: ['dev'] })
    expect(delivered[0]?.text).toBe('bots.reply.questionAnswered')
  })

  it('单题允许多选（逗号隔开）', async () => {
    await ask(oneQuestion)
    await core.handleInbound(inbound('1,2'))
    expect(questions.resolved[0]?.answers).toEqual({ q1: ['main', 'dev'] })
  })

  it('多题：按题序一位对一题', async () => {
    await ask(twoQuestions)
    await core.handleInbound(inbound('2 1'))
    expect(questions.resolved[0]?.answers).toEqual({ q1: ['dev'], q2: ['是'] })
  })

  it('多题但只答了一题时不硬答，把问题留着等重答', async () => {
    await ask(twoQuestions)
    delivered = []
    await core.handleInbound(inbound('1'))
    expect(questions.resolved).toHaveLength(0)
    expect(delivered[0]?.text).toBe('bots.reply.questionIncomplete')
    // 重答一次仍然有效
    await core.handleInbound(inbound('1 2'))
    expect(questions.resolved[0]?.answers).toEqual({ q1: ['main'], q2: ['否'] })
  })

  it('序号越界不静默吞掉：原样问回去', async () => {
    await ask(oneQuestion)
    delivered = []
    await core.handleInbound(inbound('9'))
    expect(questions.resolved).toHaveLength(0)
    expect(delivered[0]?.text).toContain('questionInvalid')
  })

  it('普通聊天内容不会被当成答复（只有纯序号才算）', async () => {
    await ask(oneQuestion)
    questions.resolved.length = 0
    delivered = []
    await core.handleInbound(inbound('第一个选项看着不错'))
    expect(questions.resolved).toHaveLength(0)
    // 这句话照常进当前任务
    expect(bridge.dispatches).toHaveLength(2)
  })

  it('问题已收尾时如实说明这次没生效', async () => {
    await ask(oneQuestion)
    questions.nextResult = { ok: false, error: 'stale-request' }
    delivered = []
    await core.handleInbound(inbound('1'))
    expect(delivered[0]?.text).toBe('bots.reply.questionStale')
  })

  it('答复优先于清单挂问：列完目录后回「2」先答问题，而不是选第 2 个目录', async () => {
    await ask(oneQuestion)
    // 清单第 2 项是 D:/repo-b；若答复没有优先命中，工作目录会被改成它
    bridge.workDirs = ['D:/repo-b']
    await core.handleInbound(inbound('/workspace'))
    await core.handleInbound(inbound('2'))
    expect(questions.resolved[0]?.answers).toEqual({ q1: ['dev'] })
    const ctx = await storage.getContext(makeActorKey(BOT.id, BOT.provider, 'u1'))
    expect(ctx?.workDir).toBe('D:/repo-a')
  })

  it('表驱动：哪些写法算序号答复', () => {
    expect(parseQuestionAnswer('1', 1)).toEqual([1])
    expect(parseQuestionAnswer(' 2 ', 1)).toEqual([2])
    expect(parseQuestionAnswer('1,2', 1)).toEqual([1, 2])
    expect(parseQuestionAnswer('1、2', 1)).toEqual([1, 2])
    expect(parseQuestionAnswer('1 2', 2)).toEqual([1, 2])
    // 多题时多余的序号是噪声，按题序截断
    expect(parseQuestionAnswer('1 2 3', 2)).toEqual([1, 2])
    expect(parseQuestionAnswer('第一个', 1)).toBeNull()
    expect(parseQuestionAnswer('', 1)).toBeNull()
    expect(parseQuestionAnswer('0', 1)).toBeNull()
  })
})

describe('actorKey 反解', () => {
  it('与 makeActorKey 互为逆操作', () => {
    const key = makeActorKey('bot-1', 'feishu', 'ou_abcDEF')
    expect(parseActorKey(key)).toEqual({ botId: 'bot-1', provider: 'feishu', providerUserId: 'ou_abcDEF', chatType: 'private' })
  })

  it('用户 id 里带冒号也能正确还原（微信的加密串理论上是 base64url）', () => {
    const key = makeActorKey('b', 'weixin', 'a:b:c')
    expect(parseActorKey(key)?.providerUserId).toBe('a:b:c')
  })

  it('结构不对或渠道不认识时回 null', () => {
    expect(parseActorKey('garbage')).toBeNull()
    expect(parseActorKey('b:telegram:u:private')).toBeNull()
    expect(parseActorKey(':weixin:u:private')).toBeNull()
    expect(parseActorKey('b:weixin::private')).toBeNull()
  })
})

