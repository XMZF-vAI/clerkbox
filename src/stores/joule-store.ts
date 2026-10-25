import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { ipc, isWebUIMode } from '../lib/ipc-client'
import { sharedStorage } from '../lib/shared-storage'
import { mergeJouleModels } from '../lib/joule-models'
import { useSettingsStore } from './settings-store'
import type { ModelProvider, ProviderModel } from '../types/agent'
import type {
  JouleDesktop,
  JouleExpired,
  JouleModel,
  JoulePlan,
  JoulePromo,
  JouleQuotas,
  JouleStateSnapshot,
  JouleStatus,
  JouleSubscription,
  JouleUser,
} from '../types/joule'

/**
 * Joule 账号的渲染层状态。
 *
 * - Key 永不进入本 store / 持久化 / localStorage：只有 settings-store 的 Joule Provider
 *   内存字段持有它，落盘由 safeStorage 唯一负责。
 * - 主进程是账号状态的唯一事实来源（设备码轮询、额度刷新都在主进程），
 *   这里只订阅快照并处理两件事：模型目录合并、订阅过期时回落到自定义模型。
 */

const JOULE_PROVIDER_ID = 'joule'
const JOULE_BASE_URL = 'https://joule.xmzf.space/v1'

interface JouleStoreState {
  status: JouleStatus
  user: JouleUser | null
  subscription: JouleSubscription | null
  expired: JouleExpired | null
  plan: JoulePlan | null
  quotas: JouleQuotas | null
  desktop: JouleDesktop | null
  promo: JoulePromo | null
  lastSyncAt: number | null
  stale: boolean
  error: string | null
  /** 订阅过期自动回落时的一次性提示（i18n key） */
  notice: string | null
  /** 设备码登录进行中（瞬时） */
  loggingIn: boolean
  userCode: string | null
  loginExpiresAt: number | null
  verificationUri: string | null
  initialized: boolean

  /** 启动订阅主进程快照；返回退订函数 */
  init: () => () => void
  login: () => Promise<void>
  cancelLogin: () => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  dismissNotice: () => void
}

const emptyAccount = {
  status: 'unlinked' as JouleStatus,
  user: null,
  subscription: null,
  expired: null,
  plan: null,
  quotas: null,
  desktop: null,
  promo: null,
  lastSyncAt: null,
  stale: false,
  error: null,
}

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

let unsubscribeState: (() => void) | null = null
let activateWhenReady = false
let fellBackFromJoule = false
let syncingModels = false

function jouleProviderFrom(models: ProviderModel[], key: string): ModelProvider {
  return {
    id: JOULE_PROVIDER_ID,
    name: 'Joule',
    presetId: JOULE_PROVIDER_ID,
    apiCompat: 'openai',
    baseUrl: JOULE_BASE_URL,
    apiKey: key,
    models,
  }
}

/** 目录刷新：按 id 合并，保留用户对已有模型的参数覆盖；新增/删除以服务端为准。 */
function syncModelsFromSnapshot(models: JouleModel[] | undefined): void {
  if (!models || syncingModels) return
  syncingModels = true
  try {
    const settings = useSettingsStore.getState()
    const provider = settings.providers.find((item) => item.id === JOULE_PROVIDER_ID)
    if (!provider) {
      // 首次启动时 Provider 可能被清空：Key 在 safeStorage，取回来重建，避免账号已连接却没有模型菜单
      void ipc
        .loadApiKeys()
        .then((keys) => {
          const key = keys[JOULE_PROVIDER_ID]
          if (!key) return
          const latest = useSettingsStore.getState().providers.find((item) => item.id === JOULE_PROVIDER_ID)
          if (latest) return
          useSettingsStore.getState().upsertProvider(jouleProviderFrom(mergeJouleModels([], models), key))
          maybeActivateJoule()
        })
        .catch(() => {
          // 凭据不可读时保持现状；下次快照会再试
        })
      return
    }
    const merged = mergeJouleModels(provider.models, models)
    if (JSON.stringify(merged) !== JSON.stringify(provider.models)) {
      settings.setProviderModels(JOULE_PROVIDER_ID, merged)
    }
    maybeActivateJoule()
  } finally {
    syncingModels = false
  }
}

function maybeActivateJoule(): void {
  if (!activateWhenReady) return
  const account = useJouleStore.getState()
  if (!account.plan) return
  const provider = useSettingsStore.getState().providers.find((item) => item.id === JOULE_PROVIDER_ID)
  if (!provider || provider.models.length === 0) return
  useSettingsStore.getState().activateModel(JOULE_PROVIDER_ID, provider.models[0].id)
  activateWhenReady = false
}

/** 订阅过期：当前若停在 Joule，回落到第一个有模型的自定义供应商，并提示一次。 */
function handleStatusTransition(previous: JouleStatus, next: JouleStatus): void {
  if (next === 'expired' && previous !== 'expired') {
    const settings = useSettingsStore.getState()
    if (settings.activeProviderId !== JOULE_PROVIDER_ID) return
    const fallback = settings.providers.find((p) => p.id !== JOULE_PROVIDER_ID && p.models.length > 0)
    if (fallback) {
      settings.activateModel(fallback.id, fallback.models[0].id)
      fellBackFromJoule = true
      useJouleStore.setState({ notice: 'joule.noticeExpiredFallback' })
    } else {
      useSettingsStore.setState({
        model: '',
        baseUrl: '',
        apiKey: '',
        activeProviderId: undefined,
        activeModelId: undefined,
      })
      fellBackFromJoule = true
      useJouleStore.setState({ notice: 'joule.noticeNoModel' })
    }
    return
  }

  if (previous === 'expired' && next === 'connected' && fellBackFromJoule) {
    const account = useJouleStore.getState()
    const provider = useSettingsStore.getState().providers.find((item) => item.id === JOULE_PROVIDER_ID)
    if (account.plan && provider && provider.models.length > 0) {
      useSettingsStore.getState().activateModel(JOULE_PROVIDER_ID, provider.models[0].id)
      fellBackFromJoule = false
    }
  }
}

function applySnapshot(snapshot: JouleStateSnapshot | null | undefined): void {
  if (!snapshot) return
  const previous = useJouleStore.getState().status
  const login = snapshot.login
  useJouleStore.setState({
    status: snapshot.status,
    user: snapshot.user,
    subscription: snapshot.subscription,
    expired: snapshot.expired,
    plan: snapshot.plan,
    quotas: snapshot.quotas,
    desktop: snapshot.desktop,
    promo: snapshot.promo ?? null,
    lastSyncAt: snapshot.lastSyncAt,
    stale: snapshot.stale,
    error: snapshot.error,
    userCode: login ? login.userCode : null,
    loginExpiresAt: login ? login.expiresAt : null,
    verificationUri: login ? login.verificationUri : null,
  })
  if (snapshot.models) syncModelsFromSnapshot(snapshot.models)
  if (previous !== snapshot.status) handleStatusTransition(previous, snapshot.status)
}

export const useJouleStore = create<JouleStoreState>()(
  persist(
    (set, get) => ({
      ...emptyAccount,
      notice: null,
      loggingIn: false,
      userCode: null,
      loginExpiresAt: null,
      verificationUri: null,
      initialized: false,

      init: () => {
        set({ initialized: true })
        if (isWebUIMode) return () => {}
        // StrictMode 开发模式会「挂载 → 清理 → 再挂载」：不因 initialized 提前返回，
        // 否则第一次清理退订后第二次不会再订阅。
        if (!unsubscribeState) {
          unsubscribeState = ipc.onJouleState((snapshot) => applySnapshot(snapshot))
        }
        void ipc
          .jouleGetState()
          .then((snapshot) => applySnapshot(snapshot))
          .catch(() => {
            // 主进程尚未就绪：保留持久化的旧快照，后续推送会修正
          })
        return () => {
          unsubscribeState?.()
          unsubscribeState = null
        }
      },

      login: async () => {
        if (get().loggingIn) return
        set({ loggingIn: true, error: null, notice: null })
        try {
          const result = await ipc.jouleStartLogin()
          if (result.cancelled) return
          if (result.error || !result.key) {
            set({ error: result.error || '登录失败，请重试' })
            return
          }
          const models = mergeJouleModels([], result.models ?? [])
          useSettingsStore.getState().upsertProvider(jouleProviderFrom(models, result.key))
          if (result.account) {
            applySnapshot(result.account)
          } else {
            set({ status: 'connected', stale: true })
          }
          if (result.account?.plan && models.length > 0) {
            useSettingsStore.getState().activateModel(JOULE_PROVIDER_ID, models[0].id)
          } else {
            activateWhenReady = true
            maybeActivateJoule()
          }
        } catch (error) {
          set({ error: errMsg(error) })
        } finally {
          set({ loggingIn: false, userCode: null, loginExpiresAt: null, verificationUri: null })
        }
      },

      cancelLogin: async () => {
        try {
          await ipc.jouleCancelLogin()
        } catch (error) {
          set({ error: errMsg(error) })
        }
      },

      logout: async () => {
        try {
          await ipc.jouleLogout()
        } catch (error) {
          console.error('[joule-store] logout failed:', error)
        }
        useSettingsStore.getState().removeProvider(JOULE_PROVIDER_ID)
        activateWhenReady = false
        fellBackFromJoule = false
        set({ ...emptyAccount, notice: null, loggingIn: false, userCode: null, loginExpiresAt: null, verificationUri: null })
      },

      refresh: async () => {
        if (isWebUIMode) return
        try {
          const snapshot = await ipc.jouleRefresh()
          applySnapshot(snapshot)
        } catch (error) {
          set({ error: errMsg(error) })
        }
      },

      dismissNotice: () => set({ notice: null }),
    }),
    {
      name: 'clerkbox-joule',
      storage: sharedStorage,
      partialize: (state) => {
        const {
          loggingIn: _l,
          userCode: _c,
          loginExpiresAt: _e,
          verificationUri: _u,
          initialized: _i,
          notice: _n,
          ...rest
        } = state
        return rest
      },
    },
  ),
)
