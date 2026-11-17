import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  webUI: false,
  cloud: false,
  chat: {} as Record<string, any>,
  scope: '', cursor: 0,
  slots: {} as Record<string, any[]>,
  effects: {} as Record<string, Array<{ dependencies?: readonly unknown[]; cleanup?: () => void }>>,
  pending: [] as Array<() => void>,
  modalClose: undefined as undefined | (() => void),
  dialogRef: { current: null },
  portal: vi.fn((children: unknown, _target: unknown) => children),
  accessibility: vi.fn(),
  preview: vi.fn(), apply: vi.fn(), close: vi.fn(), resend: vi.fn(),
  hasDraft: vi.fn((draft?: Record<string, any>) => !!draft && (
    !!draft.content || draft.attachments.length > 0 || !!draft.taskMode || draft.compactMode
  )),
}))

// Keep hook state and effect cleanup across explicit renders. This exercises the
// real component callbacks while leaving Electron, layout and focus traversal out
// of the Node suite (the shared overlay hook has its own keyboard tests).
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  const effect = (callback: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const scope = h.scope
    const index = h.cursor++
    const records = h.effects[scope] ??= []
    const previous = records[index]
    if (previous && dependencies && previous.dependencies && dependencies.length === previous.dependencies.length &&
      dependencies.every((value, i) => Object.is(value, previous.dependencies![i]))) return
    records[index] = { dependencies }
    h.pending.push(() => {
      previous?.cleanup?.()
      const cleanup = callback()
      if (typeof cleanup === 'function') records[index].cleanup = cleanup
    })
  }
  return {
    ...react,
    useState: (initial: unknown) => {
      const slots = h.slots[h.scope] ??= []
      const index = h.cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next: unknown) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
      }]
    },
    useRef: (initial: unknown) => {
      const slots = h.slots[h.scope] ??= []
      const index = h.cursor++
      return slots[index] ??= { current: initial }
    },
    useId: () => `rewind-${h.scope}`,
    useEffect: effect,
    useLayoutEffect: effect,
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
  }
})
vi.mock('react-dom', () => ({ createPortal: h.portal }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('../src/lib/ipc-client', () => ({ get isWebUIMode() { return h.webUI } }))
vi.mock('../src/remote/browser', () => ({ isCloudRemoteMode: () => h.cloud }))
vi.mock('../src/lib/rewind-action', () => ({ previewRewind: h.preview, applyRewind: h.apply }))
vi.mock('../src/stores/chat-store', () => ({
  useChatStore: Object.assign((select: (state: any) => unknown) => select(h.chat), { getState: () => h.chat }),
  hasChatDraft: h.hasDraft,
}))
vi.mock('../src/stores/vibe-store', () => ({ useVibeStore: (select: (state: any) => unknown) => select({ isVibeMode: false }) }))
vi.mock('../src/hooks/use-modal-accessibility', () => ({
  useModalAccessibility: (...args: unknown[]) => {
    h.accessibility(...args)
    h.modalClose = args[0] as () => void
    return h.dialogRef
  },
}))

import RewindActions from '../src/components/chat/RewindActions'
import RewindDialog, { type RewindDialogProps, type RewindMode } from '../src/components/chat/RewindDialog'
import { MessageActionButton } from '../src/components/chat/MessageActions'
import type { Message } from '../src/types/agent'

type Element = ReactElement<Record<string, any>>
const sessionId = 'session-a'
const anchor: Message = {
  id: 'user-a', role: 'user', content: '  Original request  ', timestamp: 1,
  attachments: [{ id: 'attachment-a', kind: 'file', name: 'note.txt', path: '/project/note.txt' }],
  fileCheckpoints: [{
    id: 'checkpoint-a', path: '/project/a.ts', toolCallId: 'tool-a', toolName: 'write_file',
    existedBefore: true, beforeRef: 'checkpoint-a.txt', afterHash: 'after', beforeBytes: 3, createdAt: 2,
  }],
}
const goodPlan = (historyVersion = 'history-a') => ({
  historyVersion, canApply: true, unsafeFiles: [], gaps: [], removedMessages: 4,
  safeFiles: [{ path: '/project/a.ts', action: 'restore', checkpointId: 'checkpoint-a',
    toolName: 'write_file', beforeRef: 'checkpoint-a.txt', bytes: 3 }],
})
const success = { ok: true, restored: [], compensated: false, removedMessages: 4 }
const emptyDraft = () => ({ content: '', attachments: [], taskMode: null, compactMode: false })

function nodes(root: ReactNode): Element[] {
  if (Array.isArray(root)) return root.flatMap(nodes)
  if (!isValidElement<Record<string, any>>(root)) return []
  const children = nodes(root.props.children)
  // Inspect the real native button too, including forwarding of disabled/name.
  if (root.type === MessageActionButton) return [root, ...nodes(MessageActionButton(root.props as never)), ...children]
  return [root, ...children]
}
function textOf(root: ReactNode): string {
  if (typeof root === 'string' || typeof root === 'number') return String(root)
  if (Array.isArray(root)) return root.map(textOf).join(' ')
  return isValidElement<{ children?: ReactNode }>(root) ? textOf(root.props.children) : ''
}
function render(scope: string, component: () => ReactNode): Element[] {
  h.scope = scope
  h.cursor = 0
  const result = nodes(component())
  h.pending.splice(0).forEach((effect) => effect())
  return result
}
function button(view: Element[], label: string): Element {
  const result = view.find((node) => node.type === 'button' &&
    (node.props['aria-label'] === label || textOf(node).trim() === label))
  expect(result, `button ${label}`).toBeDefined()
  return result!
}
function hasButton(view: Element[], label: string): boolean {
  return view.some((node) => node.type === 'button' &&
    (node.props['aria-label'] === label || textOf(node).trim() === label))
}
const actionView = (overrides: Partial<Parameters<typeof RewindActions>[0]> = {}) => render('actions', () => RewindActions({
  sessionId, anchor, canRewindAnchor: true, isStreaming: false, onResend: h.resend, ...overrides,
}))
const dialogProps = (mode: RewindMode = 'recall', overrides: Partial<RewindDialogProps> = {}): RewindDialogProps => ({
  sessionId, anchor, mode, onClose: h.close, onResend: h.resend, ...overrides,
})
const dialogView = (props = dialogProps()) => render('dialog', () => RewindDialog(props))
async function flush() {
  // preview's then/catch/finally and apply's awaiting continuation must settle.
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
async function ready(props = dialogProps()) {
  dialogView(props)
  await flush()
  return dialogView(props)
}
const confirmLabel = (mode: RewindMode) => mode === 'edit' ? 'chat.rewind.editConfirm'
  : mode === 'retry' ? 'chat.rewind.retryConfirm' : 'chat.rewind.confirm'
function keyboard(overrides: Record<string, unknown> = {}) {
  return { key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false, keyCode: 13,
    nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.webUI = false
  h.cloud = false
  h.slots = {}
  h.effects = {}
  h.pending = []
  h.modalClose = undefined
  h.chat = {
    activeSessionId: 'another-active-session',
    sessions: [{ id: sessionId, messages: [anchor] }],
    streamingSessionIds: new Set(), compactingSessionIds: new Set(), stoppingSessionIds: new Set(),
    rewindingSessionIds: new Set(), draftSubmitting: {}, drafts: {}, queuedMessages: {},
  }
  h.preview.mockReset().mockResolvedValue(goodPlan())
  h.apply.mockReset().mockResolvedValue(success)
  vi.stubGlobal('document', { body: { id: 'body' } })
})
afterEach(() => {
  for (const records of Object.values(h.effects)) for (const record of records) record?.cleanup?.()
  vi.unstubAllGlobals()
})

describe('rewind action ownership and availability', () => {
  it('offers recall for a historical real user message, while edit and files stay on the latest anchor', () => {
    const view = actionView({ canRewindAnchor: false })
    expect(hasButton(view, 'chat.rewind.recall')).toBe(true)
    expect(hasButton(view, 'chat.rewind.edit')).toBe(false)
    expect(hasButton(view, 'chat.rewind.undoFiles')).toBe(false)
    button(view, 'chat.rewind.recall').props.onClick()
    const dialog = actionView({ canRewindAnchor: false }).find((node) => node.type === RewindDialog)
    expect(dialog?.props).toMatchObject({ sessionId, anchor, mode: 'recall' })
    expect(dialog?.props.onResend).toBeUndefined()
  })

  it('keeps edit, recall and available file rollback on the latest real user message', () => {
    const view = actionView()
    for (const label of ['chat.rewind.edit', 'chat.rewind.recall', 'chat.rewind.undoFiles']) {
      expect(button(view, label).props.disabled).toBeFalsy()
    }
    button(view, 'chat.rewind.edit').props.onClick()
    expect(actionView().find((node) => node.type === RewindDialog)?.props).toMatchObject({ mode: 'edit', onResend: h.resend })
  })

  it.each([
    { role: 'assistant' }, { isCompactSummary: true }, { isCompactAttachment: true },
    { isRewindNotice: true }, { isSubAgentNotice: true }, { subAgentId: 'child' },
    { isSubAgentCard: true }, { goalEvent: { verdict: 'achieved' } },
  ])('does not offer recall for a synthetic/non-user anchor %j', (overrides) => {
    expect(actionView({ anchor: { ...anchor, ...overrides } as Message })).toEqual([])
  })

  it('keeps destructive actions unavailable to unpaired LAN clients', () => {
    h.webUI = true
    expect(actionView()).toEqual([])
  })

  it('offers the same host-validated rewind actions to paired browsers', () => {
    h.webUI = true
    h.cloud = true
    const view = actionView()
    for (const label of ['chat.rewind.edit', 'chat.rewind.recall', 'chat.rewind.undoFiles']) {
      expect(button(view, label).props.disabled).toBeFalsy()
    }
    button(view, 'chat.rewind.recall').props.onClick()
    expect(actionView().find((node) => node.type === RewindDialog)?.props).toMatchObject({ sessionId, anchor, mode: 'recall' })
  })

  it.each(['streamingSessionIds', 'compactingSessionIds', 'stoppingSessionIds', 'rewindingSessionIds', 'draftSubmitting'])
    ('shows disabled actions rather than hiding them while this session is busy: %s', (field) => {
      if (field === 'draftSubmitting') h.chat[field][sessionId] = true
      else h.chat[field].add(sessionId)
      const view = actionView()
      for (const label of ['chat.rewind.edit', 'chat.rewind.recall', 'chat.rewind.undoFiles']) {
        expect(button(view, label).props.disabled).toBe(true)
        expect(button(view, label).props['aria-description']).toMatch(/^chat\.rewind\.busy\./)
      }
    })

  it('also keeps a streaming prop visible but disabled', () => {
    expect(button(actionView({ isStreaming: true }), 'chat.rewind.recall').props.disabled).toBe(true)
  })

  it('does not borrow busy state from another session', () => {
    for (const field of ['streamingSessionIds', 'compactingSessionIds', 'stoppingSessionIds', 'rewindingSessionIds']) h.chat[field].add('other')
    h.chat.draftSubmitting.other = true
    expect(button(actionView(), 'chat.rewind.recall').props.disabled).toBeFalsy()
  })

  it('keeps the recall entry disabled with a reason while this chat has queued messages', () => {
    h.chat.queuedMessages[sessionId] = [{ id: 'queued-message' }]
    const recall = button(actionView(), 'chat.rewind.recall')
    expect(recall.props.disabled).toBe(true)
    expect(recall.props['aria-description']).toBe('chat.rewind.busy.queued')
  })
})

describe('rewind preview and committed scope', () => {
  it('blocks a pending queue in an already open dialog', async () => {
    const view = await ready()
    h.chat.queuedMessages[sessionId] = [{ id: 'queued-message' }]
    const updated = dialogView()
    expect(button(updated, 'chat.rewind.confirm').props.disabled).toBe(true)
    button(updated, 'chat.rewind.confirm').props.onClick()
    expect(h.apply).not.toHaveBeenCalled()
    expect(updated.some((node) => node.props.role === 'status' && textOf(node).includes('chat.rewind.busy.queued'))).toBe(true)
  })
  it('identifies the selected historical message, attachments and task mode before confirmation', async () => {
    const props = dialogProps('recall', { anchor: { ...anchor, taskMode: 'plan' } })
    const view = await ready(props)
    const preview = view.find((node) => node.type === 'section' && node.props['aria-label'] === 'chat.rewind.selectedMessage')
    expect(preview).toBeDefined()
    expect(textOf(preview)).toContain(anchor.content)
    expect(textOf(preview)).toContain('note.txt')
    expect(textOf(preview)).toContain('chat.rewind.selectedTaskMode')
    const body = nodes(preview).find((node) => node.type === 'p')
    expect(body?.props.className).toContain('max-h-28')
    expect(body?.props.className).toContain('overflow-y-auto')
  })

  it.each(['recall', 'edit', 'retry'] as const)('defaults %s to conversation only, even with file checkpoints', async (mode) => {
    const view = await ready(dialogProps(mode))
    expect(view.find((node) => node.type === 'input' && node.props.type === 'checkbox')?.props.checked).toBe(false)
    // Show file consequences for the whole tail, while confirmation opts in separately.
    expect(h.preview).toHaveBeenLastCalledWith(sessionId, anchor.id, 'both')
  })

  it('uses workspace scope only for the explicit files action', async () => {
    const view = await ready(dialogProps('files'))
    expect(h.preview).toHaveBeenLastCalledWith(sessionId, anchor.id, 'workspace')
    expect(view.some((node) => node.type === 'input' && node.props.type === 'checkbox')).toBe(false)
  })

  it.each(['recall', 'edit', 'retry', 'files'] as const)('binds %s to its session, displayed history and draft policy', async (mode) => {
    const props = dialogProps(mode)
    const view = await ready(props)
    button(view, confirmLabel(mode)).props.onClick()
    await flush()
    expect(h.apply).toHaveBeenCalledWith(sessionId, anchor.id, mode === 'files' ? 'workspace' : 'conversation', {
      expectedHistoryVersion: 'history-a', restoreDraft: mode === 'recall',
    })
    expect(h.close).toHaveBeenCalledTimes(1)
    if (mode === 'edit' || mode === 'retry') expect(h.resend).toHaveBeenCalledWith('Original request', anchor)
    else expect(h.resend).not.toHaveBeenCalled()
  })

  it('uses both scope only after the user explicitly chooses file rollback', async () => {
    const props = dialogProps()
    const view = await ready(props)
    view.find((node) => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } })
    const selected = await ready(props)
    expect(h.preview).toHaveBeenLastCalledWith(sessionId, anchor.id, 'both')
    button(selected, 'chat.rewind.confirm').props.onClick()
    await flush()
    expect(h.apply).toHaveBeenCalledWith(sessionId, anchor.id, 'both', { expectedHistoryVersion: 'history-a', restoreDraft: true })
  })

  it('uses the shared accessible modal and portals its panel to the body', async () => {
    await ready()
    expect(h.accessibility).toHaveBeenCalled()
    expect(h.portal).toHaveBeenCalledWith(expect.anything(), document.body)
    h.modalClose?.()
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('ignores a late preview from the previous session and submits the displayed new version', async () => {
    const first = deferred<ReturnType<typeof goodPlan>>()
    const second = deferred<ReturnType<typeof goodPlan>>()
    h.preview.mockImplementation((id: string) => id === sessionId ? first.promise : second.promise)
    dialogView(dialogProps())
    const otherProps = dialogProps('recall', { sessionId: 'session-b' })
    dialogView(otherProps)
    second.resolve(goodPlan('history-b'))
    await flush()
    first.resolve(goodPlan('old-history-a'))
    await flush()
    button(dialogView(otherProps), 'chat.rewind.confirm').props.onClick()
    await flush()
    expect(h.apply).toHaveBeenCalledWith('session-b', anchor.id, 'conversation', { expectedHistoryVersion: 'history-b', restoreDraft: true })
  })
})

describe('rewind refusal and interaction guards', () => {
  it('cannot confirm before the preview finishes', () => {
    h.preview.mockReturnValue(new Promise(() => {}))
    const view = dialogView()
    expect(button(view, 'chat.rewind.confirm').props.disabled).toBe(true)
    button(view, 'chat.rewind.confirm').props.onClick()
    expect(h.apply).not.toHaveBeenCalled()
  })

  it.each(['missing', 'rejected'])('keeps the panel open when its preview is %s', async (kind) => {
    if (kind === 'missing') h.preview.mockResolvedValue(null)
    else h.preview.mockRejectedValue(new Error('IPC unavailable'))
    const view = await ready()
    expect(button(view, 'chat.rewind.confirm').props.disabled).toBe(true)
    button(view, 'chat.rewind.confirm').props.onClick()
    expect(textOf(view[0])).toContain('chat.rewind.previewFailed')
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it('falls back to conversation-only recall when the file preview cannot be read', async () => {
    h.preview.mockImplementation((_session: string, _anchor: string, scope: string) => scope === 'both'
      ? Promise.reject(new Error('Workspace unavailable'))
      : Promise.resolve({ ...goodPlan('conversation-history'), safeFiles: [] }))
    const view = await ready()
    expect(h.preview).toHaveBeenCalledWith(sessionId, anchor.id, 'conversation')
    const files = view.find((node) => node.type === 'input' && node.props.type === 'checkbox')!
    expect(files.props.checked).toBe(false)
    expect(files.props.disabled).toBe(true)
    expect(textOf(view[0])).toContain('chat.rewind.filesDisabled.previewUnavailable')
    expect(button(view, 'chat.rewind.confirm').props.disabled).toBeFalsy()
    button(view, 'chat.rewind.confirm').props.onClick()
    await flush()
    expect(h.apply).toHaveBeenCalledWith(sessionId, anchor.id, 'conversation', {
      expectedHistoryVersion: 'conversation-history', restoreDraft: true,
    })
  })

  it('cannot bypass a file conflict with a direct click callback or Ctrl+Enter', async () => {
    h.preview.mockResolvedValue({ ...goodPlan(), canApply: false, safeFiles: [],
      unsafeFiles: [{ path: '/project/a.ts', reason: 'external_modified', action: 'restore', bytes: 3 }] })
    const props = dialogProps('files')
    const view = await ready(props)
    expect(button(view, 'chat.rewind.confirm').props.disabled).toBe(true)
    button(view, 'chat.rewind.confirm').props.onClick()
    view.find((node) => node.props.role === 'dialog')!.props.onKeyDown(keyboard())
    await flush()
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it('still allows conversation-only recall when file changes cannot be restored', async () => {
    h.preview.mockResolvedValue({ ...goodPlan(), canApply: false, gaps: [{ toolName: 'execute_command', reason: 'shell' }] })
    const view = await ready()
    expect(button(view, 'chat.rewind.confirm').props.disabled).toBeFalsy()
    button(view, 'chat.rewind.confirm').props.onClick()
    await flush()
    expect(h.apply).toHaveBeenCalledWith(sessionId, anchor.id, 'conversation', expect.anything())
  })

  it.each([
    { content: 'Existing work' }, { attachments: [{ id: 'draft-file', kind: 'file' }] },
    { taskMode: 'plan' }, { compactMode: true },
  ])('preserves an existing recall draft instead of replacing it: %j', async (draft) => {
    h.chat.drafts[sessionId] = { ...emptyDraft(), ...draft }
    const view = await ready()
    button(view, 'chat.rewind.confirm').props.onClick()
    await flush()
    expect(textOf(dialogView()[0])).toContain('chat.rewind.error.draft-conflict')
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it('does not block recall for a draft owned by another session', async () => {
    h.chat.drafts.other = { ...emptyDraft(), content: 'Other session work' }
    const view = await ready()
    button(view, 'chat.rewind.confirm').props.onClick()
    await flush()
    expect(h.apply).toHaveBeenCalledTimes(1)
  })

  it.each(['streamingSessionIds', 'compactingSessionIds', 'stoppingSessionIds', 'rewindingSessionIds', 'draftSubmitting'])
    ('blocks a session that becomes busy after preview: %s', async (field) => {
      await ready()
      if (field === 'draftSubmitting') h.chat[field][sessionId] = true
      else h.chat[field].add(sessionId)
      const view = dialogView()
      expect(button(view, 'chat.rewind.confirm').props.disabled).toBe(true)
      button(view, 'chat.rewind.confirm').props.onClick()
      view.find((node) => node.props.role === 'dialog')!.props.onKeyDown(keyboard())
      await flush()
      expect(h.apply).not.toHaveBeenCalled()
    })

  it('does not close or submit again while an apply is pending, including backdrop and modal Escape', async () => {
    const pending = deferred<typeof success>()
    h.apply.mockReturnValue(pending.promise)
    const props = dialogProps()
    const confirm = button(await ready(props), 'chat.rewind.confirm').props.onClick
    confirm()
    confirm() // Same-commit double click must be stopped before a rerender.
    await flush()
    const busyView = dialogView(props)
    const cancel = button(busyView, 'chat.rewind.cancel')
    expect(cancel.props.disabled).toBe(true)
    cancel.props.onClick()
    const backdrop = busyView.find((node) => node.type === 'div' && !node.props.role && typeof node.props.onMouseDown === 'function')!
    backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop })
    h.modalClose?.()
    busyView.find((node) => node.props.role === 'dialog')!.props.onKeyDown(keyboard({ key: 'Escape', ctrlKey: false }))
    busyView.find((node) => node.props.role === 'dialog')!.props.onKeyDown(keyboard())
    expect(h.close).not.toHaveBeenCalled()
    expect(h.apply).toHaveBeenCalledTimes(1)
    pending.resolve(success)
    await flush()
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it.each(['history-changed', 'draft-conflict', 'session-busy', 'write-failed', 'truncate-failed'])
    ('shows %s without closing the panel or resending', async (error) => {
      h.apply.mockResolvedValue({ ok: false, error, restored: [], compensated: false, removedMessages: 0 })
      const props = dialogProps('edit')
      button(await ready(props), 'chat.rewind.editConfirm').props.onClick()
      await flush()
      expect(textOf(dialogView(props)[0])).toContain(`chat.rewind.error.${error}`)
      expect(h.close).not.toHaveBeenCalled()
      expect(h.resend).not.toHaveBeenCalled()
      expect(button(dialogView(props), 'chat.rewind.editConfirm').props.disabled).toBeFalsy()
    })

  it('recovers from an IPC rejection without closing or leaving the confirmation busy', async () => {
    h.apply.mockRejectedValue(new Error('IPC disconnected'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      button(await ready(), 'chat.rewind.confirm').props.onClick()
      await flush()
      const view = dialogView()
      expect(button(view, 'chat.rewind.confirm').props.disabled).toBeFalsy()
      expect(h.close).not.toHaveBeenCalled()
      expect(view.some((node) => node.type === 'p' && textOf(node).includes('chat.rewind.error.'))).toBe(true)
    } finally { log.mockRestore() }
  })

  it.each([
    { isComposing: true, nativeEvent: { isComposing: true, keyCode: 13 } },
    { keyCode: 229, nativeEvent: { isComposing: false, keyCode: 229 } },
  ])('leaves Ctrl+Enter to the IME while composition is active: %j', async (ime) => {
    const props = dialogProps('edit')
    const view = await ready(props)
    view.find((node) => node.props.role === 'dialog')!.props.onKeyDown(keyboard(ime))
    await flush()
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
  })

  it('supports deliberate Ctrl+Enter after composition finishes', async () => {
    const props = dialogProps('edit')
    const view = await ready(props)
    view.find((node) => node.props.role === 'dialog')!.props.onKeyDown(keyboard())
    await flush()
    expect(h.apply).toHaveBeenCalledWith(sessionId, anchor.id, 'conversation', { expectedHistoryVersion: 'history-a', restoreDraft: false })
    expect(h.resend).toHaveBeenCalledWith('Original request', anchor)
  })
})
