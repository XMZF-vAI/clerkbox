import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ invoke: vi.fn(async (_method: string, _args: unknown[]) => ({ ok: true })), subscribe: vi.fn(() => () => {}) }))
vi.mock('../src/remote/browser', () => ({
  isCloudRemoteMode: () => true,
  getRemoteBootstrap: () => ({ workspace: 'D:\\work', capabilities: { control: true, files: false, approve: false } }),
  invokeRemote: h.invoke,
  subscribeRemoteEvents: h.subscribe,
  uploadRemoteFile: vi.fn(),
}))
import { ipc } from '../src/lib/ipc-client'
import type { AgentCommand } from '../src/agent-core/protocol'
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())
describe('remote browser IPC routing', () => {
  it('routes workspace choices to the host while omitting upstream credentials and permission settings', async () => {
    const command = { type: 'run', sessionId: 'remote-session', content: 'Hello', taskMode: 'plan', settings: { apiKey: 'never-transmit', approvalMode: 'full' }, skills: [{ content: 'untrusted' }], skillCatalog: ['injected'], skillReminder: 'injected', goal: { title: 'injected' }, todos: ['injected'] } as unknown as AgentCommand
    await ipc.agentCommand(command)
    expect(h.invoke).toHaveBeenCalledWith('agent:command', [expect.objectContaining({ type: 'run', sessionId: 'remote-session', content: 'Hello', taskMode: 'plan', skills: [{ content: 'untrusted' }], skillCatalog: ['injected'], goal: { title: 'injected' } })])
    expect(JSON.stringify(h.invoke.mock.calls)).not.toContain('never-transmit')
    expect(JSON.stringify(h.invoke.mock.calls)).not.toContain('approvalMode')
  })
  it('declares main ownership without starting a second agent or model stream', async () => {
    expect(await ipc.agentHostMode()).toBe('main')
    await expect(ipc.apiChatStream({ apiKey: 'never-transmit' } as never, {})).rejects.toThrow('desktop agent')
    expect(h.invoke).not.toHaveBeenCalled()
  })
  it('sends uploaded image references for runs and queues without duplicating image bytes', async () => {
    const image = { id: 'image-one', kind: 'image' as const, name: 'photo.png', path: 'D:\\work\\.clerkbox\\uploads\\photo.png', dataUrl: `data:image/png;base64,${'A'.repeat(600_000)}`, mimeType: 'image/png' }
    await ipc.agentCommand({ type: 'run', sessionId: 'remote-session', content: 'Describe this', attachments: [image] })
    await ipc.agentCommand({ type: 'queue.enqueue', sessionId: 'remote-session', item: { id: 'queue-one', content: 'Next', attachments: [image], queuedAt: 1, skills: [{ id: 'untrusted', name: 'browser-skill' }] } })
    expect(JSON.stringify(h.invoke.mock.calls)).not.toContain('data:image')
    expect(h.invoke.mock.calls[0][1]).toMatchObject([{ attachments: [{ path: image.path, kind: 'image', mimeType: 'image/png' }] }])
    expect(h.invoke.mock.calls[1][1]).toMatchObject([{ item: { attachments: [{ path: image.path }], skills: [{ id: 'untrusted', name: 'browser-skill' }] } }])
  })
  it('uses encrypted RPC for snapshots and the authenticated remote event subscription', async () => {
    await ipc.agentSnapshot('session-a', 15)
    expect(h.invoke).toHaveBeenCalledWith('agent:snapshot', ['session-a', 15])
    const listener = vi.fn()
    ipc.onAgentEvent(listener)
    expect(h.subscribe).toHaveBeenCalledWith(listener)
  })
})
