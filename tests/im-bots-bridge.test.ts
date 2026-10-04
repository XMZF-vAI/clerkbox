import { describe, it, expect } from 'vitest'

import {
  OUTBOUND_CHUNK_CHARS,
  SessionBridge,
  collapseDefaultDir,
  effectiveWorkDir,
  normalizeDir,
  redactSecrets,
  splitMessage,
  type BridgeManagerPort,
  type BridgePorts,
  type BridgeSessionRow,
  type BridgeStorePort,
  type RunOutcome,
} from '../electron/im-bots/session-bridge'
import type { AgentEvent } from '../src/agent-core/protocol'
import type { SessionRow } from '../src/types/ipc'
import { NEW_SESSION_TITLE } from '../src/lib/chat-row'

/**
 * D2 会话桥验收：完成感知、忙时入队、冷启动缺配置、分段与脱敏。
 *
 * 全部走假端口（BridgePorts 本来就是注入面），不碰 electron 也不碰 sqlite。
 */

class FakeManager implements BridgeManagerPort {
  commands: Array<{ cmd: unknown; meta: { remote: boolean } }> = []
  busy = new Set<string>()
  queued = new Map<string, number>()
  /** 默认「桌面已经跑过一次、有一份可用配置」；单独有测例把它关掉 */
  settingsReady = true
  private listeners = new Set<(payload: { seq: number; event: AgentEvent }) => void>()
  private seq = 0

  async handleCommand(cmd: unknown, meta: { remote: boolean }): Promise<{ ok: boolean; error?: string }> {
    this.commands.push({ cmd, meta })
    const item = cmd as { type: string; sessionId: string }
    if (item.type === 'queue.enqueue') this.queued.set(item.sessionId, (this.queued.get(item.sessionId) ?? 0) + 1)
    return { ok: true }
  }

  inspectSession(sessionId: string) {
    const hasRun = this.busy.has(sessionId)
    return {
      status: (hasRun ? 'working' : 'idle') as 'working' | 'idle' | 'awaiting',
      queued: this.queued.get(sessionId) ?? 0,
      hasRun,
    }
  }

  hasLocalSettingsSnapshot(): boolean {
    return this.settingsReady
  }

  subscribeEvents(handler: (payload: { seq: number; event: AgentEvent }) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  emit(event: AgentEvent): void {
    this.seq += 1
    for (const listener of this.listeners) listener({ seq: this.seq, event })
  }
}

class FakeStore implements BridgeStorePort {
  sessions: SessionRow[] = []
  messages = new Map<string, Array<{ id: string; role: string; content: string; timestamp: number }>>()
  created: BridgeSessionRow[] = []

  async createSession(row: BridgeSessionRow): Promise<void> {
    this.created.push(row)
    this.sessions.push(row as SessionRow)
  }

  async getAllSessions(): Promise<SessionRow[]> {
    return this.sessions
  }

  async getMessages(sessionId: string) {
    return this.messages.get(sessionId) ?? []
  }
}

function makeBridge(clock = 1_700_000_000_000): { bridge: SessionBridge; manager: FakeManager; store: FakeStore } {
  const manager = new FakeManager()
  const store = new FakeStore()
  let seq = 0
  const ports: BridgePorts = {
    manager,
    store,
    makeId: () => `id-${(seq += 1)}`,
    defaultWorkDir: (now: number) => `C:/home/clerkbox-work/${now}`,
    now: () => clock,
    log: () => {},
  }
  return { bridge: new SessionBridge(ports), manager, store }
}

/** 收集回推意图 */
function collector(): { outcomes: RunOutcome[]; onOutcome: (outcome: RunOutcome) => void } {
  const outcomes: RunOutcome[] = []
  return { outcomes, onOutcome: (outcome) => void outcomes.push(outcome) }
}

describe('建会话', () => {
  it('行内容与渲染层同一口径：新会话标题 + 显式工作目录 + 兜底目录', async () => {
    const { bridge, store } = makeBridge()
    const result = await bridge.createSessionForActor('D:/repo-a')
    expect(result).toEqual({ sessionId: 'id-1', workDir: 'D:/repo-a' })
    expect(store.created[0]).toEqual({
      id: 'id-1',
      title: NEW_SESSION_TITLE,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      working_dir: 'D:/repo-a',
      // 规格 §4.1：default_work_dir 与 working_dir 同值。曾经这里填新生成的空目录，
      // 于是机器人开的会话在桌面上看起来像「还没选过目录」，选过一次就回不到绑定目录了
      default_work_dir: 'D:/repo-a',
    })
  })

  it('没给目录时两列都落兜底目录，绝不留空（空 working_dir 等于让 agent 在进程的 cwd 里干活）', async () => {
    const { bridge, store } = makeBridge()
    const result = await bridge.createSessionForActor(undefined)
    expect(result.workDir).toBe('C:/home/clerkbox-work/1700000000000')
    expect(store.created[0]?.working_dir).toBe('C:/home/clerkbox-work/1700000000000')
    expect(store.created[0]?.default_work_dir).toBe('C:/home/clerkbox-work/1700000000000')
  })
})

describe('下发运行', () => {
  it('空闲时发 run，且不携带任何凭据（settings 由宿主回退到本机快照）', async () => {
    const { bridge, manager } = makeBridge()
    const result = await bridge.dispatch('s1', 'actorA', '做点事')
    expect(result).toEqual({ ok: true })
    expect(manager.commands[0]).toEqual({
      cmd: { type: 'run', sessionId: 's1', content: '做点事' },
      meta: { remote: false },
    })
  })

  it('忙时走 queue.enqueue（复用宿主 FIFO 与渲染层排队 UI，不另写一套队列）', async () => {
    const { bridge, manager } = makeBridge()
    manager.busy.add('s1')
    const result = await bridge.dispatch('s1', 'actorA', '插一条')
    expect(result).toEqual({ ok: true })
    const cmd = manager.commands[0]?.cmd as { type: string; item: { content: string; id: string } }
    expect(cmd.type).toBe('queue.enqueue')
    expect(cmd.item.content).toBe('插一条')
  })

  it('桌面从未跑过对话时第一句就拒绝，不发必然失败的 run', async () => {
    const { bridge, manager } = makeBridge()
    manager.settingsReady = false
    const result = await bridge.dispatch('s1', 'actorA', '做点事')
    expect(result).toEqual({ ok: false, error: 'missing-settings' })
    expect(manager.commands).toHaveLength(0)
  })

  it('宿主回了缺设置同样如实上报（前置判空只是快路径，宿主才是权威）', async () => {
    const { bridge, manager } = makeBridge()
    manager.handleCommand = async () => ({ ok: false, error: 'run-command-missing-settings' })
    const result = await bridge.dispatch('s1', 'actorA', '做点事')
    expect(result).toEqual({ ok: false, error: 'missing-settings' })
  })
})

describe('完成感知', () => {
  /**
   * 锁住「不在终态清除关注」这条修正。
   * 旧实现在第一次 run.completed 就把整表清掉，于是忙时排队的那条被宿主 flushQueue
   * 跑完之后没人认领 —— 手机上看到的是「消息发出去了、第二件事永远没回音」。
   * 「还在不等这个会话」由上层按聊天上下文判定（/new、/task 切走、解绑才真的不看）。
   */
  it('run.completed 只推给登记过该会话的身份，且不因为推过一次就失明', async () => {
    const { bridge, manager } = makeBridge()
    const bag = collector()
    bridge.watchRuns(bag.onOutcome)
    bridge.watch('s1', 'actorA')
    manager.busy.add('s1')
    manager.emit({ type: 'run.completed', sessionId: 's1', runId: 'r1' })
    expect(bag.outcomes).toEqual([{ sessionId: 's1', kind: 'completed', actorKeys: ['actorA'] }])
    // 排队的第二条跑完，仍然要推给同一个人
    bag.outcomes.length = 0
    manager.emit({ type: 'run.completed', sessionId: 's1', runId: 'r2' })
    expect(bag.outcomes).toEqual([{ sessionId: 's1', kind: 'completed', actorKeys: ['actorA'] }])
    // 真正解绑要靠显式动作
    bridge.unwatch('s1', 'actorA')
    bag.outcomes.length = 0
    manager.emit({ type: 'run.completed', sessionId: 's1', runId: 'r3' })
    expect(bag.outcomes).toHaveLength(0)
  })

  it('中止回 aborted，不半成品当结果', async () => {
    const { bridge, manager } = makeBridge()
    const bag = collector()
    bridge.watchRuns(bag.onOutcome)
    bridge.watch('s1', 'actorA')
    manager.emit({ type: 'run.aborted', sessionId: 's1', runId: 'r1', byUser: true })
    expect(bag.outcomes[0]).toMatchObject({ kind: 'aborted', actorKeys: ['actorA'] })
  })

  /**
   * 规格里 §4.4 把 run.status(idle) 也列为收尾信号，实现上必须排除它：
   * setStatus 端口把 'idle' 当兜底分支，运行中途完全可能广播出 idle，
   * 信了就等于任务还在跑就往手机上推一份残缺「结果」。
   */
  it('运行中途的 run.status(idle) 不算收尾', async () => {
    const { bridge, manager } = makeBridge()
    const bag = collector()
    bridge.watchRuns(bag.onOutcome)
    bridge.watch('s1', 'actorA')
    manager.emit({ type: 'run.status', sessionId: 's1', status: 'idle' })
    manager.emit({ type: 'run.status', sessionId: 's1', status: 'working' })
    manager.emit({ type: 'queue.snapshot', sessionId: 's1', items: [] })
    manager.emit({ type: 'message.added', sessionId: 's1', message: { id: 'm', role: 'assistant', content: 'x', timestamp: 1 } })
    expect(bag.outcomes).toHaveLength(0)
    manager.emit({ type: 'run.completed', sessionId: 's1', runId: 'r1' })
    expect(bag.outcomes).toHaveLength(1)
  })

  it('等审批：同一条未决审批在重连回放时只催一次', async () => {
    const { bridge, manager } = makeBridge()
    const bag = collector()
    bridge.watchRuns(bag.onOutcome)
    bridge.watch('s1', 'actorA')
    const request: AgentEvent = {
      type: 'permission.requested',
      sessionId: 's1',
      requestId: 'q1',
      preview: 'rm -rf /',
      risk: 'dangerous',
      mode: 'manual',
    }
    manager.emit(request)
    manager.emit(request) // snapshot 回放会原样再发一遍
    expect(bag.outcomes.filter((item) => item.kind === 'awaiting')).toHaveLength(1)
    // 关注关系不能因为催过一次就被清掉：批完还要发结果
    manager.emit({ type: 'run.completed', sessionId: 's1', runId: 'r1' })
    expect(bag.outcomes[1]).toMatchObject({ kind: 'completed', actorKeys: ['actorA'] })
  })

  it('审批收尾后同一 requestId 再次出现仍会催（是新的一次挂起）', async () => {
    const { bridge, manager } = makeBridge()
    const bag = collector()
    bridge.watchRuns(bag.onOutcome)
    bridge.watch('s1', 'actorA')
    const request: AgentEvent = { type: 'permission.requested', sessionId: 's1', requestId: 'q1', preview: 'p', risk: 'normal', mode: 'manual' }
    manager.emit(request)
    manager.emit({ type: 'permission.settled', sessionId: 's1', requestId: 'q1', approved: false, timedOut: true })
    manager.emit(request)
    expect(bag.outcomes.filter((item) => item.kind === 'awaiting')).toHaveLength(2)
  })

  it('等审批时把 requestId / 预览原文 / 风险一起交给上层（手机上要照着它问「确定 / 拒绝」）', async () => {
    const { bridge, manager } = makeBridge()
    const bag = collector()
    bridge.watchRuns(bag.onOutcome)
    bridge.watch('s1', 'actorA')
    manager.emit({
      type: 'permission.requested',
      sessionId: 's1',
      requestId: 'q7',
      preview: 'rm -rf D:/repo/dist',
      risk: 'dangerous',
      mode: 'manual',
      tool: 'execute_command',
      workingDir: 'D:/repo',
    })
    expect(bag.outcomes[0]).toMatchObject({
      kind: 'awaiting',
      actorKeys: ['actorA'],
      approval: { requestId: 'q7', preview: 'rm -rf D:/repo/dist', risk: 'dangerous', tool: 'execute_command', workingDir: 'D:/repo' },
    })
  })

  it('其它会话的事件一律不看', async () => {
    const { bridge, manager } = makeBridge()
    const bag = collector()
    bridge.watchRuns(bag.onOutcome)
    bridge.watch('s1', 'actorA')
    manager.emit({ type: 'run.completed', sessionId: 's2', runId: 'r9' })
    expect(bag.outcomes).toHaveLength(0)
  })

  it('watch/unwatch 对称：解绑一个身份不影响同一会话上的另一个身份', async () => {
    const { bridge, manager } = makeBridge()
    const bag = collector()
    bridge.watchRuns(bag.onOutcome)
    bridge.watch('s1', 'actorA')
    bridge.watch('s1', 'actorB')
    bridge.unwatch('s1', 'actorA')
    manager.emit({ type: 'run.completed', sessionId: 's1', runId: 'r1' })
    expect(bag.outcomes[0]?.actorKeys).toEqual(['actorB'])
  })

  it('dispose 之后不再收事件（应用退出 / 全部 bot 停用）', async () => {
    const { bridge, manager } = makeBridge()
    const bag = collector()
    bridge.watchRuns(bag.onOutcome)
    bridge.watch('s1', 'actorA')
    bridge.dispose()
    manager.emit({ type: 'run.completed', sessionId: 's1', runId: 'r1' })
    expect(bag.outcomes).toHaveLength(0)
  })

  it('重复 watchRuns 只换回调，不把订阅叠成两层（叠了一条结果发两遍）', async () => {
    const { bridge, manager } = makeBridge()
    const first = collector()
    const second = collector()
    bridge.watchRuns(first.onOutcome)
    bridge.watchRuns(second.onOutcome)
    bridge.watch('s1', 'actorA')
    manager.emit({ type: 'run.completed', sessionId: 's1', runId: 'r1' })
    expect(first.outcomes).toHaveLength(0)
    expect(second.outcomes).toHaveLength(1)
  })
})

describe('取结果', () => {
  it('取尾部最近一条有正文的 assistant 消息', async () => {
    const { bridge, store } = makeBridge()
    store.messages.set('s1', [
      { id: '1', role: 'user', content: '问题', timestamp: 1 },
      { id: '2', role: 'assistant', content: '', timestamp: 2 }, // 工具轮次的空占位
      { id: '3', role: 'system', content: '审批留痕', timestamp: 3 },
      { id: '4', role: 'assistant', content: '第一版回答', timestamp: 4 },
      { id: '5', role: 'assistant', content: '   ', timestamp: 5 },
    ])
    expect(await bridge.latestAnswer('s1')).toBe('第一版回答')
  })

  it('整场没有 assistant 正文时回空串（由上层换成「本轮没有产出」）', async () => {
    const { bridge, store } = makeBridge()
    store.messages.set('s1', [{ id: '1', role: 'user', content: '问题', timestamp: 1 }])
    expect(await bridge.latestAnswer('s1')).toBe('')
  })
})

describe('会话清单', () => {
  function rows(): SessionRow[] {
    return [
      { id: 'a', title: '甲', created_at: 1, updated_at: 100, working_dir: 'D:/repo-a' },
      { id: 'b', title: '乙', created_at: 1, updated_at: 300, working_dir: 'd:/REPO-A' },
      { id: 'c', title: '丙', created_at: 1, updated_at: 200, working_dir: 'D:/repo-b' },
      { id: 'd', title: '丁', created_at: 1, updated_at: 400, working_dir: null },
    ] as unknown as SessionRow[]
  }

  it('按目录过滤 + 更新时间倒序，且分隔符与盘符大小写不算两个目录', async () => {
    const { bridge, store } = makeBridge()
    store.sessions = rows()
    const list = await bridge.recentSessionsIn('D:/repo-a', 10)
    expect(list.map((item) => item.id)).toEqual(['b', 'a'])
    expect(await bridge.recentSessionsIn('D:\\repo-a', 10)).toHaveLength(2)
  })

  it('distinct 目录按最近使用排序、跳过空目录、大小写不同的同一目录只留一份', async () => {
    const { bridge, store } = makeBridge()
    store.sessions = rows()
    // 更新时间序：d(400, 无目录) → b(300, 'd:/REPO-A') → c(200, 'D:/repo-b') → a(100, 'D:/repo-a')
    // b 与 a 归一是同一个目录，保留更晚那条的拼写；d 因为空目录被跳过
    expect(await bridge.distinctWorkDirs(10)).toEqual(['d:/REPO-A', 'D:/repo-b'])
    expect(await bridge.distinctWorkDirs(1)).toEqual(['d:/REPO-A'])
  })

  it('空标题回落到「新会话」而不是留白', async () => {
    const { bridge, store } = makeBridge()
    store.sessions = [{ id: 'a', title: '', created_at: 1, updated_at: 1, working_dir: 'D:/x' }] as unknown as SessionRow[]
    const list = await bridge.recentSessionsIn('D:/x', 10)
    expect(list[0]?.title).toBe(NEW_SESSION_TITLE)
  })

  it('findSession 区分「不存在」与「存在但没目录」', async () => {
    const { bridge, store } = makeBridge()
    store.sessions = rows()
    expect(await bridge.findSession('d')).toEqual({ id: 'd', title: '丁', workingDir: undefined })
    expect(await bridge.findSession('nope')).toBeNull()
  })
})

describe('忙闲与排队', () => {
  it('判据来自宿主 inspect，桥不自己数事件', () => {
    const { bridge, manager } = makeBridge()
    expect(bridge.isBusy('s1')).toBe(false)
    manager.busy.add('s1')
    manager.queued.set('s1', 3)
    expect(bridge.isBusy('s1')).toBe(true)
    expect(bridge.queuedCount('s1')).toBe(3)
  })
})

describe('出站清洗', () => {
  it('已知明文一律抹成 ***（agent 把配置读给用户看是最主要的泄漏路径）', () => {
    const { bridge } = makeBridge()
    bridge.setSecretsProvider(() => ['sk-secret-value-123', 'short'])
    const out = bridge.prepareOutbound('我的 Key 是 sk-secret-value-123，另外 short 是普通词')
    expect(out[0]).toContain('***')
    expect(out[0]).not.toContain('sk-secret-value-123')
    // 短于 8 位的串不能当密钥替换，否则正文会被啃穿
    expect(out[0]).toContain('short 是普通词')
  })

  it('常见密钥形态兜底（用户仓库里粘的 Key 被原样复述出来）', () => {
    const samples = [
      'token: ghp_abcdefghijklmnopqrstuvwxyz123456',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456789',
      'api_key = sk-abcdefghijklmnopqrstuvwxyz',
      'secret_1234567890abcdef',
    ]
    for (const sample of samples) {
      const redacted = redactSecrets(sample, [])
      expect(redacted, sample).not.toContain('ghp_abcdefghij')
      expect(redacted, sample).toMatch(/\*\*\*/)
    }
  })

  it('不传明文时只做形态兜底，不误伤普通正文', () => {
    const plain = '这段回答里有 token 估算、api_key 字段名，还有 Bearer 的说法，但没有真密钥'
    expect(redactSecrets(plain, [])).toBe(plain)
  })

  it('长文本在段落边界断开，不硬切句子', () => {
    const paragraph = '句子内容'.repeat(300) // 1200 字
    const text = [paragraph, paragraph, paragraph, paragraph].join('\n\n')
    const parts = splitMessage(text, OUTBOUND_CHUNK_CHARS)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(OUTBOUND_CHUNK_CHARS)
      expect(part.trim().length).toBeGreaterThan(0)
    }
    // 断点落在段落边界：每段都应当是完整的「句子内容」整数倍
    expect(parts[0]).toBe(paragraph + '\n\n' + paragraph)
  })

  it('没有换行可用的超长单段仍然要发出去（宁可硬切也不能丢）', () => {
    const long = 'A'.repeat(OUTBOUND_CHUNK_CHARS * 2 + 7)
    const parts = splitMessage(long, OUTBOUND_CHUNK_CHARS)
    expect(parts.join('')).toBe(long)
    expect(parts).toHaveLength(3)
  })

  it('空文本不产生空消息', () => {
    expect(splitMessage('', 100)).toEqual([])
    const { bridge } = makeBridge()
    expect(bridge.prepareOutbound('')).toEqual([])
  })

  it('分段上限就是规格里的 3500', () => {
    expect(OUTBOUND_CHUNK_CHARS).toBe(3500)
  })
})

describe('目录归一', () => {
  it('反斜杠、结尾斜杠、盘符大小写都不影响「同一个目录」', () => {
    expect(normalizeDir('D:\\repo\\')).toBe(normalizeDir('D:/repo'))
    expect(normalizeDir('d:/Repo')).toBe(normalizeDir('D:/Repo'))
    expect(normalizeDir('  /srv/app  ')).toBe('/srv/app')
    expect(normalizeDir('/')).toBe('/')
  })

  it('POSIX 路径不改大小写（区分大小写的文件系统上不能混）', () => {
    expect(normalizeDir('/srv/App')).toBe('/srv/App')
    expect(normalizeDir('/srv/app')).not.toBe(normalizeDir('/srv/App'))
  })

  it('根目录与「没有目录」必须是两个值', () => {
    expect(normalizeDir('/')).toBe('/')
    expect(normalizeDir('\\')).toBe('/')
    expect(normalizeDir('///')).toBe('/')
    expect(normalizeDir('')).toBe('')
    expect(normalizeDir('   ')).toBe('')
    expect(normalizeDir('/')).not.toBe(normalizeDir(''))
  })
})

/**
 * 真实库的分布逼出来的两条规则：
 * 1. 老会话只有 default_work_dir（真实分布 3:42）——生效目录必须回退，否则 /workspace
 *    /task 在老用户眼里「什么都没有」；
 * 2. 自动兜底目录是时间戳家族（clerkbox-work/<时间戳>），逐个列出来是噪声——
 *    折叠成共同根，/task 在根上按前缀整批捞。
 */
describe('生效目录与默认目录家族折叠', () => {
  const WIN_ROOT = 'C:\\Users\\u\\clerkbox-work'
  function legacyRows(): SessionRow[] {
    return [
      { id: 'o1', title: '老一', created_at: 1, updated_at: 500, working_dir: null, default_work_dir: WIN_ROOT + '\\20260824-225651' },
      { id: 'o2', title: '老二', created_at: 1, updated_at: 400, working_dir: null, default_work_dir: 'C:/Users/u/clerkbox-work/20260826-203110' },
      { id: 'n1', title: '新', created_at: 1, updated_at: 300, working_dir: 'D:/repo', default_work_dir: 'D:/repo' },
      { id: 'x1', title: '兄弟', created_at: 1, updated_at: 200, working_dir: 'D:/repository', default_work_dir: 'D:/repository' },
    ] as unknown as SessionRow[]
  }

  it('生效目录回退 default_work_dir；纯空还是空', () => {
    expect(effectiveWorkDir({ working_dir: 'D:/a', default_work_dir: 'D:/b' })).toBe('D:/a')
    expect(effectiveWorkDir({ working_dir: null, default_work_dir: 'D:/b' })).toBe('D:/b')
    expect(effectiveWorkDir({ working_dir: '  ', default_work_dir: '' })).toBe('')
  })

  it('时间戳兜底目录折叠成共同根，非时间戳目录原样保留', () => {
    expect(collapseDefaultDir(WIN_ROOT + '\\20260824-225651')).toBe(WIN_ROOT)
    expect(collapseDefaultDir('D:/repo')).toBe('D:/repo')
    expect(collapseDefaultDir('D:/repo/20261003-200317')).toBe('D:/repo')
  })

  it('distinct 清单里折叠根只出现一次，真实目录在前按最近使用排序', async () => {
    const { bridge, store } = makeBridge()
    store.sessions = legacyRows()
    expect(await bridge.distinctWorkDirs(10)).toEqual([WIN_ROOT, 'D:/repo', 'D:/repository'])
  })

  it('/task 在折叠根上按前缀整批捞出老会话，且不误伤兄弟目录', async () => {
    const { bridge, store } = makeBridge()
    store.sessions = legacyRows()
    const list = await bridge.recentSessionsIn(WIN_ROOT, 10)
    expect(list.map((item) => item.id)).toEqual(['o1', 'o2'])
    expect(await bridge.recentSessionsIn('D:/repo', 10).then((r) => r.map((i) => i.id))).toEqual(['n1'])
  })
})
