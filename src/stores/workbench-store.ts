import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useAgentRunsStore } from './agent-runs-store'
import { ipc } from '../lib/ipc-client'

/** 右侧工作台面板种类。subagent 无用户入口，仅随聊天中的卡片点击打开 */
export type WorkbenchTabKind = 'files' | 'terminal' | 'browser' | 'subagent'

/** 一个已打开的工作台标签页 */
export interface WorkbenchTab {
  /** 全局唯一 id；files/browser 固定单例 id，terminal/subagent 各自唯一 */
  id: string
  kind: WorkbenchTabKind
  /** 仅 subagent 使用：所属会话与对应 run */
  sessionId?: string
  runId?: string
  /** 仅 subagent 使用：标签展示名（agentName），打开时快照 */
  title?: string
}

const FILES_TAB_ID = 'files'
const BROWSER_TAB_ID = 'browser'

const MIN_WIDTH = 300
const MAX_WIDTH = 760

export function clampWorkbenchWidth(w: number): number {
  const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.7)))
  return Math.min(max, Math.max(MIN_WIDTH, Math.round(w)))
}

interface WorkbenchState {
  visible: boolean
  width: number
  tabs: WorkbenchTab[]
  activeTabId: string | null
  /** 终端自增序号，保证多终端 tab id 不冲突 */
  terminalSeq: number

  setVisible: (v: boolean) => void
  toggleVisible: () => void
  setWidth: (w: number) => void
  /** 打开（或聚焦）文件面板；WebUI 模式下是否可用由调用方菜单过滤 */
  openFiles: () => void
  /** 每次新建一个独立终端标签页 */
  openTerminal: () => void
  /** 单例浏览器面板 */
  openBrowser: () => void
  /**
   * 子 Agent 详情的唯一打开入口（聊天中的卡片点击）。
   * 已存在该 run 的标签 → 聚焦它；若其本就是当前激活标签则视为「再点一次关闭」。
   */
  toggleSubAgent: (sessionId: string, runId: string, agentName: string) => void
  /** 关闭标签：终端会同步杀掉 PTY；子 Agent 会同步取消卡片选中态 */
  closeTab: (id: string) => void
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set, get) => ({
      visible: false,
      width: 460,
      tabs: [],
      activeTabId: null,
      terminalSeq: 0,

      setVisible: (v) => set({ visible: v }),
      toggleVisible: () => set((s) => ({ visible: !s.visible })),
      setWidth: (w) => set({ width: clampWorkbenchWidth(w) }),

      openFiles: () =>
        set((s) => ({
          visible: true,
          tabs: s.tabs.some((t) => t.kind === 'files')
            ? s.tabs
            : [...s.tabs, { id: FILES_TAB_ID, kind: 'files' }],
          activeTabId: FILES_TAB_ID,
        })),

      openTerminal: () =>
        set((s) => {
          const seq = s.terminalSeq + 1
          const id = `terminal-${seq}`
          return { visible: true, terminalSeq: seq, tabs: [...s.tabs, { id, kind: 'terminal' }], activeTabId: id }
        }),

      openBrowser: () =>
        set((s) => ({
          visible: true,
          tabs: s.tabs.some((t) => t.kind === 'browser')
            ? s.tabs
            : [...s.tabs, { id: BROWSER_TAB_ID, kind: 'browser' }],
          activeTabId: BROWSER_TAB_ID,
        })),

      toggleSubAgent: (sessionId, runId, agentName) => {
        const id = `subagent:${sessionId}:${runId}`
        const existing = get().tabs.find((t) => t.id === id)
        if (!existing) {
          // 新开：建标签、激活、显示面板，并同步卡片选中态
          useAgentRunsStore.getState().selectRun(runId)
          set((s) => ({ visible: true, tabs: [...s.tabs, { id, kind: 'subagent', sessionId, runId, title: agentName }], activeTabId: id }))
          return
        }
        // 已是该激活标签 → 再点一次=关闭
        if (get().activeTabId === id && get().visible) {
          get().closeTab(id)
          return
        }
        // 存在但未激活 → 仅聚焦，不改变关闭语义
        useAgentRunsStore.getState().selectRun(runId)
        set({ visible: true, activeTabId: id })
      },

      closeTab: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id)
          if (idx === -1) return s
          const tab = s.tabs[idx]
          const tabs = s.tabs.filter((t) => t.id !== id)

          // 终端标签关闭时回收 PTY 进程
          if (tab.kind === 'terminal') void ipc.ptyKill(tab.id).catch(() => {})

          // 子 Agent 标签关闭时清除聊天卡片的选中高亮
          if (tab.kind === 'subagent' && tab.runId && useAgentRunsStore.getState().selectedRunId === tab.runId) {
            useAgentRunsStore.getState().selectRun(null)
          }

          // 激活态交接：优先激活被关标签的邻居，空了回到空态（面板保持展开）
          let activeTabId = s.activeTabId
          if (s.activeTabId === id) {
            activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null
          }
          return { tabs, activeTabId }
        }),
    }),
    {
      name: 'clerkbox-workbench',
      partialize: (s) => ({ width: s.width }) as Pick<WorkbenchState, 'width'>,
    }
  )
)
