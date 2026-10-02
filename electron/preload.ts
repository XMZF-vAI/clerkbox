import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  GitBranchListResult,
  GitBranchMutationResult,
  GitCommitGraphResult,
  GitCommitResult,
  GitDiffResult,
  GitDiffSource,
  GitIdentity,
  GitPushResult,
  GitStatusResult,
  MessageRow,
  SessionRow,
  SyncPassphraseStatus,
  SystemMediaState,
  TrayConfig,
  TrayLabels,
  UpdaterState,
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
  readFileBase64: (filePath: string): Promise<{ data: string; mimeType: string; size: number }> =>
    ipcRenderer.invoke('readFileBase64', filePath),
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
  /** 多选项确认框，返回被按下按钮的下标（-1 = 无效 / 已关闭） */
  confirmDialogWithOptions: (payload: { title: string; message: string; buttons: string[]; defaultIndex: number }): Promise<number> =>
    ipcRenderer.invoke('confirmDialogWithOptions', payload),
  readFile: (path: string): Promise<string> => ipcRenderer.invoke('readFile', path),
  writeFile: (path: string, content: string): Promise<void> =>
    ipcRenderer.invoke('writeFile', path, content),
  deleteFile: (path: string): Promise<void> =>
    ipcRenderer.invoke('deleteFile', path),
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

  // 系统托盘（桌面端专属）：文案与配置由渲染层下发，托盘点选对话反向推送
  onTrayOpenSession: (callback: (sessionId: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on('tray:open-session', listener)
    return () => ipcRenderer.removeListener('tray:open-session', listener)
  },
  setTrayLabels: (labels: TrayLabels): void => { ipcRenderer.send('tray:labels', labels) },
  setTrayConfig: (config: TrayConfig): void => { ipcRenderer.send('tray:config', config) },
  notifyTrayReady: (): void => { ipcRenderer.send('tray:renderer-ready') },

  // Updater（版本号标签自动更新）
  updateCheck: (): Promise<UpdaterState> => ipcRenderer.invoke('update:check'),
  updateInstall: (): Promise<{ started: boolean }> => ipcRenderer.invoke('update:install'),
  /** agent 活跃心跳上报（streaming 变化时 + 定时） */
  updateAgentActivity: (active: boolean): void => ipcRenderer.send('update:agent-activity', active),
  onUpdateState: (callback: (state: UpdaterState) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, state: UpdaterState) => callback(state)
    ipcRenderer.on('update:state', listener)
    return () => ipcRenderer.removeListener('update:state', listener)
  },

  onBrowserNewTab: (callback: (url: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on('browser:new-tab', listener)
    return () => ipcRenderer.removeListener('browser:new-tab', listener)
  },

  // ── Agent 动作通道（Browser Use / Computer Use）──
  // invoke 侧：入参原样透传，形状由主进程 handler 的白名单校验收口（不是靠这里）
  agentBrowserCommand: (command: unknown): Promise<unknown> =>
    ipcRenderer.invoke('agentBrowser:command', command),
  agentBrowserReady: (): Promise<boolean> => ipcRenderer.invoke('agentBrowser:ready'),
  /** 请渲染层打开 Agent 浏览器标签（只在 AI 真的发出浏览器命令时由工具层发起）。
   *  sessionId 是**正在执行任务的那个会话** —— 用户可能正看着另一个对话，
   *  渲染层据此只开在目标分片，不夺取当前视图。 */
  agentBrowserEnsurePanel: (sessionId?: string): Promise<boolean> => ipcRenderer.invoke('agentBrowser:ensurePanel', sessionId),
  onAgentBrowserEnsurePanel: (callback: (sessionId: string | null) => void): (() => void) => {
    const listener = (_e: unknown, sessionId: string | null) => callback(sessionId)
    ipcRenderer.on('agentBrowser:ensurePanel', listener)
    return () => ipcRenderer.removeListener('agentBrowser:ensurePanel', listener)
  },
  computerUseCommand: (action: unknown, sessionLabel?: string): Promise<unknown> =>
    ipcRenderer.invoke('computerUse:command', action, sessionLabel ?? null),
  /** 一次运行结束：让「正在操控你的电脑」浮块退场（浮块在整段操控期内常驻，不逐动作熄） */
  endComputerUseControl: (): Promise<boolean> => ipcRenderer.invoke('computerUse:endControl'),
  /** 用户按 Esc 叫停了电脑操控。渲染层据此中止当前运行并让 agent 知道原因 */
  onComputerUseUserStopped: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('computerUse:userStopped', listener)
    return () => ipcRenderer.removeListener('computerUse:userStopped', listener)
  },
  /** Agent 浏览器刚发生了一次操作：渲染层据此点亮标签的呼吸图标（5s 滑动窗口由渲染层管） */
  onAgentBrowserOperation: (callback: (event: { tabId: string; generation: number }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: { tabId: string; generation: number }) => callback(event)
    ipcRenderer.on('agentBrowser:operation', listener)
    return () => ipcRenderer.removeListener('agentBrowser:operation', listener)
  },
  onComputerUseOperation: (callback: (event: { phase: 'scheduled' | 'active' | 'idle' }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, event: { phase: 'scheduled' | 'active' | 'idle' }) => callback(event)
    ipcRenderer.on('computerUse:operation', listener)
    return () => ipcRenderer.removeListener('computerUse:operation', listener)
  },

  // Shell
  executeCommand: (
    command: string,
    cwd?: string,
    sessionId?: string,
    timeoutMs?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }> =>
    ipcRenderer.invoke('executeCommand', command, cwd, sessionId, timeoutMs),
  executeCommandWithShell: (
    command: string,
    cwd: string | undefined,
    shellType: string,
    sessionId?: string,
    timeoutMs?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }> =>
    ipcRenderer.invoke('executeCommandWithShell', command, cwd, shellType, sessionId, timeoutMs),
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

  // ── Agent 宿主通道（批次 B · P3）：指令下发 / 事件订阅 / 重连快照 ──
  agentCommand: (cmd: unknown): Promise<{ ok: boolean; error?: string; plan?: unknown; outcome?: unknown }> =>
    ipcRenderer.invoke('agent:command', cmd),
  agentHostMode: (): Promise<'main' | 'renderer'> => ipcRenderer.invoke('agent:host-mode'),
  agentSnapshot: (sessionId: string | undefined, sinceSeq: number): Promise<unknown> =>
    ipcRenderer.invoke('agent:snapshot', sessionId, sinceSeq),
  /** 会话被删除时通知宿主回收运行态（环、消息镜像、含 apiKey 的设置快照） */
  agentDropSession: (sessionId: string): void => ipcRenderer.send('agent:drop-session', sessionId),
  /** 订阅宿主事件流；返回退订函数。payload 带单调 seq，缺口即需重连补发 */
  onAgentEvent: (
    callback: (payload: { seq: number; event: unknown }) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: { seq: number; event: unknown }) => callback(payload)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
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
  // ── 消息撤回 / 改动回滚 ──
  dbDeleteMessagesFrom: (sessionId: string, fromId: string): Promise<void> =>
    ipcRenderer.invoke('dbDeleteMessagesFrom', sessionId, fromId),
  dbPatchMessage: (id: string, patch: Record<string, unknown>): Promise<void> =>
    ipcRenderer.invoke('dbPatchMessage', id, patch),
  ckptPut: (sessionId: string, ref: string, content: string): Promise<void> =>
    ipcRenderer.invoke('ckptPut', sessionId, ref, content),
  ckptGet: (sessionId: string, ref: string): Promise<string | null> =>
    ipcRenderer.invoke('ckptGet', sessionId, ref),
  ckptRemove: (sessionId: string, refs: string[]): Promise<void> =>
    ipcRenderer.invoke('ckptRemove', sessionId, refs),
  ckptRemoveSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('ckptRemoveSession', sessionId),

  // ── Git（编程模式：分支/审查/图谱）──
  gitGetStatus: (workDir: string): Promise<GitStatusResult> => ipcRenderer.invoke('gitGetStatus', workDir),
  gitGetDiff: (workDir: string, path: string, source: GitDiffSource): Promise<GitDiffResult> =>
    ipcRenderer.invoke('gitGetDiff', workDir, path, source),
  gitGetBranches: (workDir: string): Promise<GitBranchListResult> => ipcRenderer.invoke('gitGetBranches', workDir),
  gitSwitchBranch: (workDir: string, branchName: string): Promise<GitBranchMutationResult> =>
    ipcRenderer.invoke('gitSwitchBranch', workDir, branchName),
  gitCreateBranchAndSwitch: (workDir: string, branchName: string): Promise<GitBranchMutationResult> =>
    ipcRenderer.invoke('gitCreateBranchAndSwitch', workDir, branchName),
  gitGetCommitGraph: (workDir: string, maxCount: number, skip: number): Promise<GitCommitGraphResult> =>
    ipcRenderer.invoke('gitGetCommitGraph', workDir, maxCount, skip),
  gitStagePaths: (workDir: string, paths: string[]): Promise<void> =>
    ipcRenderer.invoke('gitStagePaths', workDir, paths),
  gitCommit: (workDir: string, message: string, paths: string[]): Promise<GitCommitResult> =>
    ipcRenderer.invoke('gitCommit', workDir, message, paths),
  gitPush: (workDir: string): Promise<GitPushResult> => ipcRenderer.invoke('gitPush', workDir),
  gitGetIdentity: (workDir: string): Promise<GitIdentity> => ipcRenderer.invoke('gitGetIdentity', workDir),

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
  // 定时任务：保持系统唤醒（阻止系统休眠）
  setKeepAwake: (enable: boolean): Promise<void> => ipcRenderer.invoke('setKeepAwake', enable),

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
  accountSyncSetPassphrase: (passphrase: string): Promise<{ ok: true } | { error: string }> =>
    ipcRenderer.invoke('accountSyncSetPassphrase', passphrase),
  accountSyncGetPassphraseStatus: (): Promise<SyncPassphraseStatus> =>
    ipcRenderer.invoke('accountSyncGetPassphraseStatus'),
  agentMemoryStatus: (): Promise<AgentMemoryStatus> => ipcRenderer.invoke('agentMemoryStatus'),
  agentMemoryMigrate: (workingDir: string): Promise<AgentMemoryMigrationResult> =>
    ipcRenderer.invoke('agentMemoryMigrate', workingDir),
  agentMemoryCapture: (input: AgentMemoryCaptureInput): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agentMemoryCapture', input),
  agentMemorySearch: (query: string, workingDir?: string, sessionId?: string): Promise<AgentMemorySearchResult[]> =>
    ipcRenderer.invoke('agentMemorySearch', query, workingDir, sessionId),
  agentMemoryContext: (workingDir?: string): Promise<AgentMemoryContext> =>
    ipcRenderer.invoke('agentMemoryContext', workingDir),
  agentMemorySave: (scope: 'user' | 'project', slug: string, content: string, workingDir?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('agentMemorySave', scope, slug, content, workingDir),

  // 工作台内置终端（node-pty 真 TTY）
  ptyCreate: (info: { id: string; cwd?: string; cols?: number; rows?: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('ptyCreate', info),
  ptyInput: (id: string, data: string): void => {
    ipcRenderer.send('ptyInput', id, data)
  },
  ptyResize: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('ptyResize', id, cols, rows)
  },
  ptyKill: (id: string): Promise<void> => ipcRenderer.invoke('ptyKill', id),
  onPtyData: (callback: (id: string, data: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string, data: string) => callback(id, data)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onPtyExit: (callback: (id: string, exitCode: number) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string, exitCode: number) => callback(id, exitCode)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },

  // 日志与诊断：渲染进程日志转发主进程落盘（fire-and-forget）；导出诊断包（桌面端）
  logWrite: (level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string): void => {
    ipcRenderer.send('log:write', level, scope, message)
  },
  diagExport: (): Promise<{ ok: true; path: string } | { canceled: true } | { error: string }> =>
    ipcRenderer.invoke('diagExport'),
})
