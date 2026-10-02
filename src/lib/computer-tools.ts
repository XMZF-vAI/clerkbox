/**
 * Computer Use 工具族
 *
 * 十个工具，对标 Anthropic 的 computer-use 动作集与 ZCode 的 CUA 动作词表。
 * 只有**截图 + 坐标操作**：没有无障碍元素树。理由是跨平台代价 ——
 * Windows UIA / macOS AX API 都要各自的原生通路，做出来还是平台相关的一大块，
 * 而坐标操作在三个平台上都能用同一套语义表达。
 * 预留的演进位：命令契约里已有 elements/state_id 的位置（见 agent-actions 的 ComputerAction），
 * 补元素树时是加一档观测，不动动作定义。
 *
 * 坐标是唯一的目标表达方式，因此**截图是前置条件**：模型必须先看一帧，
 * 再对这一帧的像素发坐标。这就是工具描述里反复强调「先截图再点击」的原因。
 */
import { ipc } from './ipc-client'
import { AGENT_ACTION_LIMITS, type ComputerAction, type ComputerActionResult, type ComputerAppInfo } from './agent-actions'
import type { ToolDefinition } from '../types/agent'
import type { ToolContext } from './tool-registry'

// ── Tool definitions ──

/** 所有坐标类工具共用的前置说明 */
const COORDINATE_CONVENTION = [
  'Coordinates:',
  '- x/y are absolute integer pixels in the screenshot you were given most recently.',
  '- They are NOT normalized 0-1, NOT window bounds, NOT desktop DPI-scaled values.',
  '- If the screen has changed since your last screenshot, take a new one first — a stale frame gives wrong coordinates.',
  '- If a coordinate falls outside the reported screen size, the click is refused; re-screenshot and re-pick.',
].join('\n')

const computerTools: ToolDefinition[] = [
  {
    name: 'computer_screenshot',
    description:
      'Capture the primary screen and return it to you. This is how you see the desktop at all.\n' +
      'Usage:\n' +
      '- Call this first, before any other computer tool. Every coordinate you send later refers to the frame you got here.\n' +
      '- The image is attached to this tool result; you see it directly, you do not get a file path to read.\n' +
      '- Also call it again whenever you need to check whether something worked. Never assume an action succeeded.',
    parameters: {
      type: 'object',
      properties: {
        region: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional [x1, y1, x2, y2] in screen pixels to capture just that rectangle.',
        },
      },
      required: [],
    },
  },
  {
    name: 'computer_click',
    description:
      'Click at a point on the screen, using coordinates from your most recent screenshot.\n' +
      'Usage:\n' +
      '- Never click without a fresh screenshot; the desktop moves under you.\n' +
      `- ${COORDINATE_CONVENTION}`,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Screen X in pixels.' },
        y: { type: 'number', description: 'Screen Y in pixels.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button. Default left.' },
        click_count: { type: 'number', description: '2 for a double click. Default 1.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'computer_move',
    description: 'Move the mouse pointer to a screen point without clicking. Use it to reveal hover menus and tooltips.\n' + `Usage:\n- ${COORDINATE_CONVENTION}`,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Screen X in pixels.' },
        y: { type: 'number', description: 'Screen Y in pixels.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'computer_drag',
    description:
      'Press at one screen point, drag to another, and release.\n' +
      'Usage:\n' +
      '- Use for sliders, scrollbars, window edges, drag-and-drop.\n' +
      `- ${COORDINATE_CONVENTION}`,
    parameters: {
      type: 'object',
      properties: {
        from_x: { type: 'number', description: 'Screen X where the press starts.' },
        from_y: { type: 'number', description: 'Screen Y where the press starts.' },
        to_x: { type: 'number', description: 'Screen X where the release happens.' },
        to_y: { type: 'number', description: 'Screen Y where the release happens.' },
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
  },
  {
    name: 'computer_scroll',
    description:
      'Scroll the wheel at a screen point.\n' +
      'Usage:\n' +
      '- Positive delta_y scrolls down, negative scrolls up. Typical step is 3-5 notches.\n' +
      '- Omit x/y to scroll wherever the pointer already is.\n' +
      `- ${COORDINATE_CONVENTION}`,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Screen X of the wheel position. Omit to use the current pointer position.' },
        y: { type: 'number', description: 'Screen Y of the wheel position. Omit to use the current pointer position.' },
        delta_x: { type: 'number', description: 'Horizontal wheel delta. Default 0.' },
        delta_y: { type: 'number', description: 'Vertical wheel delta. Default -3 (three notches down).' },
      },
      required: [],
    },
  },
  {
    name: 'computer_type',
    description:
      'Type text into whatever currently has keyboard focus.\n' +
      'Usage:\n' +
      '- Click the target field first with computer_click, then type.\n' +
      '- This inserts text directly; use computer_key for Enter, Tab, Escape and shortcuts.\n' +
      '- Newlines in the text are inserted as line breaks, not as Enter presses.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `Text to type, up to ${AGENT_ACTION_LIMITS.computerTypeMaxChars} characters.` },
      },
      required: ['text'],
    },
  },
  {
    name: 'computer_key',
    description:
      'Press a key or a key combination on the focused window.\n' +
      'Usage:\n' +
      '- Use for Enter, Tab, Escape, arrows, and shortcuts like Control+s or Control+Shift+n.\n' +
      '- Key names are case-insensitive: enter, return, esc, ctrl, arrowdown all work. Use "Meta" for the Windows / Command key.\n' +
      '- Pressing a key can dismiss a dialog or submit a form — re-screenshot afterwards to see the result.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or combination with "+", e.g. Enter, Control+a, Alt+F4.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'computer_wait',
    description:
      'Pause for a fixed number of milliseconds.\n' +
      'Usage:\n' +
      '- Use after an action that triggers slow work, instead of clicking again into a still-loading window.\n' +
      `- Default ${AGENT_ACTION_LIMITS.computerWaitDefaultMs}ms, max ${AGENT_ACTION_LIMITS.computerWaitMaxMs}ms.`,
    parameters: {
      type: 'object',
      properties: {
        duration_ms: { type: 'number', description: 'How long to wait in milliseconds.' },
      },
      required: [],
    },
  },
  {
    name: 'computer_app',
    description:
      'List the running applications, or launch one by name.\n' +
      'Usage:\n' +
      '- Use action=open to start an app; you do not need its path if it is a normal installed program.\n' +
      '- Use action=list to see what is already running — that is how you find out which app is in front.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'open'], description: 'What to do. Default list.' },
        name: { type: 'string', description: 'Application name to launch, e.g. notepad, Calculator, Safari. Required for action=open.' },
      },
      required: [],
    },
  },
  {
    name: 'computer_clipboard',
    description:
      'Read the system clipboard, or write text to it.\n' +
      'Usage:\n' +
      '- Reading is the reliable way to get a long value out of a field that cannot be selected cleanly.\n' +
      '- Writing then pasting beats typing long text: write it, press Control+v / Meta+v.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: 'What to do. Default read.' },
        text: { type: 'string', description: 'Text to put on the clipboard. Required for action=write.' },
      },
      required: [],
    },
  },
]

export const COMPUTER_TOOLS: ToolDefinition[] = computerTools

// ── 结果渲染 ──

function renderApps(apps: ComputerAppInfo[] | undefined): string {
  if (!apps || apps.length === 0) return 'No applications reported.'
  return apps
    .slice(0, AGENT_ACTION_LIMITS.appListMax)
    .map((app) => `- ${app.name}${app.pid ? ` (pid ${app.pid})` : ''}${app.active ? ' [active]' : ''}`)
    .join('\n')
}

function renderScreen(result: ComputerActionResult): string {
  const screen = result.screen
  if (!screen) return ''
  return `Screen: ${screen.width}x${screen.height}px (scale ${screen.scaleFactor}). Coordinates you send must be inside this.`
}

/**
 * 截图落盘由**主进程**完成（见 electron/agent-image.ts 的 persistImageToTmp），
 * 这里只把磁盘引用转手上报给宿主。渲染层不自己写文件：`ipc.writeFile` 是文本通道，
 * 写 base64 会得到「长得像 data URL 的文本文件」，模型侧随即报 unknown format。
 */
function attachScreenshot(result: ComputerActionResult, ctx: ToolContext | undefined): string {
  const ref = result.imageRef
  if (!ref || !ctx?.recordImage) return ''
  ctx.recordImage(ref)
  return `\n[Screenshot attached: ${ref.width}x${ref.height}, saved to ${ref.path}]`
}

// ── 执行 ──

function toAction(name: string, args: Record<string, unknown>): ComputerAction | { error: string } {
  const str = (key: string, fallback = ''): string => {
    const v = args[key]
    return v === undefined || v === null ? fallback : String(v)
  }
  const num = (key: string): number | undefined => {
    const v = args[key]
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const pointArgs = (): { x: number; y: number } | { error: string } => {
    const x = num('x')
    const y = num('y')
    if (x === undefined || y === undefined) return { error: `${name} needs both x and y.` }
    return { x, y }
  }

  switch (name) {
    case 'computer_screenshot': {
      const raw = args.region
      if (Array.isArray(raw) && raw.length === 4 && raw.every((v) => Number.isFinite(Number(v)))) {
        return { action: 'screenshot', region: raw.map((v) => Math.round(Number(v))) as [number, number, number, number] }
      }
      return { action: 'screenshot' }
    }
    case 'computer_click': {
      const point = pointArgs()
      if ('error' in point) return point
      const count = num('click_count') ?? 1
      if (count >= 2) return { action: 'double_click', ...point }
      return { action: str('button', 'left') === 'right' ? 'right_click' : 'left_click', ...point, ...(count > 1 ? { clickCount: count } : {}) }
    }
    case 'computer_move': {
      const point = pointArgs()
      return 'error' in point ? point : { action: 'mouse_move', ...point }
    }
    case 'computer_drag': {
      const fromX = num('from_x')
      const fromY = num('from_y')
      const toX = num('to_x')
      const toY = num('to_y')
      if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) {
        return { error: 'computer_drag needs from_x, from_y, to_x and to_y.' }
      }
      return { action: 'left_click_drag', fromX, fromY, toX, toY }
    }
    case 'computer_scroll':
      return {
        action: 'scroll',
        x: num('x'),
        y: num('y'),
        deltaX: num('delta_x'),
        deltaY: num('delta_y') ?? -3,
      }
    case 'computer_type': {
      const text = str('text')
      if (!text) return { error: 'computer_type needs text.' }
      return { action: 'type', text: text.slice(0, AGENT_ACTION_LIMITS.computerTypeMaxChars) }
    }
    case 'computer_key': {
      const key = str('key').trim()
      if (!key) return { error: 'computer_key needs a key, e.g. Enter or Control+s.' }
      return { action: 'key', key }
    }
    case 'computer_wait': {
      // 上下界都要收：只钳上限的话负数会原样下发，虽然 setTimeout(-n) 会立刻触发，
      // 但工具描述承诺的是「default / max」，返回值就该与之一致
      const requested = num('duration_ms') ?? AGENT_ACTION_LIMITS.computerWaitDefaultMs
      return {
        action: 'wait',
        durationMs: Math.min(Math.max(0, requested), AGENT_ACTION_LIMITS.computerWaitMaxMs),
      }
    }
    case 'computer_app': {
      if (str('action', 'list') !== 'open') return { action: 'list_apps' }
      const appName = str('name').trim()
      if (!appName) return { error: 'computer_app with action=open needs a name.' }
      return { action: 'open_application', name: appName }
    }
    case 'computer_clipboard': {
      if (str('action', 'read') !== 'write') return { action: 'read_clipboard' }
      const text = str('text')
      if (!text) return { error: 'computer_clipboard with action=write needs text.' }
      return { action: 'write_clipboard', text: text.slice(0, AGENT_ACTION_LIMITS.clipboardMaxChars) }
    }
    default:
      return { error: `Unknown computer tool "${name}".` }
  }
}

const COMPUTER_TOOL_NAMES = new Set(computerTools.map((t) => t.name))

export function isComputerTool(name: string): boolean {
  return COMPUTER_TOOL_NAMES.has(name)
}

/**
 * 执行一个 computer_* 工具；未命中返回 null，由 tool-registry 落到 mcp__ / unknown 分支。
 * 错误按本仓约定回 `Error: ...` 字符串而不是 reject。
 */
export async function executeComputerTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
): Promise<string | null> {
  if (!isComputerTool(name)) return null
  const built = toAction(name, args ?? {})
  if ('error' in built) return `Error: ${built.error}`

  let result: ComputerActionResult
  try {
    result = (await ipc.computerUseCommand(built, ctx?.sessionLabel)) as ComputerActionResult
  } catch (e) {
    return `Error: computer command failed - ${e instanceof Error ? e.message : String(e)}`
  }

  if (!result || typeof result.ok !== 'boolean') {
    return 'Error: malformed computer command result from the main process.'
  }
  if (!result.ok) {
    return `Error: [${result.error?.code ?? 'execution_error'}] ${result.error?.message ?? 'Computer command failed.'}`
  }

  const sections: string[] = []
  if (result.apps) sections.push(renderApps(result.apps))
  if (result.value !== undefined) {
    const text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2) ?? String(result.value)
    if (text) sections.push(text)
  }
  const screen = renderScreen(result)
  if (screen) sections.push(screen)
  const shot = attachScreenshot(result, ctx)
  if (shot) sections.push(shot.trim())
  if (sections.length === 0) sections.push('OK')
  return sections.join('\n\n')
}
