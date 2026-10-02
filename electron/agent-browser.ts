/**
 * Agent 浏览器（Browser Use 执行器）
 *
 * 架构决定：**网页由渲染进程里的 `<webview>` guest 渲染，主进程用 CDP 驱动它。**
 * 没有用主进程 `WebContentsView`，原因是后者是原生子视图，永远盖在渲染 DOM 之上 ——
 * 会遮挡设置弹窗、命令面板、下拉菜单这类浮层（ZCode 为此专门在
 * UnifiedBrowserView.tsx 的文件头注释里记下了这个取舍）。DOM 内合成的 guest 没有这个问题。
 *
 * 由此带来的两个必须遵守的前提：
 *   1. guest 生命周期由渲染层持有。主进程只在 `did-attach-webview` 时捕获引用，
 *      之后所有命令都要先确认 guest 仍然存活，否则一律 `renderer_unreachable`。
 *   2. 渲染层折叠工作台面板时**不能卸载** Agent 浏览器组件，否则 guest 销毁、CDP 断链、
 *      正在进行的任务直接失败。这个约束由 src/components/workbench/AgentBrowserPanel.tsx 保证。
 *
 * 坐标与 ref 两条硬约定（见 src/lib/agent-actions.ts）：ref 每次快照重算、导航即失效；
 * 坐标一律是当前截图这张 raster 的绝对整数像素。
 */
import { webContents, type WebContents, type Debugger } from 'electron'
import { AGENT_ACTION_LIMITS } from '../src/lib/agent-actions'
import { fitImageToInlineBudget, persistImageToTmp } from './agent-image'
import type {
  AgentActionImage,
  BrowserCommand,
  BrowserCommandResult,
  BrowserErrorCode,
  BrowserKeyModifier,
  BrowserMouseButton,
  BrowserPageState,
  BrowserSnapshot,
  BrowserSnapshotElement,
} from '../src/lib/agent-actions'
import { pulseScreenAura } from './screen-aura'

/** Agent 浏览器 guest 使用的分区。与人类浏览器分区隔离，cookie / 登录态互不污染 */
export const AGENT_BROWSER_PARTITION = 'persist:clerkbox-agent-browser'

/** CDP 修饰键位掩码（与 Chrome DevTools Protocol 的 Modifiers 一致） */
const MODIFIER_BITS: Record<BrowserKeyModifier, number> = {
  Alt: 1,
  Control: 2,
  // ControlOrMeta：mac 上是 ⌘，其余平台是 Ctrl
  ControlOrMeta: process.platform === 'darwin' ? 4 : 2,
  Meta: 4,
  Shift: 8,
}

function modifierMask(modifiers: BrowserKeyModifier[] | undefined): number {
  if (!modifiers || modifiers.length === 0) return 0
  return modifiers.reduce((mask, m) => mask | (MODIFIER_BITS[m] ?? 0), 0)
}

/** 键名归一化：模型会送 Enter / enter / RETURN / Space 等各种写法 */
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  space: ' ',
  spacebar: ' ',
  tab: 'Tab',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  super: 'Meta',
  win: 'Meta',
  control: 'Control',
  ctrl: 'Control',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  plus: '+',
}

export function normalizeBrowserKey(key: string): string {
  const raw = String(key ?? '').trim()
  if (!raw) return ''
  if (raw.length === 1) return raw
  return KEY_ALIASES[raw.toLowerCase()] ?? raw
}

/** 组合键拆成 CDP 需要的 { key, code, keyCode, text } 形态 */
interface KeyDescriptor {
  key: string
  code: string
  keyCode: number
  text?: string
}

const NAMED_KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  Insert: 45,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ' ': 32,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
}

/** 单个可打印字符的 DOM code / keyCode。够用即可：CDP 主要按 key + text 派发 */
function printableKeyCode(char: string): number {
  if (/[a-z]/i.test(char)) return char.toUpperCase().charCodeAt(0)
  if (/[0-9]/.test(char)) return char.charCodeAt(0)
  return 0
}

function describeKey(key: string): KeyDescriptor {
  const normalized = normalizeBrowserKey(key)
  const named = NAMED_KEY_CODES[normalized]
  if (named !== undefined) {
    return { key: normalized, code: normalized.length === 1 ? normalized : normalized, keyCode: named }
  }
  return {
    key: normalized,
    code: normalized,
    keyCode: printableKeyCode(normalized),
    // 可打印字符要带 text，否则 keydown 之后的 keypress/input 事件不会产生字符
    ...(normalized.length === 1 && normalized !== '\n' ? { text: normalized } : {}),
  }
}

// ── 注入脚本：AI/ARIA 语义快照 + ref 表 ──

/**
 * 页面快照脚本（在页面上下文执行，产出 [treeText, elementRows]）。
 *
 * 刻意不引入 Playwright 的 injected script：为一个只读快照背上一个浏览器自动化运行时
 * 不划算，而 AI/ARIA 树真正需要的只是「角色 + 可访问名 + 层级 + 交互语义」。
 * ref 写进页面的 `__clerkboxRefs`，每次快照重建 —— 与 ZCode 的 `window.__zcodeRefs` 同策略。
 */
const SNAPSHOT_SCRIPT = `(() => {
  const MAX = __MAX__;
  const INCLUDE_HIDDEN = __HIDDEN__;
  const refs = new Map();
  let seq = 0;
  const rows = [];

  const IMPLICIT_ROLE = {
    a: 'link', button: 'button', input: 'textbox', textarea: 'textbox',
    select: 'combobox', option: 'option', img: 'img', h1: 'heading', h2: 'heading',
    h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', form: 'form',
    nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    table: 'table', tr: 'row', td: 'cell', th: 'columnheader', ul: 'list', ol: 'list',
    li: 'listitem', p: 'paragraph', label: 'label', summary: 'button', details: 'group',
  };
  const INPUT_ROLE = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', url: 'textbox', tel: 'textbox',
    password: 'textbox', submit: 'button', reset: 'button', button: 'button',
    file: 'button', submitButton: 'button',
  };

  const isHidden = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
    return false;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return INPUT_ROLE[type] || (el.type === 'submit' || el.type === 'button' ? 'button' : 'textbox');
    }
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    return IMPLICIT_ROLE[tag] || 'generic';
  };

  /** 可访问名：aria-label > aria-labelledby > 关联 label > 原生提示 > 可见文本 */
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\\s+/)
        .map((id) => (document.getElementById(id)?.textContent || '').trim())
        .filter(Boolean)
        .join(' ');
      if (text) return text;
    }
    if (el.labels && el.labels.length > 0) {
      const text = Array.from(el.labels).map((l) => (l.textContent || '').trim()).filter(Boolean).join(' ');
      if (text) return text;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const hint = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '';
      if (hint.trim()) return hint.trim();
      if (tag === 'input' && (el.type === 'submit' || el.type === 'button') && el.value) return String(el.value);
      return '';
    }
    if (tag === 'img') return (el.getAttribute('alt') || '').trim();
    if (tag === 'select' || tag === 'option') return (el.textContent || '').trim().slice(0, 120);
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent || '')
      .join(' ')
      .trim();
    return (own || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
  };

  const isInteractive = (el, role) => {
    if (['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'option', 'searchbox', 'slider', 'spinbutton', 'menuitem', 'tab', 'switch'].includes(role)) return true;
    if (el.isContentEditable) return true;
    if (el.tagName === 'SUMMARY' || el.tagName === 'DETAILS' || el.tagName === 'LABEL') return true;
    return el.hasAttribute('onclick') || typeof el.onclick === 'function';
  };

  const isSkipped = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'head') return true;
    if (['generic', 'presentation', 'none'].includes(el.getAttribute('role') || '')) return true;
    return false;
  };

  const lines = [];
  let truncated = false;

  const walk = (node, depth) => {
    if (truncated || depth > 40) return;
    const children = node.children || [];
    for (const el of children) {
      if (truncated) return;
      if (isSkipped(el)) continue;
      if (!INCLUDE_HIDDEN && isHidden(el)) continue;
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      let name = nameOf(el);
      // 只给「有意义的」节点建 ref：纯容器节点让模型无从下手，反而稀释快照
      if (interactive && (name || role !== 'generic')) {
        if (rows.length >= MAX) { truncated = true; return; }
        const ref = 'e' + (++seq);
        refs.set(ref, el);
        const rect = el.getBoundingClientRect();
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
        rows.push({
          ref, tag: el.tagName.toLowerCase(), role, name,
          value: (el.value !== undefined && typeof el.value === 'string' && el.value !== '') ? String(el.value).slice(0, 200) : undefined,
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || undefined,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          inViewport,
        });
        lines.push('  '.repeat(depth) + '- ' + role + (name ? ' "' + name + '"' : '') + ' [' + ref + ']');
      } else if (name && (role === 'heading' || role === 'paragraph' || role === 'listitem')) {
        if (name.length > 160) name = name.slice(0, 160) + '…';
        lines.push('  '.repeat(depth) + '- ' + role + ': ' + name);
      }
      walk(el, depth + 1);
    }
  };

  const root = document.body;
  if (root) walk(root, 0);

  const title = (document.querySelector('h1')?.textContent || document.title || '').trim().slice(0, 200);
  const tree = (title ? 'Page: ' + title + '\\n' : '') + (lines.join('\\n') || '(no interactive elements found)');
  window.__clerkboxRefs = refs;
  return { tree, elements: rows, truncated, url: location.href, title: document.title };
})()`

/** ref → 元素中心点（滚动进视口后取），并把元素标记出来让模型确认点对了 */
const RESOLVE_REF_SCRIPT = `(() => {
  const el = window.__clerkboxRefs && window.__clerkboxRefs.get(__REF__);
  if (!el) return null;
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    w: Math.round(r.width),
    h: Math.round(r.height),
    tag: el.tagName.toLowerCase(),
    inViewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
  };
})()`

/** ref → 聚焦并清空（type 工具用），避免模型重复输入时叠加旧值 */
const FOCUS_REF_SCRIPT = `(() => {
  const el = window.__clerkboxRefs && window.__clerkboxRefs.get(__REF__);
  if (!el) return null;
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  return true;
})()`

const CLEAR_REF_SCRIPT = `(() => {
  const el = window.__clerkboxRefs && window.__clerkboxRefs.get(__REF__);
  if (!el) return null;
  if (typeof el.value === 'string') {
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
})()`

const PAGE_STATE_SCRIPT = `(() => ({
  url: location.href,
  title: document.title,
  scrollX: Math.round(window.scrollX),
  scrollY: Math.round(window.scrollY),
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
}))()`

// ── 执行器 ──

interface AgentBrowserSession {
  webContentsId: number
  debugger: Debugger
  /** 每次 guest 重挂载自增，UI 靠它识别 stale 事件 */
  generation: number
  attachedAt: number
}

let session: AgentBrowserSession | null = null

/** 命令执行结果 → 事件通知（点亮标签呼吸图标）。主进程不持有渲染层状态，只发事件 */
type OperationListener = (event: { tabId: string; generation: number }) => void
let operationListener: OperationListener | null = null

export function setAgentBrowserOperationListener(listener: OperationListener | null): void {
  operationListener = listener
}

function currentUrlOf(guest: WebContents): string {
  try {
    return guest.getURL()
  } catch {
    return ''
  }
}

/**
 * 捕获 Agent 浏览器 guest。主进程在 `did-attach-webview` 时调用；
 * 分区不匹配的 guest（人类浏览器）直接忽略。
 */
export function attachAgentBrowserGuest(guest: WebContents): void {
  // 同一个 guest 重复 attach 时不重挂 debugger：CDP 只能 attach 一次，重来会抛
  if (session && session.webContentsId === guest.id) return
  detachAgentBrowserGuest()
  try {
    guest.debugger.attach('1.3')
  } catch (err) {
    console.error('[agent-browser] attach debugger failed:', err)
    return
  }
  session = { webContentsId: guest.id, debugger: guest.debugger, generation: 0, attachedAt: Date.now() }
  // guest 销毁（标签被关 / 渲染进程崩溃）后主动作废会话。
  // 少了这一句，session 会一直指着一个死 webContents：agentBrowserReady() 恒为 false，
  // 桥接组件因此判成「还没就绪」而永不重开标签，下一条命令只拿到 renderer_unreachable。
  guest.once('destroyed', () => invalidateAgentBrowserGuest(guest.id))
  console.log('[agent-browser] guest attached, id =', guest.id)
}

export function detachAgentBrowserGuest(): void {
  if (!session) return
  const target = webContents.fromId(session.webContentsId)
  try {
    if (target && !target.isDestroyed() && target.debugger.isAttached()) target.debugger.detach()
  } catch {
    // guest 已经没了是正常路径（标签被关闭），detach 失败无需上抛
  }
  session = null
}

/** guest 崩溃/销毁后主动作废会话，避免后续命令打在一个死 webContents 上 */
export function invalidateAgentBrowserGuest(webContentsId: number): void {
  if (session && session.webContentsId === webContentsId) {
    session = null
    console.log('[agent-browser] guest gone, session invalidated')
  }
}

export function isAgentBrowserReady(): boolean {
  const active = session
  if (!active) return false
  const target = webContents.fromId(active.webContentsId)
  return !!target && !target.isDestroyed()
}

function requireSession(): { active: AgentBrowserSession; guest: WebContents } {
  const active = session
  if (!active) {
    const err: AgentBrowserFailure = {
      code: 'backend_unavailable',
      message: 'Agent browser is not running. Enable "Browser use" in Settings, then open the Agent browser panel once.',
    }
    throw err
  }
  const guest = webContents.fromId(active.webContentsId)
  if (!guest || guest.isDestroyed()) {
    session = null
    const err: AgentBrowserFailure = {
      code: 'renderer_unreachable',
      message: 'Agent browser page is gone. Reopen the Agent browser panel and try again.',
    }
    throw err
  }
  return { active, guest }
}

interface AgentBrowserFailure {
  code: BrowserErrorCode
  message: string
}

function isFailure(err: unknown): err is AgentBrowserFailure {
  return !!err && typeof err === 'object' && typeof (err as AgentBrowserFailure).code === 'string'
}

/** CDP 调用统一超时兜底：没有超时的 CDP 调用在页面卡死时会永久挂住整轮 ReAct */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentBrowserTimeout(message)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

class AgentBrowserTimeout {
  readonly code: BrowserErrorCode = 'timeout'
  constructor(readonly message: string) {}
}

async function cdp<T = unknown>(active: AgentBrowserSession, method: string, params?: Record<string, unknown>): Promise<T> {
  return withTimeout(
    active.debugger.sendCommand(method as never, params as never) as Promise<T>,
    AGENT_ACTION_LIMITS.commandTimeoutMs,
    `CDP ${method} timed out after ${AGENT_ACTION_LIMITS.commandTimeoutMs}ms`,
  )
}

async function evaluate<T>(active: AgentBrowserSession, expression: string): Promise<T> {
  const res = await cdp<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    active,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
  )
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'page script threw'
    throw new AgentBrowserExecutionError(String(detail).split('\n')[0])
  }
  return res.result?.value as T
}

class AgentBrowserExecutionError {
  readonly code: BrowserErrorCode = 'execution_error'
  constructor(readonly message: string) {}
}

async function waitForLoad(active: AgentBrowserSession, guest: WebContents, timeoutMs: number): Promise<void> {
  if (!guest.isLoading()) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      guest.removeListener('did-stop-loading', onDone)
      guest.removeListener('did-fail-load', onDone)
      resolve()
    }, timeoutMs)
    const onDone = () => {
      clearTimeout(timer)
      resolve()
    }
    guest.once('did-stop-loading', onDone)
    guest.once('did-fail-load', onDone)
  })
}

/** 导航后等 DOM 落定一小会儿：load 事件触发时页面往往还没渲染完，立刻截图会拍到骨架屏 */
async function settle(active: AgentBrowserSession, guest: WebContents): Promise<void> {
  await waitForLoad(active, guest, AGENT_ACTION_LIMITS.pageLoadTimeoutMs)
  await evaluate(active, `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))`)
    .catch(() => undefined)
}

async function readPageState(active: AgentBrowserSession, guest: WebContents): Promise<BrowserPageState> {
  const fallback = {
    url: currentUrlOf(guest),
    title: '',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  }
  const detail = await evaluate<Partial<BrowserPageState>>(active, PAGE_STATE_SCRIPT).catch(() => null)
  if (!detail) return fallback
  return {
    url: String(detail.url ?? fallback.url).slice(0, AGENT_ACTION_LIMITS.pageStateMaxChars * 4),
    title: String(detail.title ?? '').slice(0, AGENT_ACTION_LIMITS.pageStateMaxChars),
    canGoBack: guest.navigationHistory.canGoBack(),
    canGoForward: guest.navigationHistory.canGoForward(),
    loading: guest.isLoading(),
    scrollX: detail.scrollX,
    scrollY: detail.scrollY,
    viewportWidth: detail.viewportWidth,
    viewportHeight: detail.viewportHeight,
  }
}

async function resolveTargetPoint(
  active: AgentBrowserSession,
  target: { ref?: string; x?: number; y?: number },
): Promise<{ x: number; y: number }> {
  if (target.ref) {
    const hit = await evaluate<{ x: number; y: number } | null>(
      active,
      RESOLVE_REF_SCRIPT.replace('__REF__', JSON.stringify(target.ref)),
    )
    if (!hit) {
      throw {
        code: 'ref_not_found',
        message: `Element ref "${target.ref}" no longer exists. Take a new snapshot to get fresh refs — they are reassigned on every snapshot and invalidated by navigation.`,
      } satisfies AgentBrowserFailure
    }
    return { x: hit.x, y: hit.y }
  }
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    return { x: Math.round(target.x), y: Math.round(target.y) }
  }
  throw { code: 'execution_error', message: 'Click needs either a ref from snapshot, or x and y coordinates.' } satisfies AgentBrowserFailure
}

async function dispatchClick(
  active: AgentBrowserSession,
  point: { x: number; y: number },
  button: BrowserMouseButton,
  clickCount: number,
  modifiers: number,
): Promise<void> {
  const base = { x: point.x, y: point.y, button, ...(modifiers > 0 ? { modifiers } : {}) }
  await cdp(active, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...base })
  await cdp(active, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount })
  await cdp(active, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount })
}

async function dispatchKeySequence(
  active: AgentBrowserSession,
  parts: string[],
  modifiers: number,
): Promise<void> {
  const descriptors = parts.map(describeKey)
  const held = descriptors.slice(0, -1)
  const final = descriptors[descriptors.length - 1]!
  const modSum = modifiers + maskOfKeys(held)
  const extra = modSum > 0 ? { modifiers: modSum } : {}

  for (const k of held) {
    await cdp(active, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, ...extra })
  }
  await cdp(active, 'Input.dispatchKeyEvent', {
    type: final.text ? 'keyDown' : 'rawKeyDown',
    key: final.key,
    code: final.code,
    windowsVirtualKeyCode: final.keyCode,
    ...(final.text ? { text: final.text } : {}),
    ...extra,
  })
  await cdp(active, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: final.key,
    code: final.code,
    windowsVirtualKeyCode: final.keyCode,
    ...extra,
  })
  for (const k of [...held].reverse()) {
    await cdp(active, 'Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, ...extra })
  }
}

function maskOfKeys(keys: KeyDescriptor[]): number {
  let mask = 0
  for (const k of keys) {
    if (k.key === 'Shift') mask |= MODIFIER_BITS.Shift
    if (k.key === 'Control') mask |= MODIFIER_BITS.Control
    if (k.key === 'Alt') mask |= MODIFIER_BITS.Alt
    if (k.key === 'Meta') mask |= MODIFIER_BITS.Meta
  }
  return mask
}

async function captureScreenshot(active: AgentBrowserSession, fullPage: boolean): Promise<AgentActionImage> {
  // 普通视口截图优先走 host 合成：它拿的是用户真正看到的那一帧（含滚动位置与合成状态），
  // CDP 截图在 guest 后台（面板折叠）时可能与实际不符。fullPage 才需要 captureBeyondViewport。
  if (!fullPage) {
    const nativeImage = await withTimeout(
      captureViaHost(active),
      AGENT_ACTION_LIMITS.commandTimeoutMs,
      'capturePage timed out',
    ).catch(() => null)
    if (nativeImage && !nativeImage.isEmpty()) {
      const { width, height } = nativeImage.getSize()
      return { dataUrl: nativeImage.toDataURL(), mimeType: 'image/png', width, height }
    }
  }
  const shot = await cdp<{ data: string }>(active, 'Page.captureScreenshot', {
    format: 'png',
    ...(fullPage ? { captureBeyondViewport: true, optimizeForSpeed: false } : {}),
  })
  const size = await evaluate<{ w: number; h: number }>(
    active,
    '({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })',
  ).catch(() => null)
  return {
    dataUrl: `data:image/png;base64,${shot.data}`,
    mimeType: 'image/png',
    width: size?.w ?? 0,
    height: size?.h ?? 0,
  }
}

async function captureViaHost(active: AgentBrowserSession) {
  const guest = webContents.fromId(active.webContentsId)
  if (!guest || guest.isDestroyed()) throw new Error('guest gone')
  return guest.capturePage()
}

// ── 命令分发 ──

async function executeCommand(active: AgentBrowserSession, guest: WebContents, command: BrowserCommand): Promise<Partial<BrowserCommandResult>> {
  switch (command.method) {
    case 'navigate': {
      const raw = String(command.url ?? '').trim()
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        throw { code: 'execution_error', message: `"${raw}" is not a valid absolute URL. Include the scheme, e.g. https://example.com` } satisfies AgentBrowserFailure
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw { code: 'navigation_blocked', message: `Only http and https URLs are allowed in the Agent browser (got ${parsed.protocol}).` } satisfies AgentBrowserFailure
      }
      await guest.loadURL(parsed.toString())
      await settle(active, guest)
      return { state: await readPageState(active, guest) }
    }
    case 'back':
    case 'forward': {
      const can = command.method === 'back' ? guest.navigationHistory.canGoBack() : guest.navigationHistory.canGoForward()
      if (!can) {
        throw {
          code: 'execution_error',
          message: `No ${command.method} history in the Agent browser.`,
        } satisfies AgentBrowserFailure
      }
      if (command.method === 'back') guest.navigationHistory.goBack()
      else guest.navigationHistory.goForward()
      await settle(active, guest)
      return { state: await readPageState(active, guest) }
    }
    case 'reload': {
      guest.reload()
      await settle(active, guest)
      return { state: await readPageState(active, guest) }
    }
    case 'snapshot': {
      const maxElements = Math.min(command.maxElements ?? AGENT_ACTION_LIMITS.snapshotMaxElements, AGENT_ACTION_LIMITS.snapshotMaxElements)
      const raw = await evaluate<{ tree: string; elements: BrowserSnapshotElement[]; truncated: boolean; url: string; title: string }>(
        active,
        SNAPSHOT_SCRIPT
          .replace('__MAX__', String(maxElements))
          .replace('__HIDDEN__', command.includeHidden ? 'true' : 'false'),
      )
      const tree = raw.tree.length > AGENT_ACTION_LIMITS.snapshotMaxChars
        ? raw.tree.slice(0, AGENT_ACTION_LIMITS.snapshotMaxChars) + '\n… (snapshot truncated)'
        : raw.tree
      const snapshot: BrowserSnapshot = {
        url: raw.url,
        title: raw.title,
        tree,
        elements: raw.elements,
        truncated: raw.truncated,
      }
      return { state: await readPageState(active, guest), snapshot }
    }
    case 'click': {
      const point = await resolveTargetPoint(active, command.target.type === 'ref' ? { ref: command.target.ref } : { x: command.target.x, y: command.target.y })
      await dispatchClick(active, point, command.button ?? 'left', command.clickCount ?? 1, modifierMask(command.modifiers))
      await settle(active, guest)
      return { state: await readPageState(active, guest) }
    }
    case 'type': {
      const text = String(command.text ?? '')
      if (command.ref) {
        await evaluate(active, FOCUS_REF_SCRIPT.replace('__REF__', JSON.stringify(command.ref))).catch((err) => {
          if (isFailure(err)) throw err
          throw { code: 'ref_not_found', message: `Element ref "${command.ref}" no longer exists. Take a new snapshot to get fresh refs.` } satisfies AgentBrowserFailure
        })
        if (command.clear) await evaluate(active, CLEAR_REF_SCRIPT.replace('__REF__', JSON.stringify(command.ref)))
      }
      if (text) await cdp(active, 'Input.insertText', { text })
      await settle(active, guest)
      return { state: await readPageState(active, guest) }
    }
    case 'press': {
      if (command.ref) {
        await evaluate(active, FOCUS_REF_SCRIPT.replace('__REF__', JSON.stringify(command.ref))).catch(() => {
          throw { code: 'ref_not_found', message: `Element ref "${command.ref}" no longer exists. Take a new snapshot to get fresh refs.` } satisfies AgentBrowserFailure
        })
      }
      const parts = String(command.key ?? '').split('+').map((p) => normalizeBrowserKey(p)).filter(Boolean)
      if (parts.length === 0) throw { code: 'execution_error', message: 'Key is empty.' } satisfies AgentBrowserFailure
      await dispatchKeySequence(active, parts, modifierMask(command.modifiers))
      await settle(active, guest)
      return { state: await readPageState(active, guest) }
    }
    case 'scroll': {
      const anchor = await resolveTargetPoint(active, command.ref ? { ref: command.ref } : { x: command.x ?? 0, y: command.y ?? 0 }).catch(() => ({ x: 0, y: 0 }))
      const deltaY = command.deltaY ?? 400
      await cdp(active, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: anchor.x, y: anchor.y, deltaX: 0, deltaY })
      await settle(active, guest)
      return { state: await readPageState(active, guest) }
    }
    case 'screenshot': {
      const raw = await captureScreenshot(active, command.fullPage === true)
      // 压不进内联预算就只回页面状态：一张巨图对模型是负担而不是信息
      const image = fitImageToInlineBudget(raw)
      const state = await readPageState(active, guest)
      if (!image) return { state, value: 'Screenshot was too large to send inline; the page state is still current.' }
      // 落盘在这里做：渲染层的 writeFile 是文本通道，写 base64 会得到假图片
      const imageRef = persistImageToTmp(image, 'browser-shot')
      return imageRef
        ? { state, imageRef }
        : { state, value: 'Screenshot was captured but could not be saved to disk; the page state is still current.' }
    }
    case 'evaluate': {
      const expression = String(command.expression ?? '').trim()
      if (!expression) throw { code: 'execution_error', message: 'Expression is empty.' } satisfies AgentBrowserFailure
      const value = await evaluate<unknown>(active, expression)
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)
      return {
        value,
        state: await readPageState(active, guest),
        ...(text.length > AGENT_ACTION_LIMITS.evaluateMaxChars
          ? { value: text.slice(0, AGENT_ACTION_LIMITS.evaluateMaxChars) + '… (truncated)' }
          : {}),
      }
    }
    case 'wait': {
      const timeoutMs = Math.min(command.timeoutMs ?? AGENT_ACTION_LIMITS.settleTimeoutMs, AGENT_ACTION_LIMITS.pageLoadTimeoutMs)
      if (command.selector) {
        const appeared = await evaluate<boolean>(active, `(() => {
          const deadline = Date.now() + ${timeoutMs};
          return new Promise((resolve) => {
            const tick = () => {
              if (document.querySelector(${JSON.stringify(command.selector)})) return resolve(true);
              if (Date.now() > deadline) return resolve(false);
              setTimeout(tick, 100);
            };
            tick();
          });
        })()`)
        if (!appeared) {
          throw {
            code: 'timeout',
            message: `Selector "${command.selector}" did not appear within ${timeoutMs}ms.`,
          } satisfies AgentBrowserFailure
        }
      } else {
        await new Promise((r) => setTimeout(r, Math.min(timeoutMs, AGENT_ACTION_LIMITS.commandTimeoutMs)))
      }
      return { state: await readPageState(active, guest) }
    }
    default: {
      // 判别联合已穷尽；这里只兜住运行期收到未知 method 的情况
      const never = command as { method: string }
      throw { code: 'capability_unsupported', message: `Unknown browser command "${never.method}".` } satisfies AgentBrowserFailure
    }
  }
}

/** 工具层唯一入口：执行一条浏览器命令，回一份同构观测结果。永不 reject。 */
export async function runAgentBrowserCommand(command: BrowserCommand): Promise<BrowserCommandResult> {
  const startedAt = Date.now()
  let active: AgentBrowserSession | null = null
  try {
    const required = requireSession()
    active = required.active
    const partial = await executeCommand(active, required.guest, command)
    operationListener?.({ tabId: String(active.webContentsId), generation: active.generation })
    // 屏幕边框光晕：与电脑操控共用同一个信号。用户在别的应用上时，Agent 浏览器
    // 面板根本不在视野里，光晕是唯一还能被余光捕捉到的「AI 正在动手」提示。
    // 滑窗自动收：浏览任务的两次命令之间可能隔着截图与推理，不能一直亮着。
    pulseScreenAura()
    return {
      ok: true,
      ...partial,
      meta: { browserUse: true, tabId: String(active.webContentsId), generation: active.generation, currentUrl: partial.state?.url },
      elapsedMs: Date.now() - startedAt,
    }
  } catch (err) {
    const failure: AgentBrowserFailure = isFailure(err)
      ? err
      : err instanceof AgentBrowserTimeout || (err as { code?: string })?.code === 'timeout'
        ? { code: 'timeout', message: (err as Error).message || 'Browser command timed out.' }
        : { code: 'execution_error', message: err instanceof Error ? err.message : String(err) }
    return {
      ok: false,
      error: { code: failure.code, message: failure.message },
      ...(active ? { meta: { browserUse: true, tabId: String(active.webContentsId), generation: active.generation } } : {}),
      elapsedMs: Date.now() - startedAt,
    }
  }
}
