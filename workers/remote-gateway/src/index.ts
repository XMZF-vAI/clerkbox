import { DurableObject } from 'cloudflare:workers'

export interface Env {
  ROOMS: DurableObjectNamespace<RelayRoom>
  CREATION_LIMITER: DurableObjectNamespace<CreationLimiter>
  ASSETS?: Fetcher
  PUBLIC_ORIGIN?: string
  ALLOW_LOCALHOST_ORIGINS?: string
}

const ROOM_ID = /^[a-f0-9]{32}$/
const TOKEN = /^[a-f0-9]{64}$/
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_PAYLOAD_BYTES = 1024 * 1024
const MAX_WIRE_BYTES = MAX_PAYLOAD_BYTES + 4096
const ROOM_TTL = 7 * 24 * 60 * 60 * 1000
const INVITE_TTL = 10 * 60 * 1000
const AUTH_TIMEOUT = 10 * 1000
const MAX_PEERS = 8
const MAX_PENDING = 4
const MAX_DEVICES = 16
const encoder = new TextEncoder()

type JsonRecord = Record<string, unknown>
interface Device { tokenHash: string; createdAt: number }
interface Room {
  hostTokenHash: string
  createdAt: number
  expiresAt: number
  activeHostPeerId?: string
  devices: Record<string, Device>
  invites: Record<string, number>
}
interface Peer {
  peerId: string
  role?: 'host' | 'browser'
  origin?: string
  deadline: number
  deviceId?: string
  invited?: boolean
  authorized?: boolean
  rateWindow: number
  rateCount: number
  byteCount: number
  closed?: boolean
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  })
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
}

function validOrigin(origin: string | null | undefined, env: Env): boolean {
  if (!origin) return false
  if (origin === (env.PUBLIC_ORIGIN || 'https://webui.clerkbox.xmzf.space')) return true
  if (env.ALLOW_LOCALHOST_ORIGINS !== 'true') return false
  try {
    const url = new URL(origin)
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch { return false }
}

async function hash(value: string): Promise<string> {
  const data = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(data), n => n.toString(16).padStart(2, '0')).join('')
}

function equalHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return difference === 0
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.body) throw new Error('Invalid request')
  const reader = request.body.getReader()
  let length = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxBytes) {
      await reader.cancel()
      throw new Error('Invalid request')
    }
    chunks.push(value)
  }
  const combined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(combined))
}

function secure(response: Response, env: Env, request: Request): Response {
  if (response.status === 101) return response
  const connectSources = ["'self'", 'wss://webui.clerkbox.xmzf.space']
  try {
    const publicOrigin = new URL(env.PUBLIC_ORIGIN || 'https://webui.clerkbox.xmzf.space')
    if (publicOrigin.protocol === 'https:') connectSources.push(`wss://${publicOrigin.host}`)
    else if (env.ALLOW_LOCALHOST_ORIGINS === 'true' && publicOrigin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(publicOrigin.hostname)) connectSources.push(`ws://${publicOrigin.host}`)
  } catch { /* Invalid deployment configuration never opens an arbitrary destination. */ }
  const headers = new Headers(response.headers)
  // Cloudflare respects no-transform when deciding whether to inject its Web
  // Analytics beacon. Keep this private app's HTML and strict self-only CSP
  // intact without changing analytics on any other hostname in the zone.
  if (new URL(request.url).hostname === 'webui.clerkbox.xmzf.space' && /^text\/html(?:;|$)/i.test(headers.get('Content-Type') || '')) {
    const cacheControl = headers.get('Cache-Control') || 'no-store'
    if (!cacheControl.split(',').some(directive => directive.trim().toLowerCase() === 'no-transform')) {
      headers.set('Cache-Control', `${cacheControl}, no-transform`)
    }
  }
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${[...new Set(connectSources)].join(' ')}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return secure(await route(request, env), env, request) }
    catch { return secure(json({ error: 'Request failed' }, 500), env, request) }
  },
} satisfies ExportedHandler<Env>

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const origin = request.headers.get('Origin')
  if (url.pathname === '/api/health') {
    return request.method === 'GET' ? json({ ok: true, protocol: 1 }) : json({ error: 'Method not allowed' }, 405)
  }
  if (url.pathname === '/api/rooms') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    if (origin && !validOrigin(origin, env)) return json({ error: 'Forbidden' }, 403)
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Invalid request' }, 400)
    let input: unknown
    try { input = await readJson(request, 2048) } catch { return json({ error: 'Invalid request' }, 400) }
    if (!record(input) || typeof input.roomId !== 'string' || !ROOM_ID.test(input.roomId) || typeof input.hostToken !== 'string' || !TOKEN.test(input.hostToken)) {
      return json({ error: 'Invalid request' }, 400)
    }
    // This value is supplied by Cloudflare at the edge. Neither the IP nor host token is persisted.
    const ip = request.headers.get('CF-Connecting-IP') || 'local'
    const ipHash = await hash(`${Math.floor(Date.now() / 86400000)}:${ip}`)
    const limiter = env.CREATION_LIMITER.get(env.CREATION_LIMITER.idFromName('creation-budget-v1'))
    const budget = await limiter.fetch(new Request('https://internal/consume', { method: 'POST', body: JSON.stringify({ ipHash }) }))
    if (!budget.ok) return json({ error: 'Too many requests' }, 429, { 'Retry-After': '600' })
    const room = env.ROOMS.get(env.ROOMS.idFromName(input.roomId))
    return room.fetch(new Request('https://internal/create', { method: 'POST', body: JSON.stringify({ hostTokenHash: await hash(input.hostToken) }) }))
  }
  const statusRoom = /^\/api\/rooms\/([a-f0-9]{32})\/status$/.exec(url.pathname)
  if (statusRoom) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    if (origin && !validOrigin(origin, env)) return json({ error: 'Forbidden' }, 403)
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return json({ error: 'Invalid request' }, 400)
    let input: unknown
    try { input = await readJson(request, 2048) } catch { return json({ error: 'Invalid request' }, 400) }
    if (!record(input) || typeof input.hostToken !== 'string' || !TOKEN.test(input.hostToken)) return json({ error: 'Invalid request' }, 400)
    const room = env.ROOMS.get(env.ROOMS.idFromName(statusRoom[1]))
    return room.fetch(new Request('https://internal/status', { method: 'POST', body: JSON.stringify({ hostTokenHash: await hash(input.hostToken) }) }))
  }
  if (url.pathname.startsWith('/relay/')) {
    const roomId = url.pathname.slice('/relay/'.length)
    if (!ROOM_ID.test(roomId)) return json({ error: 'Connection unavailable' }, 404)
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426)
    if (url.search || (origin && !validOrigin(origin, env))) return json({ error: 'Forbidden' }, 403)
    const room = env.ROOMS.get(env.ROOMS.idFromName(roomId))
    return room.fetch(request)
  }
  if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404)
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405)
  return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'Not found' }, 404)
}

export class CreationLimiter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      let input: unknown
      try { input = await request.json() } catch { return json({ error: 'Invalid request' }, 400) }
      if (!record(input) || typeof input.ipHash !== 'string' || !TOKEN.test(input.ipHash)) return json({ error: 'Invalid request' }, 400)
      const now = Date.now()
      const day = Math.floor(now / 86400000)
      const bucket = Math.floor(now / 600000)
      const global = await this.ctx.storage.get<{ day: number; count: number }>('global') || { day, count: 0 }
      const ipKey = `ip:${input.ipHash}`
      const ip = await this.ctx.storage.get<{ bucket: number; count: number }>(ipKey) || { bucket, count: 0 }
      if (global.day !== day) {
        const old = await this.ctx.storage.list({ prefix: 'ip:' })
        const keys = [...old.keys()]
        for (let offset = 0; offset < keys.length; offset += 128) await this.ctx.storage.delete(keys.slice(offset, offset + 128))
        global.day = day
        global.count = 0
      }
      if (ip.bucket !== bucket) { ip.bucket = bucket; ip.count = 0 }
      if (global.count >= 300 || ip.count >= 5) return json({ error: 'Too many requests' }, 429)
      global.count++
      ip.count++
      await this.ctx.storage.put({ global, [ipKey]: ip })
      await this.ctx.storage.setAlarm(now + 86400000)
      return json({ ok: true })
    })
  }

  async alarm(): Promise<void> { await this.ctx.storage.deleteAll() }
}

export class RelayRoom extends DurableObject<Env> {
  private room?: Room

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => { this.room = await ctx.storage.get<Room>('room') })
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'))
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (new URL(request.url).pathname === '/status' && request.method === 'POST') {
        if (!this.room || this.room.expiresAt <= Date.now()) return json({ error: 'Connection unavailable' }, 410)
        const input: unknown = await request.json()
        if (!record(input) || typeof input.hostTokenHash !== 'string' || !TOKEN.test(input.hostTokenHash)) return json({ error: 'Invalid request' }, 400)
        if (!equalHash(input.hostTokenHash, this.room.hostTokenHash)) return json({ error: 'Forbidden' }, 403)
        return json({ ok: true })
      }
      if (new URL(request.url).pathname === '/create' && request.method === 'POST') {
        if (this.room) return json({ error: 'Connection unavailable' }, 409)
        const input: unknown = await request.json()
        if (!record(input) || typeof input.hostTokenHash !== 'string' || !TOKEN.test(input.hostTokenHash)) return json({ error: 'Invalid request' }, 400)
        const now = Date.now()
        this.room = { hostTokenHash: input.hostTokenHash, createdAt: now, expiresAt: now + ROOM_TTL, devices: {}, invites: {} }
        await this.persist()
        return json({ ok: true, protocol: 1, expiresAt: this.room.expiresAt }, 201)
      }
      // Unknown and expired rooms use exactly the same response.
      if (!this.room || this.room.expiresAt <= Date.now()) return json({ error: 'Connection unavailable' }, 401)
      if (this.ctx.getWebSockets().length >= MAX_PEERS + MAX_PENDING + 1) return json({ error: 'Connection unavailable' }, 429)
      const sockets = new WebSocketPair()
      const [client, server] = [sockets[0], sockets[1]]
      this.ctx.acceptWebSocket(server)
      const now = Date.now()
      const peerId = crypto.randomUUID()
      server.serializeAttachment({ peerId, origin: request.headers.get('Origin') || undefined, deadline: now + AUTH_TIMEOUT, rateWindow: now, rateCount: 0, byteCount: 0 } satisfies Peer)
      // A persisted alarm enforces the deadline even if this object hibernates.
      await this.scheduleAlarm()
      return new Response(null, { status: 101, webSocket: client })
    })
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const peer = this.attachment(socket)
      if (!peer || peer.closed) return this.close(socket, 1008)
      if (!this.room || this.room.expiresAt <= Date.now()) return this.fail(socket)
      if (peer.role === 'browser' && !peer.authorized && peer.deadline <= Date.now()) return this.fail(socket)
      if (typeof message !== 'string') return this.close(socket, 1003)
      const size = encoder.encode(message).byteLength
      if (size > MAX_WIRE_BYTES) return this.close(socket, 1009)
      const now = Date.now()
      if (now - peer.rateWindow >= 10000) { peer.rateWindow = now; peer.rateCount = 0; peer.byteCount = 0 }
      peer.rateCount++
      peer.byteCount += size
      socket.serializeAttachment(peer)
      const byteBudget = peer.role === 'host' || peer.authorized ? 64 * MAX_PAYLOAD_BYTES : 8 * MAX_PAYLOAD_BYTES
      if (peer.rateCount > 200 || peer.byteCount > byteBudget) return this.close(socket, 1008)
      let input: unknown
      try { input = JSON.parse(message) } catch { return this.close(socket, 1008) }
      if (!record(input) || typeof input.type !== 'string') return this.close(socket, 1008)
      if (!peer.role) {
        if (peer.deadline <= now) return this.fail(socket)
        return this.authenticate(socket, peer, input)
      }
      if (input.type === 'ping') { this.send(socket, { type: 'pong' }); return }
      if (input.type === 'data') {
        if (!Object.hasOwn(input, 'payload') || encoder.encode(JSON.stringify(input.payload)).byteLength > MAX_PAYLOAD_BYTES) return this.close(socket, 1009)
        if (peer.role === 'host') {
          if (this.room.activeHostPeerId !== peer.peerId || typeof input.peerId !== 'string') return this.close(socket, 1008)
          const target = this.findPeer(input.peerId)
          if (target && this.attachment(target)?.role === 'browser') this.send(target, { type: 'data', payload: input.payload })
        } else {
          const host = this.host()
          if (host) this.send(host, { type: 'data', peerId: peer.peerId, payload: input.payload })
          else this.send(socket, { type: 'host.offline' })
        }
        return
      }
      if (peer.role !== 'host' || this.room.activeHostPeerId !== peer.peerId) return this.close(socket, 1008)
      await this.control(socket, input)
    })
  }

  private async authenticate(socket: WebSocket, peer: Peer, input: JsonRecord): Promise<void> {
    const room = this.room!
    if (input.type !== 'auth' || !['host', 'browser'].includes(String(input.role)) || typeof input.token !== 'string' || !TOKEN.test(input.token)) return this.fail(socket)
    const tokenHash = await hash(input.token)
    if (input.role === 'host') {
      if (!equalHash(tokenHash, room.hostTokenHash)) return this.fail(socket)
      const oldHost = this.host()
      peer.role = 'host'
      peer.authorized = true
      room.activeHostPeerId = peer.peerId
      room.expiresAt = Date.now() + ROOM_TTL
      socket.serializeAttachment(peer)
      await this.persist()
      if (oldHost && oldHost !== socket) this.close(oldHost, 4001)
      this.send(socket, { type: 'ready', role: 'host', peerId: peer.peerId })
      for (const browser of this.browsers()) {
        this.send(browser, { type: 'host.online' })
        this.joined(socket, this.attachment(browser)!)
      }
      return
    }
    if (!validOrigin(peer.origin, this.env)) return this.fail(socket)
    if (input.deviceId !== undefined && !validDeviceId(input.deviceId)) return this.fail(socket)
    const browsers = this.browsers()
    // Capacity is temporary. It must not invalidate a saved device credential.
    if (browsers.length >= MAX_PEERS) return this.close(socket, 1013)
    const deviceId = typeof input.deviceId === 'string' ? input.deviceId : undefined
    const device = deviceId && Object.hasOwn(room.devices, deviceId) ? room.devices[deviceId] : undefined
    const authorized = Boolean(device && equalHash(tokenHash, device.tokenHash))
    const invited = !authorized && Boolean(room.invites[tokenHash] && room.invites[tokenHash] > Date.now())
    if (!authorized && !invited) return this.fail(socket)
    if (!authorized && browsers.filter(ws => !this.attachment(ws)?.authorized).length >= MAX_PENDING) return this.close(socket, 1013)
    if (invited) {
      delete room.invites[tokenHash]
      await this.persist()
    }
    peer.role = 'browser'
    peer.deviceId = deviceId
    peer.authorized = authorized
    peer.invited = invited
    if (!authorized) peer.deadline = Date.now() + INVITE_TTL
    socket.serializeAttachment(peer)
    this.send(socket, { type: 'ready', role: 'browser', peerId: peer.peerId, invited, authorized })
    const host = this.host()
    if (host) this.joined(host, peer)
    else this.send(socket, { type: 'host.offline' })
    await this.scheduleAlarm()
  }

  private async control(host: WebSocket, input: JsonRecord): Promise<void> {
    const room = this.room!
    if (input.type === 'renew') {
      room.expiresAt = Date.now() + ROOM_TTL
      await this.persist()
      this.send(host, { type: 'renewed', expiresAt: room.expiresAt })
      return
    }
    if (input.type === 'invite') {
      const now = Date.now()
      this.removeExpiredInvites(now)
      if (typeof input.tokenHash !== 'string' || !TOKEN.test(input.tokenHash) || typeof input.expiresAt !== 'number' || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + INVITE_TTL) return this.controlError(host)
      // Refresh is a replacement, including any still-unapproved browser that
      // consumed the previous invitation. Persisted device credentials survive.
      room.invites = { [input.tokenHash]: input.expiresAt }
      for (const browser of this.browsers()) if (!this.attachment(browser)?.authorized) this.close(browser, 4003)
      await this.persist()
      this.send(host, { type: 'invite.ready', tokenHash: input.tokenHash })
      return
    }
    if (input.type === 'authorize') {
      if (typeof input.peerId !== 'string' || !validDeviceId(input.deviceId) || typeof input.tokenHash !== 'string' || !TOKEN.test(input.tokenHash)) return this.controlError(host)
      const target = this.findPeer(input.peerId)
      const peer = target && this.attachment(target)
      if (!target || peer?.role !== 'browser' || (!room.devices[input.deviceId] && Object.keys(room.devices).length >= MAX_DEVICES)) return this.controlError(host)
      room.devices[input.deviceId] = { tokenHash: input.tokenHash, createdAt: Date.now() }
      peer.deviceId = input.deviceId
      peer.authorized = true
      target.serializeAttachment(peer)
      await this.persist()
      this.send(host, { type: 'authorized', deviceId: input.deviceId })
      this.send(target, { type: 'authorized', deviceId: input.deviceId })
      return
    }
    if (input.type === 'revoke' && validDeviceId(input.deviceId)) {
      delete room.devices[input.deviceId]
      await this.persist()
      for (const browser of this.browsers()) if (this.attachment(browser)?.deviceId === input.deviceId) this.close(browser, 4403)
      this.send(host, { type: 'revoked', deviceId: input.deviceId })
      return
    }
    if (input.type === 'disconnect' && typeof input.peerId === 'string') {
      const peer = this.findPeer(input.peerId)
      // A host may shed an overloaded or failed transport without revoking the device.
      if (peer && this.attachment(peer)?.role === 'browser') this.close(peer, 1013)
      this.send(host, { type: 'disconnected', peerId: input.peerId })
      return
    }
    if (input.type === 'stop') {
      // Keep an expired tombstone until its alarm so the identifier cannot be immediately reused.
      room.expiresAt = Date.now()
      room.hostTokenHash = ''
      room.devices = {}
      room.invites = {}
      room.activeHostPeerId = undefined
      await this.persist()
      for (const socket of this.ctx.getWebSockets()) { this.send(socket, { type: 'stopped' }); this.close(socket, 4403) }
      return
    }
    this.controlError(host)
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    await this.lost(socket)
    this.close(socket, code === 1006 ? 1000 : code)
  }

  async webSocketError(socket: WebSocket): Promise<void> { await this.lost(socket); this.close(socket, 1011) }

  private async lost(socket: WebSocket): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const peer = this.attachment(socket)
      if (!peer || !this.room) return
      if (peer.role === 'host' && this.room.activeHostPeerId === peer.peerId) {
        this.room.activeHostPeerId = undefined
        await this.persist()
        for (const browser of this.browsers()) this.send(browser, { type: 'host.offline' })
      } else if (peer.role === 'browser') {
        const host = this.host()
        if (host) this.send(host, { type: 'peer.left', peerId: peer.peerId, deviceId: peer.deviceId })
      }
    })
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now()
      if (!this.room || this.room.expiresAt <= now) {
        for (const socket of this.ctx.getWebSockets()) this.fail(socket)
        await this.ctx.storage.deleteAll()
        this.room = undefined
        return
      }
      for (const socket of this.ctx.getWebSockets()) {
        const peer = this.attachment(socket)
        const waiting = !peer?.role || (peer.role === 'browser' && !peer.authorized)
        if (!peer?.closed && waiting && (!peer || peer.deadline <= now)) this.fail(socket)
      }
      if (this.removeExpiredInvites(now)) await this.ctx.storage.put('room', this.room)
      await this.scheduleAlarm()
    })
  }

  private removeExpiredInvites(now: number): boolean {
    let changed = false
    if (this.room) for (const [key, expires] of Object.entries(this.room.invites)) if (expires <= now) { delete this.room.invites[key]; changed = true }
    return changed
  }

  private attachment(socket: WebSocket): Peer | undefined {
    try { return socket.deserializeAttachment() as Peer | undefined } catch { return undefined }
  }
  private browsers(): WebSocket[] { return this.ctx.getWebSockets().filter(socket => { const peer = this.attachment(socket); return peer?.role === 'browser' && !peer.closed && socket.readyState === WebSocket.OPEN }) }
  private host(): WebSocket | undefined { return this.ctx.getWebSockets().find(socket => { const peer = this.attachment(socket); return peer?.peerId === this.room?.activeHostPeerId && !peer?.closed && socket.readyState === WebSocket.OPEN }) }
  private findPeer(peerId: string): WebSocket | undefined { return this.ctx.getWebSockets().find(socket => { const peer = this.attachment(socket); return peer?.peerId === peerId && !peer.closed && socket.readyState === WebSocket.OPEN }) }
  private joined(host: WebSocket, peer: Peer): void { this.send(host, { type: 'peer.joined', peerId: peer.peerId, deviceId: peer.deviceId, invited: Boolean(peer.invited), authorized: Boolean(peer.authorized) }) }
  private send(socket: WebSocket, value: unknown): void { try { socket.send(JSON.stringify(value)) } catch { /* A closed peer is handled by its close callback. */ } }
  private close(socket: WebSocket, code: number): void {
    const peer = this.attachment(socket)
    if (peer) {
      socket.serializeAttachment({ ...peer, closed: true })
    }
    try { socket.close(code, 'Connection closed') } catch { /* Already closed. */ }
  }
  private fail(socket: WebSocket): void { this.send(socket, { type: 'error', error: 'Connection unavailable' }); this.close(socket, 4003) }
  private controlError(host: WebSocket): void { this.send(host, { type: 'error', error: 'Invalid operation' }) }

  private async persist(): Promise<void> {
    if (this.room) await this.ctx.storage.put('room', this.room)
    await this.scheduleAlarm()
  }

  private async scheduleAlarm(): Promise<void> {
    if (!this.room) return
    let next = this.room.expiresAt
    for (const expiresAt of Object.values(this.room.invites)) next = Math.min(next, expiresAt)
    for (const socket of this.ctx.getWebSockets()) {
      const peer = this.attachment(socket)
      if (peer && !peer.closed && (!peer.role || (peer.role === 'browser' && !peer.authorized))) next = Math.min(next, peer.deadline)
    }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, next))
  }
}
