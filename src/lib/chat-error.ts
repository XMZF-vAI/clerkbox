/**
 * 聊天错误的分类与诊断文本（C4 的纯策略层）。
 *
 * 从 ChatErrorBanner.tsx 抽出：分类规则是这段逻辑里唯一会「决定用户下一步做什么」的部分
 * （去设置 / 等倒计时 / 压缩上下文 / 直接重试），值得脱离 React 单独被测住。
 */
import { extractRetryAfterMs, isContextOverflowError, isRetryableError } from '../agent-core/loop'

export type ChatErrorCode = 'rate_limit' | 'auth' | 'context_overflow' | 'network' | 'retryable' | 'unknown'

/** 需要用户去设置页处理的凭证/配额类错误（重试无用） */
const AUTH_PATTERN =
  /\b(401|403)\b|unauthorized|authentication|invalid.?api.?key|api.?key|base.?url|forbidden|insufficient_quota|quota|billing|insufficient balance|payment required|credit/i

/** 限流类错误（带 Retry-After 时倒计时后可重试） */
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests/i

/** 网络中断类错误（断网 / DNS / 代理 / fetch 失败） */
const NETWORK_PATTERN =
  /timeout|timed out|network|fetch failed|failed to fetch|econnreset|econnrefused|enotfound|eai_again|socket hang up|err_network|dns|proxy/i

/**
 * 错误分类：判定优先级 溢出 → 鉴权/配额 → 限流 → 网络 → 通用可重试 → 未知。
 * 配额必须抢在裸 429 之前：OpenAI 的 insufficient_quota 同样以 HTTP 429 送达，
 * 先判限流就会渲染成「稍后重试」，永远不给出去设置的按钮——用户对着一个重试不掉的错误干等。
 * 溢出与「是否可重试」直接复用 agent-core 的判定，不在此重复实现。
 */
export function classifyChatError(raw: string): ChatErrorCode {
  if (isContextOverflowError(raw)) return 'context_overflow'
  if (AUTH_PATTERN.test(raw)) return 'auth'
  if (RATE_LIMIT_PATTERN.test(raw)) return 'rate_limit'
  if (NETWORK_PATTERN.test(raw)) return 'network'
  if (isRetryableError(raw)) return 'retryable'
  return 'unknown'
}

/** 供文案层复用：Retry-After 头/正文里的等待毫秒数（无限流语义时返回 null） */
export function retryAfterFromError(raw: string): number | null {
  return extractRetryAfterMs(raw)
}

/** 诊断文本：错误码 + 时间戳 + 原文摘要 + 日志位置（联动 A1 的主进程日志落盘） */
export function buildDiagnosticPayload(params: {
  code: ChatErrorCode
  message: string
  sessionId: string
  timestamp: number
}): string {
  const { code, message, sessionId, timestamp } = params
  return [
    `code=${code}`,
    `time=${new Date(timestamp).toISOString()}`,
    `session=${sessionId || 'unknown'}`,
    `platform=${typeof navigator !== 'undefined' ? navigator.platform : 'unknown'}`,
    `log=%APPDATA%\\clerkbox\\logs\\main.log`,
    '',
    message.slice(0, 2000),
  ].join('\n')
}

/** 错误码 → chat.error.* 文案 key（新增 key 需双语补齐） */
export const CODE_LABEL_KEY: Record<ChatErrorCode, string> = {
  rate_limit: 'chat.error.rateLimit',
  auth: 'chat.error.auth',
  context_overflow: 'chat.error.contextOverflow',
  network: 'chat.error.network',
  retryable: 'chat.error.retryable',
  unknown: 'chat.error.unknown',
}
