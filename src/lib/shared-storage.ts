import { createJSONStorage, type StateStorage } from 'zustand/middleware'
import { ipc, isWebUIMode } from './ipc-client'
import { getRemoteBootstrap, getRemoteStorageScope, isCloudRemoteMode } from '../remote/browser'

const REMOTE_UI_SETTINGS = ['theme', 'appFont', 'uiScale', 'colorScheme', 'customSeedColor', 'language', 'interfaceMode'] as const
function remoteStorageKey(name: string): string { return `clerkbox:remote-state:${getRemoteStorageScope()}:${name}` }
function readRemoteLocal(name: string): string | null {
  try { return window.localStorage.getItem(remoteStorageKey(name)) } catch { return null }
}
function remoteSettings(): string {
  let local: Record<string, unknown> = {}
  try { local = JSON.parse(readRemoteLocal('clerkbox-settings') || '{}').state || {} } catch { /* use bootstrap */ }
  const preferences = Object.fromEntries(REMOTE_UI_SETTINGS.filter(key => key in local).map(key => [key, local[key]]))
  return JSON.stringify({ state: { ...getRemoteBootstrap()?.settings, ...preferences, apiKey: '', hasCompletedOnboarding: true, showSettings: false }, version: 0 })
}

/**
 * 共享持久化存储：把 zustand persist 桥接到主进程 KV 文件，
 * 让 Electron 桌面端与 WebUI 浏览器端读写同一份数据，实现跨模式同步。
 *
 * 设计要点：
 * - KV（主进程 clerkbox-kv.json）是唯一事实来源，主进程用写队列串行化，天然跨模式共享
 * - localStorage 仅作为存量 Electron 用户的迁移来源：KV 为空而 localStorage 有数据时，
 *   首次读取自动迁移进 KV；写入后两种模式都双写 localStorage，但那份只当
 *   「本浏览器缓存」用（供 theme-init.js 首帧取主题，以及桌面端的兜底读），不是事实来源
 * - WebUI 模式下 localStorage 属于不同 origin、读不到桌面端数据，因此真源仍走 KV
 * - API Key 不经过这里（settings-store 的 partialize 已剥离），仍由 safeStorage 加密保管
 */

async function migrateFromLocalStorage(name: string): Promise<string | null> {
  // WebUI 的 localStorage 是独立 origin，没有桌面端数据，无需迁移
  if (isWebUIMode) return null
  try {
    const local = window.localStorage.getItem(name)
    if (local != null) {
      // 迁移进 KV；失败也不阻塞本次读取（返回 local 值即可）
      void ipc.kvSet(name, local).catch(() => {})
      return local
    }
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return null
}

const kvStateStorage: StateStorage = {
  getItem: async (name: string) => {
    if (isCloudRemoteMode()) return name === 'clerkbox-settings' ? remoteSettings() : readRemoteLocal(name)
    const fromKv = await ipc.kvGet(name).catch(() => null)
    if (fromKv != null) return fromKv
    // KV 为空：可能是存量 Electron 用户，尝试从 localStorage 迁移
    return migrateFromLocalStorage(name)
  },
  setItem: async (name: string, value: string) => {
    if (isCloudRemoteMode()) {
      try {
        if (name === 'clerkbox-settings') {
          const parsed = JSON.parse(value)
          const state = parsed?.state || {}
          value = JSON.stringify({ state: Object.fromEntries(REMOTE_UI_SETTINGS.filter(key => key in state).map(key => [key, state[key]])), version: 0 })
        }
        window.localStorage.setItem(remoteStorageKey(name), value)
      } catch { /* storage quota must not trigger a host KV write */ }
      return
    }
    await ipc.kvSet(name, value).catch((e) => console.error('[shared-storage] kvSet failed:', e))
    // 双写 localStorage：真源仍是 KV，这份只是本浏览器的副本。
    // 两个用途：① Electron 侧的本地兜底缓存；② 让 public/theme-init.js 在 React 挂载前
    // 就能读到主题/字号——它读不到 KV（那是异步 IPC），WebUI 里于是曾被强制成默认深色，
    // 恰好是这个文件要防的白闪。WebUI 的 localStorage 是独立 origin，只影响这台浏览器自己。
    try {
      window.localStorage.setItem(name, value)
    } catch {
      /* 忽略配额等异常：真源已经写成功 */
    }
  },
  removeItem: async (name: string) => {
    if (isCloudRemoteMode()) {
      try { window.localStorage.removeItem(remoteStorageKey(name)) } catch { /* local only */ }
      return
    }
    await ipc.kvRemove(name).catch(() => {})
    try {
      window.localStorage.removeItem(name)
    } catch {
      /* 忽略 */
    }
  },
}

/** 供各 persist store 使用的共享存储实例 */
export const sharedStorage = createJSONStorage(() => kvStateStorage)
