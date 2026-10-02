/**
 * AI 指针
 *
 * 为什么不用系统鼠标指针：AI 的动作是 `SendInput` 合成的**真实**鼠标事件，
 * 走的是系统光标通道，我们没有、也不该去替换它（换掉之后用户在 AI 操作期间
 * 就失去了自己的光标，没法做别的事）。所以这里做的是**叠加**上去的一个标记：
 * 一个简洁的蓝色发光点，跟随 AI 最近一次指针落点。
 *
 * 它要回答的问题是「AI 的光标现在在哪」—— 用户看自己的真实光标是看不到这一点的，
 * 而在 AI 接管时，「下一步要点哪里」是最需要被看见的信息。
 *
 * 形态刻意极简（一个点 + 一圈柔光），理由和屏幕光晕一样：
 * 屏幕上已经有浮块和边框光晕两个提示了，指针再堆细节就变成噪声。
 *
 * 实现上刻意用「小窗口 + setPosition」而不是「整屏窗口 + 页内绝对定位」：
 * 整屏窗口要往页面里写坐标，而那个页面是 sandbox 且没有 preload，
 * 只能靠 executeJavaScript 反复调用 —— 每跟一步就注入一次脚本，既慢又脏。
 * 一个 64px 的窗口直接挪位置是纯窗口操作，零注入。
 */
import { BrowserWindow, screen } from 'electron'

/** 指针窗口边长（物理像素）。要装下光点本体 + 一圈外扩的柔光 */
const CURSOR_SIZE = 64
/** 光点在窗口内的位置：正中 */
const DOT_CENTER = CURSOR_SIZE / 2

/** 主色，与屏幕光晕同族，让两个提示读起来是一套的 */
const DOT_HEX = '110, 170, 255'

/**
 * 无操作后自动隐藏的静默时长。
 * AI 两次动作之间可能隔着推理，鼠标点停在那里不动是有信息量的（它停住了），
 * 但停太久就成了一个看起来像坏了的残留物。
 */
const IDLE_HIDE_MS = 4_000

function cursorHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  :root { color-scheme: dark; }
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  .dot {
    position: absolute;
    left: 50%; top: 50%;
    width: 14px; height: 14px;
    margin: -7px 0 0 -7px;
    border-radius: 50%;
    background: rgba(${DOT_HEX}, 0.95);
    box-shadow:
      /* 紧贴光点的一圈，让它在任何背景上都有硬边可辨 */
      0 0 0 1px rgba(255, 255, 255, 0.75),
      /* 主体柔光 */
      0 0 10px 2px rgba(${DOT_HEX}, 0.85),
      /* 外层扩散，衔接屏幕内容 */
      0 0 22px 6px rgba(${DOT_HEX}, 0.35);
  }
  </style></head><body><div class="dot"></div></body></html>`
}

let win: BrowserWindow | null = null
let creating: Promise<BrowserWindow> | null = null
let idleTimer: NodeJS.Timeout | null = null
let disposed = false

function ensureWindow(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return Promise.resolve(win)
  if (creating) return creating
  const task = (async () => {
    const created = new BrowserWindow({
      width: CURSOR_SIZE,
      height: CURSOR_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // 和浮块/光晕同级：不抢焦点、不进任务栏
      focusable: false,
      alwaysOnTop: true,
      webPreferences: {
        contextIsolation: true,
        devTools: false,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    // 指针是「看」的，不是「用」的：绝不吞掉用户的鼠标输入
    created.setIgnoreMouseEvents(true)
    // 不进录屏/截图
    created.setContentProtection(true)
    created.on('closed', () => {
      if (win === created) win = null
    })
    try {
      await created.loadURL(
        `data:text/html;base64,${Buffer.from(cursorHtml(), 'utf-8').toString('base64')}`,
      )
    } catch (err) {
      console.error('[ai-cursor] load failed:', err)
      try { created.destroy() } catch { /* noop */ }
      throw err
    }
    win = created
    return created
  })()
  creating = task
  void task.catch(() => {
    if (creating === task) creating = null
  })
  return task
}

/**
 * 把 AI 指针挪到屏幕物理坐标 (x, y)。
 * 只在指针类动作后调用；坐标是已经换算好的屏幕物理像素（见 computer-use 的 toScreenPoint）。
 */
export async function showAiCursor(x: number, y: number): Promise<void> {
  if (disposed) return
  try {
    const created = await ensureWindow()
    if (created.isDestroyed()) return
    // 副屏在虚拟桌面里可能是负坐标，setPosition 接受负值，不用自己偏移
    created.setPosition(Math.round(x - DOT_CENTER), Math.round(y - DOT_CENTER))
    created.showInactive()
    // Windows 上隐藏过的透明窗口会掉 WS_EX_TOPMOST，showInactive 不恢复层级
    created.setAlwaysOnTop(true, 'screen-saver')
  } catch {
    // 指针是增强信息，拿不到就不显示，绝不能因此让点击失败
    return
  }
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => hideAiCursor(), IDLE_HIDE_MS)
  idleTimer.unref?.()
}

export function hideAiCursor(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (win && !win.isDestroyed()) {
    try { win.hide() } catch { /* noop */ }
  }
}

export function disposeAiCursor(): void {
  disposed = true
  hideAiCursor()
  if (win && !win.isDestroyed()) {
    try { win.destroy() } catch { /* noop */ }
  }
  win = null
}

/** 该点所在的显示器（指针不能跨屏错位） */
export function displayForPoint(x: number, y: number): Electron.Display | null {
  return screen.getDisplayNearestPoint({ x, y })
}
