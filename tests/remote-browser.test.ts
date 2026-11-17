import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { consumeRemoteInvite, consumeRemoteInviteNavigation, forgetRemoteDevice, readRemoteDevices, RemoteBrowserClient, saveRemoteDevice, validRemoteIdentity, type RemoteBootstrap, type RemoteBrowserOptions } from '../src/remote/browser'
import { open, seal, sha256Hex } from '../src/remote/crypto'
import type { RemoteDeviceCredential, RemoteInvite } from '../src/remote/protocol'

const invite: RemoteInvite = { protocol: 1, roomId: 'a'.repeat(32), token: 'b'.repeat(64), key: 'c'.repeat(64) }
const device: RemoteDeviceCredential = { ...invite, deviceId: 'd'.repeat(32), token: 'e'.repeat(64), key: 'f'.repeat(64), name: 'My browser' }
const bootstrap: RemoteBootstrap = { protocolVersion: 1, workspace: 'D:\\work', settings: { model: 'desktop-model', apiKey: '' }, capabilities: { control: true, files: false, approve: false } }
class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] || null }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}
class FakeSocket {
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  open() { this.readyState = 1; this.onopen?.({} as Event) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent) }
  fail(code = 1006) { this.readyState = 3; this.onclose?.({ code } as CloseEvent) }
  frames() { return this.sent.filter(frame => frame.type === 'data') }
}
let clients: RemoteBrowserClient[]
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); clients = [] })
afterEach(() => { for (const client of clients) client.disconnect(); vi.unstubAllGlobals() })
function create(options: Partial<RemoteBrowserOptions> = {}) {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const credentials: RemoteDeviceCredential[] = []
  const client = new RemoteBrowserClient({ origin: 'https://webui.clerkbox.xmzf.space', createSocket: url => { urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket }, saveCredential: credential => credentials.push(credential), ...options })
  clients.push(client)
  return { client, sockets, urls, credentials }
}
async function handshake(socket: FakeSocket, identity: RemoteInvite, challenge = '1'.repeat(64)) {
  socket.open()
  socket.receive({ type: 'ready' })
  socket.receive({ type: 'data', payload: { challenge } })
  await vi.waitFor(() => expect(socket.frames()).toHaveLength(1))
  return open<Record<string, unknown>>(identity.key, socket.frames()[0].payload)
}
async function deliver(socket: FakeSocket, identity: RemoteInvite, message: unknown) {
  socket.receive({ type: 'data', payload: await seal(identity.key, message) })
}
async function connectDevice() {
  const result = create()
  result.client.connect(device)
  const socket = result.sockets[0]
  await handshake(socket, device)
  await deliver(socket, device, { kind: 'connected', challenge: '1'.repeat(64), bootstrap })
  await vi.waitFor(() => expect(result.client.getConnection().state).toBe('connected'))
  return { ...result, socket }
}

describe('remote invitation and credential boundary', () => {
  it('consumes a newly navigated invitation after an empty entry and remains StrictMode-idempotent', () => {
    const location = new URL('https://webui.clerkbox.xmzf.space/?lang=en')
    const history = { replaceState: vi.fn((_state: unknown, _unused: string, url?: string | URL | null) => { location.href = new URL(String(url), location.origin).href }) }
    const options = { workspaceLoaded: false, connect: vi.fn(), reload: vi.fn() }
    expect(consumeRemoteInviteNavigation(location, history, options)).toBe(false)
    location.hash = `invite=${encodeURIComponent(JSON.stringify(invite))}`
    expect(consumeRemoteInviteNavigation(location, history, options)).toBe(true)
    expect(location.hash).toBe('')
    expect(options.connect).toHaveBeenCalledOnce()
    expect(options.connect).toHaveBeenCalledWith(invite)
    expect(consumeRemoteInviteNavigation(location, history, options)).toBe(false)
    expect(options.connect).toHaveBeenCalledOnce()
    const next = { ...invite, roomId: '9'.repeat(32) }
    location.hash = `invite=${encodeURIComponent(JSON.stringify(next))}`
    consumeRemoteInviteNavigation(location, history, options)
    expect(options.connect).toHaveBeenLastCalledWith(next)
    expect(options.reload).not.toHaveBeenCalled()
  })
  it('requires a fresh document for invitations after a workspace has hydrated', () => {
    const location = new URL(`https://webui.clerkbox.xmzf.space/#invite=${encodeURIComponent(JSON.stringify(invite))}`)
    const history = { replaceState: vi.fn((_state: unknown, _unused: string, url?: string | URL | null) => { location.href = new URL(String(url), location.origin).href }) }
    const connect = vi.fn()
    const reload = vi.fn(() => { expect(location.hash).toContain('invite=') })
    consumeRemoteInviteNavigation(location, history, { workspaceLoaded: true, connect, reload })
    expect(connect).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledOnce()
    expect(consumeRemoteInvite(location, history)).toEqual(invite)
    expect(location.hash).toBe('')
  })
  it('clears the fragment before parsing and accepts only a valid invitation', () => {
    const replaceState = vi.fn()
    const location = { hash: `#invite=${encodeURIComponent(JSON.stringify(invite))}`, pathname: '/', search: '?lang=en' }
    expect(consumeRemoteInvite(location, { replaceState })).toEqual(invite)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?lang=en')
    expect(() => consumeRemoteInvite({ ...location, hash: '#invite=%7Bbroken' }, { replaceState })).toThrow('cloudInvalidInvite')
    expect(replaceState).toHaveBeenCalledTimes(2)
    expect(() => consumeRemoteInvite({ ...location, hash: `#invite=${encodeURIComponent(JSON.stringify(device))}` }, { replaceState })).toThrow('cloudInvalidInvite')
    expect(consumeRemoteInvite({ ...location, hash: '' }, { replaceState })).toBeNull()
  })
  it('rejects unbounded identifiers and invalid encryption/token material', () => {
    expect(validRemoteIdentity(invite)).toBe(true)
    expect(validRemoteIdentity({ ...invite, token: 'not-secret-shaped' })).toBe(false)
    expect(validRemoteIdentity({ ...invite, key: 'z'.repeat(64) })).toBe(false)
    expect(validRemoteIdentity({ ...invite, roomId: '../another-room' })).toBe(false)
    expect(validRemoteIdentity({ ...device, name: 'x'.repeat(101) })).toBe(false)
  })
  it('stores credentials per room/device and removes only the selected browser', () => {
    const storage = new MemoryStorage()
    const other = { ...device, roomId: '2'.repeat(32), deviceId: '3'.repeat(32) }
    saveRemoteDevice(device, storage)
    saveRemoteDevice(other, storage)
    expect(readRemoteDevices(storage)).toEqual([other, device])
    const index = storage.getItem('clerkbox:remote:v1:devices')!
    expect(index).not.toContain(device.token)
    expect(index).not.toContain(device.key)
    forgetRemoteDevice(device, storage)
    expect(readRemoteDevices(storage)).toEqual([other])
    storage.setItem('clerkbox:remote:v1:devices', '{broken')
    expect(readRemoteDevices(storage)).toEqual([])
  })
})

describe('encrypted browser remote transport', () => {
  it.each(['original', 'refreshed'])('uses this browser\'s paired credential when scanning an %s invitation for the same room', async variant => {
    const scanned = variant === 'original' ? invite : { ...invite, token: '9'.repeat(64), key: '8'.repeat(64) }
    const { client, sockets, credentials } = create({ readCredentials: () => [device] })
    client.connect(scanned)
    const hello = await handshake(sockets[0], device)
    expect(hello.kind).toBe('hello')
    expect(sockets[0].sent[0]).toEqual({ type: 'auth', role: 'browser', token: device.token, deviceId: device.deviceId })
    await deliver(sockets[0], device, { kind: 'connected', challenge: '1'.repeat(64), bootstrap })
    await vi.waitFor(() => expect(client.getConnection().state).toBe('connected'))
    expect(credentials).toEqual([]) // No new approval or device credential was needed.
  })
  it('falls back once to the scanned invitation when stored credentials are refused, then replaces the old device only after pairing succeeds', async () => {
    const forget = vi.fn()
    const replacement = { ...device, deviceId: '7'.repeat(32), token: '6'.repeat(64), key: '5'.repeat(64) }
    const { client, sockets, credentials } = create({ readCredentials: () => [device], forgetCredential: forget })
    client.connect(invite)
    sockets[0].open()
    sockets[0].receive({ type: 'error', error: 'Connection unavailable' })
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    expect(forget).not.toHaveBeenCalled() // A full relay can also refuse an otherwise valid credential.
    const hello = await handshake(sockets[1], invite, '2'.repeat(64))
    expect(hello.kind).toBe('pair')
    expect(sockets[1].sent[0]).toEqual({ type: 'auth', role: 'browser', token: invite.token })
    await deliver(sockets[1], invite, { kind: 'paired', challenge: '2'.repeat(64), credential: replacement })
    await vi.waitFor(() => expect(sockets).toHaveLength(3))
    expect(credentials).toEqual([replacement])
    expect(forget).toHaveBeenCalledWith(device)
  })
  it('does not loop on a revoked credential plus expired invitation or fall back for another room or transient network failure', async () => {
    const { client, sockets } = create({ readCredentials: () => [device] })
    client.connect(invite)
    sockets[0].open()
    sockets[0].fail(4003)
    expect(sockets).toHaveLength(2)
    sockets[1].open()
    sockets[1].fail(4003)
    expect(sockets).toHaveLength(2)
    expect(client.getConnection().error).toBe('remoteAccess.cloudRevoked')
    client.connect({ ...invite, roomId: '9'.repeat(32) })
    expect((await handshake(sockets[2], invite)).kind).toBe('pair')
    client.connect(invite)
    sockets[3].open()
    sockets[3].fail(1006)
    expect(sockets).toHaveLength(4)
    expect(client.getConnection().state).toBe('reconnecting')
  })
  it('uses a credential-free relay URL, verifies pairing code and rotates to device credentials', async () => {
    const { client, sockets, urls, credentials } = create()
    client.connect(invite)
    expect(urls[0]).toBe(`wss://webui.clerkbox.xmzf.space/relay/${invite.roomId}`)
    const hello = await handshake(sockets[0], invite)
    expect(hello.kind).toBe('pair')
    expect(JSON.stringify(sockets[0].frames())).not.toContain('pair')
    const challenge = '1'.repeat(64)
    const code = (await sha256Hex(challenge + invite.key)).slice(0, 8).toUpperCase()
    await deliver(sockets[0], invite, { kind: 'pending', challenge, code })
    await vi.waitFor(() => expect(client.getConnection()).toEqual({ state: 'pairing', code }))
    await deliver(sockets[0], invite, { kind: 'paired', challenge, credential: device })
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    expect(credentials).toEqual([device])
    const pairedHello = await handshake(sockets[1], device, '2'.repeat(64))
    expect(pairedHello.kind).toBe('hello')
    expect(sockets[1].sent[0]).toEqual({ type: 'auth', role: 'browser', token: device.token, deviceId: device.deviceId })
  })
  it('rejects a mismatching desktop verification code', async () => {
    const { client, sockets } = create()
    client.connect(invite)
    await handshake(sockets[0], invite)
    await deliver(sockets[0], invite, { kind: 'pending', challenge: '1'.repeat(64), code: '00000000' })
    await vi.waitFor(() => expect(client.getConnection().state).toBe('error'))
  })
  it('restores paired-device access after a reload without reusing the invitation key', async () => {
    const storage = new MemoryStorage()
    saveRemoteDevice(device, storage)
    const restored = readRemoteDevices(storage)[0]
    const { client, sockets } = create()
    client.connect(restored)
    const hello = await handshake(sockets[0], restored)
    expect(hello.kind).toBe('hello')
    expect(sockets[0].sent[0]).toMatchObject({ role: 'browser', deviceId: device.deviceId, token: device.token })
    await deliver(sockets[0], restored, { kind: 'connected', challenge: '1'.repeat(64), bootstrap })
    await vi.waitFor(() => expect(client.getConnection().state).toBe('connected'))
    expect(client.getStorageScope()).toBe(`${device.roomId}:${device.deviceId}`)
  })
  it('rejects oversized operations before sending and caps pending work without reconnecting', async () => {
    const { client, socket, sockets } = await connectDevice()
    await expect(client.invoke('agent:command', ['中'.repeat(170_000)])).rejects.toThrow('cloudRequestTooLarge')
    expect(socket.frames()).toHaveLength(1)
    expect(client.getConnection().state).toBe('connected')
    const pending = Array.from({ length: 64 }, () => client.invoke('dbGetRevision').catch(error => error.message))
    await expect(client.invoke('dbGetRevision')).rejects.toThrow('cloudTooManyRequests')
    expect(sockets).toHaveLength(1)
    client.disconnect()
    expect(await Promise.all(pending)).toEqual(Array(64).fill('remoteAccess.cloudDisconnected'))
  })
  it('matches responses by request and challenge, and only delivers authenticated events', async () => {
    const { client, socket } = await connectDevice()
    const events: unknown[] = []
    client.subscribeEvents(event => events.push(event))
    const result = client.invoke('dbGetMessages', ['session-one'])
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(2))
    const request = await open<Record<string, unknown>>(device.key, socket.frames()[1].payload)
    expect(request).toMatchObject({ kind: 'request', method: 'dbGetMessages', args: ['session-one'], challenge: '1'.repeat(64) })
    expect(request.id).toMatch(/^[a-f0-9]{32}$/)
    await deliver(socket, device, { kind: 'response', challenge: '2'.repeat(64), id: request.id, result: 'stale' })
    await deliver(socket, device, { kind: 'response', challenge: '1'.repeat(64), id: request.id, result: ['current'] })
    expect(await result).toEqual(['current'])
    const payload = { seq: 1, event: { type: 'run.completed', sessionId: 'session-one', ts: Date.now() } }
    await deliver(socket, device, { kind: 'event', challenge: '1'.repeat(64), payload })
    await vi.waitFor(() => expect(events).toEqual([payload]))
  })
  it('retries an unacknowledged request with the same id after a new connection challenge', async () => {
    const { client, socket, sockets } = await connectDevice()
    const result = client.invoke('dbGetRevision')
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(2))
    const original = await open<Record<string, unknown>>(device.key, socket.frames()[1].payload)
    socket.fail()
    client.reconnect()
    const next = sockets[1]
    await handshake(next, device, '2'.repeat(64))
    await deliver(next, device, { kind: 'connected', challenge: '2'.repeat(64), bootstrap })
    await vi.waitFor(() => expect(next.frames()).toHaveLength(2))
    const replayed = await open<Record<string, unknown>>(device.key, next.frames()[1].payload)
    expect(replayed).toEqual({ ...original, challenge: '2'.repeat(64) })
    await deliver(next, device, { kind: 'response', challenge: '2'.repeat(64), id: replayed.id, result: 5 })
    expect(await result).toBe(5)
  })
  it('delivers bounded authenticated event batches in host order and ignores stale challenges', async () => {
    const { client, socket } = await connectDevice()
    const events: unknown[] = []
    client.subscribeEvents(event => events.push(event))
    const payloads = [1, 2, 3].map(seq => ({ seq, event: { type: 'assistant.delta', sessionId: 'session-one', text: String(seq), ts: Date.now() } }))
    await deliver(socket, device, { kind: 'events', challenge: '2'.repeat(64), payloads })
    await deliver(socket, device, { kind: 'events', challenge: '1'.repeat(64), payloads })
    await vi.waitFor(() => expect(events).toEqual(payloads))
    await deliver(socket, device, { kind: 'events', challenge: '1'.repeat(64), payloads: Array(1001).fill(payloads[0]) })
    await vi.waitFor(() => expect(client.getConnection().state).toBe('error'))
  })
  it('reassembles a large encrypted history reply with bounded authenticated chunks', async () => {
    const { client, socket } = await connectDevice()
    const result = client.invoke('dbGetMessages', ['long-session'])
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(2))
    const request = await open<Record<string, unknown>>(device.key, socket.frames()[1].payload)
    const expected = [{ content: 'history'.repeat(90_000) }]
    const reply = JSON.stringify({ kind: 'response', challenge: '1'.repeat(64), id: request.id, result: expected })
    const size = 48 * 1024
    const count = Math.ceil(reply.length / size)
    for (let index = count - 1; index >= 0; index--) await deliver(socket, device, { kind: 'chunk', challenge: '1'.repeat(64), transferId: '4'.repeat(32), index, count, data: reply.slice(index * size, (index + 1) * size) })
    expect(await result).toEqual(expected)
  })
  it('stops on revoked credentials and rejects pending work instead of hiding the failure', async () => {
    const { client, socket } = await connectDevice()
    const result = client.invoke('dbGetRevision').catch(error => error.message)
    socket.fail(4403)
    expect(client.getConnection()).toMatchObject({ state: 'error', error: 'remoteAccess.cloudRevoked' })
    expect(await result).toBe('remoteAccess.cloudRevoked')
    await expect(client.invoke('dbGetRevision')).rejects.toThrow('cloudDisconnected')
  })
  it('keeps a progressing history transfer alive beyond thirty seconds', async () => {
    const { client, socket } = await connectDevice()
    const result = client.invoke('dbGetMessages', ['slow-session'])
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(2))
    const request = await open<Record<string, unknown>>(device.key, socket.frames()[1].payload)
    const reply = JSON.stringify({ kind: 'response', challenge: '1'.repeat(64), id: request.id, result: ['complete'] })
    const midpoint = Math.ceil(reply.length / 2)
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      await deliver(socket, device, { kind: 'chunk', challenge: '1'.repeat(64), transferId: '5'.repeat(32), index: 0, count: 2, data: reply.slice(0, midpoint) })
      await new Promise(resolve => setTimeout(resolve, 15))
      now.mockReturnValue(start + 45_000)
      await deliver(socket, device, { kind: 'chunk', challenge: '1'.repeat(64), transferId: '5'.repeat(32), index: 1, count: 2, data: reply.slice(midpoint) })
      expect(await result).toEqual(['complete'])
    } finally { now.mockRestore() }
  })
  it('fails a stalled history transfer explicitly instead of leaving requests pending', async () => {
    const { client, socket } = await connectDevice()
    const result = client.invoke('dbGetMessages', ['stalled-session']).catch(error => error.message)
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      await deliver(socket, device, { kind: 'chunk', challenge: '1'.repeat(64), transferId: '6'.repeat(32), index: 0, count: 2, data: '{' })
      await new Promise(resolve => setTimeout(resolve, 15))
      now.mockReturnValue(start + 121_000)
      await deliver(socket, device, { kind: 'chunk', challenge: '1'.repeat(64), transferId: '6'.repeat(32), index: 1, count: 2, data: '}' })
      expect(await result).toBe('remoteAccess.cloudTransferTimeout')
      expect(client.getConnection()).toMatchObject({ state: 'error', error: 'remoteAccess.cloudTransferTimeout' })
    } finally { now.mockRestore() }
  })
  it('marks an offline host as reconnecting and waits for a new authenticated challenge', async () => {
    const { client, socket } = await connectDevice()
    socket.receive({ type: 'host.offline' })
    await vi.waitFor(() => expect(client.getConnection().state).toBe('reconnecting'))
    socket.receive({ type: 'pong' })
    await deliver(socket, device, { kind: 'connected', challenge: '1'.repeat(64), bootstrap })
    expect(client.getConnection().state).toBe('reconnecting')
    socket.receive({ type: 'host.online' })
    socket.receive({ type: 'data', payload: { challenge: '2'.repeat(64) } })
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(2))
    await deliver(socket, device, { kind: 'connected', challenge: '2'.repeat(64), bootstrap })
    await vi.waitFor(() => expect(client.getConnection().state).toBe('connected'))
  })
  it('reports a rejected pairing instead of leaving the verification screen pending', async () => {
    const { client, sockets } = create()
    client.connect(invite)
    await handshake(sockets[0], invite)
    await deliver(sockets[0], invite, { kind: 'rejected', challenge: '1'.repeat(64) })
    await vi.waitFor(() => expect(client.getConnection()).toMatchObject({ state: 'error', error: 'remoteAccess.cloudPairRejected' }))
  })
})
