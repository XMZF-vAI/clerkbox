/**
 * 结构化日志与崩溃诊断（对标 ZCode 的 rpc logging-middleware / 诊断体系）。
 *
 * 设计决策：
 * - 现有代码全部走 console.*：这里把 console 重定向到 electron-log，
 *   零侵入地让主进程所有模块（main/api-proxy/mcp-manager/updater/...）的
 *   日志同时写入控制台与磁盘文件，逐步迁移到 log.scope() 结构化用法。
 * - 渲染进程不直接依赖 electron-log（sandbox preload 无法 require 第三方模块），
 *   改走自有 IPC（log:write，fire-and-forget）转发到主进程落盘。
 * - diagExport 把「系统信息 + 近期日志尾部」合并成单个文件导出，
 *   用户提 Issue 时可直接附带；导出不依赖任何压缩库。
 */
import { app, dialog, ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as log from 'electron-log/main'

const LOG_FILE_NAME = 'main.log'
/** 单日志文件上限 10MB，超限由 electron-log 轮转为 main.old.log */
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024
/** 渲染进程转发日志的单条消息上限，防止异常大对象刷屏 */
const MAX_RENDERER_MESSAGE_BYTES = 8 * 1024
/** 导出诊断包时每个日志文件只带尾部 512KB，控制导出体积 */
const EXPORT_TAIL_BYTES = 512 * 1024

const RENDERER_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'] as const)
type RendererLogLevel = 'debug' | 'info' | 'warn' | 'error'

let initialized = false

/**
 * 初始化主进程日志。必须在 main.ts 模块顶层尽早调用：
 * 之后的 console.* 都会同步落盘，启动期异常也能被捕获。
 */
export function initMainLogger(): void {
  if (initialized) return
  initialized = true

  log.transports.file.resolvePathFn = () => path.join(app.getPath('logs'), LOG_FILE_NAME)
  log.transports.file.maxSize = MAX_LOG_FILE_BYTES
  log.transports.file.level = 'info'
  // 开发态控制台保留 debug 级别便于调试；打包后控制台基本无人看，保持 info
  log.transports.console.level = app.isPackaged ? 'info' : 'debug'
  // 两条标准流可能先于进程被关闭（由终端拉起时终端退出、或启动脚本硬杀进程组）。
  // 之后每一次 console 写入都会抛 EPIPE，而下一行把 console 换成了 electron-log 的实现，
  // 它的 console transport 抛出后会被 uncaughtException 接住、再 console.error 一次 →
  // 自递归刷屏 + 给用户拍「主进程错误」模态框。挂个 no-op 处理器：丢字节即可，
  // 文件 transport 走的是另一条路，日志不会因此缺失。
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on('error', () => { /* 管道已断，忽略写入失败 */ })
  }
  // 关键一步：接管 console，现有全部 console.log/warn/error 自动获得落盘能力
  Object.assign(console, log.functions)

  log.info(
    `[logger] ClerkBox v${app.getVersion()} starting ` +
      `(electron=${process.versions.electron} chrome=${process.versions.chrome} ` +
      `node=${process.versions.node} ${process.platform}/${os.arch()})`,
  )

  // 渲染进程 / 子进程崩溃落盘：以往这类现场只能靠用户口述
  app.on('render-process-gone', (_event, webContents, details) => {
    log.error(
      `[crash] renderer gone: reason=${details.reason} exitCode=${details.exitCode} url=${webContents.getURL()}`,
    )
  })
  app.on('child-process-gone', (_event, details) => {
    log.error(
      `[crash] child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name ?? ''}`,
    )
  })
}

/** 读取文件尾部（最多 maxBytes），用于诊断导出时控制体积 */
function readFileTail(filePath: string, maxBytes: number): string {
  const stat = fs.statSync(filePath)
  const start = Math.max(0, stat.size - maxBytes)
  const fd = fs.openSync(filePath, 'r')
  try {
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, start)
    // 从中间截断时丢弃第一个不完整的行
    const text = buffer.toString('utf-8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    fs.closeSync(fd)
  }
}

function buildDiagnosticsBundle(): string {
  const lines: string[] = [
    '=== ClerkBox Diagnostics ===',
    `appVersion: ${app.getVersion()}`,
    `electron: ${process.versions.electron}`,
    `chrome: ${process.versions.chrome}`,
    `node: ${process.versions.node}`,
    `platform: ${process.platform} ${os.release()} ${os.arch()}`,
    `locale: ${app.getLocale()}`,
    `packaged: ${app.isPackaged}`,
    `exportedAt: ${new Date().toISOString()}`,
    '提示：分享前请自行检查内容是否包含敏感信息。',
    '',
  ]

  const logDir = app.getPath('logs')
  const candidates = ['main.old.log', LOG_FILE_NAME]
  for (const name of candidates) {
    const filePath = path.join(logDir, name)
    if (!fs.existsSync(filePath)) continue
    lines.push(`=== ${name} (last ${EXPORT_TAIL_BYTES / 1024}KB) ===`)
    try {
      lines.push(readFileTail(filePath, EXPORT_TAIL_BYTES))
    } catch (error) {
      lines.push(`<failed to read: ${error instanceof Error ? error.message : String(error)}>`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 注册日志相关 IPC。log:write 走 ipcMain.on，天然不进 WebUI handlerRegistry。 */
export function registerLogIpcHandlers(): void {
  ipcMain.on('log:write', (_event, level: unknown, scope: unknown, message: unknown) => {
    if (typeof level !== 'string' || !RENDERER_LOG_LEVELS.has(level as RendererLogLevel)) return
    const safeScope =
      typeof scope === 'string' && scope.trim() ? scope.trim().slice(0, 64) : 'unknown'
    const rawMessage = typeof message === 'string' ? message : String(message)
    const safeMessage = rawMessage.slice(0, MAX_RENDERER_MESSAGE_BYTES)
    log.scope(`renderer:${safeScope}`)[level as RendererLogLevel](safeMessage)
  })

  ipcMain.handle('diagExport', async (event) => {
    try {
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, 19)
      const options: Electron.SaveDialogOptions = {
        title: 'Export diagnostic logs',
        defaultPath: `clerkbox-diagnostics-${stamp}.log`,
        filters: [
          { name: 'Log Files', extensions: ['log', 'txt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const result =
        win && !win.isDestroyed()
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { canceled: true as const }

      fs.writeFileSync(result.filePath, buildDiagnosticsBundle(), 'utf-8')
      log.info(`[logger] diagnostics exported to ${result.filePath}`)
      return { ok: true as const, path: result.filePath }
    } catch (error) {
      log.error('[logger] diagnostics export failed:', error)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
}
