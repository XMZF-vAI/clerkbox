import { useLayoutEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useShallow } from 'zustand/react/shallow'
import { useAgentRunsStore } from './agent-runs-store'
import { useChatStore } from './chat-store'
import { ipc } from '../lib/ipc-client'

/** 右侧工作台面板种类。subagent 无用户入口，仅随聊天中的卡片点击打开；git 仅编程模式提供入口 */
export type WorkbenchTabKind = 'files' | 'terminal' | 'browser' | 'agent-browser' | 'subagent' | 'git'

/** 一个已打开的工作台标签页 */
export interface WorkbenchTab {
  /** 分片内唯一 id；files 单例，其余面板可各自打开多个 */
  id: string
  kind: WorkbenchTabKind
  /** 仅 subagent 使用：所属会话与对应 run */
  sessionId?: string
  runId?: string
  /** 仅 subagent 使用：标签展示名（agentName），打开时快照 */
  title?: string
  /** 仅 browser 使用：新标签页首次打开的 URL */
  url?: string
}

const FILES_TAB_ID = 'files'
const AGENT_BROWSER_TAB_ID = 'agent-browser'
const GIT_TAB_ID = 'git'

const MIN_WIDTH = 300
const MAX_WIDTH = 760

/** 呼吸图标的滑动窗口：每条浏览器命令把截止时间推后这么多毫秒。
 *  用窗口而不是布尔 busy 态 —— 一次长任务里命令密集，busy 态要靠事件配对收尾，
 *  漏一个就永久亮着；窗口则天然自愈。 */
export const AGENT_BROWSER_OPERATION_WINDOW_MS = 5_000

export function clampWorkbenchWidth(w: number): number {
  const max = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.7)))
  return Math.min(max, Math.max(MIN_WIDTH, Math.round(w)))
}

/**
 * 一个会话的工作台分片。
 *
 * **为什么按会话隔离**：工作台是「这个对话的辅助工作区」，不是窗口级的全局物。
 * 之前所有分片共用一份全局状态，于是切到新对话时上一个对话的浏览器标签、
 * 终端进程、甚至 Agent 浏览器全都还在 —— 尤其糟糕的是 Agent 浏览器：
 * 它是 AI 操控能力的载体，跨对话残留意味着你在新对话里看到的是上一个任务留下的现场。
 *
 * 切回旧对话会恢复它自己那份分片（不是清空，是切走）。宽度是窗口级偏好，全局共享。
 */
export interface WorkbenchSlice {
  visible: boolean
  tabs: WorkbenchTab[]
  activeTabId: string | null
  /** 终端/浏览器自增序号，保证多标签 id 不冲突 */
  terminalSeq: number
  browserSeq: number
  /** Agent 浏览器的最近一次操作截止时间戳（呼吸图标的 5s 滑动窗口，由主进程事件推进） */
  agentBrowserOperationUntil: number
}

export function emptyWorkbenchSlice(): WorkbenchSlice {
  return {
    visible: false,
    tabs: [],
    activeTabId: null,
    terminalSeq: 0,
    browserSeq: 0,
    agentBrowserOperationUntil: 0,
  }
}

interface WorkbenchState extends WorkbenchSlice {
  width: number
  /** sessionId → 分片 */
  slices: Record<string, WorkbenchSlice>
  /**
   * 分片归属的会话 id。显式持有而不是每次去读 chat store：
   * 渲染层拿它订阅，切换时才知道要换切片；未绑定时所有动作退化为操作当前会话。
   */
  boundSessionId: string | null

  bindSession: (sessionId: string) => void
  setVisible: (v: boolean) => void
  toggleVisible: () => void
  setWidth: (w: number) => void
  /** 打开（或聚焦）文件面板；WebUI 模式下是否可用由调用方菜单过滤 */
  openFiles: () => void
  /** 打开（或聚焦）Git 审查面板（单例，随会话的工作目录） */
  openGit: () => void
  /** 每次新建一个独立终端标签页 */
  openTerminal: () => void
  /** 新建浏览器面板，可选定向到指定 URL */
  openBrowser: (url?: string) => void
  /**
   * 打开（或聚焦）Agent 浏览器标签。
   *
   * **只应由 AI 真的要操控浏览器时调用**（工具层经 IPC 请渲染层打开）。
   * 能力开关打开本身**不**该让这个标签出现 —— 那是「AI 在操控浏览器」这件事的视觉载体，
   * 没有正在操控就不该亮出来。
   *
   * 单例：主进程按分区捕获 guest，多开一个就多一个抢同一个分区，
   * 反而让 `did-attach-webview` 的归属判定变得不确定。
   */
  openAgentBrowser: () => void
  /** 在指定会话分片里打开 Agent 浏览器，且不夺取当前视图（见实现处注释） */
  openAgentBrowserFor: (sessionId: string) => void
  /** 主进程报告「Agent 刚操作了一次浏览器」，把呼吸图标的截止时间推后 5s */
  markAgentBrowserOperation: () => void
  /**
   * 子 Agent 详情的唯一打开入口（聊天中的卡片点击）。
   * 已存在该 run 的标签 → 聚焦它；若其本就是当前激活标签则视为「再点一次关闭」。
   */
  toggleSubAgent: (sessionId: string, runId: string, agentName: string) => void
  /** 聚焦某个标签（点击标签栏）。不存在则忽略 */
  activateTab: (id: string) => void
  /** 关闭标签：终端会同步杀掉 PTY；子 Agent 会同步取消卡片选中态 */
  closeTab: (id: string) => void
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set, get) => {
      /**
       * 对指定会话的分片做一次更新；不传 key 时作用于当前绑定会话。
       * 顶层平铺字段同步镜像一份，组件仍可按字段订阅（useWorkbench 的实现依赖它）。
       */
      const patch = (recipe: (slice: WorkbenchSlice) => WorkbenchSlice, explicitKey?: string): void => {
        const state = get()
        const key = explicitKey ?? state.boundSessionId
        const base = key ? state.slices[key] ?? emptyWorkbenchSlice() : state
        const next = recipe(base)
        if (!key) {
          set(next as unknown as Partial<WorkbenchState>)
          return
        }
        // 只有切到的那个分片需要镜像到顶层：跨会话定向更新时镜像会污染当前视图的订阅值，
        // 而视图本来就该只看自己那份 —— 这里在 useWorkbench 的 selector 里按 boundSessionId 取分片
        set(
          key === state.boundSessionId
            ? { slices: { ...state.slices, [key]: next }, ...next }
            : { slices: { ...state.slices, [key]: next } },
        )
      }

      const current = (): WorkbenchSlice => {
        const state = get()
        const key = state.boundSessionId
        return key ? state.slices[key] ?? emptyWorkbenchSlice() : state
      }

      return {
        ...emptyWorkbenchSlice(),
        width: 460,
        slices: {},
        boundSessionId: null,

        bindSession: (sessionId) => {
          const state = get()
          if (state.boundSessionId === sessionId) return
          set({
            boundSessionId: sessionId,
            ...(state.slices[sessionId] ?? emptyWorkbenchSlice()),
          })
        },

        setVisible: (v) => patch((s) => ({ ...s, visible: v })),
        toggleVisible: () => patch((s) => ({ ...s, visible: !s.visible })),
        setWidth: (w) => set({ width: clampWorkbenchWidth(w) }),

        openFiles: () =>
          patch((s) => ({
            ...s,
            visible: true,
            tabs: s.tabs.some((t) => t.kind === 'files') ? s.tabs : [...s.tabs, { id: FILES_TAB_ID, kind: 'files' }],
            activeTabId: FILES_TAB_ID,
          })),

        openGit: () =>
          patch((s) => ({
            ...s,
            visible: true,
            tabs: s.tabs.some((t) => t.kind === 'git') ? s.tabs : [...s.tabs, { id: GIT_TAB_ID, kind: 'git' }],
            activeTabId: GIT_TAB_ID,
          })),

        openTerminal: () =>
          patch((s) => {
            const seq = s.terminalSeq + 1
            const id = `terminal-${seq}`
            return { ...s, visible: true, terminalSeq: seq, tabs: [...s.tabs, { id, kind: 'terminal' }], activeTabId: id }
          }),

        openBrowser: (url) =>
          patch((s) => {
            const seq = s.browserSeq + 1
            const id = `browser-${seq}`
            return { ...s, visible: true, browserSeq: seq, tabs: [...s.tabs, { id, kind: 'browser', url }], activeTabId: id }
          }),

        openAgentBrowser: () =>
          patch((s) => ({
            ...s,
            visible: true,
            tabs: s.tabs.some((t) => t.kind === 'agent-browser') ? s.tabs : [...s.tabs, { id: AGENT_BROWSER_TAB_ID, kind: 'agent-browser' }],
            activeTabId: AGENT_BROWSER_TAB_ID,
          })),

        /**
         * 在**指定会话**的分片里打开 Agent 浏览器，且不改绑当前会话。
         *
         * 工具层请面板时带的是**正在执行任务的那个会话**的 id。用户完全可能正在看另一个对话
         * —— 那时把标签开在当前视图就是跨会话弹出：面板凭空出现在一个无关对话里，
         * 而真正在跑任务的那个对话反而什么都没有。所以这里只写目标分片，视图不动。
         *
         * 目标会话的 webview 由 WorkbenchPanel 额外挂载（不在可见时区），
         * 保证主进程对该 guest 的 CDP 附着不会因为「用户切走了」而断掉。
         */
        openAgentBrowserFor: (sessionId) => {
          if (get().boundSessionId === sessionId) {
            get().openAgentBrowser()
            return
          }
          patch(
            (s) => ({
              ...s,
              visible: true,
              tabs: s.tabs.some((t) => t.kind === 'agent-browser') ? s.tabs : [...s.tabs, { id: AGENT_BROWSER_TAB_ID, kind: 'agent-browser' }],
              activeTabId: AGENT_BROWSER_TAB_ID,
            }),
            sessionId,
          )
        },

        markAgentBrowserOperation: () =>
          patch((s) => ({ ...s, agentBrowserOperationUntil: Date.now() + AGENT_BROWSER_OPERATION_WINDOW_MS })),

        toggleSubAgent: (sessionId, runId, agentName) => {
          const id = `subagent:${sessionId}:${runId}`
          // 卡片所在的会话就是它自己的归属（卡片只出现在活跃会话里），
          // 所以这里显式切到那个分片，不依赖当前绑定 —— 事件回调里没有 React 上下文可依赖
          if (get().boundSessionId !== sessionId) get().bindSession(sessionId)
          const existing = current().tabs.find((t) => t.id === id)
          if (!existing) {
            // 新开：建标签、激活、显示面板，并同步卡片选中态
            useAgentRunsStore.getState().selectRun(runId)
            patch((s) => ({
              ...s,
              visible: true,
              tabs: [...s.tabs, { id, kind: 'subagent', sessionId, runId, title: agentName }],
              activeTabId: id,
            }))
            return
          }
          // 已是该激活标签 → 再点一次=关闭
          if (current().activeTabId === id && current().visible) {
            get().closeTab(id)
            return
          }
          // 存在但未激活 → 仅聚焦，不改变关闭语义
          useAgentRunsStore.getState().selectRun(runId)
          patch((s) => ({ ...s, visible: true, activeTabId: id }))
        },

        activateTab: (id) =>
          patch((s) => (s.tabs.some((t) => t.id === id) ? { ...s, visible: true, activeTabId: id } : s)),

        closeTab: (id) => {
          const before = current()
          const idx = before.tabs.findIndex((t) => t.id === id)
          if (idx === -1) return
          const tab = before.tabs[idx]
          const tabs = before.tabs.filter((t) => t.id !== id)
          // 终端标签关闭时回收 PTY 进程
          if (tab.kind === 'terminal') void ipc.ptyKill(tab.id).catch(() => {})
          // 子 Agent 标签关闭时清除聊天卡片的选中高亮
          if (tab.kind === 'subagent' && tab.runId && useAgentRunsStore.getState().selectedRunId === tab.runId) {
            useAgentRunsStore.getState().selectRun(null)
          }
          // 激活态交接：优先激活被关标签的邻居，空了回到空态（面板保持展开）
          const activeTabId = before.activeTabId === id ? tabs[Math.min(idx, tabs.length - 1)]?.id ?? null : before.activeTabId
          patch((s) => ({
            ...s,
            tabs,
            activeTabId,
            // 关掉 Agent 浏览器后清空操作窗口：下次重新打开不该继承上一段的「正在操作」，
            // 否则标签刚挂上就亮着呼吸图标，像有人在驱动一个还没加载的页面
            ...(tab.kind === 'agent-browser' ? { agentBrowserOperationUntil: 0 } : {}),
          }))
        },
      }
    },
    {
      name: 'clerkbox-workbench',
      // 只持久化宽度：标签与展开状态是会话运行态，跨启动恢复会带出一堆指向
      // 已不存在的终端进程 / 已失效 Agent 浏览器 guest 的空壳
      partialize: (state) => ({ width: state.width }) as Pick<WorkbenchState, 'width'>,
    }
  )
)

/** 把当前会话绑定为分片归属。用 layout effect 让切换在绘制前落地 */
function useBindSession(sessionId: string | null, bind: (id: string) => void): void {
  useLayoutEffect(() => {
    if (sessionId) bind(sessionId)
  }, [sessionId, bind])
}

/**
 * 组件订阅入口：跟随当前活跃会话返回它自己的分片。
 *
 * 切会话时自动换成新会话的那一份，组件不需要知道会话这个概念。
 */
export function useWorkbench(): WorkbenchSlice & Pick<WorkbenchState, 'width' | 'setVisible' | 'toggleVisible' | 'setWidth' | 'openFiles' | 'openGit' | 'openTerminal' | 'openBrowser' | 'openAgentBrowser' | 'openAgentBrowserFor' | 'markAgentBrowserOperation' | 'toggleSubAgent' | 'activateTab' | 'closeTab'> {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const bind = useWorkbenchStore((s) => s.bindSession)
  const slice = useWorkbenchStore((s) => (s.boundSessionId ? s.slices[s.boundSessionId] : undefined))
  const actions = useWorkbenchStore(
    useShallow((s) => ({
      width: s.width,
      setVisible: s.setVisible,
      toggleVisible: s.toggleVisible,
      setWidth: s.setWidth,
      openFiles: s.openFiles,
      openGit: s.openGit,
      openTerminal: s.openTerminal,
      openBrowser: s.openBrowser,
      openAgentBrowser: s.openAgentBrowser,
      openAgentBrowserFor: s.openAgentBrowserFor,
      markAgentBrowserOperation: s.markAgentBrowserOperation,
      toggleSubAgent: s.toggleSubAgent,
      activateTab: s.activateTab,
      closeTab: s.closeTab,
    })),
  )
  useBindSession(activeSessionId, bind)
  return { ...(slice ?? emptyWorkbenchSlice()), ...actions }
}
