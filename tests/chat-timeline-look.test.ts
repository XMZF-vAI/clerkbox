/**
 * 对话时间线的观感守卫（2026-11-10 照抄 ZCode 会话流）。
 *
 * 老板拿 ZCode 截图点名「输入框上方这一块会话流，抄袭过来」，取代 2026-10-02 的紧凑化口径。
 * 参考物 D:\ZCode\packages\ui\src 的层级与措辞，写死在这里防止下一个人顺手改回去：
 *  1. 助手侧全行平铺，没有「N 个步骤」回合级折叠头（ZCode 完成态也全行可见）。
 *  2. 思考行 / 工具行都是内容宽度（self-start）的灰字行，不是满宽横条；
 *     chevron 悬停才显现（ZCode ToolSummaryRow / ReasoningTrigger 同款），展开转 90°。
 *  3. 运行态图标静止、类别词扫光（ZCode：旋转 loader 长期占用渲染资源）。
 *  4. 正文段落白字平铺，无左边框无底色（ZCode assistantText 行）。
 *  5. 连续 ≥2 只读工具聚「查阅」、连续 ≥2 命令聚「终端」，展开体走左导线、子行去图标。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../src/components/chat/${p}`, import.meta.url)), 'utf8')
const stream = read('AssistantTurnStream.tsx')
const reasoning = read('ReasoningRow.tsx')
const toolRow = read('ToolCallRow.tsx')
const groupRow = read('ToolGroupRow.tsx')
const list = read('MessageList.tsx')

describe('助手侧全行平铺，无回合级折叠头', () => {
  it('TurnPanel 把助手侧交给 AssistantTurnStream，不再自己折叠', () => {
    expect(list).toContain('<AssistantTurnStream')
    expect(list).not.toContain('chat.stepEdits')
    expect(list).not.toContain('shouldFold')
  })

  it('行流容器用 gap-4（ZCode 连续工作项间距），不靠回合折叠头切段', () => {
    expect(stream).toContain('flex w-full min-w-0 flex-col gap-4')
    expect(stream).not.toContain('chat.stepCount')
  })
})

describe('正文段落白字平铺', () => {
  it('正文无边框无底色，纯文本满宽（ZCode assistantText 行）', () => {
    expect(stream).toContain('min-w-0 break-words py-1 text-ui-sm leading-relaxed')
    expect(stream).not.toContain('border-l-2')
    expect(stream).not.toContain('liquid-glass-subtle')
  })
})

describe('思考行照抄 ZCode Reasoning', () => {
  it('内容宽度 + Brain 图标 + 悬停 chevron，不是满宽横条', () => {
    expect(reasoning).toContain('inline-flex max-w-full min-w-0 items-center gap-2 self-start')
    expect(reasoning).toContain('<Brain size={16}')
    expect(reasoning).toContain('opacity-0 group-hover/reasoning:opacity-100')
    expect(reasoning).toContain('group-focus-visible/reasoning:opacity-100')
    expect(reasoning).toContain('aria-controls={detailId}')
    expect(reasoning).not.toContain('flex h-7 w-full')
  })

  it('措辞走 ZCode 口径：思考 / 持续了几秒 / 持续了 N 秒 / 正在思考扫光', () => {
    expect(reasoning).toContain('chat.reasoning.thought')
    expect(reasoning).toContain('chat.reasoning.durationFewSeconds')
    expect(reasoning).toContain('chat.reasoning.durationSeconds')
    expect(reasoning).toContain('chat.reasoning.thinking')
    expect(reasoning).toContain('thinking-shimmer')
  })

  it('展开体走左导线 + 限高滚动（ZCode ReasoningContent）', () => {
    expect(reasoning).toContain('ml-2 max-h-60 overflow-auto border-l pl-3.5')
    expect(reasoning).toContain('whitespace-pre-wrap break-words')
  })
})

describe('工具行照抄 ZCode ToolSummaryRow', () => {
  it('内容宽度 + 悬停 chevron；运行态图标静止不用 spinner', () => {
    expect(toolRow).toContain('inline-flex max-w-full min-w-0 items-center gap-2 self-start')
    expect(toolRow).toContain('opacity-0 group-hover/tool:opacity-100')
    expect(toolRow).toContain('group-focus-visible/tool:opacity-100')
    expect(toolRow).toContain('aria-controls={detailId}')
    expect(toolRow).not.toContain('animate-spin')
    expect(toolRow).toContain('thinking-shimmer')
  })

  it('失败挂虚线下划线 + 悬停 tooltip（ZCode statusTooltip 语义）', () => {
    expect(toolRow).toContain('chat.toolStatus.failed')
    expect(toolRow).toContain('decoration-dotted')
  })
})

describe('查阅 / 终端聚合组', () => {
  it('措辞与左导线展开体、子行去图标', () => {
    expect(groupRow).toContain('chat.explore.label')
    expect(groupRow).toContain('chat.executeGroup.label')
    expect(groupRow).toContain('ml-2 flex flex-col gap-2 border-l pl-3.5')
    expect(groupRow).toContain('showIcon={false}')
  })
})

describe('流式吸顶状态条（保留既有 machinery）', () => {
  it('用浮层而不是 sticky（sticky 会进滚动流，虚拟列表行高口径多算一份）', () => {
    expect(list).toContain('pointer-events-none absolute inset-x-0 top-0')
    expect(list).not.toContain('sticky top-0')
  })
})
