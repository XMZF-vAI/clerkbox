import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import * as https from 'https'

/**
 * 自动更新模块。
 *
 * 设计要点（与渲染端 updater-store / TitleBar 版本号标签配套）：
 * - 检测统一走 electron-updater 的 checkForUpdates（版本源是 GitHub Release 的 latest*.yml）；
 *   检测到新版本后额外匿名拉 GitHub Release body 作为更新说明。
 * - 平台分流：Windows NSIS / Linux AppImage 支持下载 + 重启安装；
 *   macOS 无签名无法走 electron-updater（新旧包签名须一致），仅检测并跳转 Release 页手动下载。
 * - 「agent 执行时不更」的落地：检测与后台下载随时进行（不打扰、不中断），
 *   真正的安装只由渲染端在 agent 空闲（或用户确认中断）后点击触发 update:install。
 * - agent 忙碌判断双保险：渲染进程心跳（90s 超时兜底，渲染挂了 agent 必死，自洽）
 *   + main.ts 注入的工具子进程探测。
 */

const REPO_OWNER = 'XMZF-vAI'
const REPO_NAME = 'clerkbox'

/** 启动后延迟首查，避开启动高峰 */
const FIRST_CHECK_DELAY_MS = 30_000
/** 定期轮询间隔：4 小时 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** 渲染进程心跳超时：超过该时长未上报视为空闲（agent loop 在渲染进程跑，渲染挂了 agent 必死） */
const AGENT_HEARTBEAT_TIMEOUT_MS = 90_000
const GITHUB_REQUEST_TIMEOUT_MS = 15_000

export interface UpdaterDeps {
  getMainWindow: () => BrowserWindow | null
  /** main.ts 注入：是否仍有工具执行子进程在跑（sessionChildProcesses 非空） */
  hasToolChildProcesses: () => boolean
}

let deps: UpdaterDeps | null = null
/** 检测锁：防止手动触发与定时器并发重复请求 */
let checking = false
/** 是否已完成过至少一次检测（用于区分「未查过」与「查过无更新」） */
let lastCheckedAt: number | null = null
/** 渲染进程心跳：active 布尔 + 最近一次上报时间 */
let agentHeartbeat: { active: boolean; at: number } = { active: false, at: 0 }

export interface UpdaterState {
  /** 当前环境是否启用更新功能（dev 模式 / 不支持的平台为 false） */
  supported: boolean
  /** true = 可自动下载并重启安装；false = 仅提示新版本，点击跳转 Release 页 */
  canAutoInstall: boolean
  phase: 'idle' | 'checking' | 'downloading' | 'ready'
  currentVersion: string
  newVersion: string | null
  /** GitHub Release 正文（已剥离 Markdown 语法），悬浮提示用 */
  releaseNotes: string | null
  releaseUrl: string | null
  /** 下载进度 0-100 */
  progress: number | null
  lastCheckedAt: number | null
  /** agent 是否忙碌（渲染端 ready 点击时用于决定是否弹中断确认） */
  agentBusy: boolean
}

function initialState(): UpdaterState {
  return {
    supported: isDetectionSupported(),
    canAutoInstall: supportsAutoInstall(),
    phase: 'idle',
    currentVersion: app.getVersion(),
    newVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    progress: null,
    lastCheckedAt,
    agentBusy: isAgentBusy(),
  }
}

let state: UpdaterState = initialState()

/** Windows NSIS 与 Linux AppImage 走 electron-updater 全流程 */
function supportsAutoInstall(): boolean {
  if (process.platform === 'win32') return true
  if (process.platform === 'linux' && !!process.env.APPIMAGE) return true
  return false
}

/** macOS 可检测（拉 latest-mac.yml 比对版本）但只能跳转手动下载；其余环境禁用 */
function isDetectionSupported(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'darwin') return true
  return supportsAutoInstall()
}

function isAgentBusy(): boolean {
  if (agentHeartbeat.active && Date.now() - agentHeartbeat.at < AGENT_HEARTBEAT_TIMEOUT_MS) return true
  return deps?.hasToolChildProcesses() ?? false
}

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch, agentBusy: isAgentBusy() }
  pushState()
}

function pushState(): void {
  const win = deps?.getMainWindow()
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('update:state', state)
    } catch { /* 窗口销毁竞态，忽略 */ }
  }
}

/** 简单三段版本比较：a > b 返回正数 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va - vb
  }
  return 0
}

/** GitHub Release 正文剥离 Markdown 语法为纯文本（悬浮提示用） */
function markdownToPlainText(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/```\w*\n?/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '· ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 匿名拉取指定 tag 的 GitHub Release 元数据（body / html_url） */
function fetchReleaseMeta(tag: string): Promise<{ notes: string | null; url: string | null }> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${encodeURIComponent(tag)}`,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ClerkBox-Updater',
        },
        timeout: GITHUB_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0
        if (statusCode !== 200) {
          response.resume()
          resolve({ notes: null, url: null })
          return
        }
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { body?: unknown; html_url?: unknown }
            resolve({
              notes: typeof json.body === 'string' && json.body.trim() ? markdownToPlainText(json.body) : null,
              url: typeof json.html_url === 'string' ? json.html_url : null,
            })
          } catch {
            resolve({ notes: null, url: null })
          }
        })
        response.on('error', () => resolve({ notes: null, url: null }))
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve({ notes: null, url: null }))
  })
}

/** 检测新版本。支持自动安装的平台检测到更新后自动后台下载；macOS 检测到即 ready（跳转模式）。 */
async function checkForUpdates(): Promise<UpdaterState> {
  if (!isDetectionSupported() || checking) return state
  checking = true
  setState({ phase: 'checking' })
  try {
    const result = await autoUpdater.checkForUpdates()
    const newVersion = result?.updateInfo?.version ?? null
    lastCheckedAt = Date.now()
    if (!newVersion || compareVersions(newVersion, app.getVersion()) <= 0) {
      setState({ phase: 'idle', newVersion: null, releaseNotes: null, releaseUrl: null, progress: null, lastCheckedAt })
      return state
    }

    // 拉取 Release 正文作为更新说明（失败不影响更新流程，仅 tooltip 缺内容）
    const releaseTag = `v${newVersion}`
    const meta = await fetchReleaseMeta(releaseTag)

    if (!supportsAutoInstall()) {
      // macOS：不能自动安装，直接进入就绪态（点击跳转 Release 页）
      setState({
        phase: 'ready',
        newVersion,
        releaseNotes: meta.notes,
        releaseUrl: meta.url ?? `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${releaseTag}`,
        progress: null,
        lastCheckedAt,
      })
      return state
    }

    setState({ newVersion, releaseNotes: meta.notes, releaseUrl: meta.url, progress: 0, lastCheckedAt })
    // Windows/Linux：后台静默下载（不打扰 agent 执行；安装时机由用户点击决定）
    await autoUpdater.downloadUpdate()
  } catch (err) {
    // 检测/下载失败静默退回 idle，下轮轮询自动重试
    console.error('[Updater] check failed:', err)
    lastCheckedAt = Date.now()
    setState({ phase: 'idle', progress: null, lastCheckedAt })
  } finally {
    checking = false
  }
  return state
}

/** 用户点击「重启更新」：agent 忙碌与否由渲染端确认后调用，此处直接执行。 */
function installUpdate(): void {
  if (!supportsAutoInstall() || state.phase !== 'ready') return
  // isSilent: 静默安装；isForceRunAfter: 装完自动重启应用
  autoUpdater.quitAndInstall(true, true)
}

export function initUpdater(updaterDeps: UpdaterDeps): void {
  deps = updaterDeps

  if (!isDetectionSupported()) {
    // dev 模式 / 不支持平台：IPC 仍注册（渲染端拿 supported=false 后隐藏更新交互）
    registerIpc()
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = console

  autoUpdater.on('download-progress', (progress) => {
    setState({ phase: 'downloading', progress: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', () => {
    setState({ phase: 'ready', progress: null })
  })
  autoUpdater.on('error', (err) => {
    console.error('[Updater] error:', err)
    // 下载阶段出错：静默退回 idle，等下一轮轮询重试
    if (state.phase === 'downloading') setState({ phase: 'idle', progress: null })
  })

  registerIpc()

  // 启动 30s 后首查（避开启动高峰），此后每 4 小时轮询
  setTimeout(() => { void checkForUpdates() }, FIRST_CHECK_DELAY_MS).unref?.()
  setInterval(() => { void checkForUpdates() }, CHECK_INTERVAL_MS).unref?.()
}

function registerIpc(): void {
  // 手动检查（渲染端标签点击触发；checking 锁住时直接返回当前状态）
  ipcMain.handle('update:check', () => checkForUpdates())

  // 用户确认后触发安装/跳转
  ipcMain.handle('update:install', () => {
    if (supportsAutoInstall()) {
      installUpdate()
      return { started: true }
    }
    return { started: false }
  })

  // 渲染进程 agent 活跃心跳上报（streaming 状态变化时 + 定时）
  ipcMain.on('update:agent-activity', (_event, active: unknown) => {
    agentHeartbeat = { active: active === true, at: Date.now() }
    if (state.phase === 'ready') pushState() // ready 态下忙碌变化影响点击确认逻辑，推送刷新
  })
}
