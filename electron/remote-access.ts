import fs from 'fs/promises'
import os from 'os'
import { randomHex, seal, open, sha256Hex } from '../src/remote/crypto'
import { DEFAULT_REMOTE_ORIGIN, REMOTE_MAX_FRAME_BYTES, type RemoteAccessStatus, type RemoteEnableOptions, type RemoteDeviceCredential, type RemotePrincipal, type RemoteRequest } from '../src/remote/protocol'
import { createRemoteHostDispatcher } from './remote-host-dispatcher'
import { registerAgentEventSink, setRuntimeAgentHostMode, type AgentSessionManager } from './agent-host'
import type { ChatStore } from './db'
import type { AgentEvent } from '../src/agent-core/protocol'
import { subscribeRemoteUiEvents } from './remote-ui-events'

interface Device extends RemoteDeviceCredential { createdAt: number; lastSeenAt: number; workspace: string; scope?: 'desktop'; control: boolean; approve: boolean; files: boolean }
interface Receipt { id: string; deviceId: string; issuedAt: number; state: 'pending' | 'done'; result?: unknown; error?: string }
interface Saved { roomId: string; hostToken: string; registered?: boolean; options: RemoteEnableOptions & { workspace: string }; devices: Device[]; receipts: Receipt[] }
interface QueueBudget { count: number; bytes: number }
interface IncomingBudget extends QueueBudget { dropped: boolean }
interface EventBuffer { peer: Peer; events: Array<{ seq: number; event: AgentEvent }>; bytes: number; enqueued: number; sent: number; ended: Promise<void>; end(): void; flushing?: Promise<void>; timer?: ReturnType<typeof setTimeout> }
interface Peer { id: string; deviceId?: string; key: string; challenge: string; ready: boolean; requestedAt: number; name?: string; code?: string; approving?: boolean; inviteToken?: string; inviteExpiresAt?: number; seen: Set<string>; filtering: QueueBudget; uiSending: QueueBudget }
type DiagnosticReason = 'ui-queue-limit' | 'ui-send-failed' | 'event-filter-queue-limit' | 'event-queue-limit' | 'event-send-failed' | 'peer-decrypt-failed' | 'peer-limit' | 'peer-credential-unavailable' | 'bootstrap-failed' | 'bootstrap-send-failed' | 'incoming-peer-queue-limit' | 'incoming-total-queue-limit' | 'frame-processing-failed' | 'relay-send-failed' | 'peer-send-failed' | 'outbound-backpressure' | 'response-send-failed'
interface Options {
  store: ChatStore
  manager: AgentSessionManager
  readCredential(): Promise<string | null>
  writeCredential(value: string): Promise<void>
  deleteCredential(): Promise<void>
  notify(status: RemoteAccessStatus): void
  onDeviceRevoked?(deviceId?: string): void
  origin?: string
}

/** Outbound-only connector. The relay never receives this service's encryption keys. */
export class RemoteAccessService {
  private saved: Saved | null = null
  private socket: WebSocket | null = null
  private peers = new Map<string, Peer>()
  private invite: { token: string; key: string; expiresAt: number } | null = null
  private inviteOperation: Promise<RemoteAccessStatus> | null = null
  private status: RemoteAccessStatus = { enabled: false, state: 'disabled', devices: [], pending: [] }
  private generation = 0
  private retry = 0
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private lastPong = 0
  private lastRenewed = 0
  private outbound: Promise<void> = Promise.resolve()
  private outboundWindow = 0
  private outboundCount = 0
  private outboundBytes = 0
  private chain: Promise<unknown> = Promise.resolve()
  private incoming = new Map<string, IncomingBudget>()
  // Includes old-socket callbacks until their captured frames actually leave the chain.
  // Do not reset on reconnect: doing so would hide retained work from the hard limit.
  private incomingTotal: QueueBudget = { count: 0, bytes: 0 }
  private diagnostics = new Map<DiagnosticReason, number>()
  private writes: Promise<void> = Promise.resolve()
  private waiters = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly dispatcher
  private readonly origin: string
  private readonly unsubscribe: () => void
  private readonly unsubscribeUi: () => void
  private eventBuffers = new Map<string, EventBuffer>()

  constructor(private options: Options) {
    const origin = new URL(options.origin ?? DEFAULT_REMOTE_ORIGIN)
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('Remote relay must use HTTPS')
    this.origin = origin.origin
    this.dispatcher = createRemoteHostDispatcher({ store: options.store, manager: options.manager, drainEvents: force => this.drainEvents(force) })
    this.unsubscribeUi = subscribeRemoteUiEvents(event => {
      for (const peer of this.peers.values()) {
        const principal = this.principal(peer)
        if (!principal?.isActive() || principal.scope !== 'desktop') continue
        if ((event.channel === 'pty:data' || event.channel === 'pty:exit') &&
          (typeof event.args[0] !== 'string' || !event.args[0].startsWith(`remote-${principal.deviceId}-`))) continue
        const bytes = Buffer.byteLength(JSON.stringify(event))
        if (peer.uiSending.count >= 256 || peer.uiSending.bytes + bytes > 8 * 1024 * 1024) {
          this.dropPeer(peer, 'ui-queue-limit'); continue
        }
        peer.uiSending.count++; peer.uiSending.bytes += bytes
        void this.sendEncrypted(peer, { kind: 'ui-event', challenge: peer.challenge, channel: event.channel, args: event.args }).catch(() => {
          this.dropPeer(peer, 'ui-send-failed')
        }).finally(() => { peer.uiSending.count--; peer.uiSending.bytes -= bytes })
      }
    })
    this.unsubscribe = registerAgentEventSink(payload => {
      const bytes = Buffer.byteLength(JSON.stringify(payload))
      for (const peer of this.peers.values()) {
        const principal = this.principal(peer)
        if (!principal || !peer.ready) continue
        const filtered = this.dispatcher.filterEvent(principal, payload)
        if (!(filtered instanceof Promise)) {
          if (filtered && principal.isActive()) this.queueEvent(peer, filtered)
          continue
        }
        if (peer.filtering.count >= 256 || peer.filtering.bytes + bytes > 16 * 1024 * 1024) {
          void filtered.catch(() => {})
          this.dropPeer(peer, 'event-filter-queue-limit'); continue
        }
        peer.filtering.count++; peer.filtering.bytes += bytes
        void filtered.then(filtered => {
          if (filtered && principal.isActive()) this.queueEvent(peer, filtered)
        }).catch(() => {}).finally(() => { peer.filtering.count--; peer.filtering.bytes -= bytes })
      }
    })
  }

  private diagnose(reason: DiagnosticReason): void {
    const now = Date.now()
    const previous = this.diagnostics.get(reason)
    if (previous !== undefined && now - previous < 10000) return
    this.diagnostics.set(reason, now)
    // Fixed reason codes only: never log payloads, credentials, room or device IDs.
    console.warn('[remote-access]', reason)
  }
  private dropPeer(peer: Peer, reason: DiagnosticReason): void {
    if (this.peers.get(peer.id) !== peer) return
    this.diagnose(reason)
    this.forgetPeer(peer.id)
    this.send({ type: 'disconnect', peerId: peer.id })
    this.publish()
  }
  private forgetPeer(peerId: string): void {
    this.peers.delete(peerId)
    const buffer = this.eventBuffers.get(peerId)
    if (buffer?.timer) clearTimeout(buffer.timer)
    buffer?.end()
    this.eventBuffers.delete(peerId)
  }
  private queueEvent(peer: Peer, payload: { seq: number; event: AgentEvent }): void {
    if (this.peers.get(peer.id) !== peer) return
    let buffer = this.eventBuffers.get(peer.id)
    if (!buffer) {
      let end!: () => void
      const ended = new Promise<void>(resolve => { end = resolve })
      buffer = { peer, events: [], bytes: 0, enqueued: 0, sent: 0, ended, end }
      this.eventBuffers.set(peer.id, buffer)
    }
    buffer.events.push(payload)
    buffer.enqueued++
    buffer.bytes += Buffer.byteLength(JSON.stringify(payload))
    if (buffer.events.length > 4000 || buffer.bytes > 8 * 1024 * 1024) { this.dropPeer(peer, 'event-queue-limit'); return }
    if (buffer.timer || buffer.flushing) return
    const active = buffer
    active.timer = setTimeout(() => { active.timer = undefined; void this.flushEvents(active) }, 100)
    active.timer.unref?.()
  }
  private flushEvents(buffer: EventBuffer): Promise<void> {
    if (buffer.flushing) return buffer.flushing
    if (this.peers.get(buffer.peer.id) !== buffer.peer || this.eventBuffers.get(buffer.peer.id) !== buffer) return Promise.resolve()
    if (buffer.timer) { clearTimeout(buffer.timer); buffer.timer = undefined }
    const payloads = buffer.events.splice(0, 1000)
    buffer.bytes -= payloads.reduce((total, payload) => total + Buffer.byteLength(JSON.stringify(payload)), 0)
    const operation = this.sendEncrypted(buffer.peer, { kind: 'events', challenge: buffer.peer.challenge, payloads }).then(() => {
      buffer.sent += payloads.length
    }).catch(() => { this.dropPeer(buffer.peer, 'event-send-failed') })
    buffer.flushing = operation
    void operation.then(() => {
      if (buffer.flushing === operation) buffer.flushing = undefined
      if (this.peers.get(buffer.peer.id) !== buffer.peer || this.eventBuffers.get(buffer.peer.id) !== buffer) return
      if (buffer.events.length) { buffer.timer = setTimeout(() => { buffer.timer = undefined; void this.flushEvents(buffer) }, 100); buffer.timer.unref?.() }
      else this.eventBuffers.delete(buffer.peer.id)
    })
    return operation
  }
  private async drainEvents(force = true): Promise<void> {
    // A fixed barrier does not wait forever for live events arriving afterwards.
    const buffers = [...this.eventBuffers.values()]
    if (!force && !buffers.some(buffer => buffer.events.length >= 1000 || buffer.bytes >= 512 * 1024)) return
    const targets = buffers.map(buffer => ({ buffer, through: buffer.enqueued }))
    await Promise.all(targets.map(async ({ buffer, through }) => {
      while (buffer.sent < through && this.peers.get(buffer.peer.id) === buffer.peer && this.eventBuffers.get(buffer.peer.id) === buffer) {
        await Promise.race([this.flushEvents(buffer), buffer.ended])
      }
    }))
  }

  getStatus(): RemoteAccessStatus {
    const now = Date.now()
    return {
      ...this.status,
      workspace: this.saved?.options.workspace,
      scope: this.saved?.options.scope,
      permissions: this.saved ? { approve: this.saved.options.approve, files: this.saved.options.files } : undefined,
      url: this.invite && this.invite.expiresAt > now && this.saved ? `${this.origin}/#invite=${encodeURIComponent(JSON.stringify({ protocol: 1, roomId: this.saved.roomId, token: this.invite.token, key: this.invite.key }))}` : undefined,
      inviteExpiresAt: this.invite?.expiresAt,
      devices: this.saved?.devices.map(device => ({ id: device.deviceId, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, online: [...this.peers.values()].some(peer => peer.deviceId === device.deviceId && peer.ready), control: device.control, approve: device.approve, files: device.files, scope: device.scope })) ?? [],
      pending: [...this.peers.values()].filter(peer => !peer.deviceId && peer.name && peer.code && now - peer.requestedAt < 120000).map(peer => ({ id: peer.id, name: peer.name!, code: peer.code!, requestedAt: peer.requestedAt })),
    }
  }
  private publish(patch: Partial<RemoteAccessStatus> = {}): void {
    this.status = { ...this.status, ...patch }
    this.options.notify(this.getStatus())
  }
  private persist(): Promise<void> {
    const value = this.saved ? JSON.stringify(this.saved) : null
    const write = this.writes.catch(() => {}).then(() => value ? this.options.writeCredential(value) : this.options.deleteCredential())
    this.writes = write
    return write
  }
  async restore(): Promise<void> {
    try {
      const raw = await this.options.readCredential()
      if (!raw) return
      const saved = JSON.parse(raw) as Saved
      if (!/^[a-f0-9]{32}$/.test(saved.roomId) || !/^[a-f0-9]{64}$/.test(saved.hostToken) || !saved.options || !Array.isArray(saved.devices)) throw new Error('Invalid remote configuration')
      saved.options.workspace = await fs.realpath(saved.options.workspace)
      saved.receipts = Array.isArray(saved.receipts) ? saved.receipts.filter(receipt => Date.now() - receipt.issuedAt < 86400000) : []
      saved.registered ??= true
      this.saved = saved
      setRuntimeAgentHostMode('main')
      this.publish({ enabled: true, state: 'connecting', error: undefined })
      void this.connect(++this.generation).catch(() => {})
    } catch {
      this.publish({ enabled: false, state: 'error', error: 'remote-restore-failed' })
    }
  }
  async enable(input: RemoteEnableOptions): Promise<RemoteAccessStatus> {
    if (this.saved) return this.getStatus()
    if (!input || (input.workspace !== undefined && typeof input.workspace !== 'string') || (input.scope !== undefined && input.scope !== 'desktop') || typeof input.approve !== 'boolean' || typeof input.files !== 'boolean') throw new Error('Invalid remote access options')
    const workspace = await fs.realpath(input.workspace?.trim() || os.homedir())
    if (!(await fs.stat(workspace)).isDirectory()) throw new Error('Invalid default working directory')
    this.saved = { roomId: randomHex(16), hostToken: randomHex(), registered: false, options: { workspace, scope: 'desktop', approve: input.approve, files: input.files }, devices: [], receipts: [] }
    try { await this.persist() } catch { this.saved = null; throw new Error('Unable to securely save remote access credentials') }
    setRuntimeAgentHostMode('main')
    this.publish({ enabled: true, state: 'connecting', error: undefined })
    await this.connect(++this.generation)
    return this.createInvite()
  }
  async disable(): Promise<RemoteAccessStatus> {
    ++this.generation
    this.inviteOperation = null
    this.send({ type: 'stop' })
    this.saved = null
    this.options.onDeviceRevoked?.()
    this.invite = null
    this.clearConnection()
    await this.persist()
    // Keep the established main-process execution mode until app restart.
    // Switching an active task back to the renderer would create two owners.
    this.publish({ enabled: false, state: 'disabled', error: undefined })
    return this.getStatus()
  }
  async createInvite(): Promise<RemoteAccessStatus> {
    // Native IPC callers may overlap even though the dialog disables its button.
    // Coalesce one rotation instead of replacing another call's acknowledgement.
    if (this.inviteOperation) return this.inviteOperation
    const operation = this.rotateInvite()
    this.inviteOperation = operation
    try { return await operation }
    finally { if (this.inviteOperation === operation) this.inviteOperation = null }
  }
  private async rotateInvite(): Promise<RemoteAccessStatus> {
    if (!this.saved || this.status.state !== 'online') throw new Error('Remote desktop is not connected')
    const saved = this.saved
    const generation = this.generation
    // Revoke the old local invitation before any await. A failed refresh must
    // never leave a displayed old link or an approvable old pairing request.
    this.invite = null
    for (const peer of this.peers.values()) if (!peer.deviceId) { this.send({ type: 'disconnect', peerId: peer.id }); this.forgetPeer(peer.id) }
    this.publish()
    const invite = { token: randomHex(), key: randomHex(), expiresAt: Date.now() + 10 * 60000 }
    const tokenHash = await sha256Hex(invite.token)
    if (saved !== this.saved || generation !== this.generation || this.status.state !== 'online') throw new Error('Remote connection closed')
    const ack = this.waitFor(`invite.ready:${tokenHash}`)
    this.send({ type: 'invite', tokenHash, expiresAt: invite.expiresAt })
    await ack
    if (saved !== this.saved || generation !== this.generation) throw new Error('Remote connection closed')
    this.invite = invite
    this.publish()
    return this.getStatus()
  }
  async approvePair(peerId: string, approved: boolean): Promise<RemoteAccessStatus> {
    const peer = this.peers.get(peerId)
    if (!peer || peer.deviceId || peer.approving || !peer.name || !peer.code || !this.pairLive(peer) || !this.saved) throw new Error('Pair request expired')
    const saved = this.saved
    const generation = this.generation
    const assertCurrent = () => { if (this.saved !== saved || this.generation !== generation || !this.pairLive(peer) || this.peers.get(peerId) !== peer) throw new Error('Pair request expired') }
    if (!approved) {
      await this.sendEncrypted(peer, { kind: 'rejected', challenge: peer.challenge })
      this.send({ type: 'disconnect', peerId })
      this.forgetPeer(peerId)
      this.publish()
      return this.getStatus()
    }
    const device: Device = { protocol: 1, roomId: this.saved.roomId, deviceId: randomHex(16), token: randomHex(), key: randomHex(), name: peer.name, createdAt: Date.now(), lastSeenAt: Date.now(), workspace: this.saved.options.workspace, scope: 'desktop', control: true, approve: this.saved.options.approve, files: this.saved.options.files }
    if (this.saved.devices.length >= 8) throw new Error('Remote device limit reached')
    peer.approving = true
    this.saved.devices.push(device)
    try {
      await this.persist()
      assertCurrent()
      const ack = this.waitFor(`authorized:${device.deviceId}`)
      this.send({ type: 'authorize', peerId, deviceId: device.deviceId, tokenHash: await sha256Hex(device.token) })
      await ack
      assertCurrent()
      // Authorization is now committed. A simultaneous invitation refresh must
      // preserve this approved device while its encrypted credential is sent.
      peer.deviceId = device.deviceId
      await this.sendEncrypted(peer, { kind: 'paired', challenge: peer.challenge, credential: { protocol: 1, roomId: device.roomId, deviceId: device.deviceId, token: device.token, key: device.key, name: os.hostname() } })
      if (this.invite?.token === peer.inviteToken) this.invite = null
      peer.name = undefined
      peer.code = undefined
      this.publish()
    } catch (error) {
      saved.devices = saved.devices.filter(item => item !== device)
      if (this.saved === saved) { await this.persist(); this.send({ type: 'revoke', deviceId: device.deviceId }) }
      if (peer.deviceId === device.deviceId) { this.forgetPeer(peerId); this.send({ type: 'disconnect', peerId }) }
      peer.approving = false
      throw error
    }
    return this.getStatus()
  }
  async revokeDevice(deviceId: string): Promise<RemoteAccessStatus> {
    if (!this.saved || !this.saved.devices.some(device => device.deviceId === deviceId)) throw new Error('Unknown remote device')
    this.saved.devices = this.saved.devices.filter(device => device.deviceId !== deviceId)
    this.options.onDeviceRevoked?.(deviceId)
    for (const peer of this.peers.values()) if (peer.deviceId === deviceId) this.forgetPeer(peer.id)
    this.send({ type: 'revoke', deviceId })
    await this.persist()
    this.publish()
    return this.getStatus()
  }
  private waitFor(type: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const previous = this.waiters.get(type)
      if (previous) { clearTimeout(previous.timer); previous.reject(new Error('Remote operation replaced')) }
      const timer = setTimeout(() => { this.waiters.delete(type); reject(new Error('Remote relay timed out')) }, 12000)
      this.waiters.set(type, { resolve, reject, timer })
    })
  }
  private resolveWaiter(type: string, value: unknown): void {
    const waiter = this.waiters.get(type)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.waiters.delete(type)
    waiter.resolve(value)
  }
  private pairLive(peer: Peer): boolean {
    return !!this.invite && this.invite.token === peer.inviteToken && Date.now() < (peer.inviteExpiresAt ?? 0) && Date.now() - peer.requestedAt < 120000
  }
  private send(value: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    try { this.socket.send(JSON.stringify(value)) }
    catch { this.diagnose('relay-send-failed'); this.socket?.close() }
  }
  private async sendEncrypted(peer: Peer, value: unknown): Promise<void> {
    const generation = this.generation
    const serialized = JSON.stringify(value)
    if (Buffer.byteLength(serialized) > 400 * 1024) {
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error('remote-response-too-large')
      const transferId = randomHex(16)
      const chunkSize = 48 * 1024
      const count = Math.ceil(serialized.length / chunkSize)
      for (let index = 0; index < count; index++) {
        if (generation !== this.generation || this.peers.get(peer.id) !== peer) return
        await this.sendEncrypted(peer, { kind: 'chunk', challenge: peer.challenge, transferId, index, count, data: serialized.slice(index * chunkSize, (index + 1) * chunkSize) })
      }
      return
    }
    let payload: Awaited<ReturnType<typeof seal>>
    try { payload = await seal(peer.key, value) }
    catch (error) { this.diagnose('peer-send-failed'); throw error }
    const frame = JSON.stringify({ type: 'data', peerId: peer.id, payload })
    const send = this.outbound.catch(() => {}).then(async () => {
      const now = Date.now()
      if (now - this.outboundWindow >= 10000) { this.outboundWindow = now; this.outboundCount = 0; this.outboundBytes = 0 }
      if (this.outboundCount >= 150 || this.outboundBytes + Buffer.byteLength(frame) > 48 * 1024 * 1024) {
        await new Promise(resolve => setTimeout(resolve, Math.max(1, 10050 - (now - this.outboundWindow))))
        this.outboundWindow = Date.now(); this.outboundCount = 0; this.outboundBytes = 0
      }
      if (generation !== this.generation || this.peers.get(peer.id) !== peer || this.socket?.readyState !== WebSocket.OPEN) return
      let waited = 0
      while (this.socket && this.socket.bufferedAmount > 2 * REMOTE_MAX_FRAME_BYTES && waited < 30000) { await new Promise(resolve => setTimeout(resolve, 20)); waited += 20 }
      if (generation !== this.generation || this.peers.get(peer.id) !== peer || this.socket?.readyState !== WebSocket.OPEN) return
      if (waited >= 30000) { this.diagnose('outbound-backpressure'); this.socket.close(); return }
      this.outboundCount++; this.outboundBytes += Buffer.byteLength(frame)
      try { this.socket.send(frame) }
      catch (error) { this.diagnose('peer-send-failed'); throw error }
    })
    this.outbound = send
    await send
  }
  private principal(peer: Peer): RemotePrincipal | null {
    if (!peer.ready || this.peers.get(peer.id) !== peer) return null
    const device = this.saved?.devices.find(item => item.deviceId === peer.deviceId)
    if (!device) return null
    return { deviceId: device.deviceId, workspace: device.workspace, scope: device.scope, control: device.control, approve: device.approve, files: device.files, isActive: () => this.status.enabled && this.saved?.devices.includes(device) === true }
  }
  private async connect(generation: number): Promise<void> {
    const saved = this.saved
    if (!saved || generation !== this.generation) return
    this.publish({ state: this.retry ? 'reconnecting' : 'connecting', error: undefined })
    let authenticationFailed = false
    try {
      if (saved.registered) {
        const response = await fetch(`${this.origin}/api/rooms/${saved.roomId}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostToken: saved.hostToken }), signal: AbortSignal.timeout(15000) })
        if (generation !== this.generation || this.saved !== saved) return
        if (response.status === 403) { authenticationFailed = true; throw new Error('remote-room-authentication-failed') }
        if (response.status === 410) {
          // An expired relay has forgotten every device. Rotate all credentials and
          // require desktop confirmation again rather than silently reusing old access.
          saved.roomId = randomHex(16); saved.hostToken = randomHex(); saved.registered = false
          saved.devices = []; saved.receipts = []; this.invite = null
          await this.persist()
          this.publish()
        } else if (!response.ok) throw new Error('Remote relay unavailable')
      }
      if (!saved.registered) {
        const response = await fetch(`${this.origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: saved.roomId, hostToken: saved.hostToken }), signal: AbortSignal.timeout(15000) })
        if (!response.ok && response.status !== 409) throw new Error('Remote relay unavailable')
        if (generation !== this.generation || this.saved !== saved) return
        saved.registered = true
        await this.persist()
      }
      if (generation !== this.generation) return
      const socket = new WebSocket(`${this.origin.replace(/^http/, 'ws')}/relay/${saved.roomId}`)
      this.socket = socket
      await new Promise<void>((resolve, reject) => {
        let ready = false
        const timeout = setTimeout(() => { reject(new Error('Remote connection timed out')); socket.close() }, 15000)
        socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', role: 'host', token: saved.hostToken }))
        socket.onmessage = event => {
          if (generation !== this.generation || this.socket !== socket || typeof event.data !== 'string' || Buffer.byteLength(event.data) > REMOTE_MAX_FRAME_BYTES) return
          let frame: Record<string, unknown>
          try { frame = JSON.parse(event.data) } catch { return }
          // Control acknowledgements must not wait behind history transfers or slow RPCs.
          if (frame.type === 'pong' || frame.type === 'renewed') { this.lastPong = Date.now(); return }
          if (frame.type === 'invite.ready' && typeof frame.tokenHash === 'string') { this.resolveWaiter(`invite.ready:${frame.tokenHash}`, frame); return }
          if (frame.type === 'authorized' && typeof frame.deviceId === 'string') { this.resolveWaiter(`authorized:${frame.deviceId}`, frame); return }
          if (frame.type === 'peer.left' && typeof frame.peerId === 'string') {
            // A snapshot can be awaiting this peer's flush on the command chain.
            // Resolve its barrier now, and invalidate an older queued join too.
            const pending = this.incoming.get(frame.peerId)
            if (pending) pending.dropped = true
            this.forgetPeer(frame.peerId)
            this.publish()
            return
          }
          if (frame.type === 'ready' && frame.role === 'host' && !ready) {
            ready = true; clearTimeout(timeout); this.retry = 0; this.lastPong = Date.now(); this.lastRenewed = Date.now(); this.publish({ state: 'online', error: undefined }); resolve()
            this.heartbeat = setInterval(() => {
              if (Date.now() - this.lastPong > 95000) socket.close()
              else if (Date.now() - this.lastRenewed > 86400000) { this.send({ type: 'renew' }); this.lastRenewed = Date.now() }
              else this.send({ type: 'ping' })
            }, 45000)
          } else {
            const bytes = Buffer.byteLength(event.data)
            const peerId = typeof frame.peerId === 'string' ? frame.peerId : ''
            let budget = this.incoming.get(peerId)
            if (!budget) { budget = { count: 0, bytes: 0, dropped: false }; this.incoming.set(peerId, budget) }
            if (budget.dropped) return
            const totalFull = this.incomingTotal.count >= 1024 || this.incomingTotal.bytes + bytes > 64 * 1024 * 1024
            if (budget.count >= 128 || budget.bytes + bytes > 16 * 1024 * 1024 || totalFull) {
              budget.dropped = true
              this.diagnose(totalFull ? 'incoming-total-queue-limit' : 'incoming-peer-queue-limit')
              if (peerId) {
                const known = this.peers.has(peerId) || budget.count > 0 || frame.type === 'peer.joined'
                this.forgetPeer(peerId)
                if (known) this.send({ type: 'disconnect', peerId })
                this.publish()
              }
              else socket.close(1008, 'Remote queue limit')
              if (budget.count === 0 && this.incoming.get(peerId) === budget) this.incoming.delete(peerId)
              return
            }
            const queued = budget
            const total = this.incomingTotal
            queued.count++; queued.bytes += bytes
            total.count++; total.bytes += bytes
            this.chain = this.chain.catch(() => {}).then(() => !queued.dropped && generation === this.generation && this.socket === socket ? this.handleFrame(frame) : undefined)
              .catch(() => { this.diagnose('frame-processing-failed') })
              .finally(() => {
                queued.count--; queued.bytes -= bytes
                total.count--; total.bytes -= bytes
                if (queued.count === 0 && this.incoming.get(peerId) === queued) this.incoming.delete(peerId)
              })
          }
        }
        socket.onerror = () => { if (!ready) reject(new Error('Remote connection failed')) }
        socket.onclose = () => {
          clearTimeout(timeout)
          if (!ready) reject(new Error('Remote authentication failed'))
          if (generation !== this.generation || this.socket !== socket) return
          this.clearConnection()
          this.scheduleReconnect(generation)
        }
      })
    } catch {
      if (generation === this.generation && this.saved) {
        this.clearConnection()
        if (authenticationFailed) this.publish({ state: 'error', error: 'remote-room-authentication-failed' })
        else this.scheduleReconnect(generation)
        throw new Error('Unable to connect to the remote relay. Check your network and try again.')
      }
    }
  }
  private scheduleReconnect(generation: number): void {
    if (!this.saved || this.timer) return
    this.publish({ state: 'reconnecting', error: 'remote-connection-lost' })
    const delay = Math.min(30000, 1000 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4)
    this.timer = setTimeout(() => { this.timer = undefined; void this.connect(generation).catch(() => {}) }, delay)
  }
  private clearConnection(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.timer = undefined; this.heartbeat = undefined
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.peers.clear()
    this.incoming.clear()
    for (const buffer of this.eventBuffers.values()) { if (buffer.timer) clearTimeout(buffer.timer); buffer.end() }
    this.eventBuffers.clear()
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Remote connection closed')) }
    this.waiters.clear()
  }
  private async handleFrame(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'pong' || frame.type === 'renewed') { this.lastPong = Date.now(); return }
    if (frame.type === 'invite.ready' && typeof frame.tokenHash === 'string') { this.resolveWaiter(`invite.ready:${frame.tokenHash}`, frame); return }
    if (frame.type === 'authorized' && typeof frame.deviceId === 'string') { this.resolveWaiter(`authorized:${frame.deviceId}`, frame); return }
    if (frame.type === 'peer.left' && typeof frame.peerId === 'string') { this.forgetPeer(frame.peerId); this.publish(); return }
    if (frame.type === 'peer.joined' && typeof frame.peerId === 'string') {
      const device = this.saved?.devices.find(item => item.deviceId === frame.deviceId)
      const key = device?.key ?? (frame.invited && this.invite && this.invite.expiresAt > Date.now() ? this.invite.key : null)
      if (!key || this.peers.size >= 8) { this.diagnose(key ? 'peer-limit' : 'peer-credential-unavailable'); this.send({ type: 'disconnect', peerId: frame.peerId }); return }
      const peer: Peer = { id: frame.peerId, deviceId: device?.deviceId, key, challenge: randomHex(), ready: false, requestedAt: Date.now(), inviteToken: device ? undefined : this.invite?.token, inviteExpiresAt: device ? undefined : this.invite?.expiresAt, seen: new Set(), filtering: { count: 0, bytes: 0 }, uiSending: { count: 0, bytes: 0 } }
      this.peers.set(peer.id, peer)
      this.send({ type: 'data', peerId: peer.id, payload: { challenge: peer.challenge } })
      this.publish()
      return
    }
    if (frame.type !== 'data' || typeof frame.peerId !== 'string') return
    const peer = this.peers.get(frame.peerId)
    if (!peer) return
    let message: Record<string, unknown>
    try { message = await open(peer.key, frame.payload) } catch { this.dropPeer(peer, 'peer-decrypt-failed'); return }
    if (message.challenge !== peer.challenge) return
    const iv = (frame.payload as { iv?: string })?.iv
    if (iv && peer.seen.has(iv)) return
    if (iv) { peer.seen.add(iv); if (peer.seen.size > 2048) peer.seen.delete(peer.seen.values().next().value!) }
    if (!peer.deviceId) {
      if (message.kind !== 'pair' || !this.pairLive(peer) || peer.name) return
      peer.name = typeof message.name === 'string' ? message.name.replace(/[\x00-\x1f]/g, '').slice(0, 64) || 'Browser' : 'Browser'
      peer.code = (await sha256Hex(peer.challenge + peer.key)).slice(0, 8).toUpperCase()
      await this.sendEncrypted(peer, { kind: 'pending', challenge: peer.challenge, code: peer.code })
      this.publish()
      return
    }
    if (message.kind === 'hello') {
      peer.ready = true
      const principal = this.principal(peer)
      if (!principal?.isActive()) return
      const device = this.saved!.devices.find(item => item.deviceId === peer.deviceId)!
      device.lastSeenAt = Date.now()
      let bootstrap: Awaited<ReturnType<typeof this.dispatcher.bootstrap>> & { platform: string }
      try { bootstrap = { ...await this.dispatcher.bootstrap(principal), platform: process.platform } }
      catch { this.dropPeer(peer, 'bootstrap-failed'); return }
      try { await this.sendEncrypted(peer, { kind: 'connected', challenge: peer.challenge, bootstrap }) }
      catch { this.dropPeer(peer, 'bootstrap-send-failed'); return }
      this.publish()
      return
    }
    const principal = this.principal(peer)
    if (!principal?.isActive() || message.kind !== 'request') return
    await this.handleRequest(peer, principal, message as unknown as RemoteRequest)
  }
  private async handleRequest(peer: Peer, principal: RemotePrincipal, request: RemoteRequest): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(request.id) || typeof request.method !== 'string' || !Array.isArray(request.args) || !Number.isFinite(request.issuedAt) || Math.abs(Date.now() - request.issuedAt) > 300000) return
    const saved = this.saved!
    const mutating = !new Set(['remote:bootstrap', 'agent:host-mode', 'agent:snapshot', 'kvGet', 'dbGetAllSessions', 'dbGetMessages', 'dbGetRevision', 'dbGetRecents', 'readFile', 'readFileBase64', 'readImageFileBase64', 'listDir', 'fileExists', 'mcpStatus', 'mcpTools', 'loadApiKeys', 'jouleGetState', 'accountGetStatus', 'accountSyncGetPassphraseStatus', 'gitGetStatus', 'gitGetDiff', 'gitGetBranches', 'gitGetCommitGraph', 'gitGetIdentity', 'scanSkillDirs', 'scanAgents', 'scanMemory', 'readMemoryIndex', 'searchMemoryFiles', 'agentMemoryStatus', 'agentMemorySearch', 'agentMemoryContext', 'skillsSearch', 'fetchSkillMd', 'fetchSkillFromRepo', 'vibeGetWallpaper', 'vibeMediaGetState', 'agentBrowser:ready', 'ptyInput', 'ptyResize']).has(request.method)
    let receipt = mutating ? saved.receipts.find(item => item.id === request.id && item.deviceId === principal.deviceId) : undefined
    if (receipt) {
      await this.sendEncrypted(peer, { kind: 'response', challenge: peer.challenge, id: request.id, result: receipt.result, error: receipt.state === 'pending' ? 'remote-request-outcome-unknown' : receipt.error })
      return
    }
    if (mutating) {
      saved.receipts = saved.receipts.filter(item => Date.now() - item.issuedAt < 86400000)
      if (saved.receipts.length >= 2000) { await this.sendEncrypted(peer, { kind: 'response', challenge: peer.challenge, id: request.id, error: 'remote-request-limit' }); return }
      receipt = { id: request.id, deviceId: principal.deviceId, issuedAt: request.issuedAt, state: 'pending' }
      saved.receipts.push(receipt)
      try { await this.persist() } // Persist before executing: reconnection must never submit a task twice.
      catch {
        saved.receipts = saved.receipts.filter(item => item !== receipt)
        await this.sendEncrypted(peer, { kind: 'response', challenge: peer.challenge, id: request.id, error: 'remote-persistence-failed' })
        return
      }
    }
    let result: unknown
    let error: string | undefined
    try {
      if (this.saved !== saved || !principal.isActive()) throw new Error('remote-disconnected')
      result = await this.dispatcher.invoke(principal, request.method, request.args)
    }
    catch (cause) { error = cause instanceof Error ? cause.message.slice(0, 240) : 'remote-operation-failed' }
    if (receipt) {
      receipt.state = 'done'; receipt.result = result; receipt.error = error
      try { await this.persist() }
      catch { receipt.state = 'pending'; receipt.result = undefined; error = 'remote-request-outcome-unknown'; result = undefined }
    }
    if (principal.isActive()) {
      try { await this.sendEncrypted(peer, { kind: 'response', challenge: peer.challenge, id: request.id, result, error }) }
      catch {
        this.diagnose('response-send-failed')
        try { await this.sendEncrypted(peer, { kind: 'response', challenge: peer.challenge, id: request.id, error: 'remote-response-too-large' }) }
        catch { this.dropPeer(peer, 'response-send-failed') }
      }
    }
  }
  dispose(): void {
    ++this.generation
    this.clearConnection()
    this.options.onDeviceRevoked?.()
    this.unsubscribe()
    this.unsubscribeUi()
    this.dispatcher.dispose()
  }
}
