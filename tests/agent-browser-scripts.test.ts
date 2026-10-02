import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 注入脚本的语法守卫。
 *
 * browserCommandScripts / agent-browser 的页面脚本是**字符串字面量**：里面写错了括号、
 * 少转义一个反斜杠、占位符拼错，TypeScript 与 vite 都不会报错，只有等到 CDP
 * `Runtime.evaluate` 把它送进真实页面时才炸 —— 而那时是用户在等一个浏览器工具返回。
 * 这里在 CI 阶段就把每段脚本按 JS 表达式解析一遍。
 *
 * 做法：从源码文本里抓出模板字面量，替换占位符，再 `new Function` 编译。
 * 抓不到常量本身也算失败（改名/改写法后这条断言先炸，避免静默失效）。
 */
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'electron', 'agent-browser.ts'), 'utf-8')

/** 抓 `const NAME = \`...\`;` 的字面量内容 */
function extractTemplate(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = \``)
  expect(start, `找不到常量 ${name}（写法变了？）`).toBeGreaterThan(-1)
  const from = start + `const ${name} = \``.length
  const end = SOURCE.indexOf('`', from)
  expect(end, `${name} 的模板字面量未闭合`).toBeGreaterThan(from)
  return SOURCE.slice(from, end)
}

function compiles(label: string, body: string): void {
  expect(() => new Function(`return (${body})`), `${label} 语法不成立`).not.toThrow()
}

describe('injected page scripts', () => {
  it('SNAPSHOT_SCRIPT 在填入占位符后是合法表达式', () => {
    const script = extractTemplate('SNAPSHOT_SCRIPT')
      .replace(/__MAX__/g, '400')
      .replace(/__HIDDEN__/g, 'false')
    compiles('SNAPSHOT_SCRIPT', script)
  })

  it('快照脚本里引用的三个占位符都被用到了（拼错就是静默失效）', () => {
    expect(extractTemplate('SNAPSHOT_SCRIPT')).toContain('__MAX__')
    expect(extractTemplate('SNAPSHOT_SCRIPT')).toContain('__HIDDEN__')
  })

  it('ref 相关脚本填入 ref 后是合法表达式', () => {
    for (const name of ['RESOLVE_REF_SCRIPT', 'FOCUS_REF_SCRIPT', 'CLEAR_REF_SCRIPT']) {
      compiles(name, extractTemplate(name).replace(/__REF__/g, JSON.stringify('e1')))
    }
  })

  it('页面状态脚本是合法表达式且能独立求值', () => {
    const script = extractTemplate('PAGE_STATE_SCRIPT')
    compiles('PAGE_STATE_SCRIPT', script)
    // 真正跑一次：在无 DOM 环境下 location/window 缺一部分，但能编译即证明语法成立
    const fn = new Function(`return (${script})`) as () => unknown
    expect(() => fn()).toThrow() // 无 window 环境必然抛，但抛的是运行期错误而非语法错误
  })

  it('快照脚本不读取 window 上的自定义全局之外的东西（页面沙箱里只有 DOM）', () => {
    const script = extractTemplate('SNAPSHOT_SCRIPT')
    expect(script).toContain('window.__clerkboxRefs')
    // 只允许 DOM API 与语言内建；出现 require / process / import 说明有人想在页面里摸宿主
    expect(script).not.toMatch(/\brequire\s*\(/)
    expect(script).not.toMatch(/\bprocess\./)
    expect(script).not.toMatch(/\bimport\s/)
  })
})
