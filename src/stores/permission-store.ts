import { create } from 'zustand'
import type { PermissionReason } from '../agent-core/ports'

/**
 * 宿主模式下待批准的审批请求（批次 B · C2 阶段二）。
 *
 * 数据源是宿主的 `permission.requested` 事件：那里带着 loop 判定用的 tool/args，
 * UI 才能画出富预览并给出「本会话允许」。渲染层本地路径不写这里——那条路径的
 * 放行仍在原生确认框里（`use-agent` 的 permission 端口），本 store 保持为空。
 */
export interface HostPermission {
  sessionId: string
  requestId: string
  tool: string
  args: Record<string, unknown>
  reason: PermissionReason
  workingDir: string
  mode: 'manual' | 'auto' | 'full'
  /** loop 已渲染好的说明文案（卡片副标题用，避免 UI 再拼一套口径） */
  body: string
  requestedAt: number
}

interface PermissionState {
  bySession: Record<string, HostPermission[]>
  /** 幂等：同一次待批可能来自实时推送、缺口补发或 F5 整环回放 */
  open: (request: HostPermission) => void
  settle: (sessionId: string, requestId: string) => void
  clearSession: (sessionId: string) => void
}

export const usePermissionStore = create<PermissionState>((set) => ({
  bySession: {},

  open: (request) =>
    set((state) => {
      const current = state.bySession[request.sessionId] ?? []
      if (current.some((item) => item.requestId === request.requestId)) return state
      return { bySession: { ...state.bySession, [request.sessionId]: [...current, request] } }
    }),

  settle: (sessionId, requestId) =>
    set((state) => {
      const current = state.bySession[sessionId] ?? []
      const next = current.filter((item) => item.requestId !== requestId)
      if (next.length === current.length) return state
      return { bySession: { ...state.bySession, [sessionId]: next } }
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (!state.bySession[sessionId]) return state
      const bySession = { ...state.bySession }
      delete bySession[sessionId]
      return { bySession }
    }),
}))
