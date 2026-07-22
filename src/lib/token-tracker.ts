import type { Message, TokenUsage } from '../types/agent'
import { estimateTokensForText, estimateTokensForMessages } from './token-estimate'

/**
 * Tracks token usage for a session.
 * Prioritizes actual API usage data over estimation.
 */
export class TokenTracker {
  private lastUsage: TokenUsage | null = null

  /** Record usage from API response */
  recordUsage(usage: TokenUsage): void {
    this.lastUsage = usage
  }

  /** Get the best available token count for the current context.
   *  Returns lastUsage.prompt_tokens if available (most accurate),
   *  otherwise falls back to estimating from messages.
   */
  getTokenCount(messages: Message[]): number {
    if (this.lastUsage) {
      // Use actual API usage + estimate of messages added since last API call
      // (tool results, new user messages, etc.)
      const estimatedNew = this.estimateTokensFromMessages(messages)
      // The lastUsage.prompt_tokens represents the tokens at the time of the last API call.
      // Since messages may have grown since then, we use the larger of the two.
      return Math.max(this.lastUsage.prompt_tokens, estimatedNew)
    }
    return this.estimateTokensFromMessages(messages)
  }

  /** Estimate token count from message array using the unified heuristic */
  estimateTokensFromMessages(messages: Message[]): number {
    return estimateTokensForMessages(messages)
  }

  /** Estimate tokens from text using the unified heuristic */
  private estimateTokens(text: string): number {
    return estimateTokensForText(text)
  }

  /** Reset tracker (e.g., after compaction) */
  reset(): void {
    this.lastUsage = null
  }

  /** Get last recorded usage (may be null) */
  getLastUsage(): TokenUsage | null {
    return this.lastUsage
  }
}
