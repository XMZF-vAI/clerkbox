/**
 * Unified token estimation helpers.
 * Provides a single heuristic for counting tokens from text / messages.
 */

/** Estimate tokens from a single string.
 *  - CJK / full-width: ~1.5 chars/token
 *  - Emoji / extended unicode: ~1 char/token
 *  - Other ASCII / Latin: ~4 chars/token
 */
export function estimateTokensForText(text: string): number {
  if (!text) return 0
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
  const emojiChars = (text.match(/[\u{1f300}-\u{1f9ff}\u{2600}-\u{26ff}\u{2700}-\u{27bf}]/gu) || []).length
  const otherChars = text.length - cjkChars - emojiChars
  return Math.ceil(cjkChars / 1.5 + emojiChars + otherChars / 4)
}

/** Estimate tokens from an array of messages.
 *  Handles content, toolCalls, toolResults, and thinkingContent fields.
 *  注意：tool 消息的 content 与 toolResults[0].content 是同一份文本（构造时复用），
 *  重复计入会让工具密集会话的估算接近翻倍、提前触发昂贵的自动压缩 → 内容相同只计一次。
 */
export function estimateTokensForMessages<T extends { role?: string; content?: string; toolCalls?: unknown; toolResults?: unknown[]; thinkingContent?: string }>(
  messages: T[]
): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokensForText(msg.content || '')
    if (msg.toolCalls) {
      total += estimateTokensForText(JSON.stringify(msg.toolCalls))
    }
    if (msg.thinkingContent) {
      total += estimateTokensForText(msg.thinkingContent)
    }
    if (msg.toolResults) {
      for (const tr of msg.toolResults as { content?: string }[]) {
        if (tr.content !== undefined && tr.content === msg.content) continue
        total += estimateTokensForText(tr.content || '')
      }
    }
  }
  return total
}

/** Truncate plain text to an approximate token budget, keeping the head. */
export function truncateTextToTokens(content: string, maxTokens: number): string {
  if (!content) return content
  if (estimateTokensForText(content) <= maxTokens) {
    return content
  }
  const marker = '\n\n[... content truncated for compaction ...]'
  const charBudget = maxTokens * 3
  return content.slice(0, Math.max(0, charBudget - marker.length)) + marker
}
