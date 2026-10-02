/**
 * Computer Use 执行器
 *
 * 职责边界很窄：截屏、派发动作、校验坐标、报回同构观测。
 * 输入合成交给 computer-input.ts 的平台后端，截图交给 Electron 自带的
 * `desktopCapturer`（零新依赖、三平台同一套 API）。
 *
 * 三条硬约定：
 *   1. **坐标只对本帧有效**。模型看到的是上一张截图，之后桌面可能已经变了 ——
 *      所以每次成功截图都会把本帧尺寸与「本帧的指纹」记在会话里；
 *      动作类命令携带的坐标先按本帧尺寸做越界校验，超了就报 out_of_bounds，
 *      让模型去重新截图，而不是往屏幕外点出一个不可预期的事件。
 *   2. **不猜 DPI**。`desktopCapturer` 给的是物理像素，`screen.getPrimaryDisplay().size` 也是
 *      物理像素，两者同一坐标系；scaleFactor 只作为观测一并回给模型，不参与换算。
 *   3. **失败不外发截图**。截图只在截图动作本身成功时产生。
 */
import { desktopCapturer, screen, clipboard } from 'electron'
import { AGENT_ACTION_LIMITS, isComputerAction } from '../src/lib/agent-actions'
import type { AgentActionImage, AgentActionImageRef, ComputerAction, ComputerActionResult, ComputerErrorCode } from '../src/lib/agent-actions'
import { getDesktopInputBackend, DesktopUnsupportedError, virtualDesktopRect } from './computer-input'
import { fitImageToInlineBudget, persistImageToTmp } from './agent-image'
import { showComputerUseIndicator, hideComputerUseIndicator } from './cua-indicator'
import { showScreenAura, hideScreenAura } from './screen-aura'
import { showAiCursor, hideAiCursor, disposeAiCursor } from './ai-cursor'
import { beginEscapeGuard, endEscapeGuard } from './escape-guard'

/**
 * 本会话最近一帧，以及「这一帧的像素 → 屏幕物理像素」的换算。
 *
 * 这一段是「AI 点击总是点不到东西」的真凶：截屏按最长边上限（computerShotMaxDimension）
 * 降采样过，模型看到的是缩放后的图，它给的 x/y 是**这张图的像素**；而 SendInput / osascript /
 * xdotool 要的都是**屏幕物理像素**。两者在 1080p 及以下恰好相等（scale=1，不出问题），
 * 一旦屏幕超过上限（1440p/4K，scale≈0.61）就整体偏出去，模型越点越偏、越试越像失灵。
 */
interface LastFrame {
  /** 交给模型那张图的像素尺寸 —— 越界校验按这个来 */
  width: number
  height: number
  /**
   * 一个**屏幕物理像素**对应多少位图像素（= bitmapWidth / screenWidth，≤1）。
   * 存这个方向是因为它同时是 region 裁剪里 `x1 * scale` 的那个系数，两个用途同口径。
   * 换回屏幕坐标时要**除**：screen = bitmap / scale。
   */
  scale: number
  /** 被截屏那块显示器在虚拟桌面里的物理原点（副屏在左侧时为负） */
  origin: { x: number; y: number }
  at: number
}
let lastFrame: LastFrame | null = null

/**
 * 「通知渲染层用户已叫停」的出口。
 *
 * 用注入而不是直接 import main.ts 的 mainWindow：本模块被 main.ts 引用，
 * 反向 import 会成环。注入也让本模块可以在测试里独立跑。
 */
let notifyUserStopped: (() => void) | null = null

/** 由 main.ts 在启动时注入 */
export function setUserStoppedNotifier(fn: (() => void) | null): void {
  notifyUserStopped = fn
}

type Failure = { code: ComputerErrorCode; message: string }

function fail(code: ComputerErrorCode, message: string): Failure {
  return { code, message }
}

/** 主屏幕尺寸（物理像素）。与 desktopCapturer 同一坐标系，不做 scale 换算 */
function primaryScreenSize(): { width: number; height: number; scaleFactor: number } {
  const display = screen.getPrimaryDisplay()
  return {
    width: display.size.width,
    height: display.size.height,
    scaleFactor: display.scaleFactor,
  }
}

/**
 * 截屏。走 `desktopCapturer` 而不是各平台 CLI：
 * Electron 自带、同一套 API 覆盖三平台，macOS 缺屏幕录制权限时返回空列表而不是抛错，
 * 我们据此给出一条能指导用户去系统设置里授权的明确错误。
 *
 * thumbnailSize 按最长边上限请求：Electron 内部会按比例缩，不传的话 4K 屏会截出
 * 一张巨大的 PNG，纯粹浪费在裁剪上。
 */
async function captureScreen(region?: [number, number, number, number]): Promise<AgentActionImageRef> {
  const size = primaryScreenSize()
  const longest = Math.max(size.width, size.height)
  const scale = longest > AGENT_ACTION_LIMITS.computerShotMaxDimension
    ? AGENT_ACTION_LIMITS.computerShotMaxDimension / longest
    : 1
  const targetWidth = Math.max(1, Math.round(size.width * scale))
  const targetHeight = Math.max(1, Math.round(size.height * scale))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetWidth, height: targetHeight },
    fetchWindowIcons: false,
  })
  if (sources.length === 0) {
    throw fail(
      'permission_denied',
      'No screen source is available. On macOS, grant ClerkBox Screen Recording permission in System Settings → Privacy & Security → Screen Recording, then restart the app.',
    )
  }
  // 多屏时 desktopCapturer 逐屏返回；取尺寸最接近请求值的那一个（即主屏）
  const thumbnail = sources
    .map((source) => source.thumbnail)
    .filter((image) => !image.isEmpty())
    .sort((a, b) => {
      const sa = a.getSize()
      const sb = b.getSize()
      return (
        Math.abs(sb.width - targetWidth) + Math.abs(sb.height - targetHeight)
        - (Math.abs(sa.width - targetWidth) + Math.abs(sa.height - targetHeight))
      )
    })[0]
  if (!thumbnail) {
    throw fail('execution_error', 'Screen capture returned an empty image.')
  }

  // 区域截图在位图上裁：nativeImage.crop 是主进程原生的，不需要任何 canvas 依赖。
  // 请求坐标是屏幕物理像素，要先按本次的降采样比例换算到位图坐标。
  let cropped: Electron.NativeImage | null = null
  let clamped = false
  if (region) {
    const [x1, y1, x2, y2] = region
    clamped = x1 < 0 || y1 < 0 || x2 > size.width || y2 > size.height
    const left = Math.max(0, Math.min(thumbnail.getSize().width, Math.round(x1 * scale)))
    const top = Math.max(0, Math.min(thumbnail.getSize().height, Math.round(y1 * scale)))
    const right = Math.max(left + 1, Math.min(thumbnail.getSize().width, Math.round(x2 * scale)))
    const bottom = Math.max(top + 1, Math.min(thumbnail.getSize().height, Math.round(y2 * scale)))
    cropped = thumbnail.crop({ x: left, y: top, width: right - left, height: bottom - top })
  }

  const source = cropped ?? thumbnail
  const raw: AgentActionImage = {
    dataUrl: `data:image/png;base64,${source.toPNG().toString('base64')}`,
    mimeType: 'image/png',
    width: source.getSize().width,
    height: source.getSize().height,
    fullScreen: !cropped,
  }
  const image = fitImageToInlineBudget(raw)
  if (!image) {
    throw fail('execution_error', 'Screen capture produced an image too large to send to the model.')
  }
  // 落盘在主进程做：这里还握着 NativeImage，字节精确；
  // 交给渲染层用 ipc.writeFile 写会落成一个「长得像 data URL 的文本文件」，
  // 模型侧随后报 invalid image content / unknown format
  const imageRef = persistImageToTmp(image, 'computer-shot')
  if (!imageRef) {
    throw fail('execution_error', 'Screen capture succeeded but the image could not be saved to disk.')
  }
  lastFrame = {
    width: image.width,
    height: image.height,
    // 这一帧的每个位图像素对应多少屏幕物理像素，**必须从交付给模型的那张图反推**。
    // 不能复用上面给 thumbnailSize 用的那个 scale：fitImageToInlineBudget 可能又缩了一轮，
    // 两者不等时按错的换算就会系统性偏出去。
    scale: size.width > 0 ? image.width / size.width : 1,
    origin: { x: 0, y: 0 },
    at: Date.now(),
  }
  // region 越界被裁过时如实标记：这一帧不是模型请求的那个矩形
  return clamped ? { ...imageRef, fullScreen: false } : imageRef
}

/**
 * 模型给的坐标（最近那张截图的像素）→ 屏幕物理像素。
 *
 * 没有可用帧时按「模型给的就是屏幕坐标」处理：越界校验本来就会兜住离谱的值，
 * 而直接照搬比凭 scaleFactor 瞎猜更接近用户意图（用户口头描述的位置）。
 */
function toScreenPoint(point: { x: number; y: number }): { x: number; y: number } {
  const frame = lastFrame
  if (!frame) return { x: point.x, y: point.y }
  // frame.scale = bitmapPx / screenPx，所以要**除**才能回到屏幕物理坐标
  const divisor = frame.scale > 0 ? frame.scale : 1
  return {
    x: Math.round(frame.origin.x + point.x / divisor),
    y: Math.round(frame.origin.y + point.y / divisor),
  }
}

/** 把 AI 指针挪到屏幕上模型的落点处。指针类动作专用。 */
function pointCursor(point: { x: number; y: number }): void {
  void showAiCursor(point.x, point.y)
}

/** 坐标越界校验。模型最常见的错误就是拿上一帧的坐标点新帧上的位置，先挡住明显的越界 */
function assertInBounds(point: { x: number; y: number }, label: string): void {
  const frame = lastFrame
  const size = frame ?? primaryScreenSize()
  if (point.x < 0 || point.y < 0 || point.x >= size.width || point.y >= size.height) {
    throw fail(
      'out_of_bounds',
      `${label} (${Math.round(point.x)}, ${Math.round(point.y)}) is outside the ${size.width}x${size.height} frame you were given. Take a fresh computer_screenshot and pick coordinates from it.`,
    )
  }
}

/** 把动作上的坐标字段（x/y 或 fromX/fromY、toX/toY）换算成屏幕物理坐标 */
function scaled(
  action: Record<string, unknown>,
  xKey = 'x',
  yKey = 'y',
): { x: number; y: number } {
  return toScreenPoint({ x: Number(action[xKey]) || 0, y: Number(action[yKey]) || 0 })
}

async function executeAction(action: ComputerAction): Promise<Partial<ComputerActionResult>> {
  const backend = getDesktopInputBackend()
  const size = primaryScreenSize()
  // SendInput 的 ABSOLUTE 归一化基准由主进程下发（helper 查不到物理像素，见 computer-input.ts）
  await backend.setVirtualDesktop(virtualDesktopRect())

  switch (action.action) {
    case 'screenshot': {
      const imageRef = await captureScreen(action.region)
      return { imageRef, screen: size }
    }
    case 'left_click':
      assertInBounds(action, 'Click position')
      pointCursor(scaled(action))
      await backend.click(scaled(action).x, scaled(action).y, 'left', action.clickCount ?? 1)
      return { screen: size }
    case 'right_click':
      assertInBounds(action, 'Click position')
      pointCursor(scaled(action))
      await backend.click(scaled(action).x, scaled(action).y, 'right', 1)
      return { screen: size }
    case 'double_click':
      assertInBounds(action, 'Click position')
      pointCursor(scaled(action))
      await backend.click(scaled(action).x, scaled(action).y, 'left', 2)
      return { screen: size }
    case 'mouse_move':
      assertInBounds(action, 'Pointer position')
      pointCursor(scaled(action))
      await backend.move(scaled(action).x, scaled(action).y)
      return { screen: size }
    case 'left_click_drag':
      assertInBounds({ x: action.fromX, y: action.fromY }, 'Drag start')
      assertInBounds({ x: action.toX, y: action.toY }, 'Drag end')
      pointCursor(scaled(action, 'fromX', 'fromY'))
      await backend.drag(scaled(action, 'fromX', 'fromY'), scaled(action, 'toX', 'toY'))
      return { screen: size }
    case 'scroll':
      if (action.x !== undefined || action.y !== undefined) {
        assertInBounds({ x: action.x ?? 0, y: action.y ?? 0 }, 'Scroll position')
        const at = toScreenPoint({ x: action.x ?? 0, y: action.y ?? 0 })
        pointCursor(at)
        await backend.scroll(at.x, at.y, action.deltaX ?? 0, action.deltaY ?? -3)
      } else {
        await backend.scroll(undefined, undefined, action.deltaX ?? 0, action.deltaY ?? -3)
      }
      return { screen: size }
    case 'type':
      await backend.type(action.text)
      return { screen: size }
    case 'key':
      await backend.key(action.key)
      return { screen: size }
    case 'hold_key': {
      // 组合键的「按住」语义在 System Events / xdotool 上没有通用的阻塞式原语，
      // 退化成一次普通按键：绝大多数场景（Shift+点击、Ctrl+Tab）本来就只需要那一瞬。
      await backend.key(action.key)
      return { screen: size }
    }
    case 'wait': {
      const ms = Math.min(Math.max(0, action.durationMs ?? AGENT_ACTION_LIMITS.computerWaitDefaultMs), AGENT_ACTION_LIMITS.computerWaitMaxMs)
      await new Promise((r) => setTimeout(r, ms))
      return { screen: size }
    }
    case 'read_clipboard': {
      const text = clipboard.readText()
      if (text.length > AGENT_ACTION_LIMITS.clipboardMaxChars) {
        return { value: text.slice(0, AGENT_ACTION_LIMITS.clipboardMaxChars) + `\n… (${text.length} chars total, truncated)`, screen: size }
      }
      return { value: text === '' ? '(clipboard is empty)' : text, screen: size }
    }
    case 'write_clipboard':
      clipboard.writeText(action.text.slice(0, AGENT_ACTION_LIMITS.clipboardMaxChars))
      return { value: `Wrote ${action.text.length} characters to the clipboard.`, screen: size }
    case 'list_apps': {
      const apps = await backend.listApps()
      return { apps: apps.slice(0, AGENT_ACTION_LIMITS.appListMax), screen: size }
    }
    case 'open_application':
      await backend.openApp(action.name)
      return { value: `Requested launch of "${action.name}". It may take a moment to appear — take a screenshot to check.`, screen: size }
    default: {
      const never = action as { action: string }
      throw fail('execution_error', `Unknown computer action "${never.action}".`)
    }
  }
}

/**
 * 工具层唯一入口。永不 reject：失败以结构化 error 随结果返回。
 *
 * @param sessionLabel 正在执行的那个对话的名字，显示在浮块副标题上。
 *   AI 在操控用户的桌面时，用户需要能追责「是谁在动」——这个 run 是渲染层发起的，
 *   主进程无从得知，只能由调用方传下来。
 */
export async function runComputerAction(
  action: ComputerAction,
  sessionLabel?: string,
): Promise<ComputerActionResult> {
  const startedAt = Date.now()
  // 只有「真的动了桌面」的动作才亮浮层。读截图、列应用、读剪贴板不动用户的手，
  // 为它们亮「正在操控你的电脑」是虚报。
  const touchesDesktop = DESKTOP_TOUCHING_ACTIONS.has(action.action)
  if (touchesDesktop) {
    // 接管 Esc。**接管失败就不显示「按 Esc 停止」** —— 提示一个按不动的键
    // 比没有提示更糟，用户会以为是自己电脑的问题。
    const guarded = beginEscapeGuard(() => {
      endComputerUseControl()
      notifyUserStopped?.()
    })
    // 标题恒定：用户要看到的是「我的电脑正在被别人控制」这件事本身，
    // 不是它此刻在点哪儿。会话名只进日志，不挤占唯一需要可见的那一行字。
    void showComputerUseIndicator(DESKTOP_CONTROL_TITLE, guarded ? DESKTOP_CONTROL_HINT : '')
    // 屏幕边框光晕：浮块告诉你「在操控」，光晕告诉你「整个屏幕都在被接管」——
    // 视线不在浮块上时（比如你在看别的应用），光晕是唯一还能被余光捕捉到的信号。
    void showScreenAura()
    if (sessionLabel) {
      console.log('[cua] controlling computer', { action: action.action, session: sessionLabel })
    }
  }
  try {
    const partial = await executeAction(action)
    return { ok: true, ...partial, elapsedMs: Date.now() - startedAt }
  } catch (err) {
    const failure: Failure =
      err instanceof DesktopUnsupportedError
        ? fail('platform_unsupported', err.message)
        : typeof err === 'object' && err !== null && 'code' in err && 'message' in err
          ? { code: (err as Failure).code, message: (err as Failure).message }
          : fail('execution_error', err instanceof Error ? err.message : String(err))
    return { ok: false, error: failure, elapsedMs: Date.now() - startedAt }
  }
  // 刻意**不**在动作结束时熄灭浮块：AI 的两次动作之间隔着推理与审批，
  // 逐动作闪灭会让「正在接管我的电脑」看起来像「偶尔动一下」。
  // 收手交给运行结束 / 会话结束 / 能力关闭（endComputerUseControl）与 AUTO_HIDE_MS 兜底。
}

/** 供 IPC 层做入参校验（白名单，与 agent-actions 的 isComputerAction 同口径） */
export { isComputerAction }

/** 一次运行 / 会话结束时的收手：清掉越界校验用的上一帧，并让浮块退场 */
export function resetComputerUseFrame(): void {
  lastFrame = null
  endEscapeGuard()
  hideComputerUseIndicator()
  hideScreenAura()
  hideAiCursor()
}

/** 应用退出：指针窗口也要销毁，否则会留一个孤儿置顶窗口 */
export function disposeComputerUseCursors(): void {
  endEscapeGuard()
  disposeAiCursor()
}

/** 会话结束 / 能力关闭时的纯退场（不动坐标基准） */
export function endComputerUseControl(): void {
  endEscapeGuard()
  hideComputerUseIndicator()
  hideScreenAura()
  hideAiCursor()
}

/**
 * 会「动到用户桌面」的动作集合。只有这些才亮置顶浮层 ——
 * 截屏、列应用、读剪贴板、纯等待都不动用户的手，为它们亮「正在操控你的电脑」是虚报。
 */
const DESKTOP_TOUCHING_ACTIONS: ReadonlySet<ComputerAction['action']> = new Set([
  'left_click', 'right_click', 'double_click', 'mouse_move', 'left_click_drag',
  'scroll', 'type', 'key', 'hold_key', 'write_clipboard', 'open_application',
])

/**
 * 浮块的**主标题**：整段操控期内恒定不变，说的就是「AI 正在操控你的电脑」这件事本身。
 *
 * 之前把主标题让给了 `DESKTOP_TOUCHING_LABELS` 里的动作短语（"AI is clicking…"），
 * 于是浮块在「点击/输入/滚动」之间来回跳。用户要看的从来不是「它此刻在点哪里」，
 * 而是「**我的电脑此刻正在被别人控制**」—— 这是唯一需要在任何应用之上、
 * 任何时刻都可见的那一条信息。动作降级成副标题的细节。
 *
 * 主标题带产品名：这是「ClerkBox 在动你的电脑」，不是某个匿名的自动化进程。
 */
const DESKTOP_CONTROL_TITLE = 'ClerkBox 正在操控你的电脑'

/**
 * 小岛上的退出提示。
 *
 * 一个能被随时叫停的接管，比一个不能叫停的接管安全得多 —— 但「叫停」这件事
 * 如果只有开发者知道，就等于没有。所以出口必须写在**用户视线里**（小岛是唯一
 * 贴在所有应用之上、任何时候都看得见的地方），而不是埋在文档或设置里。
 */
const DESKTOP_CONTROL_HINT = '按 Esc 停止'
