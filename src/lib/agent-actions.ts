/**
 * Agent 动作契约（Browser Use / Computer Use）
 *
 * 对标 D:\ZCode 的 `packages/shared/src/browser-use/*`：
 * 工具层不直接操作 webContents / 屏幕，而是把每个动作归一成一个**判别联合**命令，
 * 由 Electron 主进程执行后回一份**同构的观测结果**。这样做的三个理由：
 *   1. 渲染进程与主进程 agent-host 共用同一份 toolRegistry，两边下发的命令形状必须一致；
 *   2. 命令形状稳定 → 契约文档、错误码、观测格式可以独立演进，不牵动工具描述；
 *   3. 「截图 / 页面状态 / 元素 ref」是观测一等公民，而不是塞进字符串里再正则捞回来
 *      （ZCode 的 CUA 卡片就是从文本里正则 `screenshot WxHpx`，那是妥协，不要继承）。
 *
 * 坐标与 ref 两条硬约定（ZCode 反复强调、也是最容易翻车的地方）：
 *   - 坐标一律是**当前这张截图像素**里的绝对整数坐标，不是 CSS 像素、不是窗口 bounds；
 *   - ref 由 `snapshot` 现场分配，**每次快照后失效**，导航后全部作废 —— 用旧 ref 必须报
 *     `ref_not_found` 而不是静默点空。
 *
 * 本文件是纯类型 + 常量：不 import electron / react / DOM，渲染进程与主进程都能编译。
 */

// ── Shared limits（与工具描述中的数值严格一致，改动时两处同步）──

export const AGENT_ACTION_LIMITS = {
  /** 单条命令超时（毫秒） */
  commandTimeoutMs: 30_000,
  /** 页面加载等待上限（毫秒） */
  pageLoadTimeoutMs: 15_000,
  /** 等待用户侧交互落定（导航后 DOM 稳定）上限（毫秒） */
  settleTimeoutMs: 5_000,

  /** 截图内联到模型的 base64 预算（字节） */
  screenshotInlineBase64Bytes: 200 * 1024,
  /** 截图进模型前的最长边（像素）；多数模型视觉上限 2000 */
  screenshotMaxDimension: 2000,
  /** 截图 PNG 质量下限（首轮压缩未达标时的重压质量） */
  screenshotMinQuality: 30,

  /** 页面状态文本（URL / 标题 / 滚动位置）单字段上限 */
  pageStateMaxChars: 500,
  /** 快照元素条数上限 */
  snapshotMaxElements: 400,
  /** 快照文本总体积上限（超出截断并置 truncated） */
  snapshotMaxChars: 30_000,
  /** evaluate 返回值的字符上限（超出截断，模型改用 snapshot） */
  evaluateMaxChars: 10_000,

  /** Agent 浏览器常驻标签数上限 */
  browserTabsMax: 8,

  /** computer_screenshot：默认最长边；超出的屏幕按此下采样后再交模型 */
  computerShotMaxDimension: 1560,
  /** computer_wait：默认 / 最大等待（毫秒） */
  computerWaitDefaultMs: 1_000,
  computerWaitMaxMs: 30_000,
  /** computer_type：单次注入文本长度上限 */
  computerTypeMaxChars: 4_000,
  /** 外部进程（截屏 / 输入合成）单次执行上限（毫秒） */
  desktopExecTimeoutMs: 15_000,
  /** computer_app / list_apps 返回条目上限 */
  appListMax: 60,
  /** 剪贴板文本读写上限（字节） */
  clipboardMaxChars: 200_000,
} as const

/** 工具名前缀。UI 分发、权限判定、开关过滤、子 agent 禁用全部按前缀走，不逐个硬编码工具名 */
export const BROWSER_TOOL_PREFIX = 'browser_'
export const COMPUTER_TOOL_PREFIX = 'computer_'

/**
 * 主进程内部流转的图像形态。
 *
 * **绝不能出现在工具结果里**：它只活在「主进程截屏 → 降采样 → 落盘」这一段，
 * 出去的是下面的 `AgentActionImageRef`。原因见 electron/agent-image.ts 的落盘注释。
 */
export interface AgentActionImage {
  /** `data:image/png;base64,...` 完整 data URL */
  dataUrl: string
  mimeType: string
  /** 该图对应的 raster 宽高（像素）——坐标解释的唯一依据 */
  width: number
  height: number
  /** true=全屏，false=区域 */
  fullScreen?: boolean
}

/**
 * 落盘后的图像引用（与 ToolResultImage 同构）。
 *
 * 由**主进程**在返回结果前写好：渲染层的 `ipc.writeFile` 是文本通道，
 * 拿它写 base64 会得到一个「长得像 data URL 的文本文件」，模型侧报 unknown format。
 */
export interface AgentActionImageRef {
  path: string
  mimeType: string
  width: number
  height: number
  fullScreen?: boolean
}

// ── Browser Use ──

/** 元素引用：来自最近一次 snapshot 的 ref，或直接给坐标 */
export type BrowserTarget =
  | { type: 'ref'; ref: string }
  | { type: 'coordinate'; x: number; y: number }

export type BrowserKeyModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift'
export type BrowserMouseButton = 'left' | 'middle' | 'right'

/**
 * 浏览器命令判别联合。
 *
 * v1 是**单视图**：Agent 浏览器就是一个专用 `<webview>`，不铺多标签。
 * ZCode 支持多标签是因为它有完整的 side pane 标签条与常驻 tab 壳；ClerkBox 的
 * 工作台标签条同时还要承载文件/终端/人类浏览器，为 Agent 单独铺一套 tab 壳
 * 收益不抵复杂度。需要并行看多个页面时用 `web_fetch` 或让用户自己开浏览器标签。
 */
export type BrowserCommand =
  | { method: 'navigate'; url: string }
  | { method: 'back' }
  | { method: 'forward' }
  | { method: 'reload' }
  | { method: 'snapshot'; maxElements?: number; includeHidden?: boolean }
  | { method: 'click'; target: BrowserTarget; button?: BrowserMouseButton; clickCount?: number; modifiers?: BrowserKeyModifier[] }
  | { method: 'type'; text: string; ref?: string; clear?: boolean }
  | { method: 'press'; key: string; ref?: string; modifiers?: BrowserKeyModifier[] }
  | { method: 'scroll'; ref?: string; x?: number; y?: number; deltaY?: number }
  | { method: 'screenshot'; fullPage?: boolean }
  | { method: 'evaluate'; expression: string }
  | { method: 'wait'; selector?: string; timeoutMs?: number }

export type BrowserErrorCode =
  | 'backend_unavailable'
  | 'capability_unsupported'
  | 'ref_not_found'
  | 'navigation_blocked'
  | 'timeout'
  | 'renderer_unreachable'
  | 'execution_error'

/** 页面状态：每次命令后都会回一份，模型据此知道自己在哪 */
export interface BrowserPageState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  scrollX?: number
  scrollY?: number
  viewportWidth?: number
  viewportHeight?: number
}

/** 快照里的一个可交互元素 */
export interface BrowserSnapshotElement {
  /** 本次快照内的引用；下次快照会重算 */
  ref: string
  tag: string
  role: string
  name: string
  value?: string
  disabled?: boolean
  /** 视口内中心点（CSS 像素），已 scrollIntoView 过 */
  x?: number
  y?: number
  inViewport?: boolean
}

export interface BrowserSnapshot {
  url: string
  title: string
  /** 面向模型的语义树文本（等价 Playwright ariaSnapshot 的形态） */
  tree: string
  elements: BrowserSnapshotElement[]
  truncated: boolean
}

export interface BrowserCommandMeta {
  browserUse: true
  tabId: string
  /** guest 重挂载时自增，UI 靠它识别 stale 事件 */
  generation: number
  currentUrl?: string
}

export interface BrowserCommandResult {
  ok: boolean
  state?: BrowserPageState
  snapshot?: BrowserSnapshot
  /** 截图：主进程已落盘的磁盘引用。**内联 data URL 不出主进程** —— 落盘在那边做，字节才精确 */
  imageRef?: AgentActionImageRef
  value?: unknown
  error?: { code: BrowserErrorCode; message: string }
  meta?: BrowserCommandMeta
  elapsedMs: number
}

/** 主进程 → 渲染层的「Agent 正在操作浏览器」事件（点亮标签呼吸图标） */
export interface BrowserOperationEvent {
  tabId: string
  generation: number
}

// ── Computer Use ──

export type ComputerMouseButton = 'left' | 'right' | 'middle'
export type ComputerPoint = { x: number; y: number }

export type ComputerAction =
  | { action: 'screenshot'; region?: [number, number, number, number] }
  | { action: 'left_click'; x: number; y: number; clickCount?: number }
  | { action: 'right_click'; x: number; y: number }
  | { action: 'double_click'; x: number; y: number }
  | { action: 'mouse_move'; x: number; y: number }
  | { action: 'left_click_drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { action: 'scroll'; x?: number; y?: number; deltaX?: number; deltaY?: number }
  | { action: 'type'; text: string }
  | { action: 'key'; key: string }
  | { action: 'hold_key'; key: string; durationMs?: number }
  | { action: 'wait'; durationMs?: number }
  | { action: 'read_clipboard' }
  | { action: 'write_clipboard'; text: string }
  | { action: 'list_apps' }
  | { action: 'open_application'; name: string }

export type ComputerErrorCode =
  | 'platform_unsupported'
  | 'permission_denied'
  | 'out_of_bounds'
  | 'timeout'
  | 'target_not_found'
  | 'execution_error'

export interface ComputerAppInfo {
  name: string
  pid?: number
  bundleId?: string
  active?: boolean
}

export interface ComputerActionResult {
  ok: boolean
  /** 截图：主进程已落盘的磁盘引用。**内联 data URL 不出主进程** —— 落盘在那边做，字节才精确 */
  imageRef?: AgentActionImageRef
  value?: unknown
  apps?: ComputerAppInfo[]
  /** 屏幕尺寸（物理像素）——坐标解释的唯一依据 */
  screen?: { width: number; height: number; scaleFactor: number }
  error?: { code: ComputerErrorCode; message: string }
  elapsedMs: number
}

// ── 纯函数工具 ──

/** 工具名 → 动作族；UI 与权限判定共用 */
export function agentActionFamily(toolName: string): 'browser' | 'computer' | null {
  if (toolName.startsWith(BROWSER_TOOL_PREFIX)) return 'browser'
  if (toolName.startsWith(COMPUTER_TOOL_PREFIX)) return 'computer'
  return null
}

export function isAgentActionTool(toolName: string): boolean {
  return agentActionFamily(toolName) !== null
}

/**
 * 只读动作：改变不了页面上任何状态，也碰不到用户桌面。
 * 权限审批、plan/spec 模式的放行面、microcompact 的清理面都读这一份。
 */
const BROWSER_READ_ONLY_METHODS: ReadonlySet<BrowserCommand['method']> = new Set([
  'snapshot',
  'screenshot',
  'evaluate',
  'back',
  'forward',
  'reload',
  'wait',
])

const COMPUTER_READ_ONLY_ACTIONS: ReadonlySet<ComputerAction['action']> = new Set([
  'screenshot',
  'list_apps',
  'read_clipboard',
  'wait',
])

export function isBrowserCommandReadOnly(command: BrowserCommand): boolean {
  return BROWSER_READ_ONLY_METHODS.has(command.method)
}

export function isComputerActionReadOnly(action: ComputerAction): boolean {
  return COMPUTER_READ_ONLY_ACTIONS.has(action.action)
}

const BROWSER_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'browser_snapshot',
  'browser_screenshot',
  'browser_evaluate',
  'browser_wait',
])

const COMPUTER_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'computer_screenshot',
  'computer_wait',
])

/**
 * 按**工具名 + 入参**判断一次调用是否只读。
 *
 * 审批门、plan/spec 模式的放行面、卡片上的「会改变状态」提示都读这一份，
 * 所以它必须只看工具名与入参、不依赖执行器 —— 执行器要把 args 翻译成命令/动作，
 * 而权限判定发生在翻译之前。
 *
 * 两个需要看入参才准判定的：
 *   - browser_navigate：action=back/forward/reload 只是翻历史，不产生新请求；
 *   - computer_app：list 只读，open 会启动进程。
 */
export function isAgentActionToolReadOnly(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName.startsWith(BROWSER_TOOL_PREFIX)) {
    if (toolName === 'browser_navigate') {
      // 导航**不算写操作**：它只换掉 Agent 浏览器自己的那一页，没有用户可见的持久副作用
      // （cookie 与登录态是隔离分区里的，删除由用户自己操作）。模型外发请求的能力
      // 本来就有 web_fetch，再为「在自己的浏览器里看一眼」拦一次纯属自伤。
      // 真正要拦的是交互 —— 点链接、填表单、提交，那才有不可逆的后果。
      return true
    }
    return BROWSER_READ_ONLY_TOOLS.has(toolName)
  }
  if (toolName.startsWith(COMPUTER_TOOL_PREFIX)) {
    if (toolName === 'computer_app') return (typeof args.action === 'string' ? args.action : 'list') !== 'open'
    if (toolName === 'computer_clipboard') return (typeof args.action === 'string' ? args.action : 'read') !== 'write'
    return COMPUTER_READ_ONLY_TOOLS.has(toolName)
  }
  return true
}

/**
 * 会话级放行的能力键。
 *
 * 必须是**能力级**而不是「工具 + 动作」级：一次浏览任务是
 * navigate → snapshot → click → type → click 的循环，按动作级记忆的话用户要点十几次
 * 「始终允许」，等于没有这个选项。按能力级则整个任务只打扰一次。
 * 收回方式是关掉设置里对应的开关 —— 那本来就是用户对该能力的总闸。
 */
export function agentActionGrantKey(family: 'browser' | 'computer'): string {
  return `agent-use:${family}`
}

/** 动作名 → i18n key 的词表（`toolRenderer.agentAction.*`），UI 只做查表不拼句子 */
export const BROWSER_ACTION_SUMMARY_IDS: Record<BrowserCommand['method'], string> = {
  navigate: 'toolRenderer.agentAction.browserNavigate',
  back: 'toolRenderer.agentAction.browserBack',
  forward: 'toolRenderer.agentAction.browserForward',
  reload: 'toolRenderer.agentAction.browserReload',
  snapshot: 'toolRenderer.agentAction.browserSnapshot',
  click: 'toolRenderer.agentAction.browserClick',
  type: 'toolRenderer.agentAction.browserType',
  press: 'toolRenderer.agentAction.browserPress',
  scroll: 'toolRenderer.agentAction.browserScroll',
  screenshot: 'toolRenderer.agentAction.browserScreenshot',
  evaluate: 'toolRenderer.agentAction.browserEvaluate',
  wait: 'toolRenderer.agentAction.browserWait',
}

export const COMPUTER_ACTION_SUMMARY_IDS: Record<ComputerAction['action'], string> = {
  screenshot: 'toolRenderer.agentAction.computerScreenshot',
  left_click: 'toolRenderer.agentAction.computerLeftClick',
  right_click: 'toolRenderer.agentAction.computerRightClick',
  double_click: 'toolRenderer.agentAction.computerDoubleClick',
  mouse_move: 'toolRenderer.agentAction.computerMouseMove',
  left_click_drag: 'toolRenderer.agentAction.computerDrag',
  scroll: 'toolRenderer.agentAction.computerScroll',
  type: 'toolRenderer.agentAction.computerType',
  key: 'toolRenderer.agentAction.computerKey',
  hold_key: 'toolRenderer.agentAction.computerHoldKey',
  wait: 'toolRenderer.agentAction.computerWait',
  read_clipboard: 'toolRenderer.agentAction.computerReadClipboard',
  write_clipboard: 'toolRenderer.agentAction.computerWriteClipboard',
  list_apps: 'toolRenderer.agentAction.computerListApps',
  open_application: 'toolRenderer.agentAction.computerOpenApp',
}

/**
 * 截图中转 data URL 的内联预算判定。
 * 超出预算时主进程应当先降采样/重压再回，而不是把 5MB base64 塞进工具结果字符串。
 */
export function exceedsInlineImageBudget(image: AgentActionImage): boolean {
  return image.dataUrl.length > AGENT_ACTION_LIMITS.screenshotInlineBase64Bytes
}

/** 坐标是否落在 raster 内；坐标越界是模型最常见的错误，单独给一个错误码便于它自纠 */
export function isPointInsideRaster(point: ComputerPoint, image: AgentActionImage): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < image.width && point.y < image.height
}

/** 数字入参钳制：模型偶尔会送字符串 / 负数 / 越界值，工具层统一收口 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// ── IPC 入参校验 ──

/**
 * 浏览器命令的运行时校验（白名单，不是黑名单）。
 *
 * 主进程 handler 会原样把 `command` 交给 CDP 执行器，所以校验必须发生在这里：
 * 只认 `method` 判别联合里列出的方法名与字段类型，其余一律拒。
 * TypeScript 的判别联合在编译期已经保证了形状，但 IPC 边界上进来的东西可能来自
 * WebUI 的 /api/invoke（见 REMOTE_INVOKE_BLOCKLIST）与旧版本客户端，运行期仍要收口。
 */
const BROWSER_COMMAND_METHODS: ReadonlySet<string> = new Set([
  'navigate', 'back', 'forward', 'reload', 'snapshot', 'click', 'type',
  'press', 'scroll', 'screenshot', 'evaluate', 'wait',
])

export function isBrowserCommand(value: unknown): value is BrowserCommand {
  if (!value || typeof value !== 'object') return false
  const method = (value as { method?: unknown }).method
  if (typeof method !== 'string' || !BROWSER_COMMAND_METHODS.has(method)) return false
  switch (method) {
    case 'navigate':
      return typeof (value as { url?: unknown }).url === 'string'
    case 'evaluate':
      return typeof (value as { expression?: unknown }).expression === 'string'
    case 'type':
    case 'press':
    case 'scroll':
    case 'wait':
    case 'snapshot':
    case 'screenshot':
      return true
    case 'click': {
      const target = (value as { target?: unknown }).target
      if (!target || typeof target !== 'object') return false
      const kind = (target as { type?: unknown }).type
      if (kind === 'ref') return typeof (target as { ref?: unknown }).ref === 'string'
      if (kind === 'coordinate') {
        return typeof (target as { x?: unknown }).x === 'number' && typeof (target as { y?: unknown }).y === 'number'
      }
      return false
    }
    default:
      return false
  }
}

const COMPUTER_ACTIONS: ReadonlySet<string> = new Set([
  'screenshot', 'left_click', 'right_click', 'double_click', 'mouse_move', 'left_click_drag',
  'scroll', 'type', 'key', 'hold_key', 'wait', 'read_clipboard', 'write_clipboard',
  'list_apps', 'open_application',
])

export function isComputerAction(value: unknown): value is ComputerAction {
  if (!value || typeof value !== 'object') return false
  const action = (value as { action?: unknown }).action
  if (typeof action !== 'string' || !COMPUTER_ACTIONS.has(action)) return false
  const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  switch (action) {
    case 'screenshot':
      return true
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'mouse_move':
      return isNum((value as { x?: unknown }).x) && isNum((value as { y?: unknown }).y)
    case 'left_click_drag':
      return ['fromX', 'fromY', 'toX', 'toY'].every((k) => isNum((value as Record<string, unknown>)[k]))
    case 'scroll':
      return true
    case 'type':
    case 'write_clipboard':
      return typeof (value as { text?: unknown }).text === 'string'
    case 'key':
    case 'hold_key':
      return typeof (value as { key?: unknown }).key === 'string'
    case 'open_application':
      return typeof (value as { name?: unknown }).name === 'string'
    case 'wait':
    case 'read_clipboard':
    case 'list_apps':
      return true
    default:
      return false
  }
}
