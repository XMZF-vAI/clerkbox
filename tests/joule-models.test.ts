import { describe, expect, it } from 'vitest'
import { mergeJouleModels } from '../src/lib/joule-models'
import type { JouleModel } from '../src/types/joule'
import type { ProviderModel } from '../src/types/agent'

const remoteModel = (over: Partial<JouleModel> = {}): JouleModel => ({
  id: 'model-a',
  displayName: 'Model A',
  contextLength: null,
  est5h: 100,
  cap: 60,
  used: 5,
  remaining: 55,
  ...over,
})

describe('mergeJouleModels', () => {
  it('新模型按服务端顺序生成，displayName 写入 label，未知 context 用保守预算', () => {
    const merged = mergeJouleModels([], [
      remoteModel({ id: 'b', displayName: 'Model B' }),
      remoteModel({ id: 'a', displayName: 'Model A' }),
    ])
    expect(merged.map((m) => m.id)).toEqual(['b', 'a'])
    expect(merged[0]!.label).toBe('Model B')
    expect(merged[0]!.maxInputTokens).toBe(120000)
    expect(merged[0]!.maxTokens).toBe(16000)
    expect(merged[0]!.supportsThinking).toBe(true)
  })

  it('保留用户覆盖的模型参数，不被刷新覆盖', () => {
    const existing: ProviderModel[] = [
      {
        id: 'a',
        label: '我的别名',
        temperature: 0.2,
        maxInputTokens: 50000,
        maxTokens: 8000,
        reasoningEfforts: ['low', 'high'],
        reasoningEffort: 'high',
      },
    ]
    const merged = mergeJouleModels(existing, [remoteModel({ id: 'a', displayName: 'Model A' })])
    expect(merged[0]).toMatchObject({
      label: '我的别名',
      temperature: 0.2,
      maxInputTokens: 50000,
      maxTokens: 8000,
      reasoningEffort: 'high',
    })
  })

  it('服务端已删除的模型从本地移除', () => {
    const existing: ProviderModel[] = [{ id: 'gone', label: '旧模型' }, { id: 'a', label: 'A' }]
    const merged = mergeJouleModels(existing, [remoteModel({ id: 'a' })])
    expect(merged.map((m) => m.id)).toEqual(['a'])
  })

  it('已知 context 时预算按 context - 16000 并保底 32000', () => {
    const wide = mergeJouleModels([], [remoteModel({ contextLength: 200000 })])
    expect(wide[0]!.maxInputTokens).toBe(184000)
    const small = mergeJouleModels([], [remoteModel({ contextLength: 40000 })])
    expect(small[0]!.maxInputTokens).toBe(32000)
  })

  it('displayName 与 id 相同时不写冗余 label', () => {
    const merged = mergeJouleModels([], [remoteModel({ id: 'glm-5.3', displayName: 'glm-5.3' })])
    expect(merged[0]!.label).toBeUndefined()
  })

  it('按服务端 thinking 配置生成档位，不按模型名猜测', () => {
    const merged = mergeJouleModels([], [
      remoteModel({
        id: 'kimi-k3',
        displayName: 'Kimi K3',
        thinking: {
          style: 'effort',
          efforts: ['low', 'high', 'max'],
          defaultEffort: 'max',
          alwaysOn: true,
        },
      }),
    ])
    expect(merged[0]).toMatchObject({
      thinkingStyle: 'effort',
      reasoningEfforts: ['low', 'high', 'max'],
      reasoningEffort: 'max',
      thinkingAlwaysOn: true,
      supportsThinking: true,
    })
  })

  it('服务端未下发 thinking 时保留本地旧配置，不套默认档位', () => {
    const existing: ProviderModel[] = [{
      id: 'unknown-model',
      thinkingStyle: 'enable',
      reasoningEfforts: ['low', 'high'],
      reasoningEffort: 'high',
      supportsThinking: true,
    }]
    const merged = mergeJouleModels(existing, [remoteModel({ id: 'unknown-model' })])
    expect(merged[0]).toMatchObject({
      thinkingStyle: 'enable',
      reasoningEfforts: ['low', 'high'],
      reasoningEffort: 'high',
    })
  })

  it('保留用户选中的合法档位，非法档位回落到服务端默认', () => {
    const keep = mergeJouleModels(
      [{ id: 'glm-5.3', reasoningEfforts: ['low', 'high', 'max'], reasoningEffort: 'high' }],
      [remoteModel({
        id: 'glm-5.3',
        thinking: { style: 'effort', efforts: ['low', 'high', 'max'], defaultEffort: 'max', alwaysOn: true },
      })],
    )
    expect(keep[0]!.reasoningEffort).toBe('high')

    const fallback = mergeJouleModels(
      [{ id: 'glm-5.3', reasoningEfforts: ['low', 'medium', 'high'], reasoningEffort: 'medium' }],
      [remoteModel({
        id: 'glm-5.3',
        thinking: { style: 'effort', efforts: ['low', 'high', 'max'], defaultEffort: 'max', alwaysOn: true },
      })],
    )
    expect(fallback[0]!.reasoningEffort).toBe('max')
  })

  it('始终开启思考的模型不能被旧设置关闭', () => {
    const merged = mergeJouleModels(
      [{ id: 'kimi-k3', supportsThinking: false }],
      [remoteModel({
        id: 'kimi-k3',
        thinking: { style: 'effort', efforts: ['low', 'high', 'max'], defaultEffort: 'max', alwaysOn: true },
      })],
    )
    expect(merged[0]!.supportsThinking).toBe(true)
    expect(merged[0]!.thinkingAlwaysOn).toBe(true)
  })
})
