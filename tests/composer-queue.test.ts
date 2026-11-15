import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostQueueResult } from '../src/lib/host-queue'

const transport = vi.hoisted(() => ({ enqueue: vi.fn(), remove: vi.fn(), resync: vi.fn() }))
vi.mock('../src/lib/host-queue', () => ({ hostQueue: transport }))
vi.mock('../src/lib/agent-client', () => ({ agentClient: { resync: transport.resync } }))

import { useChatStore, type QueuedMessageItem } from '../src/stores/chat-store'
import { mutateComposerQueue, recoverComposerQueue, refreshComposerQueue, useComposerQueueStore } from '../src/lib/composer-queue'

const item: QueuedMessageItem = { id: 'q1', content: 'Run the next task', queuedAt: 1 }
const session = (id: string) => ({ id, title: id, messages: [], createdAt: 1, updatedAt: 1 })
function deferred() {
  let resolve!: (result: HostQueueResult) => void
  const promise = new Promise<HostQueueResult>((done) => { resolve = done })
  return { resolve, promise }
}

beforeEach(() => {
  vi.resetAllMocks()
  transport.enqueue.mockResolvedValue({ status: 'accepted', mode: 'renderer' })
  transport.remove.mockResolvedValue({ status: 'accepted', mode: 'renderer' })
  transport.resync.mockResolvedValue(undefined)
  useComposerQueueStore.setState({ operations: {} })
  useChatStore.setState({ sessions: [session('a'), session('b')], activeSessionId: 'a', drafts: {}, draftSubmitting: {}, queuedMessages: {} })
  useChatStore.getState().updateDraft('a', { content: item.content })
})

describe('composer queue acceptance', () => {
  it('keeps the draft and original queue visible until acceptance', async () => {
    const pending = deferred()
    transport.enqueue.mockReturnValue(pending.promise)
    const accepted = mutateComposerQueue('a', item, 'enqueue')
    expect(useChatStore.getState().drafts.a.content).toBe(item.content)
    expect(useChatStore.getState().queuedMessages.a).toBeUndefined()
    expect(useChatStore.getState().draftSubmitting.a).toBe(true)
    pending.resolve({ status: 'accepted', mode: 'renderer' })
    expect(await accepted).toBe(true)
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
    expect(useChatStore.getState().drafts.a).toBeUndefined()
    expect(useChatStore.getState().draftSubmitting.a).toBeFalsy()
  })

  it('preserves content on an explicit rejection', async () => {
    transport.enqueue.mockResolvedValue({ status: 'rejected', error: 'not-ready' })
    expect(await mutateComposerQueue('a', item, 'enqueue')).toBe(false)
    expect(useChatStore.getState().drafts.a.content).toBe(item.content)
    expect(useComposerQueueStore.getState().operations.a.q1.status).toBe('rejected')
    expect(useChatStore.getState().queuedMessages.a).toBeUndefined()
  })

  it('blocks a duplicate click and an unconfirmed retry without sending another command', async () => {
    const pending = deferred()
    transport.enqueue.mockReturnValue(pending.promise)
    const first = mutateComposerQueue('a', item, 'enqueue')
    expect(await mutateComposerQueue('a', item, 'enqueue')).toBe(false)
    pending.resolve({ status: 'unknown', error: 'ack lost' })
    expect(await first).toBe(false)
    expect(await mutateComposerQueue('a', item, 'enqueue')).toBe(false)
    await refreshComposerQueue('a')
    expect(transport.enqueue).toHaveBeenCalledTimes(1)
    expect(transport.resync).toHaveBeenCalledWith('a')
    expect(useChatStore.getState().drafts.a.content).toBe(item.content)
  })

  it('settles a lost enqueue ACK only when the real queue proves acceptance', async () => {
    transport.enqueue.mockResolvedValue({ status: 'unknown', error: 'ack lost' })
    await mutateComposerQueue('a', item, 'enqueue')
    useChatStore.setState({ queuedMessages: { a: [item] } })
    expect(useComposerQueueStore.getState().operations.a).toBeUndefined()
    expect(useChatStore.getState().drafts.a).toBeUndefined()
    expect(transport.enqueue).toHaveBeenCalledTimes(1)
  })

  it('a late accepted enqueue does not clear newly edited content', async () => {
    const pending = deferred()
    transport.enqueue.mockReturnValue(pending.promise)
    const accepted = mutateComposerQueue('a', item, 'enqueue')
    useChatStore.getState().updateDraft('a', { content: 'new draft' })
    pending.resolve({ status: 'accepted', mode: 'renderer' })
    await accepted
    expect(useChatStore.getState().drafts.a.content).toBe('new draft')
  })
})

describe('queued edit and removal', () => {
  beforeEach(() => useChatStore.setState({ queuedMessages: { a: [item] } }))

  it('an edit rejection does not remove the item or replace the draft', async () => {
    transport.remove.mockResolvedValue({ status: 'rejected', error: 'queue-item-missing' })
    useChatStore.getState().updateDraft('a', { content: 'keep this', attachments: [{ id: 'f', name: 'keep.txt', kind: 'file', path: '/keep.txt' }] })
    expect(await mutateComposerQueue('a', item, 'edit')).toBe(false)
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
    expect(useChatStore.getState().drafts.a.content).toBe('keep this')
    expect(useChatStore.getState().drafts.a.attachments).toHaveLength(1)
  })

  it('applies a late edit only to its source conversation and restores empty attachments', async () => {
    const pending = deferred()
    transport.remove.mockReturnValue(pending.promise)
    const accepted = mutateComposerQueue('a', item, 'edit')
    useChatStore.setState({ activeSessionId: 'b' })
    useChatStore.getState().updateDraft('b', { content: 'B draft' })
    pending.resolve({ status: 'accepted', mode: 'main' })
    await accepted
    expect(useChatStore.getState().drafts.a).toMatchObject({ content: item.content, attachments: [], compactMode: false })
    expect(useChatStore.getState().drafts.b.content).toBe('B draft')
    expect(useChatStore.getState().queuedMessages.a).toEqual([])
  })

  it('keeps an intervening draft change and offers explicit recovery', async () => {
    const pending = deferred()
    transport.remove.mockReturnValue(pending.promise)
    const accepted = mutateComposerQueue('a', item, 'edit')
    useChatStore.getState().updateDraft('a', { content: 'new draft' })
    pending.resolve({ status: 'accepted', mode: 'main' })
    await accepted
    expect(useChatStore.getState().drafts.a.content).toBe('new draft')
    expect(useComposerQueueStore.getState().operations.a.q1.status).toBe('recovered')
    recoverComposerQueue('a', item.id)
    expect(useChatStore.getState().drafts.a.content).toBe(item.content)
    expect(transport.remove).toHaveBeenCalledTimes(1)
  })

  it('does not infer that an absent item was removed rather than already running', async () => {
    transport.remove.mockResolvedValue({ status: 'unknown', error: 'ack lost' })
    await mutateComposerQueue('a', item, 'edit')
    useChatStore.setState({ queuedMessages: { a: [] } })
    expect(useComposerQueueStore.getState().operations.a.q1.status).toBe('unknown')
    expect(useChatStore.getState().drafts.a.content).toBe(item.content)
  })

  it('keeps a rejected removal visible and never removes a missing item twice', async () => {
    transport.remove.mockResolvedValue({ status: 'rejected', error: 'offline' })
    expect(await mutateComposerQueue('a', item, 'remove')).toBe(false)
    expect(useChatStore.getState().queuedMessages.a).toEqual([item])
    useChatStore.setState({ queuedMessages: { a: [] } })
    expect(await mutateComposerQueue('a', item, 'remove')).toBe(false)
    expect(transport.remove).toHaveBeenCalledTimes(1)
  })

  it('reclaims pending intent when the source conversation is deleted', async () => {
    const pending = deferred()
    transport.remove.mockReturnValue(pending.promise)
    const accepted = mutateComposerQueue('a', item, 'edit')
    useChatStore.setState({ sessions: [session('b')], drafts: {}, draftSubmitting: {} })
    pending.resolve({ status: 'accepted', mode: 'main' })
    expect(await accepted).toBe(false)
    expect(useComposerQueueStore.getState().operations.a).toBeUndefined()
    expect(useChatStore.getState().drafts.a).toBeUndefined()
    expect(useChatStore.getState().draftSubmitting.a).toBeUndefined()
  })
})
