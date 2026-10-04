/**
 * 对话时间线的观感守卫（2026-10-02 紧凑化改造）。
 *
 * 由来（老板实测）：Agent 说的话被限制在 `items-start max-w-[90%]` + 按内容收缩的气泡里，
 * 模型每行写得短一点，整段就贴着左边缩成窄栏、右边空一大片 ——「内容全部都挤在左边」。
 * 对标参考设计（单列紧凑时间线）后定下的四条口径，写死在这里，防止下一个人顺手改回去：
 *  1. AI 侧正文占满消息列，不带底色；最终回复只靠左侧细线与过程叙述区分。
 *  2. 思考是时间线上的一行（与工具行同款 h-7），不是另起一套圆角展开框。
 *  3. 动作行的 chevron 常显；展开态是这一行的状态，不该靠悬停才看得见。
 *  4. 整轮折叠头吃掉整行宽度，展开区不再左缩进 —— 缩进会把已经放开的时间线重新挤回左边。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const item = readFileSync(
  fileURLToPath(new URL('../src/components/chat/MessageItem.tsx', import.meta.url)),
  'utf8',
)
const list = readFileSync(
  fileURLToPath(new URL('../src/components/chat/MessageList.tsx', import.meta.url)),
  'utf8',
)

/** 取 from 到 to 之间的一段（to 找不到就取到文件尾） */
function slice(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  expect(start, `锚点丢失：${from}`).toBeGreaterThan(-1)
  const end = text.indexOf(to, start + from.length)
  return text.slice(start, end === -1 ? text.length : end)
}

// 主消息行的容器（取 className 那一行本身，不含上面那段讲历史的注释）
const mainRow = slice(item, '<div className={`flex flex-col gap-1', '{/* User message attachments')
// 正文块：从注释锚点走到 isUser 分支之前，正好覆盖两侧分支的样式串
const contentBlock = slice(item, '{/* Message content', '{isUser ? (')
// 思考行整体（到下一个 markdown 渲染器为止）
const thinkingRow = slice(item, 'function ThinkingRow(', '/** Full markdown renderer */')
// 工具行整体（到流式行之前）
const toolRow = slice(item, 'function ToolRow(', '/** 流式生成中的工具调用行')
// 整轮折叠头（到最终回复渲染为止）
const turnFold = slice(list, '{/* 折叠头', '{finalMsg && (')

describe('AI 正文的宽度与底色', () => {
  it('AI 侧容器占满整列，不得重新出现按内容收缩的限宽', () => {
    expect(mainRow).toContain('w-full items-stretch')
    expect(mainRow).not.toMatch(/items-start\s+max-w-\[\d+%\]/)
  })

  it('用户侧仍保留右对齐气泡的限宽（短输入靠右是定位手段，不在放开范围内）', () => {
    expect(mainRow).toMatch(/items-end\s+max-w-\[85%\]/)
  })

  it('AI 正文回到无底色纯文本（旧气泡的两套底色不得复活）', () => {
    expect(contentBlock).not.toContain('liquid-glass-subtle')
    expect(contentBlock).not.toContain('bg-dark-surfaceContainerHigh text-dark-onSurface')
    expect(contentBlock).toContain('border-l-2 py-0.5 pl-3')
    expect(contentBlock).toContain('min-w-0 break-words')
  })

  it('过程叙述与最终回复用 isIntermediate 分流，两者都吃满宽度', () => {
    expect(contentBlock).toContain('isIntermediate')
    // 过程叙述不配左边线：几十段叙述都挂一条线，时间线就变成栅栏
    expect(contentBlock).toContain("px-0.5 ${vibe ? 'text-white/80' : 'text-dark-onSurface/85'}")
  })
})

describe('思考与动作行的同一语言', () => {
  it('思考改成了时间线行 ThinkingRow，旧的 ThinkingHeader 不再存在', () => {
    expect(item).toContain('function ThinkingRow(')
    expect(item).not.toContain('ThinkingHeader')
  })

  it('思考行与工具行同一套行骨架（h-7 + gap-2 + 常显 chevron）', () => {
    expect(thinkingRow).toContain('flex h-7 w-full items-center gap-2')
    expect(thinkingRow).toContain('chat.thinkingRow')
    expect(thinkingRow).toContain('<ChevronDown')
    // 展开正文复用工具明细面板，不再自带圆角框
    expect(thinkingRow).toContain('ToolDetailPanel')
    expect(thinkingRow).not.toContain('liquid-glass-subtle')
  })

  it('工具行 chevron 常显，取消悬停交叉淡入', () => {
    expect(toolRow).toContain("${open ? '' : '-rotate-90'}")
    expect(toolRow).not.toContain('group-hover/row')
  })

  it('工具行的目标 chip 去底色（底色把一行切成三段，比纯文字更挤）', () => {
    expect(toolRow).not.toMatch(/bg-(white\/\[0\.06\]|dark-surfaceContainer\/60)/)
  })
})

describe('整轮折叠头与展开区', () => {
  it('折叠头吃掉整行、直接给步数/编辑数/耗时三项统计', () => {
    expect(turnFold).toContain('h-7 w-full items-center')
    expect(turnFold).toContain('chat.stepCount')
    expect(turnFold).toContain('chat.stepEdits')
    expect(turnFold).toContain('duration')
  })

  it('展开区不再左缩进，也不给展开区自己加左边框', () => {
    expect(turnFold).not.toContain('border-l-2 pl-3')
    expect(turnFold).not.toContain('pl-2')
  })
})

describe('流式吸顶状态条', () => {
  it('用浮层而不是 sticky（sticky 会进滚动流，虚拟列表行高口径多算一份）', () => {
    expect(list).toContain('pointer-events-none absolute inset-x-0 top-0')
    expect(list).not.toContain('sticky top-0')
  })

  it('只在流式期间挂载，靠透明度切换，避免计时器各自起算报两个耗时', () => {
    const bar = slice(list, 'aria-hidden={!awayFromBottom}', '{/* 流式期间用户上翻：底部中央悬浮')
    expect(bar).toContain('awayFromBottom ? ')
    expect(bar).toContain('<AgentStatusIndicator')
  })
})
