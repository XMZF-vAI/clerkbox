/**
 * 「AI 正在操控」屏幕边框光晕
 *
 * 与 `cua-indicator.ts` 的浮块**同级**：同样是主进程的独立置顶窗口。理由相同 ——
 * 操控期间用户的注意力在别的应用上（也包括 ClerkBox 自己），渲染层里做的任何提示
 * 都会被切走的窗口盖住。光晕尤其只能是窗口级：它要盖在**整个屏幕**的边框上。
 *
 * 三条必须做对的语义（与浮块同源，理由见各条注释）：
 *   1. `focusable: false` + `setIgnoreMouseEvents(true)`：点了不激活、也不挡鼠标。
 *      一个声称「我在操作你的电脑」的提示，绝不能反过来吞掉你的输入。
 *   2. `setContentProtection(true)`：不进入屏幕录制/截图。否则用户截屏自证时，
 *      每张截图都会多一圈蓝光，噪声大到让人想关掉这个功能。
 *   3. 逐屏一个窗口，而不是一个横跨虚拟桌面的巨窗：每块屏各自有圆角边框，
 *      跨屏拼接处不会莫名其妙地出现两条竖线。
 *
 * 呼吸用 opacity + box-shadow 的 CSS 动画，不做主进程定时器 ——
 * 动画节拍交给合成器，窗口被关掉时自然消失，不会留下一个孤儿定时器。
 */
import { BrowserWindow, screen } from 'electron'

/** 边框粗细（物理像素） */
/** 圆角半径（物理像素）：跟窗口圆角一致才不像贴了张贴纸 */
const RADIUS = 14

/** 呼吸周期。与浮块的点阵节奏错开，两个动画同时跑会显得很吵 */
const BREATH_MS = 2_000

/** 兜底时限。显式收手（操控结束 / 能力关闭）是主路径，这个只在它们全失约时兜底 */
const AUTO_HIDE_MS = 5 * 60_000

/**
 * 边框光晕。用户要的是**一条粗的、往里逐渐透明的、呼吸的蓝色光带**，
 * 不是一根 1~3px 描边 —— 那个在满屏内容上根本看不见。
 *
 * 三层 inset 阴影叠出连续渐变：最外沿一条细实线把边界钉住（否则渐变糊成一片
 * 没有形状的蓝），中间一条厚光带，再外面一层柔光把光带和屏幕内容衔接起来。
 * 全用 inset + blur：光带画在盒子**内侧**，不会溢出屏幕被裁掉。
 *
 * 呼吸动的是**整体强度**（opacity），不动 inset / spread / transform ——
 * 边框必须一直待在边上；一胀一缩会被读成「屏幕边缘有东西在动」，
 * 而提示要说的是「AI 在动你的电脑」。
 */
const AURA_RGB = '76, 141, 255'
/** 光带厚度：从边缘往里衰减的主尺度 */
const BAND = 90

function auraHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  :root { color-scheme: dark; }
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  .aura {
    position: fixed; inset: 0;
    box-sizing: border-box;
    border-radius: ${RADIUS}px;
    box-shadow:
      inset 0 0 0 2px rgba(${AURA_RGB}, 0.95),
      inset 0 0 ${BAND}px ${BAND / 4}px rgba(${AURA_RGB}, 0.5),
      inset 0 0 ${BAND * 2}px ${BAND / 2}px rgba(${AURA_RGB}, 0.22);
    animation: breathe ${BREATH_MS}ms ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { opacity: .4; }
    50%      { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    /* 不熄灭：光带本身就是「正在操控」这个唯一的信号，闪没了等于没提示。
       只把它稳在一个中间强度，不再起伏。 */
    .aura { animation: none; opacity: .75; }
  }
  </style></head><body><div class="aura"></div></body></html>`
}

/** sessionId 不需要：光晕是机器级的信号，跨会话同时成立 */
const wins = new Map<string, BrowserWindow>()
let creating: Promise<void> | null = null
let autoHideTimer: NodeJS.Timeout | null = null
let disposed = false
let shown = false

function createForDisplay(displayId: number, bounds: Electron.Rectangle): BrowserWindow {
  const created = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    alwaysOnTop: true,
    focusable: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // **不要 fullscreen: true。** Windows 上它会按 workArea 重算窗口尺寸，
    // 结果就是光晕只盖到任务栏上沿为止 —— 而用户要的是「整个屏幕」。
    // 这里用 display.bounds（含任务栏区域）显式铺满，任务栏也在光晕之内。
    fullscreen: false,
    webPreferences: {
      contextIsolation: true,
      devTools: false,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // 再钉一次尺寸：某些情况下构造参数会被 DPI 缩放改写，setBounds 才是最终说了算的
  created.setBounds(bounds)
  // 点了不激活、也不挡鼠标 —— 提示不许变成障碍
  created.setIgnoreMouseEvents(true)
  // 不进入录屏/截图
  created.setContentProtection(true)
  created.on('closed', () => {
    wins.delete(String(displayId))
  })
  return created
}

/** 拉起全部屏幕的光晕。已存在则只恢复可见。 */
export async function showScreenAura(): Promise<void> {
  if (disposed) return
  shown = true
  if (creating) return creating
  const task = (async () => {
    const displays = screen.getAllDisplays()
    for (const display of displays) {
      const key = String(display.id)
      if (wins.has(key)) continue
      const created = createForDisplay(display.id, display.bounds)
      try {
        await created.loadURL(
          `data:text/html;base64,${Buffer.from(auraHtml(), 'utf-8').toString('base64')}`,
        )
      } catch (err) {
        console.error('[screen-aura] load failed:', err)
        try { created.destroy() } catch { /* noop */ }
        continue
      }
      wins.set(key, created)
    }
    // 统一在所有窗口都就位后再显示：逐个 show 会有一瞬「只有一块屏有边框」
    for (const created of wins.values()) {
      if (created.isDestroyed()) continue
      created.showInactive()
      // Windows 上隐藏过的透明窗口会掉 WS_EX_TOPMOST，showInactive 不恢复层级
      created.setAlwaysOnTop(true, 'screen-saver')
    }
  })()
  creating = task
  try {
    await task
  } finally {
    creating = null
  }
  armAutoHide()
}

function armAutoHide(): void {
  clearAutoHide()
  autoHideTimer = setTimeout(() => hideScreenAura(), AUTO_HIDE_MS)
  autoHideTimer.unref?.()
}

function clearAutoHide(): void {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer)
    autoHideTimer = null
  }
}

/** 显式收手。操控结束 / 能力关闭 / 会话结束都走这里。 */
export function hideScreenAura(): void {
  clearAutoHide()
  if (!shown) return
  shown = false
  for (const created of wins.values()) {
    if (created.isDestroyed()) continue
    try { created.destroy() } catch { /* noop */ }
  }
  wins.clear()
}

/**
 * 浏览器操控的滑窗时长。
 *
 * 电脑操控是连续的（一条接一条动桌面），光晕全程常亮是对的。
 * 浏览任务不是：截图 → 模型推理（可能几十秒） → 点击 → 截图，中间那段时间
 * 屏幕根本没被碰。全程亮着等于在说「现在正在动」，而事实是「正在准备动」。
 * 所以浏览用滑窗：每条命令亮一小段，安静期自己熄掉，行为和标签上的呼吸图标一致。
 */
const PULSE_MS = 5_000

let pulseTimer: NodeJS.Timeout | null = null

/**
 * 滑窗式闪一下：用于「间歇性」的操控（浏览器）。
 * 与 `showScreenAura` 的区别只在于多久后自动熄。
 */
export function pulseScreenAura(): void {
  if (disposed) return
  if (pulseTimer) clearTimeout(pulseTimer)
  void showScreenAura()
  pulseTimer = setTimeout(() => {
    pulseTimer = null
    // 期间没有新命令才熄 —— 有新命令会被上面的 clearTimeout 顺延
    if (wins.size > 0) hideScreenAura()
  }, PULSE_MS)
  pulseTimer.unref?.()
}

export function disposeScreenAura(): void {
  disposed = true
  if (pulseTimer) {
    clearTimeout(pulseTimer)
    pulseTimer = null
  }
  hideScreenAura()
}
