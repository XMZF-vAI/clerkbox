/**
 * 系统托盘常驻与托盘管理（主进程）。
 *
 * 设计要点：
 * - **只依赖注入**（风格对齐 `electron/updater.ts` 的 `UpdaterDeps`）：本模块不直接知道
 *   窗口、DB、i18n 的实现细节，便于单独推敲与复用。
 * - **菜单三段式**（用户定稿）：显示窗口 / 对话记录（最近 N 条，点击进入该对话）/ 退出。
 * - **每次刷新都重建菜单并 `setContextMenu`**：Linux 的 StatusNotifierItem 不重设则不生效
 *   （Electron 官方文档明文），因此不做"就地改 label"。
 * - **文案由渲染层下发**：主进程没有 i18n 机制，菜单/通知/确认框文案统一走 `tray:labels`；
 *   渲染层就绪前使用内置中文兜底，避免出现空菜单。
 * - 托盘不可用时 `initTray` 返回 false，由 main.ts 强制降级为"关闭即退出"。
 */
import { app, Menu, Notification, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export type TrayCloseBehavior = 'tray' | 'quit'

/** 菜单里的一条最近会话（已由调用方按更新时间降序排好） */
export interface TraySessionItem {
  id: string
  title: string
  updatedAt: number
}

export interface TrayLabels {
  tooltip: string
  tooltipBusy: string
  showWindow: string
  recentSessions: string
  noRecentSessions: string
  quit: string
  quitConfirmTitle: string
  quitConfirmMessage: string
  firstHideNoticeTitle: string
  firstHideNoticeBody: string
  untitledSession: string
}

export interface TrayConfig {
  closeBehavior: TrayCloseBehavior
  /** 菜单里最多展示几条最近会话（3~8，默认 5） */
  recentSessionsLimit?: number
}

export interface TrayDeps {
  /** 显示窗口：不存在则重建、最小化则还原、然后聚焦（幂等） */
  showWindow: () => void
  /** 渲染层桥接（TrayBridge）是否已挂载 */
  isRendererReady: () => boolean
  /** 主进程 → 渲染层：切到指定会话 */
  sendOpenSession: (sessionId: string) => void
  /** 最近会话列表（调用方负责排序与 DB 读取缓存） */
  getRecentSessions: () => Promise<TraySessionItem[]>
  /** agent 是否忙碌（复用 updater 的"心跳 + 工具子进程"双保险判定） */
  isAgentBusy: () => boolean
  /** 真退出：置 isQuitting 后 app.quit() */
  requestQuit: () => void
  /** 退出前确认（仅 agent 忙碌时询问） */
  confirmQuit: (title: string, message: string) => Promise<boolean>
}

/** 渲染层文案到达前的兜底（避免出现空菜单；语言切换后会被真实文案覆盖） */
const DEFAULT_LABELS: TrayLabels = {
  tooltip: 'ClerkBox',
  tooltipBusy: 'ClerkBox · AI 执行中',
  showWindow: '显示窗口',
  recentSessions: '对话记录',
  noRecentSessions: '暂无对话记录',
  quit: '退出 ClerkBox',
  quitConfirmTitle: '仍有任务在执行',
  quitConfirmMessage: 'AI 正在执行任务，退出会立即中断。确定退出吗？',
  firstHideNoticeTitle: 'ClerkBox 仍在运行',
  firstHideNoticeBody: '已最小化到系统托盘，点击托盘图标可重新打开。',
  untitledSession: '未命名对话',
}

const MIN_SESSIONS_LIMIT = 3
const MAX_SESSIONS_LIMIT = 8
/** 菜单 label 截断长度（会话标题由 AI 生成，可能很长，过宽会撑爆菜单） */
const TITLE_MAX_CHARS = 28
/** 菜单重建去抖：状态抖动时避免连打 setContextMenu */
const REFRESH_DEBOUNCE_MS = 200
/** 会话数据轮询：DB 变化（含 WebUI 端新建会话）无需事件也能跟随 */
const POLL_INTERVAL_MS = 5_000

let tray: Tray | null = null
let deps: TrayDeps | null = null
let labels: TrayLabels = { ...DEFAULT_LABELS }
let config: Required<TrayConfig> = { closeBehavior: 'tray', recentSessionsLimit: 5 }
let firstHideNoticeShown = false
/** 渲染层未就绪时暂存的会话 id，就绪后立即消费（否则"首点无效"） */
let pendingSessionId: string | null = null
let refreshTimer: NodeJS.Timeout | null = null
let pollTimer: NodeJS.Timeout | null = null

function configPath(): string {
  return path.join(app.getPath('userData'), 'tray-config.json')
}

/**
 * 托盘图标：Windows / Linux 用透明底品牌字形；macOS 用模板图（纯黑 + alpha，
 * 系统按 alpha 自动适配深浅色菜单栏，文件名须含 Template 且 @2x 同名）。
 */
function trayIconPath(): string {
  const file = process.platform === 'darwin'
    ? 'trayTemplate.png'
    : process.platform === 'win32'
      ? 'tray-win.png'
      : 'tray-linux.png'
  return path.resolve(app.getAppPath(), 'build', file)
}

function clampSessionsLimit(value: number): number {
  if (!Number.isFinite(value)) return 5
  return Math.min(MAX_SESSIONS_LIMIT, Math.max(MIN_SESSIONS_LIMIT, Math.round(value)))
}

function loadConfigFromDisk(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Partial<TrayConfig> & { firstHideNoticeShown?: boolean }
    if (raw.closeBehavior === 'tray' || raw.closeBehavior === 'quit') config.closeBehavior = raw.closeBehavior
    if (typeof raw.recentSessionsLimit === 'number') config.recentSessionsLimit = clampSessionsLimit(raw.recentSessionsLimit)
    if (raw.firstHideNoticeShown === true) firstHideNoticeShown = true
  } catch {
    // 首次运行（无文件）或文件损坏：沿用默认值
  }
}

function saveConfigToDisk(): void {
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ ...config, firstHideNoticeShown }), 'utf-8')
  } catch (error) {
    console.error('[tray] write config failed:', error instanceof Error ? error.message : String(error))
  }
}

function truncateTitle(title: string): string {
  const text = title.trim() || labels.untitledSession
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS)}…` : text
}

function createTray(): boolean {
  try {
    const icon = nativeImage.createFromPath(trayIconPath())
    if (icon.isEmpty()) {
      console.error('[tray] icon not readable:', trayIconPath())
      return false
    }
    tray = new Tray(icon)
    tray.setToolTip(labels.tooltip)
    // Windows 习惯：左键单击直接唤起窗口（语义与菜单首项一致，不做 toggle，避免双击抖动）；
    // macOS 设了 contextMenu 后左键即弹菜单（原生行为）；Linux 的 click 语义由桌面环境决定，不挂关键行为。
    if (process.platform === 'win32') {
      tray.on('click', () => deps?.showWindow())
    }
    return true
  } catch (error) {
    console.error('[tray] create failed:', error instanceof Error ? error.message : String(error))
    tray = null
    return false
  }
}

function buildMenu(sessions: TraySessionItem[], busy: boolean): Menu {
  const template: MenuItemConstructorOptions[] = [
    { label: labels.showWindow, click: () => deps?.showWindow() },
    { type: 'separator' },
    { label: labels.recentSessions, enabled: false },
  ]

  if (sessions.length === 0) {
    template.push({ label: labels.noRecentSessions, enabled: false })
  } else {
    for (const session of sessions) {
      template.push({
        label: truncateTitle(session.title),
        click: () => openSession(session.id),
      })
    }
  }

  template.push({ type: 'separator' })
  template.push({ label: labels.quit, click: () => { void handleQuit(busy) } })

  return Menu.buildFromTemplate(template)
}

/** 点会话：先让窗口到前台，再让渲染层切会话；渲染层未就绪则暂存待其就绪 */
function openSession(sessionId: string): void {
  deps?.showWindow()
  if (deps?.isRendererReady()) deps.sendOpenSession(sessionId)
  else pendingSessionId = sessionId
}

async function handleQuit(busy: boolean): Promise<void> {
  if (!deps) return
  if (busy) {
    const confirmed = await deps.confirmQuit(labels.quitConfirmTitle, labels.quitConfirmMessage)
    if (!confirmed) return
  }
  deps.requestQuit()
}

/** 每次刷新都重取数据（会话列表 / 忙碌态），避免菜单停留在上一次的快照 */
async function refreshMenu(): Promise<void> {
  if (!tray || tray.isDestroyed() || !deps) return

  let sessions: TraySessionItem[] = []
  try {
    sessions = await deps.getRecentSessions()
  } catch (error) {
    console.error('[tray] load sessions failed:', error instanceof Error ? error.message : String(error))
  }

  const busy = deps.isAgentBusy()
  try {
    tray.setToolTip(busy ? labels.tooltipBusy : labels.tooltip)
  } catch { /* 平台不支持 tooltip 时忽略 */ }

  try {
    tray.setContextMenu(buildMenu(sessions.slice(0, config.recentSessionsLimit), busy))
  } catch (error) {
    console.error('[tray] set menu failed:', error instanceof Error ? error.message : String(error))
  }
}

function scheduleRefresh(): void {
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refreshMenu()
  }, REFRESH_DEBOUNCE_MS)
  refreshTimer.unref?.()
}

/** 创建托盘；返回 false 表示当前环境不可用（调用方须降级为"关闭即退出"） */
export function initTray(trayDeps: TrayDeps): boolean {
  deps = trayDeps
  loadConfigFromDisk()
  if (!createTray()) {
    deps = null
    return false
  }
  scheduleRefresh()
  pollTimer = setInterval(() => scheduleRefresh(), POLL_INTERVAL_MS)
  pollTimer.unref?.()
  return true
}

export function isTrayAvailable(): boolean {
  return !!tray && !tray.isDestroyed()
}

export function getCloseBehavior(): TrayCloseBehavior {
  return config.closeBehavior
}

/** 渲染层下发关闭行为等配置（同时落盘，供下次启动在渲染层 hydrate 前就生效） */
export function setTrayConfig(next: TrayConfig): void {
  let changed = false
  if ((next.closeBehavior === 'tray' || next.closeBehavior === 'quit') && next.closeBehavior !== config.closeBehavior) {
    config.closeBehavior = next.closeBehavior
    changed = true
  }
  if (typeof next.recentSessionsLimit === 'number') {
    const limit = clampSessionsLimit(next.recentSessionsLimit)
    if (limit !== config.recentSessionsLimit) {
      config.recentSessionsLimit = limit
      changed = true
    }
  }
  if (!changed) return
  saveConfigToDisk()
  scheduleRefresh()
}

/** 渲染层下发文案（语言切换后会重新下发） */
export function setTrayLabels(next: Partial<TrayLabels>): void {
  const merged: TrayLabels = { ...labels }
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'string' && value && key in merged) merged[key as keyof TrayLabels] = value
  }
  labels = merged
  if (tray && !tray.isDestroyed()) {
    try {
      tray.setToolTip(deps?.isAgentBusy() ? labels.tooltipBusy : labels.tooltip)
    } catch { /* 平台不支持 tooltip 时忽略 */ }
  }
  scheduleRefresh()
}

/** 渲染层桥接挂载完成：消费暂存的会话点击 + 刷新菜单（此时文案才是准确的） */
export function notifyRendererReady(): void {
  if (pendingSessionId && deps) {
    const sessionId = pendingSessionId
    pendingSessionId = null
    deps.sendOpenSession(sessionId)
  }
  scheduleRefresh()
}

/** 首次"关闭到托盘"提示一次（标记随配置落盘，之后不再打扰） */
export function notifyFirstHide(): void {
  if (firstHideNoticeShown) return
  firstHideNoticeShown = true
  saveConfigToDisk()
  try {
    new Notification({ title: labels.firstHideNoticeTitle, body: labels.firstHideNoticeBody }).show()
  } catch (error) {
    console.error('[tray] first-hide notice failed:', error instanceof Error ? error.message : String(error))
  }
}

/** 外部状态变化（窗口显隐、WebUI 启停、更新状态等）触发菜单刷新 */
export function refreshTray(): void {
  scheduleRefresh()
}

export function destroyTray(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
  deps = null
  pendingSessionId = null
}

