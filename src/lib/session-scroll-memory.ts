/**
 * 按 sessionId 记忆消息列表滚动位置（C3）。
 * MessageList 由 ChatPage 用 `key=sessionId` 强制重挂载，组件内 state 必然丢失，
 * 所以记忆放在模块级 Map（前端单渲染进程，生命周期与窗口一致）。
 * 纯存储 + 纯决策，不碰 DOM，便于单测。
 */

export interface SessionScrollMemory {
  /** 视口顶部所在 turn 的 id；null 表示只记住了原始偏移 */
  turnId: string | null
  /** 视口顶部到该 turn 行顶的距离（>=0），turn 级精度靠它补齐 */
  offsetWithinTurn: number
  /** 保存时的 scrollTop 原值，turnId 失效时（如压缩重建）的兜底 */
  offset: number
  /** 保存时是否贴着最新消息：贴底则回来仍走「直接看最新」的现状语义 */
  atBottom: boolean
}

/** 最多记忆多少个会话，超出按最近写入顺序淘汰，避免长会话列表下的无界增长 */
export const MAX_TRACKED_SESSIONS = 40

const memoryBySession = new Map<string, SessionScrollMemory>()

export function rememberSessionScroll(sessionId: string, memory: SessionScrollMemory): void {
  if (!sessionId) return
  // delete + set：把该会话挪到 Map 末尾，充当轻量 LRU
  memoryBySession.delete(sessionId)
  memoryBySession.set(sessionId, memory)
  while (memoryBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = memoryBySession.keys().next().value
    if (oldest === undefined) break
    memoryBySession.delete(oldest)
  }
}

export function peekSessionScroll(sessionId: string): SessionScrollMemory | undefined {
  if (!sessionId) return undefined
  return memoryBySession.get(sessionId)
}

/** 全量清空（单测隔离用） */
export function clearSessionScrollMemory(): void {
  memoryBySession.clear()
}

export type ScrollRestoreDecision =
  /** 无记忆或上次贴底：进入会话即看最新消息（虚拟化前的现状行为） */
  | { kind: 'bottom' }
  /** 记住了具体 turn 且该 turn 仍在：按 turn 下标 + 行内偏移恢复 */
  | { kind: 'turn'; index: number; offsetWithinTurn: number }
  /** turn 已不存在（压缩重建、消息被清理）：退回原始偏移近似恢复 */
  | { kind: 'offset'; offset: number }

export function resolveScrollRestore(
  turns: ReadonlyArray<{ turnId: string }>,
  memory: SessionScrollMemory | undefined
): ScrollRestoreDecision {
  if (!memory) return { kind: 'bottom' }
  if (memory.atBottom) return { kind: 'bottom' }
  if (turns.length === 0) return { kind: 'bottom' }
  if (memory.turnId !== null) {
    const index = turns.findIndex((turn) => turn.turnId === memory.turnId)
    if (index >= 0) {
      return { kind: 'turn', index, offsetWithinTurn: Math.max(0, memory.offsetWithinTurn) }
    }
  }
  return { kind: 'offset', offset: Math.max(0, memory.offset) }
}
