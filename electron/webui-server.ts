import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as os from 'os'
import { app } from 'electron'

/**
 * WebUI 服务器：把 ClerkBox 的完整界面通过 HTTP 暴露给浏览器。
 *
 * 设计要点：
 * - 复用主进程已注册的 IPC handler（通过 handlerRegistry），不重复实现业务逻辑
 * - 流式对话走 SSE（Server-Sent Events），与 Electron IPC 的 apiChunk 事件语义对齐
 * - 随机 token 认证，防止局域网内未授权访问
 * - 开发模式代理到 Vite dev server，生产模式直接 serve dist/ 静态文件
 */

// ── Handler 注册表 ──
// main.ts / api-proxy.ts 在注册 ipcMain.handle 的同时，把 handler 写入此表。
// WebUI 的 /api/invoke 路由通过此表调用同一份业务逻辑。
export const handlerRegistry = new Map<string, (...args: unknown[]) => unknown>()

// ── 流式对话桥接 ──
// api-proxy.ts 导出 startChatStream / abortChatStream，main.ts 启动时注入。
export type StreamSendFn = (payload: Record<string, unknown>) => void
let startChatStreamFn: ((cfg: unknown, body: unknown, requestId: string, send: StreamSendFn) => void) | null = null
let abortChatStreamFn: ((requestId: string) => void) | null = null

export function setStreamHandlers(
  startFn: (cfg: unknown, body: unknown, requestId: string, send: StreamSendFn) => void,
  abortFn: (requestId: string) => void
): void {
  startChatStreamFn = startFn
  abortChatStreamFn = abortFn
}

// ── MIME 类型 ──
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

// Remote WebUI uploads are deliberately capped to the same 10 MB scale as
// the file tool read limit. The environment override is useful for a local
// deployment, but is bounded so a bad value cannot disable the guardrail.
const DEFAULT_WEBUI_UPLOAD_BYTES = 10 * 1024 * 1024
const getWebUIUploadLimit = (): number => {
  const raw = Number(process.env.CLERKBOX_WEBUI_MAX_UPLOAD_MB)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WEBUI_UPLOAD_BYTES
  return Math.min(Math.max(Math.floor(raw), 1), 100) * 1024 * 1024
}

// ── 服务器状态 ──
let server: http.Server | null = null
let currentToken = ''
let currentPort = 0

export function getWebUIStatus(): { running: boolean; url?: string } {
  if (!server) return { running: false }
  return { running: true, url: `http://localhost:${currentPort}/?token=${currentToken}` }
}

/** 枚举本机非内部 IPv4 地址（供移动端扫码/拼局域网 URL 用），按可用性排序 */
export function getLanAddresses(): string[] {
  const out: string[] = []
  const interfaces = os.networkInterfaces()
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      // 排除链路本地与基准测试保留段（VPN TUN 常占用 198.18.0.0/15，手机无法访问）
      if (/^169\.254\./.test(addr.address) || /^198\.(18|19)\./.test(addr.address)) continue
      out.push(addr.address)
    }
  }
  // 真实局域网网段优先（RFC1918），其余排在后面兜底
  const isPrivate = (ip: string) =>
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)))
}

export async function startWebUI(options: { lanAccess?: boolean } = {}): Promise<{ port: number; token: string; url: string }> {
  if (server) {
    return { port: currentPort, token: currentToken, url: `http://localhost:${currentPort}/?token=${currentToken}` }
  }

  currentToken = crypto.randomBytes(32).toString('hex')
  // 默认仅绑定本机回环地址；显式开启局域网访问后才绑定所有网卡。
  // 绑定 0.0.0.0 意味着同一网络内任何设备都可尝试访问，依赖随机 token 认证。
  const host = options.lanAccess ? '0.0.0.0' : '127.0.0.1'

  return new Promise((resolve, reject) => {
    server = http.createServer(handleRequest)
    server.listen(0, host, () => {
      const addr = server!.address()
      if (addr && typeof addr === 'object') {
        currentPort = addr.port
        resolve({ port: currentPort, token: currentToken, url: `http://localhost:${currentPort}/?token=${currentToken}` })
      } else {
        server = null
        reject(new Error('Failed to get server address'))
      }
    })
    server.on('error', (err) => {
      server = null
      reject(err)
    })
  })
}

export function stopWebUI(): void {
  if (server) {
    server.close()
    server = null
    currentToken = ''
    currentPort = 0
  }
}

// ── 请求分发 ──
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', `http://localhost:${currentPort}`)

  // API 路由需要 token 认证
  if (url.pathname.startsWith('/api/')) {
    const token = (req.headers['x-webui-token'] as string) || url.searchParams.get('token') || ''
    if (token !== currentToken) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    if (url.pathname === '/api/invoke' && req.method === 'POST') {
      void handleInvoke(req, res)
      return
    }
    if (url.pathname === '/api/chat-stream' && req.method === 'POST') {
      void handleChatStream(req, res)
      return
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      void handleUpload(req, res, url).catch((error) => {
        if (!res.writableEnded) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      })
      return
    }
    if (url.pathname === '/api/capabilities' && req.method === 'GET') {
      sendJson(res, 200, {
        result: {
          isRemoteClient: !isLoopbackAddress(req.socket.remoteAddress),
          canUpload: true,
          canBrowseHostFolders: true,
          maxUploadBytes: getWebUIUploadLimit(),
        },
      })
      return
    }
    if (url.pathname === '/api/platform') {
      sendJson(res, 200, { result: process.platform })
      return
    }
    if (url.pathname === '/api/homedir') {
      sendJson(res, 200, { result: os.homedir() })
      return
    }

    sendJson(res, 404, { error: 'Not found' })
    return
  }

  // 静态文件 / Vite 代理
  if (process.env.VITE_DEV_SERVER_URL) {
    proxyToVite(req, res)
  } else {
    serveStatic(req, res, url.pathname)
  }
}

/** Stream one browser-selected file to the host without buffering it in memory. */
async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const limit = getWebUIUploadLimit()
  const declaredLength = Number(req.headers['content-length'] || 0)
  if (declaredLength > limit) {
    req.resume()
    sendJson(res, 413, { error: `File too large. Maximum is ${formatBytes(limit)}.` })
    return
  }

  const rawName = url.searchParams.get('name') || 'upload.bin'
  const name = sanitizeUploadName(rawName)
  const uploadDir = path.join(app.getPath('userData'), 'webui-uploads')
  const uploadPath = path.join(uploadDir, `${crypto.randomBytes(16).toString('hex')}-${name}`)

  await fs.promises.mkdir(uploadDir, { recursive: true })
  const size = await streamRequestToFile(req, uploadPath, limit)
  if (size === null) {
    await fs.promises.rm(uploadPath, { force: true }).catch(() => {})
    sendJson(res, 413, { error: `File too large. Maximum is ${formatBytes(limit)}.` })
    return
  }

  sendJson(res, 200, {
    result: { name, path: uploadPath, size, maxUploadBytes: limit },
  })
}

function streamRequestToFile(req: http.IncomingMessage, filePath: string, limit: number): Promise<number | null> {
  return new Promise((resolve) => {
    const output = fs.createWriteStream(filePath, { flags: 'wx' })
    let received = 0
    let tooLarge = false
    let settled = false

    const finish = (result: number | null) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    output.on('error', () => {
      req.resume()
      finish(null)
    })
    output.on('finish', () => finish(tooLarge ? null : received))
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > limit) {
        tooLarge = true
        return
      }
      output.write(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        output.destroy()
        finish(null)
      } else {
        output.end()
      }
    })
    req.on('error', () => {
      output.destroy()
      finish(null)
    })
  })
}

function sanitizeUploadName(value: string): string {
  const base = path.basename(value).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').trim()
  const safe = base.replace(/^\.+$/, '') || 'upload.bin'
  return safe.slice(0, 160)
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = (address || '').replace(/^::ffff:/, '')
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')
}

// ── /api/invoke：调用 handlerRegistry 中的 handler ──
async function handleInvoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req, 10 * 1024 * 1024)
  if (body === null) {
    sendJson(res, 413, { error: 'Request body too large' })
    return
  }

  try {
    const { method, args } = JSON.parse(body) as { method: string; args: unknown[] }
    if (typeof method !== 'string' || !Array.isArray(args)) {
      sendJson(res, 400, { error: 'Invalid request format' })
      return
    }

    // 对话框类 handler 在 WebUI 模式下无法弹出原生窗口，直接返回 null
    const dialogHandlers = new Set([
      'selectFolder', 'selectImageFile', 'selectAudioFile', 'selectMusicFolder', 'selectSkillFile',
    ])
    if (dialogHandlers.has(method)) {
      sendJson(res, 200, { result: null })
      return
    }

    // confirmDialog 在浏览器端由 window.confirm 处理，不走服务端
    if (method === 'confirmDialog') {
      sendJson(res, 200, { result: true })
      return
    }

    // openExternal 在浏览器端由 window.open 处理，不走服务端
    if (method === 'openExternal') {
      sendJson(res, 200, { result: null })
      return
    }

    const handler = handlerRegistry.get(method)
    if (!handler) {
      sendJson(res, 404, { error: `Unknown method: ${method}` })
      return
    }

    // handler 签名是 (event, ...args)，WebUI 传 null 作为 event
    const result = await handler(null, ...args)
    sendJson(res, 200, { result: result === undefined ? null : result })
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}

// ── /api/chat-stream：SSE 流式对话 ──
async function handleChatStream(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req, 10 * 1024 * 1024)
  if (body === null) {
    sendJson(res, 413, { error: 'Request body too large' })
    return
  }

  try {
    const { cfg, body: chatBody } = JSON.parse(body) as { cfg: unknown; body: unknown }

    if (!startChatStreamFn) {
      sendJson(res, 503, { error: 'Streaming not available' })
      return
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // SSE 响应头，requestId 通过 header 传回前端
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Request-Id': requestId,
    })

    // 启动流式对话，分片通过 SSE 推回；收到 done/error 终止信号后关闭连接
    startChatStreamFn(cfg, chatBody, requestId, (payload) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ requestId, ...payload })}\n\n`)
      }
      if (payload.done === true || typeof payload.error === 'string') {
        if (!res.writableEnded) res.end()
      }
    })

    // 客户端断开时中止上游请求
    req.on('close', () => {
      abortChatStreamFn?.(requestId)
    })
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
  }
}

// ── 静态文件服务 ──
function getDistDir(): string {
  if (app.isPackaged) {
    return path.join(app.getAppPath(), 'dist')
  }
  return path.join(process.cwd(), 'dist')
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  const distDir = getDistDir()
  // 解码 URL 编码的路径
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }

  let filePath = path.join(distDir, decodedPath === '/' ? 'index.html' : decodedPath)

  // 浏览器默认请求 /favicon.ico：复用应用图标（public/icon.png → dist/icon.png）
  if (decodedPath === '/favicon.ico') {
    filePath = path.join(distDir, 'icon.png')
  }

  // 防止路径遍历
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(path.resolve(distDir))) {
    res.writeHead(403)
    res.end()
    return
  }

  // 文件不存在或是目录 → SPA fallback 到 index.html
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    filePath = path.join(distDir, 'index.html')
  }

  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'

  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}

// ── 开发模式：代理到 Vite dev server ──
function proxyToVite(req: http.IncomingMessage, res: http.ServerResponse): void {
  const viteUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5175'
  const parsed = new URL(viteUrl)

  const options: http.RequestOptions = {
    hostname: parsed.hostname,
    port: parsed.port || 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: parsed.host },
  }

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
    proxyRes.pipe(res)
  })
  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Vite dev server not available')
  })
  req.pipe(proxyReq)
}

// ── 工具函数 ──
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxBytes) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', () => resolve(null))
  })
}
