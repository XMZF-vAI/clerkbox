import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentCommandResult } from '../src/agent-core/protocol'
import type { Message, MessageAttachment, RewindOutcome, Session } from '../src/types/agent'
import type { MessageRow, SessionRow } from '../src/types/ipc'

const transport = vi.hoisted(() => ({ ensureMode: vi.fn(), send: vi.fn(), resync: vi.fn() }))
vi.mock('../src/lib/agent-client', () => ({ agentClient: transport }))

import { applyRewind, previewRewind } from '../src/lib/rewind-action'
import { applyAgentEvent } from '../src/lib/agent-event-apply'
import { ipc } from '../src/lib/ipc-client'
import { messageToRow, NEW_SESSION_TITLE } from '../src/lib/chat-row'
import { contentFingerprint, rewindHistoryVersion } from '../src/lib/rewind'
import { EMPTY_CHAT_DRAFT, flushSessionMessageWrites, setSessionAbortController, useChatStore } from '../src/stores/chat-store'
import { useComposerQueueStore } from '../src/lib/composer-queue'
import { resetWorkflowRunsForTests } from '../src/lib/workflow-runtime'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const attachments: MessageAttachment[] = [
  { id: 'image', kind: 'image', name: 'design.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' },
  { id: 'file', kind: 'file', name: 'brief.txt', path: 'D:\\work\\brief.txt', size: 10 },
]
const anchor: Message = { id: 'a-u1', role: 'user', content: '按这份设计做一个界面', timestamp: 3, attachments, taskMode: 'plan' }
const history: Message[] = [
  { id: 'a-u0', role: 'user', content: '先讨论方向', timestamp: 1 },
  { id: 'a-r0', role: 'assistant', content: '第一轮结果', timestamp: 2 },
  anchor,
  { id: 'a-r1', role: 'assistant', content: '目标轮结果', timestamp: 4 },
  { id: 'a-u2', role: 'user', content: '再加一个修改', timestamp: 5 },
  { id: 'a-r2', role: 'assistant', content: '后续轮结果', timestamp: 6 },
]
const otherMessage: Message = { id: 'b-u0', role: 'user', content: '另一个会话', timestamp: 1 }
const session = (id: string, messages: Message[]): Session => ({ id, title: id, messages, createdAt: 1, updatedAt: 1 })
const restoredDraft = () => ({ content: anchor.content, attachments, taskMode: 'plan', compactMode: false })
const messages = (id = 'a') => useChatStore.getState().sessions.find((item) => item.id === id)!.messages

let db: Map<string, MessageRow[]>
let metadata: Map<string, SessionRow>
let revision = 100

function truncateDb(sessionId: string, anchorMessageId: string): number {
  const rows = db.get(sessionId) ?? []
  const index = rows.findIndex((row) => row.id === anchorMessageId)
  if (index < 0) return 0
  revision += 1
  return rows.splice(index).length
}

beforeEach(() => {
  vi.resetAllMocks()
  revision += 1
  db = new Map([
    ['a', history.map((message) => messageToRow(message, 'a'))],
    ['b', [messageToRow(otherMessage, 'b')]],
  ])
  metadata = new Map(['a', 'b'].map((id) => [id, { id, title: id, created_at: 1, updated_at: 20 }]))
  useChatStore.setState({
    sessions: [session('a', history.map((message) => ({ ...message }))), session('b', [otherMessage])],
    activeSessionId: 'a', drafts: {}, draftSubmitting: {}, queuedMessages: {}, sessionErrors: {}, sessionStatus: {},
    streamingSessionIds: new Set(), compactingSessionIds: new Set(), stoppingSessionIds: new Set(), rewindingSessionIds: new Set(),
    rewindRevisions: {}, recentsFolders: [],
  })
  useComposerQueueStore.setState({ operations: {} })
  setSessionAbortController('a', null)
  setSessionAbortController('b', null)
  resetWorkflowRunsForTests()
  transport.ensureMode.mockResolvedValue('renderer')
  transport.resync.mockResolvedValue(undefined)
  transport.send.mockImplementation(async (command: AgentCommand): Promise<AgentCommandResult> => {
    if (command.type !== 'rewind.apply') return { ok: false, error: 'unexpected-command' }
    const removedMessages = truncateDb(command.sessionId, command.anchorMessageId)
    return { ok: true, outcome: { ok: true, removedMessages, restored: [], compensated: false } }
  })
  vi.spyOn(ipc, 'dbGetMessages').mockImplementation(async (id) => (db.get(id) ?? []).map((row) => ({ ...row })))
  vi.spyOn(ipc, 'dbGetAllSessions').mockImplementation(async () => [...metadata.values()].map((row) => ({ ...row })))
  vi.spyOn(ipc, 'dbGetRevision').mockImplementation(async () => revision)
  vi.spyOn(ipc, 'dbGetRecents').mockResolvedValue([])
  vi.spyOn(ipc, 'dbDeleteMessagesFrom').mockImplementation(async (id, from) => { truncateDb(id, from) })
  vi.spyOn(ipc, 'dbAddMessage').mockImplementation(async (row) => { db.set(row.session_id, [...db.get(row.session_id) ?? [], row]) })
  vi.spyOn(ipc, 'dbUpdateMessage').mockResolvedValue(undefined)
  vi.spyOn(ipc, 'dbPatchMessage').mockImplementation(async (id, patch) => {
    const row = [...db.values()].flat().find((item) => item.id === id)
    if (row) Object.assign(row, patch)
  })
  vi.spyOn(ipc, 'dbCreateSession').mockResolvedValue(undefined)
  vi.spyOn(ipc, 'dbUpdateSessionTitle').mockResolvedValue(undefined)
  vi.spyOn(ipc, 'dbDeleteSession').mockImplementation(async (id) => { db.delete(id); metadata.delete(id) })
  vi.spyOn(ipc, 'readFile').mockResolvedValue('after')
  vi.spyOn(ipc, 'writeFile').mockResolvedValue(undefined)
  vi.spyOn(ipc, 'deleteFile').mockResolvedValue(undefined)
  vi.spyOn(ipc, 'ckptGet').mockResolvedValue('before')
  vi.spyOn(ipc, 'ckptRemove').mockResolvedValue(undefined)
  vi.spyOn(ipc, 'ckptRemoveSession').mockResolvedValue(undefined)
  vi.spyOn(ipc, 'cancelSessionCommands').mockResolvedValue({ killed: 0 })
  vi.spyOn(ipc, 'agentDropSession').mockImplementation(() => {})
})

afterEach(async () => {
  await flushSessionMessageWrites('a')
  await flushSessionMessageWrites('b')
  setSessionAbortController('a', null)
  setSessionAbortController('b', null)
  vi.restoreAllMocks()
})

describe.each(['main', 'renderer'] as const)('%s 撤回与草稿恢复', (mode) => {
  it('恢复较早用户消息的正文、完整附件和任务模式，同时保留当前会话与其它草稿', async () => {
    const pendingMode = deferred<'main' | 'renderer'>()
    transport.ensureMode.mockReturnValueOnce(pendingMode.promise)
    useChatStore.getState().updateDraft('b', { content: 'B 的未发送内容', taskMode: 'spec' })
    const otherDraft = useChatStore.getState().drafts.b
    const applying = applyRewind('a', anchor.id, 'conversation', { restoreDraft: true, expectedHistoryVersion: rewindHistoryVersion(history) })
    expect(useChatStore.getState().rewindingSessionIds.has('a')).toBe(true)
    useChatStore.getState().setActiveSession('b')
    pendingMode.resolve(mode)
    expect(await applying).toMatchObject({ ok: true, removedMessages: 4 })
    const state = useChatStore.getState()
    expect(state.drafts.a).toEqual(restoredDraft())
    expect(state.drafts.a.attachments).not.toBe(attachments)
    expect(state.drafts.a.attachments[0]).not.toBe(attachments[0])
    expect(state.drafts.b).toBe(otherDraft)
    expect(state.activeSessionId).toBe('b')
    expect(messages().map((message) => message.id)).toEqual(['a-u0', 'a-r0'])
    expect(messages('b')).toEqual([otherMessage])
    expect(state.rewindRevisions.a).toBe(1)
    expect(state.rewindingSessionIds.has('a')).toBe(false)
    if (mode === 'main') {
      expect(transport.send).toHaveBeenCalledWith({ type: 'rewind.apply', sessionId: 'a', anchorMessageId: anchor.id, scope: 'conversation', expectedHistoryVersion: rewindHistoryVersion(history) })
      expect(ipc.dbDeleteMessagesFrom).not.toHaveBeenCalled()
    } else {
      expect(transport.send).not.toHaveBeenCalled()
      expect(ipc.dbDeleteMessagesFrom).toHaveBeenCalledWith('a', anchor.id)
    }
  })

  it('不恢复输入时保留已有草稿，绝不顺带覆盖或自动重发', async () => {
    transport.ensureMode.mockResolvedValue(mode)
    useChatStore.getState().updateDraft('a', { content: '继续编辑的内容', attachments: [attachments[1]!], taskMode: 'spec' })
    const draft = useChatStore.getState().drafts.a
    expect(await applyRewind('a', anchor.id, 'conversation')).toMatchObject({ ok: true })
    expect(useChatStore.getState().drafts.a).toBe(draft)
    expect(transport.send.mock.calls.every(([command]) => command.type === 'rewind.apply')).toBe(true)
  })

  it('撤回期间阻止草稿输入、附件追加、清空和发送占位，结束后允许继续编辑', async () => {
    const pendingMode = deferred<'main' | 'renderer'>()
    transport.ensureMode.mockReturnValueOnce(pendingMode.promise)
    useChatStore.getState().updateDraft('a', { ...EMPTY_CHAT_DRAFT })
    const empty = useChatStore.getState().drafts.a
    const applying = applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })
    const state = useChatStore.getState()
    state.updateDraft('a', { content: '迟到的输入', attachments: [attachments[1]!], taskMode: 'goal' })
    state.clearDraft('a', empty)
    state.setDraftSubmitting('a', true)
    state.enqueueQueuedMessage('a', { id: 'queued', content: '迟到的排队发送', queuedAt: 1 })
    expect(useChatStore.getState().drafts.a).toBe(empty)
    expect(useChatStore.getState().draftSubmitting.a).toBeFalsy()
    expect(useChatStore.getState().queuedMessages.a).toBeUndefined()
    pendingMode.resolve(mode)
    expect(await applying).toMatchObject({ ok: true })
    useChatStore.getState().updateDraft('a', { content: '恢复后继续编辑' })
    expect(useChatStore.getState().drafts.a.content).toBe('恢复后继续编辑')
  })

  it('较早启动的 DB 重读不能覆盖已成功撤回的历史或恢复草稿', async () => {
    transport.ensureMode.mockResolvedValue(mode)
    const oldRows = (db.get('a') ?? []).map((row) => ({ ...row }))
    const oldRead = deferred<MessageRow[]>()
    vi.mocked(ipc.dbGetMessages).mockReturnValueOnce(oldRead.promise)
    const reloading = useChatStore.getState().reloadSessionFromDb('a')
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: true })
    oldRead.resolve(oldRows)
    await reloading
    expect(messages().map((message) => message.id)).toEqual(['a-u0', 'a-r0'])
    expect(useChatStore.getState().drafts.a).toEqual(restoredDraft())
  })

  it('较早启动的全量同步不能复活被撤回的后续轮次', async () => {
    transport.ensureMode.mockResolvedValue(mode)
    const oldRows = (db.get('a') ?? []).map((row) => ({ ...row }))
    const oldRead = deferred<MessageRow[]>()
    vi.mocked(ipc.dbGetMessages).mockImplementationOnce(() => oldRead.promise)
    const syncing = useChatStore.getState().syncFromDb()
    await vi.waitFor(() => expect(ipc.dbGetMessages).toHaveBeenCalledWith('a'))
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: true })
    oldRead.resolve(oldRows)
    await syncing
    expect(messages().map((message) => message.id)).toEqual(['a-u0', 'a-r0'])
    expect(useChatStore.getState().drafts.a).toEqual(restoredDraft())
  })
})

describe('恢复草稿的冲突与互斥', () => {
  it.each([
    { content: '已有正文' }, { attachments: [attachments[0]!] }, { taskMode: 'plan' as const }, { compactMode: true },
  ])('已有草稿 %o 时在发送任何命令之前拒绝', async (patch) => {
    useChatStore.getState().updateDraft('a', patch)
    const draft = useChatStore.getState().drafts.a
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: false, error: 'draft-conflict' })
    expect(transport.ensureMode).not.toHaveBeenCalled()
    expect(useChatStore.getState().drafts.a).toBe(draft)
    expect(messages()).toHaveLength(history.length)
  })

  it.each(['submitting', 'streaming', 'compacting', 'stopping', 'queued', 'controller', 'queue-operation'] as const)('%s 期间拒绝撤回', async (busy) => {
    const state = useChatStore.getState()
    if (busy === 'submitting') state.setDraftSubmitting('a', true)
    if (busy === 'streaming') state.setStreaming(true, 'a')
    if (busy === 'compacting') state.setCompacting('a', true)
    if (busy === 'stopping') state.setStopping('a', true)
    if (busy === 'queued') state.enqueueQueuedMessage('a', { id: 'queued', content: '待发送', queuedAt: 1 })
    if (busy === 'controller') setSessionAbortController('a', new AbortController())
    if (busy === 'queue-operation') useComposerQueueStore.setState({ operations: { a: { queued: {
      status: 'unknown', kind: 'enqueue', item: { id: 'queued', content: '回执未确定', queuedAt: 1 }, draft: EMPTY_CHAT_DRAFT,
    } } } })
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: false, error: 'session-busy' })
    expect(transport.ensureMode).not.toHaveBeenCalled()
    expect(ipc.dbDeleteMessagesFrom).not.toHaveBeenCalled()
  })

  it('同步占锁拦住双击，模式查询期间出现发送状态也会重新拒绝', async () => {
    const mode = deferred<'renderer'>()
    transport.ensureMode.mockReturnValueOnce(mode.promise)
    const first = applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: false, error: 'session-busy' })
    useChatStore.getState().setStreaming(true, 'a')
    mode.resolve('renderer')
    expect(await first).toMatchObject({ ok: false, error: 'session-busy' })
    expect(transport.ensureMode).toHaveBeenCalledOnce()
    expect(ipc.dbDeleteMessagesFrom).not.toHaveBeenCalled()
    expect(useChatStore.getState().rewindingSessionIds.has('a')).toBe(false)
  })

  it('模式查询失败释放锁且保留消息与草稿', async () => {
    transport.ensureMode.mockRejectedValueOnce(new Error('mode unavailable'))
    await expect(applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).rejects.toThrow('mode unavailable')
    expect(useChatStore.getState().rewindingSessionIds.has('a')).toBe(false)
    expect(messages()).toHaveLength(history.length)
    expect(useChatStore.getState().drafts.a).toBeUndefined()
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: true })
  })

  it('Host IPC 失败释放锁，下一次操作仍可受理', async () => {
    transport.ensureMode.mockResolvedValue('main')
    transport.send.mockRejectedValueOnce(new Error('IPC disconnected'))
    await expect(applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).rejects.toThrow('IPC disconnected')
    expect(useChatStore.getState().rewindingSessionIds.has('a')).toBe(false)
    expect(messages()).toHaveLength(history.length)
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: true })
  })

  it('本地截断失败不恢复输入、不递增已提交版本，并释放锁', async () => {
    vi.mocked(ipc.dbDeleteMessagesFrom).mockRejectedValueOnce(new Error('disk busy'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: false, error: 'truncate-failed' })
    expect(useChatStore.getState().drafts.a).toBeUndefined()
    expect(useChatStore.getState().rewindRevisions.a).toBeUndefined()
    expect(useChatStore.getState().rewindingSessionIds.has('a')).toBe(false)
    expect(messages()).toHaveLength(history.length)
  })

  it('权威重读完成之前不清理已经撤成空白的来源会话', async () => {
    transport.ensureMode.mockResolvedValue('main')
    useChatStore.setState({ sessions: [ { ...session('a', [anchor]), title: NEW_SESSION_TITLE }, session('b', [otherMessage]) ] })
    db.set('a', [messageToRow(anchor, 'a')])
    const reload = deferred<MessageRow[]>()
    vi.mocked(ipc.dbGetMessages).mockReturnValueOnce(reload.promise)
    const applying = applyRewind('a', anchor.id, 'conversation')
    await vi.waitFor(() => expect(ipc.dbGetMessages).toHaveBeenCalledWith('a'))
    expect(messages()).toEqual([])
    useChatStore.getState().setActiveSession('b')
    useChatStore.getState().createSession({ activate: false })
    expect(useChatStore.getState().sessions.some((item) => item.id === 'a')).toBe(true)
    expect(ipc.dbDeleteSession).not.toHaveBeenCalledWith('a')
    reload.resolve([])
    expect(await applying).toMatchObject({ ok: true })
    expect(useChatStore.getState().activeSessionId).toBe('b')
  })

  it('在途全量同步不能把恢复出草稿的空白来源会话当垃圾删除', async () => {
    transport.ensureMode.mockResolvedValue('main')
    useChatStore.setState({ sessions: [{ ...session('a', [anchor]), title: NEW_SESSION_TITLE }, session('b', [otherMessage])] })
    db.set('a', [messageToRow(anchor, 'a')])
    metadata.set('a', { id: 'a', title: NEW_SESSION_TITLE, created_at: 1, updated_at: 20 })
    const oldRead = deferred<MessageRow[]>()
    vi.mocked(ipc.dbGetMessages).mockReturnValueOnce(oldRead.promise)
    const syncing = useChatStore.getState().syncFromDb()
    await vi.waitFor(() => expect(ipc.dbGetMessages).toHaveBeenCalledWith('a'))
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: true })
    oldRead.resolve([])
    await syncing
    expect(ipc.dbDeleteSession).not.toHaveBeenCalledWith('a')
    expect(useChatStore.getState().sessions.some((item) => item.id === 'a')).toBe(true)
    expect(useChatStore.getState().drafts.a).toEqual(restoredDraft())
  })
})

describe('resync 与文件回滚集成', () => {
  it('Host ACK 之前启动的迟到 resync 不能把旧分支重新写回来', async () => {
    transport.ensureMode.mockResolvedValue('main')
    const oldRows = (db.get('a') ?? []).map((row) => ({ ...row }))
    const stale = deferred<MessageRow[]>()
    vi.mocked(ipc.dbGetMessages).mockReturnValueOnce(stale.promise)
    transport.send.mockImplementationOnce(async () => {
      applyAgentEvent({ type: 'resync', sessionId: 'a', reason: 'ring-overflow' })
      const removedMessages = truncateDb('a', anchor.id)
      return { ok: true, outcome: { ok: true, removedMessages, restored: [], compensated: false } satisfies RewindOutcome }
    })
    expect(await applyRewind('a', anchor.id, 'conversation', { restoreDraft: true })).toMatchObject({ ok: true })
    stale.resolve(oldRows)
    // applyAgentEvent 故意不等待 reload；让该读取的 Promise.all 和 store 提交都走完再断言。
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(messages().map((message) => message.id)).toEqual(['a-u0', 'a-r0'])
    expect(useChatStore.getState().drafts.a).toEqual(restoredDraft())
  })

  it('只回滚文件时保留整个对话和已有草稿，不把用户消息灌回输入框', async () => {
    const target: Message = { ...anchor, fileCheckpoints: [{
      id: 'cp1', toolCallId: 'tc1', toolName: 'write_file', path: 'D:\\work\\a.txt', existedBefore: true,
      beforeRef: 'cp1.txt', afterHash: contentFingerprint('after'), beforeBytes: 6, createdAt: 3,
    }] }
    useChatStore.setState({ sessions: [session('a', [target, history[3]!]), session('b', [otherMessage])] })
    db.set('a', [target, history[3]!].map((message) => messageToRow(message, 'a')))
    useChatStore.getState().updateDraft('a', { content: '已有草稿' })
    const draft = useChatStore.getState().drafts.a
    expect(await applyRewind('a', anchor.id, 'workspace', { restoreDraft: true })).toMatchObject({ ok: true, removedMessages: 0 })
    expect(ipc.writeFile).toHaveBeenCalledWith('D:\\work\\a.txt', 'before')
    expect(ipc.dbDeleteMessagesFrom).not.toHaveBeenCalled()
    expect(messages().slice(0, 2).map((message) => message.id)).toEqual([anchor.id, history[3]!.id])
    expect(messages().at(-1)?.isRewindNotice).toBe(true)
    expect(useChatStore.getState().drafts.a).toBe(draft)
    expect(useChatStore.getState().rewindRevisions.a).toBeUndefined()
  })

  it('预览拒绝合成或助手锚点，不产生任何写入', async () => {
    expect(await previewRewind('a', 'a-r1', 'conversation')).toBeNull()
    expect(await previewRewind('a', 'missing', 'conversation')).toBeNull()
    expect(ipc.dbDeleteMessagesFrom).not.toHaveBeenCalled()
    expect(ipc.writeFile).not.toHaveBeenCalled()
  })
})
