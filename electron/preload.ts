import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AccountStatus,
  AccountSyncDownloadResult,
  AccountSyncKind,
  AccountSyncResultItem,
  ApiChunkPayload,
  ApiConnConfig,
  FetchedModel,
  MessageRow,
  SessionRow,
  SystemMediaState,
  VibeGlassTrack,
  VibeMediaCommand,
  WebSearchResult,
} from '../src/types/ipc'
import type { MemoryEntry } from '../src/types/agent'
import type { McpServerConfig, McpServerStatus, McpToolInfo, McpMarketServer } from '../src/types/ipc'

contextBridge.exposeInMainWorld('clerkbox', {
  // File system
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('selectFolder'),
  selectImageFile: (): Promise<string | null> => ipcRenderer.invoke('selectImageFile'),
  selectChatFiles: (): Promise<string[] | null> => ipcRenderer.invoke('selectChatFiles'),
  readImageFileBase64: (filePath: string): Promise<string> => ipcRenderer.invoke('readImageFileBase64', filePath),
  selectAudioFile: (): Promise<string | null> => ipcRenderer.invoke('selectAudioFile'),
  selectMusicFolder: (): Promise<string | null> => ipcRenderer.invoke('selectMusicFolder'),
  selectSkillFile: (): Promise<string | null> => ipcRenderer.invoke('selectSkillFile'),
  parseSkillFile: (filePath: string): Promise<{ success: boolean; name?: string; description?: string; icon?: string; category?: string; skillMdContent?: string; files?: Array<{ path: string; content: string }>; error?: string }> =>
    ipcRenderer.invoke('parseSkillFile', filePath),
  fileExists: (path: string): Promise<boolean> => ipcRenderer.invoke('fileExists', path),
  /** Electron 42 起 File.path 已移除，取 File 真实磁盘路径须用 webUtils.getPathForFile */
  getPathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('openExternal', url),
  confirmDialog: (title: string, message: string): Promise<boolean> =>
    ipcRenderer.invoke('confirmDialog', title, message),
  readFile: (path: string): Promise<string> => ipcRenderer.invoke('readFile', path),
  writeFile: (path: string, content: string): Promise<void> =>
    ipcRenderer.invoke('writeFile', path, content),
  listDir: (path: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]> =>
    ipcRenderer.invoke('listDir', path),

  // Window
  windowAction: (action: 'minimize' | 'maximize' | 'close'): void =>
    ipcRenderer.send('windowAction', action),
  isWindowMaximized: ipcRenderer.sendSync('isWindowMaximized') as boolean,
  onWindowStateChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, isMaximized: boolean) => callback(isMaximized)
    ipcRenderer.on('windowStateChanged', listener)
    return () => ipcRenderer.removeListener('windowStateChanged', listener)
  },

  // Shell
  executeCommand: (
    command: string,
    cwd?: string,
    sessionId?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    ipcRenderer.invoke('executeCommand', command, cwd, sessionId),
  executeCommandWithShell: (
    command: string,
    cwd: string | undefined,
    shellType: string,
    sessionId?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    ipcRenderer.invoke('executeCommandWithShell', command, cwd, shellType, sessionId),
  cancelSessionCommands: (sessionId: string): Promise<{ killed: number }> =>
    ipcRenderer.invoke('cancelSessionCommands', sessionId),

  // Web
  webSearch: (query: string, count?: number): Promise<WebSearchResult[] | { error: string }> =>
    ipcRenderer.invoke('webSearch', query, count),
  webFetch: (url: string, maxLength?: number): Promise<{ content: string; url: string } | { error: string }> =>
    ipcRenderer.invoke('webFetch', url, maxLength),

  // 模型 API 代理（主进程 fetch，绕开渲染进程同源策略）
  apiFetchModels: (cfg: ApiConnConfig): Promise<{ models: FetchedModel[] } | { error: string }> =>
    ipcRenderer.invoke('apiFetchModels', cfg),
  apiTestConnection: (cfg: ApiConnConfig): Promise<{ ok: true; latencyMs: number } | { error: string }> =>
    ipcRenderer.invoke('apiTestConnection', cfg),
  apiTestVision: (cfg: ApiConnConfig, modelId: string): Promise<{ ok: true; supported: boolean | null; reply?: string } | { ok: false; status?: number; error: string }> =>
    ipcRenderer.invoke('apiTestVision', cfg, modelId),
  apiChatStream: (cfg: ApiConnConfig, body: unknown): Promise<{ requestId: string }> =>
    ipcRenderer.invoke('apiChatStream', cfg, body),
  apiAbort: (requestId: string): Promise<void> => ipcRenderer.invoke('apiAbort', requestId),
  /** 订阅流式分片；返回退订函数 */
  onApiChunk: (
    callback: (payload: ApiChunkPayload) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: ApiChunkPayload) => callback(payload)
    ipcRenderer.on('apiChunk', listener)
    return () => ipcRenderer.removeListener('apiChunk', listener)
  },

  // Credentials are encrypted by Electron's OS-backed safeStorage in the main process.
  loadApiKeys: (): Promise<Record<string, string>> => ipcRenderer.invoke('loadApiKeys'),
  saveApiKey: (id: string, apiKey: string): Promise<void> => ipcRenderer.invoke('saveApiKey', id, apiKey),
  removeApiKey: (id: string): Promise<void> => ipcRenderer.invoke('removeApiKey', id),

  // MCP servers
  mcpSync: (servers: McpServerConfig[]): Promise<McpServerStatus[]> =>
    ipcRenderer.invoke('mcpSync', servers),
  mcpStatus: (): Promise<McpServerStatus[]> => ipcRenderer.invoke('mcpStatus'),
  mcpTest: (server: McpServerConfig): Promise<{ ok: true; toolCount: number; tools: Array<{ name: string; description: string }> } | { error: string }> =>
    ipcRenderer.invoke('mcpTest', server),
  mcpTools: (): Promise<McpToolInfo[]> => ipcRenderer.invoke('mcpTools'),
  mcpCallTool: (toolName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> =>
    ipcRenderer.invoke('mcpCallTool', toolName, args),
  onMcpStatus: (callback: (statuses: McpServerStatus[]) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, statuses: McpServerStatus[]) => callback(statuses)
    ipcRenderer.on('mcp:statusChanged', listener)
    return () => ipcRenderer.removeListener('mcp:statusChanged', listener)
  },
  mcpSearch: (): Promise<{ servers: McpMarketServer[] } | { error: string }> =>
    ipcRenderer.invoke('mcpSearch'),

  // Memory system
  scanMemory: (workingDir: string): Promise<MemoryEntry[]> =>
    ipcRenderer.invoke('scanMemory', workingDir),
  scanAgents: (workingDir: string) => ipcRenderer.invoke('scanAgents', workingDir),
  readMemoryIndex: (workingDir: string): Promise<{ content: string; wasTruncated: boolean; reason?: string }> =>
    ipcRenderer.invoke('readMemoryIndex', workingDir),
  writeMemoryFile: (workingDir: string, slug: string, frontmatter: string, content: string): Promise<void> =>
    ipcRenderer.invoke('writeMemoryFile', workingDir, slug, frontmatter, content),
  updateMemoryIndex: (workingDir: string, entryLine: string, slug: string): Promise<void> =>
    ipcRenderer.invoke('updateMemoryIndex', workingDir, entryLine, slug),
  searchMemoryFiles: (workingDir: string, query?: string, type?: string): Promise<MemoryEntry[]> =>
    ipcRenderer.invoke('searchMemoryFiles', workingDir, query, type),

  // Database
  dbCreateSession: (row: SessionRow): Promise<void> => ipcRenderer.invoke('dbCreateSession', row),
  dbUpdateSessionTitle: (id: string, title: string, updatedAt: number): Promise<void> =>
    ipcRenderer.invoke('dbUpdateSessionTitle', id, title, updatedAt),
  dbDeleteSession: (id: string): Promise<void> => ipcRenderer.invoke('dbDeleteSession', id),
  dbGetAllSessions: (): Promise<SessionRow[]> => ipcRenderer.invoke('dbGetAllSessions'),
  dbGetRecents: (): Promise<string[]> => ipcRenderer.invoke('dbGetRecents'),
  dbGetRevision: (): Promise<number> => ipcRenderer.invoke('dbGetRevision'),
  dbSetRecents: (recents: string[]): Promise<void> => ipcRenderer.invoke('dbSetRecents', recents),
  dbAddMessage: (row: MessageRow): Promise<void> => ipcRenderer.invoke('dbAddMessage', row),
  dbUpdateMessage: (
    id: string,
    content: string,
    toolCalls?: string,
    toolResults?: string,
    thinkingContent?: string | null,
    finishReason?: string | null
  ): Promise<void> =>
    ipcRenderer.invoke('dbUpdateMessage', id, content, toolCalls, toolResults, thinkingContent, finishReason),
  dbGetMessages: (sessionId: string): Promise<MessageRow[]> =>
    ipcRenderer.invoke('dbGetMessages', sessionId),
  dbDeleteMessagesBefore: (sessionId: string, beforeId: string): Promise<void> =>
    ipcRenderer.invoke('dbDeleteMessagesBefore', sessionId, beforeId),
  dbClearMessages: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('dbClearMessages', sessionId),
  dbCompactMessages: (sessionId: string, rows: MessageRow[]): Promise<void> =>
    ipcRenderer.invoke('dbCompactMessages', sessionId, rows),

  // Skill operations
  initClerkbox: (projectDir: string): Promise<void> => ipcRenderer.invoke('initClerkbox', projectDir),
  writeSkillMd: (projectDir: string, slug: string, content: string): Promise<void> =>
    ipcRenderer.invoke('writeSkillMd', projectDir, slug, content),
  writeSkillDir: (projectDir: string, slug: string, files: Array<{ path: string; content: string }>): Promise<void> =>
    ipcRenderer.invoke('writeSkillDir', projectDir, slug, files),
  removeSkillDir: (projectDir: string, slug: string): Promise<void> =>
    ipcRenderer.invoke('removeSkillDir', projectDir, slug),

  // Skills Marketplace
  skillsSearch: (query: string, page?: number, limit?: number): Promise<string> =>
    ipcRenderer.invoke('skillsSearch', query, page, limit),
  fetchSkillMd: (githubUrl: string): Promise<string> => ipcRenderer.invoke('fetchSkillMd', githubUrl),
  fetchSkillFromRepo: (githubUrl: string): Promise<string> => ipcRenderer.invoke('fetchSkillFromRepo', githubUrl),
  scanSkillDirs: (workingDir: string): Promise<string> => ipcRenderer.invoke('scanSkillDirs', workingDir),

  // Platform
  // The sandboxed preload cannot access OS APIs directly.
  platform: ipcRenderer.sendSync('getPlatform'),
  homeDir: ipcRenderer.sendSync('getHomeDir'),

  // WebUI 控制
  startWebUI: (lanAccess?: boolean): Promise<{ port: number; token: string; url: string } | { error: string }> =>
    ipcRenderer.invoke('startWebUI', lanAccess === true),
  stopWebUI: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('stopWebUI'),
  getWebUIStatus: (): Promise<{ running: boolean; url?: string }> => ipcRenderer.invoke('getWebUIStatus'),
  getLanAddresses: (): Promise<string[]> => ipcRenderer.invoke('getLanAddresses'),

  // 共享 KV 存储（Electron 与 WebUI 双模式同步持久化）
  kvGet: (key: string): Promise<string | null> => ipcRenderer.invoke('kvGet', key),
  kvSet: (key: string, value: string): Promise<void> => ipcRenderer.invoke('kvSet', key, value),
  kvRemove: (key: string): Promise<void> => ipcRenderer.invoke('kvRemove', key),

  // VIBE 氛围模式（玻璃特效 / 壁纸 / 系统媒体）
  vibeGlassSet: (level: number): Promise<{ track: VibeGlassTrack }> =>
    ipcRenderer.invoke('vibeGlassSet', level),
  vibeGlassClear: (): Promise<void> => ipcRenderer.invoke('vibeGlassClear'),
  vibeGetWallpaper: (): Promise<string | null> => ipcRenderer.invoke('vibeGetWallpaper'),
  vibeMediaGetState: (): Promise<SystemMediaState | null> => ipcRenderer.invoke('vibeMediaGetState'),
  vibeMediaCommand: (cmd: VibeMediaCommand): Promise<boolean> => ipcRenderer.invoke('vibeMediaCommand', cmd),
  vibeMediaStop: (): Promise<void> => ipcRenderer.invoke('vibeMediaStop'),
  onVibeMediaState: (callback: (state: SystemMediaState) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: SystemMediaState) => callback(state)
    ipcRenderer.on('vibe:mediaState', listener)
    return () => ipcRenderer.removeListener('vibe:mediaState', listener)
  },

  // 热土账号系统（登录 / 登出 / 数据段云同步）
  accountLogin: (): Promise<{ ok: true; status: AccountStatus } | { error: string }> =>
    ipcRenderer.invoke('accountLogin'),
  accountLogout: (): Promise<void> => ipcRenderer.invoke('accountLogout'),
  accountGetStatus: (): Promise<AccountStatus> => ipcRenderer.invoke('accountGetStatus'),
  accountSyncUpload: (kinds: AccountSyncKind[]): Promise<{ results: AccountSyncResultItem[] }> =>
    ipcRenderer.invoke('accountSyncUpload', kinds),
  accountSyncDownload: (kinds: AccountSyncKind[], force: boolean): Promise<AccountSyncDownloadResult> =>
    ipcRenderer.invoke('accountSyncDownload', kinds, force),
})
