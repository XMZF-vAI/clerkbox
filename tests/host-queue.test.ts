import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ mode: 'renderer' as 'main' | 'renderer', sent: [] as unknown[] }))

vi.mock('../src/lib/agent-client', () => ({
  agentClient: {
    ensureMode: async () => h.mode,
    send: async (cmd: unknown) => {
      h.sent.push(cmd)
      return { ok: true }
    },
  },
}))

import { hostQueue } from '../src/lib/host-queue'

beforeEach(() => {
  h.sent.length = 0
  h.mode = 'renderer'
})

describe('hostQueue 排队三动作的宿主同步', () => {
  it('renderer 模式一条都不下发：本地路径的队列行为必须与迁移前一致', async () => {
    await hostQueue.enqueue('s1', { id: 'q1', content: 'x', queuedAt: 1 })
    await hostQueue.remove('s1', 'q1')
    await hostQueue.flush('s1', 'q1')
    expect(h.sent).toEqual([])
  })

  it('main 模式三个动作成对下发，flush 带上要插队的那条 id', async () => {
    h.mode = 'main'
    await hostQueue.enqueue('s1', { id: 'q1', content: 'x', queuedAt: 1 })
    await hostQueue.remove('s1', 'q1')
    await hostQueue.flush('s1', 'q2')
    expect(h.sent).toEqual([
      { type: 'queue.enqueue', sessionId: 's1', item: { id: 'q1', content: 'x', queuedAt: 1 } },
      { type: 'queue.remove', sessionId: 's1', id: 'q1' },
      { type: 'queue.flush', sessionId: 's1', id: 'q2' },
    ])
  })

  it('每条指令都先确认模式再下发（不能凭未解析的 null 当作 renderer 跳过同步）', async () => {
    h.mode = 'main'
    const client = await import('../src/lib/agent-client')
    const order: string[] = []
    vi.spyOn(client.agentClient, 'ensureMode').mockImplementation(async () => {
      order.push('mode')
      return h.mode
    })
    const sentBefore = h.sent.length
    await hostQueue.remove('s1', 'q1')
    expect(order).toEqual(['mode'])
    expect(h.sent).toHaveLength(sentBefore + 1)
    expect(h.sent[sentBefore]).toMatchObject({ type: 'queue.remove', sessionId: 's1', id: 'q1' })
    vi.restoreAllMocks()
  })
})
