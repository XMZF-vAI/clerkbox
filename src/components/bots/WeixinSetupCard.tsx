import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, RefreshCw, ScanLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import QrCode from '../ui/QrCode'
import { ipc } from '../../lib/ipc-client'
import type { BotListItem, WeixinQrSession, WeixinQrState } from '../../../electron/im-bots/types'

interface WeixinSetupCardProps {
  bot: BotListItem
  /** 扫码成功后重拉列表：hasCredential 由主进程写凭据的那一刻才翻真，本地判不出来 */
  onChanged: () => void
}

/** 二维码状态轮询兜底间隔：主进程长轮询任意时刻广播，事件漏一次界面就会停在「等待扫码」 */
const PEEK_INTERVAL_MS = 2_000

/**
 * 微信扫码登录卡片。
 *
 * 二维码内容（iLink 的扫码链接，带登录态凭据）只交给本地 `QrCode` 画码：
 * 不渲染成可读文本、不进 console、不拼进任何可复制的链接——它与 WebUI 地址里的 token
 * 同级别敏感，泄漏出去等于把这台机器的 IM 入口交给别人。
 */
export default function WeixinSetupCard({ bot, onChanged }: WeixinSetupCardProps) {
  const { t } = useTranslation()
  const [session, setSession] = useState<WeixinQrSession | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // 会话快照的 ref 镜像：事件回调里要拿「当前这一帧」的会话补字段，而 setState 的 updater
  // 里塞副作用（停轮询、重拉列表）会被 StrictMode 双调用，所以状态与 ref 一起维护。
  const sessionRef = useRef<WeixinQrSession | null>(null)

  const applySession = useCallback((next: WeixinQrSession | null) => {
    sessionRef.current = next
    setSession(next)
  }, [])

  const stopSession = useCallback((sessionId: string) => {
    void ipc.bots.weixinQrStop(sessionId).catch(() => undefined)
  }, [])

  const reset = useCallback(() => {
    if (sessionIdRef.current) stopSession(sessionIdRef.current)
    sessionIdRef.current = null
    applySession(null)
  }, [stopSession, applySession])

  // 换 bot 时丢弃上一个扫码会话：两个 bot 的会话 id 不同，串了会把 A 的登录态画到 B 上
  useEffect(() => {
    reset()
    setStartError(null)
  }, [bot.id, reset])

  const begin = useCallback(async () => {
    if (starting) return
    setStarting(true)
    setStartError(null)
    reset()
    try {
      const result = await ipc.bots.weixinQrStart(bot.id)
      if (result.ok) {
        sessionIdRef.current = result.session.id
        applySession(result.session)
      } else {
        setStartError(result.error)
      }
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(false)
    }
  }, [applySession, bot.id, reset, starting])

  // 事件 + 轮询双轨：事件是主路径，轮询保证窗口失焦 / 事件漏发时状态仍能推进
  useEffect(() => {
    const sessionId = sessionIdRef.current
    if (!sessionId || session?.finished) return

    // 出结果就收场：confirmed 要重拉列表拿 hasCredential，任何终态都得停掉主进程的长轮询
    const settle = (next: WeixinQrSession) => {
      applySession(next)
      void ipc.bots.weixinQrStop(sessionId).catch(() => undefined)
      sessionIdRef.current = null
      if (next.state === 'confirmed') onChanged()
    }

    const offEvent = ipc.bots.onWeixinQr((event) => {
      if (event.session !== sessionId) return
      const finished: WeixinQrState[] = ['confirmed', 'expired', 'error']
      const next: WeixinQrSession = {
        ...(sessionRef.current ?? {
          id: sessionId,
          botId: bot.id,
          state: event.state,
          finished: false,
          createdAt: Date.now(),
        }),
        state: event.state,
        finished: finished.includes(event.state),
        ...(event.qrUrl ? { qrUrl: event.qrUrl } : {}),
        ...(event.message ? { message: event.message } : {}),
      }
      if (next.finished) settle(next)
      else applySession(next)
    })

    const timer = window.setInterval(() => {
      void ipc.bots
        .weixinQrPoll(sessionId)
        .then((peeked) => {
          if (!peeked) return
          if (peeked.finished) settle(peeked)
          else applySession(peeked)
        })
        .catch(() => undefined)
    }, PEEK_INTERVAL_MS)

    return () => {
      offEvent()
      window.clearInterval(timer)
    }
  }, [applySession, bot.id, onChanged, session?.finished, session?.id])

  // 卸载时回收挂起的长轮询（主进程 dispose 兜底，但关窗就该立刻停）
  useEffect(
    () => () => {
      if (sessionIdRef.current) void ipc.bots.weixinQrStop(sessionIdRef.current).catch(() => undefined)
    },
    []
  )

  const stateText = (state: WeixinQrState): string => {
    switch (state) {
      case 'waiting':
        return t('bots.weixin.state.waiting')
      case 'scanned':
        return t('bots.weixin.state.scanned')
      case 'confirmed':
        return t('bots.weixin.state.confirmed')
      case 'expired':
        return t('bots.weixin.state.expired')
      default:
        return t('bots.weixin.state.error')
    }
  }

  // 已关联：不再展示二维码，只给激活指引与「换个微信号」入口
  if (bot.hasCredential && !session) {
    return (
      <div className="p-3 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 size={15} className="text-md-success flex-shrink-0" />
          <span className="text-ui-sm font-medium text-dark-onSurface">{t('bots.weixin.linked')}</span>
        </div>
        <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-3">
          {t('bots.weixin.activationHint')}
        </p>
        <button
          type="button"
          onClick={begin}
          disabled={starting}
          className="md-focus inline-flex items-center gap-1.5 px-3 py-2 rounded-md3-sm text-ui-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors disabled:opacity-50"
        >
          <RefreshCw size={13} />
          <span>{t('bots.weixin.rescan')}</span>
        </button>
      </div>
    )
  }

  return (
    <div className="p-3 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
      <div className="flex items-center gap-2 mb-1">
        <ScanLine size={15} className="text-md-primary flex-shrink-0" />
        <span className="text-ui-sm font-medium text-dark-onSurface">{t('bots.weixin.title')}</span>
      </div>
      <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-3">{t('bots.weixin.desc')}</p>

      {!session && (
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={begin}
            disabled={starting}
            className="md-focus w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md3-sm text-ui-sm font-medium bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors disabled:opacity-50"
          >
            {starting ? <Loader2 size={14} className="animate-spin" /> : <ScanLine size={14} />}
            <span>{starting ? t('bots.weixin.starting') : t('bots.weixin.start')}</span>
          </button>
          {startError && (
            <p role="alert" className="w-full text-ui-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2">
              {t('bots.weixin.failed', { error: startError })}
            </p>
          )}
        </div>
      )}

      {session && (
        <div className="flex flex-col items-center gap-2">
          {session.state !== 'confirmed' && session.qrUrl && (
            <QrCode text={session.qrUrl} size={168} />
          )}
          <p
            role="status"
            className={`text-ui-xs flex items-center gap-1.5 ${
              session.state === 'error' || session.state === 'expired'
                ? 'text-md-error'
                : session.state === 'confirmed'
                  ? 'text-md-success'
                  : 'text-dark-onSurfaceVariant'
            }`}
          >
            {(session.state === 'waiting' || session.state === 'scanned') && (
              <Loader2 size={12} className="animate-spin" />
            )}
            {session.state === 'confirmed' && <CheckCircle2 size={12} />}
            <span>{stateText(session.state)}</span>
          </p>
          {/* 主进程给的排错线索：这是用户唯一的上下文，原样显示，不改写 */}
          {session.message && (session.state === 'error' || session.state === 'expired') && (
            <p role="alert" className="text-ui-xs text-md-error text-center leading-relaxed max-w-[280px]">
              {session.message}
            </p>
          )}
          {session.state === 'waiting' && (
            <p className="text-ui-xs text-dark-onSurfaceVariant/60 text-center">{t('bots.weixin.scanHint')}</p>
          )}
          {session.state === 'confirmed' ? (
            <p className="text-ui-xs text-md-success text-center leading-relaxed py-1">
              {t('bots.weixin.confirmedNote')}
            </p>
          ) : (
            (session.state === 'expired' || session.state === 'error') && (
              <button
                type="button"
                onClick={begin}
                disabled={starting}
                className="md-focus inline-flex items-center gap-1.5 px-3 py-2 rounded-md3-sm text-ui-xs bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors disabled:opacity-50"
              >
                <RefreshCw size={13} />
                <span>{t('bots.weixin.rescan')}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
