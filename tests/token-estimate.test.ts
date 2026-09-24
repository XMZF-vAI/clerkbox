import { describe, it, expect } from 'vitest'
import {
  estimateTokensForText,
  estimateTokensForMessages,
  truncateTextToTokens,
} from '../src/lib/token-estimate'

describe('estimateTokensForText', () => {
  it('空文本为 0', () => {
    expect(estimateTokensForText('')).toBe(0)
  })

  it('ASCII 约 4 字符/token', () => {
    expect(estimateTokensForText('abcd')).toBe(1)
    expect(estimateTokensForText('hello world')).toBe(3) // 11 chars → ceil(11/4)
  })

  it('CJK 约 1.5 字符/token', () => {
    expect(estimateTokensForText('你好世')).toBe(2) // 3 CJK → 3/1.5
  })

  it('emoji 约 1 个/token（实现按 UTF-16 码元计总长，存在启发式误差）', () => {
    const ten = estimateTokensForText('🎉'.repeat(10))
    expect(ten).toBeGreaterThanOrEqual(10)
    expect(ten).toBeLessThanOrEqual(13)
  })

  it('混合文本按比例合计', () => {
    // 2 CJK (≈1.33) + 4 ASCII (1) → ceil(2.33) = 3
    expect(estimateTokensForText('你好abcd')).toBe(3)
  })
})

describe('estimateTokensForMessages', () => {
  it('tool 消息 content 与 toolResults[0].content 相同时只计一次（防工具密集会话估算翻倍）', () => {
    const content = 'x'.repeat(400) // 100 tokens
    const withDup = estimateTokensForMessages([
      { role: 'tool', content, toolResults: [{ content }] },
    ])
    const withoutDup = estimateTokensForMessages([{ role: 'tool', content }])
    expect(withDup).toBe(withoutDup)
  })

  it('toolCalls 与 thinkingContent 计入估算', () => {
    const base = estimateTokensForMessages([{ role: 'assistant', content: '' }])
    const withToolCalls = estimateTokensForMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'a.ts' } }] },
    ])
    expect(withToolCalls).toBeGreaterThan(base)
  })
})

describe('truncateTextToTokens', () => {
  it('预算内原文返回', () => {
    const text = 'short text'
    expect(truncateTextToTokens(text, 100)).toBe(text)
  })

  it('超预算截断并带标记', () => {
    const text = 'a'.repeat(10_000)
    const result = truncateTextToTokens(text, 100)
    expect(result.endsWith('[... content truncated for compaction ...]')).toBe(true)
    expect(result.length).toBeLessThan(text.length)
  })
})
