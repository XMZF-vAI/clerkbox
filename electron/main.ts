import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
} from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { exec, spawn } from 'child_process'
import * as iconv from 'iconv-lite'
import * as https from 'https'
import * as http from 'http'
import * as os from 'os'
import * as cheerio from 'cheerio'
import * as yaml from 'js-yaml'
import { registerApiProxyHandlers, bindApiProxyCleanup } from './api-proxy'

/** Resolve path relative to project root */
function projectRoot(...segments: string[]): string {
  return path.resolve(app.getAppPath(), ...segments)
}

/** 递归查找目录下的 SKILL.md（优先根级，其次任意层级，大小写不敏感） */
function findSkillMd(dir: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  // 优先：根级 SKILL.md
  for (const e of entries) {
    if (e.isFile() && /^skill\.md$/i.test(e.name)) {
      return path.join(dir, e.name)
    }
  }
  // 其次：递归子目录
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findSkillMd(path.join(dir, e.name))
      if (found) return found
    }
  }
  return null
}

/** 递归列出目录下所有文件相对路径（用于错误提示） */
function listEntries(dir: string, base: string = ''): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push(...listEntries(path.join(dir, e.name), rel))
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

function createWindow() {
  const preloadPath = projectRoot('dist-electron/electron/preload.js')

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
    },
  })

  // Dev or production URL
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(projectRoot('dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

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

// ── IPC Handlers ──

// M12: memory 文件操作全局序列化队列，防止并发写入导致索引损坏
const memWriteQueue: Promise<unknown>[] = []
function enqueueMemWrite<T>(op: () => Promise<T> | T): Promise<T> {
  const promise = (memWriteQueue.length > 0 ? memWriteQueue[memWriteQueue.length - 1] : Promise.resolve()).then(
    op,
    op
  )
  memWriteQueue.push(promise)
  promise.finally(() => {
    const idx = memWriteQueue.indexOf(promise)
    if (idx !== -1) memWriteQueue.splice(idx, 1)
  })
  return promise
}

function registerIpcHandlers() {
  // S8: dialog 调用前校验主窗口，避免空指针；同时提供无父窗口的 fallback 重载
  const showOpenDialogSafe = (options: Electron.OpenDialogOptions) =>
    mainWindow && !mainWindow.isDestroyed()
      ? dialog.showOpenDialog(mainWindow, options)
      : dialog.showOpenDialog(options)
  const showMessageBoxSafe = (options: Electron.MessageBoxOptions) =>
    mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBox(mainWindow, options)
      : dialog.showMessageBox(options)

  // 模型 API 代理（拉模型列表 / 测连接 / 流式对话 / 中止）
  registerApiProxyHandlers()

  // S7: 同步暴露平台信息(sandbox: true 后 preload 无法直接 require('os'))
  ipcMain.on('getPlatform', (event) => {
    event.returnValue = process.platform
  })
  ipcMain.on('getHomeDir', (event) => {
    event.returnValue = os.homedir()
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
    const ext = path.extname(filePath).toLowerCase()
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
      if (ext === '.skill') {
        skillMdContent = fs.readFileSync(filePath, 'utf-8')
        // .skill 文件本身就是单个 SKILL.md 内容
        files = [{ path: 'SKILL.md', content: skillMdContent }]
      } else if (ext === '.zip') {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerkbox-skill-'))
        const platform = process.platform
        if (platform === 'win32') {
          // PowerShell Expand-Archive 自带且路径兼容性好
          await new Promise<void>((resolve, reject) => {
            exec(
              `powershell -NoProfile -Command "Expand-Archive -Path '${filePath.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force"`,
              (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
            )
          })
        } else {
          await new Promise<void>((resolve, reject) => {
            exec(`unzip -o ${JSON.stringify(filePath)} -d ${JSON.stringify(tempDir)}`, (err) =>
              err ? reject(err) : resolve()
            )
          })
        }
        // 在解压目录中递归查找 SKILL.md（优先根级，其次任意层级）
        const skillMdPath = findSkillMd(tempDir)
        if (!skillMdPath) {
          const entries = listEntries(tempDir)
          throw new Error(`ZIP 中未找到 SKILL.md 文件，解压后包含：${entries.slice(0, 10).join(', ')}${entries.length > 10 ? ' ...' : ''}`)
        }
        skillMdContent = fs.readFileSync(skillMdPath, 'utf-8')

        // 遍历解压目录所有文件，保留目录结构，读取文本文件内容
        const collected: Array<{ path: string; content: string }> = []
        const walk = (dir: string, base: string = '') => {
          let entries: fs.Dirent[]
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of entries) {
            const rel = base ? `${base}/${e.name}` : e.name
            if (e.isDirectory()) {
              walk(path.join(dir, e.name), rel)
            } else if (e.isFile()) {
              const lower = path.extname(e.name).toLowerCase()
              if (binaryExt.has(lower)) continue
              const absPath = path.join(dir, e.name)
              let content: string
              try {
                content = fs.readFileSync(absPath, 'utf-8')
              } catch {
                continue
              }
              // 含 null 字节视为二进制，跳过
              if (content.indexOf('\u0000') !== -1) continue
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
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
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
      return fs.existsSync(filePath)
    } catch {
      return false
    }
  })

  ipcMain.handle('openExternal', async (_event, url: string) => {
    // S6: 仅允许 http/https scheme，防止 ms-msdt:/vbscript: 等协议处理器被利用（Follina 等 CVE）
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

  // S3: 路径遍历防护 — 拒绝规范化后仍含 `..` 的路径，防止读到 ~/.ssh、写到启动项等
  const MAX_READ_BYTES = 10 * 1024 * 1024  // 10MB — 防止同步读大文件导致 OOM
  const MAX_WRITE_BYTES = 10 * 1024 * 1024 // 10MB — 防止填满磁盘

  /** 规范化路径并拒绝包含 `..` 跳层的路径 */
  function assertSafePath(filePath: string): string {
    if (typeof filePath !== 'string' || !filePath) {
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
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
  })

  // S4: 命令注入防护 — 主进程侧拒绝明显的危险模式（渲染进程的 isDangerousCommand 可被绕过）
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
  ipcMain.handle(
    'executeCommand',
    async (_event, command: string, cwd?: string) => {
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
          resolve({ stdout: '', stderr: String(err), exitCode: 1, encodingFallback: false })
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
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
    async (_event, command: string, cwd: string | undefined, shellType: string) => {
      const blockReason = checkDangerousCommand(command)
      if (blockReason) {
        return { stdout: '', stderr: `命令被主进程拒绝：${blockReason}`, exitCode: -1 }
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
          resolve({ stdout: '', stderr: String(err), exitCode: 1, encodingFallback: false })
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
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
    const maxLen = maxLength ?? 30000
    try {
      // First try HTTP fetch (fast, works for SSR sites)
      const raw = await fetchUrlRobust(targetUrl, maxLen + 5000)
      let text = htmlToText(raw)

      // If HTTP extraction yielded enough content, return it
      if (text.length >= 200) {
        return { content: text.substring(0, maxLen), url: targetUrl }
      }

      // Not enough content → likely a SPA, use BrowserWindow to render
      try {
        const renderedText = await fetchWithBrowser(targetUrl, maxLen + 2000)
        if (renderedText && renderedText.length > 100) {
          return { content: renderedText.substring(0, maxLen), url: targetUrl }
        }
      } catch (e) {
        console.error('Browser fetch failed:', e)
      }

      // Browser also failed, try SPA pre-rendered data as last resort
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
        return { error: '页面无有效内容，无法提取', url: targetUrl }
      }

      return { content: text.substring(0, maxLen), url: targetUrl }
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
    const MAX_MEMORY_FILE_SIZE = 1024 * 1024 // 1 MB
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
          // P6: 跳过超大文件，避免一次性读入内存导致 OOM
          if (stat.size > MAX_MEMORY_FILE_SIZE) continue
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
        } catch {}
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

  // 扫描 .clerkbox/agents 目录下所有 .md 文件，返回自定义 agent 定义
  ipcMain.handle('scanAgents', async (_event, workingDir: string) => {
    try {
      const agentsDir = path.join(workingDir, '.clerkbox', 'agents')
      if (!fs.existsSync(agentsDir)) return []
      const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
      return files.map((filename) => {
        const fullPath = path.join(agentsDir, filename)
        const content = fs.readFileSync(fullPath, 'utf-8')
        return { filename, content }
      })
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
        const MAX_BYTES = 25000
        if (Buffer.byteLength(raw, 'utf-8') > MAX_BYTES) {
          let truncated = raw.substring(0, MAX_BYTES)
          const lastNewline = truncated.lastIndexOf('\n')
          if (lastNewline > 0) {
            truncated = truncated.substring(0, lastNewline)
          }
          raw = truncated
          wasTruncated = true
          reason = reason ? `${reason}; 字节数超过 ${MAX_BYTES}` : `字节数超过 ${MAX_BYTES}`
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
        const memDir = path.join(workingDir, '.clerkbox', 'memory')
        fs.mkdirSync(memDir, { recursive: true })
        const filePath = path.join(memDir, `${slug}.md`)
        const fileContent = `---\n${frontmatter}\n---\n\n${content}`
        fs.writeFileSync(filePath, fileContent, 'utf-8')
      })
    }
  )

  // 更新记忆索引 MEMORY.md：替换或追加一条索引行
  ipcMain.handle(
    'updateMemoryIndex',
    async (_event, workingDir: string, entryLine: string, slug: string): Promise<void> => {
      return enqueueMemWrite(async () => {
        const indexPath = path.join(workingDir, '.clerkbox', 'memory', 'MEMORY.md')
        let existing = ''
        try {
          if (fs.existsSync(indexPath)) {
            existing = fs.readFileSync(indexPath, 'utf-8')
          }
        } catch {}

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
        fs.mkdirSync(path.dirname(indexPath), { recursive: true })
        fs.writeFileSync(indexPath, existing, 'utf-8')
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

  // Database operations (JSON-file based with write serialization)
  const dbPath = path.join(app.getPath('userData'), 'clerkbox-db.json')
  let dbWriteQueue: Promise<void> = Promise.resolve()

  /** Serialize DB writes to prevent concurrent read-modify-write data loss */
  function enqueueDbWrite(fn: () => void): Promise<void> {
    dbWriteQueue = dbWriteQueue.then(() => {
      fn()
    }).catch((err) => {
      console.error('DB write failed:', err)
    })
    return dbWriteQueue
  }

  function readDb(): { sessions: any[]; messages: Record<string, any[]> } {
    try {
      if (fs.existsSync(dbPath)) {
        return JSON.parse(fs.readFileSync(dbPath, 'utf-8'))
      }
    } catch {
      try {
        const backupPath = dbPath + '.backup.' + Date.now()
        if (fs.existsSync(dbPath)) {
          fs.copyFileSync(dbPath, backupPath)
          console.error('DB corrupt, backed up to:', backupPath)
        }
      } catch {}
    }
    return { sessions: [], messages: {} }
  }

  function writeDb(db: any) {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8')
  }

  ipcMain.handle('dbCreateSession', async (_event, row: any) => {
    await enqueueDbWrite(() => {
      const db = readDb()
      db.sessions.push(row)
      db.messages[row.id] = []
      writeDb(db)
    })
  })

  ipcMain.handle('dbUpdateSessionTitle', async (_event, id: string, title: string, updatedAt: number) => {
    await enqueueDbWrite(() => {
      const db = readDb()
      const session = db.sessions.find((s: any) => s.id === id)
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
      db.sessions = db.sessions.filter((s: any) => s.id !== id)
      delete db.messages[id]
      writeDb(db)
    })
  })

  ipcMain.handle('dbGetAllSessions', async () => {
    // Read-only — no write serialization needed, but must wait for pending writes
    await dbWriteQueue
    return readDb().sessions
  })

  ipcMain.handle('dbAddMessage', async (_event, row: any) => {
    await enqueueDbWrite(() => {
      const db = readDb()
      if (!db.messages[row.session_id]) {
        db.messages[row.session_id] = []
      }
      const msgs = db.messages[row.session_id]
      // M10: 去重 — 若 id 已存在则更新（UPSERT），避免重复写入导致历史膨胀
      const existingIdx = msgs.findIndex((m: any) => m.id === row.id)
      if (existingIdx !== -1) {
        msgs[existingIdx] = { ...msgs[existingIdx], ...row }
      } else {
        msgs.push(row)
      }
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
        for (const msgs of Object.values(db.messages) as any[][]) {
          const msg = msgs.find((m: any) => m.id === id)
          if (msg) {
            msg.content = content
            if (toolCalls !== undefined) msg.tool_calls = toolCalls
            if (toolResults !== undefined) msg.tool_results = toolResults
            if (thinkingContent !== undefined) msg.thinking_content = thinkingContent
            if (finishReason !== undefined) msg.finish_reason = finishReason
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
      const idx = msgs.findIndex((m: any) => m.id === beforeId)
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

  // S2: slug 严格校验 — 只允许 [a-zA-Z0-9_-]，防止 "../../.." 路径遍历导致任意目录删除
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
    // 兼容封装：单文件场景，等价于 writeSkillDir 的单文件特例
    const safeSlug = assertSafeSlug(slug)
    const skillDir = path.join(projectDir, '.clerkbox', 'skills', safeSlug)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
  })

  // 多文件写盘：把技能所有文件（含 SKILL.md 与子目录文件）写到 .clerkbox/skills/<slug>/ 下
  ipcMain.handle('writeSkillDir', async (_event, projectDir: string, slug: string, files: Array<{ path: string; content: string }>) => {
    const safeSlug = assertSafeSlug(slug)
    const skillDir = path.join(projectDir, '.clerkbox', 'skills', safeSlug)
    fs.mkdirSync(skillDir, { recursive: true })
    // 路径安全校验：确保所有文件写在 skillDir 之下
    const expectedBase = path.resolve(skillDir)
    for (const f of files) {
      // 防 path traversal：清理 path，禁止绝对路径和 ../
      const cleaned = f.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\.\.\//g, '')
      const target = path.resolve(skillDir, cleaned)
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

  // Skill marketplace: search via SkillHub API (https://skillhub.proclaw.cc)
  ipcMain.handle('skillsSearch', async (_event, query: string, page: number = 1, limit: number = 20) => {
    try {
      const apiUrl = new URL('https://skillhub.proclaw.cc/api/search')
      apiUrl.searchParams.set('q', query)
      apiUrl.searchParams.set('page', String(page))
      apiUrl.searchParams.set('pageSize', String(limit))

      const data = await new Promise<string>((resolve, reject) => {
        https.get(apiUrl.toString(), {
          headers: { 'Accept': 'application/json', 'User-Agent': 'ClerkBox/1.5' },
          timeout: 15000,
        }, (res) => {
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => resolve(body))
          res.on('error', (err) => reject(err))
        }).on('error', (err) => reject(err))
      })

      const json = JSON.parse(data)
      const skills = (json.skills || []) as any[]
      const total = json.total || 0
      const totalPages = json.totalPages || 1
      const currentPage = json.page || page
      const pageSize = json.pageSize || limit

      // Map SkillHub response → existing SkillsMPSkill format
      const mapped = skills.map((s: any) => ({
        id: s.id || s.slug || '',
        name: s.name || '',
        author: s.author?.name || s.author || 'unknown',
        description: s.description || '',
        githubUrl: s.repositoryUrl || '',
        skillUrl: s.repositoryUrl || '',
        stars: s.starCount || 0,
        updatedAt: '',
      }))

      return JSON.stringify({
        success: true,
        data: {
          skills: mapped,
          pagination: {
            page: currentPage,
            limit: pageSize,
            total,
            totalPages,
            hasNext: currentPage < totalPages,
            hasPrev: currentPage > 1,
          },
          filters: { search: query, sortBy: 'relevance' },
        },
      })
    } catch (e: any) {
      // Fallback: if SkillHub API is unreachable, return empty result gracefully
      return JSON.stringify({
        success: true,
        data: {
          skills: [],
          pagination: { page: 1, limit, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
          filters: { search: query, sortBy: 'relevance' },
        },
      })
    }
  })

  // Fetch SKILL.md from a skill's GitHub repository
  // Tries multiple common locations and branches automatically
  ipcMain.handle('fetchSkillMd', async (_event, githubUrl: string) => {
    // Parse owner/repo from GitHub URL
    const ghMatch = githubUrl.match(/github\.com\/([^/]+)\/([^/]+)/)
    if (!ghMatch) {
      return JSON.stringify({ error: 'Invalid GitHub URL' })
    }

    const [, owner, repo] = ghMatch
    const cleanRepo = repo.replace(/\.git$/, '').replace(/\/$/, '')

    // Use the robust multi-location fetcher
    return await fetchSkillMdFromRepo(`${owner}/${cleanRepo}`)
  })

  // 整目录拉取技能：用 GitHub Trees API 列出文件后逐个抓取，返回完整文件列表
  ipcMain.handle('fetchSkillFromRepo', async (_event, githubUrl: string) => {
    return await fetchSkillDirFromRepo(githubUrl)
  })

  // 扫描 .claude/skills/ 标准路径，发现全局和项目级技能
  ipcMain.handle('scanSkillDirs', async (_event, workingDir: string) => {
    return JSON.stringify(scanSkillDirs(workingDir))
  })

  // Platform info
  ipcMain.handle('getPlatform', () => {
    return process.platform
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

/** Fetch SKILL.md from a GitHub repository (owner/repo format).
 *  Tries common locations and branches used by the agent-skills ecosystem. */
async function fetchSkillMdFromRepo(ownerRepo: string): Promise<string> {
  const [owner, repo] = ownerRepo.split('/')
  const cleanRepo = (repo || '').replace(/\.git$/, '')

  // Common SKILL.md locations in the agent-skills ecosystem
  const paths = [
    'SKILL.md',
    'skills/SKILL.md',
    '.claude/skills/SKILL.md',
    '.agents/skills/SKILL.md',
    '.cursor/skills/SKILL.md',
    'docs/SKILL.md',
  ]

  // Branches to try
  const branches = ['main', 'master', 'HEAD']

  const tryFetch = (branch: string, filePath: string): Promise<string> =>
    new Promise((resolve) => {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${cleanRepo}/${branch}/${filePath}`
      https.get(rawUrl, { timeout: 15000, headers: { 'User-Agent': 'ClerkBox/1.5' } }, (res) => {
        if (res.statusCode !== 200) { resolve(''); return }
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve(data))
        res.on('error', () => resolve(''))
      }).on('error', () => resolve(''))
    })

  // Try all branch × path combinations
  for (const branch of branches) {
    for (const filePath of paths) {
      const content = await tryFetch(branch, filePath)
      if (!content) continue
      const { valid, warnings } = validateSkillMd(content)
      if (valid) {
        return JSON.stringify({ success: true, content, warnings })
      }
      // If we found a file but it's invalid, still keep it as a candidate with warnings
      if (content.trim().length > 10) {
        return JSON.stringify({ success: true, content, warnings })
      }
    }
  }

  return JSON.stringify({ error: 'SKILL.md not found in repository' })
}

/** 整目录拉取技能：解析 GitHub URL，用 Trees API 列出文件后逐个抓取，返回完整文件列表。
 *  失败时回退到 fetchSkillMdFromRepo 拉单个 SKILL.md，保证健壮性。 */
async function fetchSkillDirFromRepo(githubUrl: string): Promise<string> {
  // 解析 GitHub URL：支持 github.com/owner/repo、/tree/branch/path、/blob/branch/file
  const match = githubUrl.match(/github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.+))?)?/)
  if (!match) {
    return JSON.stringify({ error: 'Invalid GitHub URL' })
  }
  const [, owner, repoRaw, kind, branchRaw, subPathRaw] = match
  const repo = (repoRaw || '').replace(/\.git$/, '').replace(/\/$/, '')
  const branch = branchRaw || 'main'
  // subPath：技能在仓库中的根路径（默认根目录）
  let subPath = (subPathRaw || '').replace(/\/$/, '')
  // blob 单文件链接：取该文件所在目录作为 subPath，便于拉取同目录资源
  if (kind === 'blob' && subPath) {
    const idx = subPath.lastIndexOf('/')
    subPath = idx >= 0 ? subPath.slice(0, idx) : ''
  }

  // 跳过常见二进制扩展名（与 parseSkillFile 保持一致）
  const binaryExt = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
    '.zip', '.gz', '.tar', '.rar', '.7z',
    '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.avi', '.mov',
    '.pdf', '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
  ])

  // 用 GitHub Trees API 列出文件
  const treesApiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  let treeData = ''
  try {
    treeData = await new Promise<string>((resolve, reject) => {
      https.get(treesApiUrl, {
        headers: {
          'User-Agent': 'ClerkBox/1.5',
          'Accept': 'application/vnd.github+json',
        },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode !== 200) { resolve(''); return }
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve(body))
        res.on('error', (err) => reject(err))
      }).on('error', (err) => reject(err))
    })
  } catch {
    treeData = ''
  }

  // Trees API 失败：回退到旧逻辑拉单个 SKILL.md
  if (!treeData) {
    const fallback = await fetchSkillMdFromRepo(`${owner}/${repo}`)
    try {
      const parsed = JSON.parse(fallback)
      if (parsed.success && parsed.content) {
        return JSON.stringify({
          success: true,
          files: [{ path: 'SKILL.md', content: parsed.content }],
          warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        })
      }
    } catch { /* fall through to error */ }
    return JSON.stringify({ error: 'SKILL.md not found' })
  }

  // 解析 tree 响应
  let treeJson: { tree?: Array<{ path: string; type: string; size?: number }> }
  try {
    treeJson = JSON.parse(treeData)
  } catch {
    return JSON.stringify({ error: 'Failed to parse Trees API response' })
  }
  const tree = treeJson.tree || []

  // 筛选技能目录下的文件
  const prefix = subPath ? subPath + '/' : ''
  const candidates: Array<{ path: string }> = []
  for (const item of tree) {
    if (item.type !== 'blob') continue
    let p = item.path
    if (prefix) {
      if (p.startsWith(prefix)) {
        p = p.slice(prefix.length)
      } else {
        continue
      }
    }
    if (!p) continue
    // 跳过二进制扩展名
    const ext = path.extname(p).toLowerCase()
    if (binaryExt.has(ext)) continue
    // 跳过大于 500KB 的文件
    if (typeof item.size === 'number' && item.size > 500 * 1024) continue
    candidates.push({ path: p })
    if (candidates.length >= 50) break
  }

  // 必须找到 SKILL.md
  const hasSkillMd = candidates.some((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))
  if (!hasSkillMd) {
    return JSON.stringify({ error: 'SKILL.md not found' })
  }

  // 逐个从 raw.githubusercontent.com 拉取文件内容
  const warnings: string[] = []
  const files: Array<{ path: string; content: string }> = []
  for (const cand of candidates) {
    const fullPath = prefix ? `${prefix}${cand.path}` : cand.path
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fullPath}`
    try {
      const content = await new Promise<string>((resolve) => {
        https.get(rawUrl, {
          headers: { 'User-Agent': 'ClerkBox/1.5' },
          timeout: 15000,
        }, (res) => {
          if (res.statusCode !== 200) { resolve(''); return }
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => resolve(data))
          res.on('error', () => resolve(''))
        }).on('error', () => resolve(''))
      })
      if (!content) {
        warnings.push(`拉取失败: ${cand.path}`)
        continue
      }
      files.push({ path: cand.path, content })
    } catch {
      warnings.push(`拉取失败: ${cand.path}`)
    }
  }

  // 确认 SKILL.md 内容已成功获取
  const skillMdFile = files.find((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))
  if (!skillMdFile) {
    return JSON.stringify({ error: 'SKILL.md not found' })
  }

  warnings.push('该 skill 来自外部仓库，安装前请人工审阅 SKILL.md 内容后再激活')
  return JSON.stringify({ success: true, files, warnings })
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

  // 扫描单个 skills 根目录
  const scanOne = (skillsRoot: string, source: ScanSource) => {
    if (!fs.existsSync(skillsRoot)) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const slug = e.name
      const skillDir = path.join(skillsRoot, slug)
      const skillMdAbs = path.join(skillDir, 'SKILL.md')
      if (!fs.existsSync(skillMdAbs)) continue
      try {
        const skillMdContent = fs.readFileSync(skillMdAbs, 'utf-8')
        const parsed = parseSkillMd(skillMdContent)
        // 递归读取技能目录所有文件（保留目录结构，跳过二进制）
        const files: Array<{ path: string; content: string }> = []
        const walk = (dir: string, base: string = '') => {
          let ents: fs.Dirent[]
          try {
            ents = fs.readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const ent of ents) {
            const rel = base ? `${base}/${ent.name}` : ent.name
            if (ent.isDirectory()) {
              walk(path.join(dir, ent.name), rel)
            } else if (ent.isFile()) {
              const lower = path.extname(ent.name).toLowerCase()
              if (binaryExt.has(lower)) continue
              let content: string
              try {
                content = fs.readFileSync(path.join(dir, ent.name), 'utf-8')
              } catch {
                continue
              }
              // 含 null 字节视为二进制，跳过
              if (content.indexOf('\u0000') !== -1) continue
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

/** Search with Bing HTML (no API key needed, China-accessible) */
async function searchWithBingHtml(query: string, count: number): Promise<SearchResult[]> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${count}&setlang=zh-CN`
  const html = await fetchUrl(url, 200000)

  const $ = cheerio.load(html)
  const results: SearchResult[] = []

  // M13: 使用 cheerio 解析 Bing 结果，避免脆弱的正则匹配
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

      const fetcher = url.startsWith('https') ? https : http
      const req = fetcher.get(
        url,
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
        },
        (res) => {
          // Handle redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, url).toString()
            res.resume()
            doFetch(nextUrl, redirectsLeft - 1)
            return
          }

          if (res.statusCode && res.statusCode >= 400) {
            res.resume()
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }

          // P5: 用 chunks 数组 + 一次 concat，避免 Buffer.concat 循环 O(n²)
          const chunks: Buffer[] = []
          let receivedLength = 0
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
            receivedLength += chunk.length
            if (receivedLength > maxBytes) {
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
    } catch {}
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
    } catch {}
  }

  // Try og:description meta tag
  const ogDescMatch = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i)
  if (ogDescMatch && ogDescMatch[1].length > 50) {
    return ogDescMatch[1]
  }

  return null
}

/** Recursively extract text content from a JSON object */
function extractTextFromJson(obj: any, depth = 0): string {
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
    for (const key in obj) {
      if (['content', 'text', 'description', 'body', 'article', 'html', 'summary', 'title', 'excerpt'].includes(key)) {
        const text = extractTextFromJson(obj[key], depth + 1)
        if (text) parts.push(text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/** Use a hidden BrowserWindow to render SPA pages and extract rendered text.
 *  Handles sites like 36氪/知乎/钛媒体 that render content via JavaScript. */
async function fetchWithBrowser(targetUrl: string, maxLen: number): Promise<string> {
  // S1: scheme 白名单 — 仅允许 http/https，防止加载 file:// 读取本地文件或内网 SSRF
  try {
    const parsed = new URL(targetUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`blocked scheme: ${parsed.protocol}`)
    }
  } catch {
    throw new Error(`Invalid URL or blocked scheme: ${targetUrl}`)
  }

  const { BrowserWindow } = require('electron')
  let win: BrowserWindow | null = null
  try {
    const w = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // S1: 保留 webSecurity=true，不再为「加载混合内容」关闭整个同源策略。
        // 混合内容(https 页面加载 http 资源)用 allowRunningInsecureContent 控制，更细粒度。
        webSecurity: true,
        allowRunningInsecureContent: true,
        images: false,
        offscreen: true,
      },
    })
    win = w

    // 仅允许 http/https 请求，拦截 file/data/ftp 等 scheme
    w.webContents.session.webRequest.onBeforeRequest((details: any, cb: (response: any) => void) => {
      const rt = details.resourceType
      // 拦截无关资源类型
      if (rt === 'image' || rt === 'media' || rt === 'font') {
        cb({ cancel: true })
        return
      }
      // 拦截非 http/https URL
      try {
        const u = new URL(details.url)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          cb({ cancel: true })
          return
        }
      } catch {
        cb({ cancel: true })
        return
      }
      cb({})
    })

    // Load with desktop UA so sites return full content
    await w.webContents.loadURL(targetUrl, {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })

    // Wait for JS rendering: poll until document body has substantial text or timeout
    const startTime = Date.now()
    const TIMEOUT_MS = 15000
    while (Date.now() - startTime < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 800))
      try {
        const len = await w.webContents.executeJavaScript(
          `(document.body && document.body.innerText) ? document.body.innerText.length : 0`
        )
        if (len > 500) break
      } catch {
        break
      }
    }

    // Extract main article text preferentially, fall back to full body
    let rendered = await w.webContents.executeJavaScript(`
      (function() {
        // Try common article containers first
        var selectors = ['article', 'main', '[role="main"]', '.article-content', '.article', '.post-content', '.content', '#article', '#content', '.entry-content'];
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el && el.innerText && el.innerText.trim().length > 200) {
            return el.innerText;
          }
        }
        // Fallback: full body text
        return document.body ? document.body.innerText : '';
      })()
    `)

    // Clean up: remove excessive blank lines and trim
    rendered = (rendered || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    return rendered.substring(0, maxLen)
  } finally {
    if (win) {
      try {
        win.destroy()
      } catch {}
    }
  }
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

// S8: 全局异常兜底，避免未捕获异常/未处理 Promise 直接崩溃主进程
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
