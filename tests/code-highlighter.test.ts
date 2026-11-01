/**
 * 代码块语法高亮器的测试。
 *
 * 守三件事：
 *  1. 高亮器未就绪 / 语言不认识时，代码块退回纯文本（零视觉回归）；
 *  2. 高亮路径同样不破坏 XSS 边界 —— 代码内容里的伪 HTML 必须被转义；
 *  3. 双主题输出走 CSS 变量（--shiki-light / --shiki-dark），由 .dark 切换。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CORE_LANGS,
  getHighlightVersion,
  highlightCode,
  isHighlighterReady,
  loadHighlighter,
  resetHighlighterForTests,
  resolveHighlightLang,
  subscribeHighlightVersion,
} from '../src/lib/code-highlighter'
import { renderMarkdown } from '../src/lib/markdown'

describe('resolveHighlightLang 语言标注规整', () => {
  it('常见别名映射到 shiki 语言 id', () => {
    expect(resolveHighlightLang('ts')).toBe('typescript')
    expect(resolveHighlightLang('js')).toBe('javascript')
    expect(resolveHighlightLang('py')).toBe('python')
    expect(resolveHighlightLang('sh')).toBe('bash')
    expect(resolveHighlightLang('shell')).toBe('bash')
    expect(resolveHighlightLang('yml')).toBe('yaml')
    expect(resolveHighlightLang('rs')).toBe('rust')
  })

  it('大小写不敏感，且取第一个词（围栏标注可能带额外参数）', () => {
    expect(resolveHighlightLang('TypeScript')).toBe('typescript')
    expect(resolveHighlightLang('PYTHON copy')).toBe('python')
  })

  it('空标注返回 null（调用方退回纯文本，不报错）', () => {
    expect(resolveHighlightLang('')).toBeNull()
    expect(resolveHighlightLang('   ')).toBeNull()
  })

  it('不认识但存在的语言返回原 id（走按需补载路径）', () => {
    // 两级加载策略：核心集之外的语言返回 id，由 highlightCode 发起补载，
    // 补载完成前该代码块仍走纯文本。
    expect(resolveHighlightLang('brainfuck')).toBe('brainfuck')
    expect(resolveHighlightLang('brainfuck')).not.toBeNull()
  })
})

describe('高亮器未就绪时的降级行为', () => {
  beforeEach(() => {
    resetHighlighterForTests()
  })

  it('未加载时 isHighlighterReady 为 false', () => {
    expect(isHighlighterReady()).toBe(false)
  })

  it('未加载时 highlightCode 返回 null', () => {
    expect(highlightCode('const a = 1', 'typescript')).toBeNull()
  })

  it('未加载时 markdown 代码块仍是纯文本形态（与改造前一致）', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('<pre class="code-block">')
    expect(html).not.toContain('shiki')
    expect(html).toContain('const a = 1')
  })
})

describe('高亮器就绪后的输出', () => {
  beforeEach(async () => {
    resetHighlighterForTests()
    await loadHighlighter()
  })

  it('加载后 isHighlighterReady 为 true', () => {
    expect(isHighlighterReady()).toBe(true)
  })

  it('高亮输出带 token span 与双主题 CSS 变量', () => {
    const html = highlightCode('const a = 1', 'typescript')
    expect(html).not.toBeNull()
    expect(html).toContain('--shiki-light')
    expect(html).toContain('--shiki-dark')
    expect(html).toContain('<span class="line">')
  })

  it('markdown 代码块升级为高亮形态', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('code-block shiki')
    expect(html).toContain('--shiki-light')
  })

  it('不认识的语言退回纯文本', () => {
    const html = renderMarkdown('```notalanguage\n+++++\n```')
    expect(html).toContain('<pre class="code-block">')
    expect(html).not.toContain('shiki')
  })

  it('核心集之外的语言：先退回纯文本，补载完成后升级为高亮（并 bump 版本号）', async () => {
    // java 不在核心语言集里（核心集见 CORE_LANGS）
    expect(CORE_LANGS).not.toContain('java')
    const versionBefore = getHighlightVersion()
    // 首次渲染：发起补载，本次仍走纯文本
    const first = renderMarkdown('```java\nclass A {}\n```')
    expect(first).toContain('<pre class="code-block">')
    // 等补载完成
    await new Promise((resolve) => setTimeout(resolve, 600))
    const second = renderMarkdown('```java\nclass A {}\n```')
    expect(second).toContain('code-block shiki')
    // 补载完成必须 bump 版本号——这是挂载中代码块「纯文本 → 高亮」升级的唯一通知通道
    expect(getHighlightVersion()).toBeGreaterThan(versionBefore)
  })
})

describe('版本号仓库（useSyncExternalStore 订阅通道）', () => {
  beforeEach(() => {
    resetHighlighterForTests()
  })

  it('初始版本为 0，退订后不再收到通知', async () => {
    expect(getHighlightVersion()).toBe(0)
    const seen: number[] = []
    const unsubscribe = subscribeHighlightVersion(() => seen.push(getHighlightVersion()))
    unsubscribe()
    await loadHighlighter()
    expect(getHighlightVersion()).toBeGreaterThan(0)
    expect(seen).toEqual([])
  })

  it('高亮器就绪恰好 bump 一次（并发调用共享同一 Promise，不重复通知）', async () => {
    const seen: number[] = []
    const unsubscribe = subscribeHighlightVersion(() => seen.push(getHighlightVersion()))
    await Promise.all([loadHighlighter(), loadHighlighter()])
    unsubscribe()
    expect(seen).toEqual([1])
    expect(getHighlightVersion()).toBe(1)
  })

  it('resetHighlighterForTests 重置版本号', async () => {
    await loadHighlighter()
    expect(getHighlightVersion()).toBeGreaterThan(0)
    resetHighlighterForTests()
    expect(getHighlightVersion()).toBe(0)
  })
})

describe('高亮路径的 XSS 边界', () => {
  beforeEach(async () => {
    resetHighlighterForTests()
    await loadHighlighter()
  })

  it('代码内容里的伪 HTML 不会变成可执行标签', () => {
    const evil = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>'
    const html = highlightCode(evil, 'typescript')
    expect(html).not.toBeNull()
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/onerror\s*=/i)
  })

  it('走完整 markdown 渲染路径同样不漏进可执行标签', () => {
    const html = renderMarkdown('```ts\n<script>alert(1)</script>\n```')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/onerror\s*=/i)
  })

  it('代码内容按 HTML 实体转义（内容保留但不可执行）', () => {
    const html = renderMarkdown('```html\n<b>bold</b>\n```')
    expect(html).not.toMatch(/<b>bold<\/b>/)
    // shiki 按 token 切分，尖括号可能被拆到相邻 span 里，
    // 所以断言「尖括号已实体化」而不是断言某一段完整字符串。
    expect(html).toContain('&lt;')
    expect(html).toContain('&gt;')
    // 内容本身仍完整保留（只转义、不丢字）
    expect(html).toContain('bold')
  })
})
