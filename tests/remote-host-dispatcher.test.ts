import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { ChatStore } from '../electron/db'
import type { AgentSessionManager } from '../electron/agent-host'
import type { RemotePrincipal } from '../src/remote/protocol'
import type { AgentSettings } from '../src/agent-core/ports'
import { createRemoteHostDispatcher, resolveRemoteWorkspacePath } from '../electron/remote-host-dispatcher'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

type Row = Record<string, unknown>
let temp: string
let workspace: string
let outside: string
let rows: Row[]
let active: boolean
let principal: RemotePrincipal
let dispatcher: ReturnType<typeof createRemoteHostDispatcher>
let store: ChatStore
let command: ReturnType<typeof vi.fn>

beforeEach(async () => {
  // Keep the granted root and absolute fixtures canonical on macOS (/var -> /private/var).
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clerkbox-remote-dispatch-')))
  workspace = path.join(temp, 'project')
  outside = path.join(temp, 'project-private')
  await fs.mkdir(workspace)
  await fs.mkdir(outside)
  active = true
  principal = { deviceId: 'phone-1', workspace, control: true, approve: true, files: true, isActive: () => active }
  rows = [
    { id: 's1', title: 'Project', created_at: 1, updated_at: 1, working_dir: workspace, private_metadata: 'never-forward' },
    { id: 's2', title: 'Private', created_at: 1, updated_at: 1, working_dir: outside },
  ]
  store = {
    getAllSessions: vi.fn(async () => rows),
    createSession: vi.fn(async (row: Row) => { rows.push(row) }),
    getMessages: vi.fn(async (id: string) => [{ id: 'm1', session_id: id, content: 'hello', file_checkpoints: 'private-cache-ref', mutation_gaps: 'private-cache-ref' }]),
    getRevision: vi.fn(async () => 5),
    getRecents: vi.fn(async () => ['s1', 's2']),
    updateSessionTitle: vi.fn(async () => undefined),
  } as unknown as ChatStore
  command = vi.fn(async () => ({ ok: true }))
  const manager = {
    setRemoteApprovalProbe: vi.fn(),
    getLocalSettingsSnapshot: () => ({
      model: 'trusted-model', apiKey: 'secret-active', baseUrl: 'https://private-endpoint.invalid',
      apiCompat: 'openai', activeProviderId: 'p1', activeModelId: 'trusted-model',
      providers: [{ id: 'p1', name: 'Local provider', apiKey: 'secret-provider', baseUrl: 'https://private-endpoint.invalid', apiCompat: 'openai', models: [{ id: 'trusted-model', label: 'Trusted model', supportsImages: true }] }],
    } as unknown as AgentSettings),
    handleCommand: command,
    snapshot: (id: string, since: number) => ({ activeRuns: [{ sessionId: id, runId: 'r1', status: 'working' }], queue: { [id]: [] }, pendingPermissions: [], lastSeq: since }),
  } as unknown as AgentSessionManager
  const handlers = new Map([['kvGet', vi.fn(() => JSON.stringify({ state: {
    theme: 'light', language: 'en', apiKey: 'secret-legacy', mcpServers: [{ env: { TOKEN: 'secret-mcp' }, headers: { Authorization: 'secret-header' } }],
    providers: [{ apiKey: 'secret-legacy-provider' }], permissionRules: [{ pattern: 'allow-all' }],
  } }))]])
  dispatcher = createRemoteHostDispatcher({ store, manager, handlers })
})

afterEach(async () => {
  dispatcher.dispose()
  vi.restoreAllMocks()
  await fs.rm(temp, { recursive: true, force: true })
})

describe('public host settings and IPC boundary', () => {
  it('projects known UI and model metadata and never forwards legacy/MCP/provider credentials', async () => {
    const result = await dispatcher.bootstrap(principal)
    expect(result).toMatchObject({ protocolVersion: 1, workspace: await fs.realpath(workspace), capabilities: { files: true, control: true, approve: true }, settings: { theme: 'light', language: 'en', model: 'trusted-model', apiKey: '', baseUrl: '', mcpServers: [], permissionRules: [] } })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/secret-|private-endpoint|allow-all/)
    const persisted = JSON.parse(await dispatcher.invoke(principal, 'kvGet', ['clerkbox-settings']) as string)
    expect(persisted.state.providers[0]).toMatchObject({ name: 'Local provider', apiKey: '', baseUrl: '' })
    expect(persisted.state.providers[0].models[0].supportsImages).toBe(true)
    expect(await dispatcher.invoke(principal, 'kvGet', ['clerkbox-account'])).toBeNull()
  })

  it.each(['kvSet', 'kvRemove', 'loadApiKeys', 'executeCommand', 'apiFetchModels', 'apiChatStream', 'accountSyncDownload', 'mcpCallTool', 'dbAddMessage', 'dbClearMessages', 'dbDeleteSession'])('refuses arbitrary IPC method %s', async (method) => {
    await expect(dispatcher.invoke(principal, method, [])).rejects.toThrow('remote-forbidden-method')
  })

  it('revoked devices cannot read settings, messages or events', async () => {
    active = false
    await expect(dispatcher.bootstrap(principal)).rejects.toThrow('remote-disconnected')
    await expect(dispatcher.invoke(principal, 'dbGetMessages', ['s1'])).rejects.toThrow('remote-disconnected')
    expect(await dispatcher.filterEvent(principal, { seq: 1, event: { type: 'run.completed', sessionId: 's1', runId: 'r1' } })).toBeNull()
  })
})

describe('workspace and session isolation', () => {
  it('filters session lists, recents, snapshots and events to the granted workspace', async () => {
    expect(await dispatcher.invoke(principal, 'dbGetAllSessions')).toEqual([{ id: 's1', title: 'Project', created_at: 1, updated_at: 1, working_dir: workspace, default_work_dir: null, harness_mode: 'default' }])
    expect(await dispatcher.invoke(principal, 'dbGetRecents')).toEqual(['s1'])
    const snapshot = await dispatcher.invoke(principal, 'agent:snapshot', [undefined, 7])
    expect(snapshot).toMatchObject({ activeRuns: [{ sessionId: 's1' }], queue: { s1: [] }, lastSeq: 7 })
    expect(await dispatcher.invoke(principal, 'agent:snapshot', [null, 7])).toEqual(snapshot)
    await expect(dispatcher.invoke(principal, 'dbGetMessages', ['s2'])).rejects.toThrow('remote-session-unavailable')
    expect(await dispatcher.filterEvent(principal, { seq: 1, event: { type: 'run.completed', sessionId: 's2', runId: 'r1' } })).toBeNull()
    expect(await dispatcher.filterEvent(principal, { seq: 1, event: { type: 'run.completed', sessionId: 's1', runId: 'r1' } })).toMatchObject({ seq: 1 })
    expect(await dispatcher.invoke(principal, 'dbGetMessages', ['s1'])).toEqual([{ id: 'm1', session_id: 's1', content: 'hello' }])
  })

  it('prepares a host-owned session row and rejects cross-workspace paths or ID takeover', async () => {
    await dispatcher.invoke(principal, 'dbCreateSession', [{ id: 'new-session', title: 'New', created_at: -1, default_work_dir: outside, apiKey: 'injected' }])
    expect(vi.mocked(store.createSession).mock.calls[0][0]).toMatchObject({ id: 'new-session', title: 'New', working_dir: await fs.realpath(workspace), default_work_dir: await fs.realpath(workspace) })
    expect(vi.mocked(store.createSession).mock.calls[0][0]).not.toHaveProperty('apiKey')
    await expect(dispatcher.invoke(principal, 'dbCreateSession', [{ id: 'bad', working_dir: outside }])).rejects.toThrow('remote-outside-workspace')
    await expect(dispatcher.invoke(principal, 'dbCreateSession', [{ id: 's2', working_dir: workspace }])).rejects.toThrow('remote-session-unavailable')
  })

  it('rejects prefix tricks, traversal, and symlink/junction escapes even for missing children', async () => {
    await fs.symlink(outside, path.join(workspace, 'escape'), 'junction')
    await expect(resolveRemoteWorkspacePath(principal, outside, true)).rejects.toThrow('remote-outside-workspace')
    await expect(resolveRemoteWorkspacePath(principal, '../project-private', true)).rejects.toThrow('remote-outside-workspace')
    await expect(resolveRemoteWorkspacePath(principal, 'escape/missing/file', true)).rejects.toThrow('remote-outside-workspace')
    await expect(dispatcher.invoke(principal, 'readFile', [path.join(workspace, 'escape', 'secret')])).rejects.toThrow('remote-outside-workspace')
    await expect(resolveRemoteWorkspacePath(principal, 'new/nested', true)).resolves.toBe(path.join(await fs.realpath(workspace), 'new', 'nested'))
  })

  it('files need a separate capability, previews are bounded, and missing file checks return false', async () => {
    await fs.writeFile(path.join(workspace, 'hello.txt'), 'hello')
    await expect(dispatcher.invoke({ ...principal, files: false }, 'readFile', [path.join(workspace, 'hello.txt')])).rejects.toThrow('remote-files-disabled')
    expect(await dispatcher.invoke(principal, 'readFile', [path.join(workspace, 'hello.txt')])).toBe('hello')
    expect(await dispatcher.invoke(principal, 'fileExists', [path.join(workspace, 'missing.txt')])).toBe(false)
    await fs.writeFile(path.join(workspace, 'large.txt'), Buffer.alloc(256 * 1024 + 1))
    await expect(dispatcher.invoke(principal, 'readFile', [path.join(workspace, 'large.txt')])).rejects.toThrow('remote-preview-too-large')
  })
})

describe('validated command capabilities', () => {
  it('passes only an allowlisted command and the trusted paired principal to the host', async () => {
    expect(await dispatcher.invoke(principal, 'agent:host-mode')).toBe('main')
    await dispatcher.invoke(principal, 'agent:command', [{ type: 'run', sessionId: 's1', content: 'hello', taskMode: 'plan' }])
    expect(command).toHaveBeenCalledWith({ type: 'run', sessionId: 's1', content: 'hello', taskMode: 'plan', attachments: undefined }, { remote: true, pairedRemote: principal })
    await expect(dispatcher.invoke(principal, 'agent:command', [{ type: 'run', sessionId: 's1', content: 'hello', settings: { apiKey: 'attack' } }])).rejects.toThrow('remote-invalid-arguments')
    await expect(dispatcher.invoke(principal, 'agent:command', [{ type: 'run', sessionId: 's1', content: 'hello', skillReminder: 'injected' }])).rejects.toThrow('remote-invalid-arguments')
    await expect(dispatcher.invoke(principal, 'agent:command', [{ type: 'rewind.apply', sessionId: 's1' }])).rejects.toThrow('remote-forbidden-command')
    await expect(dispatcher.invoke(principal, 'agent:command', [{ type: 'abort', sessionId: 's2' }])).rejects.toThrow('remote-session-unavailable')
  })

  it('read-only clients cannot run or mutate and remote approvals are once-only', async () => {
    const reader = { ...principal, control: false, approve: false }
    await expect(dispatcher.invoke(reader, 'agent:command', [{ type: 'abort', sessionId: 's1' }])).rejects.toThrow('remote-control-disabled')
    await expect(dispatcher.invoke(reader, 'dbCreateSession', [{ id: 'new' }])).rejects.toThrow('remote-control-disabled')
    const approval = { type: 'permission.resolve', sessionId: 's1', requestId: 'pending-1', approved: true }
    await expect(dispatcher.invoke({ ...principal, approve: false }, 'agent:command', [approval])).rejects.toThrow('remote-approval-disabled')
    await expect(dispatcher.invoke(principal, 'agent:command', [{ ...approval, scope: 'session' }])).rejects.toThrow('remote-invalid-arguments')
    await dispatcher.invoke(principal, 'agent:command', [approval])
    expect(command.mock.calls.at(-1)?.[0]).toEqual({ ...approval, scope: 'once' })
  })

  it('does not accept arbitrary host attachment paths or oversized question payloads', async () => {
    await fs.writeFile(path.join(outside, 'private.txt'), 'private')
    await expect(dispatcher.invoke(principal, 'agent:command', [{ type: 'run', sessionId: 's1', content: 'read', attachments: [{ id: 'a1', kind: 'file', name: 'private', path: path.join(outside, 'private.txt') }] }])).rejects.toThrow('remote-outside-workspace')
    await expect(dispatcher.invoke(principal, 'agent:command', [{ type: 'question.resolve', sessionId: 's1', requestId: 'q1', payload: { answer: 'not-an-array' } }])).rejects.toThrow('remote-invalid-arguments')
  })
})

describe('bounded chunked uploads', () => {
  it('streams multiple chunks with device binding, ordering and one successful finalize', async () => {
    const bytes = Buffer.alloc(1024 * 1024 + 9, 73)
    const result = await dispatcher.invoke(principal, 'remote:upload.start', [{ name: 'sample.bin', size: bytes.length }]) as { uploadId: string; chunkBytes: number }
    expect(result.chunkBytes).toBe(128 * 1024)
    await expect(dispatcher.invoke(principal, 'remote:upload.finish', [result.uploadId])).rejects.toThrow('remote-upload-incomplete')
    await expect(dispatcher.invoke({ ...principal, deviceId: 'phone-2' }, 'remote:upload.chunk', [result.uploadId, 0, 'YQ=='])).rejects.toThrow('remote-upload-unavailable')
    await expect(dispatcher.invoke(principal, 'remote:upload.chunk', [result.uploadId, 1, 'YQ=='])).rejects.toThrow('remote-upload-chunk-order')
    let index = 0
    for (let offset = 0; offset < bytes.length; offset += result.chunkBytes) {
      const chunk = bytes.subarray(offset, offset + result.chunkBytes)
      const ack = await dispatcher.invoke(principal, 'remote:upload.chunk', [result.uploadId, index++, chunk.toString('base64')])
      expect(ack).toMatchObject({ nextIndex: index })
    }
    const finished = await dispatcher.invoke(principal, 'remote:upload.finish', [result.uploadId]) as { path: string; size: number }
    expect(finished.size).toBe(bytes.length)
    expect(await fs.readFile(finished.path)).toEqual(bytes)
    await expect(dispatcher.invoke(principal, 'remote:upload.finish', [result.uploadId])).rejects.toThrow('remote-upload-unavailable')
  })

  it('serializes concurrent chunks and reservations instead of duplicating data or overbooking quota', async () => {
    const start = await dispatcher.invoke(principal, 'remote:upload.start', [{ name: 'one.bin', size: 2 }]) as { uploadId: string }
    const results = await Promise.allSettled([
      dispatcher.invoke(principal, 'remote:upload.chunk', [start.uploadId, 0, 'YQ==']),
      dispatcher.invoke(principal, 'remote:upload.chunk', [start.uploadId, 0, 'YQ==']),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const reservations = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => dispatcher.invoke(principal, 'remote:upload.start', [{ name: `quota-${i}.bin`, size: 10 * 1024 * 1024 }])))
    // The two-byte existing reservation also counts toward the 50 MiB cap.
    expect(reservations.filter((r) => r.status === 'fulfilled')).toHaveLength(4)
  })

  it('expires abandoned transfers and rejects chunks after revocation', async () => {
    const start = await dispatcher.invoke(principal, 'remote:upload.start', [{ name: 'stale.bin', size: 1 }]) as { uploadId: string }
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000)
    await expect(dispatcher.invoke(principal, 'remote:upload.chunk', [start.uploadId, 0, 'YQ=='])).rejects.toThrow('remote-upload-unavailable')
    expect(await fs.readdir(path.join(workspace, '.clerkbox', 'remote-uploads'))).toEqual([])
    active = false
    await expect(dispatcher.invoke(principal, 'remote:upload.start', [{ name: 'no.bin', size: 1 }])).rejects.toThrow('remote-disconnected')
  })
})
