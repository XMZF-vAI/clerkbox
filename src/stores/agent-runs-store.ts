import { create } from 'zustand'
import type { Message, SubAgentRun } from '../types/agent'

interface AgentRunsState {
  // sessionId → SubAgentRun[]
  runsBySession: Record<string, SubAgentRun[]>
  // 当前选中查看详情的子 agent ID
  selectedRunId: string | null

  addSubAgentRun: (sessionId: string, run: SubAgentRun) => void
  appendSubAgentMessage: (sessionId: string, runId: string, msg: Message) => void
  updateSubAgentMessage: (sessionId: string, runId: string, msgId: string, updates: Partial<Message>) => void
  completeSubAgentRun: (sessionId: string, runId: string, result: string) => void
  failSubAgentRun: (sessionId: string, runId: string, error: string) => void
  abortSubAgentRun: (sessionId: string, runId: string) => void
  selectRun: (runId: string | null) => void
  clearSession: (sessionId: string) => void
}

// 不使用 persist 中间件：子 agent 流式期间会以 ~20fps 调用 updateSubAgentMessage，
// persist 会在每次 set 后同步 JSON.stringify + localStorage.setItem，阻塞渲染线程导致界面卡死。
// 子 agent 运行数据本身不需要跨会话持久化（重启后 running 状态的旧记录也无意义），改为纯内存 store。
export const useAgentRunsStore = create<AgentRunsState>((set) => ({
  runsBySession: {},
  selectedRunId: null,

  addSubAgentRun: (sessionId, run) =>
    set((state) => ({
      runsBySession: {
        ...state.runsBySession,
        [sessionId]: [...(state.runsBySession[sessionId] || []), run],
      },
    })),

  appendSubAgentMessage: (sessionId, runId, msg) =>
    set((state) => {
      const runs = state.runsBySession[sessionId] || []
      return {
        runsBySession: {
          ...state.runsBySession,
          [sessionId]: runs.map((r) =>
            r.id === runId ? { ...r, messages: [...r.messages, msg] } : r
          ),
        },
      }
    }),

  updateSubAgentMessage: (sessionId, runId, msgId, updates) =>
    set((state) => {
      const runs = state.runsBySession[sessionId] || []
      return {
        runsBySession: {
          ...state.runsBySession,
          [sessionId]: runs.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  messages: r.messages.map((m) => (m.id === msgId ? { ...m, ...updates } : m)),
                }
              : r
          ),
        },
      }
    }),

  completeSubAgentRun: (sessionId, runId, result) =>
    set((state) => {
      const runs = state.runsBySession[sessionId] || []
      return {
        runsBySession: {
          ...state.runsBySession,
          [sessionId]: runs.map((r) =>
            r.id === runId
              ? { ...r, status: 'completed' as const, result, finishedAt: Date.now() }
              : r
          ),
        },
      }
    }),

  failSubAgentRun: (sessionId, runId, error) =>
    set((state) => {
      const runs = state.runsBySession[sessionId] || []
      return {
        runsBySession: {
          ...state.runsBySession,
          [sessionId]: runs.map((r) =>
            r.id === runId
              ? { ...r, status: 'failed' as const, error, finishedAt: Date.now() }
              : r
          ),
        },
      }
    }),

  abortSubAgentRun: (sessionId, runId) =>
    set((state) => {
      const runs = state.runsBySession[sessionId] || []
      return {
        runsBySession: {
          ...state.runsBySession,
          [sessionId]: runs.map((r) =>
            r.id === runId
              ? { ...r, status: 'aborted' as const, finishedAt: Date.now() }
              : r
          ),
        },
      }
    }),

  selectRun: (runId) => set({ selectedRunId: runId }),

  clearSession: (sessionId) =>
    set((state) => {
      const newRuns = { ...state.runsBySession }
      delete newRuns[sessionId]
      return { runsBySession: newRuns }
    }),
}))
