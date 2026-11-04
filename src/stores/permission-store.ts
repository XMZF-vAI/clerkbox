import { create } from 'zustand'
import type { PermissionApproval, PermissionReason } from '../agent-core/ports'
import { decisionApproves, decisionToScope, type PermissionDecision } from '../lib/permission-preview'

/**
 * 审批请求的**两条数据源**（批次 B · C2 阶段二 + 工作流 UI 对齐）：
 *
 * 1. `bySession` —— 宿主模式：数据来自 `permission.requested` 事件，卡片可交互。
 * 2. `localBySession` —— 渲染层本地：loop 在**同进程**里等一个 promise，
 *    `confirmInChat` 把请求挂到这里，用户点完由 `resolveLocalPermission` 兑现。
 *
 * 为什么本地路径需要独立一份：渲染层宿主的 `emit` 是 no-op，`permission.requested`
 * 这条事件通道在本进程内根本不存在。原生确认框能批，但它画不出工作流的流程图。
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

/** 本地待批（渲染层同进程）：字段与 AgentPermissionRequest 一一对应，多带 requestId */
export interface LocalPermission {
  sessionId: string
  requestId: string
  tool: string
  args: Record<string, unknown>
  reason: PermissionReason
  workingDir: string
  risk: 'dangerous' | 'normal'
  title: string
  body: string
  requestedAt: number
}

interface PermissionState {
  bySession: Record<string, HostPermission[]>
  localBySession: Record<string, LocalPermission[]>
  /** 幂等：同一次待批可能来自实时推送、缺口补发或 F5 整环回放 */
  open: (request: HostPermission) => void
  settle: (sessionId: string, requestId: string) => void
  localOpen: (request: LocalPermission) => void
  localSettle: (sessionId: string, requestId: string) => void
  clearSession: (sessionId: string) => void
}

export const usePermissionStore = create<PermissionState>((set) => ({
  bySession: {},
  localBySession: {},

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

  localOpen: (request) =>
    set((state) => {
      const current = state.localBySession[request.sessionId] ?? []
      if (current.some((item) => item.requestId === request.requestId)) return state
      return { localBySession: { ...state.localBySession, [request.sessionId]: [...current, request] } }
    }),

  localSettle: (sessionId, requestId) =>
    set((state) => {
      const current = state.localBySession[sessionId] ?? []
      const next = current.filter((item) => item.requestId !== requestId)
      if (next.length === current.length) return state
      return { localBySession: { ...state.localBySession, [sessionId]: next } }
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (!state.bySession[sessionId] && !state.localBySession[sessionId]) return state
      const bySession = { ...state.bySession }
      const localBySession = { ...state.localBySession }
      delete bySession[sessionId]
      delete localBySession[sessionId]
      return { bySession, localBySession }
    }),
}))

/**
 * 待批请求的 promise 兑现表。刻意放在 store 外面：
 * 函数不是可序列化状态，塞进 store 会让每次 set 都带着它一起走，且没有任何订阅方需要它。
 */
const localResolvers = new Map<string, (approval: PermissionApproval) => void>()

const localKey = (sessionId: string, requestId: string) => `${sessionId}:${requestId}`

/**
 * 把一次确认挂进对话内，等用户点选项。
 *
 * 调用方（渲染层宿主的 `confirmInChat`）必须在拿到 promise 前就挂上 store 条目，
 * 否则卡片渲染时读不到请求。
 */
export function requestLocalPermission(
  request: Omit<LocalPermission, 'requestedAt'>
): Promise<PermissionApproval> {
  const key = localKey(request.sessionId, request.requestId)
  usePermissionStore.getState().localOpen({ ...request, requestedAt: Date.now() })
  return new Promise<PermissionApproval>((resolve) => {
    localResolvers.set(key, resolve)
  })
}

/**
 * 用户的选择 → 兑现 promise → 清掉待批条目。
 * 幂等：重复点击/回放不会二次兑现（resolver 已从表里摘掉）。
 */
export function resolveLocalPermission(
  sessionId: string,
  requestId: string,
  decision: PermissionDecision
): void {
  const key = localKey(sessionId, requestId)
  const resolve = localResolvers.get(key)
  if (resolve) {
    localResolvers.delete(key)
    // 项目级规则只放行本次，后续同类操作由 checkToolPermission 的规则引擎命中，
    // 不塞进会话级放行集合（那条路径是内存态，重启即失）。
    resolve({ approved: decisionApproves(decision), scope: decisionToScope(decision) })
  }
  usePermissionStore.getState().localSettle(sessionId, requestId)
}

/** 会话被停止/结束时的兜底：兑现为拒绝，绝不把 loop 永久挂在 promise 上 */
export function cancelLocalPermissions(sessionId: string): void {
  for (const [key, resolve] of [...localResolvers]) {
    if (!key.startsWith(`${sessionId}:`)) continue
    localResolvers.delete(key)
    resolve({ approved: false, scope: 'once' })
  }
  usePermissionStore.getState().clearSession(sessionId)
}
