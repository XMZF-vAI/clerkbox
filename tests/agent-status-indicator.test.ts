import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type { Message } from '../src/types/agent'

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refresh: vi.fn(),
}))

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useMemo: <T>(factory: () => T) => factory(),
  useState: <T>(initial: T) => [initial, h.refresh],
  useEffect: (effect: () => void | (() => void)) => { h.effects.push(effect) },
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: <T>(selector: T) => selector }))
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>()
  const create = <T>(initializer?: StateCreator<T>): unknown => {
    if (!initializer) return (next: StateCreator<T>) => create(next)
    const store = actual.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  }
  return { ...actual, create }
})

import AgentStatusIndicator, { formatAgentElapsed, resolveAgentPhase, useAgentActivity, type AgentActivity } from '../src/components/chat/AgentStatusIndicator'
import { useChatStore } from '../src/stores/chat-store'
import { usePermissionStore } from '../src/stores/permission-store'
import { useInteractiveStore } from '../src/stores/interactive-store'

const idle: AgentActivity = {
  active: false, compacting: false, stopping: false, awaitingPermission: false, awaitingQuestion: false, permissionRequestedAt: null,
}
const active = { ...idle, active: true }
const message = (over: Partial<Message> = {}): Message => ({
  id: 'assistant', role: 'assistant', content: '', timestamp: 1_000, _isStreaming: true, ...over,
})

beforeEach(() => {
  h.effects = []
  h.refresh.mockClear()
  useChatStore.setState({ compactingSessionIds: new Set(), stoppingSessionIds: new Set(), sessionStatus: {} })
  usePermissionStore.setState({ bySession: {}, localBySession: {} })
  useInteractiveStore.setState({ pendingQuestions: {} })
})

afterEach(() => vi.useRealTimers())

describe('真实会话状态优先', () => {
  it('压缩、停止、审批和提问按会话隔离，非流式压缩仍有活动状态', () => {
    useChatStore.getState().setCompacting('a', true)
    expect(useAgentActivity('a', false)).toMatchObject({ active: true, compacting: true })
    expect(useAgentActivity('b', false)).toEqual(idle)
    useChatStore.getState().setStopping('a', true)
    expect(resolveAgentPhase([message()], useAgentActivity('a', false)).key).toBe('chat.stopping')
    useChatStore.getState().setStopping('a', false)
    useChatStore.getState().setCompacting('a', false)
    useChatStore.getState().setSessionStatus('a', 'confirm-danger')
    expect(resolveAgentPhase([message()], useAgentActivity('a', true)).key).toBe('shell.waitingApproval')
    useChatStore.getState().setSessionStatus('a', null)
    useInteractiveStore.setState({ pendingQuestions: { a: { id: 'qa', sessionId: 'a', questions: [] } } })
    expect(resolveAgentPhase([message()], useAgentActivity('a', true)).key).toBe('shell.waitingAnswer')
    expect(useAgentActivity('b', false)).toEqual(idle)
  })

  it('宿主与本地审批都能显示等待，并使用真实请求时间', () => {
    usePermissionStore.setState({ localBySession: { a: [{ requestedAt: 2_000 } as never] } })
    expect(useAgentActivity('a', false)).toMatchObject({ active: true, awaitingPermission: true, permissionRequestedAt: 2_000 })
    usePermissionStore.setState({ bySession: { a: [{ requestedAt: 1_000 } as never] } })
    expect(resolveAgentPhase([message()], useAgentActivity('a', false))).toEqual({ key: 'shell.waitingApproval', startedAt: 1_000 })
  })

  it('停止和等待回答没有可靠起点时隐藏耗时，不沿用模型消息时间', () => {
    expect(resolveAgentPhase([message()], { ...active, stopping: true }).startedAt).toBeNull()
    expect(resolveAgentPhase([message()], { ...active, awaitingQuestion: true }).startedAt).toBeNull()
    expect(resolveAgentPhase([message()], { ...active, compacting: true }).startedAt).toBeNull()
    expect(resolveAgentPhase([message({ _isCompacting: true })], { ...active, compacting: true }).startedAt).toBe(1_000)
  })
})

describe('活动消息推断', () => {
  it('只用活动消息的时间，历史轮次的重试和流式标志不能污染新任务', () => {
    expect(resolveAgentPhase([message({ content: 'reply' })], active)).toEqual({ key: 'chat.agentResponding', startedAt: 1_000 })
    expect(resolveAgentPhase([message({ _retrying: { attempt: 2 } })], active)).toMatchObject({ key: 'chat.retrying', values: { attempt: 2 } })
    expect(resolveAgentPhase([message({ _retrying: { attempt: 2 } }), message({ id: 'next', role: 'user', _isStreaming: undefined, timestamp: 2_000 })], active))
      .toEqual({ key: 'chat.thinkingInProgress', startedAt: null })
    expect(resolveAgentPhase([message()], idle)).toEqual({ key: 'chat.agentWorking', startedAt: null })
  })

  it('工具结果按身份匹配，独立tool消息与乱序完成不误报仍在执行', () => {
    const tools = message({ _isStreaming: false, toolCalls: [
      { id: 'first', name: 'read_file', arguments: {} },
      { id: 'second', name: 'list_directory', arguments: {} },
    ] })
    const result = message({ role: 'tool', _isStreaming: false, toolResults: [{ toolCallId: 'second', content: 'ok' }] })
    expect(resolveAgentPhase([tools, result], active)).toMatchObject({ key: 'chat.agentExecuting', values: { name: 'read_file' } })
    const completed = message({ role: 'tool', _isStreaming: false, toolResults: [{ toolCallId: 'first', content: 'ok' }] })
    expect(resolveAgentPhase([tools, result, completed], active)).toEqual({ key: 'chat.thinkingInProgress', startedAt: null })
  })
})

describe('真实耗时与低频更新', () => {
  it('使用消息墙钟时间，重新挂载或切换会话不会从0累加', () => {
    expect(formatAgentElapsed(1_000, 10_900)).toBe('9s')
    expect(formatAgentElapsed(8_000, 10_900)).toBe('2s')
    expect(formatAgentElapsed(1_000, 126_000)).toBe('2m 5s')
    for (const invalid of [null, 0, Number.NaN, 11_000]) expect(formatAgentElapsed(invalid, 10_000)).toBeNull()
  })

  it('每秒刷新且卸载清理，不再每100ms唤醒两份指示器', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    AgentStatusIndicator({ messages: [message()], sessionId: 'a', activity: active })
    const cleanup = h.effects[0]()
    vi.advanceTimersByTime(999)
    expect(h.refresh).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.refresh).toHaveBeenCalledTimes(1)
    if (cleanup) cleanup()
    vi.advanceTimersByTime(2_000)
    expect(h.refresh).toHaveBeenCalledTimes(1)
  })

  it('没有可靠起点时不建立计时器', () => {
    vi.useFakeTimers()
    AgentStatusIndicator({ messages: [], sessionId: 'b', activity: active })
    expect(h.effects[0]()).toBeUndefined()
    vi.advanceTimersByTime(5_000)
    expect(h.refresh).not.toHaveBeenCalled()
  })
})
