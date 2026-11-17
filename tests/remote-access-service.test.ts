import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { ChatStore } from '../electron/db'
import type { AgentSessionManager } from '../electron/agent-host'
import type { RemoteDeviceCredential, RemoteInvite, RemotePrincipal } from '../src/remote/protocol'
import type { AgentEvent } from '../src/agent-core/protocol'
import { open, randomHex, seal } from '../src/remote/crypto'

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (_principal: RemotePrincipal, _method: string, _args: unknown[]) => ({ ok: true })),
  bootstrap: vi.fn(async (_principal: RemotePrincipal) => ({ protocolVersion: 1, settings: {} })),
  dispose: vi.fn(),
  setMode: vi.fn(),
  filterEvent: vi.fn(async (_principal: RemotePrincipal, _payload: { seq: number; event: AgentEvent }): Promise<{ seq: number; event: AgentEvent } | null> => null),
  eventSink: undefined as undefined | ((payload: { seq: number; event: AgentEvent }) => void),
}))
vi.mock('../electron/remote-host-dispatcher', () => ({
  createRemoteHostDispatcher: () => ({ invoke: h.invoke, bootstrap: h.bootstrap, filterEvent: h.filterEvent, dispose: h.dispose }),
}))
vi.mock('../electron/agent-host', () => ({
  registerAgentEventSink: (sink: (payload: { seq: number; event: AgentEvent }) => void) => { h.eventSink = sink; return () => { h.eventSink = undefined } },
  setRuntimeAgentHostMode: h.setMode,
}))

import { RemoteAccessService } from '../electron/remote-access'
import { DEFAULT_REMOTE_ORIGIN } from '../src/remote/protocol'

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: Record<string, unknown>[] = []
  acknowledgeInvites = true
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
  }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
  send(raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>
    this.sent.push(frame)
    if (frame.type === 'auth') queueMicrotask(() => this.receive({ type: 'ready', role: 'host' }))
    if (frame.type === 'invite' && this.acknowledgeInvites) queueMicrotask(() => this.receive({ type: 'invite.ready', tokenHash: frame.tokenHash }))
    if (frame.type === 'authorize') queueMicrotask(() => this.receive({ type: 'authorized', deviceId: frame.deviceId }))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
}

let service: RemoteAccessService
let workspace: string
let saved: string | null
let credentialWrites: ReturnType<typeof vi.fn>

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'clerkbox-remote-service-'))
  saved = null
  FakeWebSocket.instances.length = 0
  h.invoke.mockClear()
  h.bootstrap.mockClear()
  h.dispose.mockClear()
  h.setMode.mockClear()
  h.filterEvent.mockReset().mockResolvedValue(null)
  credentialWrites = vi.fn(async (value: string) => { saved = value })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
  service = new RemoteAccessService({
    store: {} as ChatStore, manager: {} as AgentSessionManager,
    readCredential: async () => saved,
    writeCredential: credentialWrites,
    deleteCredential: async () => { saved = null },
    notify: () => {}, origin: 'https://webui.clerkbox.test',
  })
})

afterEach(async () => {
  service.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await fs.rm(workspace, { recursive: true, force: true })
})

async function enable(): Promise<{ socket: FakeWebSocket; invite: RemoteInvite }> {
  const status = await service.enable({ workspace, approve: true, files: true })
  expect(status.state).toBe('online')
  const url = new URL(status.url!)
  expect(url.search).toBe('')
  const invite = JSON.parse(decodeURIComponent(url.hash.slice('#invite='.length))) as RemoteInvite
  return { socket: FakeWebSocket.instances.at(-1)!, invite }
}
async function join(socket: FakeWebSocket, peerId: string, frame: Record<string, unknown>) {
  socket.receive({ type: 'peer.joined', peerId, ...frame })
  let challenge = ''
  await vi.waitFor(() => {
    const message = socket.sent.find((item) => item.type === 'data' && item.peerId === peerId && typeof (item.payload as { challenge?: unknown })?.challenge === 'string')
    challenge = (message?.payload as { challenge?: string })?.challenge || ''
    expect(challenge).toMatch(/^[a-f0-9]{64}$/)
  })
  return challenge
}
async function send(socket: FakeWebSocket, peerId: string, key: string, value: unknown) {
  const payload = await seal(key, value)
  socket.receive({ type: 'data', peerId, payload })
  return payload
}
async function decrypted(socket: FakeWebSocket, peerId: string, key: string): Promise<Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = []
  for (const frame of socket.sent.filter((item) => item.type === 'data' && item.peerId === peerId && (item.payload as { v?: unknown })?.v === 1)) {
    try { values.push(await open(key, frame.payload)) } catch { /* Old invitation key vs new device key. */ }
  }
  return values
}
async function pairedDevice() {
  const { socket, invite } = await enable()
  const challenge = await join(socket, 'pair-peer', { invited: true })
  await send(socket, 'pair-peer', invite.key, { kind: 'pair', challenge, name: 'Test phone' })
  await vi.waitFor(() => expect(service.getStatus().pending).toHaveLength(1))
  await service.approvePair('pair-peer', true)
  const response = (await decrypted(socket, 'pair-peer', invite.key)).find((value) => value.kind === 'paired')
  const credential = response?.credential as RemoteDeviceCredential
  expect(credential.deviceId).toMatch(/^[a-f0-9]{32}$/)
  const deviceChallenge = await join(socket, 'device-peer', { deviceId: credential.deviceId })
  await send(socket, 'device-peer', credential.key, { kind: 'hello', challenge: deviceChallenge })
  await vi.waitFor(() => expect(h.bootstrap).toHaveBeenCalledTimes(1))
  return { socket, invite, credential, challenge: deviceChallenge }
}

function restartService() {
  service.dispose()
  service = new RemoteAccessService({
    store: {} as ChatStore, manager: {} as AgentSessionManager,
    readCredential: async () => saved,
    writeCredential: credentialWrites,
    deleteCredential: async () => { saved = null },
    notify: () => {}, origin: 'https://webui.clerkbox.test',
  })
}

describe('persisted remote room recovery', () => {
  it('rotates expired room credentials and clears old devices and receipts on status 410', async () => {
    const { credential } = await pairedDevice()
    const previous = JSON.parse(saved!) as { roomId: string; hostToken: string; devices: unknown[]; receipts: unknown[] }
    expect(previous.devices).toHaveLength(1)
    // The mutation history belongs to the expired room and must not cross into its replacement.
    previous.receipts = [{ id: randomHex(16), deviceId: credential.deviceId, issuedAt: Date.now(), state: 'done', result: { ok: true } }]
    saved = JSON.stringify(previous)
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockReset().mockImplementation(async input => {
      const url = String(input)
      return { ok: !url.endsWith('/status'), status: url.endsWith('/status') ? 410 : 201 } as Response
    })
    restartService()
    await service.restore()
    await vi.waitFor(() => expect(service.getStatus().state).toBe('online'))
    const restored = JSON.parse(saved!) as { roomId: string; hostToken: string; devices: unknown[]; receipts: unknown[] }
    expect(restored.roomId).not.toBe(previous.roomId)
    expect(restored.hostToken).not.toBe(previous.hostToken)
    expect(restored.roomId).toMatch(/^[a-f0-9]{32}$/)
    expect(restored.hostToken).toMatch(/^[a-f0-9]{64}$/)
    expect(restored.devices).toEqual([])
    expect(restored.receipts).toEqual([])
    expect(service.getStatus().devices).toEqual([])
    expect(service.getStatus().url).toBeUndefined()
    const creates = fetch.mock.calls.filter(([input]) => String(input).endsWith('/api/rooms'))
    expect(creates).toHaveLength(1)
    expect(JSON.parse(creates[0][1]!.body as string)).toEqual({ roomId: restored.roomId, hostToken: restored.hostToken })
  })

  it('checks a live persisted room without consuming another room creation', async () => {
    await pairedDevice()
    const previous = JSON.parse(saved!) as { roomId: string; hostToken: string; devices: unknown[] }
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockReset().mockResolvedValue({ ok: true, status: 200 } as Response)
    restartService()
    await service.restore()
    await vi.waitFor(() => expect(service.getStatus().state).toBe('online'))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0][0])).toBe(`https://webui.clerkbox.test/api/rooms/${previous.roomId}/status`)
    expect(fetch.mock.calls[0][1]?.method).toBe('POST')
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ hostToken: previous.hostToken })
    expect(JSON.parse(saved!)).toMatchObject({ roomId: previous.roomId, hostToken: previous.hostToken, devices: previous.devices })
  })

  it('surfaces a rejected room credential and stops retrying instead of looping on status 403', async () => {
    await pairedDevice()
    const previous = saved
    const sockets = FakeWebSocket.instances.length
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockReset().mockResolvedValue({ ok: false, status: 403 } as Response)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    restartService()
    await service.restore()
    await vi.waitFor(() => expect(service.getStatus().state).toBe('error'))
    await new Promise(resolve => setTimeout(resolve, 1300))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(sockets)
    expect(service.getStatus().state).toBe('error')
    expect(saved).toBe(previous)
  })
})

describe('real-crypto paired remote connector', () => {
  it('restores a previously approved device and reconnects without another desktop pairing request', async () => {
    const { credential } = await pairedDevice()
    restartService()
    await service.restore()
    await vi.waitFor(() => expect(service.getStatus().state).toBe('online'))
    const socket = FakeWebSocket.instances.at(-1)!
    const challenge = await join(socket, 'restored-device', { deviceId: credential.deviceId })
    await send(socket, 'restored-device', credential.key, { kind: 'hello', challenge })
    await vi.waitFor(() => expect(service.getStatus().devices[0].online).toBe(true))
    expect(service.getStatus().pending).toEqual([])
    expect((await decrypted(socket, 'restored-device', credential.key)).some(message => message.kind === 'connected')).toBe(true)
  })

  it('coalesces concurrent invitation refreshes and keeps paired browsers active', async () => {
    const { socket, credential } = await pairedDevice()
    const count = socket.sent.filter(frame => frame.type === 'invite').length
    const results = await Promise.all([service.createInvite(), service.createInvite(), service.createInvite()])
    expect(new Set(results.map(status => status.url)).size).toBe(1)
    expect(socket.sent.filter(frame => frame.type === 'invite')).toHaveLength(count + 1)
    expect(service.getStatus().devices).toMatchObject([{ id: credential.deviceId, online: true }])
    expect(socket.sent.some(frame => frame.type === 'revoke' && frame.deviceId === credential.deviceId)).toBe(false)
    expect(socket.sent.some(frame => frame.type === 'disconnect' && frame.peerId === 'device-peer')).toBe(false)
  })

  it('invalidates old pending pairing immediately and accepts only the matching refresh acknowledgement', async () => {
    const { socket, invite } = await enable()
    const challenge = await join(socket, 'old-pair', { invited: true })
    await send(socket, 'old-pair', invite.key, { kind: 'pair', challenge, name: 'Old phone' })
    await vi.waitFor(() => expect(service.getStatus().pending).toHaveLength(1))
    const oldHash = socket.sent.find(frame => frame.type === 'invite')!.tokenHash
    socket.acknowledgeInvites = false
    let complete = false
    const refreshing = service.createInvite().then(value => { complete = true; return value })
    expect(service.getStatus().url).toBeUndefined()
    expect(service.getStatus().pending).toEqual([])
    await expect(service.approvePair('old-pair', true)).rejects.toThrow('expired')
    await vi.waitFor(() => expect(socket.sent.filter(frame => frame.type === 'invite')).toHaveLength(2))
    socket.receive({ type: 'invite.ready', tokenHash: oldHash })
    await Promise.resolve()
    expect(complete).toBe(false)
    socket.receive({ type: 'invite.ready', tokenHash: socket.sent.filter(frame => frame.type === 'invite').at(-1)!.tokenHash })
    const status = await refreshing
    expect(status.url).toBeDefined()
    expect(JSON.parse(decodeURIComponent(new URL(status.url!).hash.slice(8))).token).not.toBe(invite.token)
  })

  it('leaves no stale invitation visible after a refresh fails and preserves paired devices', async () => {
    const { socket, credential } = await pairedDevice()
    await service.createInvite()
    socket.acknowledgeInvites = false
    const refreshing = service.createInvite()
    const rejected = expect(refreshing).rejects.toThrow('closed')
    await vi.waitFor(() => expect(socket.sent.filter(frame => frame.type === 'invite')).toHaveLength(3))
    socket.close()
    await rejected
    expect(service.getStatus().url).toBeUndefined()
    expect(service.getStatus().devices[0].id).toBe(credential.deviceId)
    expect(JSON.parse(saved!).devices).toHaveLength(1)
  })

  it('cancels a still-uncommitted approval when its invitation is refreshed during persistence', async () => {
    const { socket, invite } = await enable()
    const challenge = await join(socket, 'racing-pair', { invited: true })
    await send(socket, 'racing-pair', invite.key, { kind: 'pair', challenge, name: 'Racing phone' })
    await vi.waitFor(() => expect(service.getStatus().pending).toHaveLength(1))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    credentialWrites.mockImplementationOnce(async (value: string) => { await gate; saved = value })
    const approving = service.approvePair('racing-pair', true).catch(error => error)
    const refreshed = await service.createInvite()
    release()
    expect(await approving).toBeInstanceOf(Error)
    expect(service.getStatus().devices).toEqual([])
    expect(service.getStatus().url).toBe(refreshed.url)
    expect((await decrypted(socket, 'racing-pair', invite.key)).some(message => message.kind === 'paired')).toBe(false)
  })

  it('preserves a committed approval and the replacement invitation when refresh overlaps encrypted credential delivery', async () => {
    const { socket, invite } = await enable()
    const challenge = await join(socket, 'committed-pair', { invited: true })
    await send(socket, 'committed-pair', invite.key, { kind: 'pair', challenge, name: 'Approved phone' })
    await vi.waitFor(() => expect(service.getStatus().pending).toHaveLength(1))
    const internal = service as unknown as { sendEncrypted(peer: unknown, value: unknown): Promise<void> }
    const original = internal.sendEncrypted.bind(service)
    let release!: () => void
    let delivering = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const encrypted = vi.spyOn(internal, 'sendEncrypted').mockImplementation(async (peer, value) => {
      if ((value as { kind?: string }).kind === 'paired') { delivering = true; await gate }
      return original(peer, value)
    })
    try {
      const approving = service.approvePair('committed-pair', true)
      await vi.waitFor(() => expect(delivering).toBe(true))
      const refreshed = await service.createInvite()
      release()
      await approving
      expect(service.getStatus().url).toBe(refreshed.url)
      expect(service.getStatus().devices).toHaveLength(1)
      expect(socket.sent.some(frame => frame.type === 'disconnect' && frame.peerId === 'committed-pair')).toBe(false)
      expect((await decrypted(socket, 'committed-pair', invite.key)).some(message => message.kind === 'paired')).toBe(true)
    } finally { release(); encrypted.mockRestore() }
  })

  it('generates a public HTTPS QR invitation on the production domain with all secrets confined to its fragment', async () => {
    service.dispose()
    service = new RemoteAccessService({ store: {} as ChatStore, manager: {} as AgentSessionManager, readCredential: async () => saved, writeCredential: credentialWrites, deleteCredential: async () => { saved = null }, notify: () => {} })
    const status = await service.enable({ workspace, approve: false, files: false })
    const url = new URL(status.url!)
    expect(url.origin).toBe(DEFAULT_REMOTE_ORIGIN)
    expect(url.protocol).toBe('https:')
    expect(url.pathname).toBe('/')
    expect(url.search).toBe('')
    expect(url.hash).toContain('#invite=')
    expect(FakeWebSocket.instances.at(-1)!.url).toBe(`${DEFAULT_REMOTE_ORIGIN.replace('https:', 'wss:')}/relay/${JSON.parse(saved!).roomId}`)
  })
  it('requires a desktop approval and a new device encryption key before any RPC', async () => {
    const { socket, invite } = await enable()
    expect(JSON.stringify(socket.sent)).not.toContain(invite.key)
    const challenge = await join(socket, 'pair-peer', { invited: true })
    await send(socket, 'pair-peer', invite.key, { kind: 'request', challenge, id: randomHex(16), issuedAt: Date.now(), method: 'agent:command', args: [] })
    await send(socket, 'pair-peer', invite.key, { kind: 'pair', challenge, name: 'Browser' })
    await vi.waitFor(() => expect(service.getStatus().pending).toHaveLength(1))
    expect(h.invoke).not.toHaveBeenCalled()
    expect(h.bootstrap).not.toHaveBeenCalled()
    await service.approvePair('pair-peer', true)
    const result = (await decrypted(socket, 'pair-peer', invite.key)).find((value) => value.kind === 'paired')!
    const credential = result.credential as RemoteDeviceCredential
    expect(credential.key).not.toBe(invite.key)
    expect(credential.token).not.toBe(invite.token)
    expect(service.getStatus().url).toBeUndefined()
    expect(h.setMode).toHaveBeenCalledWith('main')
  })

  it('disconnects a peer with an incorrect key instead of treating relay membership as authorization', async () => {
    const { socket } = await enable()
    const challenge = await join(socket, 'bad-peer', { invited: true })
    await send(socket, 'bad-peer', randomHex(), { kind: 'request', challenge, id: randomHex(16), issuedAt: Date.now(), method: 'dbGetMessages', args: ['s1'] })
    await vi.waitFor(() => expect(socket.sent.some((item) => item.type === 'disconnect' && item.peerId === 'bad-peer')).toBe(true))
    expect(h.invoke).not.toHaveBeenCalled()
    expect(service.getStatus().pending).toHaveLength(0)
  })

  it('rejects expired invitations when a peer first joins', async () => {
    const { socket } = await enable()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000)
    socket.receive({ type: 'peer.joined', peerId: 'expired-peer', invited: true })
    await vi.waitFor(() => expect(socket.sent.some((item) => item.type === 'disconnect' && item.peerId === 'expired-peer')).toBe(true))
    expect(service.getStatus().url).toBeUndefined()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('does not accept a pair request from an invitation which expired after peer join', async () => {
    const { socket, invite } = await enable()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 60_000 + 50_000)
    const challenge = await join(socket, 'late-peer', { invited: true })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000)
    await send(socket, 'late-peer', invite.key, { kind: 'pair', challenge, name: 'Too late' })
    // The refresh acknowledgement traverses the same incoming frame queue after the pair attempt.
    await service.createInvite()
    expect((await decrypted(socket, 'late-peer', invite.key)).some((value) => value.kind === 'pending')).toBe(false)
    expect(service.getStatus().pending).toHaveLength(0)
    await expect(service.approvePair('late-peer', true)).rejects.toThrow('Pair request expired')
  })

  it('persists mutation receipts before dispatch and deduplicates both encrypted-frame replay and request retry', async () => {
    const { socket, credential, challenge } = await pairedDevice()
    const id = randomHex(16)
    const request = { kind: 'request', challenge, id, issuedAt: Date.now(), method: 'agent:command', args: [{ type: 'abort', sessionId: 's1' }] }
    const payload = await send(socket, 'device-peer', credential.key, request)
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(JSON.parse(saved!).receipts[0].state).toBe('done'))
    socket.receive({ type: 'data', peerId: 'device-peer', payload })
    await send(socket, 'device-peer', credential.key, request)
    await vi.waitFor(async () => expect((await decrypted(socket, 'device-peer', credential.key)).filter((value) => value.kind === 'response' && value.id === id)).toHaveLength(2))
    expect(h.invoke).toHaveBeenCalledTimes(1)
    expect(JSON.parse(saved!).receipts).toHaveLength(1)
  })

  it('rejects a stale request or a validly encrypted request for the wrong connection challenge', async () => {
    const { socket, credential, challenge } = await pairedDevice()
    await send(socket, 'device-peer', credential.key, { kind: 'request', challenge: 'wrong', id: randomHex(16), issuedAt: Date.now(), method: 'dbGetMessages', args: ['s1'] })
    await send(socket, 'device-peer', credential.key, { kind: 'request', challenge, id: randomHex(16), issuedAt: Date.now() - 6 * 60_000, method: 'agent:command', args: [] })
    await send(socket, 'device-peer', credential.key, { kind: 'request', challenge, id: randomHex(16), issuedAt: Date.now(), method: 'dbGetRevision', args: [] })
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1))
    expect(h.invoke.mock.calls[0][1]).toBe('dbGetRevision')
  })

  it('revokes the principal immediately and disabling cancels scheduled reconnect', async () => {
    const { socket, credential, challenge } = await pairedDevice()
    const principal = h.bootstrap.mock.calls[0][0]
    expect(principal.isActive()).toBe(true)
    await service.revokeDevice(credential.deviceId)
    expect(principal.isActive()).toBe(false)
    await send(socket, 'device-peer', credential.key, { kind: 'request', challenge, id: randomHex(16), issuedAt: Date.now(), method: 'agent:command', args: [] })
    socket.close()
    expect(service.getStatus().state).toBe('reconnecting')
    await service.disable()
    expect(service.getStatus()).toMatchObject({ enabled: false, state: 'disabled', devices: [] })
    expect(saved).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 1300))
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('keeps an authorized task principal alive across a transient browser disconnect', async () => {
    const { socket } = await pairedDevice()
    const principal = h.bootstrap.mock.calls[0][0]
    socket.receive({ type: 'peer.left', peerId: 'device-peer' })
    await vi.waitFor(() => expect(service.getStatus().devices[0].online).toBe(false))
    expect(principal.isActive()).toBe(true)
    await service.disable()
    expect(principal.isActive()).toBe(false)
  })

  it('does not accumulate heartbeat timers on repeated relay-ready frames', async () => {
    const timer = vi.spyOn(globalThis, 'setInterval')
    const { socket } = await enable()
    const count = timer.mock.calls.length
    socket.receive({ type: 'ready', role: 'host' })
    socket.receive({ type: 'ready', role: 'host' })
    expect(timer.mock.calls.length).toBe(count)
  })

  it('processes relay pongs while a data RPC is still pending', async () => {
    const timers = vi.spyOn(globalThis, 'setInterval')
    const { socket, credential, challenge } = await pairedDevice()
    const heartbeat = timers.mock.calls.find(([, delay]) => delay === 45_000)?.[0]
    expect(typeof heartbeat).toBe('function')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.invoke.mockImplementationOnce(async () => { await gate; return { ok: true } })
    try {
      await send(socket, 'device-peer', credential.key, { kind: 'request', challenge, id: randomHex(16), issuedAt: Date.now(), method: 'dbGetMessages', args: ['s1'] })
      await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1))
      const now = Date.now() + 135_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      socket.receive({ type: 'pong' })
      await new Promise(resolve => setTimeout(resolve, 10))
      ;(heartbeat as () => void)()
      expect(socket.readyState).toBe(FakeWebSocket.OPEN)
      expect(service.getStatus().state).toBe('online')
    } finally { release() }
  })

  it('locally drops an overflowing event peer before more filtered events can rebuild its queue', async () => {
    const { socket } = await pairedDevice()
    h.filterEvent.mockImplementation(async (_principal, payload) => payload)
    for (let seq = 1; seq <= 4002; seq++) {
      h.eventSink?.({ seq, event: { type: 'stream.delta', sessionId: 's1', messageId: 'm1', text: 'x' } })
    }
    await vi.waitFor(() => expect(socket.sent.some(frame => frame.type === 'disconnect' && frame.peerId === 'device-peer')).toBe(true))
    // The Worker can be slow to acknowledge disconnect. Local memory must already be bounded.
    expect(service.getStatus().devices[0].online).toBe(false)
    expect((service as unknown as { eventBuffers: Map<string, unknown> }).eventBuffers.size).toBe(0)
  })

  it('closes the host socket when queued incoming frames exceed the bound behind a blocked RPC', async () => {
    const { socket, credential, challenge } = await pairedDevice()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.invoke.mockImplementationOnce(async () => { await gate; return { ok: true } })
    try {
      await send(socket, 'device-peer', credential.key, { kind: 'request', challenge, id: randomHex(16), issuedAt: Date.now(), method: 'dbGetMessages', args: ['s1'] })
      await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1))
      const payload = await seal(credential.key, { kind: 'request', challenge, id: randomHex(16), issuedAt: Date.now(), method: 'dbGetRevision', args: [] })
      for (let index = 0; index < 140; index++) socket.receive({ type: 'data', peerId: 'device-peer', payload })
      await vi.waitFor(() => expect(socket.readyState).toBe(3))
      expect(h.invoke).toHaveBeenCalledTimes(1)
      expect(service.getStatus().state).toBe('reconnecting')
    } finally { release() }
  })

  it.each([
    { name: 'one oversized event', sizes: [8 * 1024 * 1024 + 1] },
    { name: 'accumulated large events', sizes: [5 * 1024 * 1024, 5 * 1024 * 1024] },
  ])('drops an event peer whose buffered bytes exceed the limit: $name', async ({ sizes }) => {
    const { socket } = await pairedDevice()
    h.filterEvent.mockImplementation(async (_principal, payload) => payload)
    sizes.forEach((size, index) => {
      h.eventSink?.({ seq: index + 1, event: { type: 'stream.delta', sessionId: 's1', messageId: 'm1', text: 'x'.repeat(size) } })
    })
    await vi.waitFor(() => expect(socket.sent.some(frame => frame.type === 'disconnect' && frame.peerId === 'device-peer')).toBe(true))
    expect(service.getStatus().devices[0].online).toBe(false)
    expect((service as unknown as { eventBuffers: Map<string, unknown> }).eventBuffers.size).toBe(0)
  })

  it('does not create two authorized devices from simultaneous approvals of one pending pair', async () => {
    const { socket, invite } = await enable()
    const challenge = await join(socket, 'pair-peer', { invited: true })
    await send(socket, 'pair-peer', invite.key, { kind: 'pair', challenge, name: 'Browser' })
    await vi.waitFor(() => expect(service.getStatus().pending).toHaveLength(1))
    const results = await Promise.allSettled([service.approvePair('pair-peer', true), service.approvePair('pair-peer', true)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(service.getStatus().devices).toHaveLength(1)
    expect((await decrypted(socket, 'pair-peer', invite.key)).filter((value) => value.kind === 'paired')).toHaveLength(1)
  })

  it('disabling while approval persistence is pending cannot resurrect a device or leak a paired credential', async () => {
    const { socket, invite } = await enable()
    const challenge = await join(socket, 'pair-peer', { invited: true })
    await send(socket, 'pair-peer', invite.key, { kind: 'pair', challenge, name: 'Browser' })
    await vi.waitFor(() => expect(service.getStatus().pending).toHaveLength(1))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const previousWrites = credentialWrites.mock.calls.length
    credentialWrites.mockImplementationOnce(async (value: string) => { await gate; saved = value })
    const approving = service.approvePair('pair-peer', true).then(() => null, (error: unknown) => error)
    await vi.waitFor(() => expect(credentialWrites.mock.calls.length).toBe(previousWrites + 1))
    const disabling = service.disable()
    release()
    const [error] = await Promise.all([approving, disabling])
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/expired|closed/i)
    expect(saved).toBeNull()
    expect(service.getStatus().devices).toHaveLength(0)
    expect((await decrypted(socket, 'pair-peer', invite.key)).some((value) => value.kind === 'paired')).toBe(false)
  })

  it('does not dispatch a queued mutation after disabling while its idempotency receipt is being saved', async () => {
    const { socket, credential, challenge } = await pairedDevice()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const previousWrites = credentialWrites.mock.calls.length
    credentialWrites.mockImplementationOnce(async (value: string) => { await gate; saved = value })
    await send(socket, 'device-peer', credential.key, { kind: 'request', challenge, id: randomHex(16), issuedAt: Date.now(), method: 'agent:command', args: [{ type: 'abort', sessionId: 's1' }] })
    await vi.waitFor(() => expect(credentialWrites.mock.calls.length).toBe(previousWrites + 1))
    const disabling = service.disable()
    release()
    await disabling
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.invoke).not.toHaveBeenCalled()
    expect(saved).toBeNull()
  })
})
