import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { ChatStore } from '../electron/db'
import { AgentSessionManager, registerAgentEventSink, setAgentHostWindowProbeForTest, setRuntimeAgentHostMode } from '../electron/agent-host'
import { RemoteAccessService } from '../electron/remote-access'
import { open, randomHex, seal } from '../src/remote/crypto'
import type { AgentEvent } from '../src/agent-core/protocol'
import type { RemoteDeviceCredential, RemoteInvite } from '../src/remote/protocol'

// Keep manager, dispatcher, replay and encryption real. Only the network transport is fake.
class RelaySocket {
  static OPEN = 1
  static instances: RelaySocket[] = []
  readyState = 0
  bufferedAmount = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: Record<string, unknown>[] = []
  constructor(_url: string) {
    RelaySocket.instances.push(this)
    queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
  }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
  send(value: string): void {
    const frame = JSON.parse(value) as Record<string, unknown>
    this.sent.push(frame)
    if (frame.type === 'auth') queueMicrotask(() => this.receive({ type: 'ready', role: 'host' }))
    if (frame.type === 'invite') queueMicrotask(() => this.receive({ type: 'invite.ready', tokenHash: frame.tokenHash }))
    if (frame.type === 'authorize') queueMicrotask(() => this.receive({ type: 'authorized', deviceId: frame.deviceId }))
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
}

type EventPayload = { seq: number; event: AgentEvent }
let manager: AgentSessionManager
let service: RemoteAccessService
let workspace: string
let events: EventPayload[]
let offEvents: () => void

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'clerkbox-real-replay-'))
  RelaySocket.instances.length = 0
  vi.stubGlobal('WebSocket', RelaySocket)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
  setAgentHostWindowProbeForTest(() => [])
  const rows = Array.from({ length: 103 }, (_, index) => ({ id: `s${index}`, title: `History ${index}`, created_at: 1, updated_at: 1, working_dir: workspace }))
  manager = new AgentSessionManager({ getAllSessions: async () => rows } as unknown as ChatStore)
  service = new RemoteAccessService({
    store: { getAllSessions: async () => rows } as unknown as ChatStore,
    manager, readCredential: async () => null, writeCredential: async () => {}, deleteCredential: async () => {}, notify: () => {},
    origin: 'https://webui.clerkbox.test',
  })
  events = []
  offEvents = registerAgentEventSink(payload => { events.push(payload) })
})

afterEach(async () => {
  offEvents()
  service.dispose()
  setAgentHostWindowProbeForTest(null)
  setRuntimeAgentHostMode(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await fs.rm(workspace, { recursive: true, force: true })
})

async function decrypt(socket: RelaySocket, peerId: string, key: string): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = []
  for (const frame of socket.sent) {
    if (frame.type !== 'data' || frame.peerId !== peerId || (frame.payload as { v?: number })?.v !== 1) continue
    try { result.push(await open(key, frame.payload)) } catch { /* Invitation and device keys differ. */ }
  }
  return result
}

async function join(socket: RelaySocket, peerId: string, extra: Record<string, unknown>): Promise<string> {
  socket.receive({ type: 'peer.joined', peerId, ...extra })
  let challenge = ''
  await vi.waitFor(() => {
    const frame = socket.sent.find(value => value.type === 'data' && value.peerId === peerId && typeof (value.payload as { challenge?: string })?.challenge === 'string')
    challenge = (frame?.payload as { challenge?: string })?.challenge || ''
    expect(challenge).not.toBe('')
  })
  return challenge
}

async function send(socket: RelaySocket, peerId: string, key: string, value: unknown): Promise<void> {
  socket.receive({ type: 'data', peerId, payload: await seal(key, value) })
}

async function pair(name: string) {
  const status = service.getStatus().enabled ? await service.createInvite() : await service.enable({ workspace, approve: true, files: true })
  const invite = JSON.parse(decodeURIComponent(new URL(status.url!).hash.slice('#invite='.length))) as RemoteInvite
  const socket = RelaySocket.instances.at(-1)!
  const pairingId = `${name}-pair`
  const pairingChallenge = await join(socket, pairingId, { invited: true })
  await send(socket, pairingId, invite.key, { kind: 'pair', challenge: pairingChallenge, name })
  await vi.waitFor(() => expect(service.getStatus().pending.some(peer => peer.id === pairingId)).toBe(true))
  await service.approvePair(pairingId, true)
  const credential = (await decrypt(socket, pairingId, invite.key)).find(value => value.kind === 'paired')!.credential as RemoteDeviceCredential
  socket.receive({ type: 'peer.left', peerId: pairingId })
  const challenge = await join(socket, name, { deviceId: credential.deviceId })
  await send(socket, name, credential.key, { kind: 'hello', challenge })
  await vi.waitFor(async () => expect((await decrypt(socket, name, credential.key)).some(value => value.kind === 'connected')).toBe(true))
  return { socket, peerId: name, credential, challenge }
}

async function requestSnapshot(peer: Awaited<ReturnType<typeof pair>>): Promise<void> {
  const id = randomHex(16)
  await send(peer.socket, peer.peerId, peer.credential.key, { kind: 'request', challenge: peer.challenge, id, issuedAt: Date.now(), method: 'agent:snapshot', args: [null, 0] })
  await vi.waitFor(async () => {
    const response = (await decrypt(peer.socket, peer.peerId, peer.credential.key)).find(value => value.kind === 'response' && value.id === id)
    expect(response).toBeDefined()
    expect(response!.error).toBeUndefined()
  }, { timeout: 10000 })
}

async function replayed(peer: Awaited<ReturnType<typeof pair>>): Promise<EventPayload[]> {
  return (await decrypt(peer.socket, peer.peerId, peer.credential.key))
    .filter(value => value.kind === 'events')
    .flatMap(value => value.payloads as EventPayload[])
}

describe('real manager replay over the public workbench transport', () => {
  it('replays a synchronous burst from 103 existing runtimes without the async filter limit', async () => {
    for (let index = 0; index < 103; index++) manager.snapshot(`s${index}`)
    const peer = await pair('browser')
    events.length = 0
    await requestSnapshot(peer)
    expect(events.length).toBeGreaterThan(256)
    const received = await replayed(peer)
    expect(received).toEqual(events)
    expect(manager.inspect()).toHaveLength(103)
    expect(service.getStatus().devices[0].online).toBe(true)
    expect(peer.socket.sent.some(frame => frame.type === 'disconnect')).toBe(false)
  }, 15000)

  it('drains more than 5000 real ring events for every connected device in bounded batches', async () => {
    for (let session = 0; session < 12; session++) {
      for (let index = 0; index < 250; index++) {
        await manager.handleCommand({ type: 'queue.enqueue', sessionId: `s${session}`, item: { id: `q${index}`, content: '', queuedAt: index } })
        await manager.handleCommand({ type: 'queue.remove', sessionId: `s${session}`, id: `q${index}` })
      }
    }
    const first = await pair('first')
    const second = await pair('second')
    events.length = 0
    await requestSnapshot(first)
    expect(events.length).toBeGreaterThan(5000)
    expect(await replayed(first)).toEqual(events)
    expect(await replayed(second)).toEqual(events)
    expect(service.getStatus().devices.every(device => device.online)).toBe(true)
    expect(first.socket.sent.some(frame => frame.type === 'disconnect')).toBe(false)
    expect(manager.inspect()).toHaveLength(12)
  }, 15000)

  it('lets a replay barrier finish when a stalled peer goes offline during its flush', async () => {
    for (let index = 0; index < 103; index++) manager.snapshot(`s${index}`)
    const first = await pair('first')
    const second = await pair('second')
    const internal = service as unknown as { sendEncrypted(peer: { id: string }, value: { kind?: string }): Promise<void> }
    const original = internal.sendEncrypted.bind(service)
    let release!: () => void
    let stalled = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const sending = vi.spyOn(internal, 'sendEncrypted').mockImplementation(async (peer, value) => {
      if (peer.id === first.peerId && value.kind === 'events') { stalled = true; await gate }
      return original(peer, value)
    })
    try {
      const replay = requestSnapshot(second)
      await vi.waitFor(() => expect(stalled).toBe(true))
      first.socket.receive({ type: 'peer.left', peerId: first.peerId })
      await replay
      expect(service.getStatus().devices).toMatchObject([{ id: first.credential.deviceId, online: false }, { id: second.credential.deviceId, online: true }])
      expect(first.socket.sent.some(frame => frame.type === 'revoke')).toBe(false)
      expect((await replayed(second)).length).toBeGreaterThan(256)
    } finally { release(); sending.mockRestore() }
  }, 15000)
})
