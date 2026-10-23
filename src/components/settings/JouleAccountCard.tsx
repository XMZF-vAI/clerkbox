import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  BarChart3,
  Check,
  Copy,
  CreditCard,
  ExternalLink,
  History,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  X,
} from 'lucide-react'
import { useJouleStore } from '../../stores/joule-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import JOULE_MARK from '../../assets/joule-mark.png'

const SUBSCRIBE_URL = 'https://joule.xmzf.space/console#subscribe'

function fmtUsd(value: number): string {
  return `$${(Number(value) || 0).toFixed(2)}`
}

function fmtDate(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function fmtDateTime(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const chipCls: Record<string, string> = {
  connected: 'bg-md-primary/15 text-md-primary',
  expired: 'bg-md-error/15 text-md-error',
  needs_reauth: 'bg-md-error/15 text-md-error',
  error: 'bg-md-tertiary/15 text-md-tertiary',
}

/** 设置 → 账号：Joule 账号卡（与热土账号完全独立）。 */
export default function JouleAccountCard() {
  const { t } = useTranslation()
  const status = useJouleStore((s) => s.status)
  const user = useJouleStore((s) => s.user)
  const subscription = useJouleStore((s) => s.subscription)
  const expired = useJouleStore((s) => s.expired)
  const plan = useJouleStore((s) => s.plan)
  const quotas = useJouleStore((s) => s.quotas)
  const lastSyncAt = useJouleStore((s) => s.lastSyncAt)
  const stale = useJouleStore((s) => s.stale)
  const error = useJouleStore((s) => s.error)
  const loggingIn = useJouleStore((s) => s.loggingIn)
  const userCode = useJouleStore((s) => s.userCode)
  const loginExpiresAt = useJouleStore((s) => s.loginExpiresAt)
  const verificationUri = useJouleStore((s) => s.verificationUri)
  const login = useJouleStore((s) => s.login)
  const cancelLogin = useJouleStore((s) => s.cancelLogin)
  const logout = useJouleStore((s) => s.logout)
  const refresh = useJouleStore((s) => s.refresh)

  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!loggingIn) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [loggingIn])

  const doRefresh = () => {
    if (busy || loggingIn) return
    setBusy(true)
    void refresh().finally(() => setBusy(false))
  }

  const openDashboard = (section?: string) => void ipc.jouleOpenDashboard(section)
  const subscribe = () => void ipc.openExternal(SUBSCRIBE_URL)

  const copyLink = async () => {
    if (!verificationUri) return
    let ok = false
    try {
      await navigator.clipboard.writeText(verificationUri)
      ok = true
    } catch {
      // Electron 渲染层可能拒绝 Clipboard API：退回 textarea + execCommand
      try {
        const area = document.createElement('textarea')
        area.value = verificationUri
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        ok = document.execCommand('copy')
        area.remove()
      } catch {
        ok = false
      }
    }
    if (ok) {
      setCopied(true)
      setCopyFailed(false)
      window.setTimeout(() => setCopied(false), 2000)
    } else {
      setCopyFailed(true)
    }
  }

  const statusKey =
    status === 'connected' ? 'joule.statusConnected'
      : status === 'expired' ? 'joule.statusExpired'
        : status === 'needs_reauth' ? 'joule.statusNeedsReauth'
          : status === 'error' ? 'joule.statusError'
            : 'joule.statusUnlinked'

  const remainingMs = loginExpiresAt ? Math.max(0, loginExpiresAt - now) : 0
  const remainingLabel = `${String(Math.floor(remainingMs / 60000)).padStart(2, '0')}:${String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0')}`

  const w5h = quotas?.w5h
  const w5hRatio = w5h && w5h.cap > 0 ? Math.min(1, Math.max(0, w5h.used / w5h.cap)) : 0
  const displayName = user?.username || user?.email || t('joule.userFallback')
  const showRefresh = status !== 'unlinked' && !loggingIn
  const showAccount = status === 'connected' || status === 'expired'
  const primaryIsSubscribe = !plan

  return (
    <div className="space-y-3 p-4 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
      <div className="flex items-center gap-2">
        <img src={JOULE_MARK} alt="" className="w-4 h-4 rounded-[4px] flex-shrink-0" />
        <span className="text-sm font-medium text-dark-onSurface">{t('joule.accountTitle')}</span>
        <span className={`px-1.5 py-0.5 rounded-md3-xs text-[10px] font-medium whitespace-nowrap ${chipCls[status] ?? 'bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant'}`}>
          {t(statusKey)}
        </span>
        <span className="flex-1" />
        {showRefresh && (
          <button
            type="button"
            onClick={doRefresh}
            disabled={busy || loggingIn}
            title={t('joule.refresh')}
            aria-label={t('joule.refresh')}
            className="w-6 h-6 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh disabled:opacity-50"
          >
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      {isWebUIMode ? (
        <div className="space-y-2">
          <p className="text-xs text-dark-onSurfaceVariant/70 leading-relaxed">{t('joule.webuiNote')}</p>
          <button
            type="button"
            onClick={() => openDashboard()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-sm bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors text-xs font-medium"
          >
            <ExternalLink size={12} /> {t('joule.openDashboard')}
          </button>
        </div>
      ) : loggingIn ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Loader2 size={13} className="animate-spin text-md-primary flex-shrink-0" />
            <span className="text-xs text-dark-onSurface">{t('joule.loggingIn')}</span>
          </div>
          <div className="flex items-center justify-between gap-3 p-3 rounded-md3-sm bg-dark-surfaceContainer">
            <div className="min-w-0">
              <div className="text-[10px] text-dark-onSurfaceVariant/70">{t('joule.userCodeLabel')}</div>
              <div className="text-lg font-semibold tracking-[0.18em] text-dark-onSurface tabular-nums">{userCode || '----'}</div>
            </div>
            <div className="text-[11px] text-dark-onSurfaceVariant tabular-nums flex-shrink-0">{remainingLabel}</div>
          </div>
          <p className="text-[11px] text-dark-onSurfaceVariant/60 leading-relaxed">{t('joule.userCodeHint')}</p>
          {copyFailed && <p className="text-[11px] text-md-error">{t('joule.copyFailed')}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copyLink()}
              disabled={!verificationUri}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-sm bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-xs font-medium text-dark-onSurfaceVariant disabled:opacity-50"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? t('joule.copied') : t('joule.copyLink')}</span>
            </button>
            <button
              type="button"
              onClick={() => void cancelLogin()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-md-error/15 hover:text-md-error transition-colors"
            >
              <X size={12} /> {t('joule.cancelLogin')}
            </button>
          </div>
        </div>
      ) : status === 'unlinked' ? (
        <div className="space-y-2">
          <p className="text-xs text-dark-onSurfaceVariant/70 leading-relaxed">{t('joule.accountDesc')}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => void login()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md3-sm bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors text-xs font-medium"
            >
              <LogIn size={13} /> {t('joule.login')}
            </button>
            <button
              type="button"
              onClick={() => openDashboard()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md3-sm bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-xs font-medium text-dark-onSurfaceVariant"
            >
              <ExternalLink size={12} /> {t('joule.openDashboard')}
            </button>
          </div>
        </div>
      ) : status === 'needs_reauth' ? (
        <div className="space-y-2">
          <p role="alert" className="flex items-start gap-1.5 text-xs text-md-error leading-relaxed">
            <AlertCircle size={13} className="flex-shrink-0 mt-px" /> {t('joule.reauthHint')}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => void login()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md3-sm bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors text-xs font-medium"
            >
              <LogIn size={13} /> {t('joule.relogin')}
            </button>
            <button
              type="button"
              onClick={() => openDashboard()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md3-sm bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-xs font-medium text-dark-onSurfaceVariant"
            >
              <ExternalLink size={12} /> {t('joule.openDashboard')}
            </button>
          </div>
        </div>
      ) : status === 'error' ? (
        <div className="space-y-2">
          <p role="alert" className="flex items-start gap-1.5 text-xs text-md-error leading-relaxed break-all">
            <AlertCircle size={13} className="flex-shrink-0 mt-px" /> {error || t('joule.quotaNoData')}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={doRefresh}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md3-sm bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors text-xs font-medium disabled:opacity-50"
            >
              <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> {t('joule.retry')}
            </button>
            <button
              type="button"
              onClick={() => openDashboard()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md3-sm bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-xs font-medium text-dark-onSurfaceVariant"
            >
              <ExternalLink size={12} /> {t('joule.openDashboard')}
            </button>
          </div>
        </div>
      ) : showAccount ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-dark-onSurface truncate">{displayName}</div>
              {user?.email && user.email !== user.username && (
                <div className="text-[11px] text-dark-onSurfaceVariant/70 truncate">{user.email}</div>
              )}
            </div>
            {subscription ? (
              <span className="px-1.5 py-0.5 rounded-md3-xs bg-md-primary/15 text-md-primary text-[10px] font-medium whitespace-nowrap">
                {subscription.label} · {fmtDate(subscription.expiresAt)}
              </span>
            ) : (
              <span className="px-1.5 py-0.5 rounded-md3-xs bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant text-[10px] font-medium whitespace-nowrap">
                {expired ? `${t('joule.statusExpired')} · ${fmtDate(expired.expiresAt)}` : t('joule.noSubscription')}
              </span>
            )}
          </div>

          {w5h && plan && (
            <div>
              <div className="flex items-center justify-between text-[11px] text-dark-onSurfaceVariant mb-1">
                <span>{t('joule.fiveHourQuota')}</span>
                <span className="tabular-nums">{t('joule.remainingOf', { remaining: fmtUsd(w5h.remaining), cap: fmtUsd(w5h.cap) })}</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden bg-dark-surfaceContainerHigh">
                <div
                  className={`h-full rounded-full ${w5hRatio >= 0.9 ? 'bg-md-error' : w5hRatio >= 0.7 ? 'bg-md-tertiary' : 'bg-md-primary'}`}
                  style={{ width: `${Math.round(w5hRatio * 100)}%` }}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={primaryIsSubscribe ? subscribe : () => openDashboard()}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-sm bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors text-xs font-medium"
            >
              {primaryIsSubscribe ? <CreditCard size={13} /> : <ExternalLink size={13} />}
              {primaryIsSubscribe ? t('joule.subscribe') : t('joule.openDashboard')}
            </button>
            <button
              type="button"
              onClick={primaryIsSubscribe ? () => openDashboard() : subscribe}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-sm bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-xs font-medium text-dark-onSurfaceVariant"
            >
              {primaryIsSubscribe ? <ExternalLink size={13} /> : <CreditCard size={13} />}
              {primaryIsSubscribe ? t('joule.openDashboard') : t('joule.subscribe')}
            </button>
            <button
              type="button"
              onClick={() => openDashboard('records')}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-sm bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-xs font-medium text-dark-onSurfaceVariant"
            >
              <History size={13} /> {t('joule.quickRecords')}
            </button>
            <button
              type="button"
              onClick={() => openDashboard('limits')}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-sm bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-xs font-medium text-dark-onSurfaceVariant"
            >
              <BarChart3 size={13} /> {t('joule.quickLimits')}
            </button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-dark-onSurfaceVariant/60">
              {stale ? t('joule.stale') : lastSyncAt ? t('joule.lastSync', { time: fmtDateTime(lastSyncAt) }) : ''}
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md3-sm text-[11px] text-dark-onSurfaceVariant hover:bg-md-error/15 hover:text-md-error transition-colors"
            >
              <LogOut size={12} /> {t('joule.logout')}
            </button>
          </div>
          <p className="text-[10px] text-dark-onSurfaceVariant/50 leading-relaxed">{t('joule.logoutHint')}</p>
        </>
      ) : null}
    </div>
  )
}
