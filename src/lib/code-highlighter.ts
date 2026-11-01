/**
 * 代码块语法高亮（shiki，按需加载 + 同步降级）。
 *
 * 为什么不直接上 streamdown：ClerkBox 的 Markdown 走「同步 HTML 字符串 + .markdown-body
 * CSS 类契约」这条路（见 lib/markdown.ts），而 streamdown 是 React 组件、自带一套 DOM
 * 结构与类名。换过去会连带打破三处既有契约：
 *   1. src/index.css 里 .markdown-body 下的全部排版规则（约 40 条）；
 *   2. tests/markdown.test.ts 的 XSS 注入向量回归（针对 renderMarkdown 的字符串输出）；
 *   3. vibe 模式（.md-vibe）对代码块/表格/引用块的白色系覆盖。
 * 因此这里只做**最值钱的那一项**：把代码块从「纯文本灰盒」升级成真正的高亮代码块，
 * 其余渲染规则与 CSS 契约原样保留。
 *
 * 加载策略（两级）：
 *   - 第一级「核心语言」：十几种最常见的语言，首次用到代码块时加载（约 0.7s）。
 *     加载完成前代码块退回纯文本 —— 与改造前完全一致，零视觉回归。
 *   - 第二级「扩展语言」：命中未加载的语言时按需补载该语言，之后即可高亮。
 *     补载是异步的，期间该代码块仍走纯文本，下次渲染时升级。
 *
 * 为什么要两级：80 种语言一次性加载要 3-4 秒（实测），不可接受；
 * 只加载核心又会让冷门语言永远没有高亮。两级兼顾首屏速度与覆盖面。
 *
 * 主题：走 shiki 的 CSS 变量双主题（--shiki-light / --shiki-dark），
 * 由 index.css 的 .dark 选择器切换，与 ClerkBox 既有的 class 暗色体系对齐，
 * 不引入第二套主题机制。
 */

import { escapeHtml } from './markdown'
import { loadCoreLangs, loadLang, loadThemes } from './shiki-langs'

/** 语言别名 → shiki 语言 id。未列出的语言走「按需补载」。 */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  golang: 'go',
  docker: 'dockerfile',
  text: 'text',
  txt: 'text',
  plaintext: 'text',
}

/**
 * 核心语言：首屏就带上，覆盖绝大多数对话里的代码块。
 * 实测 20 种语言加载约 0.7s，可以接受。
 */
export const CORE_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'json',
  'bash',
  'html',
  'css',
  'markdown',
  'yaml',
  'sql',
  'diff',
  'dockerfile',
  'go',
  'rust',
] as const

/** shiki 高亮器的最小形状：只用 codeToTokens，不依赖具体实现类 */
interface HighlighterLike {
  codeToTokens(
    code: string,
    options: {
      lang: string
      themes: { light: string; dark: string }
      defaultColor: false
    },
  ): { tokens: Array<Array<{ content: string; htmlStyle?: Record<string, string> }>> }
}

/** 主题 id：与 index.css 的 .dark 切换配套 */
const LIGHT_THEME = 'vitesse-light'
const DARK_THEME = 'vitesse-dark'

let highlighter: HighlighterLike | null = null
let loadingPromise: Promise<HighlighterLike | null> | null = null
/** 已加载的语言 id 集合 */
const loadedLangs = new Set<string>()
/** 已发起补载的语言 id（防重复请求） */
const pendingLangs = new Set<string>()

/**
 * 版本号小仓库：高亮器就绪 / 语言补载完成时 bump。
 * 渲染组件经 useSyncExternalStore 订阅该版本号触发重渲（无 setState）——
 * 这是「高亮器就绪后升级代码块」的唯一通道。此前 MarkdownContent 用
 * 「挂载时 setState 促成就绪后升级」的接法与发送期的渲染循环同时段出现被摘除
 * （见 MessageItem 的 MarkdownContent 注释）；外部 store 订阅不经过任何
 * setState，与流式渲染循环互不放大。
 */
let version = 0
const versionListeners = new Set<() => void>()

/** 高亮器版本号：就绪或补载语言成功后 +1（同步读，供 useSyncExternalStore） */
export function getHighlightVersion(): number {
  return version
}

/** 订阅版本号变化；返回退订函数 */
export function subscribeHighlightVersion(listener: () => void): () => void {
  versionListeners.add(listener)
  return () => {
    versionListeners.delete(listener)
  }
}

function bumpHighlightVersion(): void {
  version += 1
  for (const listener of versionListeners) listener()
}

/**
 * 把 markdown 代码围栏的语言标注规整成 shiki 语言 id。
 * 返回 null 表示「不认识这个语言」——调用方退回纯文本，不报错。
 */
export function resolveHighlightLang(rawLang: string): string | null {
  const cleaned = rawLang.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (!cleaned) return null
  return LANG_ALIASES[cleaned] ?? cleaned
}

/**
 * 加载核心语言的高亮器。幂等：并发调用共享同一个 Promise。
 * 失败时返回 null（代码块退回纯文本），不抛出、不影响聊天渲染。
 */
export function loadHighlighter(): Promise<HighlighterLike | null> {
  if (highlighter) return Promise.resolve(highlighter)
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    try {
      const [{ createHighlighterCoreSync }, { createJavaScriptRegexEngine }, themes, langs] =
        await Promise.all([
          import('shiki/core'),
          import('shiki/engine/javascript'),
          loadThemes(),
          loadCoreLangs(CORE_LANGS),
        ])
      highlighter = createHighlighterCoreSync({
        themes: themes as never,
        langs: langs as never,
        // JS 正则引擎：比 oniguruma(wasm) 小得多，且够用
        engine: createJavaScriptRegexEngine(),
      }) as unknown as HighlighterLike
      for (const lang of CORE_LANGS) loadedLangs.add(lang)
      bumpHighlightVersion()
      return highlighter
    } catch (error) {
      console.warn('[code-highlighter] 高亮器加载失败，代码块退回纯文本', error)
      return null
    } finally {
      loadingPromise = null
    }
  })()
  return loadingPromise
}

/** 高亮器是否已就绪（同步查询，供渲染路径判断走哪条分支） */
export function isHighlighterReady(): boolean {
  return highlighter !== null
}

/**
 * 补载一个核心集之外的语言。
 *
 * 命中未加载的语言时调用：语言包按需 import 后用 shiki 的 loadLanguage 挂到既有
 * 高亮器上。补载是异步的，期间该代码块仍走纯文本（renderMarkdown 每次都重新判断）。
 */
export function loadExtraLang(lang: string): void {
  if (!highlighter || loadedLangs.has(lang) || pendingLangs.has(lang)) return
  pendingLangs.add(lang)
  void (async () => {
    try {
      const mod = await loadLang(lang)
      if (!mod) return
      const h = highlighter as HighlighterLike & {
        loadLanguage?: (lang: unknown) => void
      }
      h.loadLanguage?.(mod)
      loadedLangs.add(lang)
      // 补载完成：让挂载中的代码块从纯文本升级为高亮（经版本号订阅，无 setState）
      bumpHighlightVersion()
    } catch (error) {
      console.warn(`[code-highlighter] 语言 ${lang} 补载失败`, error)
    } finally {
      pendingLangs.delete(lang)
    }
  })()
}

/** 单测用：重置内部状态 */
export function resetHighlighterForTests(): void {
  highlighter = null
  loadingPromise = null
  loadedLangs.clear()
  pendingLangs.clear()
  version = 0
  versionListeners.clear()
}

/**
 * 把一段代码渲染成带 token 色的 HTML（双主题 CSS 变量）。
 *
 * 返回 null 表示「现在不能高亮」——调用方必须退回纯文本渲染。
 * 绝不返回未经转义的内容：token 的 content 来自 shiki，已按 HTML 实体转义
 * （实测 <script> → &#x3C;script&gt;），这里再做一次 escapeHtml 兜底。
 */
export function highlightCode(code: string, lang: string): string | null {
  if (!highlighter) return null
  const resolved = resolveHighlightLang(lang)
  if (!resolved) return null
  if (!loadedLangs.has(resolved)) {
    // 核心集之外的语言：发起补载，本次仍走纯文本
    loadExtraLang(resolved)
    return null
  }
  try {
    const { tokens } = highlighter.codeToTokens(code, {
      lang: resolved,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
    })
    const body = tokens
      .map((line) => {
        const inner = line
          .map((token) => {
            const text = escapeHtml(token.content)
            const style = token.htmlStyle
            if (!style) return text
            const cssText = Object.entries(style)
              .map(([key, value]) => `${key}:${value}`)
              .join(';')
            return `<span style="${cssText}">${text}</span>`
          })
          .join('')
        return `<span class="line">${inner}</span>`
      })
      .join('\n')
    return body
  } catch (error) {
    // 某种语言的语法高亮失败不该让整条消息渲染不出来
    console.warn('[code-highlighter] 高亮失败，退回纯文本', error)
    return null
  }
}
