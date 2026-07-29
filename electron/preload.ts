import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('clerkbox', {
  // File system
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('selectFolder'),
  selectImageFile: (): Promise<string | null> => ipcRenderer.invoke('selectImageFile'),
  selectAudioFile: (): Promise<string | null> => ipcRenderer.invoke('selectAudioFile'),
  selectMusicFolder: (): Promise<string | null> => ipcRenderer.invoke('selectMusicFolder'),
  selectSkillFile: (): Promise<string | null> => ipcRenderer.invoke('selectSkillFile'),
  parseSkillFile: (filePath: string): Promise<{ success: boolean; name?: string; description?: string; icon?: string; category?: string; skillMdContent?: string; files?: Array<{ path: string; content: string }>; error?: string }> =>
    ipcRenderer.invoke('parseSkillFile', filePath),
  fileExists: (path: string): Promise<boolean> => ipcRenderer.invoke('fileExists', path),
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
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    ipcRenderer.invoke('executeCommand', command, cwd),
  executeCommandWithShell: (
    command: string,
    cwd: string | undefined,
    shellType: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    ipcRenderer.invoke('executeCommandWithShell', command, cwd, shellType),

  // Web
  webSearch: (query: string, count?: number): Promise<any> =>
    ipcRenderer.invoke('webSearch', query, count),
  webFetch: (url: string, maxLength?: number): Promise<any> =>
    ipcRenderer.invoke('webFetch', url, maxLength),

  // Memory system
  scanMemory: (workingDir: string): Promise<any[]> =>
    ipcRenderer.invoke('scanMemory', workingDir),
  scanAgents: (workingDir: string) => ipcRenderer.invoke('scanAgents', workingDir),
  readMemoryIndex: (workingDir: string): Promise<{ content: string; wasTruncated: boolean; reason?: string }> =>
    ipcRenderer.invoke('readMemoryIndex', workingDir),
  writeMemoryFile: (workingDir: string, slug: string, frontmatter: string, content: string): Promise<void> =>
    ipcRenderer.invoke('writeMemoryFile', workingDir, slug, frontmatter, content),
  updateMemoryIndex: (workingDir: string, entryLine: string, slug: string): Promise<void> =>
    ipcRenderer.invoke('updateMemoryIndex', workingDir, entryLine, slug),
  searchMemoryFiles: (workingDir: string, query?: string, type?: string): Promise<any[]> =>
    ipcRenderer.invoke('searchMemoryFiles', workingDir, query, type),

  // Database
  dbCreateSession: (row: any): Promise<void> => ipcRenderer.invoke('dbCreateSession', row),
  dbUpdateSessionTitle: (id: string, title: string, updatedAt: number): Promise<void> =>
    ipcRenderer.invoke('dbUpdateSessionTitle', id, title, updatedAt),
  dbDeleteSession: (id: string): Promise<void> => ipcRenderer.invoke('dbDeleteSession', id),
  dbGetAllSessions: (): Promise<any[]> => ipcRenderer.invoke('dbGetAllSessions'),
  dbAddMessage: (row: any): Promise<void> => ipcRenderer.invoke('dbAddMessage', row),
  dbUpdateMessage: (
    id: string,
    content: string,
    toolCalls?: string,
    toolResults?: string,
    thinkingContent?: string | null,
    finishReason?: string | null
  ): Promise<void> =>
    ipcRenderer.invoke('dbUpdateMessage', id, content, toolCalls, toolResults, thinkingContent, finishReason),
  dbGetMessages: (sessionId: string): Promise<any[]> =>
    ipcRenderer.invoke('dbGetMessages', sessionId),
  dbDeleteMessagesBefore: (sessionId: string, beforeId: string): Promise<void> =>
    ipcRenderer.invoke('dbDeleteMessagesBefore', sessionId, beforeId),
  dbClearMessages: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('dbClearMessages', sessionId),

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
  // S7: sandbox: true 后 preload 无法直接 require('os')，改用同步 IPC 获取。
  platform: ipcRenderer.sendSync('getPlatform'),
  homeDir: ipcRenderer.sendSync('getHomeDir'),
})
