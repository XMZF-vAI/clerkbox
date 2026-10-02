/**
 * Browser Use 工具族
 *
 * 九个工具，刻意保持扁平而不是「一个 action 参数的万能工具」：
 * 扁平 schema 让每个动作的参数约束直接写在 JSON Schema 里，模型的参数错误率明显更低，
 * 也和本仓既有的 read_file / web_search 风格一致。代价是工具列表长一点，
 * 由 P4-3 的能力开关兜住（关闭时这九个定义根本不进请求）。
 *
 * 执行链路：args → BrowserCommand → ipc.agentBrowserCommand → 主进程 CDP → BrowserCommandResult。
 * 结果按契约渲染成给模型看的**文字**；截图走 ToolContext.recordImage 旁路（见 tool-registry），
 * 不塞进返回值里 —— 那个通道的契约是 Promise<string>。
 */
import { ipc } from './ipc-client'
import { AGENT_ACTION_LIMITS, type BrowserCommand, type BrowserCommandResult, type BrowserSnapshot } from './agent-actions'
import type { ToolDefinition } from '../types/agent'
import type { ToolContext } from './tool-registry'

// ── Tool definitions ──

/** 共用的前置说明：坐标与 ref 两条硬约定。写进每条描述，模型就不必回读文档 */
const CONVENTION = [
  'Conventions:',
  '- Element refs (e1, e2, ...) come from browser_snapshot and are REASSIGNED on every snapshot. After any navigation or click, take a new snapshot before using refs again.',
  '- Coordinates are absolute integer pixels in the CURRENT viewport of the page shown in the Agent browser panel. Never use window or display bounds.',
].join('\n')

/** 观测一律附上页面状态，模型才知道自己在哪一屏 */
const OBSERVE_NOTE = 'Returns the current URL, title and scroll position together with the result.'

const browserTools: ToolDefinition[] = [
  {
    name: 'browser_navigate',
    description:
      'Navigate the built-in Agent browser to an absolute http(s) URL, or go back / forward / reload in its history.\n' +
      'Usage:\n' +
      "- The Agent browser is a dedicated tab in the right-hand workbench panel. Its cookies and logins are separate from your own browser panel.\n" +
      '- Only http and https are allowed.\n' +
      `- ${OBSERVE_NOTE}\n` +
      CONVENTION,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL including the scheme, e.g. https://example.com/docs. Required for action=navigate.' },
        action: {
          type: 'string',
          enum: ['navigate', 'back', 'forward', 'reload'],
          description: 'What to do. Defaults to navigate.',
        },
      },
      required: [],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Read the current page as a semantic tree of interactive elements, each with a ref you can click or type into.\n' +
      'Usage:\n' +
      '- Call this after every navigation and after every click, before the next action. Refs go stale immediately.\n' +
      `- Returns at most ${AGENT_ACTION_LIMITS.snapshotMaxElements} elements. A very large page is truncated; narrow it with browser_evaluate if you need something deeper.\n` +
      `- ${OBSERVE_NOTE}`,
    parameters: {
      type: 'object',
      properties: {
        max_elements: { type: 'number', description: `Cap on returned elements (default and max ${AGENT_ACTION_LIMITS.snapshotMaxElements}).` },
        include_hidden: { type: 'boolean', description: 'Include elements that are visually hidden. Default false.' },
      },
      required: [],
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an element in the Agent browser, by ref from browser_snapshot or by viewport pixel coordinates.\n' +
      'Usage:\n' +
      '- Prefer a ref: it survives layout changes that break raw coordinates.\n' +
      '- Only use x/y when the target is not in the snapshot (e.g. a canvas), and then only with the coordinates of the CURRENT viewport.\n' +
      `- ${OBSERVE_NOTE}\n` +
      CONVENTION,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest snapshot, e.g. e12.' },
        x: { type: 'number', description: 'Viewport X in pixels. Use with y when there is no ref.' },
        y: { type: 'number', description: 'Viewport Y in pixels. Use with x when there is no ref.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default left.' },
        click_count: { type: 'number', description: '2 for a double click. Default 1.' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] },
          description: 'Held modifier keys.',
        },
      },
      required: [],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into the focused element, or into a ref directly (the element is focused and scrolled into view first).\n' +
      'Usage:\n' +
      '- Pass ref to target an element; omit it to type wherever focus already is.\n' +
      '- Set clear=true to empty a field before typing — use it when replacing a search query instead of appending to it.\n' +
      `- ${OBSERVE_NOTE}\n` +
      CONVENTION,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type. Long text is typed as a single insertion.' },
        ref: { type: 'string', description: 'Element ref to focus first. Omit to use the current focus.' },
        clear: { type: 'boolean', description: 'Empty the field before typing. Default false.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_press',
    description:
      'Press a key or a key combination, optionally focusing a ref first.\n' +
      'Usage:\n' +
      '- Use this for Enter / Tab / Escape / arrows and for shortcuts such as Control+a or Control+Enter.\n' +
      '- Key names are case-insensitive: enter, return, esc, arrowdown, pageup all work.\n' +
      `- ${OBSERVE_NOTE}\n` +
      CONVENTION,
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or combination with "+", e.g. Enter, Escape, Control+a, ArrowDown, F5.' },
        ref: { type: 'string', description: 'Element ref to focus before pressing. Omit to use the current focus.' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] },
          description: 'Extra held modifiers. Usually you can just write them into key instead.',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description:
      'Scroll the page with the mouse wheel, or scroll a specific element into view.\n' +
      'Usage:\n' +
      '- Positive delta_y scrolls down, negative scrolls up.\n' +
      '- With a ref, the element is scrolled into view and delta_y is ignored.\n' +
      `- ${OBSERVE_NOTE}\n` +
      CONVENTION,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref to scroll into view.' },
        x: { type: 'number', description: 'Viewport X of the wheel position. Default 0.' },
        y: { type: 'number', description: 'Viewport Y of the wheel position. Default 0.' },
        delta_y: { type: 'number', description: 'Wheel delta in pixels. Default 400 (about half a screen down).' },
      },
      required: [],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the Agent browser as an image and return it to you. Use this when layout or visual state matters and the semantic tree is not enough.\n' +
      'Usage:\n' +
      '- The image is attached to this tool result; you see it directly, you do not get a file path to read.\n' +
      '- Coordinates you send to browser_click must refer to the viewport, not to this image unless the image is the full page.\n' +
      '- Take a fresh screenshot after anything changes the page — an old image is worse than none.',
    parameters: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: 'Capture the whole scrollable page instead of just the viewport. Default false.' },
      },
      required: [],
    },
  },
  {
    name: 'browser_evaluate',
    description:
      'Run a JavaScript expression in the page and return its value as JSON.\n' +
      'Usage:\n' +
      '- Use this to read data the semantic tree does not expose (a JSON blob in the page, computed values, a hidden field).\n' +
      '- Also use it to add a small wait before a click, e.g. a function returning a promise that resolves after 300ms.\n' +
      '- Prefer browser_snapshot and the dedicated tools for ordinary interaction: evaluate cannot click a real element for you.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression or async IIFE evaluated in the page.' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_wait',
    description:
      'Wait for a CSS selector to appear, or just pause.\n' +
      'Usage:\n' +
      '- Use after clicking something that loads asynchronously instead of retrying blindly.\n' +
      '- With no selector this is a plain pause.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for, e.g. ".results .item".' },
        timeout_ms: { type: 'number', description: `How long to wait, up to ${AGENT_ACTION_LIMITS.pageLoadTimeoutMs}ms. Default ${AGENT_ACTION_LIMITS.settleTimeoutMs}ms.` },
      },
      required: [],
    },
  },
]

export const BROWSER_TOOLS: ToolDefinition[] = browserTools

// ── 结果渲染 ──

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated at ${max} chars; narrow the request or use browser_evaluate)` : text
}

/**
 * 页面状态块。**每个动作都会附一份**，所以这里只放模型真的用得上的字段。
 *
 * 刻意不输出 History 的 canGoBack / canGoForward：模型要回退直接 `browser_navigate action=back`，
 * 没有历史时主进程会明确报错（`No back history in the Agent browser`）—— 与其在每个动作后
 * 贴两行常量噪声，不如让需要时的失败自己说明。视口同理：坐标只在截图里才有意义，
 * 而截图自带尺寸。
 */
function renderState(result: BrowserCommandResult): string {
  const state = result.state
  if (!state) return ''
  const lines = [`URL: ${state.url}`, `Title: ${state.title || '(untitled)'}`]
  // 滚动位置保留：判断「有没有滚到底」「元素是否在视口内」时模型真的会用
  if (state.scrollY !== undefined) lines.push(`Scroll: ${state.scrollY}`)
  if (state.loading) lines.push('Page is still loading.')
  return lines.join('\n')
}

function renderSnapshot(snapshot: BrowserSnapshot): string {
  const head = `URL: ${snapshot.url}\nTitle: ${snapshot.title || '(untitled)'}\n\n${snapshot.tree}`
  const hint = snapshot.truncated
    ? '\n\n(Snapshot truncated. Use browser_evaluate to narrow the page before acting.)'
    : '\n\nUse these refs in browser_click / browser_type / browser_press. Re-run browser_snapshot after anything changes the page.'
  return truncate(head, AGENT_ACTION_LIMITS.snapshotMaxChars + 2000) + hint
}

/**
 * 截图落盘由**主进程**完成（见 electron/agent-image.ts 的 persistImageToTmp），
 * 这里只把磁盘引用转手上报给宿主。
 *
 * 渲染层不自己写文件是有原因的：`ipc.writeFile` 是文本通道，写 base64 会得到一个
 * 「长得像 data URL 的文本文件」，模型侧随即报 `invalid image content: unknown format`。
 * 少一次 `写文件 → 读回 → 再 base64` 的往返，字节也精确。
 */
function attachScreenshot(result: BrowserCommandResult, ctx: ToolContext | undefined): string {
  const ref = result.imageRef
  if (!ref || !ctx?.recordImage) return ''
  ctx.recordImage(ref)
  return `\n[Screenshot attached: ${ref.width}x${ref.height}, saved to ${ref.path}]`
}

// ── 执行 ──

function toCommand(name: string, args: Record<string, unknown>): BrowserCommand | { error: string } {
  const str = (key: string, fallback = ''): string => {
    const v = args[key]
    return v === undefined || v === null ? fallback : String(v)
  }
  const num = (key: string): number | undefined => {
    const v = args[key]
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const bool = (key: string): boolean | undefined => {
    const v = args[key]
    return v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined
  }
  const mods = (): BrowserCommand extends { modifiers?: infer M } ? M : never => {
    const v = args.modifiers
    return (Array.isArray(v) ? v : []).filter((m): m is string => typeof m === 'string') as never
  }

  switch (name) {
    case 'browser_navigate': {
      const action = str('action', 'navigate') || 'navigate'
      if (action === 'back') return { method: 'back' }
      if (action === 'forward') return { method: 'forward' }
      if (action === 'reload') return { method: 'reload' }
      const url = str('url').trim()
      if (!url) return { error: 'browser_navigate needs a url (or action=back/forward/reload).' }
      return { method: 'navigate', url }
    }
    case 'browser_snapshot':
      return { method: 'snapshot', maxElements: num('max_elements'), includeHidden: bool('include_hidden') }
    case 'browser_click': {
      const ref = str('ref').trim()
      const x = num('x')
      const y = num('y')
      const target = ref
        ? { type: 'ref' as const, ref }
        : x !== undefined && y !== undefined
          ? { type: 'coordinate' as const, x, y }
          : null
      if (!target) return { error: 'browser_click needs either a ref, or both x and y.' }
      return {
        method: 'click',
        target,
        button: (str('button', 'left') as BrowserCommand extends { button?: infer B } ? B : never) ?? 'left',
        clickCount: num('click_count') ?? 1,
        modifiers: mods(),
      }
    }
    case 'browser_type':
      return { method: 'type', text: str('text'), ref: str('ref').trim() || undefined, clear: bool('clear') }
    case 'browser_press':
      return { method: 'press', key: str('key'), ref: str('ref').trim() || undefined, modifiers: mods() }
    case 'browser_scroll':
      return { method: 'scroll', ref: str('ref').trim() || undefined, x: num('x'), y: num('y'), deltaY: num('delta_y') }
    case 'browser_screenshot':
      return { method: 'screenshot', fullPage: bool('full_page') }
    case 'browser_evaluate':
      return { method: 'evaluate', expression: str('expression') }
    case 'browser_wait':
      return { method: 'wait', selector: str('selector').trim() || undefined, timeoutMs: num('timeout_ms') }
    default:
      return { error: `Unknown browser tool "${name}".` }
  }
}

const BROWSER_TOOL_NAMES = new Set(browserTools.map((t) => t.name))

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOL_NAMES.has(name)
}

/**
 * 请渲染层打开 Agent 浏览器标签，然后等 guest 就绪。
 *
 * 两步的顺序是有意的：
 *   1. `ensurePanel` —— **只有 AI 真的调用了浏览器工具才会走到这里**，
 *      所以这个标签是「AI 正在操控浏览器」的视觉载体，不会因为用户打开能力开关就自己冒出来。
 *   2. 轮询 `agentBrowserReady` —— 打开标签只是第一步，React 渲染 + `<webview>` attach
 *      才是 guest 真正可用的时刻。第一条命令几乎总是比它更早到达。
 *
 * 只能用 ipc 面，不能 import workbench store：这份代码在渲染进程与主进程 agent-host
 * 里共用同一个 toolRegistry 单例，而主进程没有 zustand。
 */
async function waitForAgentBrowser(sessionId: string | undefined, timeoutMs = 12_000): Promise<boolean> {
  // 先让出一个微任务：ensurePanel 触发的状态更新要跑起来
  await new Promise((r) => setTimeout(r, 0))
  try {
    // 必须带上 sessionId：用户可能正在看另一个对话。开在当前视图就是跨会话弹出 ——
    // 面板凭空出现在无关对话里，而真正在跑任务的会话反而什么都没有。
    await ipc.agentBrowserEnsurePanel(sessionId)
  } catch {
    // handler 未注册（远端 / 旧版本主进程）时不再等：等下去也不会变
    return false
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await ipc.agentBrowserReady()) return true
    } catch {
      return false
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/**
 * 执行一个 browser_* 工具；未命中返回 null，由 tool-registry 落到 mcp__ / unknown 分支。
 * 错误按本仓约定回 `Error: ...` 字符串而不是 reject —— 工具层永不抛给循环。
 */
export async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
): Promise<string | null> {
  if (!isBrowserTool(name)) return null
  const built = toCommand(name, args ?? {})
  if ('error' in built) return `Error: ${built.error}`

  // 除纯导航/翻历史外的动作都要求 guest 在位；导航也要求，所以统一等一次
  if (!(await waitForAgentBrowser(ctx?.sessionId))) {
    return 'Error: [backend_unavailable] The Agent browser could not be started. Open the "Agent browser" tab in the workbench panel once, then retry this call.'
  }

  let result: BrowserCommandResult
  try {
    result = (await ipc.agentBrowserCommand(built)) as BrowserCommandResult
  } catch (e) {
    return `Error: browser command failed - ${e instanceof Error ? e.message : String(e)}`
  }

  if (!result || typeof result.ok !== 'boolean') {
    return 'Error: malformed browser command result from the main process.'
  }
  if (!result.ok) {
    return `Error: [${result.error?.code ?? 'execution_error'}] ${result.error?.message ?? 'Browser command failed.'}`
  }

  const sections: string[] = []
  if (result.snapshot) sections.push(renderSnapshot(result.snapshot))
  else if (result.value !== undefined) sections.push(String(result.value))
  const state = renderState(result)
  if (state) sections.push(state)
  const shot = attachScreenshot(result, ctx)
  if (shot) sections.push(shot.trim())
  if (sections.length === 0) sections.push('OK')
  return truncate(sections.join('\n\n'), AGENT_ACTION_LIMITS.snapshotMaxChars + 4000)
}
