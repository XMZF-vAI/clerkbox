import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { ipc } from '../lib/ipc-client'
import { sharedStorage } from '../lib/shared-storage'
import { useSettingsStore } from './settings-store'
// 账号系统 IPC 契约类型统一从 types/ipc 引入（主进程 / preload / ipc-client 同源）
import type { AccountSyncKind, DownloadedModelConfig, RtUser } from '../types/ipc'

interface AccountState {
  loggedIn: boolean
  user?: RtUser
  /** 同步全局记忆开关（默认开） */
  syncMemory: boolean
  /** 同步模型配置开关（默认开） */
  syncModels: boolean
  /** 自动同步开关（默认关：启动时下载 + 本地变更后 debounce 上传） */
  autoSync: boolean
  lastSyncAt: { memory?: number; models?: number }
  /** 同步进行态（瞬时，不持久化） */
  syncing: 'idle' | 'uploading' | 'downloading'
  /** 登录进行中（瞬时，不持久化） */
  loggingIn: boolean
  lastError?: string
  /** init 幂等标志：防 React StrictMode 双调用（瞬时，不持久化） */
  initialized: boolean

  /** 启动初始化：恢复登录态 + lastSyncAt，挂 providers 自动上传订阅，按需自动下载 */
  init: () => Promise<void>
  /** 发起登录（浏览器授权流程），成功后刷新登录态 */
  login: () => Promise<void>
  /** 退出登录（云端数据保留） */
  logout: () => Promise<void>
  setSyncMemory: (v: boolean) => void
  setSyncModels: (v: boolean) => void
  setAutoSync: (v: boolean) => void
  /** 上传开启的同步项（内部供自动上传时仅传 ['models']） */
  upload: (kinds?: AccountSyncKind[]) => Promise<void>
  /** 下载；force=true 跳过新者比较直接覆盖本地 */
  download: (force: boolean) => Promise<void>
  /** 自动同步下载：force=false，被 skip 的项静默 */
  autoDownload: () => Promise<void>
}

/** 统一错误信息提取 */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 按开关收集启用的同步项 */
function enabledKinds(s: AccountState): AccountSyncKind[] {
  const kinds: AccountSyncKind[] = []
  if (s.syncMemory) kinds.push('memory')
  if (s.syncModels) kinds.push('models')
  return kinds
}

// ── 头像颜色：username 首字符 hash 到预设色 ──
const AVATAR_COLORS = [
  '#F06292', '#BA68C8', '#7986CB', '#64B5F6',
  '#4DB6AC', '#AED581', '#FFB74D', '#FF8A65',
]

/** 用户名首字母（大写），用于圆形头像 */
export function initialOf(username: string): string {
  const ch = username.trim()[0]
  return ch ? ch.toUpperCase() : '?'
}

/** username 首字符 hash 到一组预设头像背景色 */
export function avatarColorFor(username: string): string {
  const code = username.trim().codePointAt(0) ?? 0
  return AVATAR_COLORS[code % AVATAR_COLORS.length]
}

// ── providers 变化 → 自动上传（debounce 8s，仅 models）──
let providersWatchMounted = false
let autoUploadTimer: ReturnType<typeof setTimeout> | null = null
/** providers 内容快照（JSON 串浅比较），也用于下载应用配置后抑制一次误触发 */
let lastProvidersSnapshot = ''

function scheduleModelsAutoUpload(delayMs = 8000): void {
  if (autoUploadTimer) clearTimeout(autoUploadTimer)
  autoUploadTimer = setTimeout(() => {
    autoUploadTimer = null
    // 触发时再校验一次条件（期间可能已登出/关开关）
    const a = useAccountStore.getState()
    if (!(a.autoSync && a.syncModels && a.loggedIn)) return
    void a.upload(['models'])
  }, delayMs)
}

/** 挂订阅：settings-store 的 providers 变化时按条件自动上传模型段 */
function mountProvidersAutoUpload(): void {
  if (providersWatchMounted) return
  providersWatchMounted = true
  // 首次快照后再订阅，避免初始化 hydrate 阶段误触发
  lastProvidersSnapshot = JSON.stringify(useSettingsStore.getState().providers)
  useSettingsStore.subscribe((state, prevState) => {
    // 引用未变则必然没动 providers
    if (state.providers === prevState.providers) return
    const snapshot = JSON.stringify(state.providers)
    if (snapshot === lastProvidersSnapshot) return
    lastProvidersSnapshot = snapshot
    const account = useAccountStore.getState()
    if (!(account.autoSync && account.syncModels && account.loggedIn)) return
    scheduleModelsAutoUpload()
  })
}

/**
 * 应用云端下载的模型配置：
 * providers 写入 settings store → 各 apiKey 写回加密凭据存储 → 激活模型派生字段刷新
 */
export async function applyModelConfig(cfg: DownloadedModelConfig): Promise<void> {
  // 先同步快照，避免本次 setState 触发"providers 变化 → 自动上传"回环
  lastProvidersSnapshot = JSON.stringify(cfg.providers)
  useSettingsStore.setState({ providers: cfg.providers })
  for (const p of cfg.providers) {
    if (!p.apiKey) continue // 空 key 跳过
    try {
      await ipc.saveApiKey(p.id, p.apiKey)
    } catch (error) {
      console.error('[account-store] save API key failed:', error)
    }
  }
  if (cfg.activeProviderId && cfg.activeModelId) {
    useSettingsStore.getState().activateModel(cfg.activeProviderId, cfg.activeModelId)
  }
}

export const useAccountStore = create<AccountState>()(
  persist(
    (set, get) => ({
      loggedIn: false,
      user: undefined,
      syncMemory: true,
      syncModels: true,
      autoSync: false,
      lastSyncAt: {},
      syncing: 'idle',
      loggingIn: false,
      lastError: undefined,
      initialized: false,

      init: async () => {
        if (get().initialized) return
        set({ initialized: true })
        // 等待本 store 自身水合完成，避免 accountGetStatus 的结果被持久化水合覆盖
        if (!useAccountStore.persist.hasHydrated()) {
          await new Promise<void>((resolve) => {
            const unsub = useAccountStore.persist.onFinishHydration(() => {
              unsub()
              resolve()
            })
          })
        }
        try {
          // 主进程为登录态唯一事实来源（token 校验），以此恢复登录态 + lastSyncAt
          const status = await ipc.accountGetStatus()
          set({
            loggedIn: status.loggedIn,
            user: status.user,
            lastSyncAt: status.lastSyncAt ?? {},
          })
        } catch (error) {
          // 主进程账户模块尚未就绪时静默降级为未登录态
          console.error('[account-store] get status failed:', error)
        }
        mountProvidersAutoUpload()
        // 自动同步：启动后静默下载一次（新者比较在主进程，被 skip 的项静默）
        const s = get()
        if (s.autoSync && s.loggedIn) void s.autoDownload()
      },

      login: async () => {
        if (get().loggingIn) return
        set({ loggingIn: true, lastError: undefined })
        try {
          const res = await ipc.accountLogin()
          if ('error' in res) {
            set({ lastError: res.error })
          } else {
            set({
              loggedIn: res.status.loggedIn,
              user: res.status.user,
              lastSyncAt: res.status.lastSyncAt ?? {},
            })
          }
        } catch (error) {
          set({ lastError: errMsg(error) })
        } finally {
          set({ loggingIn: false })
        }
      },

      logout: async () => {
        try {
          // accountLogout 返回 Promise<void>，主进程清理登录态后本地重置即可
          await ipc.accountLogout()
        } catch (error) {
          console.error('[account-store] logout failed:', error)
        }
        // 无论主进程是否成功都回到未登录态（云端数据保留）
        set({ loggedIn: false, user: undefined, lastSyncAt: {}, lastError: undefined })
      },

      setSyncMemory: (v) => set({ syncMemory: v }),
      setSyncModels: (v) => set({ syncModels: v }),
      setAutoSync: (v) => set({ autoSync: v }),

      upload: async (kinds) => {
        const s = get()
        if (!s.loggedIn || s.syncing !== 'idle') return
        const finalKinds = kinds ?? enabledKinds(s)
        if (finalKinds.length === 0) return
        set({ syncing: 'uploading', lastError: undefined })
        try {
          const { results } = await ipc.accountSyncUpload(finalKinds)
          const lastSyncAt = { ...get().lastSyncAt }
          let lastError: string | undefined
          for (const r of results) {
            if (!r.ok && r.error && !lastError) lastError = r.error
            // 被跳过的项不算完成，不写回时间
            if (r.ok && !r.skipped) lastSyncAt[r.kind] = Date.now()
          }
          set({ lastSyncAt, lastError })
        } catch (error) {
          set({ lastError: errMsg(error) })
        } finally {
          set({ syncing: 'idle' })
        }
      },

      download: async (force) => {
        const s = get()
        if (!s.loggedIn || s.syncing !== 'idle') return
        const kinds = enabledKinds(s)
        if (kinds.length === 0) return
        set({ syncing: 'downloading', lastError: undefined })
        try {
          const { results, models } = await ipc.accountSyncDownload(kinds, force)
          if (models && kinds.includes('models')) await applyModelConfig(models)
          const lastSyncAt = { ...get().lastSyncAt }
          let lastError: string | undefined
          for (const r of results) {
            // 被跳过的项（skipped）不视为错误，也不写回时间
            if (!r.ok && !r.skipped && r.error && !lastError) lastError = r.error
            if (r.ok && !r.skipped) lastSyncAt[r.kind] = Date.now()
          }
          set({ lastSyncAt, lastError })
        } catch (error) {
          set({ lastError: errMsg(error) })
        } finally {
          set({ syncing: 'idle' })
        }
      },

      autoDownload: async () => {
        // force=false：主进程按"新者优先"判断，云端不较新则 skip（静默）
        await get().download(false)
      },
    }),
    {
      name: 'clerkbox-account',
      storage: sharedStorage,
      partialize: (state) => {
        // 瞬时态不持久化：同步中 / 登录中 / 错误 / 初始化标志
        const { syncing: _s, loggingIn: _l, lastError: _e, initialized: _i, ...rest } = state
        return rest
      },
    },
  )
)
