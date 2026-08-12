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

export const ipc = {
  selectFolder: (): Promise<string | null> => window.clerkbox.selectFolder(),
  selectImageFile: (): Promise<string | null> => window.clerkbox.selectImageFile(),
  selectAudioFile: (): Promise<string | null> => window.clerkbox.selectAudioFile(),
  selectMusicFolder: (): Promise<string | null> => window.clerkbox.selectMusicFolder(),
  selectSkillFile: (): Promise<string | null> => window.clerkbox.selectSkillFile(),
  parseSkillFile: (filePath: string): Promise<ParseSkillFileResult> => window.clerkbox.parseSkillFile(filePath),
  fileExists: (path: string): Promise<boolean> => window.clerkbox.fileExists(path),
  openExternal: (url: string): Promise<void> => window.clerkbox.openExternal(url),
  confirmDialog: (title: string, message: string): Promise<boolean> => window.clerkbox.confirmDialog(title, message),
  readFile: (path: string): Promise<string> => window.clerkbox.readFile(path),
  writeFile: (path: string, content: string): Promise<void> =>
    window.clerkbox.writeFile(path, content),
  listDir: (path: string): Promise<FileEntry[]> => window.clerkbox.listDir(path),
  executeCommand: (command: string, cwd?: string, sessionId?: string): Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean }> =>
    window.clerkbox.executeCommand(command, cwd, sessionId),
  executeCommandWithShell: (command: string, cwd: string | undefined, shellType: string, sessionId?: string): Promise<{ stdout: string; stderr: string; exitCode: number; encodingFallback?: boolean }> =>
    window.clerkbox.executeCommandWithShell(command, cwd, shellType, sessionId),
  cancelSessionCommands: (sessionId: string): Promise<{ killed: number }> =>
    window.clerkbox.cancelSessionCommands(sessionId),
  webSearch: (query: string, count?: number): Promise<Array<{ title: string; snippet: string; url: string }> | { error: string }> =>
    window.clerkbox.webSearch(query, count),
  webFetch: (url: string, maxLength?: number): Promise<{ content: string; url: string } | { error: string }> =>
    window.clerkbox.webFetch(url, maxLength),
  // 模型 API 代理（主进程 fetch，绕开渲染进程同源策略）
  apiFetchModels: (cfg: ApiConnConfig): Promise<{ models: FetchedModel[] } | { error: string }> =>
    window.clerkbox.apiFetchModels(cfg),
  apiTestConnection: (cfg: ApiConnConfig): Promise<{ ok: true; latencyMs: number } | { error: string }> =>
    window.clerkbox.apiTestConnection(cfg),
  apiChatStream: (cfg: ApiConnConfig, body: unknown): Promise<{ requestId: string }> =>
    window.clerkbox.apiChatStream(cfg, body),
  apiAbort: (requestId: string): Promise<void> => window.clerkbox.apiAbort(requestId),
  onApiChunk: (callback: (payload: ApiChunkPayload) => void): (() => void) =>
    window.clerkbox.onApiChunk(callback),
  loadApiKeys: (): Promise<Record<string, string>> => window.clerkbox.loadApiKeys(),
  saveApiKey: (id: string, apiKey: string): Promise<void> => window.clerkbox.saveApiKey(id, apiKey),
  removeApiKey: (id: string): Promise<void> => window.clerkbox.removeApiKey(id),
  // Memory system
  scanMemory: (workingDir: string): Promise<MemoryEntry[]> =>
    window.clerkbox.scanMemory(workingDir),
  scanAgents: (workingDir: string) => window.clerkbox.scanAgents(workingDir),
  readMemoryIndex: (workingDir: string): Promise<{ content: string; wasTruncated: boolean; reason?: string }> =>
    window.clerkbox.readMemoryIndex(workingDir),
  writeMemoryFile: (workingDir: string, slug: string, frontmatter: string, content: string): Promise<void> =>
    window.clerkbox.writeMemoryFile(workingDir, slug, frontmatter, content),
  updateMemoryIndex: (workingDir: string, entryLine: string, slug: string): Promise<void> =>
    window.clerkbox.updateMemoryIndex(workingDir, entryLine, slug),
  searchMemoryFiles: (workingDir: string, query?: string, type?: string): Promise<MemoryEntry[]> =>
    window.clerkbox.searchMemoryFiles(workingDir, query, type),
  dbCreateSession: (row: SessionRow): Promise<void> => window.clerkbox.dbCreateSession(row),
  dbUpdateSessionTitle: (id: string, title: string, updatedAt: number): Promise<void> =>
    window.clerkbox.dbUpdateSessionTitle(id, title, updatedAt),
  dbDeleteSession: (id: string): Promise<void> => window.clerkbox.dbDeleteSession(id),
  dbGetAllSessions: (): Promise<SessionRow[]> => window.clerkbox.dbGetAllSessions(),
  dbGetRecents: (): Promise<string[]> => window.clerkbox.dbGetRecents(),
  dbSetRecents: (recents: string[]): Promise<void> => window.clerkbox.dbSetRecents(recents),
  dbAddMessage: (row: MessageRow): Promise<void> => window.clerkbox.dbAddMessage(row),
  dbUpdateMessage: (id: string, content: string, toolCalls?: string, toolResults?: string, thinkingContent?: string | null, finishReason?: string | null): Promise<void> =>
    window.clerkbox.dbUpdateMessage(id, content, toolCalls, toolResults, thinkingContent, finishReason),
  dbGetMessages: (sessionId: string): Promise<MessageRow[]> => window.clerkbox.dbGetMessages(sessionId),
  dbDeleteMessagesBefore: (sessionId: string, beforeId: string): Promise<void> =>
    window.clerkbox.dbDeleteMessagesBefore(sessionId, beforeId),
  dbClearMessages: (sessionId: string): Promise<void> =>
    window.clerkbox.dbClearMessages(sessionId),
  // .clerkbox operations
  initClerkbox: (projectDir: string): Promise<void> => window.clerkbox.initClerkbox(projectDir),
  writeSkillMd: (projectDir: string, slug: string, content: string): Promise<void> =>
    window.clerkbox.writeSkillMd(projectDir, slug, content),
  writeSkillDir: (projectDir: string, slug: string, files: Array<{ path: string; content: string }>): Promise<void> =>
    window.clerkbox.writeSkillDir(projectDir, slug, files),
  removeSkillDir: (projectDir: string, slug: string): Promise<void> =>
    window.clerkbox.removeSkillDir(projectDir, slug),
  skillsSearch: (query: string, page?: number, limit?: number): Promise<string> =>
    window.clerkbox.skillsSearch(query, page, limit),
  fetchSkillMd: (githubUrl: string): Promise<string> =>
    window.clerkbox.fetchSkillMd(githubUrl),
  fetchSkillFromRepo: (githubUrl: string): Promise<string> =>
    window.clerkbox.fetchSkillFromRepo(githubUrl),
  scanSkillDirs: (workingDir: string): Promise<string> =>
    window.clerkbox.scanSkillDirs(workingDir),
  windowAction: (action: 'minimize' | 'maximize' | 'close'): void => window.clerkbox.windowAction(action),
  platform: () => window.clerkbox.platform,
  homeDir: () => window.clerkbox.homeDir,
}
