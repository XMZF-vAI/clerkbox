/**
 * dangerouslySetInnerHTML 的入口就是 XSS 边界，src/lib/markdown.ts 的文件头也写了
 * 「修改渲染规则时必须回归 javascript:/onerror= 等注入向量」——但这条回归此前并不存在。
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/lib/markdown'

const noRawScriptTag = (html: string) => !/<script/i.test(html)

describe('renderMarkdown 注入向量', () => {
  it('原文里的标签一律转义，不产出可执行标签', () => {
    const html = renderMarkdown('你好 <script>alert(1)</script> <img src=x onerror=alert(1)>')
    expect(noRawScriptTag(html)).toBe(true)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toMatch(/<img/i)
    // 注入串只能以「文本」形态出现：尖括号被转义后，onerror= 这些字符本身不构成属性
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('javascript: / data: 链接协议被白名单挡掉', () => {
    const js = renderMarkdown('[点我](javascript:alert(1))')
    expect(js).not.toMatch(/href="javascript:/i)
    const data = renderMarkdown('[点我](data:text/html;base64,PHNjcmlwdD4=)')
    expect(data).not.toMatch(/href="data:/i)
    const VB = renderMarkdown('[点我](vbscript:msgbox(1))')
    expect(VB).not.toMatch(/href="vbscript:/i)
  })

  it('协议里塞空白/控制字符的绕过写法同样不透传', () => {
    const html = renderMarkdown('[x](java\tscript:alert(1))')
    expect(html).not.toMatch(/href="java/i)
  })

  it('正常链接与相对锚点照常可用', () => {
    expect(renderMarkdown('[docs](https://example.com/a)')).toContain('href="https://example.com/a"')
    expect(renderMarkdown('[锚](#section)')).toContain('href="#section"')
    expect(renderMarkdown('[邮件](mailto:a@b.com)')).toContain('href="mailto:a@b.com"')
  })

  it('代码块整体转义，模型输出的伪 HTML 不会漏进 DOM', () => {
    const html = renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```')
    expect(html).not.toMatch(/<img/i)
    expect(html).toContain('&lt;img')
  })
})
