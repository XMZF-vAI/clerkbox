import type { AgentEvent } from '../agent-core/protocol'
import { open, randomHex, seal, sha256Hex } from './crypto'
import { REMOTE_MAX_FRAME_BYTES, type RemoteDeviceCredential, type RemoteInvite } from './protocol'

export interface RemoteBootstrap {
  protocolVersion: 1
  workspace: string
  settings: Record<string, unknown>
  capabilities: { control: boolean; approve: boolean; files: boolean; maxUploadBytes?: number }
  platform?: string
}
export interface RemoteConnection {
  state: 'idle' | 'connecting' | 'pairing' | 'connected' | 'reconnecting' | 'error'
  code?: string
  error?: string
  deviceName?: string
}
type RemoteEvent = { seq: number; event: AgentEvent }
type Identity = RemoteInvite | RemoteDeviceCredential
interface PendingRequest {
  id: string
  method: string
  args: unknown[]
  issuedAt: number
  resolve(value: unknown): void
  reject(reason: Error): void
  timer: ReturnType<typeof setTimeout>
}
const DEVICE_PREFIX = 'clerkbox:remote:v1:'
const DEVICE_INDEX = `${DEVICE_PREFIX}devices`
const HEX = /^[a-f0-9]{64}$/
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{16,128}$/.test(value)

export function isCloudRemoteMode(): boolean {
  return typeof document !== 'undefined' && document.querySelector('meta[name="clerkbox-remote"]')?.getAttribute('content') === '1'
}

export function validRemoteIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<RemoteDeviceCredential>
  return item.protocol === 1 && identifier(item.roomId) && typeof item.token === 'string' && HEX.test(item.token)
    && typeof item.key === 'string' && HEX.test(item.key)
    && (item.deviceId === undefined || (identifier(item.deviceId) && typeof item.name === 'string' && item.name.length <= 100))
}

/** Consume credentials from the fragment before rendering or loading the application. */
export function consumeRemoteInvite(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>): RemoteInvite | null {
  const params = new URLSearchParams(location.hash.slice(1))
  if (!params.has('invite')) return null
  history.replaceState(null, '', location.pathname + location.search)
  try {
    const value: unknown = JSON.parse(params.get('invite') || '')
    if (!validRemoteIdentity(value) || 'deviceId' in value) throw new Error('Invalid invitation')
    return value
  } catch {
    throw new Error('remoteAccess.cloudInvalidInvite')
  }
}

/** Process both initial URLs and same-document invitation navigation. */
export function consumeRemoteInviteNavigation(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
  options: { workspaceLoaded: boolean; connect(invite: RemoteInvite): void; reload(): void },
): boolean {
  const invite = consumeRemoteInvite(location, history)
  if (!invite) return false
  if (options.workspaceLoaded) {
    // A different computer must not inherit already-hydrated stores or agent listeners.
    const canonical: RemoteInvite = { protocol: 1, roomId: invite.roomId, token: invite.token, key: invite.key }
    history.replaceState(null, '', `${location.pathname}${location.search}#invite=${encodeURIComponent(JSON.stringify(canonical))}`)
    options.reload()
  } else options.connect(invite)
  return true
}

function deviceKey(credential: Pick<RemoteDeviceCredential, 'roomId' | 'deviceId'>): string {
  return `${DEVICE_PREFIX}${credential.roomId}:${credential.deviceId}`
}
export function readRemoteDevices(storage: Storage = localStorage): RemoteDeviceCredential[] {
  try {
    const index: unknown = JSON.parse(storage.getItem(DEVICE_INDEX) || '[]')
    if (!Array.isArray(index)) return []
    return index.slice(0, 20).flatMap(key => {
      if (typeof key !== 'string' || !/^clerkbox:remote:v1:[a-f0-9]{16,128}:[a-f0-9]{16,128}$/.test(key)) return []
      try {
        const value: unknown = JSON.parse(storage.getItem(key) || 'null')
        return validRemoteIdentity(value) && 'deviceId' in value && deviceKey(value) === key ? [value] : []
      } catch { return [] }
    })
  } catch { return [] }
}
export function saveRemoteDevice(credential: RemoteDeviceCredential, storage: Storage = localStorage): void {
  if (!validRemoteIdentity(credential) || !('deviceId' in credential)) throw new Error('remoteAccess.cloudInvalidInvite')
  const key = deviceKey(credential)
  const devices = readRemoteDevices(storage).filter(item => deviceKey(item) !== key)
  storage.setItem(key, JSON.stringify(credential))
  storage.setItem(DEVICE_INDEX, JSON.stringify([key, ...devices.map(deviceKey)].slice(0, 20)))
}
export function forgetRemoteDevice(credential: RemoteDeviceCredential, storage: Storage = localStorage): void {
  const key = deviceKey(credential)
  const devices = readRemoteDevices(storage).filter(item => deviceKey(item) !== key)
  storage.removeItem(key)
  storage.setItem(DEVICE_INDEX, JSON.stringify(devices.map(deviceKey)))
}

export interface RemoteBrowserOptions {
  origin: string
  createSocket?: (url: string) => WebSocket
  saveCredential?: (credential: RemoteDeviceCredential) => void
  readCredentials?: () => RemoteDeviceCredential[]
  forgetCredential?: (credential: RemoteDeviceCredential) => void
}

/** One transport for the existing desktop agent. No model credentials or agent loop live here. */
export class RemoteBrowserClient {
  private socket: WebSocket | null = null
  private identity: Identity | null = null
  private fallbackInvite: RemoteInvite | null = null
  private replacingCredential: RemoteDeviceCredential | null = null
  private challenge = ''
  private generation = 0
  private stopped = true
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private lastReceived = 0
  private connection: RemoteConnection = { state: 'idle' }
  private bootstrap: RemoteBootstrap | null = null
  private listeners = new Set<() => void>()
  private events = new Set<(event: RemoteEvent) => void>()
  private pending = new Map<string, PendingRequest>()
  private incoming: Promise<void> = Promise.resolve()
  private transfers = new Map<string, { pieces: Map<number, string>; count: number; bytes: number; startedAt: number; lastUpdated: number }>()
  constructor(private options: RemoteBrowserOptions) {}

  getConnection = (): RemoteConnection => this.connection
  getBootstrap = (): RemoteBootstrap | null => this.bootstrap
  getStorageScope = (): string => this.identity ? `${this.identity.roomId}:${'deviceId' in this.identity ? this.identity.deviceId : 'invite'}` : 'unpaired'
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  subscribeEvents = (listener: (event: RemoteEvent) => void): (() => void) => { this.events.add(listener); return () => { this.events.delete(listener) } }
  private update(connection: RemoteConnection): void {
    this.connection = connection
    for (const listener of this.listeners) listener()
  }
  connect(identity: Identity): void {
    if (!validRemoteIdentity(identity)) throw new Error('remoteAccess.cloudInvalidInvite')
    this.disconnect()
    let remembered: RemoteDeviceCredential | undefined
    if (!('deviceId' in identity)) {
      try { remembered = (this.options.readCredentials ?? readRemoteDevices)().find(device => device.roomId === identity.roomId && validRemoteIdentity(device)) } catch { /* Private browsing can make storage unavailable. */ }
    }
    this.identity = remembered ?? identity
    this.fallbackInvite = remembered ? identity as RemoteInvite : null
    this.replacingCredential = remembered ?? null
    this.stopped = false
    this.attempt = 0
    this.openSocket()
  }
  reconnect = (): void => {
    if (!this.identity) return
    this.stopped = false
    this.attempt = 0
    this.closeSocket()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.openSocket()
  }
  disconnect = (): void => {
    this.stopped = true
    this.closeSocket()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.bootstrap = null
    this.fallbackInvite = null
    this.replacingCredential = null
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('remoteAccess.cloudDisconnected')) }
    this.pending.clear()
    this.update({ state: 'idle' })
  }
  private closeSocket(): void {
    this.generation += 1
    this.challenge = ''
    this.transfers.clear()
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.handshakeTimer = null
    this.heartbeat = null
    const socket = this.socket
    this.socket = null
    if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.onopen = null; socket.close() }
  }
  private tryInvitationFallback(): boolean {
    // A revoked stored credential must not trap a freshly scanned invitation.
    // Retry the invitation once, only before bootstrap and on an auth refusal.
    // Keep the old credential until re-pairing succeeds: a full relay also uses
    // a generic refusal, and must not silently erase an otherwise valid device.
    if (!this.fallbackInvite || this.bootstrap) return false
    this.identity = this.fallbackInvite
    this.fallbackInvite = null
    this.attempt = 0
    this.openSocket()
    return true
  }
  private openSocket(): void {
    if (this.stopped || !this.identity) return
    this.closeSocket()
    const identity = this.identity
    const generation = this.generation
    const url = new URL(`/relay/${identity.roomId}`, this.options.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    this.update({ state: this.bootstrap ? 'reconnecting' : 'connecting', deviceName: 'name' in identity ? identity.name : undefined })
    try {
      const socket = (this.options.createSocket ?? (value => new WebSocket(value)))(url.href)
      this.socket = socket
      this.handshakeTimer = setTimeout(() => { if (socket === this.socket) this.retry() }, 20_000)
      socket.onopen = () => {
        if (socket !== this.socket) return
        socket.send(JSON.stringify({ type: 'auth', role: 'browser', token: identity.token, ...('deviceId' in identity ? { deviceId: identity.deviceId } : {}) }))
        this.lastReceived = Date.now()
        this.heartbeat = setInterval(() => {
          if (socket !== this.socket) return
          if ([...this.transfers.values()].some(transfer => Date.now() - transfer.lastUpdated > 120_000 || Date.now() - transfer.startedAt > 180_000)) {
            this.fail('remoteAccess.cloudTransferTimeout')
            return
          }
          if (Date.now() - this.lastReceived > 45_000) this.retry()
          else if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ping' }))
        }, 15_000)
      }
      socket.onmessage = event => {
        // Serial decryption preserves desktop event ordering despite asynchronous AES-GCM.
        this.incoming = this.incoming.then(async () => {
          if (generation !== this.generation || socket !== this.socket) return
          if (typeof event.data !== 'string' || event.data.length > REMOTE_MAX_FRAME_BYTES) throw new Error('Invalid relay frame')
          this.lastReceived = Date.now()
          await this.accept(JSON.parse(event.data), identity, socket, generation)
        }).catch(() => { if (generation === this.generation) this.fail('remoteAccess.cloudConnectionError') })
      }
      socket.onerror = () => { /* close handles retry; never surface a token-bearing browser exception */ }
      socket.onclose = event => {
        if (socket !== this.socket || generation !== this.generation) return
        if ([4001, 4003, 4401, 4403].includes(event.code)) { if (!this.tryInvitationFallback()) this.fail('remoteAccess.cloudRevoked') }
        else this.retry()
      }
    } catch { this.retry() }
  }
  private async accept(value: unknown, identity: Identity, socket: WebSocket, generation: number): Promise<void> {
    if (!value || typeof value !== 'object') return
    const envelope = value as Record<string, unknown>
    if (envelope.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return }
    if (envelope.type === 'ready' || envelope.type === 'pong') return
    if (envelope.type === 'stopped') { this.fail('remoteAccess.cloudRevoked'); return }
    if (envelope.type === 'host.offline' || envelope.type === 'host.online') {
      this.challenge = ''
      this.transfers.clear()
      this.update({ state: 'reconnecting', deviceName: this.connection.deviceName })
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      if (envelope.type === 'host.online') this.handshakeTimer = setTimeout(() => { if (socket === this.socket) this.retry() }, 20_000)
      return
    }
    if (envelope.type === 'error') { if (!this.tryInvitationFallback()) this.fail('remoteAccess.cloudConnectionError'); return }
    if (envelope.type !== 'data' || !envelope.payload || typeof envelope.payload !== 'object') return
    const raw = envelope.payload as Record<string, unknown>
    if (typeof raw.challenge === 'string' && identifier(raw.challenge) && raw.kind === undefined && raw.v === undefined) {
      this.challenge = raw.challenge
      await this.send({ kind: 'deviceId' in identity ? 'hello' : 'pair', challenge: this.challenge, name: 'name' in identity ? identity.name : this.browserName() }, socket, identity.key)
      return
    }
    const message = await open<Record<string, unknown>>(identity.key, raw)
    await this.acceptOpened(message, identity, socket, generation)
  }
  private async acceptOpened(message: Record<string, unknown>, identity: Identity, socket: WebSocket, generation: number): Promise<void> {
    if (generation !== this.generation || socket !== this.socket || !this.challenge || message.challenge !== this.challenge) return
    if (message.kind === 'rejected') { this.fail('remoteAccess.cloudPairRejected'); return }
    if (message.kind === 'chunk') {
      if (typeof message.transferId !== 'string' || !/^[a-f0-9]{32}$/.test(message.transferId) || !Number.isSafeInteger(message.index) || !Number.isSafeInteger(message.count)
        || (message.count as number) < 1 || (message.count as number) > 1024 || (message.index as number) < 0 || (message.index as number) >= (message.count as number)
        || typeof message.data !== 'string' || message.data.length > 48 * 1024) throw new Error('Invalid remote transfer')
      if ([...this.transfers.values()].some(transfer => Date.now() - transfer.lastUpdated > 120_000 || Date.now() - transfer.startedAt > 180_000)) {
        this.fail('remoteAccess.cloudTransferTimeout')
        return
      }
      let transfer = this.transfers.get(message.transferId)
      if (!transfer) {
        if (this.transfers.size >= 4) throw new Error('Too many remote transfers')
        transfer = { pieces: new Map(), count: message.count as number, bytes: 0, startedAt: Date.now(), lastUpdated: Date.now() }
        this.transfers.set(message.transferId, transfer)
      }
      const index = message.index as number
      if (transfer.count !== message.count || (transfer.pieces.has(index) && transfer.pieces.get(index) !== message.data)) throw new Error('Invalid remote transfer')
      if (!transfer.pieces.has(index)) {
        transfer.bytes += new TextEncoder().encode(message.data).byteLength
        transfer.pieces.set(index, message.data)
        transfer.lastUpdated = Date.now()
      }
      if ([...this.transfers.values()].reduce((sum, item) => sum + item.bytes, 0) > 32 * 1024 * 1024) throw new Error('Remote transfer too large')
      if (transfer.pieces.size === transfer.count) {
        this.transfers.delete(message.transferId)
        const value = JSON.parse(Array.from({ length: transfer.count }, (_, i) => transfer!.pieces.get(i)!).join('')) as Record<string, unknown>
        if (value.kind === 'chunk') throw new Error('Invalid remote transfer')
        await this.acceptOpened(value, identity, socket, generation)
      }
      return
    }
    if (message.kind === 'pending' && typeof message.code === 'string' && /^[A-F0-9]{8}$/.test(message.code)) {
      const expectedCode = (await sha256Hex(this.challenge + identity.key)).slice(0, 8).toUpperCase()
      if (message.code !== expectedCode || generation !== this.generation) throw new Error('Pairing code mismatch')
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.update({ state: 'pairing', code: message.code })
      return
    }
    if (message.kind === 'paired') {
      const credential = message.credential
      if (!validRemoteIdentity(credential) || !('deviceId' in credential) || credential.roomId !== identity.roomId) throw new Error('Invalid device credential')
      try { (this.options.saveCredential ?? saveRemoteDevice)(credential) } catch { this.fail('remoteAccess.cloudStorageError'); return }
      if (this.replacingCredential && this.replacingCredential.deviceId !== credential.deviceId) {
        try { (this.options.forgetCredential ?? forgetRemoteDevice)(this.replacingCredential) } catch { /* The newly saved credential remains usable. */ }
      }
      this.replacingCredential = null
      this.fallbackInvite = null
      this.identity = credential
      this.openSocket()
      return
    }
    if (message.kind === 'connected') {
      const bootstrap = message.bootstrap as RemoteBootstrap | undefined
      if (!bootstrap || bootstrap.protocolVersion !== 1 || typeof bootstrap.workspace !== 'string' || !bootstrap.settings || !bootstrap.capabilities) throw new Error('Invalid bootstrap')
      this.bootstrap = bootstrap
      this.fallbackInvite = null
      this.replacingCredential = null
      this.attempt = 0
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.update({ state: 'connected', deviceName: 'name' in identity ? identity.name : undefined })
      for (const request of this.pending.values()) void this.transmit(request)
      return
    }
    if (message.kind === 'response' && typeof message.id === 'string') {
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if (typeof message.error === 'string') request.reject(new Error(message.error.slice(0, 300)))
      else request.resolve(message.result)
    }
    if ((message.kind === 'event' || message.kind === 'events') && this.connection.state === 'connected') {
      const payloads = message.kind === 'events' ? message.payloads : [message.payload]
      if (!Array.isArray(payloads) || payloads.length > 1000) throw new Error('Invalid remote events')
      for (const value of payloads) {
        const payload = value as RemoteEvent | undefined
        if (payload && Number.isSafeInteger(payload.seq) && payload.seq >= 0 && payload.event && typeof payload.event.type === 'string') {
          for (const listener of this.events) { try { listener(payload) } catch { /* one renderer must not stop the stream */ } }
        }
      }
    }
  }
  private browserName(): string {
    if (typeof navigator === 'undefined') return 'Browser'
    const platform = /Android/i.test(navigator.userAgent) ? 'Android' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iOS' : /Windows/i.test(navigator.userAgent) ? 'Windows' : /Mac/i.test(navigator.userAgent) ? 'macOS' : 'Browser'
    return `${platform} WebUI`
  }
  private async send(payload: unknown, socket = this.socket, key = this.identity?.key): Promise<void> {
    if (!socket || socket.readyState !== 1 || !key) throw new Error('remoteAccess.cloudDisconnected')
    const generation = this.generation
    const frame = await seal(key, payload)
    if (socket !== this.socket || generation !== this.generation || socket.readyState !== 1) return
    socket.send(JSON.stringify({ type: 'data', payload: frame }))
  }
  private retry(): void {
    if (this.stopped) return
    this.closeSocket()
    if (this.retryTimer) return
    this.update({ state: 'reconnecting', deviceName: this.connection.deviceName })
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt++, 5), 30_000) * (0.8 + Math.random() * 0.4)
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.openSocket() }, delay)
  }
  private fail(error: string): void {
    this.closeSocket()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(error)) }
    this.pending.clear()
    this.update({ state: 'error', error })
  }
  invoke<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.connection.state !== 'connected') return Promise.reject(new Error('remoteAccess.cloudDisconnected'))
    if (this.pending.size >= 64) return Promise.reject(new Error('remoteAccess.cloudTooManyRequests'))
    try {
      // Reserve envelope space before encryption so a rejected command never starts a reconnect loop.
      if (new TextEncoder().encode(JSON.stringify({ method, args })).byteLength > 479 * 1024) return Promise.reject(new Error('remoteAccess.cloudRequestTooLarge'))
    } catch { return Promise.reject(new Error('remoteAccess.cloudRequestTooLarge')) }
    return new Promise<T>((resolve, reject) => {
      const id = randomHex(16)
      const request: PendingRequest = { id, method, args, issuedAt: Date.now(), resolve: value => resolve(value as T), reject,
        timer: setTimeout(() => { this.pending.delete(id); reject(new Error('remoteAccess.cloudRequestTimeout')) }, 240_000) }
      this.pending.set(id, request)
      void this.transmit(request)
    })
  }
  private async transmit(request: PendingRequest): Promise<void> {
    if (this.connection.state !== 'connected') return
    try { await this.send({ kind: 'request', challenge: this.challenge, id: request.id, issuedAt: request.issuedAt, method: request.method, args: request.args }) }
    catch (error) {
      if (error instanceof Error && error.message === 'Remote message too large') {
        clearTimeout(request.timer)
        this.pending.delete(request.id)
        request.reject(new Error('remoteAccess.cloudRequestTooLarge'))
      } else this.retry()
    }
  }
}

let singleton: RemoteBrowserClient | undefined
export function remoteBrowser(): RemoteBrowserClient {
  return singleton ??= new RemoteBrowserClient({ origin: typeof location === 'undefined' ? 'https://webui.clerkbox.xmzf.space' : location.origin })
}
export const invokeRemote = <T>(method: string, args: unknown[] = []): Promise<T> => remoteBrowser().invoke<T>(method, args)
export const subscribeRemoteEvents = (listener: (event: RemoteEvent) => void): (() => void) => remoteBrowser().subscribeEvents(listener)
export const subscribeRemoteConnection = (listener: () => void): (() => void) => remoteBrowser().subscribe(listener)
export const getRemoteConnection = (): RemoteConnection => remoteBrowser().getConnection()
export const getRemoteBootstrap = (): RemoteBootstrap | null => remoteBrowser().getBootstrap()
export const getRemoteStorageScope = (): string => remoteBrowser().getStorageScope()
export const canRemoteApprove = (): boolean => getRemoteConnection().state === 'connected' && getRemoteBootstrap()?.capabilities.approve === true

export async function uploadRemoteFile(file: File): Promise<{ path: string; name: string; size: number; maxUploadBytes: number }> {
  const bootstrap = getRemoteBootstrap()
  if (!bootstrap?.capabilities.files) throw new Error('remoteAccess.cloudFilesDisabled')
  if (file.size > (bootstrap.capabilities.maxUploadBytes ?? 10 * 1024 * 1024)) throw new Error('remoteAccess.cloudFileTooLarge')
  const started = await invokeRemote<{ uploadId: string }>('remote:upload.start', [{ name: file.name || 'upload.bin', size: file.size }])
  for (let offset = 0, index = 0; offset < file.size; offset += 128 * 1024, index += 1) {
    const bytes = new Uint8Array(await file.slice(offset, offset + 128 * 1024).arrayBuffer())
    let binary = ''
    for (let from = 0; from < bytes.length; from += 8192) binary += String.fromCharCode(...bytes.subarray(from, from + 8192))
    await invokeRemote('remote:upload.chunk', [started.uploadId, index, btoa(binary)])
  }
  const result = await invokeRemote<{ path: string; name: string; size: number }>('remote:upload.finish', [started.uploadId])
  return { ...result, maxUploadBytes: bootstrap.capabilities.maxUploadBytes ?? 10 * 1024 * 1024 }
}
