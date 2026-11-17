import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommandResult } from '../src/agent-core/protocol'
import type { CompactionResult } from '../src/types/agent'
import type { StateCreator } from 'zustand'

// 本组检查动作与 store 的真实协作，跳过与动作无关的 React DOM 挂载和订阅。
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const hooks = {
    useCallback: <T>(callback: T) => callback,
    useRef: <T>(current: T) => ({ current }),
    useEffect: () => undefined,
    useDebugValue: () => undefined,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  }
  return { ...actual, ...hooks, default: { ...actual, ...hooks } }
})
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

const h = vi.hoisted(() => ({
  mode: 'renderer' as 'main' | 'renderer',
  ensureMode: vi.fn<() => Promise<'main' | 'renderer'>>(),
  command: vi.fn<() => Promise<AgentCommandResult>>(async () => ({ ok: true })),
  resync: vi.fn(async () => undefined),
  compact: vi.fn<() => Promise<CompactionResult>>(),
  loop: vi.fn(async () => new Promise<void>(() => undefined)),
  cancelCommands: vi.fn(async () => undefined),
  id: 0,
}))

vi.mock('../src/lib/agent-client', () => ({
  agentClient: {
    ensureMode: h.ensureMode,
    getState: () => ({ mode: h.mode }),
    send: h.command,
    resync: h.resync,
  },
}))
vi.mock('../src/lib/ipc-client', () => ({
  isWebUIMode: false,
  ipc: new Proxy({
    cancelSessionCommands: h.cancelCommands,
    platform: () => 'win32',
    homeDir: () => '/test',
    kvGet: async () => null,
    kvPatch: async ({ value }: { value: string | null }) => ({ value }),
  }, { get: (target, key) => Reflect.get(target, key) ?? (async () => undefined) }),
}))
vi.mock('../src/lib/compact', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/compact')>(),
  compactConversation: h.compact,
}))
vi.mock('../src/agent-core/loop', () => ({ makeId: () => `test-${++h.id}`, runReactLoop: h.loop }))
vi.mock('../src/lib/tool-registry', () => ({ toolRegistry: { setAgentActionCapabilities: () => undefined } }))
vi.mock('../src/lib/notify', () => ({ notifyIfNotViewing: () => undefined }))

import { useAgent } from '../src/hooks/use-agent'
import { getSessionAbortController, setSessionAbortController, useChatStore } from '../src/stores/chat-store'
import { useSettingsStore } from '../src/stores/settings-store'
import i18n from '../src/i18n'

const item = { id: 'q1', content: 'queued text', queuedAt: 1 }

beforeEach(async () => {
  await Promise.resolve()
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout })
  h.mode = 'renderer'
  h.ensureMode.mockReset().mockImplementation(async () => h.mode)
  h.command.mockReset().mockResolvedValue({ ok: true })
  h.compact.mockReset().mockImplementation(() => new Promise(() => undefined))
  h.resync.mockReset().mockResolvedValue(undefined)
  h.loop.mockReset().mockImplementation(async () => new Promise<void>(() => undefined))
  h.cancelCommands.mockClear()
  setSessionAbortController('a', null)
  setSessionAbortController('b', null)
  useSettingsStore.setState({ baseUrl: '', apiKey: '', providers: [] })
  useChatStore.setState({
    sessions: ['a', 'b'].map((id) => ({
      id, title: id, createdAt: 1, updatedAt: 1,
      messages: [{ id: `m-${id}`, role: 'user', content: 'history', timestamp: 1 }],
    })),
    activeSessionId: 'a',
    queuedMessages: { a: [item] },
    streamingSessionIds: new Set(),
    compactingSessionIds: new Set(),
    stoppingSessionIds: new Set(),
    rewindingSessionIds: new Set(),
    rewindRevisions: {},
    drafts: {},
    draftSubmitting: {},
    sessionErrors: {},
    sessionStatus: {},
  })
})

afterEach(() => {
  setSessionAbortController('a', null)
  setSessionAbortController('b', null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('普通发送的受理与执行结果', () => {
  it('宿主明确拒绝时保留原消息和错误，不执行渲染层循环', async () => {
    h.mode = 'main'
    h.command.mockResolvedValue({ ok: false, error: 'run-command-missing-settings' })
    await expect(useAgent('a').sendMessage('new prompt')).resolves.toBe(false)
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(1)
    expect(useChatStore.getState().sessionErrors.a).toBe(i18n.t('agent.hostNeedsLocalRun'))
    expect(h.loop).not.toHaveBeenCalled()
    expect(h.command).toHaveBeenCalledTimes(1)
  })

  it('宿主 ACK 丢失只读同步并保留明确提示，不重发或把消息回队', async () => {
    h.mode = 'main'
    h.command.mockRejectedValue(new Error('lost ack'))
    h.resync.mockImplementation(async () => {
      useChatStore.getState().setStreaming(true, 'a')
      useChatStore.getState().setSessionError('a', undefined)
    })
    await expect(useAgent('a').sendMessage('new prompt')).resolves.toBe(false)
    expect(h.command).toHaveBeenCalledTimes(1)
    expect(h.resync).toHaveBeenCalledTimes(1)
    expect(h.resync).toHaveBeenCalledWith('a')
    expect(useChatStore.getState().sessionErrors.a).toBe(i18n.t('agent.commandUnknown'))
    expect(useChatStore.getState().sessionErrors.b).toBeUndefined()
    expect(useChatStore.getState().streamingSessionIds.has('a')).toBe(true)
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
    expect(h.loop).not.toHaveBeenCalled()
  })

  it('本地执行失败仍是已受理，用户消息只落一次并暂停后续队列', async () => {
    useSettingsStore.setState({ baseUrl: 'http://localhost:11434/v1', model: 'test' })
    h.loop.mockRejectedValueOnce(new Error('generation failed'))
    await expect(useAgent('a').sendMessage('new prompt')).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    const session = useChatStore.getState().sessions.find((current) => current.id === 'a')
    expect(session?.messages.filter((message) => message.role === 'user' && message.content === 'new prompt')).toHaveLength(1)
    expect(session?.messages.at(-1)?.content).toContain('generation failed')
    expect(useChatStore.getState().sessionErrors.a).toBe('generation failed')
    expect(useChatStore.getState().streamingSessionIds.has('a')).toBe(false)
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
    expect(h.loop).toHaveBeenCalledTimes(1)
  })
})

describe('排队消息立即发送', () => {
  it('缺少模型配置导致发送未受理时，排队项保留', async () => {
    await expect(useAgent('a').sendQueuedNow(item)).resolves.toBe(false)
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(1)
  })

  it('真实受理后才移除排队项，并且只发给原会话', async () => {
    useSettingsStore.setState({ baseUrl: 'http://localhost:11434/v1', model: 'test' })
    const agent = useAgent('a')
    useChatStore.getState().setActiveSession('b')
    await expect(agent.sendQueuedNow(item)).resolves.toBe(true)
    expect(useChatStore.getState().queuedMessages.a).toEqual([])
    expect(useChatStore.getState().sessions.find((s) => s.id === 'a')?.messages.at(-1)?.content).toBe(item.content)
    expect(useChatStore.getState().sessions.find((s) => s.id === 'b')?.messages).toHaveLength(1)
  })

  it('宿主立即发送回执未知时不本地移除，也不重新下发 run', async () => {
    h.mode = 'main'
    h.command.mockRejectedValue(new Error('lost ack'))
    await expect(useAgent('a').sendQueuedNow(item)).resolves.toBe(false)
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
    expect(h.command).toHaveBeenCalledTimes(1)
    expect(h.resync).toHaveBeenCalledWith('a')
  })

  it('旧控制器迟迟未释放时超时保留排队项，并确实取消会话命令', async () => {
    useSettingsStore.setState({ baseUrl: 'http://localhost:11434/v1', model: 'test' })
    const ctrl = new AbortController()
    setSessionAbortController('a', ctrl)
    const sending = useAgent('a').sendQueuedNow(item)
    await vi.advanceTimersByTimeAsync(5100)
    await expect(sending).resolves.toBe(false)
    expect(ctrl.signal.aborted).toBe(true)
    expect(h.cancelCommands).toHaveBeenCalledWith('a')
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
  })
})

describe('压缩受理与隔离', () => {
  it('受理压缩立即返回，A 会话压缩不阻塞 B 会话', async () => {
    useSettingsStore.setState({ baseUrl: 'http://localhost:11434/v1', model: 'test' })
    const agentA = useAgent('a')
    await expect(agentA.manualCompact('保留任务')).resolves.toBe(true)
    expect(useChatStore.getState().compactingSessionIds.has('a')).toBe(true)
    const agentB = useAgent('b')
    expect(agentB.isCompacting).toBe(false)
    await expect(agentB.sendMessage('B continues')).resolves.toBe(true)
    await expect(agentA.manualCompact()).resolves.toBe(false)
  })

  it('配置缺失或宿主明确拒绝时返回未受理', async () => {
    await expect(useAgent('a').manualCompact('do not lose')).resolves.toBe(false)
    expect(useChatStore.getState().compactingSessionIds.size).toBe(0)
    h.mode = 'main'
    h.command.mockResolvedValue({ ok: false, error: 'compaction-busy' })
    await expect(useAgent('a').manualCompact()).resolves.toBe(false)
    expect(useChatStore.getState().sessionErrors.a).toBeTruthy()
  })

  it('压缩失败释放来源会话状态，并将占位更新为可见失败', async () => {
    useSettingsStore.setState({ baseUrl: 'http://localhost:11434/v1', model: 'test' })
    useChatStore.setState({ queuedMessages: {} })
    useChatStore.getState().setCompacting('b', true)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.compact.mockRejectedValueOnce(new Error('network failed'))
    await expect(useAgent('a').manualCompact()).resolves.toBe(true)
    await Promise.resolve()
    expect(useChatStore.getState().compactingSessionIds.has('a')).toBe(false)
    expect(useChatStore.getState().compactingSessionIds.has('b')).toBe(true)
    const message = useChatStore.getState().sessions.find((s) => s.id === 'a')?.messages.at(-1)
    expect(message?._isCompacting).toBe(false)
    expect(message?.content).toBeTruthy()
    log.mockRestore()
  })
})

describe('停止受理反馈', () => {
  it('宿主拒绝时保留真实运行态，在来源会话提示并只读对账', async () => {
    h.mode = 'main'
    h.command.mockResolvedValue({ ok: false, error: 'no-run' })
    useChatStore.getState().setStreaming(true, 'a')
    await expect(useAgent('a').abort()).resolves.toBe(false)
    expect(useChatStore.getState().streamingSessionIds.has('a')).toBe(true)
    expect(useChatStore.getState().sessionErrors.a).toBeTruthy()
    expect(useChatStore.getState().sessionErrors.b).toBeUndefined()
    expect(h.resync).toHaveBeenCalledWith('a')
    expect(useChatStore.getState().stoppingSessionIds.size).toBe(0)
  })

  it('本地停止会中止原控制器并清理该会话命令', async () => {
    const ctrl = new AbortController()
    setSessionAbortController('a', ctrl)
    await expect(useAgent('a').abort()).resolves.toBe(true)
    expect(ctrl.signal.aborted).toBe(true)
    expect(getSessionAbortController('a')).toBe(ctrl)
    expect(h.cancelCommands).toHaveBeenCalledWith('a')
  })
})

describe('消息撤回期间的运行入口隔离', () => {
  it.each(['renderer', 'main'] as const)('%s：撤回占锁时发送、压缩、立即发送都不受理，保留草稿和队列', async (mode) => {
    h.mode = mode
    useSettingsStore.setState({ baseUrl: 'http://localhost:11434/v1', model: 'test' })
    useChatStore.getState().updateDraft('a', { content: '不能丢的草稿', taskMode: 'plan' })
    const draft = useChatStore.getState().drafts.a
    const messages = useChatStore.getState().sessions[0].messages
    const agent = useAgent('a')
    useChatStore.getState().setRewinding('a', true)

    await expect(agent.sendMessage('new prompt')).resolves.toBe(false)
    await expect(agent.manualCompact('保留任务')).resolves.toBe(false)
    await expect(agent.sendQueuedNow(item)).resolves.toBe(false)

    expect(h.ensureMode).not.toHaveBeenCalled()
    expect(h.command).not.toHaveBeenCalled()
    expect(h.loop).not.toHaveBeenCalled()
    expect(h.compact).not.toHaveBeenCalled()
    expect(h.cancelCommands).not.toHaveBeenCalled()
    expect(useChatStore.getState().drafts.a).toBe(draft)
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
    expect(useChatStore.getState().sessions[0].messages).toBe(messages)
    expect(useChatStore.getState().streamingSessionIds.size).toBe(0)
    expect(useChatStore.getState().compactingSessionIds.size).toBe(0)
    expect(getSessionAbortController('a')).toBeUndefined()
  })

  it.each([
    ['renderer', 'send'], ['main', 'send'],
    ['renderer', 'compact'], ['main', 'compact'],
    ['renderer', 'queue'], ['main', 'queue'],
  ] as const)('%s：%s 等待模式查询期间开始撤回，查询返回后仍拒绝执行', async (mode, action) => {
    h.mode = mode
    useSettingsStore.setState({ baseUrl: 'http://localhost:11434/v1', model: 'test' })
    useChatStore.getState().updateDraft('a', { content: '异步查询期间的草稿', taskMode: 'plan' })
    const draft = useChatStore.getState().drafts.a
    let resolveMode!: (mode: 'renderer' | 'main') => void
    h.ensureMode.mockImplementationOnce(() => new Promise((resolve) => { resolveMode = resolve }))
    const agent = useAgent('a')
    const pending = action === 'send' ? agent.sendMessage('new prompt')
      : action === 'compact' ? agent.manualCompact('保留任务')
      : agent.sendQueuedNow(item)
    expect(h.ensureMode).toHaveBeenCalledTimes(1)
    expect(h.command).not.toHaveBeenCalled()
    useChatStore.getState().setRewinding('a', true)
    resolveMode(mode)

    await expect(pending).resolves.toBe(false)
    expect(h.command).not.toHaveBeenCalled()
    expect(h.loop).not.toHaveBeenCalled()
    expect(h.compact).not.toHaveBeenCalled()
    expect(h.cancelCommands).not.toHaveBeenCalled()
    expect(useChatStore.getState().drafts.a).toBe(draft)
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(1)
    expect(getSessionAbortController('a')).toBeUndefined()
  })

  it('已调度的本地队列自动发送遇到撤回锁时连出队都不进行，解锁后可正常受理', async () => {
    useSettingsStore.setState({ baseUrl: 'http://localhost:11434/v1', model: 'test' })
    useChatStore.getState().updateDraft('a', { content: '当前草稿' })
    const draft = useChatStore.getState().drafts.a
    const agent = useAgent('a')
    const dequeue = vi.fn(useChatStore.getState().dequeueQueuedMessage)
    const originalDequeue = useChatStore.getState().dequeueQueuedMessage
    useChatStore.setState({ dequeueQueuedMessage: dequeue })
    try {
      agent.requestQueuedFlush()
      useChatStore.getState().setRewinding('a', true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(dequeue).not.toHaveBeenCalled()
      expect(h.ensureMode).not.toHaveBeenCalled()
      expect(h.command).not.toHaveBeenCalled()
      expect(h.loop).not.toHaveBeenCalled()
      expect(useChatStore.getState().drafts.a).toBe(draft)
      expect(useChatStore.getState().queuedMessages.a).toEqual([item])

      useChatStore.getState().setRewinding('a', false)
      agent.requestQueuedFlush()
      await vi.advanceTimersByTimeAsync(200)
      expect(dequeue).toHaveBeenCalledTimes(1)
      expect(h.loop).toHaveBeenCalledTimes(1)
      expect(useChatStore.getState().queuedMessages.a).toEqual([])
      expect(useChatStore.getState().sessions[0].messages.at(-1)?.content).toBe(item.content)
      expect(useChatStore.getState().drafts.a).toBe(draft)
    } finally {
      useChatStore.setState({ dequeueQueuedMessage: originalDequeue })
    }
  })

  it.each(['renderer', 'main'] as const)('%s：A 会话撤回不阻止 B 会话正常发送', async (mode) => {
    h.mode = mode
    useSettingsStore.setState({ baseUrl: 'http://localhost:11434/v1', model: 'test' })
    useChatStore.getState().setRewinding('a', true)
    await expect(useAgent('b').sendMessage('B continues')).resolves.toBe(true)
    expect(useChatStore.getState().rewindingSessionIds.has('a')).toBe(true)
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(1)
    if (mode === 'main') {
      expect(h.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'run', sessionId: 'b' }))
      expect(h.loop).not.toHaveBeenCalled()
    } else {
      expect(h.command).not.toHaveBeenCalled()
      expect(h.loop).toHaveBeenCalledTimes(1)
      expect(useChatStore.getState().sessions.find((s) => s.id === 'b')?.messages.at(-1)?.content).toBe('B continues')
    }
  })
})
