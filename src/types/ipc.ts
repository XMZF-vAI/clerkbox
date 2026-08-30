import type { ApiCompat, MemoryEntry, MemoryType } from './agent'

export interface FileEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

export interface WebUICapabilities {
  isRemoteClient: boolean
  canUpload: boolean
  canBrowseHostFolders: boolean
  maxUploadBytes: number
}

export interface WebUIUploadResult {
  name: string
  path: string
  size: number
  maxUploadBytes: number
}

export interface SessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  /** 用户为本会话选择的工作目录（未选择时缺省） */
  working_dir?: string | null
  /** 会话创建时自动生成的默认工作目录（回填用） */
  default_work_dir?: string | null
}

export interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  thinking_content?: string | null
  timestamp: number
  tool_calls?: string | null
  tool_results?: string | null
  /** 附件（MessageAttachment[] 的 JSON 序列化） */
  attachments?: string | null
  finish_reason?: string | null
  is_compact?: number  // 0 or 1 — marks compact boundary/summary messages
  is_compact_attachment?: number  // 0 or 1 — marks post-compaction file-restore messages
  is_sub_agent_card?: number  // 0 or 1 — marks sub-agent card placeholder messages
  sub_agent_id?: string | null  // associated sub-agent run id
  /** 发送时的任务工作流（'spec' | 'plan' | 'goal'），仅 user 消息携带 */
  task_mode?: string | null
  /** 发送时选中的 Skill 快照 JSON，仅 user 消息携带 */
  skills?: string | null
}

export interface WebSearchResult {
  title: string
  snippet: string
  url: string
}

// ── MCP (Model Context Protocol) ──

/** MCP 服务器连接方式 */
export type McpTransportType = 'stdio' | 'http'

/** 一条 MCP 服务器配置（env/headers 可能含密钥，随设置一起持久化） */
export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransportType
  enabled: boolean
  /** stdio：启动命令，如 npx / uvx / node */
  command?: string
  /** stdio：命令参数 */
  args?: string[]
  /** stdio：环境变量（可含 API Token 等密钥） */
  env?: Record<string, string>
  /** http：服务器 URL（streamable-http / SSE 自动识别） */
  url?: string
  /** http：附加请求头（可含 Authorization 等密钥） */
  headers?: Record<string, string>
}

/** 连接后发现的单个 MCP 工具（已带 mcp__前缀名） */
export interface McpToolInfo {
  name: string
  description: string
  /** JSON Schema 参数定义 */
  parameters: object
}

/** MCP 服务器运行状态 */
export interface McpServerStatus {
  id: string
  name: string
  transport: McpTransportType
  enabled: boolean
  state: 'connecting' | 'connected' | 'error' | 'disabled'
  toolCount: number
  /** 连接成功时返回该服务器提供的工具清单 */
  tools: McpToolInfo[]
  error?: string
}

/** MCP 插件市场条目的连接配置（解析自 mcp-cn.com 的 connections 字段） */
export interface McpMarketConnection {
  type: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/** MCP 插件市场（mcp-cn.com / MCP Hub 中国版）的服务器条目 */
export interface McpMarketServer {
  id: string
  name: string
  qualifiedName: string
  description: string
  logo: string | null
  creator: string
  useCount: number
  tags: string[]
  isDomestic: boolean
  packageUrl: string | null
  connection: McpMarketConnection | null
}

// ── 热土引擎（REngine）账号系统 ──

/** 热土用户信息 */
export interface RtUser {
  id: number
  uuid?: string
  username: string
  email?: string
  emailVerified?: boolean
  isBetaUser?: boolean
}

/** 账号登录态 */
export interface AccountStatus {
  loggedIn: boolean
  user?: RtUser
  lastSyncAt: { memory?: number; models?: number }
}

/** 可同步的数据种类 */
export type AccountSyncKind = 'memory' | 'models'

/** 单项同步结果 */
export interface AccountSyncResultItem {
  kind: AccountSyncKind
  ok: boolean
  error?: string
  skipped?: boolean
}

/** 从云端下载的模型配置（providers 含 apiKey） */
export interface DownloadedModelConfig {
  providers: import('./agent').ModelProvider[]
  activeProviderId?: string
  activeModelId?: string
}

/** 下载同步结果（models 仅当请求包含 'models' 且成功时返回） */
export interface AccountSyncDownloadResult {
  results: AccountSyncResultItem[]
  models?: DownloadedModelConfig
}

// ── VIBE 氛围模式 ──

/** 玻璃模式实际生效的渲染轨道 */
export type VibeGlassTrack = 'acrylic' | 'transparent' | 'fallback'

/** 系统媒体会话（SMTC）状态快照 */
export interface SystemMediaState {
  /** 当前是否存在活跃的系统媒体会话 */
  available: boolean
  title?: string
  artist?: string
  album?: string
  /** Playing / Paused / Stopped / Changing */
  status?: string
  positionMs?: number
  durationMs?: number
  /** 专辑封面 data URL（仅切歌时更新一次，避免高频大流量） */
  cover?: string
  /** 系统主音量 0-100 */
  volume?: number
}

/** 系统媒体控制命令 */
export type VibeMediaCommand =
  | { type: 'toggle' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'seek'; positionMs: number }
  | { type: 'volume'; volume: number }

// ── 内置工作台（Trae 式右侧面板坞） ──

/** 创建 PTY 终端的入参（仅桌面端可用） */
export interface PtyCreateInfo {
  /** 渲染层生成的终端实例 id（与工作台标签 id 一致） */
  id: string
  cwd?: string
  cols?: number
  rows?: number
}

export interface ClerkBoxAPI {
  selectFolder: () => Promise<string | null>
  selectImageFile: () => Promise<string | null>
  selectChatFiles: () => Promise<string[] | null>
  /** 按磁盘路径读取图片文件，返回 base64 data URL */
  readImageFileBase64: (path: string) => Promise<string>
  /** 按磁盘路径读取预览文件，返回 base64 内容和 MIME 类型 */
  readFileBase64: (path: string) => Promise<{ data: string; mimeType: string; size: number }>
  selectAudioFile: () => Promise<string | null>
  selectMusicFolder: () => Promise<string | null>
  fileExists: (path: string) => Promise<boolean>
  /** 取 File 对应的磁盘绝对路径（Electron 42 起 File.path 已移除，须走 webUtils） */
  getPathForFile: (file: File) => string
  openExternal: (url: string) => Promise<void>
  confirmDialog: (title: string, message: string) => Promise<boolean>
  windowAction: (action: 'minimize' | 'maximize' | 'close') => void
  isWindowMaximized: boolean
  onWindowStateChange: (callback: (isMaximized: boolean) => void) => () => void
  /** 订阅内嵌浏览器的 target="_blank" / window.open 请求 */
  onBrowserNewTab: (callback: (url: string) => void) => () => void
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  selectSkillFile: () => Promise<string | null>
  parseSkillFile: (filePath: string) => Promise<ParseSkillFileResult>
  listDir: (path: string) => Promise<FileEntry[]>
  executeCommand: (command: string, cwd?: string, sessionId?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean; timedOut?: boolean }>
  executeCommandWithShell: (command: string, cwd: string | undefined, shellType: string, sessionId?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean; timedOut?: boolean }>
  cancelSessionCommands: (sessionId: string) => Promise<{ killed: number }>
  webSearch: (query: string, count?: number) => Promise<WebSearchResult[] | { error: string }>
  webFetch: (url: string, maxLength?: number) => Promise<{ content: string; url: string } | { error: string }>
  apiFetchModels: (cfg: ApiConnConfig) => Promise<{ models: FetchedModel[] } | { error: string }>
  apiTestConnection: (cfg: ApiConnConfig) => Promise<{ ok: true; latencyMs: number } | { error: string }>
  /** 探测模型图片输入支持：发纯色 PNG 并验证回复内容（HTTP 200 不代表支持，需模型真的说出颜色）。
   *  supported: true=确认支持 / false=确认不支持 / null=无法判定（保持现值） */
  apiTestVision: (cfg: ApiConnConfig, modelId: string) => Promise<{ ok: true; supported: boolean | null; reply?: string } | { ok: false; status?: number; error: string }>
  apiChatStream: (cfg: ApiConnConfig, body: unknown) => Promise<{ requestId: string }>
  apiAbort: (requestId: string) => Promise<void>
  onApiChunk: (callback: (payload: ApiChunkPayload) => void) => () => void
  loadApiKeys: () => Promise<Record<string, string>>
  saveApiKey: (id: string, apiKey: string) => Promise<void>
  removeApiKey: (id: string) => Promise<void>
  scanMemory: (workingDir: string) => Promise<MemoryEntry[]>
  scanAgents: (workingDir: string) => Promise<Array<{ filename: string; content: string }>>
  readMemoryIndex: (workingDir: string) => Promise<{ content: string; wasTruncated: boolean; reason?: string }>
  writeMemoryFile: (workingDir: string, slug: string, frontmatter: string, content: string) => Promise<void>
  updateMemoryIndex: (workingDir: string, entryLine: string, slug: string) => Promise<void>
  searchMemoryFiles: (workingDir: string, query?: string, type?: string) => Promise<MemoryEntry[]>
  dbCreateSession: (row: SessionRow) => Promise<void>
  dbUpdateSessionTitle: (id: string, title: string, updatedAt: number) => Promise<void>
  dbDeleteSession: (id: string) => Promise<void>
  dbGetAllSessions: () => Promise<SessionRow[]>
  dbGetRecents: () => Promise<string[]>
  dbGetRevision: () => Promise<number>
  dbSetRecents: (recents: string[]) => Promise<void>
  dbAddMessage: (row: MessageRow) => Promise<void>
  dbUpdateMessage: (id: string, content: string, toolCalls?: string, toolResults?: string, thinkingContent?: string | null, finishReason?: string | null) => Promise<void>
  dbGetMessages: (sessionId: string) => Promise<MessageRow[]>
  dbDeleteMessagesBefore: (sessionId: string, beforeId: string) => Promise<void>
  dbClearMessages: (sessionId: string) => Promise<void>
  /** 原子压缩：单次写入内整体替换该会话的全部消息（compactSession 专用） */
  dbCompactMessages: (sessionId: string, rows: MessageRow[]) => Promise<void>
  initClerkbox: (projectDir: string) => Promise<void>
  writeSkillMd: (projectDir: string, slug: string, content: string) => Promise<void>
  writeSkillDir: (projectDir: string, slug: string, files: Array<{ path: string; content: string }>) => Promise<void>
  removeSkillDir: (projectDir: string, slug: string) => Promise<void>
  skillsSearch: (query: string, page?: number, limit?: number) => Promise<string>
  fetchSkillMd: (githubUrl: string) => Promise<string>
  fetchSkillFromRepo: (githubUrl: string) => Promise<string>
  scanSkillDirs: (workingDir: string) => Promise<string>
  platform: string
  homeDir: string
  // WebUI 控制
  startWebUI: (lanAccess?: boolean) => Promise<{ port: number; token: string; url: string } | { error: string }>
  stopWebUI: () => Promise<{ ok: boolean }>
  getWebUIStatus: () => Promise<{ running: boolean; url?: string }>
  getLanAddresses: () => Promise<string[]>
  // 共享 KV 存储（Electron 与 WebUI 双模式同步持久化）
  kvGet: (key: string) => Promise<string | null>
  kvSet: (key: string, value: string) => Promise<void>
  kvRemove: (key: string) => Promise<void>
  // MCP 服务器（Model Context Protocol）
  /** 全量同步服务器配置（主进程按需建立/断开连接），返回最新状态 */
  mcpSync: (servers: McpServerConfig[]) => Promise<McpServerStatus[]>
  /** 查询所有服务器当前状态 */
  mcpStatus: () => Promise<McpServerStatus[]>
  /** 测试一条配置（临时连接，完成后断开，不落入常驻连接池） */
  mcpTest: (server: McpServerConfig) => Promise<{ ok: true; toolCount: number; tools: Array<{ name: string; description: string }> } | { error: string }>
  /** 拉取所有已连接服务器提供的聚合工具清单（对话用） */
  mcpTools: () => Promise<McpToolInfo[]>
  /** 按 mcp__服务器__工具 全名调用工具 */
  mcpCallTool: (toolName: string, args: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>
  /** 订阅服务器状态变化；返回退订函数 */
  onMcpStatus: (callback: (statuses: McpServerStatus[]) => void) => () => void
  /** 拉取 MCP 插件市场服务器列表（mcp-cn.com 全量） */
  mcpSearch: () => Promise<{ servers: McpMarketServer[] } | { error: string }>
  // ── VIBE 氛围模式（玻璃特效 / 壁纸 / 系统媒体） ──
  /** 设置玻璃程度（0-100）。返回实际生效轨道：acrylic=系统亚克力 / transparent=全透明 / fallback=壁纸快照降级 */
  vibeGlassSet: (level: number) => Promise<{ track: VibeGlassTrack }>
  /** 关闭玻璃特效，恢复普通透明窗口 */
  vibeGlassClear: () => Promise<void>
  /** 读取当前桌面壁纸，返回 data URL（玻璃模式降级轨与 WebUI 模式使用） */
  vibeGetWallpaper: () => Promise<string | null>
  /** 获取系统正在播放的媒体状态（顺带确保主进程轮询助手已启动） */
  vibeMediaGetState: () => Promise<SystemMediaState | null>
  /** 发送媒体控制命令（播放/暂停/切歌/进度/音量） */
  vibeMediaCommand: (cmd: VibeMediaCommand) => Promise<boolean>
  /** 停止系统媒体轮询（离开系统音频模式时调用，主进程延迟回收） */
  vibeMediaStop: () => Promise<void>
  /** 订阅系统媒体状态变化（仅 Electron 模式有效，WebUI 需轮询）；返回退订函数 */
  onVibeMediaState: (callback: (state: SystemMediaState) => void) => () => void
  // 热土账号系统（登录 / 登出 / 数据段云同步）
  accountLogin: () => Promise<{ ok: true; status: AccountStatus } | { error: string }>
  accountLogout: () => Promise<void>
  accountGetStatus: () => Promise<AccountStatus>
  accountSyncUpload: (kinds: AccountSyncKind[]) => Promise<{ results: AccountSyncResultItem[] }>
  accountSyncDownload: (kinds: AccountSyncKind[], force: boolean) => Promise<AccountSyncDownloadResult>
  // ── 内置终端（node-pty 真 TTY，仅桌面端） ──
  ptyCreate: (info: PtyCreateInfo) => Promise<{ ok: boolean }>
  ptyInput: (id: string, data: string) => void
  ptyResize: (id: string, cols: number, rows: number) => void
  ptyKill: (id: string) => Promise<void>
  /** 订阅终端输出流；返回退订函数 */
  onPtyData: (callback: (id: string, data: string) => void) => () => void
  /** 订阅终端退出事件；返回退订函数 */
  onPtyExit: (callback: (id: string, exitCode: number) => void) => () => void
}

/** 模型 API 连接配置（主进程代理入参） */
export interface ApiConnConfig {
  baseUrl: string
  apiKey: string
  apiCompat: ApiCompat
}

/** 在线拉取到的一个模型 */
export interface FetchedModel {
  id: string
  label?: string
}

/** 流式分片事件负载 */
export interface ApiChunkPayload {
  requestId: string
  chunk?: string
  done?: boolean
  error?: string
}

/** parseSkillFile IPC 返回类型 */
export interface ParseSkillFileResult {
  success: boolean
  name?: string
  description?: string
  icon?: string
  category?: string
  skillMdContent?: string
  /** 技能包含的所有文件（含 SKILL.md 与子目录文件）；path 相对解压根目录 */
  files?: Array<{ path: string; content: string }>
  error?: string
}

declare global {
  interface Window {
    clerkbox: ClerkBoxAPI
  }
}
