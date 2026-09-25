import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentClient, type AgentTransport } from '../src/lib/agent-client'
import type { AgentCommand, AgentEvent, AgentSnapshot } from '../src/agent-core/protocol'

const emptySnapshot: AgentSnapshot = { activeRuns: [], queue: {}, pendingPermissions: [], lastSeq: 0 }

/** 可编程传输：事件由测试手动投递，snapshot/command 记录调用参数 */
function fakeTransport(over: Partial<AgentTransport> = {}) {
  const calls: { snapshotSince: number[]; commands: AgentCommand[] } = { snapshotSince: [], commands: [] }
  let emit: ((p: { seq: number; event: AgentEvent }) => void) | null = null
  const transport: AgentTransport = {
    mode: async () => 'main',
    snapshot: async (_sid, sinceSeq) => {
      calls.snapshotSince.push(sinceSeq)
      return emptySnapshot
    },
    command: async (cmd) => {
      calls.commands.push(cmd)
      return { ok: true }
    },
    onEvent: (cb) => {
      emit = cb
      return () => {
        emit = null
      }
    },
    ...over,
  }
  return {
    transport,
    calls,
    push: (seq: number, event: AgentEvent = { type: 'run.started', sessionId: 's1', runId: 'r1', ts: 1 }) => emit?.({ seq, event }),
    subscribed: () => emit !== null,
  }
}

const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('模式判定', () => {
  it('renderer 模式不建订阅、不接管编排', async () => {
    const f = fakeTransport({ mode: async () => 'renderer' })
    const client = createAgentClient(f.transport)
    await expect(client.start()).resolves.toBe(false)
    expect(f.subscribed()).toBe(false)
    expect(client.getState()).toMatchObject({ mode: 'renderer', connection: 'offline' })
  })

  it('模式查询失败按 renderer 回落，不把界面悬空', async () => {
    const f = fakeTransport({ mode: async () => { throw new Error('no channel') } })
    const client = createAgentClient(f.transport)
    await expect(client.start()).resolves.toBe(false)
    expect(client.getState().connection).toBe('offline')
  })

  it('main 模式订阅事件并立即整环补发（lastSeq 从 0 起）', async () => {
    const f = fakeTransport()
    const client = createAgentClient(f.transport)
    await expect(client.start()).resolves.toBe(true)
    expect(f.subscribed()).toBe(true)
    expect(f.calls.snapshotSince).toEqual([0])
    expect(client.getState()).toMatchObject({ mode: 'main', connection: 'connected', lastSeq: 0 })
  })

  it('重复 start 幂等，不叠第二份订阅', async () => {
    const f = fakeTransport()
    const client = createAgentClient(f.transport)
    await client.start()
    await client.start()
    expect(f.calls.snapshotSince).toEqual([0])
  })
})

describe('事件按序、不重、不丢', () => {
  it('seq 回退或重复的事件不派发（回放与实时流必然重叠）', async () => {
    const f = fakeTransport()
    const client = createAgentClient(f.transport)
    await client.start()
    const seen: number[] = []
    client.subscribe((_e, seq) => seen.push(seq))
    f.push(1)
    f.push(1)
    f.push(0)
    f.push(2)
    expect(seen).toEqual([1, 2])
    expect(client.getState().lastSeq).toBe(2)
  })

  it('出现缺口即按已见位置请求补发', async () => {
    const f = fakeTransport()
    const client = createAgentClient(f.transport)
    await client.start()
    f.push(1)
    f.push(5) // 缺 2~4
    expect(f.calls.snapshotSince).toEqual([0, 1])
    expect(client.getState().lastSeq).toBe(5)
  })

  it('一个订阅方抛错不影响其余订阅方', async () => {
    const f = fakeTransport()
    const client = createAgentClient(f.transport)
    await client.start()
    const reached: string[] = []
    client.subscribe(() => { throw new Error('bad reducer') })
    client.subscribe(() => reached.push('second'))
    f.push(1)
    expect(reached).toEqual(['second'])
  })
})

describe('断线退避重连', () => {
  it('补发失败进入 reconnecting，按指数退避重试直至恢复', async () => {
    vi.useFakeTimers()
    let fail = true
    const states: string[] = []
    const f = fakeTransport({
      snapshot: async (_sid, sinceSeq) => {
        if (fail) throw new Error('host busy')
        return { ...emptySnapshot, lastSeq: sinceSeq }
      },
    })
    const client = createAgentClient(f.transport, { retryBaseMs: 10, retryMaxMs: 40 })
    client.onConnectionChange((s) => states.push(s))
    await client.start()
    expect(states).toContain('reconnecting')

    fail = false
    await tick(10) // 首次退避 = base * 2^0
    expect(client.getState().connection).toBe('connected')
    expect(states[states.length - 1]).toBe('connected')
  })

  it('退避增长有上限，持续失败也不会叠加多个定时器', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const f = fakeTransport({
      snapshot: async () => {
        attempts += 1
        throw new Error('down')
      },
    })
    const client = createAgentClient(f.transport, { retryBaseMs: 10, retryMaxMs: 30 })
    await client.start()
    // 先跑够多轮让指数增长触顶
    await tick(1_000)
    expect(client.getState().connection).toBe('reconnecting')
    const before = attempts
    await tick(300)
    const retries = attempts - before
    // 触顶后间隔应等于 retryMaxMs：300ms 窗口约 10 次，明显多说明没封顶
    expect(retries).toBeGreaterThan(0)
    expect(retries).toBeLessThanOrEqual(15)
  })
})

describe('指令与生命周期', () => {
  it('send 透传给传输层', async () => {
    const f = fakeTransport()
    const client = createAgentClient(f.transport)
    await client.start()
    await client.send({ type: 'abort', sessionId: 's1' })
    expect(f.calls.commands).toEqual([{ type: 'abort', sessionId: 's1' }])
  })

  it('stop 退订并清空模式，之后 start 可重新连接', async () => {
    const f = fakeTransport()
    const client = createAgentClient(f.transport)
    await client.start()
    client.stop()
    expect(f.subscribed()).toBe(false)
    expect(client.getState().mode).toBeNull()
    await client.start()
    expect(f.subscribed()).toBe(true)
  })

  it('取消订阅只摘掉自己那一份', async () => {
    const f = fakeTransport()
    const client = createAgentClient(f.transport)
    await client.start()
    const hits: number[] = []
    const off = client.subscribe((_e, seq) => hits.push(seq))
    client.subscribe((_e, seq) => hits.push(seq * 100))
    f.push(1)
    off()
    f.push(2)
    // seq=1 时两个订阅方都收到；off() 之后只剩第二个
    expect(hits).toEqual([1, 100, 200])
  })
})
