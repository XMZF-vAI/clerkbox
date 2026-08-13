import { createJSONStorage, type StateStorage } from 'zustand/middleware'
import { ipc, isWebUIMode } from './ipc-client'

/**
 * 共享持久化存储：把 zustand persist 桥接到主进程 KV 文件，
 * 让 Electron 桌面端与 WebUI 浏览器端读写同一份数据，实现跨模式同步。
 *
 * 设计要点：
 * - KV（主进程 clerkbox-kv.json）是唯一事实来源，主进程用写队列串行化，天然跨模式共享
 * - localStorage 仅作为存量 Electron 用户的迁移来源：KV 为空而 localStorage 有数据时，
 *   首次读取自动迁移进 KV；之后 Electron 模式双写 localStorage 作为本地兜底缓存
 * - WebUI 模式下 localStorage 属于不同 origin、读不到桌面端数据，因此只走 KV
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
    const fromKv = await ipc.kvGet(name).catch(() => null)
    if (fromKv != null) return fromKv
    // KV 为空：可能是存量 Electron 用户，尝试从 localStorage 迁移
    return migrateFromLocalStorage(name)
  },
  setItem: async (name: string, value: string) => {
    await ipc.kvSet(name, value).catch((e) => console.error('[shared-storage] kvSet failed:', e))
    // Electron 模式双写 localStorage 作为本地兜底缓存
    if (!isWebUIMode) {
      try {
        window.localStorage.setItem(name, value)
      } catch {
        /* 忽略配额等异常 */
      }
    }
  },
  removeItem: async (name: string) => {
    await ipc.kvRemove(name).catch(() => {})
    if (!isWebUIMode) {
      try {
        window.localStorage.removeItem(name)
      } catch {
        /* 忽略 */
      }
    }
  },
}

/** 供各 persist store 使用的共享存储实例 */
export const sharedStorage = createJSONStorage(() => kvStateStorage)
