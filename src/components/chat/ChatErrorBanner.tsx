import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Copy, Check, RefreshCw, Settings, Archive } from 'lucide-react'
import { extractRetryAfterMs, isContextOverflowError, isRetryableError } from '../../agent-core/loop'
import { useSettingsStore } from '../../stores/settings-store'

export type ChatErrorCode =
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'network'
  | 'retryable'
  | 'unknown'

/** 错误码 → chat.error.* 文案 key（新增 key 需双语补齐） */
const CODE_LABEL_KEY: Record<ChatErrorCode, string> = {
  rate_limit: 'chat.error.rateLimit',
  auth: 'chat.error.auth',
  context_overflow: 'chat.error.contextOverflow',
  network: 'chat.error.network',
  retryable: 'chat.error.retryable',
  unknown: 'chat.error.unknown',
}

/** 需要用户去设置页处理的凭证/配额类错误（重试无用） */
const AUTH_PATTERN =
  /\b(401|403)\b|unauthorized|authentication|invalid.?api.?key|api.?key|base.?url|forbidden|insufficient_quota|quota|billing|insufficient balance|payment required|credit/i

/** 限流类错误（带 Retry-After 时倒计时后可重试） */
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests/i

/** 网络中断类错误（断网 / DNS / 代理 / fetch 失败） */
const NETWORK_PATTERN =
  /timeout|timed out|network|fetch failed|failed to fetch|econnreset|econnrefused|enotfound|eai_again|socket hang up|err_network|dns|proxy/i

/** 错误分类：判定优先级 溢出 → 限流 → 鉴权/配额 → 网络 → 通用可重试 → 未知。
 *  溢出与「是否可重试」直接复用 agent-core 的判定，不在此重复实现。 */
export function classifyChatError(raw: string): ChatErrorCode {
  if (isContextOverflowError(raw)) return 'context_overflow'
  if (RATE_LIMIT_PATTERN.test(raw)) return 'rate_limit'
  if (AUTH_PATTERN.test(raw)) return 'auth'
  if (NETWORK_PATTERN.test(raw)) return 'network'
  if (isRetryableError(raw)) return 'retryable'
  return 'unknown'
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

interface ChatErrorBannerProps {
  /** useAgent 的 error 原文；null / 空串时不渲染 */
  error?: string | null
  sessionId: string
  vibe?: boolean
  /** 上下文压缩进行中：禁用「立即压缩」按钮 */
  isCompacting?: boolean
  /** 是否可安全重发最后一条用户消息（会话空闲且存在用户消息） */
  canRetry?: boolean
  onCompact?: () => void
  onRetry?: () => void
}

const ACTION_BUTTON_BASE =
  'inline-flex items-center gap-1 rounded-md3-xs px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50'

export default function ChatErrorBanner({
  error,
  sessionId,
  vibe = false,
  isCompacting = false,
  canRetry = false,
  onCompact,
  onRetry,
}: ChatErrorBannerProps) {
  const { t } = useTranslation()
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [copied, setCopied] = useState(false)

  const code = useMemo<ChatErrorCode>(() => (error ? classifyChatError(error) : 'unknown'), [error])
  const retryAfterMs = useMemo(() => (error ? extractRetryAfterMs(error) ?? 0 : 0), [error])
  const [remainingMs, setRemainingMs] = useState(0)

  // 所有 hooks 先于 early return 执行，避免 error 出现/消失时 hook 数量变化
  useEffect(() => {
    if (!error || retryAfterMs <= 0) {
      setRemainingMs(0)
      return
    }
    const start = Date.now()
    setRemainingMs(retryAfterMs)
    const timer = setInterval(() => {
      const left = retryAfterMs - (Date.now() - start)
      if (left <= 0) {
        setRemainingMs(0)
        clearInterval(timer)
      } else {
        setRemainingMs(left)
      }
    }, 250)
    return () => clearInterval(timer)
  }, [error, retryAfterMs])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  if (!error) return null

  const showCompact = code === 'context_overflow' && !!onCompact
  const retryBlockedByCountdown = remainingMs > 0
  const secondsLeft = Math.ceil(remainingMs / 1000)
  // 重试只在能安全重发的场景出现；倒计时期间即便暂不可重发也保留按钮，用于展示等待时长
  const showRetry =
    (code === 'rate_limit' || code === 'network' || code === 'retryable') &&
    !!onRetry &&
    (canRetry || retryBlockedByCountdown)
  const showSettings = code === 'auth'

  const handleCopy = async () => {
    const payload = buildDiagnosticPayload({
      code,
      message: error,
      sessionId,
      timestamp: Date.now(),
    })
    try {
      await navigator.clipboard.writeText(payload)
      setCopied(true)
    } catch (e) {
      console.error('Failed to copy diagnostics:', e)
    }
  }

  const toneClass = vibe
    ? 'bg-white/10 border border-white/20 text-white/90'
    : 'bg-md-error/10 border border-md-error/20 text-md-error'
  const actionClass = vibe
    ? `${ACTION_BUTTON_BASE} bg-white/15 text-white/90 hover:bg-white/25`
    : `${ACTION_BUTTON_BASE} bg-md-error/15 text-md-error hover:bg-md-error/25`

  return (
    <div role="alert" className={`mx-4 mb-2 flex flex-col gap-1.5 rounded-md3-sm px-4 py-2.5 ${toneClass}`}>
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t(CODE_LABEL_KEY[code])}</div>
          <div className="line-clamp-4 text-xs break-words opacity-80">{error}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        {showCompact && (
          <button type="button" onClick={onCompact} disabled={isCompacting} className={actionClass}>
            <Archive size={12} />
            {t(isCompacting ? 'chat.ctxCompacting' : 'chat.ctxCompactNow')}
          </button>
        )}
        {showRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={!canRetry || retryBlockedByCountdown}
            className={actionClass}
          >
            <RefreshCw size={12} />
            {retryBlockedByCountdown
              ? t('chat.error.retryIn', { seconds: secondsLeft })
              : t('chat.error.retry')}
          </button>
        )}
        {showSettings && (
          <button
            type="button"
            onClick={() => updateSettings({ showSettings: true, pendingSettingsTab: 'api' })}
            className={actionClass}
          >
            <Settings size={12} />
            {t('chat.error.openSettings')}
          </button>
        )}
        <button type="button" onClick={handleCopy} className={actionClass}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {t(copied ? 'chat.error.copied' : 'chat.error.copyDiagnostics')}
        </button>
      </div>
    </div>
  )
}
