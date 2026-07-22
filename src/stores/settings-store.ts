import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppSettings, CustomModel } from '../types/agent'

interface SettingsState extends AppSettings {
  showSettings: boolean
  updateSettings: (partial: Partial<AppSettings & { showSettings?: boolean }>) => void
  resetSettings: () => void
  /** 添加/更新自定义模型 */
  upsertCustomModel: (model: CustomModel) => void
  /** 删除自定义模型；若删除的是当前生效项，回落到剩余第一项 */
  removeCustomModel: (id: string) => void
  /** 设为当前生效模型：把该模型的 model/baseUrl/apiKey 写入生效字段 */
  activateCustomModel: (id: string) => void
}

const defaultSettings: AppSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.7,
  maxTokens: 8192,
  theme: 'dark',
  colorScheme: 'classic',
  customSeedColor: '#F4A7B9',
  language: 'zh-CN',
  permissionMode: 'craft',
  enableThinking: false,
  thinkingBudget: undefined,
  customModels: [],
  activeCustomModelId: undefined,
  hasCompletedOnboarding: false,
}

/** 把模型的连接信息写入生效字段 */
const applyModel = (m: CustomModel) => ({ model: m.model, baseUrl: m.baseUrl, apiKey: m.apiKey, activeCustomModelId: m.id })

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...defaultSettings,
      showSettings: false,
      updateSettings: (partial) => set((state) => ({ ...state, ...partial })),
      resetSettings: () => set({ ...defaultSettings, showSettings: false }),
      upsertCustomModel: (model) => set((state) => {
        const exists = state.customModels.some((m) => m.id === model.id)
        const customModels = exists
          ? state.customModels.map((m) => (m.id === model.id ? model : m))
          : [...state.customModels, model]
        // 若编辑的正是当前生效模型，同步刷新生效字段
        const patch = state.activeCustomModelId === model.id ? applyModel(model) : {}
        return { customModels, ...patch }
      }),
      removeCustomModel: (id) => set((state) => {
        const customModels = state.customModels.filter((m) => m.id !== id)
        if (state.activeCustomModelId !== id) return { customModels }
        // 删除的是当前项：回落到剩余第一项，否则清空生效标记
        const next = customModels[0]
        return { customModels, ...(next ? applyModel(next) : { activeCustomModelId: undefined }) }
      }),
      activateCustomModel: (id) => {
        const m = get().customModels.find((x) => x.id === id)
        if (m) set(applyModel(m))
      },
    }),
    {
      name: 'clerkbox-settings',
      partialize: (state) => {
        // Don't persist showSettings
        const { showSettings: _, ...rest } = state
        return rest
      },
    }
  )
)

/** 老用户迁移：customModels 为空但已有生效配置时，种子化成第一条 */
export function seedCustomModelsIfEmpty() {
  const s = useSettingsStore.getState()
  if (s.customModels.length > 0 || !s.model.trim()) return
  const seed: CustomModel = {
    id: `seed-${Date.now()}`,
    label: s.model,
    model: s.model,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
  }
  useSettingsStore.setState({ customModels: [seed], activeCustomModelId: seed.id })
}
