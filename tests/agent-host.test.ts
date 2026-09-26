import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionManager, resolveAgentHostMode } from '../electron/agent-host'
import type { ChatStore } from '../electron/db'
import type { AgentCommand } from '../src/agent-core/protocol'

/** 宿主只需这几个存储方法参与运行期写入/读取 */
function fakeStore(): ChatStore {
  return {
    kind: 'sqlite',
    getMessages: vi.fn(async () => []),
    getAllSessions: vi.fn(async () => []),
    addMessage: vi.fn(async () => undefined),
    updateMessage: vi.fn(async () => undefined),
    compactMessages: vi.fn(async () => undefined),
  } as unknown as ChatStore
}

const runCmd = (over: Partial<Extract<AgentCommand, { type: 'run' }>> = {}): AgentCommand =>
  ({ type: 'run', sessionId: 's1', content: 'hi', ...over }) as AgentCommand

describe('运行模式开关', () => {
  const original = process.env.CLERKBOX_AGENT_HOST
  afterEach(() => {
    if (original === undefined) delete process.env.CLERKBOX_AGENT_HOST
    else process.env.CLERKBOX_AGENT_HOST = original
  })

  it('P3~P5 默认 renderer，显式环境变量才切 main', () => {
    delete process.env.CLERKBOX_AGENT_HOST
    expect(resolveAgentHostMode()).toBe('renderer')
    process.env.CLERKBOX_AGENT_HOST = 'main'
    expect(resolveAgentHostMode()).toBe('main')
    process.env.CLERKBOX_AGENT_HOST = 'renderer'
    expect(resolveAgentHostMode()).toBe('renderer')
  })

  it('非法取值回落 renderer（回滚开关不能被手滑写坏）', () => {
    process.env.CLERKBOX_AGENT_HOST = 'MAIN-process'
    expect(resolveAgentHostMode()).toBe('renderer')
  })
})

describe('指令受理与守卫', () => {
  it('缺 settings 的 run 明确拒绝，而不是拿默认配置猜', async () => {
    const m = new AgentSessionManager(fakeStore())
    const r = await m.handleCommand(runCmd())
    expect(r).toEqual({ ok: false, error: 'run-command-missing-settings' })
    expect(m.inspect().find((s) => s.sessionId === 's1')?.hasRun).toBeFalsy()
  })

  it('未运行时 abort 与陈旧 requestId 回执都被拒绝', async () => {
    const m = new AgentSessionManager(fakeStore())
    expect(await m.handleCommand({ type: 'abort', sessionId: 's1' })).toEqual({ ok: false, error: 'no-run' })
    expect(await m.handleCommand({ type: 'permission.resolve', sessionId: 's1', requestId: 'ghost', approved: true }))
      .toEqual({ ok: false, error: 'stale-request' })
  })
})

describe('排队语义（运行中收到新消息不并发，按队列 FIFO）', () => {
  it('enqueue / remove 广播 queue.snapshot，内容为当前队列', async () => {
    const m = new AgentSessionManager(fakeStore())
    await m.handleCommand({
      type: 'queue.enqueue',
      sessionId: 's1',
      item: { id: 'q1', content: '第二条', queuedAt: 1 },
    })
    await m.handleCommand({
      type: 'queue.enqueue',
      sessionId: 's1',
      item: { id: 'q2', content: '第三条', queuedAt: 2 },
    })
    let snaps = m.peekRing('s1').filter((e) => e.type === 'queue.snapshot')
    expect(snaps.map((e) => (e as { items: unknown[] }).items)).toEqual([[expect.any(Object)], [expect.any(Object), expect.any(Object)]])
    expect(snaps.at(-1)).toMatchObject({ items: [{ id: 'q1' }, { id: 'q2' }] })

    await m.handleCommand({ type: 'queue.remove', sessionId: 's1', id: 'q1' })
    snaps = m.peekRing('s1').filter((e) => e.type === 'queue.snapshot')
    expect(snaps.at(-1)).toMatchObject({ items: [{ id: 'q2' }] })
  })

  it('无快照可复用时不发送队列（缺 settings 的守卫仍然生效）', async () => {
    const m = new AgentSessionManager(fakeStore())
    await m.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: 'q1', content: 'x', queuedAt: 1 } })
    await m.handleCommand({ type: 'queue.flush', sessionId: 's1' })
    expect(m.inspect().find((s) => s.sessionId === 's1')?.hasRun).toBeFalsy()
    expect(m.inspect().find((s) => s.sessionId === 's1')?.queued).toBe(1)
  })
  it('queue.flush 带 id 时把该条提到队首（「立即发送」不再只能发第一条）', async () => {
    const m = new AgentSessionManager(fakeStore())
    for (const id of ['q1', 'q2', 'q3']) {
      await m.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id, content: id, queuedAt: 1 } })
    }
    await m.handleCommand({ type: 'queue.flush', sessionId: 's1', id: 'q3' })
    const snaps = m.peekRing('s1').filter((e) => e.type === 'queue.snapshot')
    expect(snaps.at(-1)).toMatchObject({ items: [{ id: 'q3' }, { id: 'q1' }, { id: 'q2' }] })
  })
})

describe('事件环与 seq', () => {
  it('环形缓冲超出上限时发 resync，而不是悄悄丢事件', async () => {
    const m = new AgentSessionManager(fakeStore())
    // 每次 enqueue 广播一条 queue.snapshot：灌满 500 上限
    for (let i = 0; i < 520; i++) {
      await m.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: `q${i}`, content: '', queuedAt: i } })
    }
    const ring = m.peekRing('s1')
    expect(ring.length).toBeLessThanOrEqual(501)
    const resync = ring.find((e) => e.type === 'resync')
    expect(resync).toMatchObject({ sessionId: 's1', reason: 'ring-overflow' })
    const seqs = m.snapshot('s1', 0).lastSeq
    expect(seqs).toBeGreaterThan(500)
  })

  it('溢出后真事件仍在继续入环，resync 按合并窗口收束而不是每事件一次', async () => {
    const m = new AgentSessionManager(fakeStore())
    for (let i = 0; i < 600; i++) {
      await m.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: `q${i}`, content: '', queuedAt: i } })
    }
    const ring = m.peekRing('s1')
    expect(ring.filter((e) => e.type === 'queue.snapshot').length).toBeGreaterThan(400)
    expect(ring.filter((e) => e.type === 'resync').length).toBeLessThanOrEqual(2)
    // 回归点：旧实现把环裁到上限后只广播 resync、扣下触发事件，而下一帧又立刻「溢出」——
    // 于是一段长回答（约 20 事件/秒）里真事件再也不外发，渲染层只剩每秒一次整会话重拉。
    expect(ring[ring.length - 1]!.type).toBe('queue.snapshot')
  })

  it('snapshot 汇报在队队列与运行态，供重连恢复', async () => {
    const m = new AgentSessionManager(fakeStore())
    await m.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: 'q1', content: 'x', queuedAt: 1 } })
    const snap = m.snapshot(undefined, 0)
    expect(snap.queue.s1).toHaveLength(1)
    expect(snap.activeRuns).toEqual([])
    expect(snap.pendingPermissions).toEqual([])
    expect(snap.lastSeq).toBeGreaterThan(0)
  })

  it('dropSession 清空运行态，不给宿主留僵尸', async () => {
    const m = new AgentSessionManager(fakeStore())
    await m.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: 'q1', content: 'x', queuedAt: 1 } })
    expect(m.inspect()).toHaveLength(1)
    m.dropSession('s1')
    expect(m.inspect()).toHaveLength(0)
    expect(m.peekRing('s1')).toEqual([])
  })

  it('未知指令拒收', async () => {
    const m = new AgentSessionManager(fakeStore())
    const r = await m.handleCommand({ type: 'nope' } as unknown as AgentCommand)
    expect(r.ok).toBe(false)
  })
})
