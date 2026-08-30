import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SessionGoal } from '../types/agent'

/**
 * 会话级 Goal 状态（/goal 模式）：
 * 每个会话至多一个目标；目标跨消息持续生效，由 agent 循环收尾处的独立评估器
 * 判定三态（进行中/已达成/无法完成）并驱动自动续跑（对齐 Claude Code /goal）。
 * 低频写入（设定/评估/终态，流式期间不更新），localStorage 持久化以支持重启恢复。
 */
interface GoalState {
  bySession: Record<string, SessionGoal>
  /** 设定/覆盖当前会话的目标（进入 active 并重置计数） */
  setGoal: (sessionId: string, condition: string) => void
  /** 局部更新目标状态（评估计数/理由/终态） */
  updateGoal: (sessionId: string, patch: Partial<SessionGoal>) => void
  /** 清除目标（/goal clear 或用户在状态条上清除） */
  clearGoal: (sessionId: string) => void
}

export const useGoalStore = create<GoalState>()(
  persist(
    (set) => ({
      bySession: {},
      setGoal: (sessionId, condition) => set((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: {
            condition,
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            evaluations: 0,
          },
        },
      })),
      updateGoal: (sessionId, patch) => set((state) => {
        const goal = state.bySession[sessionId]
        if (!goal) return state
        return {
          bySession: {
            ...state.bySession,
            [sessionId]: { ...goal, ...patch, updatedAt: Date.now() },
          },
        }
      }),
      clearGoal: (sessionId) => set((state) => {
        const next = { ...state.bySession }
        delete next[sessionId]
        return { bySession: next }
      }),
    }),
    { name: 'clerkbox-goal-store' }
  )
)
