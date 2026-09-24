import { describe, it, expect } from 'vitest'
import type { Message } from '../src/types/agent'
import {
  getCompactPrompt,
  formatCompactSummary,
  getCompactUserSummaryMessage,
  truncateToTokens,
  stripImagesFromMessages,
  groupMessagesByApiRound,
  truncateHeadForPTLRetry,
  findKeepBoundaryIndex,
} from '../src/lib/compact'

let seq = 0
function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  seq += 1
  return { id: `m${seq}`, role, content, timestamp: seq, ...extra }
}

function userMsgs(count: number, text: string): Message[] {
  return Array.from({ length: count }, () => msg('user', text))
}

describe('getCompactPrompt', () => {
  it('包含必备摘要小节', () => {
    const prompt = getCompactPrompt()
    expect(prompt).toContain('Primary Request and Intent')
    expect(prompt).toContain('Current Work')
    expect(prompt).toContain('<summary>')
  })

  it('追加用户自定义指令', () => {
    expect(getCompactPrompt('重点保留 SQL 决策')).toContain('重点保留 SQL 决策')
  })
})

describe('formatCompactSummary', () => {
  it('剥离 <analysis> 并提取 <summary> 内容', () => {
    const raw = '<analysis>thinking</analysis><summary>\n  结论正文 \n</summary>'
    expect(formatCompactSummary(raw)).toBe('结论正文')
  })

  it('无 <summary> 标签时回退为去 analysis 后的全文', () => {
    expect(formatCompactSummary('<analysis>隐去</analysis>剩下的正文')).toBe('剩下的正文')
  })

  it('标签匹配大小写不敏感', () => {
    expect(formatCompactSummary('<SUMMARY>abc</SUMMARY>')).toBe('abc')
  })
})

describe('getCompactUserSummaryMessage', () => {
  it('摘要嵌入续聊模板', () => {
    const text = getCompactUserSummaryMessage('摘要内容')
    expect(text).toContain('摘要内容')
    expect(text).toContain('continued from a previous conversation')
  })
})

describe('truncateToTokens', () => {
  it('预算内原文返回', () => {
    expect(truncateToTokens('短文本', 100)).toBe('短文本')
  })

  it('超预算截断并带标记', () => {
    const result = truncateToTokens('长'.repeat(10_000), 50)
    expect(result).toContain('[... content truncated for compaction ...]')
    expect(result.length).toBeLessThan(10_000)
  })
})

describe('stripImagesFromMessages', () => {
  it('替换 markdown 图片与 [image:] 标记', () => {
    const out = stripImagesFromMessages([msg('user', '看图 ![截图](file:///a.png) 和 [image:png;id=1] 完毕')])
    expect(out[0].content).toBe('看图 [image] 和 [image] 完毕')
  })

  it('无图片时保留原消息引用（避免无谓重渲染）', () => {
    const original = msg('user', '纯文本')
    expect(stripImagesFromMessages([original])[0]).toBe(original)
  })
})

describe('groupMessagesByApiRound', () => {
  it('assistant 开启新分组，tool 归属前一个 assistant 组', () => {
    const groups = groupMessagesByApiRound([
      msg('user', '问1'),
      msg('assistant', '答1'),
      msg('tool', '工具结果'),
      msg('assistant', '答2'),
      msg('user', '问2'),
    ])
    expect(groups.map((g) => g.map((m) => m.role))).toEqual([
      ['user'],
      ['assistant', 'tool'],
      ['assistant', 'user'],
    ])
  })

  it('空输入返回空数组', () => {
    expect(groupMessagesByApiRound([])).toEqual([])
  })
})

describe('truncateHeadForPTLRetry', () => {
  it('不足 2 组时返回 null（无可丢弃）', () => {
    expect(truncateHeadForPTLRetry([msg('user', '仅一条')])).toBeNull()
  })

  it('丢弃约 20% 的分组且至少保留 1 组', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `消息${i}`))
    const result = truncateHeadForPTLRetry(messages)
    expect(result).not.toBeNull()
    const kept = result as Message[]
    expect(kept.length).toBeLessThan(messages.length)
    expect(kept.length).toBeGreaterThanOrEqual(messages.length / 2)
  })

  it('剩余消息以 tool 开头时前置合成 user 标记', () => {
    const messages = [
      msg('assistant', 'a1'),
      msg('assistant', 'a2'),
      msg('tool', 't1'),
    ]
    const result = truncateHeadForPTLRetry(messages) as Message[]
    expect(result).not.toBeNull()
    if (result[0].id.startsWith('ptl-marker-')) {
      expect(result[0].role).toBe('user')
      expect(result[1].role).toBe('tool')
    } else {
      expect(result[0].role).not.toBe('tool')
    }
  })
})

describe('findKeepBoundaryIndex', () => {
  it('消息数不超过保留数时不压缩（返回 0）', () => {
    expect(findKeepBoundaryIndex(userMsgs(5, 'x'), 6)).toBe(0)
  })

  it('常规情况保留末尾 keepRecentCount 条', () => {
    expect(findKeepBoundaryIndex(userMsgs(20, 'x'), 6)).toBe(14)
  })

  it('边界落在 tool 消息上时向前回退到其 assistant+toolCalls 前驱', () => {
    const messages = [
      ...userMsgs(13, 'x'),
      msg('assistant', '调用工具', { toolCalls: [{ id: 'tc1', name: 'read_file', arguments: {} }] }),
      msg('tool', '结果', { toolResults: [{ toolCallId: 'tc1', content: '结果' }] }),
      ...userMsgs(5, 'y'),
    ]
    // 共 20 条，keep 6 → 初始边界 14（tool）→ 回退到 13（assistant+toolCalls）
    expect(findKeepBoundaryIndex(messages, 6)).toBe(13)
  })

  it('孤立的 assistant+toolCalls（无 tool 响应）被跳过', () => {
    const messages = [
      ...userMsgs(13, 'x'),
      msg('assistant', '孤儿调用', { toolCalls: [{ id: 'tc9', name: 'read_file', arguments: {} }] }),
      ...userMsgs(6, 'y'),
    ]
    // 共 20 条，keep 6 → 初始边界 14（user）无需调整
    expect(findKeepBoundaryIndex(messages, 6)).toBe(14)
    // keep 7 → 初始边界 13（孤儿 assistant+toolCalls，下一条不是其 tool 响应）→ 跳过到 14
    expect(findKeepBoundaryIndex(messages, 7)).toBe(14)
  })
})
