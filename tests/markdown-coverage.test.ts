/**
 * Markdown 渲染覆盖守卫。
 *
 * 由来（老板实测）：「工作流 UI 包括子 agent 都没适配 markdown 渲染」——
 * 工作流的汇总报告、子代理的正文/任务书/最终结果当时都是 `whitespace-pre-wrap`
 * 纯文本：标题不粗、列表没项目符号、行内代码没有底色，模型写得越结构化越难看。
 *
 * 根因是 MarkdownContent 原先埋在 MessageItem.tsx 内部且未导出，别的组件无从复用。
 * 现在它抽成共用组件（size: base | compact），下面把「哪些产出必须走它」写死：
 *  1. 工作流终态结果；
 *  2. 子代理对话正文、任务书、最终结果。
 *
 * 这类回归不会报错、不会崩，只是悄悄变难看 —— 所以用源码断言守住，
 * 与 chat-timeline-look.test.ts 同一种做法（抄机制不抄视觉）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

const markdownComponent = read('components/chat/MarkdownContent.tsx')
const workflowRenderer = read('components/chat/tool-renderers/WorkflowRenderer.tsx')
const subAgentPanel = read('components/chat/SubAgentDetailPanel.tsx')
const messageItem = read('components/chat/MessageItem.tsx')
const css = read('index.css')

describe('MarkdownContent 是唯一正文渲染组件', () => {
  it('导出 MarkdownContent，并支持 base / compact 两档', () => {
    expect(markdownComponent).toContain('export const MarkdownContent')
    expect(markdownComponent).toContain("'base' | 'compact'")
    expect(markdownComponent).toContain('md-compact')
  })

  it('高亮版本订阅仍在组件内（代码块就绪后会升级）', () => {
    expect(markdownComponent).toContain('useSyncExternalStore')
    expect(markdownComponent).toContain('renderMarkdown')
  })

  it('MessageItem 复用共用组件，不再保留第二份实现', () => {
    expect(messageItem).toContain("from './MarkdownContent'")
    // 本地再定义一份就会绕开 md-compact 与后续所有修补
    expect(messageItem).not.toContain('const MarkdownContent = memo(')
  })

  it('紧凑档样式存在，且不改配色只改尺寸', () => {
    expect(css).toContain('.markdown-body.md-compact')
    expect(css).toContain('@apply text-ui-xs leading-relaxed')
  })
})

describe('工作流结果按 Markdown 渲染', () => {
  it('WorkflowRenderer 的终态结果走 MarkdownContent', () => {
    expect(workflowRenderer).toContain("import { MarkdownContent } from '../MarkdownContent'")
    // run.result 的那一段必须是 MarkdownContent，不能退回纯文本
    const at = workflowRenderer.indexOf('run.status === \'completed\' && run.result')
    expect(at, '终态结果的渲染分支丢失').toBeGreaterThan(-1)
    const block = workflowRenderer.slice(at, at + 400)
    expect(block).toContain('<MarkdownContent')
    expect(block).toContain('size="compact"')
    expect(block).not.toContain('whitespace-pre-wrap')
  })

  it('错误文本仍按 pre 原样展示（堆栈不该被 Markdown 解析）', () => {
    expect(workflowRenderer).toContain('{run.error}</pre>')
  })
})

describe('子代理面板三处产出按 Markdown 渲染', () => {
  it('对话正文走 MarkdownContent（compact）', () => {
    expect(subAgentPanel).toContain("import { MarkdownContent } from './MarkdownContent'")
    expect(subAgentPanel).toContain('<MarkdownContent content={msg.content} vibe={vibe} size="compact" />')
  })

  it('任务书走 MarkdownContent，并限高内滚（长任务书不许挤掉消息区）', () => {
    expect(subAgentPanel).toContain('<MarkdownContent content={run.prompt} vibe={vibe} size="compact" />')
    expect(subAgentPanel).toContain('max-h-32 overflow-y-auto')
  })

  it('最终结果走 MarkdownContent，且不再截到 1000 字', () => {
    expect(subAgentPanel).toContain('<MarkdownContent content={run.result} vibe={vibe} size="compact" />')
    expect(subAgentPanel).not.toContain('run.result.slice(0, 1000)')
  })

  it('思考过程保持纯文本（不是 Markdown 语义，避免模型自述被误渲染）', () => {
    // 注意定位 JSX 里的 {msg.thinkingContent}，不是上面 hasThinking 的判断表达式
    const at = subAgentPanel.indexOf('{msg.thinkingContent}')
    expect(at).toBeGreaterThan(-1)
    const block = subAgentPanel.slice(Math.max(0, at - 260), at)
    expect(block).toContain('whitespace-pre-wrap')
  })
})
