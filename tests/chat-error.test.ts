import { describe, expect, it } from 'vitest'
import { buildDiagnosticPayload, classifyChatError } from '../src/lib/chat-error'

describe('classifyChatError 判定优先级', () => {
  it('配额耗尽虽以 429 送达，仍归为鉴权/配额类（要的是「去设置」而不是「稍后再试」）', () => {
    const raw =
      'API Error 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}'
    // 回归点：限流判定原先排在鉴权之前，裸 \b429\b 会把这条截走，
    // 于是「去设置」按钮永远不出现，用户对着一个重试不掉的错误干等倒计时。
    expect(classifyChatError(raw)).toBe('auth')
  })

  it('纯限流保持 rate_limit', () => {
    expect(classifyChatError('API Error 429: Rate limit reached. Please try again in 30s.')).toBe('rate_limit')
  })

  it('上下文溢出优先于一切（要压缩而不是改配置）', () => {
    expect(classifyChatError('HTTP 400: prompt is too long: 210000 tokens > 200000 maximum')).toBe('context_overflow')
    expect(classifyChatError('429 quota: your context length exceeded the model maximum context')).toBe('context_overflow')
  })

  it('网络中断归为 network', () => {
    expect(classifyChatError('fetch failed: ENOTFOUND api.openai.com')).toBe('network')
  })

  it('401 / 无效 Key 归为 auth，兜底 unknown', () => {
    expect(classifyChatError('HTTP 401 Unauthorized')).toBe('auth')
    expect(classifyChatError('something nobody modelled')).toBe('unknown')
  })
})

describe('buildDiagnosticPayload', () => {
  it('带上错误码、会话与截断后的原文摘要，供用户复制排障', () => {
    const text = buildDiagnosticPayload({
      code: 'auth',
      message: 'x'.repeat(3000),
      sessionId: 's1',
      timestamp: 1_700_000_000_000,
    })
    expect(text.split('\n')[0]).toBe('code=auth')
    expect(text).toContain('session=s1')
    expect(text).not.toContain('x'.repeat(2001))
  })
})
