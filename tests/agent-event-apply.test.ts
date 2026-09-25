/**
 * 宿主事件应用侧（P4c）：验证"同一份语义"在实时、补发、整环回放三种投递来源下
 * 都只会得到一份界面状态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAgentEvent } from '../src/lib/agent-event-apply'
import { useChatStore } from '../src/stores/chat-store'
import { useAgentRunsStore } from '../src/stores/agent-runs-store'
import { useGoalStore } from '../src/stores/goal-store'
import type { Message, SubAgentRun } from '../src/types/agent'

const sid = 'sess-x'

const msg = (over: Partial<Message>): Message => ({
  id: 'm1',
  role: 'assistant',
  content: '',
  timestamp: 1,
  ...over,
})

const run = (over: Partial<SubAgentRun>): SubAgentRun => ({
  id: 'r1',
  agentType: 'researcher',
  agentName: '研究员',
  prompt: 'p',
  status: 'running',
  messages: [],
  startedAt: 1,
  ...over,
})

function session() {
  return useChatStore.getState().sessions.find((s) => s.id === sid)
}

beforeEach(() => {
  useChatStore.setState({
    sessions: [{ id: sid, title: '新会话', messages: [], createdAt: 1, updatedAt: 1 }],
    activeSessionId: sid,
    streamingSessionIds: new Set<string>(),
    sessionStatus: {},
    sessionErrors: {},
    queuedMessages: {},
  })
  useAgentRunsStore.setState({ runsBySession: {} })
  useGoalStore.setState({ bySession: {} })
})

describe('运行态与消息回灌', () => {
  it('run.started 点亮流式与工作状态，并清掉上一轮错误串', () => {
    useChatStore.getState().setSessionError(sid, '上一轮炸了')
    applyAgentEvent({ type: 'run.started', sessionId: sid, runId: 'r', ts: 1 })
    expect(useChatStore.getState().streamingSessionIds.has(sid)).toBe(true)
    expect(useChatStore.getState().sessionStatus[sid]).toBe('working')
    expect(useChatStore.getState().sessionErrors[sid]).toBeUndefined()
  })

  it('run.status 带 error 时写入 store，供宿主模式下的错误横幅消费', () => {
    applyAgentEvent({ type: 'run.status', sessionId: sid, status: 'idle', error: '断网了' })
    expect(useChatStore.getState().sessionErrors[sid]).toBe('断网了')
    expect(useChatStore.getState().streamingSessionIds.has(sid)).toBe(false)
  })

  it('message.added 重复投递只留一条（整环回放与本地已加载必然重叠）', () => {
    applyAgentEvent({ type: 'message.added', sessionId: sid, message: msg({ id: 'a1', content: '第一版' }) })
    applyAgentEvent({ type: 'message.added', sessionId: sid, message: msg({ id: 'a1', content: '第二版' }) })
    const messages = session()?.messages ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('第二版')
  })

  it('stream.delta 逐段拼接，message.updated 覆盖字段', () => {
    applyAgentEvent({ type: 'message.added', sessionId: sid, message: msg({ id: 'a1', _isStreaming: true }) })
    applyAgentEvent({ type: 'stream.delta', sessionId: sid, messageId: 'a1', text: '你好' })
    applyAgentEvent({ type: 'stream.delta', sessionId: sid, messageId: 'a1', text: '，世界' })
    expect(session()?.messages[0].content).toBe('你好，世界')
    applyAgentEvent({ type: 'message.updated', sessionId: sid, messageId: 'a1', updates: { finishReason: 'stop' } })
    expect(session()?.messages[0].finishReason).toBe('stop')
    expect(session()?.messages[0].content).toBe('你好，世界')
  })

  it('首条用户消息按同一规则改会话标题', () => {
    applyAgentEvent({ type: 'message.added', sessionId: sid, message: msg({ id: 'u1', role: 'user', content: '帮我写个方案' }) })
    expect(session()?.title).toBe('帮我写个方案')
  })
})

describe('其余通道', () => {
  it('permission.requested 置危险确认态——宿主模式下 C2 卡片就靠它显示', () => {
    applyAgentEvent({
      type: 'permission.requested',
      sessionId: sid,
      requestId: 'p1',
      preview: 'rm -rf /',
      risk: 'dangerous',
      mode: 'manual',
    })
    expect(useChatStore.getState().sessionStatus[sid]).toBe('confirm-danger')
  })

  it('queue.snapshot 整段替换本地队列', () => {
    applyAgentEvent({
      type: 'queue.snapshot',
      sessionId: sid,
      items: [{ id: 'q1', content: 'x', queuedAt: 1 }],
    })
    expect(useChatStore.getState().queuedMessages[sid]).toHaveLength(1)
    applyAgentEvent({ type: 'queue.snapshot', sessionId: sid, items: [] })
    expect(useChatStore.getState().queuedMessages[sid]).toHaveLength(0)
  })

  it('subagent.updated 同 id 覆盖不叠卡片', () => {
    applyAgentEvent({ type: 'subagent.updated', sessionId: sid, run: run({ status: 'running' }) })
    applyAgentEvent({ type: 'subagent.updated', sessionId: sid, run: run({ status: 'completed', result: 'ok' }) })
    const runs = useAgentRunsStore.getState().runsBySession[sid] ?? []
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('completed')
  })

  it('goal.updated 为 null 时清除目标状态条', () => {
    useGoalStore.getState().setGoal(sid, '做完它')
    applyAgentEvent({ type: 'goal.updated', sessionId: sid, goal: null })
    expect(useGoalStore.getState().bySession[sid]).toBeUndefined()
  })

  it('resync 触发整会话按 DB 重拉，且不许走「流式会话保留本地」的 syncFromDb', async () => {
    // 回归点：宿主模式下运行中的会话必然在 streamingSessionIds 里，而 syncFromDb 对这类
    // 会话刻意跳过合并——等于在最需要重拉的时刻空转，长回答溢出后界面再也回不来。
    useChatStore.getState().setStreaming(true, sid)
    const reload = vi.spyOn(useChatStore.getState(), 'reloadSessionFromDb').mockResolvedValue(undefined)
    const sync = vi.spyOn(useChatStore.getState(), 'syncFromDb').mockResolvedValue(undefined)
    applyAgentEvent({ type: 'resync', sessionId: sid, reason: 'ring-overflow' })
    expect(reload).toHaveBeenCalledWith(sid)
    expect(sync).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('reloadSessionFromDb 用 DB 覆盖本地消息，流式会话也不例外', async () => {
    const { ipc } = await import('../src/lib/ipc-client')
    vi.spyOn(ipc, 'dbGetMessages').mockResolvedValue([
      { id: 'db1', session_id: sid, role: 'user', content: 'DB 里的', timestamp: 5 },
    ] as never)
    vi.spyOn(ipc, 'dbGetAllSessions').mockResolvedValue([
      { id: sid, title: '新会话', created_at: 1, updated_at: 9, harness_mode: 'code' },
    ] as never)
    useChatStore.getState().remoteUpsertMessage(sid, msg({ id: 'local-only', content: '本地才有' }))
    useChatStore.getState().setStreaming(true, sid)
    await useChatStore.getState().reloadSessionFromDb(sid)
    expect(session()?.messages.map((m) => m.id)).toEqual(['db1'])
    vi.restoreAllMocks()
  })
})
