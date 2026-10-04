import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, KeyRound, Link2, Loader2, RotateCcw, Unlink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmDialog from '../ui/ConfirmDialog'
import { useOverlayKeyboardLock } from '../ui/Modal'
import { ipc } from '../../lib/ipc-client'
import type { BotListItem, Binding } from '../../../electron/im-bots/types'

interface BindPanelProps {
  bot: BotListItem
  onChanged: () => void
}

/** 危险操作的目标：解绑与重置都是「改了 IM 侧的身份状态」，都要过确认 */
type PendingAction =
  | { kind: 'unbind'; actor: Binding }
  | { kind: 'reset'; actor: Binding }
  | null

/** 绑定时刻的展示格式：只到分钟，手机上没人看秒；有效期判定另有 `bindCodeIsLive` 口径 */
function formatBoundAt(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 绑定管理：桌面端签发绑定码 → IM 私聊里发 `/bind 码` → 主进程核销并记账。
 *
 * 绑定码 30 秒单次有效，所以倒计时走完就当作不存在（与主进程 `bindCodeIsLive` 同口径），
 * 界面上留旧码只会让用户在微信里发一个已经废掉的码，然后困惑于「为什么没反应」。
 */
export default function BindPanel({ bot, onChanged }: BindPanelProps) {
  const { t } = useTranslation()
  const [code, setCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number>(0)
  const [remaining, setRemaining] = useState(0)
  const [issuing, setIssuing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingAction>(null)
  const copiedTimer = useRef<number | null>(null)

  // 确认框叠在本面板之上：期间让出所属 Modal 的 Esc / Tab，避免一次按键关掉两层
  useOverlayKeyboardLock(pending !== null)

  // 切换 bot 时清掉上一个的绑定码：码是 per-bot 的，串号显示等于给了个永远无效的码
  useEffect(() => {
    setCode(null)
    setExpiresAt(0)
    setRemaining(0)
    setActionError(null)
  }, [bot.id])

  // 倒计时：本地每秒推一次，过期不弹提示、只把「重新生成」端出来，减少对主进程的无谓请求
  useEffect(() => {
    if (!code || !expiresAt) return
    const tick = () => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [code, expiresAt])

  useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    },
    []
  )

  const generate = useCallback(async () => {
    if (issuing) return
    setIssuing(true)
    setActionError(null)
    try {
      const result = await ipc.bots.generateBindCode(bot.id)
      if (result.ok && result.code && result.expiresAt) {
        setCode(result.code)
        setExpiresAt(result.expiresAt)
        setRemaining(Math.max(0, Math.ceil((result.expiresAt - Date.now()) / 1000)))
      } else {
        setCode(null)
        setActionError(t('bots.error.bindFailed'))
      }
    } catch {
      setCode(null)
      setActionError(t('bots.error.bindFailed'))
    } finally {
      setIssuing(false)
    }
  }, [bot.id, issuing, t])

  const copyCommand = useCallback(async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(`/bind ${code}`)
      setCopied(true)
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* 剪贴板不可用时忽略（与既有 WebUI 复制同一处理） */
    }
  }, [code])

  const runPending = useCallback(async () => {
    if (!pending) return
    const actor = pending.actor
    try {
      const result =
        pending.kind === 'unbind' ? await ipc.bots.unbindActor(actor.actorKey) : await ipc.bots.resetActor(actor.actorKey)
      if (!result.ok) setActionError(result.error)
      await onChanged()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }, [onChanged, pending])

  const live = !!code && remaining > 0

  return (
    <div className="p-3 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
      <div className="flex items-center gap-2 mb-1">
        <Link2 size={15} className="text-md-primary flex-shrink-0" />
        <span className="text-ui-sm font-medium text-dark-onSurface">{t('bots.bind.title')}</span>
      </div>
      <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-3">{t('bots.bind.desc')}</p>

      {/* 凭据都没有时，绑定命令是发不进来的：先让用户把渠道接通 */}
      {!bot.hasCredential ? (
        <p className="text-ui-xs text-md-warning leading-relaxed">{t('bots.bind.needCredential')}</p>
      ) : (
        <div className="mb-3">
          {live ? (
            <div className="flex items-center gap-2 p-2.5 rounded-md3-sm bg-dark-surfaceContainerHigh">
              <div className="flex-1 min-w-0">
                <p className="text-ui-xs uppercase tracking-wider text-dark-onSurfaceVariant/50 mb-0.5">
                  {t('bots.bind.codeLabel')}
                </p>
                <code className="block text-ui-sm font-mono break-all select-all text-dark-onSurface">
                  {t('bots.bind.command', { code })}
                </code>
              </div>
              <button
                type="button"
                onClick={copyCommand}
                aria-label={t('bots.bind.copy')}
                title={t('bots.bind.copy')}
                className="md-focus flex-shrink-0 w-7 h-7 max-md:w-9 max-md:h-9 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainer transition-colors"
              >
                {copied ? <Check size={14} className="text-md-primary" /> : <Copy size={14} />}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={generate}
              disabled={issuing}
              className="md-focus w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md3-sm text-ui-sm font-medium bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors disabled:opacity-50"
            >
              {issuing ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
              <span>{code ? t('bots.bind.regenerate') : t('bots.bind.generate')}</span>
            </button>
          )}

          {live && (
            <div className="flex items-center justify-between mt-1.5">
              <p className="text-ui-xs text-dark-onSurfaceVariant/60">
                {t('bots.bind.expiresIn', { seconds: remaining })}
              </p>
              {copied && <p className="text-ui-xs text-md-primary">{t('bots.bind.copied')}</p>}
            </div>
          )}
          {!live && code && (
            <p className="text-ui-xs text-md-warning mt-1.5">{t('bots.bind.expired')}</p>
          )}
        </div>
      )}

      <div className="pt-3 border-t border-dark-onSurfaceVariant/10">
        <p className="text-ui-xs font-medium text-dark-onSurfaceVariant/50 uppercase tracking-wider mb-2">
          {bot.boundActors.length > 0
            ? t('bots.bind.boundCount', { total: bot.boundActors.length })
            : t('bots.bind.boundSection')}
        </p>

        {bot.boundActors.length === 0 ? (
          <p className="text-ui-xs text-dark-onSurfaceVariant/60">{t('bots.bind.boundNone')}</p>
        ) : (
          <ul className="space-y-1.5">
            {bot.boundActors.map((actor) => (
              <li
                key={actor.actorKey}
                className="flex items-center gap-2 px-2.5 py-2 rounded-md3-sm bg-dark-surfaceContainerHigh"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-ui-xs text-dark-onSurface truncate">
                    {actor.displayName || t('bots.bind.accountUnknown')}
                  </p>
                  <p className="text-ui-xs text-dark-onSurfaceVariant/50 truncate tabular-nums">
                    {actor.providerUserId}
                    {actor.boundAt ? ` · ${formatBoundAt(actor.boundAt)}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPending({ kind: 'reset', actor })}
                  aria-label={t('bots.bind.reset')}
                  title={t('bots.bind.reset')}
                  className="md-focus flex-shrink-0 w-7 h-7 max-md:w-9 max-md:h-9 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainer hover:text-dark-onSurface transition-colors"
                >
                  <RotateCcw size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setPending({ kind: 'unbind', actor })}
                  aria-label={t('bots.bind.unbind')}
                  title={t('bots.bind.unbind')}
                  className="md-focus flex-shrink-0 w-7 h-7 max-md:w-9 max-md:h-9 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant/70 hover:bg-md-error/20 hover:text-md-error transition-colors"
                >
                  <Unlink size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {actionError && (
        <p role="alert" className="mt-2 text-ui-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2">
          {actionError}
        </p>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.kind === 'unbind' ? t('bots.bind.unbindTitle') : t('bots.bind.resetTitle')}
          message={pending.kind === 'unbind' ? t('bots.bind.unbindMsg') : t('bots.bind.resetMsg')}
          confirmText={pending.kind === 'unbind' ? t('bots.bind.unbind') : t('bots.bind.reset')}
          cancelText={t('common.cancel')}
          variant="danger"
          onConfirm={runPending}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}
