import { create } from 'zustand'
import { ipc, isWebUIMode } from '../lib/ipc-client'
import { useChatStore } from './chat-store'
import type { UpdaterState } from '../types/ipc'

/**
 * 自动更新状态（TitleBar 版本号标签的数据源）。
 *
 * 主进程 updater 是状态机持有方，本 store 只做两件事：
 * 1. 镜像主进程推送/拉取的 UpdaterState 快照；
 * 2. agent 心跳上报——streaming 状态变化即时上报 + 每 30s 定时上报，
 *    主进程 90s 收不到心跳即视为空闲（agent loop 在渲染进程跑，渲染挂了 agent 必死，自洽）。
 */
interface UpdaterStoreState {
  state: UpdaterState | null
  /** 手动检查中（防重复点击标签触发并发检测） */
  checking: boolean
  /** 订阅主进程推送 + 首次拉取 + 心跳上报；返回清理函数（App 卸载时调用） */
  init: () => () => void
  /** 标签点击触发的手动检查 */
  checkNow: () => Promise<void>
}

export const useUpdaterStore = create<UpdaterStoreState>((set, get) => ({
  state: null,
  checking: false,

  init: () => {
    if (isWebUIMode) return () => {}

    // 订阅主进程状态推送（下载进度/就绪等任何变化全量推送）
    const offState = ipc.onUpdateState((s) => set({ state: s }))

    // 拉初始状态（顺带触发首次检测，比主进程 30s 定时器更早拿到结果）
    void ipc.updateCheck().then((s) => set({ state: s })).catch(() => {})

    // agent 活跃心跳：streaming 变化即时上报 + 30s 定时兜底
    let lastReported: boolean | null = null
    const report = (active: boolean) => {
      if (active === lastReported) return
      lastReported = active
      ipc.updateAgentActivity(active)
    }
    const currentActive = () => useChatStore.getState().streamingSessionIds.size > 0
    report(currentActive())
    const unsubChat = useChatStore.subscribe((s, prev) => {
      if (s.streamingSessionIds !== prev.streamingSessionIds) report(currentActive())
    })
    const timer = window.setInterval(() => report(currentActive()), 30_000)

    return () => {
      offState()
      unsubChat()
      window.clearInterval(timer)
    }
  },

  checkNow: async () => {
    if (get().checking) return
    set({ checking: true })
    try {
      const s = await ipc.updateCheck()
      set({ state: s })
    } catch {
      /* 检测失败静默忽略，保持现有显示 */
    } finally {
      set({ checking: false })
    }
  },
}))
