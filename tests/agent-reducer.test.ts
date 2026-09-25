import { describe, expect, it } from 'vitest'
import { planAgentEvent } from '../src/lib/agent-reducer'
import type { AgentEvent } from '../src/agent-core/protocol'
import type { Message } from '../src/types/agent'

const msg: Message = { id: 'm1', role: 'assistant', content: 'x', timestamp: 1 }

describe('运行态事件 → 流式与状态标记', () => {
  it('run.started 同时点亮 streaming 与 working，顺序不可颠倒', () => {
    expect(planAgentEvent({ type: 'run.started', sessionId: 's1', runId: 'r1', ts: 1 }).map((p) => p.kind))
      .toEqual(['set-streaming', 'set-status'])
  })

  it('run.completed / run.aborted 一律清状态并熄流（不留残余 spinner）', () => {
    for (const event of [
      { type: 'run.completed', sessionId: 's1', runId: 'r1' },
      { type: 'run.aborted', sessionId: 's1', runId: 'r1', byUser: true },
    ] as AgentEvent[]) {
      expect(planAgentEvent(event)).toEqual([
        { kind: 'set-status', sessionId: 's1', status: null },
        { kind: 'set-streaming', sessionId: 's1', on: false },
      ])
    }
  })

  it('run.status 三态映射：awaiting→confirm-danger，idle→清状态且熄流', () => {
    expect(planAgentEvent({ type: 'run.status', sessionId: 's1', status: 'awaiting' })).toEqual([
      { kind: 'set-streaming', sessionId: 's1', on: true },
      { kind: 'set-status', sessionId: 's1', status: 'confirm-danger' },
    ])
    expect(planAgentEvent({ type: 'run.status', sessionId: 's1', status: 'idle', error: 'boom' })).toEqual([
      { kind: 'set-streaming', sessionId: 's1', on: false },
      { kind: 'set-status', sessionId: 's1', status: null },
    ])
  })
})

describe('消息与流式增量', () => {
  it('message.added 走 upsert（F5 整环回放必然与 DB 已加载内容重叠）', () => {
    expect(planAgentEvent({ type: 'message.added', sessionId: 's1', message: msg })).toEqual([
      { kind: 'upsert-message', sessionId: 's1', message: msg },
    ])
  })

  it('stream.delta 原样透传，由应用侧负责拼接', () => {
    expect(planAgentEvent({ type: 'stream.delta', sessionId: 's1', messageId: 'm1', text: 'ab' })).toEqual([
      { kind: 'stream-delta', sessionId: 's1', messageId: 'm1', text: 'ab' },
    ])
  })

  it('stream.ended 与 tool.* 有意不产生补丁：消息内容已由 message.* 承载，再改就是双写', () => {
    expect(planAgentEvent({ type: 'stream.ended', sessionId: 's1', messageId: 'm1' })).toEqual([])
    expect(planAgentEvent({ type: 'tool.started', sessionId: 's1', messageId: 'm1', callId: 'c1', name: 'read_file', args: {} })).toEqual([])
    expect(planAgentEvent({ type: 'tool.finished', sessionId: 's1', callId: 'c1', result: 'ok', isError: false })).toEqual([])
  })
})

describe('审批与其余通道', () => {
  it('permission.requested 把会话置为危险确认态（C2 卡片靠它显示）', () => {
    expect(planAgentEvent({
      type: 'permission.requested',
      sessionId: 's1',
      requestId: 'p1',
      preview: 'rm -rf /',
      risk: 'dangerous',
      mode: 'manual',
    })).toEqual([{ kind: 'set-status', sessionId: 's1', status: 'confirm-danger' }])
  })

  it('question.requested 打开提问，resync 触发整会话重拉', () => {
    expect(planAgentEvent({ type: 'question.requested', sessionId: 's1', requestId: 'q1', question: [] })).toEqual([
      { kind: 'open-question', sessionId: 's1', requestId: 'q1', questions: [] },
    ])
    expect(planAgentEvent({ type: 'resync', sessionId: 's1', reason: 'ring-overflow' })).toEqual([
      { kind: 'reload-session', sessionId: 's1', reason: 'ring-overflow' },
    ])
  })

  it('goal/usage/todos/subagent 各归各位（usage 不能被塞进 goal 补丁）', () => {
    expect(planAgentEvent({ type: 'goal.updated', sessionId: 's1', goal: null })).toEqual([
      { kind: 'set-goal', sessionId: 's1', goal: null },
    ])
    const usage = { total: 10, budget: 100, autoCompactThreshold: 80, categories: [] }
    expect(planAgentEvent({ type: 'usage.updated', sessionId: 's1', usage })).toEqual([
      { kind: 'set-usage', sessionId: 's1', usage },
    ])
    expect(planAgentEvent({ type: 'todos.updated', sessionId: 's1', items: [] })).toEqual([
      { kind: 'set-todos', sessionId: 's1', items: [] },
    ])
  })

  it('未知/未来事件类型映射为空而不是抛错', () => {
    expect(planAgentEvent({ type: 'not-invented-yet', sessionId: 's1' } as unknown as AgentEvent)).toEqual([])
  })
})
