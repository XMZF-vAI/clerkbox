/**
 * 消息与 DB 行的双向编解码（批次 B · P3 前置）。
 *
 * 抽出来而不是留在 chat-store 里，是因为运行期落库即将由宿主（主进程 agent-host）
 * 独占：两侧若各写一份 JSON 编码与列名映射，字段漂移只会在用户重启后暴露。
 * 渲染层与宿主都从这里取同一份实现。
 */
import type { Message, MessageAttachment, ToolCall, ToolResult } from '../types/agent'
import type { MessageRow } from '../types/ipc'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseToolCalls(value: string | null | undefined): ToolCall[] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return undefined
    return parsed.flatMap((item) =>
      isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' && isRecord(item.arguments)
        ? [{ id: item.id, name: item.name, arguments: item.arguments }]
        : []
    )
  } catch {
    return undefined
  }
}

export function parseToolResults(value: string | null | undefined): ToolResult[] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return undefined
    return parsed.flatMap((item) =>
      isRecord(item) && typeof item.toolCallId === 'string' && typeof item.content === 'string'
        ? [{
            toolCallId: item.toolCallId,
            content: item.content,
            ...(typeof item.isError === 'boolean' ? { isError: item.isError } : {}),
          }]
        : []
    )
  } catch {
    return undefined
  }
}

/** 解析 DB 行的 attachments JSON 列（MessageAttachment[] 序列化）；可选字段缺失时容忍 */
export function parseAttachments(value: string | null | undefined): MessageAttachment[] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return undefined
    const attachments = parsed.flatMap((item) =>
      isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string'
        && typeof item.kind === 'string' && (item.kind === 'image' || item.kind === 'file')
        ? [{
            id: item.id,
            kind: item.kind as MessageAttachment['kind'],
            name: item.name,
            ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
            ...(typeof item.dataUrl === 'string' ? { dataUrl: item.dataUrl } : {}),
            ...(typeof item.path === 'string' ? { path: item.path } : {}),
            ...(typeof item.size === 'number' ? { size: item.size } : {}),
          }]
        : []
    )
    return attachments.length > 0 ? attachments : undefined
  } catch {
    return undefined
  }
}

export function parseMessageSkills(value: string | null | undefined): Message['skills'] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return undefined
    const skills = parsed.flatMap((item) =>
      isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string'
        ? [{
            id: item.id,
            name: item.name,
            ...(typeof item.icon === 'string' ? { icon: item.icon } : {}),
            ...(typeof item.slug === 'string' ? { slug: item.slug } : {}),
          }]
        : []
    )
    return skills.length > 0 ? skills : undefined
  } catch {
    return undefined
  }
}

/** 把 DB 消息行映射为内存 Message 结构（loadFromDb / syncFromDb / 宿主读历史共用） */
export function mapMessageRows(msgRows: MessageRow[]): Message[] {
  return msgRows.map((m) => ({
    id: m.id,
    role: ['user', 'assistant', 'system', 'tool'].includes(m.role) ? m.role as Message['role'] : 'assistant',
    content: m.content || '',
    thinkingContent: m.thinking_content || undefined,
    timestamp: m.timestamp,
    toolCalls: parseToolCalls(m.tool_calls),
    toolResults: parseToolResults(m.tool_results),
    attachments: parseAttachments(m.attachments),
    skills: parseMessageSkills(m.skills),
    finishReason: m.finish_reason || undefined,
    isCompactSummary: m.is_compact === 1 ? true : undefined,
    isCompactAttachment: m.is_compact_attachment === 1 ? true : undefined,
    isSubAgentCard: m.is_sub_agent_card === 1 ? true : undefined,
    subAgentId: m.sub_agent_id || undefined,
    taskMode: m.task_mode === 'spec' || m.task_mode === 'plan' || m.task_mode === 'goal' ? m.task_mode : undefined,
  }))
}

/**
 * Message → 落库行。dbAddMessage 与 dbCompactMessages 用同一份编码，
 * 保证压缩重写历史时不会丢掉普通写入路径携带的字段。
 */
export function messageToRow(message: Message, sessionId: string): MessageRow {
  return {
    id: message.id,
    session_id: sessionId,
    role: message.role,
    content: message.content,
    thinking_content: message.thinkingContent || null,
    timestamp: message.timestamp,
    tool_calls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    tool_results: message.toolResults ? JSON.stringify(message.toolResults) : null,
    attachments: message.attachments ? JSON.stringify(message.attachments) : null,
    finish_reason: message.finishReason || null,
    is_compact: message.isCompactSummary ? 1 : 0,
    is_compact_attachment: message.isCompactAttachment ? 1 : 0,
    is_sub_agent_card: message.isSubAgentCard ? 1 : 0,
    sub_agent_id: message.subAgentId || null,
    task_mode: message.taskMode || null,
    skills: message.skills ? JSON.stringify(message.skills) : null,
  }
}

/**
 * 会话标题：取首条用户消息前 30 字。渲染层与宿主必须同一条规则，
 * 否则宿主改名与本地即时改名会给出两种标题。
 */
export function deriveSessionTitle(content: string): string {
  return content.slice(0, 30) + (content.length > 30 ? '...' : '')
}

/**
 * 「尚未命名」的哨兵值：新建会话的初始标题，同时也是空会话判定与首条消息改名的依据。
 * 曾经是散在 chat-store / agent-host / db 三处的字面量，任一处 i18n 化都会让其余两处静默失效。
 */
export const NEW_SESSION_TITLE = '新会话'

/** dbUpdateMessage 的位置参数（增量回落同一条编码规则） */
export function messageUpdateArgs(message: Message): [
  id: string,
  content: string,
  toolCalls: string | undefined,
  toolResults: string | undefined,
  thinkingContent: string | null,
  finishReason: string | null,
] {
  return [
    message.id,
    message.content,
    message.toolCalls ? JSON.stringify(message.toolCalls) : undefined,
    message.toolResults ? JSON.stringify(message.toolResults) : undefined,
    message.thinkingContent || null,
    message.finishReason || null,
  ]
}
