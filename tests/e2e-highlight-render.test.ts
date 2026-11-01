/**
 * 端到端渲染管线验证：确认高亮器加载后，markdown 渲染路径真的产出带 token 色的 HTML。
 *
 * 这是「观感守卫」的补充：前面的测试验证各零件，本测试验证它们串起来后的最终产物。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { loadHighlighter } from '../src/lib/code-highlighter'
import { renderMarkdown } from '../src/lib/markdown'

describe('端到端：高亮后的 markdown 渲染产物', () => {
  beforeAll(async () => { await loadHighlighter() })

  it('TS 代码块产出 token span（带双主题 CSS 变量）', () => {
    const html = renderMarkdown('```ts\nconst x: number = 1\n```')
    expect(html).toContain('code-block shiki')
    expect(html).toMatch(/<span style="--shiki-light:[^"]+;--shiki-dark:[^"]+">/)
    // 关键字与标识符应是不同的 token（不同颜色 → 不同 span）
    const spans = html.match(/<span style="--shiki-light/g) ?? []
    expect(spans.length).toBeGreaterThan(2)
  })

  it('Python 代码块同样高亮（证明不是只对 TS 生效）', () => {
    const html = renderMarkdown('```python\ndef add(a, b):\n    return a + b\n```')
    expect(html).toContain('code-block shiki')
    expect(html).toContain('--shiki-light')
  })

  it('多行代码块保留换行结构', () => {
    const html = renderMarkdown('```js\nline1\nline2\nline3\n```')
    const lines = html.match(/class="line"/g) ?? []
    expect(lines.length).toBe(3)
  })

  it('代码块之外的正文不受影响（仍是 .markdown-body 契约内的纯 HTML）', () => {
    const html = renderMarkdown('# 标题\n\n正文一段。\n\n```ts\nconst a = 1\n```')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<p>正文一段。</p>')
    expect(html).toContain('code-block shiki')
  })

  it('围栏外的普通文本不会被误高亮', () => {
    const html = renderMarkdown('这是普通文本，含 `inline` 代码。')
    expect(html).not.toContain('shiki')
    expect(html).toContain('inline-code')
  })
})
