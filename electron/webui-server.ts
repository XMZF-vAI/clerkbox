import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import * as os from 'os'
import * as dgram from 'dgram'
import { isIPv4 } from 'net'
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

// ── 远程能力黑名单 ──
// 威胁模型：WebUI token 会出现在 URL / HTTP 请求中，可能被局域网嗅探、浏览器
// 历史或代理日志泄漏。token 一旦泄漏，攻击者不应能借此直接获得 RCE 或窃取密钥。
// 因此凡涉及「读取/写入凭据、执行命令、伪终端、按配置拉起子进程、整目录写删技能」
// 的 handler 一律拒绝通过 /api/invoke 远程调用（403）。
// 本地 Electron 渲染层不受影响：它走 ipcRenderer.invoke，不经过该注册表。
// 说明：ptyWrite 实际不存在，输入通道叫 ptyInput，且 ptyInput / ptyResize 注册在
// ipcMain.on 上（本就不在 handlerRegistry 中），这里一并列入以防实现变化；
// executeCommandWithShell / cancelSessionCommands / mcpTest 与 executeCommand /
// mcpSync 同属命令执行、进程控制与按配置拉起子进程的范畴，一并禁止。
export const REMOTE_INVOKE_BLOCKLIST: readonly string[] = [
  // 凭据 / API Key
  'loadApiKeys',
  'saveApiKey',
  'removeApiKey',
  // 命令执行与进程控制
  'executeCommand',
  'executeCommandWithShell',
  'cancelSessionCommands',
  // 文件删除（改动回滚收掉本轮新建的文件）：按调用方给定的路径删本机文件，
  // 与 executeCommand 同档危险，不对远程暴露。
  'deleteFile',
  // 伪终端（node-pty）
  'ptyCreate',
  'ptyWrite',
  'ptyInput',
  'ptyResize',
  'ptyKill',
  // MCP：按用户配置连接 / 拉起子进程
  'mcpSync',
  'mcpTest',
  // 技能目录整目录写入 / 删除
  'writeSkillDir',
  'removeSkillDir',
  // Agent 宿主通道：ipcMain.handle 被 monkey-patch 自动同步进 handlerRegistry（见 main.ts
  // 的 patchedHandle），所以 agent:* 从 /api/invoke 天然可达。这里按能力划线：
  // - agent:command 是 ReAct 编排总入口，拿到它等于「以用户身份驱动本机 agent」（等同 RCE），
  //   且其中的 permission.resolve 能替本地用户批准危险操作。进黑名单是第一道门；
  //   remoteAgentCommandAllowed（回环之外需显式开 CLERKBOX_WEBUI_ALLOW_REMOTE_RUN）是第二道。
  //   两道都要留：环境变量是用户可选项，黑名单不是。
  // - agent:snapshot 回吐 500 条事件环，内含完整消息内容与待批命令预览。远程视图本来就走
  //   /api/agent/events（SSE，带 seq 去重），snapshot 在远程既多余又泄漏，故禁。
  // - agent:host-mode 是唯一刻意放行的 agent 通道：只返回一个 'main' | 'renderer' 字符串，
  //   零副作用零数据；WebUI 侧靠它判断该连宿主还是本地自跑
  //   （agent-client.ts 的 transport.mode().catch(() => 'renderer')）。拦掉它会让远程视图
  //   误判成渲染层模式，转而要求本地持有 API Key——Key 从不下发远程，结果就是
  //   「客户端有 Key 却报缺 Key」。tests/webui-blocklist.test.ts 已把这条例外锁住。
  'agent:command',
  'agent:snapshot',
  // WebUI 自身的控制面：startWebUI 的 lanAccess=true 会把服务从 127.0.0.1 改绑 0.0.0.0，
  // 远程持 token 者可用它把暴露面从本机放大到整个局域网；getLanAddresses 则泄露内网 IP，
  // 为横向探测提供起点。三者都是「管理 WebUI 自己」，远程调用无正当场景。
  'startWebUI',
  'stopWebUI',
  'getLanAddresses',
  // 诊断导出（弹保存对话框属桌面端交互，远程调用无意义）
  'diagExport',
  // 消息撤回 / 改动回滚：ckpt* 三个通道能按调用方给定的名字往本机写文件，
  // dbDeleteMessagesFrom / dbPatchMessage 能截断与改写任意消息行。
  // 远程视图本来就不能跑 agent（agent:command 在黑名单），也就永远不会产生或消费快照，
  // 全部拒绝对远程暴露；本地 Electron 渲染层走 ipcRenderer，不受影响。
  'ckptPut',
  'ckptGet',
  'ckptRemove',
  'ckptRemoveSession',
  'dbDeleteMessagesFrom',
  'dbPatchMessage',
  // Agent 动作通道：agentBrowser:command 能让远程调用方驱动本机 Agent 浏览器
  // （导航任意 http(s)、点页面、填表单），computerUse:command 更进一步——它合成的是
  // 用户真实桌面上的鼠标键盘事件，能在任何应用里点击、输入、启动程序。
  // agentBrowser:ensurePanel 会让渲染层弹出并展开 Agent 浏览器标签，同样不该对远程开放。
  // 三者都属于「以用户身份操作这台机器」，与 executeCommand 同档，且没有任何正当的远程调用场景。
  'agentBrowser:command',
  'agentBrowser:ensurePanel',
  'computerUse:command',
  // computerUse:endControl 会把本机「正在操控你的电脑」浮块撤下来。
  // 看着无害，但它证明远端能指挥本机桌面能力的状态机 —— 与 command 同档，一并挡掉。
  'computerUse:endControl',
  // Git 集成（编程模式）：写通道（switch/create/stage/commit/push）能改动本机仓库、
  // push 更会把内容推到远端；读通道（status/diff/branches/graph/identity）吐出的
  // status 与 diff 就是本机源码正文。远程视图隐藏 Git 面板（workbench tab desktopOnly），
  // 这里整组拦住兜底，与「远程不跑 agent（agent:command 在列）」同一条防线。
  'gitGetStatus',
  'gitGetDiff',
  'gitGetBranches',
  'gitSwitchBranch',
  'gitCreateBranchAndSwitch',
  'gitGetCommitGraph',
  'gitStagePaths',
  'gitCommit',
  'gitPush',
  'gitGetIdentity',
]

/**
 * 受双重门控的宿主命令通道：传输层看地址（remoteAgentCommandAllowed），
 * 策略层看命令类型（见 electron/agent-host.ts 的远程规则：不带凭据、审批只认本地窗口）。
 */
export const REMOTE_AGENT_GATED_CHANNELS: readonly string[] = ['agent:command']

/**
 * 远程触发宿主运行的边界。默认只有回环地址（本机浏览器）能把 run / queue / abort 这类
 * 命令发进宿主；局域网或公网设备要开，需显式设置 CLERKBOX_WEBUI_ALLOW_REMOTE_RUN=1。
 * 理由：token 出现在 URL 与 HTTP 头里，泄漏面比本地窗口大得多，而 run 命令等于
 * 「以用户身份驱动本机 agent」。
 *
 * 现状提醒：agent:command 目前同时留在 REMOTE_INVOKE_BLOCKLIST 里，于是这道地址门
 * **走不到**（黑名单在前），CLERKBOX_WEBUI_ALLOW_REMOTE_RUN 因此暂时不生效。
 * 「远程能不能触发运行」是老板要拍的策略题，两扇门只留一扇由他定；在此之前别假装 env 有效。
 */
export function remoteAgentCommandAllowed(address: string | undefined): boolean {
  if (isLoopbackAddress(address)) return true
  return process.env.CLERKBOX_WEBUI_ALLOW_REMOTE_RUN === '1'
}

// ── /api/agent/events：宿主事件流的远程订阅通道（SSE）──
const agentEventClients = new Set<http.ServerResponse>()
/** 由 main.ts 注入：把 sinceSeq 之后的事件重新广播一遍（只进 SSE，不进 HTTP 响应） */
let agentEventReplayFn: ((sinceSeq: number, sessionId?: string) => void) | null = null

export function setAgentEventBridge(hooks: { replay: (sinceSeq: number, sessionId?: string) => void }): void {
  agentEventReplayFn = hooks.replay
}

/** /api/agent/resync 请求体解析：形状不对回 null，sinceSeq 归一到非负整数 */
export function parseAgentResyncBody(raw: unknown): { sessionId?: string; sinceSeq: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as { sessionId?: unknown; sinceSeq?: unknown }
  const sinceSeq =
    typeof body.sinceSeq === 'number' && Number.isFinite(body.sinceSeq) ? Math.max(0, Math.floor(body.sinceSeq)) : 0
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined
  return { sessionId, sinceSeq }
}

/** 宿主每次广播事件时同步推给远程订阅者；无订阅时零开销 */
export function pushAgentEvent(payload: { seq: number; event: unknown }): void {
  if (agentEventClients.size === 0) return
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of agentEventClients) {
    if (!res.writableEnded) res.write(frame)
  }
}

function handleAgentEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })
  res.write(': open\n\n')
  agentEventClients.add(res)
  // 心跳：反代与浏览器会掐掉长时间零字节的连接
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 25_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    agentEventClients.delete(res)
  })
  // 补发整环：seq 去重与乱序整理在渲染层薄客户端里已有，重复回放是安全的
  agentEventReplayFn?.(0)
}

/**
 * 缺口补发的触发器：薄客户端检出 seq 跳号时调它取回漏掉的事件。
 *
 * 刻意**不回任何事件数据**：宿主 snapshot 的产物只经已鉴权的 SSE 广播出去，HTTP 响应固定
 * 是 {ok:true}。否则等于把 500 条事件环（含完整消息内容与待批命令预览）做成一个可拉取的
 * API——那正是 agent:snapshot 留在远程黑名单里的理由。触发与投递分道，两边都拿到所需，
 * 泄漏面一点没加。
 */
async function handleAgentResync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req, 64 * 1024)
  if (body === null) {
    sendJson(res, 413, { error: 'Request body too large' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    sendJson(res, 400, { error: 'Invalid request format' })
    return
  }
  const input = parseAgentResyncBody(parsed)
  if (!input) {
    sendJson(res, 400, { error: 'Invalid request format' })
    return
  }
  agentEventReplayFn?.(input.sinceSeq, input.sessionId)
  sendJson(res, 200, { result: { ok: true } })
}

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

/** 探测目标：UDP socket connect() 时不会真正发包，但内核会依据路由表
 *  把“本机出口 IP”绑到该 socket 上 — 借此读出真正用于上网的 IPv4 地址。
 * 同时使用 Google DNS（8.8.8.8）和阿里云 DNS（223.5.5.5）做冗余探测，
 * 国内网络可能屏蔽其中一个，另一个仍能给出正确出口。 */
const UDP_PROBES: ReadonlyArray<{ host: string; port: number }> = [
  { host: '223.5.5.5', port: 53 },
  { host: '8.8.8.8', port: 53 },
]

/** 通过 UDP socket 探测本机出口 IP（最多取第一可用结果），超时 800ms。 */
function probeLocalIpViaUdp(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ip: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ip)
    }
    // 安全超时：connect() 通常瞬时返回，写一个 hard timeout 兜底
    const timer = setTimeout(() => finish(null), 800)
    // 顺序探测，单个目标失败（error / 非 IPv4）继续尝试下一个；都失败则返回 null
    let idx = 0
    const tryNext = (): void => {
      if (settled) return
      const target = UDP_PROBES[idx++]
      if (!target) {
        finish(null)
        return
      }
      // 每个目标用全新 socket：error 之后的旧 socket 状态不可复用
      const socket = dgram.createSocket('udp4')
      const done = (ip: string | null) => {
        try { socket.close() } catch { /* ignore */ }
        if (ip) finish(ip)
        else tryNext()
      }
      socket.once('error', () => done(null))
      try {
        socket.connect(target.port, target.host, () => {
          const addr = socket.address()
          const ip = typeof addr === 'object' && addr && 'address' in addr ? (addr as { address: string }).address : ''
          // IPv4 only；若拿到 :: 形式跳过
          done(ip && isIPv4(ip) ? ip : null)
        })
      } catch {
        done(null)
      }
    }
    tryNext()
  })
}

/** 枚举本机非内部 IPv4 地址，按可用性排序；优先使用 UDP 探测法选出口 IP。 */
export async function getLanAddresses(): Promise<string[]> {
  // 1) 首选：UDP 探测得到真实上网出口，绕开 Hyper-V / WSL / Docker 等虚拟交换机
  let probed: string | null = null
  try {
    probed = await probeLocalIpViaUdp()
  } catch {
    probed = null
  }

  // 2) 兜底：枚举系统所有网卡，剔除回环/链路本地/VPN 段，按 RFC1918 排序
  const fallback: string[] = []
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (/^169\.254\./.test(addr.address) || /^198\.(18|19)\./.test(addr.address)) continue
      fallback.push(addr.address)
    }
  }
  // 真实局域网网段优先（RFC1918），其余排在后面兜底
  const isPrivate = (ip: string) =>
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  fallback.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)))

  if (probed && isPrivate(probed)) return [probed, ...fallback.filter((x) => x !== probed)]
  if (probed) return [probed, ...fallback]
  return fallback
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
    // 立即掐断所有 keep-alive 长连接：否则 server.close() 要等挂起连接自然结束，
    // 端口释放被拖延（closeAllConnections 为 Node 18.2+ API，旧环境忽略）
    try {
      server.closeAllConnections()
    } catch {
      // 旧版 Node 无该方法时忽略
    }
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
    // API 端点仅接受 x-webui-token header：前端从 URL ?token= 提取后已改用 header
    // 发送，API 不再回退接受 query token，避免带 token 的完整 URL 进入访问日志 /
    // 浏览器历史后被长期重放（静态页面首次加载仍可经 query 带入 token）
    const token = (req.headers['x-webui-token'] as string) || ''
    if (!tokenMatches(token)) {
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
    if (url.pathname === '/api/agent/events' && req.method === 'GET') {
      handleAgentEvents(req, res)
      return
    }
    if (url.pathname === '/api/agent/resync' && req.method === 'POST') {
      void handleAgentResync(req, res)
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
    void serveStatic(req, res, url.pathname)
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

/**
 * token 恒定时间比对（纯函数，导出以便单测）。
 * 普通 !== 会在首个不同字节处提前返回，理论上可被时序侧信道逐字节爆破；token 是这条
 * 链路上唯一的凭据，比对方式不该泄露前缀信息。长度不等先短路（timingSafeEqual 要求
 * 等长入参，且长度不是秘密——固定 64 位 hex）；expected 为空同样短路，保证 fail-closed：
 * stopWebUI 清空 currentToken 后不能让「不带 token 头」的请求蒙混过关。
 */
export function safeTokenEquals(candidate: string, expected: string): boolean {
  if (!expected || candidate.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}

function tokenMatches(candidate: string): boolean {
  return safeTokenEquals(candidate, currentToken)
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

    // 远程能力黑名单：涉密钥 / 命令 / 伪终端 / 进程配置的 handler 一律 403
    //（见 REMOTE_INVOKE_BLOCKLIST 处的威胁模型说明）
    if (REMOTE_INVOKE_BLOCKLIST.includes(method)) {
      sendJson(res, 403, { error: 'Forbidden method' })
      return
    }

    // 宿主命令通道：默认只允许本机回环触发（远程视图本身走 agent:snapshot + SSE，不受影响）
    if (REMOTE_AGENT_GATED_CHANNELS.includes(method) && !remoteAgentCommandAllowed(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'Remote agent run is disabled; enable it with CLERKBOX_WEBUI_ALLOW_REMOTE_RUN=1' })
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

async function serveStatic(_req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
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

  const distRoot = path.resolve(distDir)
  let filePath = path.join(distRoot, decodedPath === '/' ? 'index.html' : decodedPath)

  // 浏览器默认请求 /favicon.ico：复用应用图标（public/icon.png → dist/icon.png）
  if (decodedPath === '/favicon.ico') {
    filePath = path.join(distRoot, 'icon.png')
  }

  // 防止路径遍历。简单的 startsWith 会把 dist-other 误判为 dist 子目录，
  // 使用 path.relative 同时覆盖 Windows 分隔符和大小写规则。
  const resolved = path.resolve(filePath)
  const relative = path.relative(distRoot, resolved)
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    res.writeHead(403)
    res.end()
    return
  }

  // 文件不存在或是目录 → SPA fallback 到 index.html。异步 stat/read 避免
  // WebUI 请求静态资源时同步 I/O 阻塞聊天 SSE 和其他 API。
  try {
    const stats = await fs.promises.stat(resolved)
    if (stats.isDirectory()) filePath = path.join(distRoot, 'index.html')
  } catch {
    filePath = path.join(distRoot, 'index.html')
  }

  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'

  try {
    const content = await fs.promises.readFile(filePath)
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
