import type { ApiCompat, MemoryEntry, MemoryType } from './agent'

export interface FileEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

export interface SessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
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
  finish_reason?: string | null
  is_compact?: number  // 0 or 1 — marks compact boundary/summary messages
  is_sub_agent_card?: number  // 0 or 1 — marks sub-agent card placeholder messages
  sub_agent_id?: string | null  // associated sub-agent run id
}

export interface WebSearchResult {
  title: string
  snippet: string
  url: string
}

export interface ClerkBoxAPI {
  selectFolder: () => Promise<string | null>
  selectImageFile: () => Promise<string | null>
  selectAudioFile: () => Promise<string | null>
  selectMusicFolder: () => Promise<string | null>
  fileExists: (path: string) => Promise<boolean>
  openExternal: (url: string) => Promise<void>
  confirmDialog: (title: string, message: string) => Promise<boolean>
  windowAction: (action: 'minimize' | 'maximize' | 'close') => void
  isWindowMaximized: boolean
  onWindowStateChange: (callback: (isMaximized: boolean) => void) => () => void
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  selectSkillFile: () => Promise<string | null>
  parseSkillFile: (filePath: string) => Promise<ParseSkillFileResult>
  listDir: (path: string) => Promise<FileEntry[]>
  executeCommand: (command: string, cwd?: string, sessionId?: string) => Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean }>
  executeCommandWithShell: (command: string, cwd: string | undefined, shellType: string, sessionId?: string) => Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean }>
  cancelSessionCommands: (sessionId: string) => Promise<{ killed: number }>
  webSearch: (query: string, count?: number) => Promise<WebSearchResult[] | { error: string }>
  webFetch: (url: string, maxLength?: number) => Promise<{ content: string; url: string } | { error: string }>
  apiFetchModels: (cfg: ApiConnConfig) => Promise<{ models: FetchedModel[] } | { error: string }>
  apiTestConnection: (cfg: ApiConnConfig) => Promise<{ ok: true; latencyMs: number } | { error: string }>
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
  dbSetRecents: (recents: string[]) => Promise<void>
  dbAddMessage: (row: MessageRow) => Promise<void>
  dbUpdateMessage: (id: string, content: string, toolCalls?: string, toolResults?: string, thinkingContent?: string | null, finishReason?: string | null) => Promise<void>
  dbGetMessages: (sessionId: string) => Promise<MessageRow[]>
  dbDeleteMessagesBefore: (sessionId: string, beforeId: string) => Promise<void>
  dbClearMessages: (sessionId: string) => Promise<void>
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
  startWebUI: () => Promise<{ port: number; token: string; url: string } | { error: string }>
  stopWebUI: () => Promise<{ ok: boolean }>
  getWebUIStatus: () => Promise<{ running: boolean; url?: string }>
  // 共享 KV 存储（Electron 与 WebUI 双模式同步持久化）
  kvGet: (key: string) => Promise<string | null>
  kvSet: (key: string, value: string) => Promise<void>
  kvRemove: (key: string) => Promise<void>
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
