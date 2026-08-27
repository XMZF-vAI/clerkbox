import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, X, Zap } from 'lucide-react'
import { useChatStore } from '../../stores/chat-store'
import { useSettingsStore } from '../../stores/settings-store'
import { getSessionAgent } from '../../hooks/use-agent'
import { formatContextTokens, type ContextCategoryKey } from '../../lib/context-usage'
import type { Message } from '../../types/agent'

/** 会话级 token 汇总（从消息中的 usage 字段累加） */
function computeSessionTokenStats(messages: Message[]) {
  let promptTokens = 0
  let completionTokens = 0
  let cacheRead = 0
  let cacheCreation = 0
  let apiCalls = 0
  for (const m of messages) {
    if (!m.usage) continue
    apiCalls++
    promptTokens += m.usage.prompt_tokens
    completionTokens += m.usage.completion_tokens
    cacheRead += m.usage.cache_read_input_tokens ?? 0
    cacheCreation += m.usage.cache_creation_input_tokens ?? 0
  }
  const cacheHitRate = promptTokens > 0 ? cacheRead / promptTokens : 0
  return { promptTokens, completionTokens, cacheRead, cacheCreation, apiCalls, cacheHitRate }
}

/** 各分类的可视化颜色（面板堆叠条 + 图例共用） */
const CATEGORY_META: Record<ContextCategoryKey, { color: string; labelKey: string }> = {
  system: { color: '#9ca3af', labelKey: 'chat.ctxSystemPrompt' },
  summary: { color: '#c084fc', labelKey: 'chat.ctxCompactSummary' },
  user: { color: '#60a5fa', labelKey: 'chat.ctxUserMessages' },
  assistant: { color: '#4ade80', labelKey: 'chat.ctxAssistantMessages' },
  tools: { color: '#fbbf24', labelKey: 'chat.ctxToolCalls' },
  attachments: { color: '#22d3ee', labelKey: 'chat.ctxAttachments' },
}

/** 用量弧线颜色：< 警戒线蓝色，≥ 警戒线琥珀，≥ 自动压缩阈值红色 */
function arcColor(ratio: number, warningRatio: number): string {
  if (ratio >= 1) return '#f87171'
  if (ratio >= warningRatio) return '#fbbf24'
  return '#89b4fa'
}

/** 环形上下文用量指示器：细环 + 进度弧（顶部起点），点击展开统计面板 */
export default function ContextUsageIndicator() {
  const { t } = useTranslation()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const messages = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.messages)
  const maxInputTokens = useSettingsStore((s) => s.maxInputTokens)
  const activeModelId = useSettingsStore((s) => s.activeModelId)

  const [open, setOpen] = useState(false)
  const [compactPending, setCompactPending] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点击面板外部 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const agent = getSessionAgent(activeSessionId)
  const usage = useMemo(
    () => (agent && messages ? agent.getUsage(messages) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent, messages, maxInputTokens, activeModelId]
  )

  const compacting = !!messages?.some((m) => m._isCompacting)
  const hasMessages = !!messages && messages.length > 0
  const sessionStats = useMemo(() => messages ? computeSessionTokenStats(messages) : null, [messages])

  const ratio = usage && usage.budget > 0 ? usage.total / usage.budget : 0
  const warningRatio = usage && usage.budget > 0
    ? Math.max(usage.autoCompactThreshold - 10000, 0) / usage.budget
    : 0
  const clamped = Math.min(ratio, 1)
  const percent = Math.round(ratio * 100)

  // 圆环几何：r=7.25，周长≈45.55，-90° 让弧线从顶部开始
  const R = 7.25
  const CIRC = 2 * Math.PI * R

  const triggerCompact = async () => {
    if (!agent || compacting || compactPending || !hasMessages) return
    setCompactPending(true)
    try {
      await agent.manualCompact()
    } finally {
      setCompactPending(false)
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative mr-2"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('chat.contextUsageAria')}
        title={usage ? t('chat.ctxTotalTooltip', { used: formatContextTokens(usage.total), total: formatContextTokens(usage.budget), percent }) : t('chat.contextUsageAria')}
        className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
          <circle cx="9" cy="9" r={R} fill="none" strokeWidth="2" stroke="#ffffff" strokeOpacity={0.18} strokeDasharray={CIRC} />
          {usage && clamped > 0 && (
            <circle
              cx="9" cy="9" r={R} fill="none" strokeWidth="2" strokeLinecap="round"
              stroke={arcColor(ratio, warningRatio)}
              strokeDasharray={`${clamped * CIRC} ${CIRC}`}
            />
          )}
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-72 z-50 rounded-md3-lg border border-dark-onSurfaceVariant/15 bg-dark-surfaceContainer shadow-2xl p-4 animate-fade-in"
          role="dialog"
          aria-label={t('chat.contextUsageTitle')}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-dark-onSurface">{t('chat.contextUsageTitle')}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t('common.close')}
              className="w-6 h-6 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors"
            >
              <X size={13} />
            </button>
          </div>

          {!usage || !hasMessages ? (
            <p className="text-xs text-dark-onSurfaceVariant py-4 text-center">{t('chat.ctxEmpty')}</p>
          ) : (
            <>
              {/* 总量 */}
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-lg font-semibold text-dark-onSurface">
                  {formatContextTokens(usage.total)}
                  <span className="text-xs font-normal text-dark-onSurfaceVariant"> / {formatContextTokens(usage.budget)}</span>
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-md3-xs ${
                    ratio >= 1
                      ? 'bg-md-error/15 text-md-error'
                      : ratio >= warningRatio
                        ? 'bg-md-tertiary/15 text-md-tertiary'
                        : 'bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant'
                  }`}
                >
                  {percent}%
                </span>
              </div>

              {/* 分类堆叠条 */}
              <div className="flex h-2 rounded-full overflow-hidden bg-dark-surfaceContainerHigh mb-3">
                {usage.categories.filter((c) => c.tokens > 0).map((c) => (
                  <div
                    key={c.key}
                    style={{ width: `${Math.max((c.tokens / usage.total) * 100, 1.5)}%`, backgroundColor: CATEGORY_META[c.key].color }}
                  />
                ))}
              </div>

              {/* 图例明细 */}
              <div className="flex flex-col gap-1.5 mb-3">
                {usage.categories.filter((c) => c.tokens > 0).map((c) => (
                  <div key={c.key} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_META[c.key].color }} />
                    <span className="text-dark-onSurfaceVariant flex-1">{t(CATEGORY_META[c.key].labelKey)}</span>
                    <span className="text-dark-onSurface tabular-nums">{formatContextTokens(c.tokens)}</span>
                    <span className="text-dark-onSurfaceVariant tabular-nums w-9 text-right">
                      {usage.total > 0 ? Math.round((c.tokens / usage.total) * 100) : 0}%
                    </span>
                  </div>
                ))}
              </div>

              {/* 阈值提示 */}
              <p className="text-[11px] text-dark-onSurfaceVariant/80 mb-3">
                {t('chat.ctxAutoCompactHint', { tokens: formatContextTokens(usage.autoCompactThreshold) })}
              </p>

              {/* 会话 token 明细 */}
              {sessionStats && sessionStats.apiCalls > 0 && (
                <>
                  <div className="border-t border-dark-onSurfaceVariant/10 pt-3 mt-1 mb-3">
                    <div className="flex items-center gap-1.5 mb-2.5">
                      <Zap size={11} className="text-md-tertiary" />
                      <span className="text-xs font-medium text-dark-onSurface">{t('chat.ctxSessionStats')}</span>
                      <span className="text-[10px] text-dark-onSurfaceVariant ml-auto">{t('chat.ctxApiCalls', { count: sessionStats.apiCalls })}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-dark-onSurfaceVariant">{t('chat.ctxPromptTokens')}</span>
                        <span className="text-dark-onSurface tabular-nums">{formatContextTokens(sessionStats.promptTokens)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-dark-onSurfaceVariant">{t('chat.ctxCompletionTokens')}</span>
                        <span className="text-dark-onSurface tabular-nums">{formatContextTokens(sessionStats.completionTokens)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-dark-onSurfaceVariant">{t('chat.ctxCacheRead')}</span>
                        <span className="text-dark-onSurface tabular-nums">{formatContextTokens(sessionStats.cacheRead)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-dark-onSurfaceVariant">{t('chat.ctxCacheCreation')}</span>
                        <span className="text-dark-onSurface tabular-nums">{formatContextTokens(sessionStats.cacheCreation)}</span>
                      </div>
                    </div>
                    {/* 缓存命中率 */}
                    <div className="flex items-center justify-between mt-2.5 px-2 py-1.5 rounded-md3-xs bg-dark-surfaceContainerHigh">
                      <span className="text-xs text-dark-onSurfaceVariant">{t('chat.ctxCacheHitRate')}</span>
                      <span className={`text-xs font-medium tabular-nums ${
                        sessionStats.cacheHitRate >= 0.8
                          ? 'text-md-success'
                          : sessionStats.cacheHitRate >= 0.5
                            ? 'text-md-tertiary'
                            : 'text-md-error'
                      }`}>
                        {Math.round(sessionStats.cacheHitRate * 100)}%
                      </span>
                    </div>
                  </div>
                </>
              )}

              {/* 立即压缩 */}
              <button
                type="button"
                onClick={triggerCompact}
                disabled={compacting || compactPending}
                className="w-full h-8 flex items-center justify-center gap-1.5 rounded-md3-sm bg-md-primary text-md-onPrimary text-xs font-medium hover:bg-md-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {compacting || compactPending ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    {t('chat.ctxCompacting')}
                  </>
                ) : (
                  t('chat.ctxCompactNow')
                )}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
