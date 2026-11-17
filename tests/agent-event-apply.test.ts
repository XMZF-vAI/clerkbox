/**
 * 宿主事件应用侧（P4c）：验证"同一份语义"在实时、补发、整环回放三种投递来源下
 * 都只会得到一份界面状态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyAgentEvent } from '../src/lib/agent-event-apply'
import { useChatStore } from '../src/stores/chat-store'
import { useAgentRunsStore } from '../src/stores/agent-runs-store'
import { useGoalStore } from '../src/stores/goal-store'
import { useInteractiveStore } from '../src/stores/interactive-store'
import { agentClient } from '../src/lib/agent-client'
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
  useInteractiveStore.getState().cancelQuestion(sid)
  useChatStore.setState({
    sessions: [{ id: sid, title: '新会话', messages: [], createdAt: 1, updatedAt: 1 }],
    activeSessionId: sid,
    streamingSessionIds: new Set<string>(),
    compactingSessionIds: new Set<string>(),
    stoppingSessionIds: new Set<string>(),
    rewindingSessionIds: new Set<string>(),
    rewindRevisions: {},
    sessionStatus: {},
    sessionErrors: {},
    queuedMessages: {},
  })
  useAgentRunsStore.setState({ runsBySession: {} })
  useGoalStore.setState({ bySession: {} })
})

describe('host question receipts and reconnect replay', () => {
  const requested = { type: 'question.requested', sessionId: sid, requestId: 'question-ack', question: [{ id: 'q1', header: 'Choose', question: 'Choose', options: [{ label: 'A', description: '' }] }] } as const

  it('keeps the same card until the host acknowledges, then ignores historical replays', async () => {
    let accept!: (result: { ok: true }) => void
    const send = vi.spyOn(agentClient, 'send').mockImplementation(() => new Promise(resolve => { accept = resolve }))
    try {
      applyAgentEvent(requested as never)
      const card = useInteractiveStore.getState().pendingQuestions[sid]!
      const first = useInteractiveStore.getState().resolveQuestion(sid, card.id, { q1: ['A'] })
      const duplicate = useInteractiveStore.getState().resolveQuestion(sid, card.id, { q1: ['B'] })
      applyAgentEvent(requested as never) // Same request from a reconnect snapshot.
      expect(useInteractiveStore.getState().pendingQuestions[sid]).toBe(card)
      await Promise.resolve()
      expect(send).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledWith({ type: 'question.resolve', sessionId: sid, requestId: requested.requestId, payload: { q1: ['A'] } })
      accept({ ok: true })
      await Promise.all([first, duplicate])
      expect(useInteractiveStore.getState().pendingQuestions[sid]).toBeUndefined()
      applyAgentEvent(requested as never)
      expect(useInteractiveStore.getState().pendingQuestions[sid]).toBeUndefined()
    } finally { send.mockRestore(); applyAgentEvent({ type: 'run.completed', sessionId: sid, runId: 'r' }) }
  })

  it.each(['transport', 'rejected'])('keeps a %s failure retryable through a same-request snapshot', async failure => {
    const send = vi.spyOn(agentClient, 'send')
    if (failure === 'transport') send.mockRejectedValueOnce(new Error('remoteAccess.cloudDisconnected'))
    else send.mockResolvedValueOnce({ ok: false, error: 'remote-control-disabled' })
    send.mockResolvedValueOnce({ ok: true })
    try {
      applyAgentEvent(requested as never)
      const card = useInteractiveStore.getState().pendingQuestions[sid]!
      await expect(useInteractiveStore.getState().resolveQuestion(sid, card.id, { q1: ['A'] })).rejects.toThrow()
      expect(useInteractiveStore.getState().pendingQuestions[sid]).toBe(card)
      applyAgentEvent(requested as never)
      expect(useInteractiveStore.getState().pendingQuestions[sid]).toBe(card)
      await useInteractiveStore.getState().resolveQuestion(sid, card.id, { q1: ['A'] })
      expect(send).toHaveBeenCalledTimes(2)
      expect(useInteractiveStore.getState().pendingQuestions[sid]).toBeUndefined()
    } finally { send.mockRestore(); applyAgentEvent({ type: 'run.completed', sessionId: sid, runId: 'r' }) }
  })

  it('restores an unanswered request missing from local state instead of blocking it forever', () => {
    applyAgentEvent(requested as never)
    const card = useInteractiveStore.getState().pendingQuestions[sid]!
    useInteractiveStore.setState({ pendingQuestions: {} }) // A cleared local view before the reconnect snapshot.
    applyAgentEvent(requested as never)
    expect(useInteractiveStore.getState().pendingQuestions[sid]).toEqual(card)
    expect(useInteractiveStore.getState().pendingQuestions[sid]?.id).toBe(requested.requestId)
    useInteractiveStore.getState().cancelQuestion(sid)
  })

  it('settles only the matching request across devices and prevents replay reopening it', () => {
    applyAgentEvent(requested as never)
    applyAgentEvent({ type: 'question.settled', sessionId: sid, requestId: requested.requestId, timedOut: false })
    expect(useInteractiveStore.getState().pendingQuestions[sid]).toBeUndefined()
    applyAgentEvent(requested as never)
    expect(useInteractiveStore.getState().pendingQuestions[sid]).toBeUndefined()

    applyAgentEvent({ ...requested, requestId: 'next-question' } as never)
    applyAgentEvent({ type: 'question.settled', sessionId: sid, requestId: requested.requestId, timedOut: true })
    expect(useInteractiveStore.getState().pendingQuestions[sid]?.id).toBe('next-question')
    applyAgentEvent({ type: 'run.completed', sessionId: sid, runId: 'r' })
  })

  it('does not send a blank host answer during run cleanup or clear a newer question with a late receipt', async () => {
    let accept!: (result: { ok: true }) => void
    const send = vi.spyOn(agentClient, 'send').mockImplementation(() => new Promise(resolve => { accept = resolve }))
    try {
      applyAgentEvent(requested as never)
      const submission = useInteractiveStore.getState().resolveQuestion(sid, requested.requestId, { q1: ['A'] })
      await Promise.resolve()
      applyAgentEvent({ type: 'run.completed', sessionId: sid, runId: 'r' })
      applyAgentEvent({ ...requested, requestId: 'next-question' } as never)
      accept({ ok: true })
      await submission
      expect(send).toHaveBeenCalledOnce()
      expect(useInteractiveStore.getState().pendingQuestions[sid]?.id).toBe('next-question')
    } finally { send.mockRestore(); applyAgentEvent({ type: 'run.completed', sessionId: sid, runId: 'r' }) }
  })

  it('keeps renderer questions synchronous and resolves their original promise', async () => {
    const answer = useInteractiveStore.getState().requestQuestion(sid, [])
    const id = useInteractiveStore.getState().pendingQuestions[sid]!.id
    useInteractiveStore.getState().resolveQuestion(sid, id, { q1: ['local'] })
    expect(useInteractiveStore.getState().pendingQuestions[sid]).toBeUndefined()
    await expect(answer).resolves.toEqual({ q1: ['local'] })
  })
})

describe('运行态与消息回灌', () => {
  it('压缩态按来源会话隔离，重连后的权威空闲态可以清除旧状态', () => {
    applyAgentEvent({ type: 'compaction.status', sessionId: sid, compacting: true })
    expect(useChatStore.getState().compactingSessionIds.has(sid)).toBe(true)
    expect(useChatStore.getState().compactingSessionIds.has('another')).toBe(false)
    applyAgentEvent({ type: 'compaction.status', sessionId: sid, compacting: false })
    expect(useChatStore.getState().compactingSessionIds.has(sid)).toBe(false)
  })

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
  it('历史撤回的resync使旧DB读失效，清来源会话旧运行卡片但保留其它会话', () => {
    const reload = vi.spyOn(useChatStore.getState(), 'reloadSessionFromDb').mockResolvedValue(undefined)
    useAgentRunsStore.setState({ runsBySession: { [sid]: [run({ status: 'completed' })], other: [run({ id: 'other-run' })] } })
    useChatStore.getState().setSessionError(sid, '旧分支错误')
    try {
      applyAgentEvent({ type: 'resync', sessionId: sid, reason: 'rewind:conversation' })
      expect(useChatStore.getState().rewindRevisions[sid]).toBe(1)
      expect(useAgentRunsStore.getState().runsBySession[sid]).toBeUndefined()
      expect(useAgentRunsStore.getState().runsBySession.other).toHaveLength(1)
      expect(useChatStore.getState().sessionErrors[sid]).toBeUndefined()
      expect(reload).toHaveBeenCalledWith(sid)
      applyAgentEvent({ type: 'resync', sessionId: sid, reason: 'rewind:workspace' })
      expect(useChatStore.getState().rewindRevisions[sid]).toBe(1)
    } finally { reload.mockRestore() }
  })

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
