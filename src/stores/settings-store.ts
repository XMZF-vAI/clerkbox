import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppSettings, ApiCompat, CustomModel, ModelProvider, ProviderModel } from '../types/agent'
import { normalizeEffort } from '../types/agent'
import { guessApiCompat, guessPresetByBaseUrl, fallbackNameFromBaseUrl } from '../lib/provider-catalog'
import { ipc } from '../lib/ipc-client'

interface SettingsState extends AppSettings {
  showSettings: boolean
  updateSettings: (partial: Partial<AppSettings & { showSettings?: boolean }>) => void
  resetSettings: () => void
  /** 添加/更新提供商 */
  upsertProvider: (provider: ModelProvider) => void
  /** 删除提供商；若删除的是当前生效项，回落到剩余第一个可用模型 */
  removeProvider: (id: string) => void
  /** 覆盖某提供商的已启用模型列表 */
  setProviderModels: (providerId: string, models: ProviderModel[]) => void
  /** 从提供商移除单个模型 */
  removeProviderModel: (providerId: string, modelId: string) => void
  /** 设为当前生效：把该提供商的连接信息 + 模型写入派生字段 */
  activateModel: (providerId: string, modelId: string) => void
}

const defaultSettings: AppSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxInputTokens: 184000,
  maxTokens: 16000,
  theme: 'dark',
  colorScheme: 'classic',
  customSeedColor: '#F4A7B9',
  language: 'zh-CN',
  permissionMode: 'craft',
  enableThinking: false,
  thinkingBudget: undefined,
  providers: [],
  activeProviderId: undefined,
  activeModelId: undefined,
  apiCompat: 'openai',
  directFetch: false,
  customModels: [],
  activeCustomModelId: undefined,
  providersMigratedAt: undefined,
  hasCompletedOnboarding: false,
  agentsMdEnabled: true,
  claudeMdCompat: true,
}

const apiKeyWriteQueues = new Map<string, Promise<void>>()
const apiKeyRevisions = new Map<string, number>()
let credentialStorageReady = false
let credentialHydrationEpoch = 0

/** Serialize credential writes per provider so rapid input cannot persist out of order. */
function queueApiKeyWrite(providerId: string, apiKey: string): Promise<void> {
  const previous = apiKeyWriteQueues.get(providerId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => (apiKey ? ipc.saveApiKey(providerId, apiKey) : ipc.removeApiKey(providerId)))
  apiKeyWriteQueues.set(providerId, next)
  void next.then(
    () => { if (apiKeyWriteQueues.get(providerId) === next) apiKeyWriteQueues.delete(providerId) },
    () => { if (apiKeyWriteQueues.get(providerId) === next) apiKeyWriteQueues.delete(providerId) },
  )
  return next
}

/** 把提供商 + 模型的连接信息写入生效（派生）字段 */
const applyActive = (p: ModelProvider, modelId: string) => {
  const model = p.models.find((m) => m.id === modelId)
  const base = {
    model: modelId,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    apiCompat: p.apiCompat,
    directFetch: p.directFetch ?? false,
    activeProviderId: p.id,
    activeModelId: modelId,
    // 模型级高级参数 → 同步到全局生效字段（未配置则保留全局默认）
    temperature: model?.temperature ?? defaultSettings.temperature,
    maxInputTokens: model?.maxInputTokens ?? defaultSettings.maxInputTokens,
    maxTokens: model?.maxTokens ?? defaultSettings.maxTokens,
    thinkingBudget: defaultSettings.thinkingBudget,
    reasoningEffort: model?.reasoningEfforts?.length
      ? normalizeEffort(model.reasoningEffort ?? model.reasoningEfforts[0])
      : undefined,
  }
  // 思考开关是「用户偏好」，不应被模型能力覆盖自动开启。
  // 仅当模型明确不支持思考时才强制关闭，避免用户切到支持模型后思考被意外打开。
  return model?.supportsThinking === false
    ? { ...base, enableThinking: false as boolean }
    : base
}

/** 清空所有生效（派生）字段 —— 避免删光 provider 后残留 baseUrl/apiKey，继续发请求给已删除端点 */
const clearActive = () => ({
  model: '',
  baseUrl: '',
  apiKey: '',
  apiCompat: 'openai' as ApiCompat,
  directFetch: false,
  activeProviderId: undefined,
  activeModelId: undefined,
  reasoningEffort: undefined,
})

/** 在提供商列表里找第一个「有模型」的组合，用于删除后回落 */
const firstAvailable = (providers: ModelProvider[]): { provider: ModelProvider; modelId: string } | null => {
  for (const p of providers) {
    if (p.models.length > 0) return { provider: p, modelId: p.models[0].id }
  }
  return null
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,
      showSettings: false,
      updateSettings: (partial) => set((state) => ({ ...state, ...partial })),
      resetSettings: () => {
        credentialHydrationEpoch += 1
        const providerIds = get().providers.map((provider) => provider.id)
        set({ ...defaultSettings, showSettings: false })
        for (const id of providerIds) {
          void queueApiKeyWrite(id, '').catch((error) => console.error('[settings-store] remove API key failed:', error))
        }
      },

      upsertProvider: (provider) => {
        const previous = get().providers.find((item) => item.id === provider.id)
        if (previous?.apiKey !== provider.apiKey) {
          apiKeyRevisions.set(provider.id, (apiKeyRevisions.get(provider.id) ?? 0) + 1)
          void queueApiKeyWrite(provider.id, provider.apiKey)
            .catch((error) => console.error('[settings-store] save API key failed:', error))
        }
        set((state) => {
        const exists = state.providers.some((p) => p.id === provider.id)
        const providers = exists
          ? state.providers.map((p) => (p.id === provider.id ? provider : p))
          : [...state.providers, provider]
        // 若编辑的正是当前生效提供商，同步刷新派生字段
        if (state.activeProviderId !== provider.id) return { providers }
        // 当前生效模型可能已被移除 → 回落到该提供商第一个模型
        const stillThere = provider.models.some((m) => m.id === state.activeModelId)
        const modelId = stillThere ? state.activeModelId! : provider.models[0]?.id
        if (!modelId) {
          const next = firstAvailable(providers)
          return next
            ? { providers, ...applyActive(next.provider, next.modelId) }
            : { providers, ...clearActive() }
        }
          return { providers, ...applyActive(provider, modelId) }
        })
      },

      removeProvider: (id) => {
        if (get().providers.some((provider) => provider.id === id)) {
          apiKeyRevisions.set(id, (apiKeyRevisions.get(id) ?? 0) + 1)
          void queueApiKeyWrite(id, '').catch((error) => console.error('[settings-store] remove API key failed:', error))
        }
        set((state) => {
        const providers = state.providers.filter((p) => p.id !== id)
        if (state.activeProviderId !== id) return { providers }
        const next = firstAvailable(providers)
        return next
          ? { providers, ...applyActive(next.provider, next.modelId) }
            : { providers, ...clearActive() }
        })
      },

      setProviderModels: (providerId, models) => {
        const p = get().providers.find((x) => x.id === providerId)
        if (p) get().upsertProvider({ ...p, models })
      },

      removeProviderModel: (providerId, modelId) => {
        const p = get().providers.find((x) => x.id === providerId)
        if (p) get().upsertProvider({ ...p, models: p.models.filter((m) => m.id !== modelId) })
      },

      activateModel: (providerId, modelId) => {
        const p = get().providers.find((x) => x.id === providerId)
        if (p) set(applyActive(p, modelId))
      },
    }),
    {
      name: 'clerkbox-settings',
      partialize: (state) => {
        // Keep credentials only in Electron's OS-backed safeStorage.
        const { showSettings: _, apiKey: _apiKey, providers, customModels, ...rest } = state
        const keepBrowserCredentials = !credentialStorageReady
        return {
          ...rest,
          apiKey: keepBrowserCredentials ? state.apiKey : '',
          providers: providers.map((provider) => ({
            ...provider,
            apiKey: keepBrowserCredentials ? provider.apiKey : '',
          })),
          customModels: customModels.map((model) => ({
            ...model,
            apiKey: keepBrowserCredentials ? model.apiKey : '',
          })),
        }
      },
      // 旧版本没有 maxInputTokens 时补默认，避免 undefined 贯穿运行时
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppSettings>
        return {
          ...current,
          ...p,
          maxInputTokens: p.maxInputTokens ?? defaultSettings.maxInputTokens,
          maxTokens: p.maxTokens ?? defaultSettings.maxTokens,
          temperature: p.temperature ?? defaultSettings.temperature,
        }
      },
    }
  )
)

/**
 * 老用户迁移：把扁平的 customModels 按 baseUrl 归并成 providers。
 *
 * - 只跑一次（providersMigratedAt 作标记）
 * - **不删除** customModels，万一有问题旧数据还在
 * - 若连 customModels 都没有，但已有生效的 model/baseUrl，则种子化成一个提供商
 */
export function migrateProvidersIfNeeded() {
  const s = useSettingsStore.getState()
  if (s.providersMigratedAt) return
  if (s.providers.length > 0) {
    useSettingsStore.setState({ providersMigratedAt: Date.now() })
    return
  }

  // 数据源：优先用 customModels；为空则用当前生效字段种子化一条
  const source: CustomModel[] = s.customModels.length > 0
    ? s.customModels
    : s.model.trim() && s.baseUrl.trim()
      ? [{ id: `seed-${Date.now()}`, label: s.model, model: s.model, baseUrl: s.baseUrl, apiKey: s.apiKey }]
      : []

  if (source.length === 0) {
    useSettingsStore.setState({ providersMigratedAt: Date.now() })
    return
  }

  // 按 baseUrl 分组（同一平台的多个模型归到一个提供商下）
  const byBaseUrl = new Map<string, CustomModel[]>()
  for (const m of source) {
    const key = m.baseUrl.trim().replace(/\/+$/, '')
    const list = byBaseUrl.get(key)
    if (list) list.push(m)
    else byBaseUrl.set(key, [m])
  }

  const providers: ModelProvider[] = []
  let activeProviderId: string | undefined
  let activeModelId: string | undefined

  let i = 0
  for (const [baseUrl, models] of byBaseUrl) {
    const preset = guessPresetByBaseUrl(baseUrl)
    // 协议判定：预设匹配上就用预设的（altCompat 命中则用 alt 的协议），否则从 URL 猜
    let apiCompat: ApiCompat
    if (preset) {
      const altHit = preset.altCompat && baseUrl.replace(/\/+$/, '') === preset.altCompat.baseUrl.replace(/\/+$/, '')
      apiCompat = altHit ? preset.altCompat!.apiCompat : preset.apiCompat
    } else {
      apiCompat = guessApiCompat(baseUrl)
    }

    const providerId = `p-${Date.now()}-${i++}`
    // apiKey 取组内第一个非空的
    const apiKey = models.find((m) => m.apiKey.trim())?.apiKey || ''

    // 模型去重：同一个 model id 只保留一条，别名取第一个跟 id 不同的 label
    const seen = new Map<string, ProviderModel>()
    for (const m of models) {
      if (seen.has(m.model)) continue
      const label = m.label.trim() && m.label.trim() !== m.model ? m.label.trim() : undefined
      seen.set(m.model, { id: m.model, label })
    }

    providers.push({
      id: providerId,
      name: preset?.name || fallbackNameFromBaseUrl(baseUrl),
      presetId: preset && preset.group !== 'custom' ? preset.id : undefined,
      apiCompat,
      baseUrl,
      apiKey,
      models: [...seen.values()],
    })

    // 保持原来的生效项
    const wasActive = models.find((m) => m.id === s.activeCustomModelId)
    if (wasActive) {
      activeProviderId = providerId
      activeModelId = wasActive.model
    }
  }

  // 原来没有生效标记（或没匹配上）→ 回落到第一个
  if (!activeProviderId) {
    const first = firstAvailable(providers)
    if (first) {
      activeProviderId = first.provider.id
      activeModelId = first.modelId
    }
  }

  const active = providers.find((p) => p.id === activeProviderId)
  useSettingsStore.setState({
    providers,
    providersMigratedAt: Date.now(),
    ...(active && activeModelId ? applyActive(active, activeModelId) : {}),
  })
}

/** Restore encrypted provider credentials after Zustand hydrates non-secret settings. */
export async function hydrateProviderApiKeys(): Promise<void> {
  const state = useSettingsStore.getState()
  const revisionSnapshot = new Map(apiKeyRevisions)
  const hydrationEpoch = credentialHydrationEpoch
  let encryptedKeys: Record<string, string>
  try {
    encryptedKeys = await ipc.loadApiKeys()
  } catch (error) {
    console.error('[settings-store] load API keys failed:', error)
    return
  }

  const keysToMigrate: Array<[string, string]> = []
  const providers = state.providers.map((provider) => {
    const legacyKey = provider.apiKey || (provider.id === state.activeProviderId ? state.apiKey : '')
    const apiKey = encryptedKeys[provider.id] ?? legacyKey
    if (!encryptedKeys[provider.id] && legacyKey) keysToMigrate.push([provider.id, legacyKey])
    return { ...provider, apiKey }
  })

  try {
    if (hydrationEpoch !== credentialHydrationEpoch) return
    await Promise.all(keysToMigrate.map(([id, apiKey]) => queueApiKeyWrite(id, apiKey)))
  } catch (error) {
    // Preserve the legacy browser copy until the OS-backed migration succeeds.
    console.error('[settings-store] migrate API keys failed:', error)
    return
  }

  if (hydrationEpoch !== credentialHydrationEpoch) return

  const latest = useSettingsStore.getState()
  const latestProviders = latest.providers.map((provider) => {
    const initial = state.providers.find((item) => item.id === provider.id)
    const keyChangedDuringHydration = (apiKeyRevisions.get(provider.id) ?? 0) !== (revisionSnapshot.get(provider.id) ?? 0)
    if (keyChangedDuringHydration) return provider
    const legacyKey = provider.apiKey || (provider.id === latest.activeProviderId ? latest.apiKey : '')
    return { ...provider, apiKey: encryptedKeys[provider.id] ?? legacyKey }
  })
  const activeProvider = latestProviders.find((provider) => provider.id === latest.activeProviderId)
  for (const provider of latestProviders) {
    if ((apiKeyRevisions.get(provider.id) ?? 0) !== (revisionSnapshot.get(provider.id) ?? 0)) {
      void queueApiKeyWrite(provider.id, provider.apiKey)
        .catch((error) => console.error('[settings-store] save API key failed:', error))
    }
  }
  credentialStorageReady = true
  useSettingsStore.setState({
    providers: latestProviders,
    apiKey: activeProvider?.apiKey ?? '',
    customModels: latest.customModels.map((model) => ({ ...model, apiKey: '' })),
  })
}
