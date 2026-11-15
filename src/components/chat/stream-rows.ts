/**
 * 会话流行流构建（照抄 ZCode v4/conversationAssistantWorkItems.ts 的分组语义）。
 *
 * 一轮的助手消息按自然顺序摊成行：思考行 → 正文段 → 工具行。
 * 工具行里连续 ≥2 个只读工具聚成「查阅」组、连续 ≥2 个执行命令聚成「终端」组；
 * 单个工具保持独立行；思考 / 正文 / 特殊卡片打断分组。
 * 组身份锚定首个工具调用 id：流式追加只更新 children，不重建组件（展开态不丢）。
 */
import type { Message, StreamingToolCall, ToolCall, ToolResult } from '../../types/agent'
import { isRenderedByUnifiedEntry } from './tool-renderers/resolveRenderer'

export interface ToolRowItem {
  call: ToolCall
  result?: ToolResult
  /** 属主消息：_isStreaming 决定无结果的工具是「在跑」还是「已停止」 */
  message: Message
}

export type StreamRow =
  | { kind: 'thinking'; key: string; message: Message }
  | { kind: 'text'; key: string; message: Message }
  | { kind: 'tool'; key: string; item: ToolRowItem }
  | { kind: 'streamingTool'; key: string; call: StreamingToolCall }
  | { kind: 'exploreGroup'; key: string; items: ToolRowItem[] }
  | { kind: 'executeGroup'; key: string; items: ToolRowItem[] }
  | { kind: 'special'; key: string; message: Message }

export type ExploreBucket = 'fetch' | 'search' | 'list' | 'file'

/** 特殊消息：子代理卡 / 压缩摘要 / 权限留痕 / 目标判定 / 通知条等，原样交给 MessageItem */
function isSpecialMessage(m: Message): boolean {
  return (
    m.role !== 'assistant' ||
    !!m.isSubAgentCard ||
    !!m.isCompactSummary ||
    !!m.isCompactAttachment ||
    !!m.isRewindNotice ||
    !!m.isSubAgentNotice ||
    !!m.goalEvent ||
    !!m._isCompacting ||
    !!m._retrying ||
    !!m.collapsed
  )
}

// ── 只读命令判定（照抄 ZCode lib/exploreToolCall.ts 的正则口径）──
const EXECUTE_READ_COMMAND_RE =
  /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i
const EXECUTE_WRITE_COMMAND_RE =
  /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i
const SHELL_REDIRECT_WRITE_RE = /(^|[^\d<])>>?\s*\S|&>\s*\S/i
const SHELL_LOOP_RE = /\b(for|while)\b/i

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim()
  const stripQuotes = (value: string) => {
    const v = value.trim()
    return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
      ? v.slice(1, -1).trim()
      : v
  }
  const shellMatch = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i)
  if (shellMatch?.[1]) return stripQuotes(shellMatch[1])
  const psMatch = trimmed.match(/^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[\s\S]*?\s-(?:command|c)\s+([\s\S]+)$/i)
  if (psMatch?.[1]) return stripQuotes(psMatch[1])
  return trimmed
}

/** 拆成独立命令段（&& / || / ;），与 ZCode 同一套口径 */
export function commandSegments(command: string): string[] {
  return Array.from(
    new Set(
      unwrapShellCommand(command)
        .split(/&&|\|\||;/g)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  )
}

export function isReadOnlyCommand(command: string): boolean {
  const segments = commandSegments(command)
  if (segments.length === 0) return false
  if (segments.some((s) => EXECUTE_WRITE_COMMAND_RE.test(s))) return false
  if (segments.some((s) => SHELL_REDIRECT_WRITE_RE.test(s))) return false
  if (segments.some((s) => EXECUTE_READ_COMMAND_RE.test(s))) return true
  // 只读探查包在 for/while 循环里（批量 cat / 递归扫目录）仍算只读
  return segments.some((s) => SHELL_LOOP_RE.test(s) && EXECUTE_READ_COMMAND_RE.test(s))
}

const EXPLORE_TOOL_NAMES = new Set([
  'read_file', 'read_image', 'list_dir', 'search_files', 'search_content', 'web_search', 'web_fetch',
])

/** 只读探查工具（ZCode isExploreToolCall 的 ClerkBox 工具名映射） */
export function isExploreTool(call: ToolCall): boolean {
  if (EXPLORE_TOOL_NAMES.has(call.name)) return true
  if (call.name === 'execute_command') return isReadOnlyCommand(String(call.arguments.command ?? ''))
  return false
}

/** 执行类工具：execute_command 且不是只读探查 */
export function isExecuteTool(call: ToolCall): boolean {
  return call.name === 'execute_command' && !isReadOnlyCommand(String(call.arguments.command ?? ''))
}

/** 查阅分桶（ZCode classifyExploreToolCall：fetch 优先，其次 search / list，兜底 file） */
export function exploreBucket(call: ToolCall): ExploreBucket {
  switch (call.name) {
    case 'web_fetch': return 'fetch'
    case 'web_search':
    case 'search_files':
    case 'search_content': return 'search'
    case 'list_dir': return 'list'
    case 'read_file':
    case 'read_image': return 'file'
  }
  // 只读 shell：按命令内容分桶
  const command = commandSegments(String(call.arguments.command ?? '')).join(' ; ')
  if (/(^|\s)(rg|grep|ripgrep|git\s+grep|select-string|sls)(\s|$)/i.test(command)) return 'search'
  if (/(^|\s)(ls|find|tree|dir|get-childitem|gci)(\s|$)/i.test(command)) return 'list'
  return 'file'
}

export function countExploreBuckets(items: ToolRowItem[]): Record<ExploreBucket, number> {
  const counts: Record<ExploreBucket, number> = { fetch: 0, search: 0, list: 0, file: 0 }
  for (const item of items) counts[exploreBucket(item.call)] += 1
  return counts
}

/** 桶的展示顺序（ZCode formatExploreSummary：fetch → search → list → file，只写非零桶） */
export const EXPLORE_BUCKET_ORDER: readonly ExploreBucket[] = ['fetch', 'search', 'list', 'file']

export interface ExecuteGroupStats {
  total: number
  failed: number
  stopped: number
}

export function executeGroupStats(items: ToolRowItem[]): ExecuteGroupStats {
  let failed = 0
  let stopped = 0
  for (const item of items) {
    if (item.result?.isError) failed += 1
    // 无结果且属主消息已不在流式 = 这步被打断（中止 / 从未执行）
    else if (!item.result && !item.message._isStreaming) stopped += 1
  }
  return { total: items.length, failed, stopped }
}

/** 组是否仍在跑：有子工具没结果且属主消息还在流式 */
export function isGroupRunning(items: ToolRowItem[]): boolean {
  return items.some((i) => !i.result && !!i.message._isStreaming)
}

/** 运行中组的摘要主角：最后一个在跑的子工具；没有在跑的就是最后一个 */
export function latestActiveItem(items: ToolRowItem[]): ToolRowItem | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item && !item.result && item.message._isStreaming) return item
  }
  return items[items.length - 1]
}

/** 工具是否仍在运行（无结果且属主消息在流式） */
export function isToolRunning(item: ToolRowItem): boolean {
  return !item.result && !!item.message._isStreaming
}

/** 思考是否仍在流式：消息在流式且还没产出正文 / 工具 / 完成原因 */
export function isThinkingActive(message: Message): boolean {
  return (
    !!message._isStreaming &&
    !message.content.trim() &&
    !message.finishReason &&
    !message.toolCalls?.length &&
    !message.streamingToolCalls?.length
  )
}

function groupConsecutiveTools(rows: StreamRow[]): StreamRow[] {
  const out: StreamRow[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]!
    if (row.kind !== 'tool') {
      out.push(row)
      i += 1
      continue
    }
    const family = isExploreTool(row.item.call) ? 'explore' : isExecuteTool(row.item.call) ? 'execute' : null
    if (!family) {
      out.push(row)
      i += 1
      continue
    }
    const group: ToolRowItem[] = [row.item]
    i += 1
    while (i < rows.length) {
      const next = rows[i]!
      if (next.kind !== 'tool') break
      const nextFamily = isExploreTool(next.item.call) ? 'explore' : isExecuteTool(next.item.call) ? 'execute' : null
      if (nextFamily !== family) break
      group.push(next.item)
      i += 1
    }
    // 单个工具不套聚合层（ZCode：第二个连续同类到达后才升级为组）
    if (group.length === 1) {
      out.push(row)
      continue
    }
    out.push(
      family === 'explore'
        ? { kind: 'exploreGroup', key: `explore:${group[0]!.call.id}`, items: group }
        : { kind: 'executeGroup', key: `execute:${group[0]!.call.id}`, items: group },
    )
  }
  return out
}

/** 把一轮的助手消息摊成行流并分组。role=tool 的消息不进时间线（结果挂在助手消息上） */
export function buildStreamRows(messages: Message[]): StreamRow[] {
  const rows: StreamRow[] = []
  for (const m of messages) {
    if (m.role === 'tool') continue
    if (isSpecialMessage(m)) {
      rows.push({ kind: 'special', key: m.id, message: m })
      continue
    }
    if (m.thinkingContent) rows.push({ kind: 'thinking', key: `think:${m.id}`, message: m })
    if (m.content.trim()) rows.push({ kind: 'text', key: `text:${m.id}`, message: m })
    for (const call of m.toolCalls ?? []) {
      if (isRenderedByUnifiedEntry(call.name)) continue
      rows.push({
        kind: 'tool',
        key: `tool:${call.id}`,
        item: { call, result: m.toolResults?.find((r) => r.toolCallId === call.id), message: m },
      })
    }
    // 流式中的工具调用是最新到达的，排在已完成工具之后（时间线尾部才是正在发生的事）
    for (const call of m.streamingToolCalls ?? []) {
      rows.push({ kind: 'streamingTool', key: `streaming:${call.id}`, call })
    }
  }
  return groupConsecutiveTools(rows)
}