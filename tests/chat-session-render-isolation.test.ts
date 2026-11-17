import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/types/agent'

const h = vi.hoisted(() => ({
  activeSessionId: 'a',
  sessions: [] as Array<{ id: string; messages: Message[] }>,
  streamingSessionIds: new Set<string>(),
  initialized: true,
  cloudRemote: false,
}))

// Inspect ChatPage's real child identities without mounting Electron-only descendants.
// Sibling key collisions are a reconciliation defect even when a single render looks correct.
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: vi.fn(),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/stores/chat-store', () => ({
  useChatStore: Object.assign((select: (state: unknown) => unknown) => select({
    sessions: h.sessions,
    activeSessionId: h.activeSessionId,
    streamingSessionIds: h.streamingSessionIds,
    initialized: h.initialized,
  }), { getState: () => ({ streamingSessionIds: h.streamingSessionIds }) }),
  getSessionAbortController: () => undefined,
}))
vi.mock('../src/stores/settings-store', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select({
    interfaceMode: 'coding', baseUrl: 'https://model.example/v1', model: 'model', providers: [],
  }),
}))
vi.mock('../src/stores/skills-store', () => ({ useSkillsStore: (select: (state: unknown) => unknown) => select({}) }))
vi.mock('../src/stores/ui-store', () => ({ useUIStore: { getState: () => ({}) } }))
vi.mock('../src/hooks/use-agent', () => ({ useAgent: () => ({ isCompacting: false, isStopping: false }) }))
vi.mock('../src/lib/ipc-client', () => ({ ipc: {}, isWebUIMode: false }))
vi.mock('../src/remote/browser', () => ({ isCloudRemoteMode: () => h.cloudRemote, getRemoteConnection: () => ({ state: 'connected' }) }))
vi.mock('../src/components/chat/MessageList', () => ({ default: () => null }))
vi.mock('../src/components/chat/ChatInput', () => ({ default: () => null }))
vi.mock('../src/components/chat/ModelSetupGuidance', () => ({ default: () => null }))
vi.mock('../src/components/chat/ThemeWaves', () => ({ default: () => null }))
vi.mock('../src/components/chat/QuestionCard', () => ({ default: () => null }))
vi.mock('../src/components/chat/TodoListCard', () => ({ default: () => null }))
vi.mock('../src/components/chat/GoalBanner', () => ({ default: () => null }))
vi.mock('../src/components/chat/ChatErrorBanner', () => ({ default: () => null }))
vi.mock('../src/components/chat/RewindDialog', () => ({ default: () => null }))
vi.mock('../src/components/chat/PermissionCard', () => ({ PermissionApprovalCard: () => null }))

import ChatPage from '../src/components/chat/ChatPage'
import ChatInput from '../src/components/chat/ChatInput'
import MessageList from '../src/components/chat/MessageList'

type Element = ReactElement<Record<string, any>>
function nodes(root: ReactNode): Element[] {
  if (Array.isArray(root)) return root.flatMap(nodes)
  if (!isValidElement<Record<string, any>>(root)) return []
  return [root, ...nodes(root.props.children)]
}
function render(vibe: boolean) { return nodes(ChatPage({ vibe })) }
function message(id: string, role: 'user' | 'assistant' = 'user'): Message {
  return { id, role, content: id, timestamp: 1 }
}
function keyedChildren(node: Element) {
  const children = Array.isArray(node.props.children) ? node.props.children.flat(Infinity) : [node.props.children]
  return children.filter((child: unknown): child is Element => isValidElement(child) && child.key !== null)
}
function identity(view: Element[]) {
  const list = view.find((node) => node.type === MessageList)
  const input = view.find((node) => node.type === ChatInput)
  expect(list).toBeDefined()
  expect(input).toBeDefined()
  return { list: list!, input: input! }
}

beforeEach(() => {
  h.activeSessionId = 'a'
  h.initialized = true
  h.cloudRemote = false
  h.streamingSessionIds = new Set()
  h.sessions = [
    { id: 'a', messages: [message('a-user'), message('a-assistant', 'assistant')] },
    { id: 'b', messages: [message('b-user'), message('b-assistant', 'assistant')] },
    { id: 'new', messages: [] },
  ]
})

describe('remote composer startup ownership', () => {
  it('keeps uploads and input unavailable while asynchronous history is still loading', async () => {
    h.cloudRemote = true
    h.initialized = false
    h.activeSessionId = ''
    h.sessions = []
    let finishHistory!: () => void
    const history = new Promise<void>((resolve) => { finishHistory = resolve }).then(() => {
      h.sessions = [{ id: 'restored', messages: [message('history')] }]
      h.activeSessionId = 'restored'
      h.initialized = true
    })

    const pending = render(false)
    expect(pending.some((node) => node.type === ChatInput)).toBe(false)
    expect(pending.some((node) => node.props.role === 'status' && node.props['aria-busy'] === 'true')).toBe(true)
    finishHistory()
    await history

    const ready = render(false).filter((node) => node.type === ChatInput)
    expect(ready).toHaveLength(1)
    expect(ready[0].props.sessionId).toBe('restored')
  })

  it.each(['', 'missing'])('requires a valid selected session after remote initialization (active=%s)', (active) => {
    h.cloudRemote = true
    h.activeSessionId = active
    expect(render(false).some((node) => node.type === ChatInput)).toBe(false)
  })

  it('preserves the existing desktop empty composer during local startup', () => {
    h.initialized = false
    h.activeSessionId = ''
    h.sessions = []
    expect(render(false).some((node) => node.type === ChatInput)).toBe(true)
  })
})

describe.each([false, true])('chat render ownership (vibe=%s)', (vibe) => {
  it('never gives two direct siblings the same React key', () => {
    for (const parent of render(vibe)) {
      const keys = keyedChildren(parent).map((child: Element) => child.key)
      expect(new Set(keys).size, `duplicate sibling keys: ${keys.join(', ')}`).toBe(keys.length)
    }
  })

  it('keeps list and composer identities distinct, stable within a session, and renewed on a session switch', () => {
    const a = identity(render(vibe))
    expect(a.list.key).not.toBe(a.input.key)
    expect(a.list.key).not.toBeNull()
    expect(a.input.key).not.toBeNull()

    h.sessions[0].messages = [...h.sessions[0].messages, message('a-more', 'assistant')]
    const updated = identity(render(vibe))
    expect(updated.list.key).toBe(a.list.key)
    expect(updated.input.key).toBe(a.input.key)

    h.activeSessionId = 'b'
    const b = identity(render(vibe))
    expect(b.list.key).not.toBe(a.list.key)
    expect(b.input.key).not.toBe(a.input.key)
    expect(b.list.key).not.toBe(b.input.key)
  })

  it.each(['ordinary', 'long', 'streaming'])('has one composer and no old list after %s chats are switched repeatedly and a new chat opens', (mode) => {
    if (mode === 'long') {
      h.sessions[0].messages = Array.from({ length: 160 }, (_, index) => message(`a-${index}`, index % 2 ? 'assistant' : 'user'))
    }
    if (mode === 'streaming') h.streamingSessionIds.add('a')

    for (const sessionId of ['a', 'b', 'a', 'b', 'a', 'new']) {
      h.activeSessionId = sessionId
      const view = render(vibe)
      const inputs = view.filter((node) => node.type === ChatInput)
      const lists = view.filter((node) => node.type === MessageList)
      expect(inputs).toHaveLength(1)
      expect(inputs[0].props.sessionId).toBe(sessionId)
      if (sessionId === 'new') {
        expect(lists).toHaveLength(0)
        expect(inputs[0].props.variant).toBe(vibe ? 'default' : 'welcome')
      } else {
        expect(lists).toHaveLength(1)
        expect(lists[0].props.sessionId).toBe(sessionId)
        expect(lists[0].props.messages).toBe(h.sessions.find((session) => session.id === sessionId)!.messages)
        expect(lists[0].props.isStreaming).toBe(h.streamingSessionIds.has(sessionId))
      }
    }
  })
})
