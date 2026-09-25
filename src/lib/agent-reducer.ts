/**
 * 宿主事件 → 渲染层补丁的纯映射（批次 B · P4）。
 *
 * 刻意只产出"要改什么"，不直接碰任何 store：映射可单测，且同一份语义既服务实时流、
 * 缺口补发也服务 F5 后的整环回放。幂等性（重复的 message.added 等）由应用侧决定，
 * 因为那需要读当前状态，纯函数做不到。
 */
import type { AgentEvent } from '../agent-core/protocol'
import type { Message, SessionGoal, SubAgentRun, TodoItem, UserQuestion } from '../types/agent'
import type { QueuedMessageItem, SessionStatus } from '../stores/chat-store'

export type StorePatch =
  | { kind: 'set-streaming'; sessionId: string; on: boolean }
  /** error 为 null 表示清除，undefined 表示不改动当前错误串 */
  | { kind: 'set-status'; sessionId: string; status: SessionStatus | null; error?: string | null }
  | { kind: 'upsert-message'; sessionId: string; message: Message }
  | { kind: 'update-message'; sessionId: string; messageId: string; updates: Partial<Message> }
  /** 流式增量：应用侧按 messageId 追加到已有内容，重复投递不在此处去重 */
  | { kind: 'stream-delta'; sessionId: string; messageId: string; text: string }
  | { kind: 'set-queue'; sessionId: string; items: QueuedMessageItem[] }
  | { kind: 'set-todos'; sessionId: string; items: TodoItem[] }
  | { kind: 'set-goal'; sessionId: string; goal: SessionGoal | null }
  | { kind: 'upsert-subagent-run'; sessionId: string; run: SubAgentRun }
  | { kind: 'open-question'; sessionId: string; requestId: string; questions: UserQuestion[] }
  | { kind: 'notify'; sessionId: string; channel: 'error' | 'done' | 'confirm-danger'; message?: string }
  /** 整会话重拉：环形缓冲溢出或宿主原子重写历史（压缩）时唯一的正确动作 */
  | { kind: 'reload-session'; sessionId: string; reason: string }

/**
 * tool.started / tool.finished 有意不产出补丁：循环已通过 message.added / message.updated
 * 把 toolCalls 与 toolResults 写进消息本身，再动一次就是双写。这两个事件留给未来的
 * 模型轨迹面板做展示用。
 */
export function planAgentEvent(event: AgentEvent): StorePatch[] {
  switch (event.type) {
    case 'run.started':
      return [
        { kind: 'set-streaming', sessionId: event.sessionId, on: true },
        // 新一轮开始即清上一次的错误串：失败要留在横幅上，直到用户再次发起
        { kind: 'set-status', sessionId: event.sessionId, status: 'working', error: null },
      ]
    case 'run.completed':
      return [
        { kind: 'set-status', sessionId: event.sessionId, status: null },
        { kind: 'set-streaming', sessionId: event.sessionId, on: false },
      ]
    case 'run.aborted':
      return [
        { kind: 'set-status', sessionId: event.sessionId, status: null },
        { kind: 'set-streaming', sessionId: event.sessionId, on: false },
      ]
    case 'run.status': {
      const patches: StorePatch[] = [{ kind: 'set-streaming', sessionId: event.sessionId, on: event.status !== 'idle' }]
      // 宿主的 awaiting 对应渲染层的危险确认态；error 串交给横幅，不改状态机
      const status: SessionStatus | null = event.status === 'awaiting' ? 'confirm-danger' : event.status === 'working' ? 'working' : null
      patches.push({ kind: 'set-status', sessionId: event.sessionId, status, error: event.error })
      return patches
    }
    case 'message.added':
      return [{ kind: 'upsert-message', sessionId: event.sessionId, message: event.message }]
    case 'message.updated':
      return [{ kind: 'update-message', sessionId: event.sessionId, messageId: event.messageId, updates: event.updates }]
    case 'stream.delta':
      return [{ kind: 'stream-delta', sessionId: event.sessionId, messageId: event.messageId, text: event.text }]
    case 'stream.ended':
      // 单条消息收尾不代表整轮结束（一轮内可能多条），且流式标记是会话级的：无事可做
      return []
    case 'queue.snapshot':
      return [{ kind: 'set-queue', sessionId: event.sessionId, items: event.items }]
    case 'permission.requested':
      return [{ kind: 'set-status', sessionId: event.sessionId, status: 'confirm-danger' }]
    case 'question.requested':
      return [{ kind: 'open-question', sessionId: event.sessionId, requestId: event.requestId, questions: event.question as UserQuestion[] }]
    case 'todos.updated':
      return [{ kind: 'set-todos', sessionId: event.sessionId, items: event.items }]
    case 'goal.updated':
      return [{ kind: 'set-goal', sessionId: event.sessionId, goal: event.goal ?? null }]
    case 'subagent.updated':
      return [{ kind: 'upsert-subagent-run', sessionId: event.sessionId, run: event.run }]
    case 'usage.updated':
      // 宿主目前不广播用量（P3 只在宿主侧留档），上下文指示器的宿主化属 P5 范围
      return []
    case 'notify':
      return [{ kind: 'notify', sessionId: event.sessionId, channel: event.kind, message: event.message }]
    case 'resync':
      return [{ kind: 'reload-session', sessionId: event.sessionId, reason: event.reason }]
    case 'tool.started':
    case 'tool.finished':
      return []
    default:
      return []
  }
}
