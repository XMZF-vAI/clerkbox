/**
 * 「AI 正在操控你的电脑」置顶浮层
 *
 * 为什么必须放在**主进程做成独立窗口**，而不是渲染层里的一个浮层：
 * 电脑操作期间，用户的注意力在别的应用上，也包括 ClerkBox 自己。渲染层浮层会被
 * 切走的窗口盖住，等于「AI 在动你的电脑，但你看不到提示」——这正是要避免的情况。
 * 独立置顶窗口是唯一能在任何应用之上持续可见的形态。
 *
 * 三条必须做对的语义（都是 ZCode 踩过之后写进注释的）：
 *   1. `focusable: false` + `setIgnoreMouseEvents(true)`：点了不激活、也不挡鼠标。
 *      浮层声称的是「我在操作」，绝不能反过来把用户的输入吞掉。
 *   2. `setContentProtection(true)`：阻止屏幕录制/截图拍到这个窗口。
 *      否则用户截屏自证时，浮层本身会出现在证据里。
 *   3. `hide()` 失败降级为 `destroy()`：浮层在向用户声明一个事实，
 *      隐藏失败等于对着用户撒谎；销毁后下一个动作会重新拉起。
 */
import { BrowserWindow, screen } from 'electron'

/** 停手的兜底时限。显式清除路径（运行结束 / 会话结束 / 能力关闭）才是主路径，
 *  这个计时器只在它们全部失约时收场，保证浮层不会无限期停留。
 *  刻意给得比单个动作长得多：操控期内 AI 的两次动作之间可能隔着推理与审批，
 *  短时限会让浮块在运行中途熄灭。 */
const AUTO_HIDE_MS = 5 * 60_000
/** 退场动画时长：CSS 退出动画跑完再真正隐藏 */
const HIDE_ANIMATION_MS = 120
/** 拉起失败的重试间隔 */
const CREATE_RETRY_MS = 250

/** 浮块窗口尺寸。两行文案（标题 + 会话副标题）所需的高度，不是单行 38px */
/**
 * 浮块窗口尺寸。刻意沿用 ZCode 的账：窗口要比卡片大一圈，
 * 那圈留白是给 box-shadow 用的 —— 卡片贴边的话阴影会被窗口裁掉，
 * 浮层就会看起来像一块没有浮起来的灰色方块（这正是它此前的样子）。
 */
/** 窗口要比卡片宽裕：卡片贴合内容，窗口负责把两侧的圆角和阴影完整地放出来 */
const INDICATOR_SHADOW_INSET = { top: 6, right: 40, bottom: 12, left: 40 } as const
const INDICATOR_CARD_HEIGHT = 38
const INDICATOR_WIDTH = 400
const INDICATOR_HEIGHT = INDICATOR_SHADOW_INSET.top + INDICATOR_CARD_HEIGHT + INDICATOR_SHADOW_INSET.bottom

const POINTERS = [0, 120, 240] as const

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * **标题烤进 HTML，不靠运行时推送。**
 *
 * 这个浮块窗口是 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`
 * 且**没有 preload**，渲染进程里压根没有 `ipcRenderer` —— `webContents.send()`
 * 发过去的东西永远没人接收。所以曾经 `window.setLabel` 定义了却从不被调用：
 * 3 个点是纯 CSS 动画照常动，标题永远是空的，浮层成了「一坨灰东西加三个点」。
 * 参照 ZCode：文案在造 HTML 时就写进去，一劳永逸。
 */
function indicatorHtml(title: string, hint: string): string {
  const dots = POINTERS.map((delay) => `<span style="animation-delay:${delay}ms"></span>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  :root { color-scheme: light dark; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
  body {
    display: flex; align-items: center; justify-content: center;
    padding: ${INDICATOR_SHADOW_INSET.top}px ${INDICATOR_SHADOW_INSET.right}px ${INDICATOR_SHADOW_INSET.bottom}px ${INDICATOR_SHADOW_INSET.left}px;
    font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  }
  .pill {
    display: flex; align-items: center; gap: 10px; box-sizing: border-box;
    /* 贴合内容而不是 width:100%。顶到窗口边缘时右边那个圆角会被窗口裁成直角 ——
       浮层看起来像被「切了一刀」。窗口给足余量、卡片自己决定宽度，两边都不会被切。 */
    width: auto; max-width: 100%;
    height: ${INDICATOR_CARD_HEIGHT}px; padding: 0 18px; border-radius: 12px; white-space: nowrap;
    background: rgba(255, 255, 255, 0.96); border: 1px solid rgba(15, 23, 42, 0.14);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 12px -6px rgba(15, 23, 42, 0.18);
    color: #0f172a; font-size: 13px; line-height: 1; font-weight: 600;
  }
  /* 标题 + 退出提示。提示是必须的：小岛是唯一贴在所有应用之上的东西，
     「怎么叫停它」写在这里才真的找得到。做成按键形状是因为它是一个可按的键。 */
  .title { font-weight: 600; }
  .hint {
    display: inline-flex; align-items: center; gap: 4px; margin-left: 2px;
    padding: 2px 6px; border-radius: 5px;
    background: rgba(15, 23, 42, 0.08); border: 1px solid rgba(15, 23, 42, 0.12);
    color: #475569; font-size: 11px; font-weight: 600;
  }
  .dots { display: inline-flex; align-items: center; gap: 3px; }
  .dots span {
    width: 4px; height: 4px; border-radius: 50%; background: #64748b;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 70%, 100% { opacity: .35; transform: scale(.8); }
    35% { opacity: 1; transform: scale(1); }
  }
  html[data-state="leaving"] .pill { opacity: 0; transition: opacity 120ms ease, transform 120ms ease; transform: translateY(-6px); }
  @media (prefers-color-scheme: dark) {
    .pill {
      background: rgba(35, 38, 43, 0.96); border-color: rgba(255, 255, 255, 0.14);
      color: #f8fafc; box-shadow: 0 1px 2px rgba(0,0,0,.4), 0 6px 14px -6px rgba(0,0,0,.5);
    }
    .dots span { background: #a8b3c4; }
    .hint { background: rgba(255, 255, 255, 0.1); border-color: rgba(255, 255, 255, 0.16); color: #c3ccd9; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dots span { animation: none; }
    html[data-state="leaving"] .pill { transition-duration: 1ms; transform: none; }
  }
  </style></head><body data-state="idle">
  <div class="pill" role="status" aria-live="polite">
    <span class="dots" aria-hidden="true">${dots}</span>
    <span class="title">${escapeHtml(title)}</span>
    <span class="hint">${escapeHtml(hint)}</span>
  </div>
  <script>
    // 只留退场状态这一个钩子。标题已烤进 HTML，不需要推送。
    // 状态切换走 executeJavaScript 调用它 —— 同样是死路可走的 ipcRenderer 推送
    // 换成 executeJavaScript：它在页面自己的主世界里跑，能碰到这个内联脚本定义的函数。
    window.setState = function (state) { document.documentElement.dataset.state = state; };
  </script>
  </body></html>`
}

let win: BrowserWindow | null = null
let creating: Promise<BrowserWindow> | null = null
let hideTimer: NodeJS.Timeout | null = null
let autoHideTimer: NodeJS.Timeout | null = null
let label: string | null = null
/** 当前浮块窗口烤的是哪句文案；变了就得重建窗口 */
let winTitle: string | null = null
let winHint = ''
let disposed = false

/**
 * 切退场状态。
 *
 * 走 `executeJavaScript` 而不是 `webContents.send`：这个窗口没有 preload、
 * `sandbox: true`，渲染侧拿不到 `ipcRenderer`，send 过去的消息没有任何接收方。
 * （原来的 `send('indicator:state')` 是一条死链路 —— 退场动画其实也一直没生效。）
 */
function setDocumentState(state: 'idle' | 'active' | 'leaving'): void {
  if (!win || win.isDestroyed()) return
  void win.webContents
    .executeJavaScript(`window.setState && window.setState(${JSON.stringify(state)})`)
    .catch(() => { /* 页面还没加载完 / 已销毁：退场动画非关键，不追 */ })
}

function hideOrDestroy(target: BrowserWindow): void {
  if (disposed || target.isDestroyed()) return
  try {
    target.hide()
  } catch {
    // hide 抛错说明这个窗口已经不可靠了。销毁是安全底线：
    // 下一个动作会由 ensureWindow 重新拉起，用户最多看到一次闪烁，而不是一个赖着不走的假提示。
    try { target.destroy() } catch { /* 已经在销毁流程里 */ }
    if (win === target) win = null
  }
}

function beginHide(): void {
  if (!win || win.isDestroyed() || hideTimer) return
  setDocumentState('leaving')
  const target = win
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (!disposed && target === win && !target.isDestroyed()) hideOrDestroy(target)
  }, HIDE_ANIMATION_MS)
  hideTimer.unref?.()
}

function clearAutoHide(): void {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer)
    autoHideTimer = null
  }
}

function armAutoHide(): void {
  clearAutoHide()
  // 每次「刚动了一下」都重新计时。单个动作可以跑很久（截屏 + 重压），
  // 短时限会让浮层在操作中途熄灭，反而更让人不放心。
  autoHideTimer = setTimeout(() => beginHide(), AUTO_HIDE_MS)
  autoHideTimer.unref?.()
}

/** 浮层显示在鼠标所在屏幕的顶部居中 —— 眼睛在哪儿，提示就跟到哪儿 */
function computePosition(): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const bounds = display.workArea
  // 高度要装下标题 + 副标题两行（13px + 11px + 2px gap + 上下留白）
  return { x: Math.round(bounds.x + (bounds.width - INDICATOR_WIDTH) / 2), y: Math.round(bounds.y + 8) }
}

function scheduleRetry(): void {
  if (disposed) return
  const timer = setTimeout(() => {
    if (!win || win.isDestroyed()) void ensureWindow(label ?? '', winHint).catch(() => scheduleRetry())
  }, CREATE_RETRY_MS)
  timer.unref?.()
}

/**
 * 拉起浮块窗口。标题烤在 HTML 里，所以窗口身份与文案绑定：
 * 文案变了就重建窗口（loadURL 到同一个 URL 不刷新，必须换 data URL 或直接重建）。
 */
function ensureWindow(title: string, hint: string): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) {
    if (winTitle === title && winHint === hint) return Promise.resolve(win)
    // 文案变了：直接重建，别指望同 URL 的 loadURL 会重新加载
    try { win.destroy() } catch { /* noop */ }
    win = null
  }
  if (creating) return creating
  const task = (async () => {
    const created = new BrowserWindow({
      width: INDICATOR_WIDTH,
      height: INDICATOR_HEIGHT,
      ...computePosition(),
      alwaysOnTop: true,
      focusable: false,
      frame: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      transparent: true,
      backgroundColor: '#00000000',
      autoHideMenuBar: true,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      movable: false,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        devTools: false,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    created.setIgnoreMouseEvents(true)
    // 阻止截屏拍到浮层本身：否则用户截屏自证时证据里会混进这个窗口
    created.setContentProtection(true)

    // 意外的 closed 不该让「正在操控」这件事静默消失 —— 还有在跑的 turn 就重建
    created.on('closed', () => {
      if (win === created) win = null
      scheduleRetry()
    })

    const url = `data:text/html;base64,${Buffer.from(indicatorHtml(title, hint), 'utf-8').toString('base64')}`
    winTitle = title
    winHint = hint
    try {
      await created.loadURL(url)
    } catch (err) {
      console.error('[cua-indicator] load failed:', err)
      if (!created.isDestroyed()) created.destroy()
      throw err
    }
    win = created
    return created
  })()
  creating = task
  // 创建失败时不能把 creating 永久钉死，否则后续所有动作都会拿到同一个 rejected promise
  void task.catch(() => {
    if (creating === task) creating = null
  })
  return task
}

/**
 * 报告一次「AI 动了一下桌面」。
 *
 * **浮块在整个操控期常驻，不随单个动作熄灭。**
 *
 * 早期实现是每个动作 show → 动作结束 hide，结果它一直闪：AI 的动作之间隔着推理、
 * 审批、以及可能几十秒的等待，浮块在那段时间熄掉，用户看到的是「AI 偶尔动一下我的
 * 电脑」，而不是「AI 正在接管我的电脑」。闪烁的提示在安全上几乎无效 —— 用户无从
 * 判断现在该不该碰鼠标。
 *
 * 所以语义改成「本次运行正在操控」：`show` 把窗口拉起并常驻，直到运行结束
 * （渲染层调 `endComputerUseControl`）、会话结束、能力关闭，或 `AUTO_HIDE_MS`
 * 的失约兜底触发。
 *
 * 两阶段协议的 active 阶段专用：scheduled 阶段**不能**亮浮层 ——
 * 那时 AI 往往正卡在审批弹窗上，显示「正在操控」是在说谎。
 *
 * @param text 主标题，整段操控期内恒定（"ClerkBox 正在操控你的电脑"）。
 *   文案烤在 HTML 里，所以它同时是窗口的身份：变了就重建窗口。
 */
export async function showComputerUseIndicator(text: string, hint?: string): Promise<void> {
  if (disposed) return
  // 没有文案就不开窗，避免出现一个空浮块
  if (!text) return
  label = text
  try {
    const target = await ensureWindow(text, hint ?? '')
    if (target.isDestroyed()) return
    target.showInactive()
    // Windows 隐藏透明窗口后可能清掉 WS_EX_TOPMOST，showInactive 只恢复可见性不恢复层级，
    // 所以每次显示都要重新声明置顶并移到最前
    target.setAlwaysOnTop(true, 'screen-saver')
    target.moveTop()
    setDocumentState('active')
    armAutoHide()
  } catch (err) {
    console.error('[cua-indicator] show failed:', err)
    scheduleRetry()
  }
}

/**
 * 显式收手：一次运行结束 / 会话结束 / 能力关闭都走这里。
 *
 * 这是浮块的**主**退场路径，与 `show` 成对使用；
 * `AUTO_HIDE_MS` 只在所有显式路径全部失约时兜底。
 */
export function hideComputerUseIndicator(): void {
  clearAutoHide()
  if (!win || win.isDestroyed()) return
  if (!label) {
    // 从没亮过就别动：直接 hide 会让一个刚创建完的窗口白白走一遍退场动画
    return
  }
  label = null
  beginHide()
}

export function disposeComputerUseIndicator(): void {
  disposed = true
  clearAutoHide()
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  if (win && !win.isDestroyed()) {
    try { win.destroy() } catch { /* noop */ }
  }
  win = null
}
