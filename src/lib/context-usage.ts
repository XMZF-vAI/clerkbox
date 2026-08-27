/**
 * 上下文用量统计（右上角环形指示器面板）：
 * 按内容类型细分当前会话消息的 token 占用估算。
 * 分类口径与 estimateTokensForMessages / compact.ts 的估算启发式保持一致。
 */
import type { Message } from '../types/agent'
import { estimateTokensForText } from './token-estimate'

/** 图片附件的固定 token 估算（与 compact.ts 的 IMAGE_TOKEN_ESTIMATE 一致） */
const IMAGE_TOKEN_ESTIMATE = 1000

export type ContextCategoryKey = 'system' | 'summary' | 'user' | 'assistant' | 'tools' | 'attachments'

export interface ContextCategory {
  key: ContextCategoryKey
  tokens: number
}

export interface ContextUsageInfo {
  /** 当前上下文总 token（优先取最近一次 API prompt_tokens，无则用估算值） */
  total: number
  /** 上下文预算（激活模型 maxInputTokens ?? 全局 ?? 184K） */
  budget: number
  /** 自动压缩触发阈值 */
  autoCompactThreshold: number
  /** 各分类 token（已按 total 等比缩放，Σcategories === total） */
  categories: ContextCategory[]
}

/** 估算单条消息中"工具调用与结果"部分的 token */
function estimateMessageTools(msg: Message): number {
  let tokens = 0
  if (msg.toolCalls) tokens += estimateTokensForText(JSON.stringify(msg.toolCalls))
  if (msg.toolResults) {
    for (const tr of msg.toolResults) tokens += estimateTokensForText(tr.content || '')
  }
  return tokens
}

/** 估算单条消息中"文件附件"部分的 token（图片按固定值，文件按路径文本） */
function estimateMessageAttachments(msg: Message): number {
  let tokens = 0
  for (const a of msg.attachments ?? []) {
    tokens += a.kind === 'image'
      ? IMAGE_TOKEN_ESTIMATE
      : estimateTokensForText(`${a.name}\n${a.path || ''}`)
  }
  return tokens
}

/**
 * 计算各分类的原始估算 token：
 * - system：系统提示词（由调用方传入估算值，随 SYSTEM_PROMPT 常量变化）
 * - summary：压缩摘要消息（isCompactSummary 标记）
 * - user / assistant：用户与助手消息正文（助手含思考内容）
 * - tools：工具调用参数与工具结果
 * - attachments：文件/图片附件
 */
export function computeRawBreakdown(messages: Message[], systemPromptTokens: number): ContextCategory[] {
  let summary = 0
  let user = 0
  let assistant = 0
  let tools = 0
  let attachments = 0

  for (const msg of messages) {
    if (msg._isCompacting) continue // 压缩过程占位，不占用真实上下文
    if (msg.isCompactSummary) {
      summary += estimateTokensForText(msg.content)
      continue
    }
    user += msg.role === 'user' ? estimateTokensForText(msg.content) : 0
    if (msg.role === 'assistant') {
      assistant += estimateTokensForText(msg.content) + estimateTokensForText(msg.thinkingContent || '')
    }
    tools += estimateMessageTools(msg)
    attachments += estimateMessageAttachments(msg)
  }

  return [
    { key: 'system', tokens: systemPromptTokens },
    { key: 'summary', tokens: summary },
    { key: 'user', tokens: user },
    { key: 'assistant', tokens: assistant },
    { key: 'tools', tokens: tools },
    { key: 'attachments', tokens: attachments },
  ]
}

/**
 * 压缩边界过滤：只保留 API 实际发送的消息子集。
 * 压缩后 UI 保留全部历史，但 API 只发送「摘要 + 边界之后的消息」。
 * 主循环/子 agent 的自动压缩判定与 buildAPIMessages 共用此口径，
 * 避免判定用全量历史、发送用子集导致的两边口径不一致。
 */
export function getApiVisibleMessages(messages: Message[]): Message[] {
  let lastSummaryIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isCompactSummary && messages[i].role !== 'system') {
      lastSummaryIdx = i
      break
    }
  }
  if (lastSummaryIdx === -1) return messages
  // 摘要之后 = summary + keptRecent + fileAttachments（都不含旧历史）
  return messages.slice(lastSummaryIdx)
}

/**
 * 汇总为面板可用的用量信息：
 * total 优先用 API 返回的 prompt_tokens（比估算更准），分类按比例缩放到 total，
 * 保证堆叠条与环形指示器的百分比一致。
 * 注意：统计基于 API 实际发送的消息子集（压缩后旧历史不计入）。
 */
export function computeContextUsage(
  messages: Message[],
  total: number,
  budget: number,
  systemPromptTokens: number
): ContextUsageInfo {
  const autoCompactThreshold = Math.max(budget - 20000, Math.floor(budget * 0.8))
  // 只统计 API 实际发送的消息子集（压缩后旧历史不计入）
  const apiMessages = getApiVisibleMessages(messages)
  const raw = computeRawBreakdown(apiMessages, systemPromptTokens)
  const rawSum = raw.reduce((acc, c) => acc + c.tokens, 0)
  const scale = rawSum > 0 && total > 0 ? total / rawSum : 0
  const categories = raw.map((c) => ({ key: c.key, tokens: Math.round(c.tokens * scale) }))
  return { total, budget, autoCompactThreshold, categories }
}

/** token 数展示格式：1234 → 1.2K */
export function formatContextTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}
