/**
 * Agent 运行时事件协议（批次 B · §3.2）
 *
 * P1：仅落类型与 seq 工具（渲染层宿主直接驱动 loop，不走 IPC）。
 * P3 起：渲染层 → 宿主走 invoke 'agent:command'；宿主 → 渲染层走 'agent:event'
 *（带单调 seq，缺口即断线重连，环形缓冲上限 500 条/会话，超限回退 resync）。
 *
 * 字段语义为 C/D 批次（权限审批 UI 等）的共享契约：只增不改。
 */
import type { ContextUsageInfo } from '../lib/context-usage'
import type { QueuedMessageItem } from '../stores/chat-store'
import type { Message, MessageAttachment, MessageSkillSnapshot, SubAgentRun, TaskMode } from '../types/agent'

// ── 渲染层 → 宿主（invoke 'agent:command'）──

export type AgentCommand =
  | { type: 'run'; sessionId: string; content: string;
      attachments?: MessageAttachment[]; taskMode?: TaskMode; skills?: MessageSkillSnapshot[] }
  | { type: 'abort'; sessionId: string }
  | { type: 'queue.enqueue'; sessionId: string; item: QueuedMessageItem }
  | { type: 'queue.remove'; sessionId: string; id: string }
  | { type: 'queue.flush'; sessionId: string }          // 立即发送队首
  | { type: 'permission.resolve'; sessionId: string; requestId: string; approved: boolean }
  | { type: 'question.resolve'; sessionId: string; requestId: string; payload: unknown }
  | { type: 'manual.compact'; sessionId: string; instructions?: string }

// ── 宿主 → 渲染层（push 'agent:event'，带单调 seq）──

export type AgentEvent =
  | { type: 'run.started';      sessionId: string; runId: string; ts: number }
  | { type: 'message.added';    sessionId: string; message: Message }   // 落库完成后
  | { type: 'message.updated';  sessionId: string; messageId: string; updates: Partial<Message> }
  | { type: 'stream.delta';     sessionId: string; messageId: string; text: string } // 合批 16~32ms
  | { type: 'stream.ended';     sessionId: string; messageId: string }
  | { type: 'tool.started';     sessionId: string; messageId: string; callId: string; name: string; args: unknown }
  | { type: 'tool.finished';    sessionId: string; callId: string; result: string; isError: boolean }
  | { type: 'permission.requested'; sessionId: string; requestId: string;
      preview: string;   // UI 纯函数渲染命令/文件预览（参照 ZCode permission-request-preview）
      risk: 'dangerous' | 'normal'; mode: 'manual' | 'auto' | 'full' }
  | { type: 'question.requested'; sessionId: string; requestId: string; question: unknown } // QuestionCard
  | { type: 'queue.snapshot';   sessionId: string; items: QueuedMessageItem[] }
  | { type: 'run.status';       sessionId: string; status: 'working' | 'awaiting' | 'idle'; error?: string }
  | { type: 'run.completed';    sessionId: string; runId: string }
  | { type: 'run.aborted';      sessionId: string; runId: string; byUser: boolean }
  | { type: 'subagent.updated'; sessionId: string; run: SubAgentRun }
  | { type: 'usage.updated';    sessionId: string; usage: ContextUsageInfo }

// ── 重连回放（invoke 'agent:snapshot' 或 attach 返回）──

export interface AgentSnapshot {
  activeRuns: Array<{ sessionId: string; runId: string; status: 'working' | 'awaiting' }>
  queue: Record<string, QueuedMessageItem[]>
  pendingPermissions: AgentEvent[]   // 未决审批/提问，重连即恢复弹窗
  lastSeq: number
}

// ── seq 工具 ──

/** 单调递增 seq 计数器：事件通道按会话各持一个，重连补发依据。 */
export function createSeqCounter(start = 0): { next(): number; get(): number } {
  let n = start
  return {
    next: () => ++n,
    get: () => n,
  }
}
