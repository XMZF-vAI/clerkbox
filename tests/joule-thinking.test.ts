import { describe, expect, it } from 'vitest'
import { buildRequestBody, type BuildBodyOptions } from '../src/lib/api-adapters'

const base = (over: Partial<BuildBodyOptions> = {}): BuildBodyOptions => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  temperature: 0.7,
  maxTokens: 256,
  thinking: true,
  stream: false,
  ...over,
})

describe('OpenAI 思考参数序列化', () => {
  it('effort 风格只发 reasoning_effort', () => {
    const body = buildRequestBody('openai', base({
      thinkingStyle: 'effort',
      reasoningEffort: 'max',
    }))
    expect(body.reasoning_effort).toBe('max')
    expect(body.thinking).toBeUndefined()
    expect(body.enable_thinking).toBeUndefined()
  })

  it('kimi 风格发送 thinking.enabled，关闭时显式 disabled', () => {
    expect(buildRequestBody('openai', base({ thinkingStyle: 'kimi' })).thinking).toEqual({ type: 'enabled' })
    expect(buildRequestBody('openai', base({ thinkingStyle: 'kimi', thinking: false })).thinking).toEqual({ type: 'disabled' })
  })

  it('minimax 风格发送 thinking.adaptive，关闭时显式 disabled', () => {
    expect(buildRequestBody('openai', base({ thinkingStyle: 'minimax' })).thinking).toEqual({ type: 'adaptive' })
    expect(buildRequestBody('openai', base({ thinkingStyle: 'minimax', thinking: false })).thinking).toEqual({ type: 'disabled' })
  })

  it('deepseek 风格开启时发 reasoning_effort，关闭时发 thinking.disabled', () => {
    const on = buildRequestBody('openai', base({ thinkingStyle: 'deepseek', reasoningEffort: 'high' }))
    expect(on.reasoning_effort).toBe('high')
    expect(on.thinking).toBeUndefined()
    const off = buildRequestBody('openai', base({ thinkingStyle: 'deepseek', thinking: false }))
    expect(off.thinking).toEqual({ type: 'disabled' })
    expect(off.reasoning_effort).toBeUndefined()
  })
})
