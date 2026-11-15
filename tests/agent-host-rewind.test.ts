import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStore } from '../electron/db'
import type { AgentPorts, AgentSettings } from '../src/agent-core/ports'
import type { AgentCommand, AgentEvent } from '../src/agent-core/protocol'
import type { Message } from '../src/types/agent'
import type { MessageRow } from '../src/types/ipc'

const h = vi.hoisted(() => ({
  run: vi.fn<(...args: unknown[]) => Promise<void>>(),
  compact: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  workflows: [] as Array<{ id: string; sessionId: string; status: string }>,
  nextId: 0,
}))

vi.mock('../src/agent-core/loop', () => ({
  makeId: () => `host-rewind-${++h.nextId}`,
  runReactLoop: (...args: unknown[]) => h.run(...args),
}))
vi.mock('../src/lib/compact', () => ({
  compactConversation: (...args: unknown[]) => h.compact(...args),
  findKeepBoundaryIndex: () => 0,
}))
vi.mock('../src/lib/tool-registry', () => ({
  toolRegistry: { getDefinitionsForMode: () => [], setAgentActionCapabilities: () => {}, execute: vi.fn() },
}))
vi.mock('../src/lib/workflow-runtime', () => ({
  abortWorkflowRunsForSession: vi.fn(),
  stopWorkflowRun: vi.fn(),
  listRunningWorkflowRuns: (sessionId: string) => h.workflows.filter((run) => run.sessionId === sessionId && run.status === 'running'),
}))

import { AgentSessionManager, setAgentHostWindowProbeForTest } from '../electron/agent-host'
import { messageToRow } from '../src/lib/chat-row'
import { contentFingerprint } from '../src/lib/rewind'
import { ipc } from '../src/lib/ipc-client'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const history: Message[] = [
  { id: 'u1', role: 'user', content: '第一轮', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: '第一轮回答', timestamp: 2 },
  { id: 'u2', role: 'user', content: '第二轮', timestamp: 3 },
  { id: 'a2', role: 'assistant', content: '第二轮回答', timestamp: 4 },
]

function fakeStore(seed: Message[] = history) {
  const rows = seed.map((message) => messageToRow(message, 's1'))
  const store = {
    kind: 'sqlite',
    getMessages: vi.fn(async () => rows.map((row) => ({ ...row }))),
    getAllSessions: vi.fn(async () => [{ id: 's1', title: '撤回测试', created_at: 1, updated_at: 1, working_dir: 'D:\\work' }]),
    addMessage: vi.fn(async (row: MessageRow) => { rows.push(row) }),
    updateMessage: vi.fn(async () => undefined),
    patchMessage: vi.fn(async (id: string, patch: Partial<MessageRow>) => {
      const row = rows.find((item) => item.id === id)
      if (row) Object.assign(row, patch)
    }),
    compactMessages: vi.fn(async (_id: string, next: MessageRow[]) => { rows.splice(0, rows.length, ...next) }),
    deleteMessagesFrom: vi.fn(async (_id: string, fromId: string) => {
      const index = rows.findIndex((row) => row.id === fromId)
      if (index >= 0) rows.splice(index)
    }),
  }
  return { store, rows, manager: new AgentSessionManager(store as unknown as ChatStore) }
}

const settings = {
  model: 'test-model', apiCompat: 'openai', baseUrl: 'https://api.invalid.test/v1', apiKey: 'test',
  approvalMode: 'manual', providers: [], maxTokens: 1024, maxInputTokens: 184000,
} as unknown as AgentSettings
const command = (type: 'rewind.preview' | 'rewind.apply', over: Record<string, unknown> = {}): AgentCommand =>
  ({ type, sessionId: 's1', anchorMessageId: 'u1', scope: 'conversation', ...over }) as AgentCommand
const idle = (manager: AgentSessionManager) => vi.waitFor(() => {
  expect(manager.inspect().find((session) => session.sessionId === 's1')?.hasRun).toBe(false)
})

beforeEach(() => {
  h.nextId = 0
  h.workflows = []
  h.run.mockReset().mockResolvedValue(undefined)
  h.compact.mockReset()
  setAgentHostWindowProbeForTest(() => [])
  vi.spyOn(ipc, 'readFile').mockResolvedValue('after')
  vi.spyOn(ipc, 'writeFile').mockResolvedValue(undefined)
  vi.spyOn(ipc, 'deleteFile').mockResolvedValue(undefined)
  vi.spyOn(ipc, 'ckptGet').mockResolvedValue('before')
  vi.spyOn(ipc, 'ckptRemove').mockResolvedValue(undefined)
})

afterEach(() => {
  setAgentHostWindowProbeForTest(null)
  vi.restoreAllMocks()
})

describe('Host 撤回的锚点与历史版本', () => {
  it('较早的真实用户消息可预览并截断全部后续轮次', async () => {
    const { manager, rows } = fakeStore()
    const preview = await manager.handleCommand(command('rewind.preview'))
    expect(preview).toMatchObject({ ok: true, plan: { removedMessages: 4 } })
    expect(preview.plan?.historyVersion).toEqual(expect.any(String))
    await expect(manager.handleCommand(command('rewind.apply', { expectedHistoryVersion: preview.plan?.historyVersion })))
      .resolves.toMatchObject({ ok: true, outcome: { removedMessages: 4 } })
    expect(rows).toEqual([])
  })

  it.each(['a1', 'missing', 'notice', 'compact'])('拒绝非真实用户锚点 %s', async (anchorMessageId) => {
    const { manager, store } = fakeStore([
      ...history,
      { id: 'notice', role: 'user', content: '合成回执', timestamp: 5, isRewindNotice: true },
      { id: 'compact', role: 'user', content: '压缩摘要', timestamp: 6, isCompactSummary: true },
    ])
    await expect(manager.handleCommand(command('rewind.preview', { anchorMessageId })))
      .resolves.toEqual({ ok: false, error: 'no-checkpoint' })
    await expect(manager.handleCommand(command('rewind.apply', { anchorMessageId })))
      .resolves.toMatchObject({ ok: false, error: 'no-checkpoint' })
    expect(store.deleteMessagesFrom).not.toHaveBeenCalled()
  })

  it('确认后历史同 ID 内容发生变化时，CAS 拒绝截断', async () => {
    const { manager, store, rows } = fakeStore()
    const preview = await manager.handleCommand(command('rewind.preview'))
    rows[1]!.content = '预览后被修改'
    await expect(manager.handleCommand(command('rewind.apply', { expectedHistoryVersion: preview.plan?.historyVersion })))
      .resolves.toMatchObject({ ok: false, error: 'history-changed' })
    expect(store.deleteMessagesFrom).not.toHaveBeenCalled()
    expect(ipc.writeFile).not.toHaveBeenCalled()
  })

  it('both 也允许较早的真实用户锚点，先恢复文件再截断', async () => {
    const { manager, store } = fakeStore([
      { ...history[0]!, fileCheckpoints: [{
        id: 'cp1', toolCallId: 'tc1', toolName: 'write_file', path: 'D:\\work\\a.txt',
        existedBefore: true, beforeRef: 'cp1.txt', afterHash: contentFingerprint('after'), beforeBytes: 6, createdAt: 1,
      }] },
      ...history.slice(1),
    ])
    await expect(manager.handleCommand(command('rewind.apply', { scope: 'both' })))
      .resolves.toMatchObject({ ok: true, outcome: { removedMessages: 4, restored: [{ path: 'D:\\work\\a.txt', action: 'restore' }] } })
    expect(ipc.writeFile).toHaveBeenCalledWith('D:\\work\\a.txt', 'before')
    expect(vi.mocked(ipc.writeFile).mock.invocationCallOrder[0]).toBeLessThan(store.deleteMessagesFrom.mock.invocationCallOrder[0]!)
  })
})

describe('Host 撤回的互斥与删除会话', () => {
  it('第一次异步读库前占锁，双击 apply 被拒绝，锁内不能手动压缩', async () => {
    const { manager, store, rows } = fakeStore()
    const read = deferred<MessageRow[]>()
    store.getMessages.mockImplementationOnce(() => read.promise)
    const applying = manager.handleCommand(command('rewind.apply'))
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toEqual({ ok: false, error: 'session-busy' })
    await expect(manager.handleCommand({ type: 'manual.compact', sessionId: 's1' })).resolves.toEqual({ ok: false, error: 'compaction-busy' })
    await expect(manager.handleCommand({ type: 'queue.flush', sessionId: 's1' })).resolves.toEqual({ ok: false, error: 'session-busy' })
    read.resolve([...rows])
    await expect(applying).resolves.toMatchObject({ ok: true })
    expect(store.deleteMessagesFrom).toHaveBeenCalledTimes(1)
  })

  it('运行中拒绝 apply，保留原 run 与队列；preview 仍可读', async () => {
    const { manager, store } = fakeStore()
    const run = deferred<void>()
    h.run.mockReturnValueOnce(run.promise)
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: '进行中', settings })
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toEqual({ ok: false, error: 'session-busy' })
    await expect(manager.handleCommand(command('rewind.preview'))).resolves.toMatchObject({ ok: true })
    expect((h.run.mock.calls[0]![3] as AbortController).signal.aborted).toBe(false)
    expect(store.deleteMessagesFrom).not.toHaveBeenCalled()
    run.resolve()
    await idle(manager)
  })

  it('压缩中拒绝 apply，避免旧快照重写撤回结果', async () => {
    const { manager, store } = fakeStore()
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: '初始化设置', settings })
    await idle(manager)
    const compact = deferred<unknown>()
    h.compact.mockReturnValueOnce(compact.promise)
    await manager.handleCommand({ type: 'manual.compact', sessionId: 's1' })
    await vi.waitFor(() => expect(h.compact).toHaveBeenCalledOnce())
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toEqual({ ok: false, error: 'session-busy' })
    expect(store.deleteMessagesFrom).not.toHaveBeenCalled()
    manager.dropSession('s1')
    compact.resolve({ boundaryMessage: history[0], summaryMessage: history[1], fileAttachments: [] })
  })

  it('有待发队列或仍在运行的后台工作流时拒绝 apply', async () => {
    const { manager, store } = fakeStore()
    await manager.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: 'q1', content: '待发', queuedAt: 1 } })
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toEqual({ ok: false, error: 'session-busy' })
    await manager.handleCommand({ type: 'queue.remove', sessionId: 's1', id: 'q1' })
    h.workflows = [{ id: 'workflow-1', sessionId: 's1', status: 'running' }]
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toEqual({ ok: false, error: 'session-busy' })
    expect(store.deleteMessagesFrom).not.toHaveBeenCalled()
  })

  it('执行期间新消息只排队，自动 flush 等撤回提交后再运行', async () => {
    const { manager, store, rows } = fakeStore()
    const read = deferred<MessageRow[]>()
    store.getMessages.mockImplementationOnce(() => read.promise)
    const applying = manager.handleCommand(command('rewind.apply'))
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: '撤回期间发来', settings })
    expect(manager.inspect()[0]).toMatchObject({ hasRun: false, queued: 1 })
    expect(h.run).not.toHaveBeenCalled()
    read.resolve([...rows])
    await expect(applying).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
    expect(rows.map((row) => row.content)).toEqual(['撤回期间发来'])
    expect(store.deleteMessagesFrom.mock.invocationCallOrder[0]).toBeLessThan(h.run.mock.invocationCallOrder[0]!)
    await idle(manager)
  })

  it('等待前一轮迟到的落库完成，截断后不会被旧 addMessage 复活', async () => {
    const { manager, store, rows } = fakeStore()
    const write = deferred<void>()
    store.addMessage.mockImplementation(async (row) => {
      if (row.id === 'late') await write.promise
      rows.push(row)
    })
    h.run.mockImplementationOnce(async (ports) => {
      (ports as AgentPorts).store.addMessage('s1', { id: 'late', role: 'assistant', content: '迟到写入', timestamp: 20 })
    })
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: '前一轮', settings })
    await idle(manager)
    const applying = manager.handleCommand(command('rewind.apply'))
    await Promise.resolve()
    expect(store.deleteMessagesFrom).not.toHaveBeenCalled()
    write.resolve()
    await expect(applying).resolves.toMatchObject({ ok: true })
    expect(rows).toEqual([])
  })

  it('异步读库期间删除会话会取消 apply，迟到指令也不复活 Host 会话', async () => {
    const { manager, store, rows } = fakeStore()
    const read = deferred<MessageRow[]>()
    store.getMessages.mockImplementationOnce(() => read.promise)
    const applying = manager.handleCommand(command('rewind.apply'))
    manager.dropSession('s1')
    read.resolve([...rows])
    await expect(applying).resolves.toEqual({ ok: false, error: 'session-dropped' })
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toEqual({ ok: false, error: 'session-dropped' })
    await expect(manager.handleCommand(command('rewind.preview'))).resolves.toEqual({ ok: false, error: 'session-dropped' })
    expect(store.deleteMessagesFrom).not.toHaveBeenCalled()
    expect(manager.inspect()).toEqual([])
  })

  it('执行器异常会映射错误并释放锁，允许重新预览/执行', async () => {
    const { manager, store } = fakeStore()
    store.getMessages.mockRejectedValueOnce(new Error('read failed'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toEqual({ ok: false, error: 'write-failed' })
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toMatchObject({ ok: true })
    expect(log).toHaveBeenCalled()
  })
})

describe('Host 撤回后的权威状态', () => {
  it('清空旧消息/流事件环，保留 seq 单调递增，重连只回放新分支', async () => {
    const { manager, rows } = fakeStore()
    h.run.mockImplementationOnce(async (ports) => {
      (ports as AgentPorts).store.addMessage('s1', { id: 'old-assistant', role: 'assistant', content: '旧分支', timestamp: 20 })
    })
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: '旧问题', settings })
    await idle(manager)
    const before = manager.inspect()[0]!.lastSeq
    expect(manager.peekRing('s1').some((event) => event.type === 'message.added')).toBe(true)
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toMatchObject({ ok: true })
    expect(rows).toEqual([])
    expect(manager.peekRing('s1')).toEqual([{ type: 'resync', sessionId: 's1', reason: 'rewind:conversation' }])
    expect(manager.inspect()[0]!.lastSeq).toBeGreaterThan(before)
    manager.snapshot('s1', 0)
    expect(manager.peekRing('s1').some((event: AgentEvent) => event.type === 'message.added' || event.type === 'stream.delta')).toBe(false)
  })

  it('截断提交后镜像重读失败仍发送 resync，避免旧事件复活', async () => {
    const { manager, store } = fakeStore()
    // 初次执行读取、执行前复核由公共执行器决定；truncate 后才让重读失败。
    store.deleteMessagesFrom.mockImplementation(async () => {
      store.getMessages.mockRejectedValueOnce(new Error('reload failed'))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(manager.handleCommand(command('rewind.apply'))).resolves.toMatchObject({ ok: true })
    expect(manager.peekRing('s1')).toEqual([{ type: 'resync', sessionId: 's1', reason: 'rewind:conversation' }])
  })

  it('远程通道不能预览或提交撤回', async () => {
    const { manager, store } = fakeStore()
    for (const type of ['rewind.preview', 'rewind.apply'] as const) {
      await expect(manager.handleCommand(command(type), { remote: true })).resolves.toEqual({ ok: false, error: 'rewind-local-only' })
    }
    expect(store.getMessages).not.toHaveBeenCalled()
  })
})
