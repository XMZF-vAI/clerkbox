import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { ChatStore } from '../electron/db'
import type { AgentPorts, AgentSettings } from '../src/agent-core/ports'
import type { RemotePrincipal } from '../src/remote/protocol'
import type { SessionContext } from '../src/agent-core/session-context'
import type { Message } from '../src/types/agent'

const h = vi.hoisted(() => ({
  runs: [] as Array<{ ports: AgentPorts; ctx: SessionContext; messages: Message[]; finish: () => void }>,
  nextId: 0,
  buildMemoryPrompt: vi.fn(async () => 'private-global-memory'),
  findAgent: vi.fn(async () => null),
}))
vi.mock('../electron/api-proxy', () => ({ startChatStream: vi.fn(), abortChatStream: vi.fn() }))
vi.mock('../src/agent-core/loop', () => ({
  makeId: () => `remote-test-${++h.nextId}`,
  runReactLoop: (ports: AgentPorts, ctx: SessionContext, messages: Message[], controller: AbortController) => new Promise<void>((resolve) => {
    const finish = () => { controller.signal.removeEventListener('abort', finish); resolve() }
    controller.signal.addEventListener('abort', finish, { once: true })
    h.runs.push({ ports, ctx, messages, finish })
  }),
}))
vi.mock('../src/lib/tool-registry', () => ({
  // Simulate a shared registry with every global capability enabled by another local run.
  toolRegistry: { getDefinitionsForMode: () => ['read_file', 'search_memory', 'save_memory', 'mcp__private__query', 'scheduled_task', 'spawn_agent', 'send_message_to_agent', 'create_workflow', 'save_workflow', 'resume_workflow', 'browser_navigate', 'computer_screenshot', 'app_list_sessions', 'future_global_tool'].map((name) => ({ name })), setAgentActionCapabilities: () => {}, execute: vi.fn(async () => 'ok') },
}))
vi.mock('../src/lib/agent-registry', () => ({ findAgent: h.findAgent }))
vi.mock('../src/lib/memory', () => ({
  buildMemoryPrompt: h.buildMemoryPrompt, MAX_MEMORY_BYTES: 25000, MAX_MEMORY_LINES: 200,
}))

import { AgentSessionManager, resolveAgentHostMode, setRuntimeAgentHostMode, setAgentHostWindowProbeForTest } from '../electron/agent-host'
import { toolRegistry } from '../src/lib/tool-registry'
import { ipc } from '../src/lib/ipc-client'

let temp: string
let workspace: string
let outside: string
let active: boolean
let principal: RemotePrincipal
let manager: AgentSessionManager
let store: ChatStore
const settings: AgentSettings = {
  model: 'trusted-model', baseUrl: 'https://trusted.invalid/v1', apiKey: 'local-secret', apiCompat: 'openai',
  providers: [], temperature: 0.7, maxTokens: 1000, maxInputTokens: 184000, enableThinking: false,
  directFetch: false, approvalMode: 'full', browserUseEnabled: true, computerUseEnabled: true,
  agentsMdEnabled: false, claudeMdCompat: false, permissionRules: [],
}

beforeEach(async () => {
  // macOS temp paths may use /var while realpath resolves them through /private/var.
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clerkbox-remote-agent-')))
  workspace = path.join(temp, 'workspace')
  outside = path.join(temp, 'outside')
  await fs.mkdir(workspace)
  await fs.mkdir(outside)
  active = true
  principal = { deviceId: 'paired-phone', workspace, control: true, approve: true, files: true, isActive: () => active }
  const messages: Record<string, unknown>[] = []
  store = {
    getAllSessions: vi.fn(async () => [{ id: 's1', title: 'Remote', working_dir: workspace, created_at: 1, updated_at: 1 }, { id: 's2', title: 'Private', working_dir: outside, created_at: 1, updated_at: 1 }]),
    getMessages: vi.fn(async (sid: string) => messages.filter((row) => row.session_id === sid)),
    addMessage: vi.fn(async (row: Record<string, unknown>) => { messages.push(row) }),
    updateMessage: vi.fn(async () => {}),
    compactMessages: vi.fn(async () => {}),
  } as unknown as ChatStore
  h.runs.length = 0
  h.nextId = 0
  vi.mocked(toolRegistry.execute).mockClear()
  h.buildMemoryPrompt.mockClear()
  h.findAgent.mockClear()
  manager = new AgentSessionManager(store)
  manager.noteLocalSettings(settings)
  setAgentHostWindowProbeForTest(() => [])
})

afterEach(async () => {
  manager.dropSession('s1')
  manager.dropSession('s2')
  for (const run of h.runs) run.finish()
  await Promise.resolve()
  setRuntimeAgentHostMode(null)
  setAgentHostWindowProbeForTest(null)
  await fs.rm(temp, { recursive: true, force: true })
})

const idle = () => vi.waitFor(() => expect(manager.inspect().every((s) => !s.hasRun)).toBe(true))
const paired = () => ({ remote: true, pairedRemote: principal })
const lastUserText = (run: typeof h.runs[number]) => run.messages.filter((message) => message.role === 'user').at(-1)?.content

describe('desktop and paired device concurrency', () => {
  it('serializes two devices starting the same idle session after asynchronous validation', async () => {
    const results = await Promise.all([
      manager.handleCommand({ type: 'run', sessionId: 's1', content: 'phone-one' }, paired()),
      manager.handleCommand({ type: 'run', sessionId: 's1', content: 'phone-two' }, { remote: true, pairedRemote: { ...principal, deviceId: 'second-phone' } }),
    ])
    expect(results).toEqual([{ ok: true }, { ok: true }])
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    expect(manager.inspect()[0]).toMatchObject({ hasRun: true, queued: 1 })
    h.runs[0].finish()
    await vi.waitFor(() => expect(h.runs).toHaveLength(2))
    expect(manager.inspect()[0]).toMatchObject({ hasRun: true, queued: 0 })
    h.runs[1].finish()
    await idle()
    expect(h.runs.map(lastUserText).sort()).toEqual(['phone-one', 'phone-two'])
  })

  it('admits one run and queues concurrent desktop and two-device messages exactly once', async () => {
    const phone2 = { ...principal, deviceId: 'second-phone' }
    const results = await Promise.all([
      manager.handleCommand({ type: 'run', sessionId: 's1', content: 'desktop', settings }),
      manager.handleCommand({ type: 'run', sessionId: 's1', content: 'phone-one' }, paired()),
      manager.handleCommand({ type: 'run', sessionId: 's1', content: 'phone-two' }, { remote: true, pairedRemote: phone2 }),
    ])
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }])
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    expect(manager.inspect()[0]).toMatchObject({ hasRun: true, queued: 2 })
    h.runs[0].finish()
    await vi.waitFor(() => expect(h.runs).toHaveLength(2))
    expect(manager.inspect()[0]).toMatchObject({ hasRun: true, queued: 1 })
    h.runs[1].finish()
    await vi.waitFor(() => expect(h.runs).toHaveLength(3))
    expect(manager.inspect()[0]).toMatchObject({ hasRun: true, queued: 0 })
    h.runs[2].finish()
    await idle()
    expect(h.runs.map(lastUserText).sort()).toEqual(['desktop', 'phone-one', 'phone-two'])
    expect(h.runs.slice(1).every((run) => run.ports.settings.approvalMode === 'manual')).toBe(true)
  })

  it('deduplicates a queue item retried by two devices while busy and after execution', async () => {
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'desktop', settings })
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    const command = { type: 'queue.enqueue' as const, sessionId: 's1', item: { id: 'shared-message-id', content: 'send-once', queuedAt: 1 } }
    await Promise.all([
      manager.handleCommand(command, paired()),
      manager.handleCommand(command, { remote: true, pairedRemote: { ...principal, deviceId: 'second-phone' } }),
    ])
    expect(manager.snapshot('s1').queue.s1).toHaveLength(1)
    h.runs[0].finish()
    await vi.waitFor(() => expect(h.runs).toHaveLength(2))
    h.runs[1].finish()
    await idle()
    expect(await manager.handleCommand(command, paired())).toEqual({ ok: true })
    expect(h.runs).toHaveLength(2)
    expect(manager.snapshot('s1').queue.s1).toEqual([])
    expect(lastUserText(h.runs[1])).toBe('send-once')
  })

  it('reserves the same queue head across remote admission IO and keeps later desktop work in order', async () => {
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'initial', settings })
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    for (const id of ['queued-one', 'queued-two']) {
      await manager.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id, content: id, queuedAt: 1 } }, paired())
    }
    const rows = await store.getAllSessions()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let pending = false
    vi.mocked(store.getAllSessions).mockImplementationOnce(async () => { pending = true; await gate; return rows })
    h.runs[0].finish()
    await vi.waitFor(() => expect(pending).toBe(true))
    try {
      expect(manager.snapshot('s1').queue.s1.map((item) => item.id)).toEqual(['queued-one', 'queued-two'])
      await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'later-desktop', settings })
      await manager.handleCommand({ type: 'queue.flush', sessionId: 's1' })
      expect(h.runs).toHaveLength(1)
      expect(manager.snapshot('s1').queue.s1.slice(0, 2).map((item) => item.id)).toEqual(['queued-one', 'queued-two'])
    } finally { release() }
    for (let index = 1; index <= 3; index++) {
      await vi.waitFor(() => expect(h.runs).toHaveLength(index + 1))
      h.runs[index].finish()
    }
    await idle()
    expect(h.runs.map(lastUserText)).toEqual(['initial', 'queued-one', 'queued-two', 'later-desktop'])
  })

  it('honors another device removing a queued message while remote admission is pending', async () => {
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'initial', settings })
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    await manager.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: 'cancel-me', content: 'never-execute', queuedAt: 1 } }, paired())
    const rows = await store.getAllSessions()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let pending = false
    vi.mocked(store.getAllSessions).mockImplementationOnce(async () => { pending = true; await gate; return rows })
    h.runs[0].finish()
    await vi.waitFor(() => expect(pending).toBe(true))
    try {
      expect(await manager.handleCommand({ type: 'queue.remove', sessionId: 's1', id: 'cancel-me' })).toEqual({ ok: true })
      await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'replacement', settings })
    } finally { release() }
    await vi.waitFor(() => expect(h.runs).toHaveLength(2))
    expect(lastUserText(h.runs[1])).toBe('replacement')
    h.runs[1].finish()
    await idle()
    expect(h.runs.map(lastUserText)).not.toContain('never-execute')
  })

  it('does not resurrect a session deleted during remote admission or on a retried command', async () => {
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'initial', settings })
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    await manager.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: 'queued', content: 'never-execute', queuedAt: 1 } }, paired())
    const rows = await store.getAllSessions()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let pending = false
    vi.mocked(store.getAllSessions).mockImplementationOnce(async () => { pending = true; await gate; return rows })
    h.runs[0].finish()
    await vi.waitFor(() => expect(pending).toBe(true))
    manager.dropSession('s1')
    release()
    await idle()
    expect(await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'retry', settings })).toEqual({ ok: false, error: 'session-dropped' })
    expect(h.runs).toHaveLength(1)
    expect(manager.inspect()).toEqual([])
  })
})

describe('paired remote agent source and permissions', () => {
  it('starts a new remote session from the trusted desktop configuration and never accepts remote connection settings', async () => {
    const result = await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'hello', settings: { ...settings, apiKey: 'attacker', baseUrl: 'https://attacker.invalid' } }, paired())
    expect(result).toEqual({ ok: true })
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    expect(h.runs[0].ports.settings).toMatchObject({ apiKey: 'local-secret', baseUrl: 'https://trusted.invalid/v1', approvalMode: 'manual', browserUseEnabled: false, computerUseEnabled: false, permissionRules: [] })
    expect(manager.getLocalSettingsSnapshot()?.approvalMode).toBe('full')
    h.runs[0].finish()
    await idle()
  })

  it('retains source restrictions when a remote item waits behind a local full-mode run', async () => {
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'local', settings })
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    await manager.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: 'q1', content: 'remote', queuedAt: 1 } }, paired())
    h.runs[0].finish()
    await vi.waitFor(() => expect(h.runs).toHaveLength(2))
    expect(h.runs[1].ports.settings.approvalMode).toBe('manual')
    expect(manager.getLocalSettingsSnapshot()?.approvalMode).toBe('full')
    expect(JSON.stringify(manager.snapshot('s1'))).not.toContain('paired-phone')
    h.runs[1].finish()
    await idle()
  })

  it('can run a first queued message and discards queued commands from a revoked device', async () => {
    await manager.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: 'q1', content: 'first', queuedAt: 1 } }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    expect(h.runs[0].ports.settings.approvalMode).toBe('manual')
    await manager.handleCommand({ type: 'queue.enqueue', sessionId: 's1', item: { id: 'q2', content: 'revoked', queuedAt: 2 } }, paired())
    active = false
    h.runs[0].finish()
    await idle()
    expect(h.runs).toHaveLength(1)
    expect(manager.inspect()[0].queued).toBe(0)
  })

  it('keeps the remote origin for background wake and rechecks revocation', async () => {
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'remote' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    h.runs[0].finish()
    await idle()
    const ctx = h.runs[0].ctx
    ctx.pendingSubagentNotifications.push({ message: 'finished' } as never)
    ctx.requestWake?.()
    await vi.waitFor(() => expect(h.runs).toHaveLength(2))
    expect(h.runs[1].ports.settings.approvalMode).toBe('manual')
    h.runs[1].finish()
    await idle()
    active = false
    ctx.requestWake?.()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.runs).toHaveLength(2)
  })

  it('enforces workspace and active control again at the host boundary', async () => {
    expect(await manager.handleCommand({ type: 'abort', sessionId: 's2' }, paired())).toEqual({ ok: false, error: 'remote-outside-workspace' })
    expect(await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'no' }, { remote: true, pairedRemote: { ...principal, control: false } })).toEqual({ ok: false, error: 'remote-control-disabled' })
    active = false
    expect(await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'no' }, paired())).toEqual({ ok: false, error: 'remote-disconnected' })
    expect(h.runs).toHaveLength(0)
  })

  it('checks model-generated filesystem paths and forbids global app management', async () => {
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'remote' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    const ports = h.runs[0].ports
    await expect(ports.tools.execute('read_file', { path: path.join(outside, 'secret') }, {} as never)).rejects.toThrow('remote-outside-workspace')
    await expect(ports.tools.execute('app_list_sessions', {}, {} as never)).rejects.toThrow('remote-app-management-disabled')
    await expect(ports.tools.execute('read_file', { path: path.join(workspace, 'project.txt') }, {} as never)).resolves.toBe('ok')
    expect(toolRegistry.execute).toHaveBeenCalledTimes(1)
    h.runs[0].finish()
    await idle()
  })

  it('hides and rejects implicit global/cloud memory tools at the paired host boundary', async () => {
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'memory' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    const ports = h.runs[0].ports
    expect(ports.tools.definitions('default').map((tool) => tool.name)).toEqual(['read_file'])
    expect(ports.env.homeDir()).toBe('')
    await expect(ports.tools.execute('search_memory', {}, {} as never)).rejects.toThrow('remote-global-memory-disabled')
    await expect(ports.tools.execute('save_memory', { scope: 'user' }, {} as never)).rejects.toThrow('remote-global-memory-disabled')
    await expect(ports.tools.execute('save_memory', { scope: 'project' }, {} as never)).rejects.toThrow('remote-global-memory-disabled')
    const capture = vi.spyOn(ipc, 'agentMemoryCapture')
    await ports.ui.agentMemoryCapture({ sessionId: 's1', workingDir: workspace, messages: [] })
    expect(capture).not.toHaveBeenCalled()
    expect(toolRegistry.execute).not.toHaveBeenCalled()
    h.runs[0].finish()
    await idle()
  })

  it('injects only the real project memory index without calling global/cloud memory APIs', async () => {
    const memory = path.join(workspace, '.clerkbox', 'memory')
    await fs.mkdir(memory, { recursive: true })
    await fs.writeFile(path.join(memory, 'MEMORY.md'), '- Project-only decision')
    await fs.writeFile(path.join(outside, 'MEMORY.md'), 'private-global-secret')
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'memory' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    const prompt = await h.runs[0].ports.env.buildMemoryPrompt(workspace, outside)
    expect(prompt).toContain('Project-only decision')
    expect(prompt).not.toContain('private-global')
    expect(h.buildMemoryPrompt).not.toHaveBeenCalled()
    h.runs[0].finish()
    await idle()
  })

  it('rejects global management, MCP and shared desktop capabilities even if they are registered locally', async () => {
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'tools' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    const ports = h.runs[0].ports
    expect(ports.tools.definitions('default').map((tool) => tool.name)).toEqual(['read_file'])
    for (const tool of ['mcp__private__query', 'scheduled_task', 'spawn_agent', 'send_message_to_agent', 'create_workflow', 'save_workflow', 'resume_workflow', 'browser_navigate', 'computer_screenshot', 'future_global_tool']) {
      await expect(ports.tools.execute(tool, {}, {} as never)).rejects.toThrow('remote-tool-unavailable')
    }
    expect(await ports.tools.findAgent('private-custom-agent', workspace)).toBeNull()
    expect(h.findAgent).not.toHaveBeenCalled()
    expect(toolRegistry.execute).not.toHaveBeenCalled()
    h.runs[0].finish()
    await idle()
  })

  it('refuses an escaped project memory index and memory reads after revocation', async () => {
    await fs.mkdir(path.join(workspace, '.clerkbox'), { recursive: true })
    await fs.writeFile(path.join(outside, 'MEMORY.md'), 'private-global-secret')
    await fs.symlink(outside, path.join(workspace, '.clerkbox', 'memory'), 'junction')
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'memory' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    const env = h.runs[0].ports.env
    await expect(env.buildMemoryPrompt(workspace, '')).rejects.toThrow('remote-outside-workspace')
    active = false
    await expect(env.buildMemoryPrompt(workspace, '')).rejects.toThrow('remote-disconnected')
    expect(h.buildMemoryPrompt).not.toHaveBeenCalled()
    h.runs[0].finish()
    await idle()
  })

  it('bounds project memory reads and keeps local memory behavior unchanged', async () => {
    const memory = path.join(workspace, '.clerkbox', 'memory')
    await fs.mkdir(memory, { recursive: true })
    const index = path.join(memory, 'MEMORY.md')
    await fs.writeFile(index, 'x'.repeat(25001))
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'memory' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    expect(await h.runs[0].ports.env.buildMemoryPrompt(workspace, '')).toBe('')
    await fs.writeFile(index, Array.from({ length: 201 }, (_, i) => `line-${i}`).join('\n'))
    const prompt = await h.runs[0].ports.env.buildMemoryPrompt(workspace, '')
    expect(prompt).toContain('line-199')
    expect(prompt).not.toContain('line-200')
    h.runs[0].finish()
    await idle()
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'local', settings })
    await vi.waitFor(() => expect(h.runs).toHaveLength(2))
    const local = h.runs[1].ports
    expect(local.tools.definitions('default').map((tool) => tool.name)).toContain('search_memory')
    expect(local.env.homeDir()).toBe(os.homedir())
    expect(await local.env.buildMemoryPrompt(workspace, os.homedir())).toBe('private-global-memory')
    expect(h.buildMemoryPrompt).toHaveBeenCalledWith(workspace, os.homedir())
    h.runs[1].finish()
    await idle()
  })

  it('reads a real in-workspace image through the paired host environment', async () => {
    const image = path.join(workspace, 'image.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await fs.writeFile(image, bytes)
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'image' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    expect(await h.runs[0].ports.env.readImageAsDataUrl?.(image, 'image/png')).toBe(`data:image/png;base64,${bytes.toString('base64')}`)
    h.runs[0].finish()
    await idle()
  })

  it('refuses image fallback reads outside the paired workspace', async () => {
    const image = path.join(outside, 'private.png')
    await fs.writeFile(image, Buffer.from('outside image'))
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'image' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    expect(await h.runs[0].ports.env.readImageAsDataUrl?.(image, 'image/png')).toBeNull()
    h.runs[0].finish()
    await idle()
  })

  it('rechecks device revocation before an image fallback read', async () => {
    const image = path.join(workspace, 'image.png')
    await fs.writeFile(image, Buffer.from('workspace image'))
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'image' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    active = false
    expect(await h.runs[0].ports.env.readImageAsDataUrl?.(image, 'image/png')).toBeNull()
    h.runs[0].finish()
    await idle()
  })

  it('rejects oversized real image files and unsupported MIME types', async () => {
    const image = path.join(workspace, 'large.png')
    await fs.writeFile(image, Buffer.alloc(10 * 1024 * 1024 + 1))
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'image' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    expect(await h.runs[0].ports.env.readImageAsDataUrl?.(image, 'image/png')).toBeNull()
    const tiny = path.join(workspace, 'tiny.svg')
    await fs.writeFile(tiny, '<svg/>')
    expect(await h.runs[0].ports.env.readImageAsDataUrl?.(tiny, 'image/svg+xml')).toBeNull()
    h.runs[0].finish()
    await idle()
  })

  it('accepts only a live, pending, once-only approval from an approved device even without a local window', async () => {
    manager.setRemoteApprovalProbe(() => active && principal.approve)
    await manager.handleCommand({ type: 'run', sessionId: 's1', content: 'remote' }, paired())
    await vi.waitFor(() => expect(h.runs).toHaveLength(1))
    const pending = h.runs[0].ports.permission.confirm({ tool: 'execute_command', args: { command: 'echo test' }, reason: 'dangerous-command', risk: 'dangerous', workingDir: workspace, title: 'Approve', body: 'echo test' })
    const event = manager.peekRing('s1').find((e) => e.type === 'permission.requested')
    expect(event?.type).toBe('permission.requested')
    const requestId = (event as { requestId: string }).requestId
    const cmd = { type: 'permission.resolve' as const, sessionId: 's1', requestId, approved: true }
    expect(await manager.handleCommand(cmd, { remote: true })).toEqual({ ok: false, error: 'approval-local-only' })
    expect(await manager.handleCommand(cmd, { remote: true, pairedRemote: { ...principal, approve: false } })).toEqual({ ok: false, error: 'remote-approval-disabled' })
    expect(await manager.handleCommand({ ...cmd, scope: 'session' }, paired())).toEqual({ ok: false, error: 'remote-approval-disabled' })
    expect(await manager.handleCommand(cmd, paired())).toEqual({ ok: true })
    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' })
    expect(await manager.handleCommand(cmd, paired())).toEqual({ ok: false, error: 'stale-request' })
    h.runs[0].finish()
    await idle()
  })
})

it('only changes host mode when explicitly enabled at runtime', () => {
  const original = resolveAgentHostMode()
  setRuntimeAgentHostMode('main')
  expect(resolveAgentHostMode()).toBe('main')
  setRuntimeAgentHostMode(null)
  expect(resolveAgentHostMode()).toBe(original)
})
