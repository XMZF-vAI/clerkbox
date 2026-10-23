import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge, RefreshCw, X, Lock } from 'lucide-react'
import { useJouleStore } from '../../stores/joule-store'
import { ipc } from '../../lib/ipc-client'

function fmtUsd(value: number): string {
  return `$${(Number(value) || 0).toFixed(2)}`
}

function fmtClock(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function fmtDayTime(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function barClass(ratio: number): string {
  if (ratio >= 0.9) return 'bg-md-error'
  if (ratio >= 0.7) return 'bg-md-tertiary'
  return 'bg-md-primary'
}

/** 标题栏 5h 额度入口：紧凑百分比 + 长条弹层（详情跳仪表盘）。未连接 Joule 时不渲染。 */
export default function JouleQuotaButton() {
  const { t } = useTranslation()
  const status = useJouleStore((s) => s.status)
  const plan = useJouleStore((s) => s.plan)
  const quotas = useJouleStore((s) => s.quotas)
  const lastSyncAt = useJouleStore((s) => s.lastSyncAt)
  const stale = useJouleStore((s) => s.stale)
  const refresh = useJouleStore((s) => s.refresh)

  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 打开弹层时刷新一次（主进程 30 秒节流）
  useEffect(() => {
    if (!open) return
    setRefreshing(true)
    void refresh().finally(() => setRefreshing(false))
  }, [open, refresh])

  if (status === 'unlinked') return null

  const w5h = quotas?.w5h
  const ratio = w5h && w5h.cap > 0 ? Math.min(1, Math.max(0, w5h.used / w5h.cap)) : 0
  const percent = Math.round(ratio * 100)
  const subscribe = () => void ipc.openExternal('https://joule.xmzf.space/console#subscribe')
  const details = () => void ipc.jouleOpenDashboard('limits')

  return (
    <div ref={rootRef} className="relative mr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('joule.quotaButtonAria')}
        title={w5h ? t('joule.quotaButtonTitle', { percent }) : t('joule.quotaButtonAria')}
        className="h-8 max-md:h-10 px-1.5 max-md:px-2 flex items-center gap-1 rounded-md3-sm flex-shrink-0 hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant transition-colors"
      >
        <Gauge size={16} />
        <span className="text-[10px] max-md:text-xs tabular-nums">
          {w5h ? t('joule.quotaButtonCompact', { percent }) : t('joule.quotaButtonCompactNoData')}
        </span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-72 max-md:fixed max-md:top-[60px] max-md:left-1/2 max-md:right-auto max-md:-translate-x-1/2 max-md:w-[min(92vw,288px)] z-50 rounded-md3-lg border border-dark-onSurfaceVariant/15 bg-dark-surfaceContainer shadow-elevation-3 p-4 animate-fade-in"
          role="dialog"
          aria-label={t('joule.quotaTitle')}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-dark-onSurface">{t('joule.quotaTitle')}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setRefreshing(true)
                  void refresh().finally(() => setRefreshing(false))
                }}
                disabled={refreshing}
                aria-label={t('joule.refresh')}
                title={t('joule.refresh')}
                className="w-6 h-6 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh disabled:opacity-50"
              >
                <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('common.close')}
                className="w-6 h-6 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {status === 'needs_reauth' ? (
            <div className="py-3">
              <p className="text-xs text-md-error leading-relaxed">{t('joule.quotaNeedsReauth')}</p>
            </div>
          ) : status === 'expired' ? (
            <div className="py-2 flex flex-col gap-3">
              <p className="text-xs text-dark-onSurfaceVariant leading-relaxed">{t('joule.quotaExpiredHint')}</p>
              <button
                type="button"
                onClick={subscribe}
                className="w-full h-8 flex items-center justify-center gap-1.5 rounded-md3-sm bg-md-primary text-md-onPrimary text-xs font-medium hover:bg-md-primary/90 transition-colors"
              >
                <Lock size={12} /> {t('joule.subscribe')}
              </button>
            </div>
          ) : !plan ? (
            <div className="py-2 flex flex-col gap-3">
              <p className="text-xs text-dark-onSurfaceVariant leading-relaxed">{t('joule.quotaNoSubscription')}</p>
              <button
                type="button"
                onClick={subscribe}
                className="w-full h-8 flex items-center justify-center gap-1.5 rounded-md3-sm bg-md-primary text-md-onPrimary text-xs font-medium hover:bg-md-primary/90 transition-colors"
              >
                {t('joule.subscribe')}
              </button>
            </div>
          ) : !w5h ? (
            <p className="text-xs text-dark-onSurfaceVariant py-4 text-center">{t('joule.quotaNoData')}</p>
          ) : (
            <>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-lg font-semibold text-dark-onSurface tabular-nums">
                  {t('joule.quotaRemaining', { remaining: fmtUsd(w5h.remaining) })}
                  <span className="text-xs font-normal text-dark-onSurfaceVariant"> / {fmtUsd(w5h.cap)}</span>
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-md3-xs tabular-nums ${
                    ratio >= 0.9
                      ? 'bg-md-error/15 text-md-error'
                      : ratio >= 0.7
                        ? 'bg-md-tertiary/15 text-md-tertiary'
                        : 'bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant'
                  }`}
                >
                  {t('joule.quotaUsedPercent', { percent })}
                </span>
              </div>

              <div className="h-2.5 rounded-full overflow-hidden bg-dark-surfaceContainerHigh">
                <div
                  className={`h-full rounded-full transition-[width] duration-500 ${barClass(ratio)}`}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-1.5 mb-3 text-[11px] text-dark-onSurfaceVariant">
                <span>{t('joule.quotaUsed', { used: fmtUsd(w5h.used) })}</span>
                <span>{t('joule.quotaResumesAt', { time: fmtClock(w5h.resetAt) })}</span>
              </div>

              <div className="space-y-2 border-t border-dark-onSurfaceVariant/10 pt-3">
                {quotas?.week && (
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-dark-onSurfaceVariant mb-1">
                      <span>{t('joule.quotaWeek')}</span>
                      <span className="tabular-nums">{fmtUsd(quotas.week.remaining)} / {fmtUsd(quotas.week.cap)}</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden bg-dark-surfaceContainerHigh">
                      <div className={`h-full rounded-full ${barClass(quotas.week.cap > 0 ? quotas.week.used / quotas.week.cap : 0)}`} style={{ width: `${Math.min(100, Math.round((quotas.week.cap > 0 ? quotas.week.used / quotas.week.cap : 0) * 100))}%` }} />
                    </div>
                  </div>
                )}
                {quotas?.month && (
                  <div>
                    <div className="flex items-center justify-between text-[11px] text-dark-onSurfaceVariant mb-1">
                      <span>{t('joule.quotaMonth')}</span>
                      <span className="tabular-nums">{fmtUsd(quotas.month.remaining)} / {fmtUsd(quotas.month.cap)}</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden bg-dark-surfaceContainerHigh">
                      <div className={`h-full rounded-full ${barClass(quotas.month.cap > 0 ? quotas.month.used / quotas.month.cap : 0)}`} style={{ width: `${Math.min(100, Math.round((quotas.month.cap > 0 ? quotas.month.used / quotas.month.cap : 0) * 100))}%` }} />
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between mt-3">
                <span className="text-[10px] text-dark-onSurfaceVariant/70">
                  {stale
                    ? t('joule.stale')
                    : lastSyncAt
                      ? t('joule.lastSync', { time: fmtDayTime(lastSyncAt) })
                      : ''}
                </span>
                <button
                  type="button"
                  onClick={details}
                  className="h-7 px-3 rounded-md3-sm bg-md-primary/10 text-md-primary text-[11px] font-medium hover:bg-md-primary/20 transition-colors"
                >
                  {t('joule.quotaDetails')}
                </button>
              </div>
            </>
          )}

        </div>
      )}
    </div>
  )
}
