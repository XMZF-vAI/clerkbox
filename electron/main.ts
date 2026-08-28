import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  safeStorage,
} from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { spawn } from 'child_process'
import * as iconv from 'iconv-lite'
import * as https from 'https'
import * as http from 'http'
import * as net from 'net'
import * as dns from 'dns'
import * as os from 'os'
import * as cheerio from 'cheerio'
import * as yaml from 'js-yaml'
import { registerApiProxyHandlers, bindApiProxyCleanup, startChatStream, abortChatStream, type ApiConnConfig } from './api-proxy'
import { handlerRegistry, setStreamHandlers, startWebUI, stopWebUI, getWebUIStatus, getLanAddresses } from './webui-server'
import * as rtAccount from './rt-account'
import { mcpManager } from './mcp-manager'
import { winAcrylic } from './win-acrylic'
import { systemMedia } from './system-media'
import { registerTerminalHandlers, disposeAllTerminals } from './terminal'
import type { AccountSyncKind, McpMarketConnection, McpServerConfig, SystemMediaState, VibeGlassTrack } from '../src/types/ipc'

const SKILL_REQUEST_TIMEOUT_MS = 15_000
const MAX_SKILL_FILE_BYTES = 512 * 1024
const MAX_SKILL_TREE_BYTES = 5 * 1024 * 1024
const MAX_SKILL_FILES = 50
const MAX_SKILL_DIRECTORY_BYTES = 2 * 1024 * 1024
const MAX_SKILL_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_SKILL_SCAN_ENTRIES = 1_000
const MAX_CUSTOM_AGENT_FILES = 100
const MAX_CUSTOM_AGENT_FILE_BYTES = 512 * 1024
const MAX_MEMORY_FILE_BYTES = 1024 * 1024
const MAX_MEMORY_INDEX_BYTES = 25_000
const MAX_API_KEY_BYTES = 16 * 1024

/** Reject archives whose metadata exceeds extraction limits before invoking an OS extractor. */
function assertSafeSkillArchive(filePath: string): void {
  const archive = fs.readFileSync(filePath)
  const endOfCentralDirectory = 0x06054b50
  const centralDirectoryHeader = 0x02014b50
  const minimumEocdSize = 22
  if (archive.length < minimumEocdSize) throw new Error('Invalid ZIP archive')

  const searchStart = Math.max(0, archive.length - minimumEocdSize - 0xffff)
  let eocdOffset = -1

  for (let offset = archive.length - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === endOfCentralDirectory) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset === -1) throw new Error('Invalid ZIP archive')

  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8)
  const totalEntries = archive.readUInt16LE(eocdOffset + 10)
  const centralDirectorySize = archive.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16)
  if (
    entriesOnDisk === 0xffff ||
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error('ZIP64 archives are not supported for skill imports')
  }
  if (entriesOnDisk !== totalEntries || totalEntries === 0 || totalEntries > MAX_SKILL_FILES) {
    throw new Error(`Archive entry count must be between 1 and ${MAX_SKILL_FILES}`)
  }
  if (centralDirectoryOffset + centralDirectorySize > eocdOffset) {
    throw new Error('Invalid ZIP central directory')
  }

  let offset = centralDirectoryOffset
  let totalUncompressedBytes = 0
  for (let index = 0; index < totalEntries; index += 1) {
    const minimumHeaderSize = 46
    if (offset + minimumHeaderSize > eocdOffset || archive.readUInt32LE(offset) !== centralDirectoryHeader) {
      throw new Error('Invalid ZIP central directory entry')
    }
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const filenameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const externalAttributes = archive.readUInt32LE(offset + 38)
    const entryLength = minimumHeaderSize + filenameLength + extraLength + commentLength
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      offset + entryLength > eocdOffset
    ) {
      throw new Error('Invalid or ZIP64 archive entry')
    }

    const filename = archive.subarray(offset + minimumHeaderSize, offset + minimumHeaderSize + filenameLength).toString('utf-8')
    const normalizedFilename = filename.replace(/\\/g, '/')
    const pathSegments = normalizedFilename.split('/').filter(Boolean)
    const unixFileType = (externalAttributes >>> 16) & 0xf000
    if (
      !filename ||
      filename.includes('\0') ||
      normalizedFilename.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalizedFilename) ||
      pathSegments.some((segment) => segment === '.' || segment === '..') ||
      unixFileType === 0xa000
    ) {
      throw new Error('Archive contains an unsafe entry path')
    }

    totalUncompressedBytes += uncompressedSize
    if (totalUncompressedBytes > MAX_SKILL_DIRECTORY_BYTES) {
      throw new Error(`Archive expands beyond the ${MAX_SKILL_DIRECTORY_BYTES} byte limit`)
    }
    offset += entryLength
  }
}

interface GitHubRepositoryReference {
  owner: string
  repo: string
  kind?: 'tree' | 'blob'
  branch?: string
  subPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse a GitHub repository URL before interpolating it into an API endpoint. */
function parseGitHubRepositoryUrl(input: string): GitHubRepositoryReference | null {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname)) {
      return null
    }

    const rawSegments = url.pathname.split('/').filter(Boolean)
    if (rawSegments.length < 2) return null
    const segments = rawSegments.map((segment) => decodeURIComponent(segment))
    const [owner, rawRepo, route, branch, ...subPathSegments] = segments
    const repo = rawRepo.replace(/\.git$/i, '')
    const isRepositorySegment = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
    const isSafePathSegment = (value: string) =>
      value.length > 0 && value.length <= 255 && value !== '.' && value !== '..' && !/[\\/\0]/.test(value)

    if (!isRepositorySegment(owner) || !isRepositorySegment(repo)) return null
    if (route !== undefined && route !== 'tree' && route !== 'blob') {
      return { owner, repo, subPath: '' }
    }
    if (route && (!branch || !isSafePathSegment(branch))) return null
    if (!subPathSegments.every(isSafePathSegment)) return null

    return {
      owner,
      repo,
      kind: route,
      branch,
      subPath: subPathSegments.join('/'),
    }
  } catch {
    return null
  }
}

/** Fetch a bounded HTTPS response and release non-successful response streams. */
function fetchHttpsText(
  url: string,
  headers: Record<string, string>,
  maxBytes: number = MAX_SKILL_FILE_BYTES,
  maxRedirects: number = 5
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      const statusCode = response.statusCode ?? 0
      // 跟随 3xx 重定向（如 /skills → /）
      if (statusCode >= 300 && statusCode < 400 && response.headers.location && maxRedirects > 0) {
        response.resume()
        const redirectUrl = new URL(response.headers.location, url).href
        resolve(fetchHttpsText(redirectUrl, headers, maxBytes, maxRedirects - 1))
        return
      }
      if (statusCode !== 200) {
        response.resume()
        resolve({ statusCode, body: '' })
        return
      }

      const chunks: Buffer[] = []
      let receivedBytes = 0
      response.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length
        if (receivedBytes > maxBytes) {
          response.destroy(new Error(`Response exceeds ${maxBytes} byte limit`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ statusCode, body: Buffer.concat(chunks).toString('utf-8') }))
      response.on('error', reject)
    })

    request.setTimeout(SKILL_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Request timed out')))
    request.on('error', reject)
  })
}

/**
 * 宽松 JSON 解析：mcp-cn.com 的 connections 字段是「无引号的 JSON」字符串，
 * 如 [{type:stdio,config:{command:npx,args:[-y,@scope/pkg],env:{KEY:<your-key>}}}]。
 * 标准 JSON.parse 会失败，这里先分词（标点单独成 token，字面量一律加引号），
 * 再用递归下降还原成对象。键/值靠栈区分：对象内紧跟 '{' 或 ',' 的是键（扫描到 ':' 截止），
 * 值不做冒号断词（保住 https:// 里的冒号）。
 */
function parseLenientJson(raw: string): unknown {
  const tokens: string[] = []
  const stack: string[] = []
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '{' || ch === '[') {
      tokens.push(ch)
      stack.push(ch)
      i++
    } else if (ch === '}' || ch === ']') {
      tokens.push(ch)
      stack.pop()
      i++
    } else if (ch === ',' || ch === ':') {
      tokens.push(ch)
      i++
    } else if (/\s/.test(ch)) {
      i++
    } else {
      const last = tokens[tokens.length - 1]
      const isKey = stack[stack.length - 1] === '{' && (last === '{' || last === ',')
      let j = i
      while (j < raw.length) {
        const c = raw[j]
        if (c === ',' || c === '}' || c === ']') break
        if (isKey && c === ':') break
        j++
      }
      const value = raw.slice(i, j).trim()
      if (value) tokens.push(JSON.stringify(value))
      i = j
    }
  }

  let pos = 0
  const parseValue = (): unknown => {
    const tok = tokens[pos]
    if (tok === undefined) return undefined
    if (tok === '{') return parseObject()
    if (tok === '[') return parseArray()
    pos++
    try {
      return JSON.parse(tok)
    } catch {
      return tok
    }
  }
  const parseObject = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {}
    pos++ // consume '{'
    while (pos < tokens.length && tokens[pos] !== '}') {
      if (tokens[pos] === ',') {
        pos++
        continue
      }
      const keyToken = tokens[pos]
      pos++
      if (tokens[pos] === ':') pos++
      let key: string
      try {
        key = JSON.parse(keyToken) as string
      } catch {
        key = String(keyToken)
      }
      obj[key] = parseValue()
    }
    pos++ // consume '}'
    return obj
  }
  const parseArray = (): unknown[] => {
    const arr: unknown[] = []
    pos++ // consume '['
    while (pos < tokens.length && tokens[pos] !== ']') {
      if (tokens[pos] === ',') {
        pos++
        continue
      }
      arr.push(parseValue())
    }
    pos++ // consume ']'
    return arr
  }
  return parseValue()
}

/** Resolve path relative to project root */
function projectRoot(...segments: string[]): string {
  return path.resolve(app.getAppPath(), ...segments)
}

/** 递归查找目录下的 SKILL.md（优先根级，其次任意层级，大小写不敏感） */
function findSkillMd(dir: string, budget: { remaining: number } = { remaining: MAX_SKILL_SCAN_ENTRIES }): string | null {
  if (budget.remaining <= 0) return null
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  // 优先：根级 SKILL.md
  for (const e of entries) {
    if (--budget.remaining < 0) return null
    if (e.isFile() && /^skill\.md$/i.test(e.name)) {
      return path.join(dir, e.name)
    }
  }
  // 其次：递归子目录
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findSkillMd(path.join(dir, e.name), budget)
      if (found) return found
    }
  }
  return null
}

/** 递归列出目录下所有文件相对路径（用于错误提示） */
function listEntries(
  dir: string,
  base: string = '',
  out: string[] = [],
  budget: { remaining: number } = { remaining: MAX_SKILL_SCAN_ENTRIES }
): string[] {
  if (out.length >= 20 || budget.remaining <= 0) return out
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (out.length >= 20 || --budget.remaining < 0) return out
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      listEntries(path.join(dir, e.name), rel, out, budget)
    } else {
      out.push(rel)
    }
  }
  return out
}

/** 解析 SKILL.md 的 YAML frontmatter，失败时回退到正文元数据 */
function parseSkillMd(content: string): {
  name: string
  description: string
  icon: string
  category: string
  triggerKeywords: string[]
  version: string
  author: string
  chainsTo: string[]
} {
  const lines = content.split('\n')
  let name = ''
  let description = ''
  let icon = '⚡'
  let category: string = 'custom'
  let triggerKeywords: string[] = []
  let version = ''
  let author = ''
  let chainsTo: string[] = []

  // 辅助：把 trigger_keywords / chains_to 规范化为 string[]
  const normalizeStrList = (v: unknown): string[] => {
    if (v == null) return []
    if (typeof v === 'string') return [v]
    if (Array.isArray(v)) return v.map((x) => String(x))
    return []
  }

  // 尝试 YAML frontmatter
  if (lines[0]?.trim() === '---') {
    const end = lines.slice(1).findIndex((l) => l.trim() === '---')
    if (end !== -1) {
      const front = lines.slice(1, end + 1).join('\n')
      try {
        const parsed = yaml.load(front) as Record<string, unknown> | null | undefined
        if (parsed && typeof parsed === 'object') {
          const getStr = (key: string) => {
            const v = parsed[key]
            return typeof v === 'string' ? v.trim() : v == null ? '' : String(v)
          }
          name = getStr('name')
          description = getStr('description')
          icon = getStr('icon') || '⚡'
          category = getStr('category') || 'custom'
          triggerKeywords = normalizeStrList(parsed['trigger_keywords'])
          version = getStr('version')
          author = getStr('author')
          chainsTo = normalizeStrList(parsed['chains_to'])
        } else {
          // 解析为空/非对象：回退到正则
          throw new Error('empty frontmatter')
        }
      } catch {
        // yaml.load 失败：回退到正则提取 name/description（保证健壮性）
        const get = (key: string) => {
          const m = front.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm'))
          return m?.[1]?.trim().replace(/^["']|["']$/g, '') || ''
        }
        name = get('name')
        description = get('description')
        icon = get('icon') || '⚡'
        category = get('category') || 'custom'
      }
    }
  }

  // 回退：第一级 Markdown 标题作为名称，第一段作为描述
  if (!name) {
    const titleMatch = content.match(/^#\s+(.+)$/m)
    name = titleMatch?.[1]?.trim() || '自定义技能'
  }
  if (!description) {
    const body = content.replace(/^---[\s\S]*?---/, '').trim()
    const firstPara = body.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'))
    description = firstPara?.slice(0, 100) || '用户自定义技能'
  }

  return { name, description, icon, category, triggerKeywords, version, author, chainsTo }
}

let mainWindow: BrowserWindow | null = null

/** Keep provider credentials encrypted by the OS instead of in renderer localStorage. */
function credentialStorePath(): string {
  return path.join(app.getPath('userData'), 'clerkbox-credentials.json')
}

function assertCredentialId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error('Invalid credential identifier')
  }
  return value
}

function readCredentialStore(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(credentialStorePath(), 'utf-8'))
    if (!isRecord(parsed)) return {}
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => /^[A-Za-z0-9._-]{1,128}$/.test(entry[0]) && typeof entry[1] === 'string'
    )
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

function writeCredentialStore(store: Record<string, string>): void {
  const destination = credentialStorePath()
  const temporary = `${destination}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(temporary, JSON.stringify(store), 'utf-8')
  try {
    fs.renameSync(temporary, destination)
  } catch (error) {
    try {
      fs.copyFileSync(temporary, destination)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
    if (!fs.existsSync(destination)) throw error
  }
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('System credential encryption is unavailable')
  }
}

function createWindow() {
  const preloadPath = projectRoot('dist-electron/electron/preload.js')
  const devUrl = process.env.VITE_DEV_SERVER_URL

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    transparent: true,
    backgroundColor: '#00000000',
    icon: projectRoot('build/icon.ico'),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 工作台浏览器面板需要内嵌 <webview>
      webviewTag: true,
    },
  })

  const openInBrowser = (url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(parsed.toString())
      }
    } catch {
      // Ignore malformed popup URLs instead of navigating the application window.
    }
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url)
    return { action: 'deny' }
  })

  const trustedOrigin = devUrl ? new URL(devUrl).origin : null
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url)
      const isTrusted = trustedOrigin
        ? parsed.origin === trustedOrigin
        : parsed.protocol === 'file:'
      if (isTrusted) return
    } catch {
      // Fall through and block malformed navigation targets.
    }
    event.preventDefault()
    openInBrowser(url)
  })

  // Dev or production URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(projectRoot('dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    // 窗口销毁：玻璃特效随窗口消失，系统媒体轮询随之停止（管理器保持可复用）
    winAcrylic.terminate()
    systemMedia.terminate()
  })

  // MCP 状态变化通过该窗口推送给渲染进程
  mcpManager.setMainWindow(mainWindow)

  // 系统媒体状态变化通过该窗口推送给渲染进程
  systemMedia.setMainWindow(mainWindow)

  // 窗口销毁 / reload 时掐掉在途的模型 API 流式请求
  bindApiProxyCleanup(mainWindow)

  // 圆角窗口：向渲染进程同步最大化状态（最大化时取消圆角）
  const sendWindowState = () => {
    mainWindow?.webContents.send('windowStateChanged', mainWindow.isMaximized())
  }
  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)
  mainWindow.webContents.on('did-finish-load', sendWindowState)
}

// 记忆条目结构（与 src/types/agent.ts 中的 MemoryEntry 保持一致）
interface MemoryEntry {
  filename: string
  name: string
  description: string | null
  type: 'user' | 'feedback' | 'project' | 'reference' | undefined
  content: string
  mtime: number
}

// ── VIBE 氛围模式：壁纸读取（玻璃模式降级轨） ──

const MAX_WALLPAPER_BYTES = 16 * 1024 * 1024
let wallpaperCache: { dataUrl: string; mtimeMs: number; size: number } | null = null

/** 解析当前桌面壁纸文件路径：优先 TranscodedWallpaper（实际显示内容），回退注册表 */
async function resolveWallpaperPath(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const transcoded = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')
    : null
  if (transcoded && fs.existsSync(transcoded)) return transcoded
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn('reg.exe', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'], { windowsHide: true })
      let out = ''
      child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf-8') })
      child.once('error', reject)
      child.once('exit', () => resolve(out))
    })
    const match = result.match(/WallPaper\s+REG_SZ\s+(.+)/i)
    const registryPath = match?.[1]?.trim()
    if (registryPath && fs.existsSync(registryPath)) return registryPath
  } catch {
    // 注册表读取失败：按无壁纸处理
  }
  return null
}

function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return null
}

// ── IPC Handlers ──

/** Serialize memory writes so concurrent updates cannot overwrite each other. */
const memWriteQueue: Promise<unknown>[] = []
function enqueueMemWrite<T>(op: () => Promise<T> | T): Promise<T> {
  const promise = (memWriteQueue.length > 0 ? memWriteQueue[memWriteQueue.length - 1] : Promise.resolve()).then(
    op,
    op
  )
  memWriteQueue.push(promise)
  void promise.then(() => {
    const idx = memWriteQueue.indexOf(promise)
    if (idx !== -1) memWriteQueue.splice(idx, 1)
  }, () => {
    const idx = memWriteQueue.indexOf(promise)
    if (idx !== -1) memWriteQueue.splice(idx, 1)
  })
  return promise
}

function registerIpcHandlers() {
  // Dialogs remain usable while the main window is closing or has not been created.
  const showOpenDialogSafe = (options: Electron.OpenDialogOptions) =>
    mainWindow && !mainWindow.isDestroyed()
      ? dialog.showOpenDialog(mainWindow, options)
      : dialog.showOpenDialog(options)
  const showMessageBoxSafe = (options: Electron.MessageBoxOptions) =>
    mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBox(mainWindow, options)
      : dialog.showMessageBox(options)

  // ── WebUI handler 注册表：monkey-patch ipcMain.handle，让所有 handler 自动同步到 WebUI ──
  // 这样 46 个 handler 无需逐个手动注册，WebUI 的 /api/invoke 可直接调用同一份业务逻辑。
  const originalHandle = ipcMain.handle.bind(ipcMain)
  const patchedHandle = (channel: string, listener: (...args: unknown[]) => unknown) => {
    handlerRegistry.set(channel, listener)
    return originalHandle(channel, listener as (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown)
  }
  ipcMain.handle = patchedHandle as typeof ipcMain.handle

  // 流式对话桥接：WebUI 的 /api/chat-stream 走 SSE，复用 startChatStream / abortChatStream
  setStreamHandlers(
    (cfg, body, requestId, send) => startChatStream(cfg as ApiConnConfig, body, requestId, send),
    abortChatStream
  )

  // 模型 API 代理（拉模型列表 / 测连接 / 流式对话 / 中止）
  registerApiProxyHandlers()

  // 工作台终端（node-pty 真 TTY）
  registerTerminalHandlers()

  // The sandboxed preload cannot access OS APIs directly.
  ipcMain.on('getPlatform', (event) => {
    event.returnValue = process.platform
  })
  ipcMain.on('getHomeDir', (event) => {
    event.returnValue = os.homedir()
  })

  ipcMain.handle('loadApiKeys', async (): Promise<Record<string, string>> => {
    assertEncryptionAvailable()
    const credentials = readCredentialStore()
    const decrypted: Record<string, string> = {}
    for (const [id, encrypted] of Object.entries(credentials)) {
      try {
        decrypted[id] = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      } catch {
        // A credential encrypted for another OS account must never crash startup.
      }
    }
    return decrypted
  })

  ipcMain.handle('saveApiKey', async (_event, id: unknown, apiKey: unknown): Promise<void> => {
    const credentialId = assertCredentialId(id)
    if (typeof apiKey !== 'string' || Buffer.byteLength(apiKey, 'utf-8') > MAX_API_KEY_BYTES) {
      throw new Error('Invalid or oversized API key')
    }
    assertEncryptionAvailable()
    const credentials = readCredentialStore()
    if (apiKey) credentials[credentialId] = safeStorage.encryptString(apiKey).toString('base64')
    else delete credentials[credentialId]
    writeCredentialStore(credentials)
  })

  ipcMain.handle('removeApiKey', async (_event, id: unknown): Promise<void> => {
    const credentialId = assertCredentialId(id)
    assertEncryptionAvailable()
    const credentials = readCredentialStore()
    delete credentials[credentialId]
    writeCredentialStore(credentials)
  })

  // File system
  ipcMain.handle('selectFolder', async () => {
    const result = await showOpenDialogSafe({
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('selectImageFile', async () => {
    const result = await showOpenDialogSafe({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // 对话附件多选：图片与任意类型文件均可，不加 filters
  ipcMain.handle('selectChatFiles', async () => {
    const result = await showOpenDialogSafe({
      properties: ['openFile', 'multiSelections'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
  })

  // 按磁盘路径读取图片文件为 base64 data URL（渲染进程无法按路径读本地文件）
  ipcMain.handle('readImageFileBase64', async (_e, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('readImageFileBase64: file path must be a non-empty string')
    }
    let size = 0
    try {
      size = (await fs.promises.stat(filePath)).size
    } catch {
      throw new Error(`Cannot access image file: ${filePath}`)
    }
    if (size > 32 * 1024 * 1024) {
      throw new Error('Image file too large (max 32MB)')
    }
    let buf: Buffer
    try {
      buf = await fs.promises.readFile(filePath)
    } catch {
      throw new Error(`Failed to read image file: ${filePath}`)
    }
    const ext = path.extname(filePath).toLowerCase()
    const mime =
      ext === '.png' ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.gif' ? 'image/gif'
            : ext === '.webp' ? 'image/webp'
              : ext === '.bmp' ? 'image/bmp'
                : ext === '.svg' ? 'image/svg+xml'
                  : 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  ipcMain.handle('selectAudioFile', async () => {
    const result = await showOpenDialogSafe({
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('selectMusicFolder', async () => {
    const result = await showOpenDialogSafe({
      properties: ['openDirectory'],
      title: '选择音乐文件夹',
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // ── VIBE 氛围模式：玻璃特效 / 壁纸 / 系统媒体 ──

  /** 设置玻璃程度。WebUI 远程调用（event 为 null）不得影响宿主机窗口，直接走降级轨 */
  ipcMain.handle('vibeGlassSet', async (event, level: unknown): Promise<{ track: VibeGlassTrack }> => {
    if (!event || process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) {
      return { track: 'fallback' }
    }
    const lvl = typeof level === 'number' && Number.isFinite(level) ? level : 0
    const result = await winAcrylic.setAcrylic(mainWindow.getNativeWindowHandle(), lvl)
    if (!result.ok) return { track: 'fallback' }
    return { track: lvl <= 0 ? 'transparent' : 'acrylic' }
  })

  ipcMain.handle('vibeGlassClear', async (event): Promise<void> => {
    if (!event) return
    const hwnd = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getNativeWindowHandle() : undefined
    await winAcrylic.clearAcrylic(hwnd)
  })

  ipcMain.handle('vibeGetWallpaper', async (): Promise<string | null> => {
    const wallpaperPath = await resolveWallpaperPath()
    if (!wallpaperPath) return null
    try {
      const stat = fs.statSync(wallpaperPath)
      if (wallpaperCache && wallpaperCache.mtimeMs === stat.mtimeMs && wallpaperCache.size === stat.size) {
        return wallpaperCache.dataUrl
      }
      if (stat.size > MAX_WALLPAPER_BYTES) return null
      const buf = fs.readFileSync(wallpaperPath)
      const mime = sniffImageMime(buf)
      if (!mime) return null
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      wallpaperCache = { dataUrl, mtimeMs: stat.mtimeMs, size: stat.size }
      return dataUrl
    } catch {
      return null
    }
  })

  ipcMain.handle('vibeMediaGetState', async (): Promise<SystemMediaState | null> => {
    try {
      await systemMedia.ensureStarted()
    } catch {
      return null
    }
    return systemMedia.getState()
  })

  ipcMain.handle('vibeMediaCommand', async (_event, cmd: unknown): Promise<boolean> => {
    if (typeof cmd !== 'object' || cmd === null) return false
    const record = cmd as Record<string, unknown>
    if (typeof record.type !== 'string') return false
    if (record.type === 'seek') {
      if (typeof record.positionMs !== 'number' || !Number.isFinite(record.positionMs)) return false
      return systemMedia.sendCommand({ type: 'seek', positionMs: record.positionMs })
    }
    if (record.type === 'volume') {
      if (typeof record.volume !== 'number' || !Number.isFinite(record.volume)) return false
      return systemMedia.sendCommand({ type: 'volume', volume: record.volume })
    }
    if (record.type === 'toggle' || record.type === 'play' || record.type === 'pause' || record.type === 'next' || record.type === 'prev') {
      return systemMedia.sendCommand({ type: record.type })
    }
    return false
  })

  ipcMain.handle('vibeMediaStop', async (): Promise<void> => {
    systemMedia.stop()
  })

  /** 选择自定义技能文件：.skill（直接就是 SKILL.md）或 .zip（内含 SKILL.md） */
  ipcMain.handle('selectSkillFile', async () => {
    const result = await showOpenDialogSafe({
      properties: ['openFile'],
      title: '选择技能文件',
      filters: [
        { name: 'Skill 文件', extensions: ['skill', 'zip'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  /** 解析自定义技能文件，返回 SKILL.md 内容、完整文件列表与元数据 */
  ipcMain.handle('parseSkillFile', async (_event, filePath: string) => {
    const ext = typeof filePath === 'string' ? path.extname(filePath).toLowerCase() : ''
    let skillMdContent = ''
    let tempDir = ''
    // 完整文件列表（path 相对解压根目录，content 为 utf-8 文本）
    let files: Array<{ path: string; content: string }> = []

    // 跳过常见二进制扩展名（仅保留文本文件，避免把图片等读成 utf-8 乱码）
    const binaryExt = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
      '.zip', '.gz', '.tar', '.rar', '.7z',
      '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.avi', '.mov',
      '.pdf', '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
      '.ttf', '.otf', '.woff', '.woff2', '.eot',
    ])

    try {
      const sourceStat = fs.statSync(filePath)
      if (!sourceStat.isFile()) throw new Error('Skill source is not a file')
      const sourceLimit = ext === '.zip' ? MAX_SKILL_ARCHIVE_BYTES : MAX_SKILL_FILE_BYTES
      if (sourceStat.size > sourceLimit) throw new Error('Skill source exceeds the allowed size')

      if (ext === '.skill') {
        skillMdContent = fs.readFileSync(filePath, 'utf-8')
        // .skill 文件本身就是单个 SKILL.md 内容
        files = [{ path: 'SKILL.md', content: skillMdContent }]
      } else if (ext === '.zip') {
        assertSafeSkillArchive(filePath)
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerkbox-skill-'))
        const runExtractor = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
          const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
          let stderr = ''
          child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_192) })
          child.on('error', reject)
          child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(stderr || `Archive extraction failed with exit code ${code ?? 'unknown'}`))
          })
        })
        if (process.platform === 'win32') {
          await runExtractor('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'param($source, $destination) Expand-Archive -LiteralPath $source -DestinationPath $destination -Force',
            filePath,
            tempDir,
          ])
        } else {
          await runExtractor('unzip', ['-o', filePath, '-d', tempDir])
        }
        // 在解压目录中递归查找 SKILL.md（优先根级，其次任意层级）
        const skillMdPath = findSkillMd(tempDir)
        if (!skillMdPath) {
          const entries = listEntries(tempDir)
          throw new Error(`ZIP 中未找到 SKILL.md 文件，解压后包含：${entries.slice(0, 10).join(', ')}${entries.length > 10 ? ' ...' : ''}`)
        }
        const skillMdStat = fs.statSync(skillMdPath)
        if (skillMdStat.size > MAX_SKILL_FILE_BYTES) throw new Error('SKILL.md exceeds the allowed size')
        skillMdContent = fs.readFileSync(skillMdPath, 'utf-8')

        // 遍历解压目录所有文件，保留目录结构，读取文本文件内容
        const collected: Array<{ path: string; content: string }> = []
        let totalBytes = 0
        const walk = (dir: string, base: string = '') => {
          if (collected.length >= MAX_SKILL_FILES || totalBytes >= MAX_SKILL_DIRECTORY_BYTES) return
          let entries: fs.Dirent[]
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of entries) {
            if (collected.length >= MAX_SKILL_FILES || totalBytes >= MAX_SKILL_DIRECTORY_BYTES) return
            const rel = base ? `${base}/${e.name}` : e.name
            if (e.isDirectory()) {
              walk(path.join(dir, e.name), rel)
            } else if (e.isFile()) {
              const lower = path.extname(e.name).toLowerCase()
              if (binaryExt.has(lower)) continue
              const absPath = path.join(dir, e.name)
              let stat: fs.Stats
              try {
                stat = fs.statSync(absPath)
              } catch {
                continue
              }
              if (stat.size > MAX_SKILL_FILE_BYTES || totalBytes + stat.size > MAX_SKILL_DIRECTORY_BYTES) continue
              let content: string
              try {
                content = fs.readFileSync(absPath, 'utf-8')
              } catch {
                continue
              }
              // 含 null 字节视为二进制，跳过
              if (content.indexOf('\u0000') !== -1) continue
              totalBytes += stat.size
              collected.push({ path: rel, content })
            }
          }
        }
        walk(tempDir)

        // 若解压根目录下没有 SKILL.md（即 SKILL.md 在子目录中），把 SKILL.md 提升到根级
        // 同时保留其在子目录中的原位置，便于 references 路径解析
        if (!collected.find((f) => f.path === 'SKILL.md' || /^SKILL\.md$/i.test(f.path))) {
          const skillMdRel = path.relative(tempDir, skillMdPath).replace(/\\/g, '/')
          const item = collected.find((f) => f.path === skillMdRel)
          if (item) {
            collected.unshift({ path: 'SKILL.md', content: item.content })
          }
        }
        files = collected.length > 0 ? collected : [{ path: 'SKILL.md', content: skillMdContent }]
      } else {
        throw new Error('不支持的文件格式')
      }

      const parsed = parseSkillMd(skillMdContent)
      return { success: true, ...parsed, skillMdContent, files }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true })
        } catch { /* ignore cleanup errors */ }
      }
    }
  })

  ipcMain.handle('fileExists', async (_event, filePath: string) => {
    try {
      return fs.existsSync(assertSafePath(filePath))
    } catch {
      return false
    }
  })

  ipcMain.handle('openExternal', async (_event, url: string) => {
    // External links must not invoke local protocol handlers.
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`blocked scheme: ${parsed.protocol}`)
      }
    } catch {
      throw new Error('Invalid URL or blocked scheme')
    }
    await shell.openExternal(url)
  })

  ipcMain.handle('confirmDialog', async (_event, title: string, message: string) => {
    const result = await showMessageBoxSafe({
      type: 'question',
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      title,
      message,
    })
    return result.response === 1
  })

  ipcMain.on('windowAction', (_event, action: 'minimize' | 'maximize' | 'close') => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    } else if (action === 'close') mainWindow.close()
  })

  ipcMain.on('isWindowMaximized', (event) => {
    event.returnValue = mainWindow?.isMaximized() ?? false
  })

  // File tool paths may be absolute, but cannot contain traversal segments or null bytes.
  const MAX_READ_BYTES = 10 * 1024 * 1024  // 10MB — 防止同步读大文件导致 OOM
  const MAX_WRITE_BYTES = 10 * 1024 * 1024 // 10MB — 防止填满磁盘

  /** Normalize a file-system path and reject traversal or null-byte input. */
  function assertSafePath(filePath: string): string {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
      throw new Error('Invalid path')
    }
    const normalized = path.normalize(filePath)
    // 规范化后若仍含 .. 段（作为独立路径段），说明试图跳出基目录
    // 用正则匹配路径分隔符之间的 .. 段，避免误判 foo..bar 这种文件名
    if (/(^|[/\\])\.\.([/\\]|$)/.test(normalized)) {
      throw new Error(`Path traversal blocked: ${filePath}`)
    }
    return normalized
  }

  ipcMain.handle('readFile', async (_event, filePath: string) => {
    const safe = assertSafePath(filePath)
    // 同步读取前先检查大小，避免 OOM
    let stat: fs.Stats
    try {
      stat = fs.statSync(safe)
    } catch {
      throw new Error(`File not found: ${safe}`)
    }
    if (!stat.isFile()) throw new Error(`Not a file: ${safe}`)
    if (stat.size > MAX_READ_BYTES) {
      // 大文件只读前 MAX_READ_BYTES 字节
      const fd = fs.openSync(safe, 'r')
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES)
        const bytesRead = fs.readSync(fd, buf, 0, MAX_READ_BYTES, 0)
        return buf.slice(0, bytesRead).toString('utf-8') + `\n\n[... 文件过大，已截断，共 ${stat.size} 字节 ...]`
      } finally {
        fs.closeSync(fd)
      }
    }
    return fs.readFileSync(safe, 'utf-8')
  })

  ipcMain.handle('writeFile', async (_event, filePath: string, content: string) => {
    const safe = assertSafePath(filePath)
    if (typeof content !== 'string') throw new Error('Invalid content')
    if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) {
      throw new Error(`Content too large: ${Buffer.byteLength(content, 'utf-8')} bytes > ${MAX_WRITE_BYTES}`)
    }
    fs.mkdirSync(path.dirname(safe), { recursive: true })
    fs.writeFileSync(safe, content, 'utf-8')
  })

  ipcMain.handle('listDir', async (_event, dirPath: string) => {
    const entries = fs.readdirSync(assertSafePath(dirPath), { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
  })

  // Defense in depth: renderer-side confirmation is not a security boundary.
  const DANGEROUS_CMD_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
    // PowerShell 编码执行（绕过所有黑名单）
    { regex: /-\s*enc(?:odedcommand)?\s+/i, reason: 'PowerShell -EncodedCommand 被禁止' },
    // Invoke-Expression 及其别名 iex
    { regex: /\b(?:Invoke-Expression|iex)\s*[\(\{]/i, reason: 'Invoke-Expression 被禁止' },
    { regex: /\biex\s+/i, reason: 'iex (Invoke-Expression 别名) 被禁止' },
    // 从网络下载并直接执行
    { regex: /\|\s*(?:bash|sh|zsh|python|node|pwsh|powershell)\b/i, reason: '管道执行解释器被禁止' },
    // fork bomb
    { regex: /:\s*\(\s*\)\s*\{/, reason: 'fork bomb 被禁止' },
    // 系统关机/重启
    { regex: /\b(?:Stop-Computer|Restart-Computer)\b/i, reason: '系统关机/重启命令被禁止' },
    { regex: /\bshutdown\b/i, reason: 'shutdown 命令被禁止' },
    // Destructive filesystem operations and forced process termination.
    { regex: /\brm\s+-rf\b/i, reason: '递归强制删除命令被禁止' },
    { regex: /\brmdir\s+\/[sq]/i, reason: '递归删除目录命令被禁止' },
    { regex: /\bdel\s+\/(?:[sq]|f\s+\/s\s+\/q)/i, reason: '强制删除命令被禁止' },
    { regex: /\b(?:Remove-Item|ri)\b.*-(?:Recurse|r)\b.*-(?:Force|f)\b/i, reason: '递归强制删除命令被禁止' },
    { regex: /\b(?:mkfs|format)\b/i, reason: '格式化文件系统命令被禁止' },
    { regex: /\btaskkill\b.*\/f\b/i, reason: '强制结束进程命令被禁止' },
  ]

  /** 校验命令字符串，返回拒绝原因或 null */
  function checkDangerousCommand(command: string): string | null {
    if (typeof command !== 'string' || !command) return 'Invalid command'
    for (const { regex, reason } of DANGEROUS_CMD_PATTERNS) {
      if (regex.test(command)) return reason
    }
    return null
  }

  /**
   * 解码子进程输出：先用 UTF-8 解码，若含 U+FFFD 替换字符则回退用 GBK(CP936) 解码。
   * 返回解码后的文本及是否触发了 GBK 回退的标记。
   */
  function decodeOutput(buf: Buffer): { text: string; fallbackUsed: boolean } {
    if (buf.length === 0) return { text: '', fallbackUsed: false }
    const utf8Text = buf.toString('utf8')
    if (utf8Text.includes('\uFFFD')) {
      // UTF-8 解码出现替换字符，回退用 GBK 解码
      return { text: iconv.decode(buf, 'gbk'), fallbackUsed: true }
    }
    return { text: utf8Text, fallbackUsed: false }
  }

  // Shell
  // sessionId → 当前活动子进程集合。用户点中断按钮时通过 cancelSessionCommands 杀掉。
  const sessionChildProcesses = new Map<string, Set<import('child_process').ChildProcess>>()
  const registerChild = (sessionId: string | undefined, child: import('child_process').ChildProcess) => {
    if (!sessionId) return
    let set = sessionChildProcesses.get(sessionId)
    if (!set) { set = new Set(); sessionChildProcesses.set(sessionId, set) }
    set.add(child)
  }
  const unregisterChild = (sessionId: string | undefined, child: import('child_process').ChildProcess) => {
    if (!sessionId) return
    const set = sessionChildProcesses.get(sessionId)
    if (!set) return
    set.delete(child)
    if (set.size === 0) sessionChildProcesses.delete(sessionId)
  }
  ipcMain.handle(
    'cancelSessionCommands',
    async (_event, sessionId: string) => {
      const set = sessionChildProcesses.get(sessionId)
      if (!set) return { killed: 0 }
      let killed = 0
      for (const child of set) {
        try {
          child.kill('SIGTERM')
          // Windows 上 SIGTERM 不一定真杀掉，补一刀 SIGKILL
          setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already dead */ } }, 200)
          killed++
        } catch { /* ignore */ }
      }
      set.clear()
      sessionChildProcesses.delete(sessionId)
      return { killed }
    }
  )
  ipcMain.handle(
    'executeCommand',
    async (_event, command: string, cwd?: string, sessionId?: string) => {
      const blockReason = checkDangerousCommand(command)
      if (blockReason) {
        return { stdout: '', stderr: `命令被主进程拒绝：${blockReason}`, exitCode: -1 }
      }
      const MAX_BUFFER = 10 * 1024 * 1024
      const TIMEOUT_MS = 60000
      // Windows 默认 cmd.exe，强制 UTF-8 代码页
      const isWin = process.platform === 'win32'
      const shellCmd = isWin ? `chcp 65001 >nul 2>&1 && ${command}` : command
      const shellArgs = isWin ? ['/c', shellCmd] : ['-c', command]
      const shellPath = isWin ? 'cmd.exe' : '/bin/sh'
      return new Promise((resolve) => {
        const child = spawn(shellPath, shellArgs, {
          cwd,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          windowsHide: true,
        })
        registerChild(sessionId, child)
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutLen = 0
        let stderrLen = 0
        let killed = false
        let settled = false
        const timer = setTimeout(() => {
          killed = true
          child.kill()
        }, TIMEOUT_MS)
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutLen += chunk.length
          if (stdoutLen > MAX_BUFFER) {
            if (!killed) { killed = true; child.kill() }
            return
          }
          stdoutChunks.push(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderrLen += chunk.length
          if (stderrLen > MAX_BUFFER) {
            if (!killed) { killed = true; child.kill() }
            return
          }
          stderrChunks.push(chunk)
        })
        child.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unregisterChild(sessionId, child)
          resolve({ stdout: '', stderr: String(err), exitCode: 1, encodingFallback: false })
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unregisterChild(sessionId, child)
          const out = decodeOutput(Buffer.concat(stdoutChunks))
          const err = decodeOutput(Buffer.concat(stderrChunks))
          resolve({
            stdout: out.text,
            stderr: err.text,
            exitCode: killed ? -1 : (code ?? 0),
            encodingFallback: out.fallbackUsed || err.fallbackUsed,
          })
        })
      })
    }
  )

  ipcMain.handle(
    'executeCommandWithShell',
    async (_event, command: string, cwd: string | undefined, shellType: string, sessionId?: string) => {
      const blockReason = checkDangerousCommand(command)
      if (blockReason) {
        return { stdout: '', stderr: `命令被主进程拒绝：${blockReason}`, exitCode: -1 }
      }
      if (shellType !== 'cmd' && shellType !== 'powershell') {
        return { stdout: '', stderr: 'Unsupported shell type', exitCode: -1 }
      }
      const isPS = shellType === 'powershell'
      const shellPath = isPS ? 'powershell.exe' : 'cmd.exe'
      // 强制 UTF-8 控制台代码页
      const shellCmd = isPS
        ? `& { [Console]::OutputEncoding=[Text.Encoding]::UTF8; chcp 65001 > $null; ${command} }`
        : `chcp 65001 >nul 2>&1 && ${command}`
      const MAX_BUFFER = 10 * 1024 * 1024
      const TIMEOUT_MS = 60000
      return new Promise((resolve) => {
        const child = spawn(shellPath, isPS ? ['-NoProfile', '-Command', shellCmd] : ['/c', shellCmd], {
          cwd,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          windowsHide: true,
        })
        registerChild(sessionId, child)
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutLen = 0
        let stderrLen = 0
        let killed = false
        let settled = false
        const timer = setTimeout(() => {
          killed = true
          child.kill()
        }, TIMEOUT_MS)
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutLen += chunk.length
          if (stdoutLen > MAX_BUFFER) {
            if (!killed) { killed = true; child.kill() }
            return
          }
          stdoutChunks.push(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderrLen += chunk.length
          if (stderrLen > MAX_BUFFER) {
            if (!killed) { killed = true; child.kill() }
            return
          }
          stderrChunks.push(chunk)
        })
        child.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unregisterChild(sessionId, child)
          resolve({ stdout: '', stderr: String(err), exitCode: 1, encodingFallback: false })
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unregisterChild(sessionId, child)
          const out = decodeOutput(Buffer.concat(stdoutChunks))
          const err = decodeOutput(Buffer.concat(stderrChunks))
          resolve({
            stdout: out.text,
            stderr: err.text,
            exitCode: killed ? -1 : (code ?? 0),
            encodingFallback: out.fallbackUsed || err.fallbackUsed,
          })
        })
      })
    }
  )

  // Web search (Bing)
  ipcMain.handle('webSearch', async (_event, query: string, count?: number) => {
    const maxCount = Math.min(Math.max(count ?? 5, 1), 10)
    try {
      return await searchWithBingHtml(query, maxCount)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { error: `网页搜索失败：${msg}` }
    }
  })

  // Web fetch
  ipcMain.handle('webFetch', async (_event, targetUrl: string, maxLength?: number) => {
    try {
      const safeUrl = assertPublicWebUrl(targetUrl).toString()
      const requestedLength = typeof maxLength === 'number' && Number.isFinite(maxLength)
        ? Math.trunc(maxLength)
        : 30_000
      const maxLen = Math.min(Math.max(requestedLength, 1), 100_000)
      // First try HTTP fetch (fast, works for SSR sites)
      const raw = await fetchUrlRobust(safeUrl, maxLen + 5000)
      let text = htmlToText(raw)

      // If HTTP extraction yielded enough content, return it
      if (text.length >= 200) {
        return { content: text.substring(0, maxLen), url: safeUrl }
      }

      // Use serialized SPA data as a safe fallback. Executing arbitrary remote
      // page scripts in a BrowserWindow would reintroduce a DNS-rebinding path.
      if (text.length < 100) {
        const spaText = extractSpaContent(raw)
        if (spaText && spaText.length > 100) {
          text = htmlToText(spaText)
        }
      }

      // Final fallback: title + meta description
      if (text.length < 50) {
        const titleMatch = raw.match(/<title[^>]*>([^<]+)<\/title>/i)
        const descMatch = raw.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
        const ogDescMatch = raw.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i)
        const parts: string[] = []
        if (titleMatch) parts.push(titleMatch[1].trim())
        if (descMatch) parts.push(descMatch[1].trim())
        if (ogDescMatch && ogDescMatch[1] !== descMatch?.[1]) parts.push(ogDescMatch[1].trim())
        if (parts.length > 0) {
          text = parts.join('\n\n')
        }
      }

      if (text.length === 0) {
        return { error: '页面无有效内容，无法提取', url: safeUrl }
      }

      return { content: text.substring(0, maxLen), url: safeUrl }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { error: msg }
    }
  })

  // ── Memory system (.clerkbox/memory/) ──

  /** 解析 YAML frontmatter，提取 name/description/type 字段 */
  function parseFrontmatter(headContent: string): {
    name: string
    description: string | null
    type: 'user' | 'feedback' | 'project' | 'reference' | undefined
  } {
    // 统一换行符，避免 Windows \r\n 影响正则匹配
    const normalized = headContent.replace(/\r\n/g, '\n')
    const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---/)
    if (!fmMatch) {
      return { name: '', description: null, type: undefined }
    }
    const fm = fmMatch[1]
    const nameMatch = fm.match(/^name:\s*(.+)$/m)
    const descMatch = fm.match(/^description:\s*(.+)$/m)
    const typeMatch = fm.match(/^type:\s*(.+)$/m)
    const typeRaw = typeMatch ? typeMatch[1].trim() : undefined
    const validTypes = ['user', 'feedback', 'project', 'reference']
    const type =
      typeRaw && validTypes.includes(typeRaw)
        ? (typeRaw as 'user' | 'feedback' | 'project' | 'reference')
        : undefined
    return {
      name: nameMatch ? nameMatch[1].trim() : '',
      description: descMatch ? descMatch[1].trim() : null,
      type,
    }
  }

  /** 扫描记忆目录，返回所有记忆条目（按 mtime 倒序，最多 200 条） */
  async function scanMemoryEntries(workingDir: string): Promise<MemoryEntry[]> {
    try {
      const memDir = path.join(workingDir, '.clerkbox', 'memory')
      if (!fs.existsSync(memDir)) return []
      const files = fs
        .readdirSync(memDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      const entries: MemoryEntry[] = []
      for (const filename of files) {
        try {
          const fullPath = path.join(memDir, filename)
          const stat = await fs.promises.stat(fullPath)
          // Do not load oversized memory files into the renderer.
          if (!stat.isFile() || stat.size > MAX_MEMORY_FILE_BYTES) continue
          const content = await fs.promises.readFile(fullPath, 'utf-8')
          // 读取前 30 行用于解析 frontmatter
          const headLines = content.split('\n').slice(0, 30).join('\n')
          const { name, description, type } = parseFrontmatter(headLines)
          entries.push({
            filename,
            name,
            description,
            type,
            content,
            mtime: stat.mtimeMs,
          })
        } catch { /* Ignore one unreadable memory entry and continue scanning. */ }
      }
      entries.sort((a, b) => b.mtime - a.mtime)
      return entries.slice(0, 200)
    } catch {
      return []
    }
  }

  // 扫描记忆目录下所有 .md 文件（排除 MEMORY.md），返回记忆条目列表
  ipcMain.handle('scanMemory', async (_event, workingDir: string): Promise<MemoryEntry[]> => {
    return scanMemoryEntries(workingDir)
  })

  /** 全局记忆落盘成功后通知账号系统（可能触发自动云同步）；仅当写入目标是用户主目录时生效 */
  function notifyGlobalMemoryWritten(workingDir: string): void {
    if (typeof workingDir !== 'string') return
    try {
      if (path.resolve(workingDir) !== path.resolve(os.homedir())) return
    } catch {
      return
    }
    rtAccount.rtNotifyMemoryWritten()
  }

  // 扫描 .clerkbox/agents 目录下所有 .md 文件，返回自定义 agent 定义
  ipcMain.handle('scanAgents', async (_event, workingDir: string) => {
    try {
      const agentsDir = path.join(workingDir, '.clerkbox', 'agents')
      if (!fs.existsSync(agentsDir)) return []
      const files = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .slice(0, MAX_CUSTOM_AGENT_FILES)
      const agents: Array<{ filename: string; content: string }> = []
      for (const file of files) {
        const filename = file.name
        const fullPath = path.join(agentsDir, filename)
        const stat = fs.statSync(fullPath)
        if (stat.size > MAX_CUSTOM_AGENT_FILE_BYTES) continue
        const content = fs.readFileSync(fullPath, 'utf-8')
        agents.push({ filename, content })
      }
      return agents
    } catch {
      return []
    }
  })

  // 读取记忆索引文件 MEMORY.md，按行数和字节数截断
  ipcMain.handle(
    'readMemoryIndex',
    async (_event, workingDir: string): Promise<{ content: string; wasTruncated: boolean; reason?: string }> => {
      try {
        const indexPath = path.join(workingDir, '.clerkbox', 'memory', 'MEMORY.md')
        if (!fs.existsSync(indexPath)) {
          return { content: '', wasTruncated: false }
        }
        const indexStat = fs.statSync(indexPath)
        if (!indexStat.isFile()) return { content: '', wasTruncated: false }
        if (indexStat.size > MAX_MEMORY_INDEX_BYTES) {
          const fd = fs.openSync(indexPath, 'r')
          try {
            const buffer = Buffer.alloc(MAX_MEMORY_INDEX_BYTES)
            const bytesRead = fs.readSync(fd, buffer, 0, MAX_MEMORY_INDEX_BYTES, 0)
            const content = buffer
              .subarray(0, bytesRead)
              .toString('utf-8')
              .split('\n')
              .slice(0, 200)
              .join('\n')
            return {
              content,
              wasTruncated: true,
              reason: `Memory index exceeds ${MAX_MEMORY_INDEX_BYTES} bytes`,
            }
          } finally {
            fs.closeSync(fd)
          }
        }
        let raw = fs.readFileSync(indexPath, 'utf-8')
        let wasTruncated = false
        let reason: string | undefined

        // 按 200 行截断
        const lines = raw.split('\n')
        if (lines.length > 200) {
          raw = lines.slice(0, 200).join('\n')
          wasTruncated = true
          reason = '行数超过 200'
        }

        // 按 25000 字节截断（在最后一个换行符前截断）
        if (Buffer.byteLength(raw, 'utf-8') > MAX_MEMORY_INDEX_BYTES) {
          let truncated = raw.substring(0, MAX_MEMORY_INDEX_BYTES)
          const lastNewline = truncated.lastIndexOf('\n')
          if (lastNewline > 0) {
            truncated = truncated.substring(0, lastNewline)
          }
          raw = truncated
          wasTruncated = true
          reason = reason
            ? `${reason}; 字节数超过 ${MAX_MEMORY_INDEX_BYTES}`
            : `字节数超过 ${MAX_MEMORY_INDEX_BYTES}`
        }

        return { content: raw, wasTruncated, reason }
      } catch {
        return { content: '', wasTruncated: false }
      }
    }
  )

  // 写入单个记忆文件 <slug>.md（含 frontmatter）
  ipcMain.handle(
    'writeMemoryFile',
    async (_event, workingDir: string, slug: string, frontmatter: string, content: string): Promise<void> => {
      return enqueueMemWrite(async () => {
        // slug 校验，防止路径遍历写到 memory 目录之外
        if (typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
          throw new Error(`Invalid memory slug: ${slug}`)
        }
        if (typeof frontmatter !== 'string' || typeof content !== 'string') {
          throw new Error('Invalid memory content')
        }
        const fileContent = `---\n${frontmatter}\n---\n\n${content}`
        if (Buffer.byteLength(fileContent, 'utf-8') > MAX_MEMORY_FILE_BYTES) {
          throw new Error(`Memory entry exceeds the ${MAX_MEMORY_FILE_BYTES} byte limit`)
        }
        const memDir = path.join(workingDir, '.clerkbox', 'memory')
        fs.mkdirSync(memDir, { recursive: true })
        const filePath = path.join(memDir, `${slug}.md`)
        fs.writeFileSync(filePath, fileContent, 'utf-8')
        // 落盘成功后通知账号系统（仅全局范围时）
        notifyGlobalMemoryWritten(workingDir)
      })
    }
  )

  // 更新记忆索引 MEMORY.md：替换或追加一条索引行
  ipcMain.handle(
    'updateMemoryIndex',
    async (_event, workingDir: string, entryLine: string, slug: string): Promise<void> => {
      return enqueueMemWrite(async () => {
        const indexPath = path.join(workingDir, '.clerkbox', 'memory', 'MEMORY.md')
        if (typeof entryLine !== 'string' || typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
          throw new Error('Invalid memory index entry')
        }
        if (Buffer.byteLength(entryLine, 'utf-8') > MAX_MEMORY_INDEX_BYTES) {
          throw new Error(`Memory index entry exceeds the ${MAX_MEMORY_INDEX_BYTES} byte limit`)
        }
        let existing = ''
        if (fs.existsSync(indexPath)) {
          const stat = fs.statSync(indexPath)
          if (!stat.isFile() || stat.size > MAX_MEMORY_INDEX_BYTES) {
            throw new Error('Memory index exceeds the allowed size')
          }
          existing = fs.readFileSync(indexPath, 'utf-8')
        }

        // 检查是否已有指向 <slug>.md 的索引行
        const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const lineRegex = new RegExp(`^.*\\(${escapedSlug}\\.md\\).*$`, 'm')
        if (lineRegex.test(existing)) {
          // 已有索引行：替换为新的 entryLine
          existing = existing.replace(lineRegex, entryLine)
        } else {
          // 没有索引行：在末尾追加（确保前面有换行）
          if (existing.length > 0 && !existing.endsWith('\n')) {
            existing += '\n'
          }
          existing += entryLine
        }
        if (Buffer.byteLength(existing, 'utf-8') > MAX_MEMORY_INDEX_BYTES) {
          throw new Error(`Memory index exceeds the ${MAX_MEMORY_INDEX_BYTES} byte limit`)
        }
        fs.mkdirSync(path.dirname(indexPath), { recursive: true })
        fs.writeFileSync(indexPath, existing, 'utf-8')
        // 落盘成功后通知账号系统（仅全局范围时）
        notifyGlobalMemoryWritten(workingDir)
      })
    }
  )

  // 搜索记忆文件：可选按 type 过滤、按 query 关键词匹配（大小写不敏感）
  ipcMain.handle(
    'searchMemoryFiles',
    async (_event, workingDir: string, query?: string, type?: string): Promise<MemoryEntry[]> => {
      try {
        let entries = await scanMemoryEntries(workingDir)

        // 按 type 过滤
        if (type) {
          entries = entries.filter((e) => e.type === type)
        }

        // 按 query 关键词匹配（大小写不敏感）
        if (query) {
          const q = query.toLowerCase()
          entries = entries.filter(
            (e) =>
              e.name.toLowerCase().includes(q) ||
              (e.description ?? '').toLowerCase().includes(q) ||
              e.content.toLowerCase().includes(q)
          )
        }

        return entries
      } catch {
        return []
      }
    }
  )

  // Database operations (JSON file with serialized, durable writes)
  const dbPath = path.join(app.getPath('userData'), 'clerkbox-db.json')
  let dbWriteQueue: Promise<void> = Promise.resolve()

  /** Serialize writes while allowing callers to observe failures. */
  function enqueueDbWrite(fn: () => void): Promise<void> {
    const write = dbWriteQueue.then(fn)
    dbWriteQueue = write.catch((err) => {
      console.error('DB write failed:', err)
    })
    return write
  }

  interface Database {
    sessions: Record<string, unknown>[]
    messages: Record<string, Record<string, unknown>[]>
    recentsFolders?: string[]
    /** 全局修订号：任何写入都会自增，供另一端检测数据变化 */
    revision?: number
  }

  function readDb(): Database {
    try {
      if (fs.existsSync(dbPath)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(dbPath, 'utf-8'))
        if (parsed && typeof parsed === 'object') {
          const data = parsed as Record<string, unknown>
          return {
            sessions: Array.isArray(data.sessions) ? data.sessions.filter(isRecord) : [],
            messages: isRecord(data.messages)
              ? Object.fromEntries(
                  Object.entries(data.messages).map(([id, rows]) => [
                    id,
                    Array.isArray(rows) ? rows.filter(isRecord) : [],
                  ])
                )
              : {},
            recentsFolders: Array.isArray(data.recentsFolders)
              ? data.recentsFolders.filter((folder): folder is string => typeof folder === 'string')
              : [],
            revision: typeof data.revision === 'number' ? data.revision : 0,
          }
        }
        throw new Error('Database root must be an object')
      }
    } catch {
      try {
        const backupPath = dbPath + '.backup.' + Date.now()
        if (fs.existsSync(dbPath)) {
          fs.copyFileSync(dbPath, backupPath)
          console.error('DB corrupt, backed up to:', backupPath)
        }
      } catch { /* Preserve the original corruption error if backup creation also fails. */ }
    }
    return { sessions: [], messages: {}, recentsFolders: [], revision: 0 }
  }

  /** Write through a sibling temporary file to avoid corrupting the database on interruption. */
  function writeDb(db: Database) {
    // 任何写入都自增全局修订号，供另一端的 syncFromDb 廉价检测变化
    db.revision = (db.revision || 0) + 1
    const tempPath = `${dbPath}.tmp-${process.pid}`
    fs.writeFileSync(tempPath, JSON.stringify(db, null, 2), 'utf-8')
    try {
      fs.renameSync(tempPath, dbPath)
    } catch (err) {
      try {
        fs.copyFileSync(tempPath, dbPath)
      } finally {
        fs.rmSync(tempPath, { force: true })
      }
      if (!fs.existsSync(dbPath)) throw err
    }
  }

  /** 消息变更时同步刷新会话 updated_at，让另一端的 syncFromDb 能检测到变化 */
  function touchSessionUpdatedAt(db: Database, sessionId: string, ts: number): void {
    const session = db.sessions.find((s) => s.id === sessionId)
    if (session) session.updated_at = ts
  }

  ipcMain.handle('dbCreateSession', async (_event, row: Record<string, unknown>) => {
    await enqueueDbWrite(() => {
      if (typeof row?.id !== 'string' || !row.id) throw new Error('Invalid session row')
      const db = readDb()
      const existingIndex = db.sessions.findIndex((session) => session.id === row.id)
      if (existingIndex === -1) db.sessions.push(row)
      else db.sessions[existingIndex] = { ...db.sessions[existingIndex], ...row }
      if (!db.messages[row.id]) db.messages[row.id] = []
      writeDb(db)
    })
  })

  ipcMain.handle('dbUpdateSessionTitle', async (_event, id: string, title: string, updatedAt: number) => {
    await enqueueDbWrite(() => {
      const db = readDb()
      const session = db.sessions.find((s) => s.id === id)
      if (session) {
        session.title = title
        session.updated_at = updatedAt
      }
      writeDb(db)
    })
  })

  ipcMain.handle('dbDeleteSession', async (_event, id: string) => {
    await enqueueDbWrite(() => {
      const db = readDb()
      db.sessions = db.sessions.filter((s) => s.id !== id)
      delete db.messages[id]
      writeDb(db)
    })
  })

  ipcMain.handle('dbGetAllSessions', async () => {
    // Read-only — no write serialization needed, but must wait for pending writes
    await dbWriteQueue
    return readDb().sessions
  })

  ipcMain.handle('dbGetRecents', async () => {
    await dbWriteQueue
    return readDb().recentsFolders || []
  })

  ipcMain.handle('dbGetRevision', async () => {
    await dbWriteQueue
    return readDb().revision || 0
  })

  ipcMain.handle('dbSetRecents', async (_event, recents: string[]) => {
    await enqueueDbWrite(() => {
      const db = readDb()
      db.recentsFolders = Array.isArray(recents)
        ? recents.filter((folder) => typeof folder === 'string').slice(0, 8)
        : []
      writeDb(db)
    })
  })

  ipcMain.handle('dbAddMessage', async (_event, row: Record<string, unknown>) => {
    await enqueueDbWrite(() => {
      if (typeof row?.id !== 'string' || !row.id || typeof row.session_id !== 'string' || !row.session_id) {
        throw new Error('Invalid message row')
      }
      const db = readDb()
      if (!db.messages[row.session_id]) {
        db.messages[row.session_id] = []
      }
      const msgs = db.messages[row.session_id]
      // Upsert by message id so repeated stream writes do not duplicate history.
      const existingIdx = msgs.findIndex((m) => m.id === row.id)
      if (existingIdx !== -1) {
        msgs[existingIdx] = { ...msgs[existingIdx], ...row }
      } else {
        msgs.push(row)
      }
      const ts = typeof row.timestamp === 'number' ? row.timestamp : Date.now()
      // 会话行可能被另一端的空会话清理误删 → 消息成孤儿，另一端永远看不到。
      // 这里自愈：行缺失时用首条消息内容派生标题重建。
      if (!db.sessions.some((s) => s.id === row.session_id)) {
        const text = typeof row.content === 'string' ? row.content.trim().replace(/\s+/g, ' ') : ''
        db.sessions.push({
          id: row.session_id,
          title: text ? (text.length > 20 ? text.slice(0, 20) + '…' : text) : '新会话',
          created_at: ts,
          updated_at: ts,
        })
      }
      // 同步刷新会话 updated_at，让另一端的 syncFromDb 能检测到消息变化
      touchSessionUpdatedAt(db, row.session_id, ts)
      writeDb(db)
    })
  })

  ipcMain.handle(
    'dbUpdateMessage',
    async (
      _event,
      id: string,
      content: string,
      toolCalls?: string,
      toolResults?: string,
      thinkingContent?: string | null,
      finishReason?: string | null
    ) => {
      await enqueueDbWrite(() => {
        const db = readDb()
        let found = false
        for (const [sessionId, msgs] of Object.entries(db.messages)) {
          const msg = msgs.find((m) => m.id === id)
          if (msg) {
            msg.content = content
            if (toolCalls !== undefined) msg.tool_calls = toolCalls
            if (toolResults !== undefined) msg.tool_results = toolResults
            if (thinkingContent !== undefined) msg.thinking_content = thinkingContent
            if (finishReason !== undefined) msg.finish_reason = finishReason
            // 同步刷新会话 updated_at，让另一端的 syncFromDb 能检测到消息变化
            touchSessionUpdatedAt(db, sessionId, Date.now())
            found = true
            break
          }
        }
        if (found) writeDb(db)
      })
    }
  )

  ipcMain.handle('dbGetMessages', async (_event, sessionId: string) => {
    await dbWriteQueue
    const db = readDb()
    return db.messages[sessionId] || []
  })

  ipcMain.handle('dbDeleteMessagesBefore', async (_event, sessionId: string, beforeId: string) => {
    await enqueueDbWrite(() => {
      const db = readDb()
      const msgs = db.messages[sessionId]
      if (!msgs) return

      // Find the index of the message with beforeId
      const idx = msgs.findIndex((m) => m.id === beforeId)
      if (idx === -1) return

      // deleteBeforeId means "delete everything that came before this message"
      // So we keep from idx onwards (the message with beforeId and everything after it),
      // and delete everything before idx
      db.messages[sessionId] = msgs.slice(idx)
      writeDb(db)
    })
  })

  // 清空指定 session 的所有消息（用于 compactSession 的「清空再重写」策略）
  ipcMain.handle('dbClearMessages', async (_event, sessionId: string) => {
    await enqueueDbWrite(() => {
      const db = readDb()
      db.messages[sessionId] = []
      writeDb(db)
    })
  })

  // 原子压缩：单次写入内整体替换该 session 的消息列表。
  // 旧「清空再逐条重写」两步间崩溃会丢失全会话历史；这里借助 writeDb 的
  // tmp+rename 原子性一次落盘完成替换，不存在清空后未写回的中间态。
  // 最坏情况（写入失败）旧数据完好，仅压缩未生效。
  ipcMain.handle('dbCompactMessages', async (_event, sessionId: string, rows: Record<string, unknown>[]) => {
    await enqueueDbWrite(() => {
      if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(rows)) {
        throw new Error('Invalid compact payload')
      }
      for (const row of rows) {
        if (!isRecord(row) || typeof row.id !== 'string' || !row.id) {
          throw new Error('Invalid message row in compact payload')
        }
      }
      const db = readDb()
      db.messages[sessionId] = [...rows]
      // 会话行可能缺失（如被另一端清理）→ 与 dbAddMessage 同策略自愈重建
      if (rows.length > 0 && !db.sessions.some((s) => s.id === sessionId)) {
        const last = rows[rows.length - 1]
        const ts = typeof last.timestamp === 'number' ? last.timestamp : Date.now()
        const text = typeof last.content === 'string' ? last.content.trim().replace(/\s+/g, ' ') : ''
        db.sessions.push({
          id: sessionId,
          title: text ? (text.length > 20 ? text.slice(0, 20) + '…' : text) : '新会话',
          created_at: ts,
          updated_at: ts,
        })
      }
      touchSessionUpdatedAt(db, sessionId, Date.now())
      writeDb(db)
    })
  })

  // A restricted slug prevents skill-directory traversal.
  function assertSafeSlug(slug: string): string {
    if (typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
      throw new Error(`Invalid slug: ${slug}`)
    }
    return slug
  }

  // Skill operations (.clerkbox directory)
  ipcMain.handle('initClerkbox', async (_event, projectDir: string) => {
    const clerkboxDir = path.join(projectDir, '.clerkbox')
    fs.mkdirSync(path.join(clerkboxDir, 'skills'), { recursive: true })
  })

  ipcMain.handle('writeSkillMd', async (_event, projectDir: string, slug: string, content: string) => {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf-8') > MAX_SKILL_FILE_BYTES) {
      throw new Error('Invalid or oversized skill content')
    }
    const safeSlug = assertSafeSlug(slug)
    const skillDir = path.join(projectDir, '.clerkbox', 'skills', safeSlug)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
  })

  // 多文件写盘：把技能所有文件（含 SKILL.md 与子目录文件）写到 .clerkbox/skills/<slug>/ 下
  ipcMain.handle('writeSkillDir', async (_event, projectDir: string, slug: string, files: Array<{ path: string; content: string }>) => {
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_SKILL_FILES) {
      throw new Error('Invalid skill file list')
    }
    const safeSlug = assertSafeSlug(slug)
    const skillDir = path.join(projectDir, '.clerkbox', 'skills', safeSlug)
    fs.mkdirSync(skillDir, { recursive: true })
    const expectedBase = path.resolve(skillDir)
    let totalBytes = 0
    for (const f of files) {
      if (!isRecord(f) || typeof f.path !== 'string' || typeof f.content !== 'string') {
        throw new Error('Invalid skill file')
      }
      const fileBytes = Buffer.byteLength(f.content, 'utf-8')
      if (fileBytes > MAX_SKILL_FILE_BYTES || totalBytes + fileBytes > MAX_SKILL_DIRECTORY_BYTES) {
        throw new Error('Skill files exceed the allowed size')
      }
      totalBytes += fileBytes

      const segments = f.path.replace(/\\/g, '/').split('/')
      if (
        f.path.includes('\0') ||
        f.path.startsWith('/') ||
        segments.some((segment) => !segment || segment === '.' || segment === '..')
      ) {
        throw new Error(`Invalid skill file path: ${f.path}`)
      }
      const target = path.resolve(skillDir, ...segments)
      const rel = path.relative(expectedBase, target)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Path traversal blocked in writeSkillDir: ${f.path}`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, f.content, 'utf-8')
    }
  })

  ipcMain.handle('removeSkillDir', async (_event, projectDir: string, slug: string) => {
    const safeSlug = assertSafeSlug(slug)
    const skillDir = path.join(projectDir, '.clerkbox', 'skills', safeSlug)
    // 二次校验：确保 skillDir 确实在 projectDir/.clerkbox/skills/ 之下
    const expectedBase = path.resolve(projectDir, '.clerkbox', 'skills')
    const resolved = path.resolve(skillDir)
    const rel = path.relative(expectedBase, resolved)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Path traversal blocked in removeSkillDir')
    }
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })

  // Skill marketplace: 抓取 hub.cocoloop.cn SSR (Next.js App Router RSC) 解析 initialItems
  ipcMain.handle('skillsSearch', async (_event, query: string, page: number = 1, limit: number = 20) => {
    const safeQuery = typeof query === 'string' ? query.trim().slice(0, 200) : ''
    const toInteger = (value: unknown, fallback: number, min: number, max: number) =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(Math.trunc(value), min), max)
        : fallback
    const safePage = toInteger(page, 1, 1, 1000)
    const safeLimit = toInteger(limit, 20, 1, 100)

    try {
      // 1. 抓搜索页 SSR HTML（hub.cocoloop.cn 是 Next.js App Router，服务端渲染含 initialItems）
      //    注意：主页 /skills 是纯静态 HTML 没有 initialItems，必须用 /search 路由才能拿到 RSC 数据。
      //    另外：服务端 SSR 忽略 ?q=（返回固定热门列表），只有 ?page=N 分页是服务端生效的 ——
      //    站点的搜索框是客户端行为。因此带关键词时并行拉多页聚合候选池，再做本地过滤，
      //    否则只在一个 20 条的热门列表里找，搜什么都接近零结果。
      // CocoLoop 的 SSR 不会处理 q 参数，因此搜索必须在本地候选池中匹配。
      // 旧实现只抓 5 页（约 100 条），热门排序会让大量技能永远没有机会被搜索到。
      // 抓取更大的、有界候选池，仍通过并发请求控制总延迟和网络开销。
      const SEARCH_POOL_PAGES = 20
      const pagesToFetch = safeQuery
        ? Array.from({ length: SEARCH_POOL_PAGES }, (_, i) => i + 1)
        : [safePage]
      const responses = await Promise.all(
        pagesToFetch.map((p) =>
          fetchHttpsText(
            `https://hub.cocoloop.cn/search?keyword=${encodeURIComponent(safeQuery)}&page=${p}`,
            { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ClerkBox/1.7' },
            2 * 1024 * 1024
          )
        )
      )
      const okResponse = responses.find((r) => r.statusCode === 200)
      if (!okResponse) throw new Error(`CocoLoop returned HTTP ${responses[0]?.statusCode ?? 0}`)

      // 2. 解析 RSC 流中的 initialItems 数组，多页结果按 id 去重合并
      const seenIds = new Set<string>()
      const allSkills = responses.flatMap((r) => (r.statusCode === 200 ? parseCocoloopSkills(r.body) : []))
        .filter((s) => {
          if (seenIds.has(s.id)) return false
          seenIds.add(s.id)
          return true
        })

      // 3. 关键词过滤：服务端不响应 ?q=，客户端做宽松的本地模糊匹配。
      //    支持中文、大小写、连字符/下划线和多个空格分隔的关键词；多个词需全部命中，
      //    但可命中名称、中文标题、描述、作者、slug 或 id 的任意字段。
      const normalizeSearchText = (value: string) => value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s\-_\/\\]+/g, ' ')
        .trim()
      const queryTokens = normalizeSearchText(safeQuery).split(' ').filter(Boolean)
      const filtered = queryTokens.length > 0
        ? allSkills.filter((s) => {
            const haystack = normalizeSearchText([
              s.id,
              s.name,
              s.titleCn || '',
              s.description,
              s.author || '',
              s.creatorSlug || '',
            ].join(' '))
            return queryTokens.every((token) => haystack.includes(token))
          })
        : allSkills

      // 4. 分页
      const total = filtered.length
      const totalPages = Math.max(1, Math.ceil(total / safeLimit))
      const start = (safePage - 1) * safeLimit
      const paged = filtered.slice(start, start + safeLimit)

      return JSON.stringify({
        success: true,
        data: {
          skills: paged,
          pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            totalPages,
            hasNext: safePage < totalPages,
            hasPrev: safePage > 1,
          },
          filters: { search: safeQuery, sortBy: 'relevance' },
        },
      })
    } catch (err) {
      // 返回 success: false + 错误信息，便于前端诊断，不再静默吞掉错误
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        data: {
          skills: [],
          pagination: { page: safePage, limit: safeLimit, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
          filters: { search: safeQuery, sortBy: 'relevance' },
        },
      })
    }
  })

  // 下载 CocoLoop skill zip 解压后只取 SKILL.md 内容（兼容旧接口签名，参数为 downloadUrl）
  ipcMain.handle('fetchSkillMd', async (_event, downloadUrl: string) => {
    return await fetchCocoloopSkillMd(downloadUrl)
  })

  // 整目录拉取技能：下载 CocoLoop skill zip 并解压，返回完整文件列表
  ipcMain.handle('fetchSkillFromRepo', async (_event, downloadUrl: string) => {
    return await fetchCocoloopSkillDir(downloadUrl)
  })

  // 扫描 .claude/skills/ 标准路径，发现全局和项目级技能
  ipcMain.handle('scanSkillDirs', async (_event, workingDir: string) => {
    return JSON.stringify(scanSkillDirs(workingDir))
  })

  // Platform info
  ipcMain.handle('getPlatform', () => {
    return process.platform
  })

  // ── 共享 KV 存储：Electron 与 WebUI 双模式读写同一份持久化数据 ──
  // 渲染进程的 zustand persist（设置/技能/Vibe/token 统计）桥接到这里，
  // 避免 WebUI（不同 origin）读不到 localStorage 导致"未配置模型"。
  const kvPath = path.join(app.getPath('userData'), 'clerkbox-kv.json')
  let kvWriteQueue: Promise<void> = Promise.resolve()

  function readKvStore(): Record<string, string> {
    try {
      if (fs.existsSync(kvPath)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(kvPath, 'utf-8'))
        if (parsed && typeof parsed === 'object') {
          const out: Record<string, string> = {}
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'string') out[k] = v
          }
          return out
        }
      }
    } catch (err) {
      console.error('[kv] read failed:', err)
    }
    return {}
  }

  function writeKvStore(data: Record<string, string>): void {
    const tempPath = `${kvPath}.tmp-${process.pid}`
    fs.writeFileSync(tempPath, JSON.stringify(data), 'utf-8')
    try {
      fs.renameSync(tempPath, kvPath)
    } catch (err) {
      try {
        fs.copyFileSync(tempPath, kvPath)
      } finally {
        fs.rmSync(tempPath, { force: true })
      }
      if (!fs.existsSync(kvPath)) throw err
    }
  }

  ipcMain.handle('kvGet', (_event, key: unknown): string | null => {
    if (typeof key !== 'string') return null
    const data = readKvStore()
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
  })

  ipcMain.handle('kvSet', (_event, key: unknown, value: unknown): Promise<void> => {
    if (typeof key !== 'string' || typeof value !== 'string') return Promise.resolve()
    const write = kvWriteQueue.then(() => {
      const data = readKvStore()
      data[key] = value
      writeKvStore(data)
    })
    kvWriteQueue = write.catch((err) => console.error('[kv] write failed:', err))
    return write
  })

  ipcMain.handle('kvRemove', (_event, key: unknown): Promise<void> => {
    if (typeof key !== 'string') return Promise.resolve()
    const write = kvWriteQueue.then(() => {
      const data = readKvStore()
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        delete data[key]
        writeKvStore(data)
      }
    })
    kvWriteQueue = write.catch((err) => console.error('[kv] remove failed:', err))
    return write
  })

  // ── 热土引擎（REngine）账号系统：登录 / 登出 / 状态 / 数据段云同步 ──

  /** 校验同步 kinds 入参：必须是 'memory' | 'models' 数组 */
  function parseSyncKinds(value: unknown): AccountSyncKind[] | null {
    if (!Array.isArray(value)) return null
    if (!value.every((item): item is AccountSyncKind => item === 'memory' || item === 'models')) return null
    return [...new Set(value)]
  }

  ipcMain.handle('accountLogin', () => rtAccount.rtLogin())

  ipcMain.handle('accountLogout', () => {
    rtAccount.rtLogout()
  })

  ipcMain.handle('accountGetStatus', () => rtAccount.rtGetStatus())

  ipcMain.handle('accountSyncUpload', (_event, kinds: unknown) => {
    const parsed = parseSyncKinds(kinds)
    if (!parsed) throw new Error('Invalid sync kinds')
    return rtAccount.rtSyncUpload(parsed)
  })

  ipcMain.handle('accountSyncDownload', (_event, kinds: unknown, force: unknown) => {
    const parsed = parseSyncKinds(kinds)
    if (!parsed) throw new Error('Invalid sync kinds')
    return rtAccount.rtSyncDownload(parsed, force === true)
  })

  // ── MCP（Model Context Protocol）服务器管理 ──
  // 配置由渲染进程 settings-store 持久化，主进程只负责连接与工具调用
  ipcMain.handle('mcpSync', (_event, servers: unknown) => {
    if (!Array.isArray(servers)) return mcpManager.statuses()
    return mcpManager.sync(servers as McpServerConfig[])
  })
  ipcMain.handle('mcpStatus', () => mcpManager.statuses())
  ipcMain.handle('mcpTools', () => mcpManager.allTools())
  ipcMain.handle('mcpTest', (_event, server: unknown) => {
    const config = server as McpServerConfig
    if (!config || typeof config !== 'object' || !config.name) {
      return { error: 'Invalid MCP server config' }
    }
    return mcpManager.test(config)
  })
  ipcMain.handle('mcpCallTool', (_event, toolName: unknown, args: unknown) => {
    if (typeof toolName !== 'string') {
      return { content: 'Error: 非法的 MCP 工具调用参数', isError: true }
    }
    return mcpManager.callTool(toolName, (args ?? {}) as Record<string, unknown>)
  })

  // ── MCP 插件市场：抓取 mcp-cn.com（MCP Hub 中国版，中文描述 + 国内直连）──
  ipcMain.handle('mcpSearch', async () => {
    try {
      const res = await fetchHttpsText(
        'https://www.mcp-cn.com/api/servers?page=1&pageSize=100',
        {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ClerkBox/1.7',
          Accept: 'application/json',
        },
        4 * 1024 * 1024
      )
      if (res.statusCode !== 200) throw new Error(`mcp-cn.com returned HTTP ${res.statusCode}`)
      const payload = JSON.parse(res.body) as { code?: number; data?: unknown }
      const list = Array.isArray(payload.data) ? (payload.data as Array<Record<string, unknown>>) : []

      const servers = list.map((item) => {
        // connections 是无引号 JSON 字符串，取第一个可解析的连接配置
        let connection: McpMarketConnection | null = null
        const rawConn = typeof item.connections === 'string' ? item.connections : ''
        if (rawConn) {
          try {
            const parsed = parseLenientJson(rawConn)
            const entries = Array.isArray(parsed)
              ? parsed
              : parsed && typeof parsed === 'object'
                ? [parsed]
                : []
            const first = entries.find(
              (e): e is Record<string, unknown> => !!e && typeof e === 'object'
            ) as Record<string, unknown> | undefined
            if (first) {
              const config = (first.config && typeof first.config === 'object'
                ? first.config
                : first) as Record<string, unknown>
              const type = String(first.type ?? 'stdio').toLowerCase()
              if (type === 'stdio') {
                connection = {
                  type: 'stdio',
                  command: typeof config.command === 'string' ? config.command : undefined,
                  args: Array.isArray(config.args) ? config.args.map((a) => String(a)) : undefined,
                  env:
                    config.env && typeof config.env === 'object'
                      ? Object.fromEntries(
                          Object.entries(config.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])
                        )
                      : undefined,
                }
              } else {
                // http / sse / streamable-http 统一归一为 http
                connection = {
                  type: 'http',
                  url: typeof config.url === 'string' ? config.url : undefined,
                  headers:
                    config.headers && typeof config.headers === 'object'
                      ? Object.fromEntries(
                          Object.entries(config.headers as Record<string, unknown>).map(([k, v]) => [
                            k,
                            String(v),
                          ])
                        )
                      : undefined,
                }
              }
            }
          } catch {
            connection = null
          }
        }
        return {
          id: String(item.server_id ?? item.id ?? ''),
          name: String(item.display_name ?? item.name ?? ''),
          qualifiedName: String(item.qualified_name ?? ''),
          description: String(item.description ?? ''),
          logo: typeof item.logo === 'string' && item.logo ? item.logo : null,
          creator: String(item.creator ?? ''),
          useCount: Number(item.use_count ?? 0) || 0,
          tags: typeof item.tag === 'string' && item.tag
            ? item.tag.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
            : Array.isArray(item.tags)
              ? item.tags.map((s) => String(s))
              : [],
          isDomestic: item.is_domestic === true,
          packageUrl: typeof item.package_url === 'string' && item.package_url ? item.package_url : null,
          connection,
        }
      })
      return { servers }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ── WebUI 控制 ──
  ipcMain.handle('startWebUI', async (_event, lanAccess?: boolean) => {
    try {
      return await startWebUI({ lanAccess: lanAccess === true })
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('stopWebUI', () => {
    stopWebUI()
    return { ok: true }
  })
  ipcMain.handle('getWebUIStatus', () => {
    return getWebUIStatus()
  })
  // 局域网 IPv4 列表：WebUI 弹窗用于拼手机可访问的 URL 并生成二维码
  ipcMain.handle('getLanAddresses', () => {
    return getLanAddresses()
  })
}

/** Validate fetched SKILL.md structure and return human-readable warnings. */
function validateSkillMd(content: string): { valid: boolean; warnings: string[] } {
  const warnings: string[] = []
  const trimmed = content.trim()
  if (!trimmed.startsWith('---')) {
    warnings.push('缺少 YAML frontmatter，无法确认技能元数据')
    return { valid: false, warnings }
  }
  const normalized = trimmed.replace(/\r\n/g, '\n')
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) {
    warnings.push('frontmatter 格式不合法')
    return { valid: false, warnings }
  }
  const fm = fmMatch[1]
  const bodyStart = fmMatch[0].length
  const body = normalized.slice(bodyStart).trim()

  // 用 js-yaml 解析 frontmatter 做校验（与 parseSkillMd 一致）；
  // 解析失败时回退到正则提取 name/description，但保持返回 warnings 而非抛错
  let name = ''
  let description = ''
  let parsed: Record<string, unknown> | null = null
  try {
    const loaded = yaml.load(fm)
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      parsed = loaded as Record<string, unknown>
      const getStr = (key: string) => {
        const v = parsed![key]
        return typeof v === 'string' ? v.trim() : v == null ? '' : String(v)
      }
      name = getStr('name')
      description = getStr('description')
    }
  } catch {
    // 解析失败：回退到正则提取 name/description
    const nameMatch = fm.match(/^name:\s*(.+)$/m)
    const descMatch = fm.match(/^description:\s*(.+)$/m)
    name = nameMatch ? nameMatch[1].trim() : ''
    description = descMatch ? descMatch[1].trim() : ''
  }

  // name/description 必需校验
  if (!name) warnings.push('frontmatter 中缺少 name 字段')
  if (!description) warnings.push('frontmatter 中缺少 description 字段')

  // trigger_keywords 校验：若存在则必须为数组或字符串
  if (parsed && parsed['trigger_keywords'] !== undefined) {
    const tk = parsed['trigger_keywords']
    if (typeof tk !== 'string' && !Array.isArray(tk)) {
      warnings.push('frontmatter 中 trigger_keywords 必须为字符串或字符串数组')
    }
  }

  // chains_to 校验：若存在则必须为字符串或数组
  if (parsed && parsed['chains_to'] !== undefined) {
    const ct = parsed['chains_to']
    if (typeof ct !== 'string' && !Array.isArray(ct)) {
      warnings.push('frontmatter 中 chains_to 必须为字符串或字符串数组')
    }
  }

  // 正文 ≥20 字符校验
  if (body.length < 20) warnings.push('SKILL.md 正文过短，可能未包含有效指令')
  // Always warn about external content
  warnings.push('该 skill 来自外部仓库，安装前请人工审阅 SKILL.md 内容后再激活')
  return { valid: name.length > 0 && description.length > 0, warnings }
}

/** 解析 CocoLoop SSR (Next.js App Router RSC) HTML 中的 initialItems 数组。
 *  RSC 把 JSON 作为字符串嵌入 HTML，每个 " 被转义为 \"。
 *  用栈匹配找到完整数组后 unescape 再 JSON.parse。
 *
 *  注意：搜索页 SSR HTML 把整个 RSC 流字符串化后嵌入外层流，
 *  因此 marker 实际形式是 \"initialItems\":[（双层转义）。
 *  统一查找 initialItems 字面量后回溯到第一个 [，兼容两种形式。 */
function parseCocoloopSkills(html: string): Array<{
  id: string
  name: string
  titleCn: string
  author: string
  creatorSlug: string
  description: string
  skillUrl: string
  downloadUrl: string
  githubUrl: string
  emoji: string
  bssLevel: string
  downloads: string
  favorites: string
  installs: string
  recommend: string
  stars: number
  updatedAt: string
}> {
  // 1. 找到 initialItems 字面量位置（兼容转义/非转义两种形式）
  const markerIdx = html.indexOf('initialItems')
  if (markerIdx < 0) return []
  // 2. 从 marker 后回溯找到第一个 [（可能在转义引号之后）
  let arrayStart = -1
  for (let i = markerIdx; i < html.length; i++) {
    if (html[i] === '[') { arrayStart = i; break }
  }
  if (arrayStart < 0) return []

  // 3. 用栈匹配找到对应的 ]，考虑转义引号
  let depth = 0
  let inString = false
  let escape = false
  let arrayEnd = -1
  for (let i = arrayStart; i < html.length; i++) {
    const ch = html[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0 && ch === ']') { arrayEnd = i; break }
    }
  }
  if (arrayEnd < 0) return []

  // 3. 提取数组字符串，unescape 后 JSON.parse
  //    RSC 字符串转义只转义两种字符：" → \"、\ → \\。
  //    反向操作只需还原这两种，\n/\r/\t 是 JSON 层的转义，由 JSON.parse 处理。
  const rawArray = html.slice(arrayStart, arrayEnd + 1)
  let unescaped = rawArray
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
  let parsed: unknown
  try {
    parsed = JSON.parse(unescaped)
  } catch {
    // 部分字段含未预期转义时回退：逐对象提取
    return parseCocoloopSkillsFallback(html)
  }
  if (!Array.isArray(parsed)) return []

  const asString = (v: unknown) => (typeof v === 'string' ? v : '')
  const result: Array<ReturnType<typeof parseCocoloopSkills> extends Array<infer T> ? T : never> = []
  for (const item of parsed) {
    if (!isRecord(item)) continue
    const id = asString(item.id)
    const downloadUrl = asString(item.downloadUrl)
    if (!id || !downloadUrl) continue
    // 解析 downloads 文本为数值（如 "419.8k" → 419800）
    const parseCount = (text: string): number => {
      const m = text.match(/([\d.]+)\s*([km]?)/i)
      if (!m) return 0
      const n = parseFloat(m[1]) || 0
      const unit = m[2].toLowerCase()
      return Math.round(n * (unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1))
    }
    result.push({
      id,
      name: asString(item.title) || asString(item.slug) || `skill-${id}`,
      titleCn: asString(item.titleCn),
      author: asString(item.creator) || 'unknown',
      creatorSlug: asString(item.creatorSlug),
      description: asString(item.description),
      skillUrl: `https://hub.cocoloop.cn/skills/${id}`,
      downloadUrl,
      githubUrl: downloadUrl,
      emoji: asString(item.emoji),
      bssLevel: asString(item.bssLevel),
      downloads: asString(item.downloads),
      favorites: asString(item.favorites),
      installs: asString(item.installs),
      recommend: asString(item.recommend),
      stars: parseCount(asString(item.downloads)),
      updatedAt: '',
    })
  }
  return result
}

/** Fallback：当整段 JSON.parse 失败时，用正则逐字段提取 skill 对象。 */
function parseCocoloopSkillsFallback(html: string): Array<ReturnType<typeof parseCocoloopSkills> extends Array<infer T> ? T : never> {
  const fieldRegex = (name: string) => new RegExp(`\\"${name}\\":\\"((?:[^"\\\\]|\\\\.)*)\\"`, 'g')
  const ids = [...html.matchAll(fieldRegex('id'))].map(m => m[1])
  const downloadUrls = [...html.matchAll(fieldRegex('downloadUrl'))].map(m => m[1])
  const result: Array<ReturnType<typeof parseCocoloopSkills> extends Array<infer T> ? T : never> = []
  const maxLen = Math.min(ids.length, downloadUrls.length)
  for (let i = 0; i < maxLen; i++) {
    const id = ids[i]
    const downloadUrl = downloadUrls[i]
    if (!/^\d+$/.test(id) || !downloadUrl.startsWith('https://')) continue
    result.push({
      id,
      name: `skill-${id}`,
      titleCn: '',
      author: 'unknown',
      creatorSlug: '',
      description: '',
      skillUrl: `https://hub.cocoloop.cn/skills/${id}`,
      downloadUrl,
      githubUrl: downloadUrl,
      emoji: '',
      bssLevel: '',
      downloads: '',
      favorites: '',
      installs: '',
      recommend: '',
      stars: 0,
      updatedAt: '',
    })
  }
  return result
}

/** 下载二进制 zip 到临时文件，返回路径。 */
function fetchHttpsBuffer(url: string, headers: Record<string, string>, maxBytes: number): Promise<{ statusCode: number; filePath: string; size: number }> {
  return new Promise((resolve, reject) => {
    const tempPath = path.join(os.tmpdir(), `clerkbox-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`)
    const request = https.get(url, { headers }, (response) => {
      const statusCode = response.statusCode ?? 0
      if (statusCode !== 200) {
        response.resume()
        resolve({ statusCode, filePath: '', size: 0 })
        return
      }
      const writeStream = fs.createWriteStream(tempPath)
      let receivedBytes = 0
      response.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length
        if (receivedBytes > maxBytes) {
          response.destroy(new Error(`Response exceeds ${maxBytes} byte limit`))
          writeStream.destroy()
          try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
          return
        }
        writeStream.write(chunk)
      })
      response.on('end', () => {
        writeStream.end(() => resolve({ statusCode, filePath: tempPath, size: receivedBytes }))
      })
      response.on('error', (err) => {
        writeStream.destroy()
        try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
        reject(err)
      })
    })
    request.setTimeout(SKILL_REQUEST_TIMEOUT_MS * 4, () => request.destroy(new Error('Request timed out')))
    request.on('error', reject)
  })
}

/** 解压 zip 到临时目录，复用 parseSkillFile 的解压逻辑。
 *  返回 { files, skillMdContent, warnings }。 */
async function extractSkillZip(zipPath: string): Promise<{
  files: Array<{ path: string; content: string }>
  skillMdContent: string
  warnings: string[]
}> {
  const binaryExt = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
    '.zip', '.gz', '.tar', '.rar', '.7z',
    '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.avi', '.mov',
    '.pdf', '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
  ])
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerkbox-cocoloop-'))
  try {
    assertSafeSkillArchive(zipPath)
    const runExtractor = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8_192) })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(stderr || `Archive extraction failed with exit code ${code ?? 'unknown'}`))
      })
    })
    if (process.platform === 'win32') {
      // 注意：Node spawn 传额外参数给 PowerShell -Command 的 param() 绑定不可靠，
      // 改用 -File 脚本文件方式，避免参数丢失导致 Expand-Archive 收到 null。
      const scriptPath = path.join(os.tmpdir(), `clerkbox-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`)
      fs.writeFileSync(scriptPath, `param([string]$source, [string]$destination) Expand-Archive -LiteralPath $source -DestinationPath $destination -Force`, 'utf-8')
      try {
        await runExtractor('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-source', zipPath,
          '-destination', tempDir,
        ])
      } finally {
        try { fs.unlinkSync(scriptPath) } catch { /* ignore */ }
      }
    } else {
      await runExtractor('unzip', ['-o', zipPath, '-d', tempDir])
    }

    const skillMdPath = findSkillMd(tempDir)
    if (!skillMdPath) {
      const entries = listEntries(tempDir)
      throw new Error(`ZIP 中未找到 SKILL.md 文件，解压后包含：${entries.slice(0, 10).join(', ')}${entries.length > 10 ? ' ...' : ''}`)
    }
    const skillMdStat = fs.statSync(skillMdPath)
    if (skillMdStat.size > MAX_SKILL_FILE_BYTES) throw new Error('SKILL.md exceeds the allowed size')
    const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8')

    // 遍历所有文件
    const collected: Array<{ path: string; content: string }> = []
    let totalBytes = 0
    const walk = (dir: string, base: string = '') => {
      if (collected.length >= MAX_SKILL_FILES || totalBytes >= MAX_SKILL_DIRECTORY_BYTES) return
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (collected.length >= MAX_SKILL_FILES || totalBytes >= MAX_SKILL_DIRECTORY_BYTES) return
        const rel = base ? `${base}/${e.name}` : e.name
        if (e.isDirectory()) {
          walk(path.join(dir, e.name), rel)
        } else if (e.isFile()) {
          const lower = path.extname(e.name).toLowerCase()
          if (binaryExt.has(lower)) continue
          const absPath = path.join(dir, e.name)
          let stat: fs.Stats
          try { stat = fs.statSync(absPath) } catch { continue }
          if (stat.size > MAX_SKILL_FILE_BYTES || totalBytes + stat.size > MAX_SKILL_DIRECTORY_BYTES) continue
          let content: string
          try { content = fs.readFileSync(absPath, 'utf-8') } catch { continue }
          if (content.indexOf('\u0000') !== -1) continue
          totalBytes += stat.size
          collected.push({ path: rel, content })
        }
      }
    }
    walk(tempDir)

    // 若 SKILL.md 在子目录，提升到根级一份
    if (!collected.find((f) => f.path === 'SKILL.md' || /^SKILL\.md$/i.test(f.path))) {
      const skillMdRel = path.relative(tempDir, skillMdPath).replace(/\\/g, '/')
      const item = collected.find((f) => f.path === skillMdRel)
      if (item) collected.unshift({ path: 'SKILL.md', content: item.content })
    }

    const files = collected.length > 0 ? collected : [{ path: 'SKILL.md', content: skillMdContent }]
    const { valid, warnings } = validateSkillMd(skillMdContent)
    warnings.push('该 skill 来自 CocoLoop Hub（hub.cocoloop.cn），安装前请人工审阅 SKILL.md 内容后再激活')
    if (!valid) warnings.unshift('SKILL.md 校验未通过：name/description 必需')
    return { files, skillMdContent, warnings }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** 下载 CocoLoop skill zip 解压后只返回 SKILL.md 内容（兼容旧 fetchSkillMd 接口）。 */
async function fetchCocoloopSkillMd(downloadUrl: string): Promise<string> {
  if (!/^https?:\/\/dl\.cocoloop\.cn\//i.test(downloadUrl)) {
    return JSON.stringify({ error: 'Invalid CocoLoop download URL' })
  }
  try {
    const { statusCode, filePath } = await fetchHttpsBuffer(
      downloadUrl,
      { 'User-Agent': 'Mozilla/5.0 ClerkBox/1.7' },
      MAX_SKILL_ARCHIVE_BYTES
    )
    if (statusCode !== 200 || !filePath) {
      return JSON.stringify({ error: `Download failed: HTTP ${statusCode}` })
    }
    try {
      const { skillMdContent, warnings } = await extractSkillZip(filePath)
      return JSON.stringify({ success: true, content: skillMdContent, warnings })
    } finally {
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

/** 下载 CocoLoop skill zip 并解压，返回完整文件列表（兼容旧 fetchSkillFromRepo 接口）。 */
async function fetchCocoloopSkillDir(downloadUrl: string): Promise<string> {
  if (!/^https?:\/\/dl\.cocoloop\.cn\//i.test(downloadUrl)) {
    return JSON.stringify({ error: 'Invalid CocoLoop download URL' })
  }
  try {
    const { statusCode, filePath } = await fetchHttpsBuffer(
      downloadUrl,
      { 'User-Agent': 'Mozilla/5.0 ClerkBox/1.7' },
      MAX_SKILL_ARCHIVE_BYTES
    )
    if (statusCode !== 200 || !filePath) {
      return JSON.stringify({ error: `Download failed: HTTP ${statusCode}` })
    }
    try {
      const { files, skillMdContent, warnings } = await extractSkillZip(filePath)
      if (!skillMdContent) return JSON.stringify({ error: 'SKILL.md not found in archive' })
      return JSON.stringify({ success: true, files, warnings })
    } finally {
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

/** 扫描技能目录，发现 ClerkBox 自有路径 + Anthropic 兼容路径的技能。
 *  扫描顺序（优先级从高到低）：
 *    1. ~/.clerkbox/skills/        （ClerkBox 全局，自有路径）
 *    2. <workingDir>/.clerkbox/skills/ （ClerkBox 项目级，自有路径）
 *    3. ~/.claude/skills/          （Anthropic 兼容，全局）
 *    4. <workingDir>/.claude/skills/   （Anthropic 兼容，项目级）
 *  对每个 <name>/SKILL.md 用 parseSkillMd 提取元数据，并递归读取目录所有文件。 */
function scanSkillDirs(workingDir: string): Array<{
  slug: string
  name: string
  description: string
  icon: string
  category: string
  triggerKeywords: string[]
  version: string
  author: string
  chainsTo: string[]
  source: 'global-clerkbox' | 'project-clerkbox' | 'global-claude' | 'project-claude'
  skillMdPath: string
  skillMdContent: string
  files: Array<{ path: string; content: string }>
}> {
  type ScanSource = 'global-clerkbox' | 'project-clerkbox' | 'global-claude' | 'project-claude'
  const result: Array<{
    slug: string
    name: string
    description: string
    icon: string
    category: string
    triggerKeywords: string[]
    version: string
    author: string
    chainsTo: string[]
    source: ScanSource
    skillMdPath: string
    skillMdContent: string
    files: Array<{ path: string; content: string }>
  }> = []

  // 跳过常见二进制扩展名（与 parseSkillFile 保持一致）
  const binaryExt = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
    '.zip', '.gz', '.tar', '.rar', '.7z',
    '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.avi', '.mov',
    '.pdf', '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
  ])
  const MAX_SKILLS_PER_SOURCE = 100

  /** Scan a bounded set of local skill files so discovery cannot exhaust memory. */
  const scanOne = (skillsRoot: string, source: ScanSource) => {
    if (!fs.existsSync(skillsRoot)) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.slice(0, MAX_SKILLS_PER_SOURCE)) {
      if (!e.isDirectory()) continue
      const slug = e.name
      const skillDir = path.join(skillsRoot, slug)
      const skillMdAbs = path.join(skillDir, 'SKILL.md')
      if (!fs.existsSync(skillMdAbs)) continue
      try {
        const skillMdStat = fs.statSync(skillMdAbs)
        if (!skillMdStat.isFile() || skillMdStat.size > MAX_SKILL_FILE_BYTES) continue
        const skillMdContent = fs.readFileSync(skillMdAbs, 'utf-8')
        const parsed = parseSkillMd(skillMdContent)
        const files: Array<{ path: string; content: string }> = []
        let totalBytes = 0
        const walk = (dir: string, base: string = '') => {
          if (files.length >= MAX_SKILL_FILES || totalBytes >= MAX_SKILL_DIRECTORY_BYTES) return
          let ents: fs.Dirent[]
          try {
            ents = fs.readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const ent of ents) {
            if (files.length >= MAX_SKILL_FILES || totalBytes >= MAX_SKILL_DIRECTORY_BYTES) return
            const rel = base ? `${base}/${ent.name}` : ent.name
            if (ent.isDirectory()) {
              walk(path.join(dir, ent.name), rel)
            } else if (ent.isFile()) {
              const lower = path.extname(ent.name).toLowerCase()
              if (binaryExt.has(lower)) continue
              const filePath = path.join(dir, ent.name)
              let stat: fs.Stats
              try {
                stat = fs.statSync(filePath)
              } catch {
                continue
              }
              if (stat.size > MAX_SKILL_FILE_BYTES || totalBytes + stat.size > MAX_SKILL_DIRECTORY_BYTES) continue
              let content: string
              try {
                content = fs.readFileSync(filePath, 'utf-8')
              } catch {
                continue
              }
              if (content.indexOf('\u0000') !== -1) continue
              totalBytes += stat.size
              files.push({ path: rel, content })
            }
          }
        }
        walk(skillDir)
        result.push({
          slug,
          name: parsed.name,
          description: parsed.description,
          icon: parsed.icon,
          category: parsed.category,
          triggerKeywords: parsed.triggerKeywords,
          version: parsed.version,
          author: parsed.author,
          chainsTo: parsed.chainsTo,
          source,
          skillMdPath: skillMdAbs,
          skillMdContent,
          files,
        })
      } catch {
        // 单个技能解析失败跳过，不影响其他
      }
    }
  }

  // ClerkBox 自有路径（优先）
  scanOne(path.join(os.homedir(), '.clerkbox', 'skills'), 'global-clerkbox')
  scanOne(path.join(workingDir, '.clerkbox', 'skills'), 'project-clerkbox')
  // Anthropic 兼容路径
  scanOne(path.join(os.homedir(), '.claude', 'skills'), 'global-claude')
  scanOne(path.join(workingDir, '.claude', 'skills'), 'project-claude')
  return result
}

// ── Web search/fetch helpers ──

interface SearchResult {
  title: string
  snippet: string
  url: string
}

/** Return whether an IPv4 address is private, reserved, multicast, or otherwise non-public. */
function isBlockedIpv4Address(address: string): boolean {
  const [first, second] = address.split('.').map(Number)
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
}

/** Expand a valid IPv6 address into eight 16-bit groups. */
function expandIpv6Address(address: string): number[] | null {
  let normalized = address.toLowerCase()
  const lastColon = normalized.lastIndexOf(':')
  if (lastColon !== -1 && normalized.includes('.')) {
    const ipv4 = normalized.slice(lastColon + 1)
    if (net.isIP(ipv4) !== 4) return null
    const [a, b, c, d] = ipv4.split('.').map(Number)
    normalized = `${normalized.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  const compressed = normalized.includes('::')
  const [left, right = ''] = normalized.split('::')
  const leftGroups = left ? left.split(':') : []
  const rightGroups = compressed && right ? right.split(':') : []
  const groups = compressed
    ? [...leftGroups, ...Array(8 - leftGroups.length - rightGroups.length).fill('0'), ...rightGroups]
    : leftGroups
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.map((group) => Number.parseInt(group, 16))
}

/** Return whether an IP address can target a local or non-routable network. */
function isBlockedNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  const family = net.isIP(normalized)
  if (family === 4) return isBlockedIpv4Address(normalized)
  if (family !== 6) return true

  const groups = expandIpv6Address(normalized)
  if (!groups) return true
  const isUnspecified = groups.every((group) => group === 0)
  const isLoopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1
  const isUniqueLocal = (groups[0] & 0xfe00) === 0xfc00
  const isLinkLocal = (groups[0] & 0xffc0) === 0xfe80
  const isMulticast = (groups[0] & 0xff00) === 0xff00
  if (isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isMulticast) return true

  // IPv4-mapped IPv6 addresses are routable as the embedded IPv4 address.
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  if (isIpv4Mapped) {
    const embeddedIpv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    return isBlockedIpv4Address(embeddedIpv4)
  }

  return false
}

/** Reject schemes and literal hosts that could make the web tool reach local services. */
function assertPublicWebUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 8_192) {
    throw new Error('Invalid URL')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Invalid URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme: ${parsed.protocol}`)
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Local network URLs are not allowed')
  }

  if (net.isIP(host) && isBlockedNetworkAddress(host)) {
    throw new Error('Private network URLs are not allowed')
  }

  return parsed
}

/** Resolve each host immediately before connecting and reject private DNS answers. */
function lookupPublicHost(
  hostname: string,
  options: number | dns.LookupOneOptions | dns.LookupAllOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family: number
  ) => void
): void {
  const lookupOptions = typeof options === 'number' ? { family: options } : options
  // Node ≥ 22（autoSelectFamily 默认开启）会以 all:true 调用 lookup，
  // 此时 callback 必须返回地址数组；返回单地址格式会导致
  // "Invalid IP address: undefined"（socket 层拿不到地址）。
  const wantAll = typeof options === 'object' && options !== null && (options as dns.LookupAllOptions).all === true
  dns.lookup(hostname, {
    family: lookupOptions.family,
    hints: lookupOptions.hints,
    verbatim: true,
    all: true,
  }, (error, addresses) => {
    if (error) {
      callback(error, '', 0)
      return
    }
    const records = addresses as dns.LookupAddress[]
    if (records.length === 0 || records.some((record) => isBlockedNetworkAddress(record.address))) {
      callback(new Error('Private network DNS result is not allowed') as NodeJS.ErrnoException, '', 0)
      return
    }
    if (wantAll) {
      callback(null, records, 0)
    } else {
      callback(null, records[0].address, records[0].family)
    }
  })
}

/** Search with Bing HTML (no API key needed, China-accessible) */
async function searchWithBingHtml(query: string, count: number): Promise<SearchResult[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${count}&setlang=zh-CN`
  const html = await fetchUrl(url, 200000)

  const $ = cheerio.load(html)
  const results: SearchResult[] = []

  // DOM parsing tolerates small markup changes better than regular expressions.
  $('.b_algo').each((_i, el) => {
    if (results.length >= count) return false
    const $el = $(el)
    const $link = $el.find('h2 a').first()
    const linkUrl = $link.attr('href') || ''
    const title = $link.text().trim()
    let snippet = $el.find('p').first().text().trim()
    if (!snippet) {
      snippet = $el.find('.b_caption').first().text().trim()
    }
    if (!snippet) {
      snippet = $el.text().trim().slice(0, 150)
    }
    if (title && linkUrl) {
      results.push({ title, snippet, url: linkUrl })
    }
  })

  if (results.length === 0) {
    throw new Error('未从必应搜索页解析到结果（页面结构可能已变化）')
  }

  return results
}

/** Fetch a URL with proper handling of redirects, gzip, and timeouts */
function fetchUrl(targetUrl: string, maxBytes: number, customHeaders?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const doFetch = (url: string, redirectsLeft: number) => {
      if (redirectsLeft < 0) {
        reject(new Error('Too many redirects'))
        return
      }

      let parsed: URL
      try {
        parsed = assertPublicWebUrl(url)
      } catch (err) {
        reject(err)
        return
      }
      const fetcher = parsed.protocol === 'https:' ? https : http
      const req = fetcher.get(
        parsed,
        {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'identity',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            ...customHeaders,
          },
          // HTTP requests resolve one connection target at a time.
          lookup: lookupPublicHost as net.LookupFunction,
        },
        (res) => {
          // Handle redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, parsed).toString()
            res.resume()
            doFetch(nextUrl, redirectsLeft - 1)
            return
          }

          if (res.statusCode && res.statusCode >= 400) {
            res.resume()
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }

          // Accumulate chunks and concatenate once to avoid quadratic copying.
          const chunks: Buffer[] = []
          let receivedLength = 0
          res.on('data', (chunk: Buffer) => {
            const remaining = maxBytes - receivedLength
            if (remaining <= 0) return
            if (chunk.length > remaining) {
              chunks.push(chunk.subarray(0, remaining))
              receivedLength += remaining
              req.destroy()
              resolve(Buffer.concat(chunks).toString('utf-8'))
              return
            }
            chunks.push(chunk)
            receivedLength += chunk.length
            if (receivedLength >= maxBytes) {
              req.destroy()
              resolve(Buffer.concat(chunks).toString('utf-8'))
            }
          })
          res.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf-8'))
          })
          res.on('error', (err: Error) => reject(err))
        }
      )
      req.on('error', (err: Error) => reject(err))
      req.setTimeout(15000, () => {
        req.destroy(new Error('Request timeout'))
      })
    }

    doFetch(targetUrl, 5)
  })
}

/** Mobile UA for sites that block desktop scraping */
const MOBILE_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
}

/** Fetch URL with retry: try desktop UA first, then mobile UA on 403 */
async function fetchUrlRobust(url: string, maxBytes: number): Promise<string> {
  try {
    return await fetchUrl(url, maxBytes)
  } catch (e) {
    // On 403, retry with mobile UA
    if (e instanceof Error && e.message.includes('HTTP 403')) {
      return await fetchUrl(url, maxBytes, MOBILE_HEADERS)
    }
    throw e
  }
}

/** Extract text from SPA pre-rendered data (Next.js, Vue, etc.) */
function extractSpaContent(html: string): string | null {
  // Next.js: __NEXT_DATA__ JSON
  const nextMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1])
      const text = extractTextFromJson(data)
      if (text && text.length > 200) return text
    } catch { /* Invalid optional SPA payloads fall back to HTML extraction. */ }
  }

  // Vue/Nuxt: window.__NUXT__
  const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*\(function\([^)]*\)\s*\{[\s\S]*?\}\)\([^)]*\)/i)
  if (nuxtMatch) {
    // Hard to parse, skip
  }

  // Generic: window.__INITIAL_STATE__ or window.__INITIAL_DATA__
  const stateMatch = html.match(/window\.(?:__INITIAL_STATE__|__INITIAL_DATA__|__APOLLO_STATE__|__NUXT__)\s*=\s*([\s\S]*?);\s*<\/script>/i)
  if (stateMatch) {
    try {
      const data = JSON.parse(stateMatch[1])
      const text = extractTextFromJson(data)
      if (text && text.length > 200) return text
    } catch { /* Invalid optional SPA payloads fall back to HTML extraction. */ }
  }

  // Try og:description meta tag
  const ogDescMatch = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i)
  if (ogDescMatch && ogDescMatch[1].length > 50) {
    return ogDescMatch[1]
  }

  return null
}

/** Recursively extract text content from a JSON object */
function extractTextFromJson(obj: unknown, depth = 0): string {
  if (depth > 10) return ''
  if (typeof obj === 'string') {
    // Only return strings that look like content (not URLs, not too short)
    if (obj.length > 20 && !obj.startsWith('http') && !obj.startsWith('/_') && !obj.startsWith('data:')) {
      return obj
    }
    return ''
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => extractTextFromJson(item, depth + 1)).filter(Boolean).join('\n')
  }
  if (typeof obj === 'object' && obj !== null) {
    const parts: string[] = []
    for (const [key, value] of Object.entries(obj)) {
      if (['content', 'text', 'description', 'body', 'article', 'html', 'summary', 'title', 'excerpt'].includes(key)) {
        const text = extractTextFromJson(value, depth + 1)
        if (text) parts.push(text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/** Strip HTML tags from a string */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
}

/** Convert HTML to readable plain text */
function htmlToText(html: string): string {
  // 1) Remove non-content tags entirely (including their content)
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<button[\s\S]*?<\/button>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<canvas[\s\S]*?<\/canvas>/gi, '')
    .replace(/<video[\s\S]*?<\/video>/gi, '')
    .replace(/<audio[\s\S]*?<\/audio>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove common ad/banner containers
    .replace(/<(?:div|section|ul|ol)\s+[^>]*class="[^"]*(?:ad|banner|sidebar|menu|breadcrumb|cookie|consent|popup|modal|share|related|recommend|comment|widget)[^"]*"[^>]*>[\s\S]*?<\/(?:div|section|ul|ol)>/gi, '')

  // 2) Try to prefer <main>, <article>, or common content containers
  const contentMatch = text.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i)
  if (contentMatch && contentMatch[1].length > 200) {
    text = contentMatch[1]
  } else {
    // Try common content class/id patterns
    const divContentMatch = text.match(/<(?:div|section)\s+[^>]*(?:id|class)="[^"]*(?:content|article|post|entry|main|body|story|detail|document)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/i)
    if (divContentMatch && divContentMatch[1].length > 200) {
      text = divContentMatch[1]
    }
  }

  // 3) Convert block-level tags to newlines
  text = text
    .replace(/<(?:p|div|section|h[1-6]|br|li|tr|td|th|hr|blockquote|pre|ul|ol|table)[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|section|h[1-6]|li|tr|td|th|blockquote|pre|ul|ol|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')

  // 4) Strip remaining tags
  text = stripTags(text)

  // 5) Collapse whitespace and filter noise lines
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/^ +/gm, '')
    .replace(/ +$/gm, '')
    // Remove lines that are just punctuation or very short (likely UI noise)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      // Keep lines with meaningful content (>= 2 chars, not just symbols)
      if (line.length < 2) return false
      if (/^[•\-\*\|\s·]+$/.test(line)) return false
      return true
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text
}

// ── App lifecycle ──

// Log uncaught failures instead of terminating the main process without diagnostics.
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showErrorBox('主进程错误', err?.message || String(err))
  }
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showErrorBox('未处理的 Promise 错误', String(reason))
  }
})

// 设置 AppUserModelID：让 Windows 任务栏正确识别应用身份，
// 配合 BrowserWindow icon 让任务栏/开始菜单显示自定义图标而非默认 Electron 图标。
// 必须在 app.whenReady() 之前调用。
if (process.platform === 'win32') {
  app.setAppUserModelId('com.xmzf.clerkbox')
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  // 启动时校验热土账号 Token：失效则清理登录态（网络异常时保留，避免误登出）
  void rtAccount.rtVerifyStartupToken()

  // 服务器部署场景：设置 CLERKBOX_WEBUI_AUTO=1 时自动启动 WebUI 并打印访问地址，
  // 无需手动点击界面按钮即可远程访问。
  if (process.env.CLERKBOX_WEBUI_AUTO === '1') {
    startWebUI()
      .then(({ url }) => {
        console.log(`[WebUI] Auto-started: ${url}`)
      })
      .catch((e) => {
        console.error('[WebUI] Auto-start failed:', e)
      })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前清理 MCP 子进程、终端 PTY 与 VIBE 助手进程，避免残留
app.on('before-quit', () => {
  void mcpManager.disposeAll()
  winAcrylic.dispose()
  systemMedia.dispose()
  disposeAllTerminals()
})
