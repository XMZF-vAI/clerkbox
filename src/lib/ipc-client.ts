import type {
  ApiChunkPayload,
  ApiConnConfig,
  FetchedModel,
  FileEntry,
  MessageRow,
  ParseSkillFileResult,
  SessionRow,
} from '../types/ipc'
import type { MemoryEntry } from '../types/agent'

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
}

/** WebUI 模式下判断当前是否为 WebUI 环境（供 UI 层隐藏窗口控制按钮等） */
export const isWebUIMode = !isElectron

// ── WebUI HTTP 调用封装 ──
async function webInvoke<T>(method: string, args: unknown[] = []): Promise<T> {
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

// ── WebUI 流式对话：SSE 桥接到 onApiChunk 回调模式 ──
// 与 Electron 的 apiChunk 事件语义对齐，api-transport.ts 无需改动。
type ChunkCallback = (payload: ApiChunkPayload) => void
const chunkListeners = new Set<ChunkCallback>()

/** 在途 SSE 请求：requestId → AbortController（用于 apiAbort） */
const sseControllers = new Map<string, AbortController>()

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
      if (!reader) return
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
    } catch {
      // 连接中断等，静默处理
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

// ── 统一 ipc 对象 ──
// Electron 模式直接委托 window.clerkbox；WebUI 模式走 HTTP。
export const ipc = {
  // 文件对话框：WebUI 模式无法弹出原生对话框，返回 null（UI 层降级为手动输入路径）
  selectFolder: (): Promise<string | null> =>
    isElectron ? window.clerkbox.selectFolder() : Promise.resolve(null),
  selectImageFile: (): Promise<string | null> =>
    isElectron ? window.clerkbox.selectImageFile() : Promise.resolve(null),
  selectAudioFile: (): Promise<string | null> =>
    isElectron ? window.clerkbox.selectAudioFile() : Promise.resolve(null),
  selectMusicFolder: (): Promise<string | null> =>
    isElectron ? window.clerkbox.selectMusicFolder() : Promise.resolve(null),
  selectSkillFile: (): Promise<string | null> =>
    isElectron ? window.clerkbox.selectSkillFile() : Promise.resolve(null),

  parseSkillFile: (filePath: string): Promise<ParseSkillFileResult> =>
    isElectron ? window.clerkbox.parseSkillFile(filePath) : webInvoke('parseSkillFile', [filePath]),
  fileExists: (path: string): Promise<boolean> =>
    isElectron ? window.clerkbox.fileExists(path) : webInvoke('fileExists', [path]),
  openExternal: (url: string): Promise<void> =>
    isElectron ? window.clerkbox.openExternal(url) : (window.open(url, '_blank'), Promise.resolve()),
  confirmDialog: (title: string, message: string): Promise<boolean> =>
    isElectron ? window.clerkbox.confirmDialog(title, message) : Promise.resolve(window.confirm(`${title}\n\n${message}`)),
  readFile: (path: string): Promise<string> =>
    isElectron ? window.clerkbox.readFile(path) : webInvoke('readFile', [path]),
  writeFile: (path: string, content: string): Promise<void> =>
    isElectron ? window.clerkbox.writeFile(path, content) : webInvoke('writeFile', [path, content]),
  listDir: (path: string): Promise<FileEntry[]> =>
    isElectron ? window.clerkbox.listDir(path) : webInvoke('listDir', [path]),
  executeCommand: (command: string, cwd?: string, sessionId?: string): Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean }> =>
    isElectron ? window.clerkbox.executeCommand(command, cwd, sessionId) : webInvoke('executeCommand', [command, cwd, sessionId]),
  executeCommandWithShell: (command: string, cwd: string | undefined, shellType: string, sessionId?: string): Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean }> =>
    isElectron ? window.clerkbox.executeCommandWithShell(command, cwd, shellType, sessionId) : webInvoke('executeCommandWithShell', [command, cwd, shellType, sessionId]),
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
  apiChatStream: (cfg: ApiConnConfig, body: unknown): Promise<{ requestId: string }> =>
    isElectron ? window.clerkbox.apiChatStream(cfg, body) : webChatStream(cfg, body),
  apiAbort: (requestId: string): Promise<void> =>
    isElectron ? window.clerkbox.apiAbort(requestId) : (webAbort(requestId), Promise.resolve()),
  onApiChunk: (callback: (payload: ApiChunkPayload) => void): (() => void) => {
    if (isElectron) return window.clerkbox.onApiChunk(callback)
    chunkListeners.add(callback)
    return () => { chunkListeners.delete(callback) }
  },

  loadApiKeys: (): Promise<Record<string, string>> =>
    isElectron ? window.clerkbox.loadApiKeys() : webInvoke('loadApiKeys'),
  saveApiKey: (id: string, apiKey: string): Promise<void> =>
    isElectron ? window.clerkbox.saveApiKey(id, apiKey) : webInvoke('saveApiKey', [id, apiKey]),
  removeApiKey: (id: string): Promise<void> =>
    isElectron ? window.clerkbox.removeApiKey(id) : webInvoke('removeApiKey', [id]),

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

  // WebUI 控制（仅 Electron 模式可用）
  startWebUI: (): Promise<{ port: number; token: string; url: string } | { error: string }> =>
    isElectron ? window.clerkbox.startWebUI() : Promise.resolve({ error: 'Already in WebUI mode' }),
  stopWebUI: (): Promise<{ ok: boolean }> =>
    isElectron ? window.clerkbox.stopWebUI() : Promise.resolve({ ok: false }),
  getWebUIStatus: (): Promise<{ running: boolean; url?: string }> =>
    isElectron ? window.clerkbox.getWebUIStatus() : Promise.resolve({ running: true, url: window.location.href }),

  // 共享 KV 存储：双模式读写主进程同一份文件，实现设置/技能等跨模式同步
  kvGet: (key: string): Promise<string | null> =>
    isElectron ? window.clerkbox.kvGet(key) : webInvoke('kvGet', [key]),
  kvSet: (key: string, value: string): Promise<void> =>
    isElectron ? window.clerkbox.kvSet(key, value) : webInvoke('kvSet', [key, value]),
  kvRemove: (key: string): Promise<void> =>
    isElectron ? window.clerkbox.kvRemove(key) : webInvoke('kvRemove', [key]),
}

// ── WebUI 模式下异步预取 platform / homeDir ──
let cachedPlatform = ''
let cachedHomeDir = ''
if (!isElectron && typeof window !== 'undefined') {
  void webGet<string>('/api/platform').then((p) => { cachedPlatform = p }).catch(() => {})
  void webGet<string>('/api/homedir').then((h) => { cachedHomeDir = h }).catch(() => {})
}
