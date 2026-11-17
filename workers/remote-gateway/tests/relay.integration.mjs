import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const origin = 'https://webui.clerkbox.xmzf.space'
const random = bytes => randomBytes(bytes).toString('hex')
const digest = token => createHash('sha256').update(token).digest('hex')
let mf
let ip = 1

before(async () => {
  const out = fileURLToPath(new URL('../.test-build/', import.meta.url))
  await mkdir(out, { recursive: true })
  await build({
    // Test-only storage fixture: the production fetch/socket implementations
    // remain inherited. Expiration is persisted, then the object is evicted so
    // its real constructor and status path read the expired record from SQLite.
    stdin: {
      contents: `import worker, { RelayRoom as ProductionRelayRoom, CreationLimiter } from './src/index.ts';
        export default {
          fetch(request, env, ctx) {
            const assets = {fetch: () => new Response('<!doctype html><title>WebUI</title>', {headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate'}})};
            return worker.fetch(request, {...env, ASSETS: assets}, ctx);
          }
        }; export { CreationLimiter };
        export class RelayRoom extends ProductionRelayRoom {
          async fetch(request) {
            if (new URL(request.url).pathname === '/__test-expire') {
              await this.ctx.blockConcurrencyWhile(async () => {
                const room = await this.ctx.storage.get('room');
                if (!room) throw new Error('Test room missing');
                await this.ctx.storage.put('room', {...room, expiresAt: Date.now() - 1});
              });
              return new Response(null, {status:204});
            }
            return super.fetch(request);
          }
        }`,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
    },
    outfile: `${out}/worker.mjs`, bundle: true, format: 'esm', platform: 'browser',
    target: 'es2022', external: ['cloudflare:workers'],
  })
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'gateway-test', modules: true, scriptPath: `${out}/worker.mjs`, compatibilityDate: '2026-11-16',
    durableObjects: {
      ROOMS: { className: 'RelayRoom', useSQLite: true },
      CREATION_LIMITER: { className: 'CreationLimiter', useSQLite: true },
    },
    bindings: { PUBLIC_ORIGIN: origin, ALLOW_LOCALHOST_ORIGINS: 'false' },
  }))
})

after(async () => { await mf?.dispose() })

async function createRoom(overrides = {}, customIp) {
  const roomId = random(16)
  const hostToken = random(32)
  const response = await mf.dispatchFetch(`${origin}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': customIp || `192.0.2.${ip++}` },
    body: JSON.stringify({ roomId, hostToken, ...overrides }),
  })
  return { roomId, hostToken, response }
}

class Channel {
  constructor(socket) {
    this.socket = socket
    this.messages = []
    this.listeners = []
    this.closed = new Promise(resolve => { socket.addEventListener('close', event => resolve(event)) })
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data)
      this.messages.push(data)
      this.listeners.slice().forEach(check => check())
    })
    socket.accept()
  }
  send(data) { this.socket.send(JSON.stringify(data)) }
  next(type, timeout = 2500) {
    return new Promise((resolve, reject) => {
      const find = () => {
        const index = this.messages.findIndex(message => message.type === type)
        if (index < 0) return
        const [message] = this.messages.splice(index, 1)
        clearTimeout(timer)
        this.listeners = this.listeners.filter(listener => listener !== find)
        resolve(message)
      }
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter(listener => listener !== find)
        reject(new Error(`Timed out waiting for protocol event ${type}`))
      }, timeout)
      this.listeners.push(find)
      find()
    })
  }
  async absent(type, ms = 80) {
    await new Promise(resolve => setTimeout(resolve, ms))
    assert.equal(this.messages.some(message => message.type === type), false, `Unexpected protocol event ${type}`)
  }
  close() { try { this.socket.close(1000) } catch {} }
}

async function connect(roomId, socketOrigin = origin) {
  const headers = { Upgrade: 'websocket' }
  if (socketOrigin) headers.Origin = socketOrigin
  const response = await mf.dispatchFetch(`${origin}/relay/${roomId}`, { headers })
  assert.equal(response.status, 101)
  return new Channel(response.webSocket)
}

async function host(room) {
  const connection = await connect(room.roomId, null)
  connection.send({ type: 'auth', role: 'host', token: room.hostToken })
  const ready = await connection.next('ready')
  assert.equal(ready.role, 'host')
  return connection
}

async function invite(connection) {
  const token = random(32)
  connection.send({ type: 'invite', tokenHash: digest(token), expiresAt: Date.now() + 60000 })
  assert.equal((await connection.next('invite.ready')).tokenHash, digest(token))
  return token
}

async function browser(room, hostConnection, deviceId = random(16)) {
  const token = await invite(hostConnection)
  const connection = await connect(room.roomId)
  connection.send({ type: 'auth', role: 'browser', token, deviceId })
  const ready = await connection.next('ready')
  const joined = await hostConnection.next('peer.joined')
  assert.equal(ready.peerId, joined.peerId)
  return { connection, ready, joined, token, deviceId }
}

test('health, methods, creation validation, duplicate protection and security headers', async () => {
  const health = await mf.dispatchFetch(`${origin}/api/health`)
  assert.deepEqual(await health.json(), { ok: true, protocol: 1 })
  assert.equal(health.headers.get('Cache-Control'), 'no-store')
  assert.equal(health.headers.get('Referrer-Policy'), 'no-referrer')
  assert.ok(health.headers.get('Content-Security-Policy').includes("connect-src 'self' wss://webui.clerkbox.xmzf.space;"))
  assert.equal((await mf.dispatchFetch(`${origin}/api/rooms`)).status, 405)
  assert.equal((await createRoom({ roomId: 'bad' })).response.status, 400)
  const room = await createRoom()
  assert.equal(room.response.status, 201)
  const duplicate = await createRoom({ roomId: room.roomId })
  assert.equal(duplicate.response.status, 409)
  assert.equal((await mf.dispatchFetch(`${origin}/api/missing`)).status, 404)
})

test('only canonical WebUI HTML disables transformations and preserves the strict CSP and cache policy', async () => {
  const page = await mf.dispatchFetch(`${origin}/`)
  assert.equal(page.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate, no-transform')
  assert.ok(page.headers.get('Content-Security-Policy').includes("script-src 'self';"))
  assert.equal(page.headers.get('Content-Security-Policy').includes('cloudflareinsights.com'), false)
  const otherHostname = await mf.dispatchFetch('https://other.xmzf.space/')
  assert.equal(otherHostname.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate')
  const health = await mf.dispatchFetch(`${origin}/api/health`)
  assert.equal(health.headers.get('Cache-Control'), 'no-store')
})

test('creation is limited by source and does not overwrite rooms', async () => {
  for (let index = 0; index < 5; index++) assert.equal((await createRoom({}, '198.51.100.99')).response.status, 201)
  const limited = await createRoom({}, '198.51.100.99')
  assert.equal(limited.response.status, 429)
  assert.equal(limited.response.headers.get('Retry-After'), '600')
})

test('authenticated room status distinguishes live, expired, missing and wrong credentials without consuming creation budget', async () => {
  const source = '198.51.100.102'
  const room = await createRoom({}, source)
  const status = (roomId = room.roomId, hostToken = room.hostToken, headers = {}, body) => mf.dispatchFetch(`${origin}/api/rooms/${roomId}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': source, ...headers },
    body: body ?? JSON.stringify({ hostToken }),
  })
  for (let index = 0; index < 6; index++) {
    const response = await status()
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  }
  const wrong = await status(room.roomId, random(32))
  assert.equal(wrong.status, 403)
  assert.deepEqual(await wrong.json(), { error: 'Forbidden' })
  assert.equal((await status(random(16))).status, 410)
  assert.equal((await status(room.roomId, room.hostToken, { Origin: 'https://attacker.invalid' })).status, 403)
  assert.equal((await status(room.roomId, room.hostToken, {}, JSON.stringify({ hostToken: room.hostToken, padding: 'x'.repeat(2048) }))).status, 400)
  assert.equal((await mf.dispatchFetch(`${origin}/api/rooms/${room.roomId}/status`)).status, 405)
  assert.equal((await createRoom({}, source)).response.status, 201, 'Status checks must not consume room creation budget')

  const namespace = await mf.getDurableObjectNamespace('ROOMS')
  const stub = namespace.get(namespace.idFromName(room.roomId))
  assert.equal((await stub.fetch('https://internal/__test-expire')).status, 204)
  await mf.unsafeEvictDurableObject('gateway-test', 'RelayRoom', { name: room.roomId })
  const expired = await status()
  assert.equal(expired.status, 410)
  assert.deepEqual(await expired.json(), { error: 'Connection unavailable' })
  assert.equal((await status(room.roomId, random(32))).status, 410, 'Expired rooms never reveal their previous token validity')
})

test('hostile origins, query credentials, invalid IDs and non-WebSocket requests are rejected', async () => {
  const room = await createRoom()
  assert.equal((await mf.dispatchFetch(`${origin}/relay/${room.roomId}`, { headers: { Upgrade: 'websocket', Origin: 'https://attacker.invalid' } })).status, 403)
  assert.equal((await mf.dispatchFetch(`${origin}/relay/${room.roomId}?token=do-not-log`, { headers: { Upgrade: 'websocket' } })).status, 403)
  assert.equal((await mf.dispatchFetch(`${origin}/relay/not-valid`, { headers: { Upgrade: 'websocket' } })).status, 404)
  assert.equal((await mf.dispatchFetch(`${origin}/relay/${room.roomId}`)).status, 426)
  const wrongOriginCreate = await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' }, body: '{}' })
  assert.equal(wrongOriginCreate.status, 403)
})

test('invalid host token and missing browser Origin receive uniform auth errors', async () => {
  const room = await createRoom()
  const wrong = await connect(room.roomId, null)
  wrong.send({ type: 'auth', role: 'host', token: random(32) })
  assert.deepEqual(await wrong.next('error'), { type: 'error', error: 'Connection unavailable' })
  assert.equal((await wrong.closed).code, 4003)
  const owner = await host(room)
  const token = await invite(owner)
  const absentOrigin = await connect(room.roomId, null)
  absentOrigin.send({ type: 'auth', role: 'browser', token })
  assert.deepEqual(await absentOrigin.next('error'), { type: 'error', error: 'Connection unavailable' })
  owner.close()
})

test('single-use invitation, pair metadata and targeted opaque payloads remain isolated', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const first = await browser(room, owner)
  assert.equal(first.ready.authorized, false)
  assert.equal(first.joined.invited, true)
  const replay = await connect(room.roomId)
  replay.send({ type: 'auth', role: 'browser', token: first.token, deviceId: first.deviceId })
  await replay.next('error')
  assert.equal((await replay.closed).code, 4003)
  owner.send({ type: 'authorize', peerId: first.ready.peerId, deviceId: first.deviceId, tokenHash: digest(random(32)) })
  await owner.next('authorized')
  await first.connection.next('authorized')
  const second = await browser(room, owner)
  first.connection.send({ type: 'data', payload: { challenge: 'opaque-pair-challenge' } })
  assert.deepEqual(await owner.next('data'), { type: 'data', peerId: first.ready.peerId, payload: { challenge: 'opaque-pair-challenge' } })
  await second.connection.absent('data')
  owner.send({ type: 'data', peerId: first.ready.peerId, payload: { cipher: 'opaque-ciphertext' } })
  assert.deepEqual(await first.connection.next('data'), { type: 'data', payload: { cipher: 'opaque-ciphertext' } })
  await second.connection.absent('data')
  first.connection.close(); second.connection.close(); owner.close()
})

test('only host can invite or authorize and expired invitation registration is rejected', async () => {
  const room = await createRoom()
  const owner = await host(room)
  owner.send({ type: 'invite', tokenHash: digest(random(32)), expiresAt: Date.now() - 1 })
  assert.deepEqual(await owner.next('error'), { type: 'error', error: 'Invalid operation' })
  const peer = await browser(room, owner)
  peer.connection.send({ type: 'invite', tokenHash: digest(random(32)), expiresAt: Date.now() + 60000 })
  assert.equal((await peer.connection.closed).code, 1008)
  owner.close()
})

test('registered invitation expiry and reserved device identifiers cannot authenticate', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const token = random(32)
  owner.send({ type: 'invite', tokenHash: digest(token), expiresAt: Date.now() + 150 })
  await owner.next('invite.ready')
  await new Promise(resolve => setTimeout(resolve, 250))
  const expired = await connect(room.roomId)
  expired.send({ type: 'auth', role: 'browser', token })
  await expired.next('error')
  assert.equal((await expired.closed).code, 4003)
  const fresh = await invite(owner)
  const reserved = await connect(room.roomId)
  reserved.send({ type: 'auth', role: 'browser', token: fresh, deviceId: '__proto__' })
  await reserved.next('error')
  assert.equal((await reserved.closed).code, 4003)
  owner.send({ type: 'ping' })
  await owner.next('pong')
  owner.close()
})

test('room boundaries prevent cross-room host routing and foreign host credentials', async () => {
  const firstRoom = await createRoom()
  const secondRoom = await createRoom()
  const firstHost = await host(firstRoom)
  const secondHost = await host(secondRoom)
  const firstBrowser = await browser(firstRoom, firstHost)
  const secondBrowser = await browser(secondRoom, secondHost)
  firstHost.send({ type: 'data', peerId: secondBrowser.ready.peerId, payload: 'foreign-room' })
  await secondBrowser.connection.absent('data')
  await firstBrowser.connection.absent('data')
  const foreign = await connect(secondRoom.roomId, null)
  foreign.send({ type: 'auth', role: 'host', token: firstRoom.hostToken })
  await foreign.next('error')
  assert.equal((await foreign.closed).code, 4003)
  firstBrowser.connection.close(); secondBrowser.connection.close(); firstHost.close(); secondHost.close()
})

test('approved device can reconnect, wrong device fails, and revocation disconnects it immediately', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const peer = await browser(room, owner)
  const token = random(32)
  owner.send({ type: 'authorize', peerId: peer.ready.peerId, deviceId: peer.deviceId, tokenHash: digest(token) })
  assert.equal((await owner.next('authorized')).deviceId, peer.deviceId)
  await peer.connection.next('authorized')
  peer.connection.close()
  await owner.next('peer.left')
  const wrong = await connect(room.roomId)
  wrong.send({ type: 'auth', role: 'browser', token, deviceId: random(16) })
  await wrong.next('error')
  const reconnect = await connect(room.roomId)
  reconnect.send({ type: 'auth', role: 'browser', token, deviceId: peer.deviceId })
  assert.equal((await reconnect.next('ready')).authorized, true)
  await owner.next('peer.joined')
  owner.send({ type: 'revoke', deviceId: peer.deviceId })
  await owner.next('revoked')
  assert.equal((await reconnect.closed).code, 4403)
  const revoked = await connect(room.roomId)
  revoked.send({ type: 'auth', role: 'browser', token, deviceId: peer.deviceId })
  await revoked.next('error')
  owner.close()
})

test('host reconnect replays peers and old host close cannot take the new host offline', async () => {
  const room = await createRoom()
  const firstHost = await host(room)
  const peer = await browser(room, firstHost)
  const replacement = await host(room)
  assert.equal((await firstHost.closed).code, 4001)
  await peer.connection.next('host.online')
  assert.equal((await replacement.next('peer.joined')).peerId, peer.ready.peerId)
  await peer.connection.absent('host.offline')
  peer.connection.send({ type: 'data', payload: 'still-connected' })
  assert.equal((await replacement.next('data')).payload, 'still-connected')
  replacement.close()
  await peer.connection.next('host.offline')
  const thirdHost = await host(room)
  await peer.connection.next('host.online')
  assert.equal((await thirdHost.next('peer.joined')).peerId, peer.ready.peerId)
  peer.connection.close(); thirdHost.close()
})

test('host disconnect is recoverable and keeps the approved device credential valid', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const peer = await browser(room, owner)
  const token = random(32)
  owner.send({ type: 'authorize', peerId: peer.ready.peerId, deviceId: peer.deviceId, tokenHash: digest(token) })
  await owner.next('authorized')
  await peer.connection.next('authorized')
  owner.send({ type: 'disconnect', peerId: peer.ready.peerId })
  await owner.next('disconnected')
  assert.equal((await peer.connection.closed).code, 1013)
  await peer.connection.absent('error')
  const reconnected = await connect(room.roomId)
  reconnected.send({ type: 'auth', role: 'browser', token, deviceId: peer.deviceId })
  assert.equal((await reconnected.next('ready')).authorized, true)
  await owner.next('peer.joined')
  reconnected.send({ type: 'data', payload: 'credential-still-valid' })
  assert.equal((await owner.next('data')).payload, 'credential-still-valid')
  reconnected.close(); owner.close()
})

test('oversize opaque payload is closed with a policy size error', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const peer = await browser(room, owner)
  peer.connection.send({ type: 'data', payload: 'x'.repeat(1024 * 1024 + 1) })
  assert.equal((await peer.connection.closed).code, 1009)
  await owner.absent('data')
  owner.close()
})

test('refresh cancels pending pairing while an approved peer keeps its access and larger transfer budget', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const approved = await browser(room, owner)
  owner.send({ type: 'authorize', peerId: approved.ready.peerId, deviceId: approved.deviceId, tokenHash: digest(random(32)) })
  await owner.next('authorized')
  await approved.connection.next('authorized')
  const pending = await browser(room, owner)
  await invite(owner)
  assert.equal((await pending.connection.closed).code, 4003)
  const chunk = 'x'.repeat(550000)
  for (let index = 0; index < 20; index++) {
    approved.connection.send({ type: 'data', payload: chunk })
    assert.equal((await owner.next('data')).payload.length, chunk.length)
  }
  approved.connection.close()
  owner.close()
})

test('invitation rotation replaces unused tokens and preserves persistent device authentication', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const approved = await browser(room, owner)
  const deviceToken = random(32)
  owner.send({ type: 'authorize', peerId: approved.ready.peerId, deviceId: approved.deviceId, tokenHash: digest(deviceToken) })
  await owner.next('authorized')
  await approved.connection.next('authorized')
  const stale = await invite(owner)
  const current = await invite(owner)
  const denied = await connect(room.roomId)
  denied.send({ type: 'auth', role: 'browser', token: stale })
  await denied.next('error')
  assert.equal((await denied.closed).code, 4003)
  approved.connection.send({ type: 'data', payload: 'approved-survives-refresh' })
  assert.equal((await owner.next('data')).payload, 'approved-survives-refresh')
  const fresh = await connect(room.roomId)
  fresh.send({ type: 'auth', role: 'browser', token: current })
  assert.equal((await fresh.next('ready')).invited, true)
  await owner.next('peer.joined')
  approved.connection.close()
  fresh.close()
  // A reconnect uses its saved device token, without consuming another invite.
  const reconnect = await connect(room.roomId)
  reconnect.send({ type: 'auth', role: 'browser', token: deviceToken, deviceId: approved.deviceId })
  assert.equal((await reconnect.next('ready')).authorized, true)
  reconnect.close(); owner.close()
})

test('eight approved browsers can connect together and a ninth is refused without disrupting them', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const peers = []
  for (let index = 0; index < 8; index++) {
    const peer = await browser(room, owner)
    owner.send({ type: 'authorize', peerId: peer.ready.peerId, deviceId: peer.deviceId, tokenHash: digest(random(32)) })
    await owner.next('authorized')
    await peer.connection.next('authorized')
    peers.push(peer)
  }
  const token = await invite(owner)
  const overflow = await connect(room.roomId)
  overflow.send({ type: 'auth', role: 'browser', token })
  assert.equal((await overflow.closed).code, 1013)
  await overflow.absent('error')
  for (const [index, peer] of peers.entries()) {
    peer.connection.send({ type: 'data', payload: { index } })
    assert.deepEqual((await owner.next('data')).payload, { index })
    peer.connection.close()
  }
  owner.close()
})

test('stop closes every peer and invalidates host, invite and device authentication', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const peer = await browser(room, owner)
  owner.send({ type: 'stop' })
  await peer.connection.next('stopped')
  assert.equal((await peer.connection.closed).code, 4403)
  assert.equal((await owner.closed).code, 4403)
  const unavailable = await mf.dispatchFetch(`${origin}/relay/${room.roomId}`, { headers: { Upgrade: 'websocket' } })
  assert.equal(unavailable.status, 401)
  assert.deepEqual(await unavailable.json(), { error: 'Connection unavailable' })
})

test('unauthenticated sockets expire after ten seconds without a busy keepalive loop', async () => {
  const room = await createRoom()
  const connection = await connect(room.roomId)
  const started = Date.now()
  assert.deepEqual(await connection.next('error', 12500), { type: 'error', error: 'Connection unavailable' })
  assert.ok(Date.now() - started >= 9500)
  // Complete the proxy's close handshake; no auth frame was ever accepted.
  connection.close()
  assert.equal((await connection.closed).code, 4003)
})

test('hibernation retains authenticated routing and host renewal extends metadata TTL', async () => {
  const room = await createRoom()
  const owner = await host(room)
  const peer = await browser(room, owner)
  const token = random(32)
  owner.send({ type: 'authorize', peerId: peer.ready.peerId, deviceId: peer.deviceId, tokenHash: digest(token) })
  await owner.next('authorized')
  await peer.connection.next('authorized')
  await mf.unsafeEvictDurableObject('gateway-test', 'RelayRoom', { name: room.roomId, webSockets: 'hibernate' })
  peer.connection.send({ type: 'data', payload: { opaque: 'after-hibernation' } })
  assert.equal((await owner.next('data')).payload.opaque, 'after-hibernation')
  owner.send({ type: 'renew' })
  assert.ok((await owner.next('renewed')).expiresAt > Date.now() + 6 * 86400000)
  peer.connection.close(); owner.close()
})
