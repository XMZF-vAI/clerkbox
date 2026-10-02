import type {
  AccountStatus,
  AccountSyncDownloadResult,
  AccountSyncKind,
  AccountSyncResultItem,
  AgentMemoryCaptureInput,
  AgentMemoryContext,
  AgentMemoryMigrationResult,
  AgentMemorySearchResult,
  AgentMemoryStatus,
  ApiChunkPayload,
  ApiConnConfig,
  FetchedModel,
  FileEntry,
  GitBranchListResult,
  GitBranchMutationResult,
  GitCommitGraphResult,
  GitCommitResult,
  GitDiffResult,
  GitDiffSource,
  GitIdentity,
  GitPushResult,
  GitStatusResult,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
  McpMarketServer,
  MessageRow,
  ParseSkillFileResult,
  SessionRow,
  SyncPassphraseStatus,
  SystemMediaState,
  TrayConfig,
  TrayLabels,
  UpdaterState,
  VibeGlassTrack,
  VibeMediaCommand,
  WebUICapabilities,
  WebUIUploadResult,
} from '../types/ipc'
import type { MemoryEntry } from '../types/agent'
import type { AgentCommand, AgentCommandResult, AgentEvent, AgentSnapshot } from '../agent-core/protocol'

/**
 * 统一 IPC 客户端：双模式运行。
 *
 * - Electron 模式：window.clerkbox 由 preload 注入，直接走 ipcRenderer.invoke
 * - WebUI 模式：浏览器中无 window.clerkbox，改走 HTTP（/api/invoke + /api/chat-stream SSE）
 *
 * 上层业务代码（stores / hooks / api-transport）对两种模式完全无感知，
 * 因为它们只依赖本模块导出的 ipc 对象。
 */

// ── 模式检测 ──
const isElectron = typeof window !== 'undefined' && !!window.clerkbox

// ── WebUI token：从 URL ?token=xxx 提取，随每个 API 请求发送 ──
let webuiToken = ''
if (!isElectron && typeof window !== 'undefined') {
  const params = new URLSearchParams(window.location.search)
  webuiToken = params.get('token') || ''
  // 存入 sessionStorage，刷新页面后仍可复用（SPA 路由切换不丢）
  if (webuiToken) sessionStorage.setItem('clerkbox-webui-token', webuiToken)
  else webuiToken = sessionStorage.getItem('clerkbox-webui-token') || ''
  // 从地址栏抹掉 token（sessionStorage 已留存）：减少链接被复制、
  // 浏览器历史/服务器日志记录 token 的泄漏面。仅首次携带时执行一次。
  if (params.get('token')) {
    params.delete('token')
    const qs = params.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
  }
}

/** WebUI 模式下判断当前是否为 WebUI 环境（供 UI 层隐藏窗口控制按钮等） */
export const isWebUIMode = !isElectron

// ── 宿主模式（批次 B P3）：运行在 Electron 主进程内，复用同一套调用面 ──
// agent-host 启动时注入实现，使 tool-registry / compact 等既有代码无需改动即可在
// 主进程执行：invoke 直调 handlerRegistry（WebUI 的 /api/invoke 已验证该路径可行），
// 流式直调 api-proxy.startChatStream（零 IPC 往返）。
// 注意：宿主内 isElectron 恒为 false，故 isWebUIMode 亦为 true——其消费方全部是渲染层
// 组件，主进程不会求值；本模块内的分支一律先判 hostBridge。
export interface IpcHostBridge {
  invoke<T>(method: string, args: unknown[]): Promise<T>
  /** 由宿主调用 api-proxy.startChatStream，分片经 emit 回灌 chunkListeners */
  startChatStream(
    cfg: ApiConnConfig,
    body: unknown,
    requestId: string,
    emit: (payload: ApiChunkPayload) => void
  ): void
  abortChatStream(requestId: string): void
}

let hostBridge: IpcHostBridge | null = null

export function setIpcHostBridge(bridge: IpcHostBridge | null): void {
  hostBridge = bridge
}

/** 当前是否运行在宿主（主进程 agent-host）内 */
export const isHostMode = (): boolean => hostBridge !== null

// ── WebUI HTTP 调用封装 ──
async function webInvoke<T>(method: string, args: unknown[] = []): Promise<T> {
  if (hostBridge) return hostBridge.invoke<T>(method, args)
  const res = await fetch('/api/invoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WebUI-Token': webuiToken,
    },
    body: JSON.stringify({ method, args }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebUI invoke failed (${res.status}): ${text}`)
  }
  const json = await res.json()
  if (json.error) throw new Error(json.error)
  return json.result as T
}

async function webGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { 'X-WebUI-Token': webuiToken },
  })
  if (!res.ok) throw new Error(`WebUI GET failed (${res.status})`)
  const json = await res.json()
  return json.result as T
}

async function webUploadFile(file: File): Promise<WebUIUploadResult> {
  const query = `?name=${encodeURIComponent(file.name || 'upload.bin')}`
  const res = await fetch(`/api/upload${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-WebUI-Token': webuiToken,
    },
    body: file,
  })
  const json = await res.json().catch(() => ({})) as { result?: WebUIUploadResult; error?: string }
  if (!res.ok || json.error || !json.result) {
    throw new Error(json.error || `WebUI upload failed (${res.status})`)
  }
  return json.result
}

const FALLBACK_WEBUI_UPLOAD_BYTES = 10 * 1024 * 1024

async function browserFileWithinUploadLimit(file: File): Promise<boolean> {
  const capabilities = await webGet<WebUICapabilities>('/api/capabilities').catch(() => null)
  const limit = capabilities?.maxUploadBytes || FALLBACK_WEBUI_UPLOAD_BYTES
  if (file.size <= limit) return true
  window.alert(`File too large. Maximum is ${Math.round(limit / (1024 * 1024))} MB.`)
  return false
}

/** Open a browser file picker synchronously from the user gesture. */
function webPickFiles(options: { accept?: string; multiple?: boolean }): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple === true
    if (options.accept) input.accept = options.accept
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    input.style.opacity = '0'
    const cleanup = () => {
      input.remove()
      input.onchange = null
      input.oncancel = null
    }
    input.onchange = () => {
      const files = Array.from(input.files || [])
      cleanup()
      resolve(files.length > 0 ? files : null)
    }
    input.oncancel = () => {
      cleanup()
      resolve(null)
    }
    document.body.appendChild(input)
    input.click()
  })
}

function readBrowserFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Failed to read browser file'))
    reader.readAsDataURL(file)
  })
}

async function webPickDataUrl(accept: string): Promise<string | null> {
  const files = await webPickFiles({ accept })
  if (!files?.[0]) return null
  if (!(await browserFileWithinUploadLimit(files[0]))) return null
  return readBrowserFileAsDataUrl(files[0])
}

async function webPickUploadedFiles(options: { accept?: string; multiple?: boolean }): Promise<string[] | null> {
  const files = await webPickFiles(options)
  if (!files) return null
  const paths: string[] = []
  for (const file of files) {
    if (!(await browserFileWithinUploadLimit(file))) continue
    paths.push((await webUploadFile(file)).path)
  }
  return paths
}

let webuiCapabilitiesPromise: Promise<WebUICapabilities> | null = null

// ── WebUI 流式对话：SSE 桥接到 onApiChunk 回调模式 ──
// 与 Electron 的 apiChunk 事件语义对齐，api-transport.ts 无需改动。
type ChunkCallback = (payload: ApiChunkPayload) => void
const chunkListeners = new Set<ChunkCallback>()

/** 在途 SSE 请求：requestId → AbortController（用于 apiAbort） */
const sseControllers = new Map<string, AbortController>()

/**
 * 宿主内流式：与 webChatStream 共用 chunkListeners 派发面，但既不经 IPC 也不经 HTTP。
 * 消费端（api-transport / compact）看到的 requestId + apiChunk 语义与 Electron 模式一致。
 */
async function hostChatStream(cfg: ApiConnConfig, body: unknown): Promise<{ requestId: string }> {
  const bridge = hostBridge
  if (!bridge) throw new Error('ipc: host bridge not installed')
  const requestId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  bridge.startChatStream(cfg, body, requestId, (payload) => {
    for (const cb of chunkListeners) cb(payload)
  })
  return { requestId }
}

async function webChatStream(cfg: ApiConnConfig, body: unknown): Promise<{ requestId: string }> {
  const res = await fetch('/api/chat-stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WebUI-Token': webuiToken,
    },
    body: JSON.stringify({ cfg, body }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebUI chat-stream failed (${res.status}): ${text}`)
  }

  const requestId = res.headers.get('X-Request-Id') || `req-${Date.now()}`
  const ac = new AbortController()
  sseControllers.set(requestId, ac)

  // 后台读取 SSE 流，分片派发给所有 chunkListeners
  void (async () => {
    try {
      const reader = res.body?.getReader()
      if (!reader) {
        for (const cb of chunkListeners) cb({ requestId, error: 'WebUI: response body is empty' })
        return
      }
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (ac.signal.aborted) { await reader.cancel(); break }
        buffer += decoder.decode(value, { stream: true })
        // SSE 以 \n\n 分隔事件
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''
        for (const event of events) {
          const dataLine = event.split('\n').find((l) => l.startsWith('data: '))
          if (!dataLine) continue
          try {
            const payload = JSON.parse(dataLine.slice(6)) as ApiChunkPayload
            for (const cb of chunkListeners) cb(payload)
          } catch { /* 忽略解析失败的分片 */ }
        }
      }
      // 读到流末尾仍需兜底派发 done：服务端若未发 done 事件就提前关闭（网络断、
      // 反向代理超时），消费端的 for-await 会永远等待，agent 循环挂死。
      // 重复 done 无害：消费端收到第一个 done 即返回。
      for (const cb of chunkListeners) cb({ requestId, done: true })
    } catch (e) {
      if (ac.signal.aborted) {
        // 用户主动中断：派发 done 让迭代器静默退出
        for (const cb of chunkListeners) cb({ requestId, done: true })
      } else {
        // 连接中断等异常：派发 error 让消费端抛出、reactLoop 走错误分支，而不是永久挂起
        const msg = e instanceof Error ? e.message : String(e)
        for (const cb of chunkListeners) cb({ requestId, error: `WebUI stream interrupted: ${msg}` })
      }
    } finally {
      sseControllers.delete(requestId)
    }
  })()

  return { requestId }
}

function webAbort(requestId: string): void {
  sseControllers.get(requestId)?.abort()
  sseControllers.delete(requestId)
}

// ── 宿主事件流的 WebUI 订阅通道（批次 B · P5）──
/** 重连退避上限 */
const AGENT_STREAM_BACKOFF_MAX_MS = 10_000

/**
 * 用 fetch + ReadableStream 而不是 EventSource：token 只允许出现在请求头里
 * （见 webui-server 的威胁模型注释），而 EventSource 没有自定义 header 的能力。
 * 服务端在新连接建立时补发整环，所以断线重连不丢事件；seq 去重、乱序整理与缺口补发
 * 都由 agent-client 的游标闸门负责，这里只负责把帧交出去。
 */
function openAgentEventStream(callback: (payload: { seq: number; event: AgentEvent }) => void): () => void {
  // 主进程内的宿主自己就是事件源，不需要回环订阅
  if (hostBridge) return () => {}

  let closed = false
  let attempt = 0
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const emitFrame = (frame: string): void => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw) continue
      try {
        const payload = JSON.parse(raw) as { seq: number; event: AgentEvent }
        if (typeof payload.seq !== 'number' || !payload.event) continue
        attempt = 0
        callback(payload)
      } catch {
        /* 半帧或心跳注释：忽略 */
      }
    }
  }

  const scheduleReconnect = (): void => {
    if (timer || closed) return
    const delay = Math.min(1000 * 2 ** attempt, AGENT_STREAM_BACKOFF_MAX_MS)
    attempt += 1
    timer = setTimeout(() => {
      timer = null
      void readStream()
    }, delay)
  }

  const readStream = async (): Promise<void> => {
    controller = new AbortController()
    try {
      const res = await fetch('/api/agent/events', {
        headers: { 'X-WebUI-Token': webuiToken, Accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`agent events failed (${res.status})`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const sep = buffer.indexOf('\n\n')
          if (sep < 0) break
          emitFrame(buffer.slice(0, sep))
          buffer = buffer.slice(sep + 2)
        }
      }
    } catch (err) {
      if (closed) return
      console.warn('[ipc] 宿主事件流中断，退避重连：', err instanceof Error ? err.message : err)
    }
    if (closed) return
    // 连接结束（服务端重启、代理掐连、网络抖动）后重开，重开即触发补发
    scheduleReconnect()
  }

  void readStream()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    controller?.abort()
  }
}

/**
 * 缺口补发（批次 B · P5）。
 *
 * WebUI 侧走 POST /api/agent/resync 这个**触发器**：宿主把 sinceSeq 之后的事件重新广播一遍，
 * 数据只经已鉴权的 SSE 回来，HTTP 响应固定 {ok:true}。远程拉取 agent:snapshot 会直接把 500 条
 * 事件环（含完整消息与待批命令预览）做成可读取的 API，所以那条通道留在黑名单里。
 * 薄客户端只 await 成/败并靠事件本身推进 seq 游标，因此这里的返回值是占位形状。
 */
async function requestAgentResync(sessionId: string | undefined, sinceSeq: number): Promise<AgentSnapshot> {
  if (hostBridge) return hostBridge.invoke<AgentSnapshot>('agent:snapshot', [sessionId, sinceSeq])
  const res = await fetch('/api/agent/resync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WebUI-Token': webuiToken,
    },
    body: JSON.stringify({ sessionId, sinceSeq }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`WebUI resync failed (${res.status}): ${text}`)
  }
  return { activeRuns: [], queue: {}, pendingPermissions: [], lastSeq: sinceSeq }
}

// ── 统一 ipc 对象 ──
// Electron 模式直接委托 window.clerkbox；WebUI 模式走 HTTP。
export const ipc = {
  getWebUICapabilities: (): Promise<WebUICapabilities> => {
    if (isElectron) {
      return Promise.resolve({
        isRemoteClient: false,
        canUpload: false,
        canBrowseHostFolders: false,
        maxUploadBytes: 10 * 1024 * 1024,
      })
    }
    if (!webuiCapabilitiesPromise) {
      webuiCapabilitiesPromise = webGet<WebUICapabilities>('/api/capabilities')
    }
    return webuiCapabilitiesPromise
  },
  uploadWebUIFile: (file: File): Promise<WebUIUploadResult> =>
    isElectron ? Promise.reject(new Error('WebUI upload is only available in a browser')) : webUploadFile(file),
  // 文件对话框：WebUI 模式无法弹出原生对话框，返回 null（UI 层降级为手动输入路径）
  selectFolder: (): Promise<string | null> =>
    isElectron ? window.clerkbox.selectFolder() : Promise.resolve(null),
  selectImageFile: (): Promise<string | null> =>
    isElectron
      ? window.clerkbox.selectImageFile()
      : webPickDataUrl('image/*'),
  // 对话附件多选：WebUI 模式无法弹出原生对话框，返回 null（UI 层降级为手动输入路径）
  selectChatFiles: (): Promise<string[] | null> =>
    isElectron ? window.clerkbox.selectChatFiles() : webPickUploadedFiles({ multiple: true }),
  // 按磁盘路径读图片为 base64 data URL（渲染进程无法直接读本地文件）
  readImageFileBase64: (path: string): Promise<string> =>
    isElectron ? window.clerkbox.readImageFileBase64(path) : webInvoke('readImageFileBase64', [path]),
  readFileBase64: (path: string): Promise<{ data: string; mimeType: string; size: number }> =>
    isElectron ? window.clerkbox.readFileBase64(path) : webInvoke('readFileBase64', [path]),
  selectAudioFile: (): Promise<string | null> =>
    isElectron
      ? window.clerkbox.selectAudioFile()
      : webPickDataUrl('audio/*'),
  selectMusicFolder: (): Promise<string | null> =>
    isElectron ? window.clerkbox.selectMusicFolder() : Promise.resolve(null),
  selectSkillFile: (): Promise<string | null> =>
    isElectron
      ? window.clerkbox.selectSkillFile()
      : webPickUploadedFiles({ accept: '.skill,.zip,application/zip' }).then((paths) => paths?.[0] || null),

  parseSkillFile: (filePath: string): Promise<ParseSkillFileResult> =>
    isElectron ? window.clerkbox.parseSkillFile(filePath) : webInvoke('parseSkillFile', [filePath]),
  fileExists: (path: string): Promise<boolean> =>
    isElectron ? window.clerkbox.fileExists(path) : webInvoke('fileExists', [path]),
  // 取 File 的真实磁盘路径：仅 Electron 模式可用（浏览器拿不到本地路径，返回空串）
  getPathForFile: (file: File): string =>
    isElectron ? window.clerkbox.getPathForFile(file) : '',
  openExternal: (url: string): Promise<void> =>
    isElectron ? window.clerkbox.openExternal(url) : (window.open(url, '_blank'), Promise.resolve()),
  confirmDialog: (title: string, message: string): Promise<boolean> =>
    isElectron ? window.clerkbox.confirmDialog(title, message) : Promise.resolve(window.confirm(`${title}\n\n${message}`)),
  // WebUI 是浏览器页面，没有能力弹三选项的原生框。恒返回 -1（取消）而不是伪造一个
  // window.confirm 的 Yes/No：宁可让 Agent 动作在远程视图里用不了，也不要给用户
  // 一个「我以为选的是始终允许、其实是允许一次」的两按钮框
  confirmDialogWithOptions: (payload: { title: string; message: string; buttons: string[]; defaultIndex: number }): Promise<number> =>
    isElectron ? window.clerkbox.confirmDialogWithOptions(payload) : Promise.resolve(-1),
  readFile: (path: string): Promise<string> =>
    isElectron ? window.clerkbox.readFile(path) : webInvoke('readFile', [path]),
  writeFile: (path: string, content: string): Promise<void> =>
    isElectron ? window.clerkbox.writeFile(path, content) : webInvoke('writeFile', [path, content]),
  deleteFile: (path: string): Promise<void> =>
    isElectron ? window.clerkbox.deleteFile(path) : webInvoke('deleteFile', [path]),
  listDir: (path: string): Promise<FileEntry[]> =>
    isElectron ? window.clerkbox.listDir(path) : webInvoke('listDir', [path]),
  executeCommand: (command: string, cwd?: string, sessionId?: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean; timedOut?: boolean }> =>
    isElectron ? window.clerkbox.executeCommand(command, cwd, sessionId, timeoutMs) : webInvoke('executeCommand', [command, cwd, sessionId, timeoutMs]),
  executeCommandWithShell: (command: string, cwd: string | undefined, shellType: string, sessionId?: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean; timedOut?: boolean }> =>
    isElectron ? window.clerkbox.executeCommandWithShell(command, cwd, shellType, sessionId, timeoutMs) : webInvoke('executeCommandWithShell', [command, cwd, shellType, sessionId, timeoutMs]),
  cancelSessionCommands: (sessionId: string): Promise<{ killed: number }> =>
    isElectron ? window.clerkbox.cancelSessionCommands(sessionId) : webInvoke('cancelSessionCommands', [sessionId]),
  webSearch: (query: string, count?: number): Promise<Array<{ title: string; snippet: string; url: string }> | { error: string }> =>
    isElectron ? window.clerkbox.webSearch(query, count) : webInvoke('webSearch', [query, count]),
  webFetch: (url: string, maxLength?: number): Promise<{ content: string; url: string } | { error: string }> =>
    isElectron ? window.clerkbox.webFetch(url, maxLength) : webInvoke('webFetch', [url, maxLength]),

  // 模型 API 代理
  apiFetchModels: (cfg: ApiConnConfig): Promise<{ models: FetchedModel[] } | { error: string }> =>
    isElectron ? window.clerkbox.apiFetchModels(cfg) : webInvoke('apiFetchModels', [cfg]),
  apiTestConnection: (cfg: ApiConnConfig): Promise<{ ok: true; latencyMs: number } | { error: string }> =>
    isElectron ? window.clerkbox.apiTestConnection(cfg) : webInvoke('apiTestConnection', [cfg]),
  // 探测模型图片输入支持（双模式均走主进程代理，靠回复内容判定而非仅 HTTP 状态）
  apiTestVision: (cfg: ApiConnConfig, modelId: string): Promise<{ ok: true; supported: boolean | null; reply?: string } | { ok: false; status?: number; error: string }> =>
    isElectron ? window.clerkbox.apiTestVision(cfg, modelId) : webInvoke('apiTestVision', [cfg, modelId]),
  apiChatStream: (cfg: ApiConnConfig, body: unknown): Promise<{ requestId: string }> => {
    if (hostBridge) return hostChatStream(cfg, body)
    return isElectron ? window.clerkbox.apiChatStream(cfg, body) : webChatStream(cfg, body)
  },
  apiAbort: (requestId: string): Promise<void> => {
    if (hostBridge) return (hostBridge.abortChatStream(requestId), Promise.resolve())
    return isElectron ? window.clerkbox.apiAbort(requestId) : (webAbort(requestId), Promise.resolve())
  },
  onApiChunk: (callback: (payload: ApiChunkPayload) => void): (() => void) => {
    if (isElectron) return window.clerkbox.onApiChunk(callback)
    chunkListeners.add(callback)
    return () => { chunkListeners.delete(callback) }
  },

  // ── Agent 宿主通道（批次 B · P3 主进程注册，P4 渲染层薄客户端消费）──
  agentCommand: (cmd: AgentCommand): Promise<AgentCommandResult> =>
    isElectron ? window.clerkbox.agentCommand(cmd) : webInvoke('agent:command', [cmd]),
  agentHostMode: (): Promise<'main' | 'renderer'> =>
    isElectron ? window.clerkbox.agentHostMode() : webInvoke('agent:host-mode'),
  agentSnapshot: (sessionId: string | undefined, sinceSeq: number): Promise<AgentSnapshot> =>
    isElectron ? window.clerkbox.agentSnapshot(sessionId, sinceSeq) : requestAgentResync(sessionId, sinceSeq),
  /**
   * 会话删除即回收宿主侧运行态。不发的话 sessions / contexts / snapshots 只增不减，
   * 而 snapshots 里存着含 apiKey 的设置快照与整段事件环——删掉的会话也在替用户留着它们。
   */
  agentDropSession: (sessionId: string): void => {
    // 可选调用：主进程侧改动要重启才生效，开发态会出现「渲染层已更新、preload 还是旧的」，
    // 而这条只是请宿主回收运行态，缺桥接不该把「删除会话」这一步整个报错中断
    if (isElectron) window.clerkbox.agentDropSession?.(sessionId)
    // WebUI：这条走 ipcMain.on（不在 handlerRegistry 里），远程本就到不了，无宿主运行态可回收
  },
  /**
   * 订阅宿主事件流。Electron 走 ipcRenderer 推送；WebUI 走 GET /api/agent/events（SSE，
   * 批次 B · P5 已接入）——远程视图与本地窗口收的是同一份带 seq 的事件序列。
   */
  onAgentEvent: (callback: (payload: { seq: number; event: AgentEvent }) => void): (() => void) => {
    if (isElectron) return window.clerkbox.onAgentEvent(callback)
    return openAgentEventStream(callback)
  },
  onBrowserNewTab: (callback: (url: string) => void): (() => void) =>
    isElectron ? window.clerkbox.onBrowserNewTab(callback) : () => {},

  // ── Agent 动作通道（Browser Use / Computer Use）──
  // WebUI 模式下这三条在主进程黑名单里（webui-server 的 REMOTE_INVOKE_BLOCKLIST），
  // 调用会失败；浏览器/桌面操控本来就是本机能力，远程视图拿不到也不该拿到。
  agentBrowserCommand: (command: unknown): Promise<unknown> =>
    isElectron ? window.clerkbox.agentBrowserCommand(command) : webInvoke('agentBrowser:command', [command]),
  agentBrowserReady: (): Promise<boolean> =>
    isElectron ? window.clerkbox.agentBrowserReady() : webInvoke('agentBrowser:ready'),
agentBrowserEnsurePanel: (sessionId?: string): Promise<boolean> =>
    isElectron ? window.clerkbox.agentBrowserEnsurePanel(sessionId) : webInvoke('agentBrowser:ensurePanel'),
  onAgentBrowserEnsurePanel: (callback: (sessionId: string | null) => void) =>
    isElectron ? window.clerkbox.onAgentBrowserEnsurePanel(callback) : () => {},
  computerUseCommand: (action: unknown, sessionLabel?: string): Promise<unknown> =>
    isElectron ? window.clerkbox.computerUseCommand(action, sessionLabel) : webInvoke('computerUse:command', [action]),
  endComputerUseControl: (): Promise<boolean> =>
    isElectron ? window.clerkbox.endComputerUseControl() : Promise.resolve(false),
  onComputerUseUserStopped: (callback: () => void) =>
    isElectron ? window.clerkbox.onComputerUseUserStopped(callback) : () => {},
  onAgentBrowserOperation: (callback: (event: { tabId: string; generation: number }) => void): (() => void) =>
    isElectron ? window.clerkbox.onAgentBrowserOperation(callback) : () => {},
  onComputerUseOperation: (callback: (event: { phase: 'scheduled' | 'active' | 'idle' }) => void): (() => void) =>
    isElectron ? window.clerkbox.onComputerUseOperation(callback) : () => {},

  loadApiKeys: (): Promise<Record<string, string>> =>
    isElectron ? window.clerkbox.loadApiKeys() : webInvoke('loadApiKeys'),
  saveApiKey: (id: string, apiKey: string): Promise<void> =>
    isElectron ? window.clerkbox.saveApiKey(id, apiKey) : webInvoke('saveApiKey', [id, apiKey]),
  removeApiKey: (id: string): Promise<void> =>
    isElectron ? window.clerkbox.removeApiKey(id) : webInvoke('removeApiKey', [id]),

  // MCP 服务器（Model Context Protocol）
  // WebUI 模式无事件推送，onMcpStatus 返回空退订函数（状态靠拉取）
  mcpSync: (servers: McpServerConfig[]): Promise<McpServerStatus[]> =>
    isElectron ? window.clerkbox.mcpSync(servers) : webInvoke('mcpSync', [servers]),
  mcpStatus: (): Promise<McpServerStatus[]> =>
    isElectron ? window.clerkbox.mcpStatus() : webInvoke('mcpStatus'),
  mcpTest: (server: McpServerConfig): Promise<{ ok: true; toolCount: number; tools: Array<{ name: string; description: string }> } | { error: string }> =>
    isElectron ? window.clerkbox.mcpTest(server) : webInvoke('mcpTest', [server]),
  mcpTools: (): Promise<McpToolInfo[]> =>
    isElectron ? window.clerkbox.mcpTools() : webInvoke('mcpTools'),
  mcpCallTool: (toolName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> =>
    isElectron ? window.clerkbox.mcpCallTool(toolName, args) : webInvoke('mcpCallTool', [toolName, args]),
  onMcpStatus: (callback: (statuses: McpServerStatus[]) => void): (() => void) => {
    if (isElectron) return window.clerkbox.onMcpStatus(callback)
    return () => {}
  },
  mcpSearch: (): Promise<{ servers: McpMarketServer[] } | { error: string }> =>
    isElectron ? window.clerkbox.mcpSearch() : webInvoke('mcpSearch'),

  // Memory system
  scanMemory: (workingDir: string): Promise<MemoryEntry[]> =>
    isElectron ? window.clerkbox.scanMemory(workingDir) : webInvoke('scanMemory', [workingDir]),
  scanAgents: (workingDir: string): Promise<Array<{ filename: string; content: string }>> =>
    isElectron ? window.clerkbox.scanAgents(workingDir) : webInvoke('scanAgents', [workingDir]),
  readMemoryIndex: (workingDir: string): Promise<{ content: string; wasTruncated: boolean; reason?: string }> =>
    isElectron ? window.clerkbox.readMemoryIndex(workingDir) : webInvoke('readMemoryIndex', [workingDir]),
  writeMemoryFile: (workingDir: string, slug: string, frontmatter: string, content: string): Promise<void> =>
    isElectron ? window.clerkbox.writeMemoryFile(workingDir, slug, frontmatter, content) : webInvoke('writeMemoryFile', [workingDir, slug, frontmatter, content]),
  updateMemoryIndex: (workingDir: string, entryLine: string, slug: string): Promise<void> =>
    isElectron ? window.clerkbox.updateMemoryIndex(workingDir, entryLine, slug) : webInvoke('updateMemoryIndex', [workingDir, entryLine, slug]),
  searchMemoryFiles: (workingDir: string, query?: string, type?: string): Promise<MemoryEntry[]> =>
    isElectron ? window.clerkbox.searchMemoryFiles(workingDir, query, type) : webInvoke('searchMemoryFiles', [workingDir, query, type]),

  // Database
  dbCreateSession: (row: SessionRow): Promise<void> =>
    isElectron ? window.clerkbox.dbCreateSession(row) : webInvoke('dbCreateSession', [row]),
  dbUpdateSessionTitle: (id: string, title: string, updatedAt: number): Promise<void> =>
    isElectron ? window.clerkbox.dbUpdateSessionTitle(id, title, updatedAt) : webInvoke('dbUpdateSessionTitle', [id, title, updatedAt]),
  dbDeleteSession: (id: string): Promise<void> =>
    isElectron ? window.clerkbox.dbDeleteSession(id) : webInvoke('dbDeleteSession', [id]),
  dbGetAllSessions: (): Promise<SessionRow[]> =>
    isElectron ? window.clerkbox.dbGetAllSessions() : webInvoke('dbGetAllSessions'),
  dbGetRecents: (): Promise<string[]> =>
    isElectron ? window.clerkbox.dbGetRecents() : webInvoke('dbGetRecents'),
  dbGetRevision: (): Promise<number> =>
    isElectron ? window.clerkbox.dbGetRevision() : webInvoke('dbGetRevision'),
  dbSetRecents: (recents: string[]): Promise<void> =>
    isElectron ? window.clerkbox.dbSetRecents(recents) : webInvoke('dbSetRecents', [recents]),
  dbAddMessage: (row: MessageRow): Promise<void> =>
    isElectron ? window.clerkbox.dbAddMessage(row) : webInvoke('dbAddMessage', [row]),
  dbUpdateMessage: (id: string, content: string, toolCalls?: string, toolResults?: string, thinkingContent?: string | null, finishReason?: string | null): Promise<void> =>
    isElectron ? window.clerkbox.dbUpdateMessage(id, content, toolCalls, toolResults, thinkingContent, finishReason) : webInvoke('dbUpdateMessage', [id, content, toolCalls, toolResults, thinkingContent, finishReason]),
  dbGetMessages: (sessionId: string): Promise<MessageRow[]> =>
    isElectron ? window.clerkbox.dbGetMessages(sessionId) : webInvoke('dbGetMessages', [sessionId]),
  dbDeleteMessagesBefore: (sessionId: string, beforeId: string): Promise<void> =>
    isElectron ? window.clerkbox.dbDeleteMessagesBefore(sessionId, beforeId) : webInvoke('dbDeleteMessagesBefore', [sessionId, beforeId]),
  dbClearMessages: (sessionId: string): Promise<void> =>
    isElectron ? window.clerkbox.dbClearMessages(sessionId) : webInvoke('dbClearMessages', [sessionId]),
  dbCompactMessages: (sessionId: string, rows: MessageRow[]): Promise<void> =>
    isElectron ? window.clerkbox.dbCompactMessages(sessionId, rows) : webInvoke('dbCompactMessages', [sessionId, rows]),
  // ── 消息撤回 / 改动回滚 ──
  dbDeleteMessagesFrom: (sessionId: string, fromId: string): Promise<void> =>
    isElectron ? window.clerkbox.dbDeleteMessagesFrom(sessionId, fromId) : webInvoke('dbDeleteMessagesFrom', [sessionId, fromId]),
  dbPatchMessage: (id: string, patch: Record<string, unknown>): Promise<void> =>
    isElectron ? window.clerkbox.dbPatchMessage(id, patch) : webInvoke('dbPatchMessage', [id, patch]),
  ckptPut: (sessionId: string, ref: string, content: string): Promise<void> =>
    isElectron ? window.clerkbox.ckptPut(sessionId, ref, content) : webInvoke('ckptPut', [sessionId, ref, content]),
  ckptGet: (sessionId: string, ref: string): Promise<string | null> =>
    isElectron ? window.clerkbox.ckptGet(sessionId, ref) : webInvoke('ckptGet', [sessionId, ref]),
  ckptRemove: (sessionId: string, refs: string[]): Promise<void> =>
    isElectron ? window.clerkbox.ckptRemove(sessionId, refs) : webInvoke('ckptRemove', [sessionId, refs]),
  ckptRemoveSession: (sessionId: string): Promise<void> =>
    isElectron ? window.clerkbox.ckptRemoveSession(sessionId) : webInvoke('ckptRemoveSession', [sessionId]),

  // ── Git（编程模式：分支/审查/图谱；WebUI 侧全部列入黑名单，走 webInvoke 会被 403 拒绝）──
  gitGetStatus: (workDir: string): Promise<GitStatusResult> =>
    isElectron ? window.clerkbox.gitGetStatus(workDir) : webInvoke('gitGetStatus', [workDir]),
  gitGetDiff: (workDir: string, path: string, source: GitDiffSource): Promise<GitDiffResult> =>
    isElectron ? window.clerkbox.gitGetDiff(workDir, path, source) : webInvoke('gitGetDiff', [workDir, path, source]),
  gitGetBranches: (workDir: string): Promise<GitBranchListResult> =>
    isElectron ? window.clerkbox.gitGetBranches(workDir) : webInvoke('gitGetBranches', [workDir]),
  gitSwitchBranch: (workDir: string, branchName: string): Promise<GitBranchMutationResult> =>
    isElectron ? window.clerkbox.gitSwitchBranch(workDir, branchName) : webInvoke('gitSwitchBranch', [workDir, branchName]),
  gitCreateBranchAndSwitch: (workDir: string, branchName: string): Promise<GitBranchMutationResult> =>
    isElectron
      ? window.clerkbox.gitCreateBranchAndSwitch(workDir, branchName)
      : webInvoke('gitCreateBranchAndSwitch', [workDir, branchName]),
  gitGetCommitGraph: (workDir: string, maxCount: number, skip: number): Promise<GitCommitGraphResult> =>
    isElectron
      ? window.clerkbox.gitGetCommitGraph(workDir, maxCount, skip)
      : webInvoke('gitGetCommitGraph', [workDir, maxCount, skip]),
  gitStagePaths: (workDir: string, paths: string[]): Promise<void> =>
    isElectron ? window.clerkbox.gitStagePaths(workDir, paths) : webInvoke('gitStagePaths', [workDir, paths]),
  gitCommit: (workDir: string, message: string, paths: string[]): Promise<GitCommitResult> =>
    isElectron ? window.clerkbox.gitCommit(workDir, message, paths) : webInvoke('gitCommit', [workDir, message, paths]),
  gitPush: (workDir: string): Promise<GitPushResult> =>
    isElectron ? window.clerkbox.gitPush(workDir) : webInvoke('gitPush', [workDir]),
  gitGetIdentity: (workDir: string): Promise<GitIdentity> =>
    isElectron ? window.clerkbox.gitGetIdentity(workDir) : webInvoke('gitGetIdentity', [workDir]),

  // .clerkbox operations
  initClerkbox: (projectDir: string): Promise<void> =>
    isElectron ? window.clerkbox.initClerkbox(projectDir) : webInvoke('initClerkbox', [projectDir]),
  writeSkillMd: (projectDir: string, slug: string, content: string): Promise<void> =>
    isElectron ? window.clerkbox.writeSkillMd(projectDir, slug, content) : webInvoke('writeSkillMd', [projectDir, slug, content]),
  writeSkillDir: (projectDir: string, slug: string, files: Array<{ path: string; content: string }>): Promise<void> =>
    isElectron ? window.clerkbox.writeSkillDir(projectDir, slug, files) : webInvoke('writeSkillDir', [projectDir, slug, files]),
  removeSkillDir: (projectDir: string, slug: string): Promise<void> =>
    isElectron ? window.clerkbox.removeSkillDir(projectDir, slug) : webInvoke('removeSkillDir', [projectDir, slug]),
  skillsSearch: (query: string, page?: number, limit?: number): Promise<string> =>
    isElectron ? window.clerkbox.skillsSearch(query, page, limit) : webInvoke('skillsSearch', [query, page, limit]),
  fetchSkillMd: (githubUrl: string): Promise<string> =>
    isElectron ? window.clerkbox.fetchSkillMd(githubUrl) : webInvoke('fetchSkillMd', [githubUrl]),
  fetchSkillFromRepo: (githubUrl: string): Promise<string> =>
    isElectron ? window.clerkbox.fetchSkillFromRepo(githubUrl) : webInvoke('fetchSkillFromRepo', [githubUrl]),
  scanSkillDirs: (workingDir: string): Promise<string> =>
    isElectron ? window.clerkbox.scanSkillDirs(workingDir) : webInvoke('scanSkillDirs', [workingDir]),

  // 窗口控制：WebUI 模式无窗口，no-op
  windowAction: (action: 'minimize' | 'maximize' | 'close'): void => {
    if (isElectron) window.clerkbox.windowAction(action)
  },

  // 系统托盘：浏览器端没有托盘概念，全部 no-op（界面侧也不展示相关设置）
  onTrayOpenSession: (callback: (sessionId: string) => void): (() => void) =>
    isElectron ? window.clerkbox.onTrayOpenSession(callback) : () => {},
  setTrayLabels: (labels: TrayLabels): void => {
    if (isElectron) window.clerkbox.setTrayLabels(labels)
  },
  setTrayConfig: (config: TrayConfig): void => {
    if (isElectron) window.clerkbox.setTrayConfig(config)
  },
  notifyTrayReady: (): void => {
    if (isElectron) window.clerkbox.notifyTrayReady()
  },

  // 平台信息：Electron 同步返回；WebUI 需异步获取，但接口签名是同步的，
  // 所以 WebUI 模式用缓存值（首次访问时异步拉取并缓存）
  platform: (): string => {
    if (isElectron) return window.clerkbox.platform
    return cachedPlatform
  },
  homeDir: (): string => {
    if (isElectron) return window.clerkbox.homeDir
    return cachedHomeDir
  },
  getHomeDir: async (): Promise<string> => {
    if (isElectron) return window.clerkbox.homeDir
    if (cachedHomeDir) return cachedHomeDir
    cachedHomeDir = await webGet<string>('/api/homedir')
    return cachedHomeDir
  },

  // WebUI 控制（仅 Electron 模式可用）
  startWebUI: (lanAccess?: boolean): Promise<{ port: number; token: string; url: string } | { error: string }> =>
    isElectron ? window.clerkbox.startWebUI(lanAccess === true) : Promise.resolve({ error: 'Already in WebUI mode' }),
  stopWebUI: (): Promise<{ ok: boolean }> =>
    isElectron ? window.clerkbox.stopWebUI() : Promise.resolve({ ok: false }),
  getWebUIStatus: (): Promise<{ running: boolean; url?: string }> =>
    isElectron ? window.clerkbox.getWebUIStatus() : Promise.resolve({ running: true, url: window.location.href }),
  getLanAddresses: (): Promise<string[]> =>
    isElectron ? window.clerkbox.getLanAddresses() : Promise.resolve([]),

  // 共享 KV 存储：双模式读写主进程同一份文件，实现设置/技能等跨模式同步
  kvGet: (key: string): Promise<string | null> =>
    isElectron ? window.clerkbox.kvGet(key) : webInvoke('kvGet', [key]),
  kvSet: (key: string, value: string): Promise<void> =>
    isElectron ? window.clerkbox.kvSet(key, value) : webInvoke('kvSet', [key, value]),
  kvRemove: (key: string): Promise<void> =>
    isElectron ? window.clerkbox.kvRemove(key) : webInvoke('kvRemove', [key]),
  // 定时任务：保持系统唤醒（WebUI 模式同样落到桌面主进程，由桌面端代为阻止休眠）
  setKeepAwake: (enable: boolean): Promise<void> =>
    isElectron ? window.clerkbox.setKeepAwake(enable) : webInvoke('setKeepAwake', [enable]),

  // VIBE 氛围模式
  // 玻璃特效只作用于 Electron 本机窗口：WebUI 远程模式直接走降级轨（壁纸快照）
  vibeGlassSet: (level: number): Promise<{ track: VibeGlassTrack }> =>
    isElectron ? window.clerkbox.vibeGlassSet(level) : Promise.resolve({ track: 'fallback' }),
  vibeGlassClear: (): Promise<void> =>
    isElectron ? window.clerkbox.vibeGlassClear() : Promise.resolve(),
  vibeGetWallpaper: (): Promise<string | null> =>
    isElectron ? window.clerkbox.vibeGetWallpaper() : webInvoke('vibeGetWallpaper'),
  vibeMediaGetState: (): Promise<SystemMediaState | null> =>
    isElectron ? window.clerkbox.vibeMediaGetState() : webInvoke('vibeMediaGetState'),
  vibeMediaCommand: (cmd: VibeMediaCommand): Promise<boolean> =>
    isElectron ? window.clerkbox.vibeMediaCommand(cmd) : webInvoke('vibeMediaCommand', [cmd]),
  vibeMediaStop: (): Promise<void> =>
    isElectron ? window.clerkbox.vibeMediaStop() : webInvoke('vibeMediaStop'),
  // 媒体状态推送仅 Electron 模式存在（WebUI 走轮询）；统一返回退订函数
  onVibeMediaState: (callback: (state: SystemMediaState) => void): (() => void) => {
    if (isElectron && typeof window.clerkbox.onVibeMediaState === 'function') {
      return window.clerkbox.onVibeMediaState(callback)
    }
    return () => {}
  },

  // 热土账号系统：登录 / 登出 / 状态 / 数据段云同步
  accountLogin: (): Promise<{ ok: true; status: AccountStatus } | { error: string }> =>
    isElectron ? window.clerkbox.accountLogin() : webInvoke('accountLogin'),
  accountLogout: (): Promise<void> =>
    isElectron ? window.clerkbox.accountLogout() : webInvoke('accountLogout'),
  accountGetStatus: (): Promise<AccountStatus> =>
    isElectron ? window.clerkbox.accountGetStatus() : webInvoke('accountGetStatus'),
  accountSyncUpload: (kinds: AccountSyncKind[]): Promise<{ results: AccountSyncResultItem[] }> =>
    isElectron ? window.clerkbox.accountSyncUpload(kinds) : webInvoke('accountSyncUpload', [kinds]),
  accountSyncDownload: (kinds: AccountSyncKind[], force: boolean): Promise<AccountSyncDownloadResult> =>
    isElectron ? window.clerkbox.accountSyncDownload(kinds, force) : webInvoke('accountSyncDownload', [kinds, force]),
  accountSyncSetPassphrase: (passphrase: string): Promise<{ ok: true } | { error: string }> =>
    isElectron ? window.clerkbox.accountSyncSetPassphrase(passphrase) : webInvoke('accountSyncSetPassphrase', [passphrase]),
  accountSyncGetPassphraseStatus: (): Promise<SyncPassphraseStatus> =>
    isElectron ? window.clerkbox.accountSyncGetPassphraseStatus() : webInvoke('accountSyncGetPassphraseStatus'),
  agentMemoryStatus: (): Promise<AgentMemoryStatus> =>
    isElectron ? window.clerkbox.agentMemoryStatus() : webInvoke('agentMemoryStatus'),
  agentMemoryMigrate: (workingDir: string): Promise<AgentMemoryMigrationResult> =>
    isElectron ? window.clerkbox.agentMemoryMigrate(workingDir) : webInvoke('agentMemoryMigrate', [workingDir]),
  agentMemoryCapture: (input: AgentMemoryCaptureInput): Promise<{ ok: boolean; error?: string }> =>
    isElectron ? window.clerkbox.agentMemoryCapture(input) : webInvoke('agentMemoryCapture', [input]),
  agentMemorySearch: (query: string, workingDir?: string, sessionId?: string): Promise<AgentMemorySearchResult[]> =>
    isElectron ? window.clerkbox.agentMemorySearch(query, workingDir, sessionId) : webInvoke('agentMemorySearch', [query, workingDir, sessionId]),
  agentMemoryContext: (workingDir?: string): Promise<AgentMemoryContext> =>
    isElectron ? window.clerkbox.agentMemoryContext(workingDir) : webInvoke('agentMemoryContext', [workingDir]),
  agentMemorySave: (scope: 'user' | 'project', slug: string, content: string, workingDir?: string): Promise<{ ok: boolean; error?: string }> =>
    isElectron ? window.clerkbox.agentMemorySave(scope, slug, content, workingDir) : webInvoke('agentMemorySave', [scope, slug, content, workingDir]),

  // 工作台内置终端（node-pty）：仅 Electron 桌面端可用，WebUI 一律拒绝
  ptyCreate: (info: { id: string; cwd?: string; cols?: number; rows?: number }): Promise<{ ok: boolean }> =>
    isElectron ? window.clerkbox.ptyCreate(info) : Promise.reject(new Error('Terminal is desktop-only')),
  ptyInput: (id: string, data: string): void => {
    if (isElectron) window.clerkbox.ptyInput(id, data)
  },
  ptyResize: (id: string, cols: number, rows: number): void => {
    if (isElectron) window.clerkbox.ptyResize(id, cols, rows)
  },
  ptyKill: (id: string): Promise<void> =>
    isElectron ? window.clerkbox.ptyKill(id) : Promise.resolve(),
  onPtyData: (callback: (id: string, data: string) => void): (() => void) =>
    isElectron ? window.clerkbox.onPtyData(callback) : () => {},
  onPtyExit: (callback: (id: string, exitCode: number) => void): (() => void) =>
    isElectron ? window.clerkbox.onPtyExit(callback) : () => {},

  // 自动更新：仅 Electron 桌面端（WebUI 浏览器端无本地安装能力，版本号标签保持静态）
  updateCheck: (): Promise<UpdaterState> =>
    isElectron ? window.clerkbox.updateCheck() : Promise.resolve(WEBUI_UPDATER_UNSUPPORTED),
  updateInstall: (): Promise<{ started: boolean }> =>
    isElectron ? window.clerkbox.updateInstall() : Promise.resolve({ started: false }),
  updateAgentActivity: (active: boolean): void => {
    if (isElectron) window.clerkbox.updateAgentActivity(active)
  },
  onUpdateState: (callback: (state: UpdaterState) => void): (() => void) =>
    isElectron ? window.clerkbox.onUpdateState(callback) : () => {},

  // 日志与诊断（A1）：logWrite 仅桌面端转发落盘；WebUI 无本地日志文件可导出
  logWrite: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string): void => {
    if (isElectron) window.clerkbox.logWrite(level, scope, message)
  },
  diagExport: (): Promise<{ ok: true; path: string } | { canceled: true } | { error: string }> =>
    isElectron
      ? window.clerkbox.diagExport()
      : Promise.resolve({ error: 'Diagnostics export is desktop-only' }),
}

/** WebUI 模式下返回的「不支持更新」状态快照 */
const WEBUI_UPDATER_UNSUPPORTED: UpdaterState = {
  supported: false,
  canAutoInstall: false,
  phase: 'idle',
  currentVersion: '',
  newVersion: null,
  releaseNotes: null,
  releaseUrl: null,
  progress: null,
  lastCheckedAt: null,
  agentBusy: false,
}

// ── WebUI 模式下异步预取 platform / homeDir ──
let cachedPlatform = ''
let cachedHomeDir = ''
if (!isElectron && typeof window !== 'undefined') {
  void webGet<string>('/api/platform').then((p) => { cachedPlatform = p }).catch(() => {})
  void webGet<string>('/api/homedir').then((h) => { cachedHomeDir = h }).catch(() => {})
}
