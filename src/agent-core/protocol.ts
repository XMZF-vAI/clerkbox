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
import type { SkillCatalogEntry } from '../lib/skill-catalog'
import type { QueuedMessageItem } from '../stores/chat-store'
import type {
  Message,
  MessageAttachment,
  MessageSkillSnapshot,
  SessionGoal,
  SubAgentRun,
  TaskMode,
  TodoItem,
} from '../types/agent'
import type { AgentSettings, PermissionReason } from './ports'

// ── 渲染层 → 宿主（invoke 'agent:command'）──

export type AgentCommand =
  | { type: 'run'; sessionId: string; content: string;
      attachments?: MessageAttachment[]; taskMode?: TaskMode; skills?: MessageSkillSnapshot[];
      /**
       * P3 宿主运行随命令下发的快照。宿主不读渲染层的 zustand persist（localStorage），
       * 故设置、技能目录、目标与待办的初值由下发方给出；运行期真相源再改由宿主持有，
       * 变更以事件回流。消息历史不在此列——宿主直接读 ChatStore。
       */
      settings?: AgentSettings; skillCatalog?: SkillCatalogEntry[];
      skillReminder?: string; goal?: SessionGoal; todos?: TodoItem[] }
  | { type: 'abort'; sessionId: string }
  | { type: 'queue.enqueue'; sessionId: string; item: QueuedMessageItem }
  | { type: 'queue.remove'; sessionId: string; id: string }
  | { type: 'queue.flush'; sessionId: string; id?: string }  // 立即发送队首（给 id 则先把该条提到队首）
  | { type: 'permission.resolve'; sessionId: string; requestId: string; approved: boolean;
      /** 'session' = 本会话内同类目标不再询问（放行集合由宿主持有，UI 关闭/离线也照旧生效） */
      scope?: 'once' | 'session' }
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
      risk: 'dangerous' | 'normal'; mode: 'manual' | 'auto' | 'full';
      /**
       * P4 追加（只增不改）：只带一段已渲染好的 preview 字符串时，界面既画不出富预览、
       * 也算不出「本会话允许」的匹配键 —— 于是宿主模式下的危险操作实际无人能批，
       * 120s 后一律 fail-closed 拒绝。这几项把 loop 判定用的原始入参带过来，
       * UI 侧据此复用同一个 buildPermissionPreview，两侧不会长出第二套判定。
       */
      tool?: string; args?: Record<string, unknown>; reason?: PermissionReason; workingDir?: string }
  /** 审批收尾：批准/拒绝/超时/运行结束回收都发这条，卡片才不会永远挂着 */
  | { type: 'permission.settled'; sessionId: string; requestId: string; approved: boolean; timedOut: boolean }
  | { type: 'question.requested'; sessionId: string; requestId: string; question: unknown } // QuestionCard
  | { type: 'queue.snapshot';   sessionId: string; items: QueuedMessageItem[] }
  | { type: 'run.status';       sessionId: string; status: 'working' | 'awaiting' | 'idle'; error?: string }
  | { type: 'run.completed';    sessionId: string; runId: string }
  | { type: 'run.aborted';      sessionId: string; runId: string; byUser: boolean }
  | { type: 'subagent.updated'; sessionId: string; run: SubAgentRun }
  | { type: 'usage.updated';    sessionId: string; usage: ContextUsageInfo }
  // ── P3 追加（只增不改）：宿主在运行期持有的 UI 侧状态回流渲染层 ──
  | { type: 'todos.updated';    sessionId: string; items: TodoItem[] }
  | { type: 'goal.updated';     sessionId: string; goal: SessionGoal | null }
  | { type: 'notify';           sessionId: string; kind: 'error' | 'done' | 'confirm-danger'; message?: string }
  /** 环形缓冲溢出：渲染层放弃补发，整会话重拉 DB */
  | { type: 'resync';           sessionId: string; reason: string }

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
