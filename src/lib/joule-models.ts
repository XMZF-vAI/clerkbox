import type { JouleModel } from '../types/joule'
import type { ProviderModel } from '../types/agent'

/**
 * Joule 目录模型 → ClerkBox ProviderModel。
 * 服务端目录是新增/删除的唯一事实来源；用户手动改过的模型参数（label / 温度 /
 * 上下文预算 / 输出上限）保留，不被每次刷新覆盖。
 *
 * 思考能力完全来自服务端 `remote.thinking`（单一事实来源），CB 不按模型名猜；
 * 服务端未下发时沿用用户已有配置，绝不擅自套 low/medium/high。
 */
export function mergeJouleModels(existing: ProviderModel[], fetched: JouleModel[]): ProviderModel[] {
  const byId = new Map(existing.map((model) => [model.id, model]))
  return fetched.map((remote) => {
    const prior = byId.get(remote.id)
    const remoteThinking = remote.thinking
    const reasoningEfforts = remoteThinking
      ? [...remoteThinking.efforts]
      : (prior?.reasoningEfforts ?? [])
    const reasoningEffort = prior?.reasoningEffort && reasoningEfforts.includes(prior.reasoningEffort)
      ? prior.reasoningEffort
      : remoteThinking?.defaultEffort ?? reasoningEfforts[0]
    const thinkingAlwaysOn = remoteThinking?.alwaysOn ?? prior?.thinkingAlwaysOn
    return {
      id: remote.id,
      label: prior?.label ?? (remote.displayName && remote.displayName !== remote.id ? remote.displayName : undefined),
      // 始终开启思考的模型不允许被旧设置关掉；可关闭的模型尊重用户显式关闭
      supportsThinking: thinkingAlwaysOn
        ? true
        : (prior?.supportsThinking === false ? false : true),
      thinkingAlwaysOn,
      supportsImages: prior?.supportsImages,
      thinkingStyle: remoteThinking?.style ?? prior?.thinkingStyle ?? 'enable',
      reasoningEfforts,
      reasoningEffort,
      temperature: prior?.temperature,
      maxInputTokens:
        prior?.maxInputTokens ??
        (remote.contextLength ? Math.max(32000, remote.contextLength - 16000) : 120000),
      maxTokens: prior?.maxTokens ?? 16000,
    }
  })
}
