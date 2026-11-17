import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRow } from '../src/types/ipc'
const h = vi.hoisted(() => ({
  cloud: true,
  connection: 'connected',
  workspace: 'D:\\shared-workspace',
  scope: `${'a'.repeat(32)}:${'b'.repeat(32)}`,
  create: vi.fn(async (_row: unknown) => {}),
  remove: vi.fn(async (_id: string) => {}),
  all: vi.fn(async (): Promise<unknown[]> => []),
  messages: vi.fn(async (_sessionId: string): Promise<MessageRow[]> => []),
  revision: vi.fn(async () => 1),
}))
vi.mock('../src/remote/browser', () => ({ isCloudRemoteMode: () => h.cloud, getRemoteBootstrap: () => ({ workspace: h.workspace }), getRemoteStorageScope: () => h.scope, getRemoteConnection: () => ({ state: h.connection }) }))
vi.mock('../src/lib/ipc-client', () => ({ ipc: {
  platform: () => 'win32', homeDir: () => 'C:\\browser-user',
  dbCreateSession: h.create, dbDeleteSession: h.remove, dbGetAllSessions: h.all,
  dbGetMessages: h.messages, dbGetRecents: async () => [], dbGetRevision: h.revision,
  cancelSessionCommands: async () => ({ killed: 0 }), agentDropSession: () => {}, ckptRemoveSession: async () => {},
} }))
import { prepareCloudSession, useChatStore } from '../src/stores/chat-store'
import { NEW_SESSION_TITLE } from '../src/lib/chat-row'
let stored: Map<string, string>

function historyMessage(sessionId: string): MessageRow {
  return { id: `message-${sessionId}`, session_id: sessionId, role: 'user', content: `History ${sessionId}`, timestamp: 1 }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.cloud = true
  h.connection = 'connected'
  h.workspace = 'D:\\shared-workspace'
  h.scope = `${'a'.repeat(32)}:${'b'.repeat(32)}`
  stored = new Map()
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) })
  h.create.mockResolvedValue(undefined)
  h.all.mockResolvedValue([])
  h.messages.mockResolvedValue([])
  h.revision.mockResolvedValue(1)
  useChatStore.setState({ sessions: [], drafts: {}, draftSubmitting: {}, initialized: false, activeSessionId: null, streamingSessionIds: new Set(), rewindingSessionIds: new Set(), rewindRevisions: {} })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('host-owned cloud session preparation', () => {
  it('keeps the selected host directory and admits only one first-run preparation', async () => {
    const id = useChatStore.getState().createSession({ workingDir: 'C:\\outside' })
    const session = useChatStore.getState().sessions.find(item => item.id === id)!
    expect(session).toMatchObject({ workingDir: 'C:\\outside' })
    expect(session.defaultWorkDir).toContain('clerkbox-work')
    expect(h.create).not.toHaveBeenCalled()
    await Promise.all([prepareCloudSession(id), prepareCloudSession(id)])
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ id, working_dir: 'C:\\outside', default_work_dir: session.defaultWorkDir }))
    await prepareCloudSession(id)
    expect(h.create).toHaveBeenCalledTimes(1)
  })
  it('keeps a failed preparation retryable without claiming that a host session exists', async () => {
    const id = useChatStore.getState().createSession()
    h.create.mockRejectedValueOnce(new Error('offline'))
    await expect(prepareCloudSession(id)).rejects.toThrow('offline')
    await prepareCloudSession(id)
    expect(h.create).toHaveBeenCalledTimes(2)
  })
  it('supports choosing host directories, harness modes and explicitly deleting a conversation', async () => {
    const first = useChatStore.getState().createSession()
    const second = useChatStore.getState().createSession()
    useChatStore.getState().setActiveSession(second)
    useChatStore.getState().updateSessionWorkingDir(second, 'C:\\outside')
    useChatStore.getState().setSessionHarnessMode(second, 'codex')
    expect(useChatStore.getState().sessions.find(item => item.id === second)).toMatchObject({ workingDir: 'C:\\outside', harnessMode: 'codex' })
    useChatStore.getState().deleteSession(second)
    expect(useChatStore.getState().sessions.find(item => item.id === first)).toBeUndefined()
    expect(useChatStore.getState().sessions.find(item => item.id === second)).toBeUndefined()
    expect(h.remove).toHaveBeenCalledWith(second)
    expect(h.create).not.toHaveBeenCalled()
  })
  it('loads scoped history without deleting an empty desktop session and preserves live run state', async () => {
    h.all.mockResolvedValue([{ id: 'host-empty-session', title: NEW_SESSION_TITLE, created_at: 1, updated_at: 1 }])
    useChatStore.setState({ streamingSessionIds: new Set(['host-running-session']) })
    await useChatStore.getState().loadFromDb()
    expect(h.remove).not.toHaveBeenCalled()
    expect(useChatStore.getState().streamingSessionIds.has('host-running-session')).toBe(true)
    expect(useChatStore.getState().sessions[0].defaultWorkDir).toContain('clerkbox-work')
  })
  it('loads 103 cloud histories four at a time and publishes only the complete ordered history without changing drafts', async () => {
    const rows = Array.from({ length: 103 }, (_, index) => ({ id: `history-${index}`, title: `Task ${index}`, created_at: index + 1, updated_at: index % 7 }))
    const releases = new Map<string, () => void>()
    let active = 0
    let maximumActive = 0
    h.all.mockResolvedValue(rows)
    h.messages.mockImplementation((id) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      return new Promise(resolve => releases.set(id, () => { active -= 1; resolve([historyMessage(id)]) }))
    })
    stored.set(`clerkbox:remote-active:${h.scope}`, 'history-72')
    const drafts = { 'history-72': { content: 'Keep my unfinished task', attachments: [{ id: 'file', kind: 'file' as const, name: 'notes.txt', path: 'D:\\notes.txt' }], taskMode: 'plan' as const, compactMode: false } }
    useChatStore.setState({ drafts })
    const loading = useChatStore.getState().loadFromDb()

    for (let start = 0; start < rows.length; start += 4) {
      const end = Math.min(start + 4, rows.length)
      await vi.waitFor(() => expect(h.messages).toHaveBeenCalledTimes(end))
      expect(active).toBe(end - start)
      expect(useChatStore.getState().initialized).toBe(false)
      expect(useChatStore.getState().sessions).toEqual([])
      // Responses arrive in reverse order; their session association and stable tie order must survive.
      for (let index = end - 1; index >= start; index -= 1) releases.get(rows[index].id)!()
    }
    await loading

    const state = useChatStore.getState()
    expect(maximumActive).toBe(4)
    expect(active).toBe(0)
    expect(h.messages.mock.calls.map(([id]) => id)).toEqual(rows.map(row => row.id))
    expect(state.sessions.map(session => session.id)).toEqual([...rows].sort((a, b) => b.updated_at - a.updated_at).map(row => row.id))
    for (const session of state.sessions) expect(session.messages).toEqual([expect.objectContaining({ id: `message-${session.id}`, content: `History ${session.id}` })])
    expect(state.activeSessionId).toBe('history-72')
    expect(state.drafts).toBe(drafts)
    expect(state.initialized).toBe(true)
    expect(h.remove).not.toHaveBeenCalled()
  })
  it('keeps desktop history reads serial and removes legacy empty sessions in the original row order', async () => {
    h.cloud = false
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: `desktop-${index}`, title: index === 0 ? NEW_SESSION_TITLE : `Task ${index}`, created_at: index + 1, updated_at: 1 }))
    const releases = new Map<string, () => void>()
    let active = 0
    let maximumActive = 0
    h.all.mockResolvedValue(rows)
    h.messages.mockImplementation((id) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      return new Promise(resolve => releases.set(id, () => { active -= 1; resolve(id === 'desktop-0' ? [] : [historyMessage(id)]) }))
    })
    const loading = useChatStore.getState().loadFromDb()
    for (let index = 0; index < rows.length; index += 1) {
      await vi.waitFor(() => expect(h.messages).toHaveBeenCalledTimes(index + 1))
      expect(active).toBe(1)
      expect(useChatStore.getState().initialized).toBe(false)
      releases.get(rows[index].id)!()
    }
    await loading
    expect(maximumActive).toBe(1)
    expect(h.messages.mock.calls.map(([id]) => id)).toEqual(rows.map(row => row.id))
    expect(h.remove).toHaveBeenCalledOnce()
    expect(h.remove).toHaveBeenCalledWith('desktop-0')
    expect(useChatStore.getState().sessions.slice(1).map(session => session.id)).toEqual(rows.slice(1).map(row => row.id))
    expect(useChatStore.getState().sessions[0].title).toBe(NEW_SESSION_TITLE)
  })
  it('preserves the cloud legacy-shell policy across a concurrent batch', async () => {
    const rows = [
      { id: 'empty-shell', title: NEW_SESSION_TITLE, created_at: 1, updated_at: 1 },
      { id: 'named-empty', title: 'Named empty task', created_at: 2, updated_at: 2 },
      { id: 'populated-shell', title: NEW_SESSION_TITLE, created_at: 3, updated_at: 3 },
    ]
    h.all.mockResolvedValue(rows)
    h.messages.mockImplementation(async id => id === 'populated-shell' ? [historyMessage(id)] : [])
    stored.set(`clerkbox:remote-active:${h.scope}`, 'named-empty')
    await useChatStore.getState().loadFromDb()
    expect(useChatStore.getState().sessions.map(session => session.id)).toEqual(['populated-shell', 'named-empty'])
    expect(useChatStore.getState().activeSessionId).toBe('named-empty')
    expect(h.remove).not.toHaveBeenCalled()
  })
  it('keeps the existing list, selection and draft intact when a later cloud history batch fails', async () => {
    const id = useChatStore.getState().createSession()
    useChatStore.getState().updateDraft(id, { content: 'Do not lose this draft', taskMode: 'plan' })
    const { sessions, drafts, activeSessionId } = useChatStore.getState()
    const rows = Array.from({ length: 9 }, (_, index) => ({ id: `failure-${index}`, title: `Task ${index}`, created_at: index + 1, updated_at: index + 1 }))
    h.all.mockResolvedValue(rows)
    h.messages.mockImplementation(async sessionId => {
      if (sessionId === 'failure-5') throw new Error('history unavailable')
      return [historyMessage(sessionId)]
    })
    await useChatStore.getState().loadFromDb()
    const state = useChatStore.getState()
    expect(h.messages).toHaveBeenCalledTimes(8)
    expect(state.sessions).toBe(sessions)
    expect(state.activeSessionId).toBe(activeSessionId)
    expect(state.drafts).toBe(drafts)
    expect(state.initialized).toBe(true)
    expect(h.remove).not.toHaveBeenCalled()
  })
  it('restores the selected conversation on reload only from this device scoped history', async () => {
    h.all.mockResolvedValue([{ id: 'history-one', title: 'Earlier task', created_at: 1, updated_at: 1 }, { id: 'history-two', title: 'Current task', created_at: 2, updated_at: 2 }])
    await useChatStore.getState().loadFromDb()
    useChatStore.getState().setActiveSession('history-one')
    expect(stored.get(`clerkbox:remote-active:${h.scope}`)).toBe('history-one')
    const saved = new Map(stored)
    useChatStore.setState({ sessions: [], activeSessionId: null, initialized: false })
    stored = saved // A new document retains sessionStorage while recreating the store.
    await useChatStore.getState().loadFromDb()
    expect(useChatStore.getState().activeSessionId).toBe('history-one')
    expect(useChatStore.getState().sessions.map(session => session.id)).toEqual(['history-two', 'history-one'])
  })
  it('does not restore another device selection or an ID absent from returned scoped sessions', async () => {
    const originalScope = h.scope
    stored.set(`clerkbox:remote-active:${originalScope}`, 'history-one')
    h.scope = `${'a'.repeat(32)}:${'c'.repeat(32)}`
    h.all.mockResolvedValue([{ id: 'history-one', title: 'Authorized history', created_at: 1, updated_at: 1 }])
    await useChatStore.getState().loadFromDb()
    expect(useChatStore.getState().activeSessionId).not.toBe('history-one')
    expect(stored.get(`clerkbox:remote-active:${originalScope}`)).toBe('history-one')
    stored.set(`clerkbox:remote-active:${h.scope}`, 'outside-workspace-session')
    await useChatStore.getState().loadFromDb()
    expect(useChatStore.getState().activeSessionId).not.toBe('outside-workspace-session')
    expect(useChatStore.getState().sessions.some(session => session.id === 'outside-workspace-session')).toBe(false)
  })
  it('keeps desktop startup on a fresh welcome session even when browser selection exists', async () => {
    stored.set(`clerkbox:remote-active:${h.scope}`, 'history-one')
    h.cloud = false
    h.all.mockResolvedValue([{ id: 'history-one', title: 'Desktop history', created_at: 1, updated_at: 1 }])
    await useChatStore.getState().loadFromDb()
    expect(useChatStore.getState().sessions[0]).toMatchObject({ title: NEW_SESSION_TITLE })
    expect(useChatStore.getState().activeSessionId).not.toBe('history-one')
    expect(stored.get(`clerkbox:remote-active:${h.scope}`)).toBe('history-one')
  })
  it('pauses cloud polling while offline and resumes without changing the draft', async () => {
    const id = useChatStore.getState().createSession()
    useChatStore.getState().updateDraft(id, { content: 'Keep my unfinished message' })
    for (const state of ['reconnecting', 'error', 'idle', 'connecting', 'pairing']) {
      h.connection = state
      await useChatStore.getState().syncFromDb()
    }
    expect(h.revision).not.toHaveBeenCalled()
    expect(h.all).not.toHaveBeenCalled()
    expect(useChatStore.getState().drafts[id].content).toBe('Keep my unfinished message')
    h.connection = 'connected'
    h.revision.mockResolvedValue(123)
    await useChatStore.getState().syncFromDb()
    expect(h.all).toHaveBeenCalledOnce()
    expect(useChatStore.getState().drafts[id].content).toBe('Keep my unfinished message')
  })
  it('ignores only expected disconnect failures from an in-flight poll and reports real failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.revision.mockImplementationOnce(async () => { h.connection = 'reconnecting'; throw new Error('remoteAccess.cloudDisconnected') })
    await useChatStore.getState().syncFromDb()
    expect(log).not.toHaveBeenCalled()
    h.connection = 'connected'
    const realError = new Error('database read failed')
    h.revision.mockImplementationOnce(async () => { h.connection = 'reconnecting'; throw realError })
    await useChatStore.getState().syncFromDb()
    expect(log).toHaveBeenCalledWith('[chat-store] syncFromDb failed:', realError)
  })
})
