import { create } from 'zustand'
import { useChatStore, EMPTY_CHAT_DRAFT, type ChatDraft, type QueuedMessageItem } from '../stores/chat-store'
import { hostQueue } from './host-queue'
import { agentClient } from './agent-client'

export interface ComposerQueueOperation {
  kind: 'enqueue' | 'edit' | 'remove'
  status: 'pending' | 'unknown' | 'recovered' | 'rejected'
  item: QueuedMessageItem
  draft: ChatDraft
  error?: string
}

interface ComposerQueueState {
  operations: Record<string, Record<string, ComposerQueueOperation>>
}

/** Pending UI intent survives switching conversations; the host still owns the queue itself. */
export const useComposerQueueStore = create<ComposerQueueState>(() => ({ operations: {} }))
export const EMPTY_QUEUE_OPERATIONS: Record<string, ComposerQueueOperation> = {}

function updateOperation(sessionId: string, id: string, operation?: ComposerQueueOperation) {
  useComposerQueueStore.setState((state) => {
    const session = { ...state.operations[sessionId] }
    if (operation) session[id] = operation
    else delete session[id]
    const operations = { ...state.operations }
    if (Object.keys(session).length) operations[sessionId] = session
    else delete operations[sessionId]
    return { operations }
  })
}

function restoreItemDraft(sessionId: string, item: QueuedMessageItem) {
  useChatStore.getState().updateDraft(sessionId, {
    content: item.content,
    attachments: item.attachments ?? [],
    taskMode: item.taskMode ?? null,
    compactMode: false,
  })
}

/** No optimistic deletion or draft clearing: settle only after an ACK or an authoritative snapshot. */
export async function mutateComposerQueue(
  sessionId: string,
  item: QueuedMessageItem,
  kind: ComposerQueueOperation['kind'],
): Promise<boolean> {
  const state = useChatStore.getState()
  if (state.rewindingSessionIds.has(sessionId)) return false
  if (!state.sessions.some((session) => session.id === sessionId)) return false
  const existing = useComposerQueueStore.getState().operations[sessionId]?.[item.id]
  if (existing && existing.status !== 'rejected') return false
  if (kind !== 'remove' && state.draftSubmitting[sessionId]) return false
  if (kind !== 'enqueue' && !state.queuedMessages[sessionId]?.some((queued) => queued.id === item.id)) return false
  const operation: ComposerQueueOperation = {
    kind, item, draft: state.drafts[sessionId] ?? EMPTY_CHAT_DRAFT, status: 'pending',
  }
  updateOperation(sessionId, item.id, operation)
  if (kind !== 'remove') state.setDraftSubmitting(sessionId, true)
  try {
    const result = kind === 'enqueue'
      ? await hostQueue.enqueue(sessionId, item)
      : await hostQueue.remove(sessionId, item.id)
    const current = useChatStore.getState()
    if (!current.sessions.some((session) => session.id === sessionId)) return false
    // An intervening authoritative snapshot may already have acknowledged this enqueue.
    if (useComposerQueueStore.getState().operations[sessionId]?.[item.id] !== operation) return result.status === 'accepted'
    if (result.status !== 'accepted') {
      updateOperation(sessionId, item.id, { ...operation, status: result.status, error: result.error })
      return false
    }
    if (kind === 'enqueue') {
      if (result.mode === 'renderer' && !current.queuedMessages[sessionId]?.some((queued) => queued.id === item.id)) {
        current.enqueueQueuedMessage(sessionId, item)
      }
      current.clearDraft(sessionId, operation.draft)
    } else {
      current.removeQueuedMessage(sessionId, item.id)
      if (kind === 'edit') {
        if ((useChatStore.getState().drafts[sessionId] ?? EMPTY_CHAT_DRAFT) !== operation.draft) {
          updateOperation(sessionId, item.id, { ...operation, status: 'recovered' })
          return true
        }
        restoreItemDraft(sessionId, item)
      }
    }
    updateOperation(sessionId, item.id)
    return true
  } finally {
    if (kind !== 'remove') useChatStore.getState().setDraftSubmitting(sessionId, false)
  }
}

export async function refreshComposerQueue(sessionId: string): Promise<boolean> {
  try {
    await agentClient.resync(sessionId)
    return true
  } catch {
    return false
  }
}

/** Called only after the user reviews an unconfirmed outcome; never resubmits a command. */
export function recoverComposerQueue(sessionId: string, id: string) {
  const operation = useComposerQueueStore.getState().operations[sessionId]?.[id]
  if (!operation || operation.status === 'pending') return
  if (operation.kind === 'edit' && operation.status !== 'rejected' &&
      useChatStore.getState().sessions.some((session) => session.id === sessionId)) {
    restoreItemDraft(sessionId, operation.item)
  }
  updateOperation(sessionId, id)
}

// A real queue entry proves acceptance even when its command ACK was lost.
useChatStore.subscribe((state) => {
  const operations = useComposerQueueStore.getState().operations
  for (const [sessionId, sessionOperations] of Object.entries(operations)) {
    const exists = state.sessions.some((session) => session.id === sessionId)
    for (const [id, operation] of Object.entries(sessionOperations)) {
      if (!exists) updateOperation(sessionId, id)
      else if (operation.kind === 'enqueue' && operation.status !== 'rejected' &&
          state.queuedMessages[sessionId]?.some((item) => item.id === id)) {
        // Remove the intent first: clearing the draft notifies this subscriber again.
        updateOperation(sessionId, id)
        state.clearDraft(sessionId, operation.draft)
      }
    }
  }
})
