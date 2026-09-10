import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, RotateCw, ExternalLink } from 'lucide-react'
import { useUpdaterStore } from '../../stores/updater-store'
import { ipc } from '../../lib/ipc-client'
import pkg from '../../../package.json'

/**
 * 标题栏版本号标签：自动更新的唯一 UI 入口。
 *
 * - idle：静态版本号，点击手动检查更新，悬浮显示当前版本/检查时间
 * - downloading：主题色呼吸光晕 + 标签文本变为下载进度 + 底部细进度条
 * - ready：光晕 + 新版本号 + 重启图标，点击重启安装（agent 忙碌时先弹中断确认）；
 *   macOS 无签名不能自动安装，点击跳转 Release 页
 * - 悬浮卡片任何时候可见更新内容（GitHub Release 正文，主进程已剥离 Markdown）
 * - WebUI 模式 / dev 模式：supported=false，纯静态标签
 */
export default function UpdateBadge() {
  const { t } = useTranslation()
  const state = useUpdaterStore((s) => s.state)
  const checking = useUpdaterStore((s) => s.checking)
  const checkNow = useUpdaterStore((s) => s.checkNow)
  const [showTip, setShowTip] = useState(false)
  const tipTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current)
  }, [])

  const supported = state?.supported ?? false
  const phase = supported ? (state?.phase ?? 'idle') : 'idle'
  const newVersion = state?.newVersion ?? null
  const progress = state?.progress ?? null
  const ready = phase === 'ready'
  const canAutoInstall = state?.canAutoInstall ?? false
  const isBusyChecking = checking || phase === 'checking'
  const glow = phase === 'downloading' || ready

  const handleMouseEnter = () => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current)
    tipTimer.current = window.setTimeout(() => setShowTip(true), 350)
  }
  const handleMouseLeave = () => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current)
    setShowTip(false)
  }

  const handleClick = async () => {
    if (!supported) return
    if (ready) {
      if (!canAutoInstall) {
        // macOS：跳转 Release 页手动下载
        if (state?.releaseUrl) void ipc.openExternal(state.releaseUrl)
        return
      }
      // agent 忙碌时二次确认（用户主诉：agent 执行时不更）
      if (state?.agentBusy) {
        const ok = await ipc.confirmDialog(t('titlebar.updateConfirmTitle'), t('titlebar.updateConfirmMessage'))
        if (!ok) return
      }
      await ipc.updateInstall()
      return
    }
    if (phase === 'idle') void checkNow()
  }

  // 标签文本：ready 显示新版本号；下载中显示进度；其余显示当前版本
  const label = ready && newVersion
    ? `v${newVersion}`
    : phase === 'downloading' && progress != null
      ? `${Math.round(progress)}%`
      : `v${pkg.version}`

  const statusLine = isBusyChecking
    ? t('titlebar.updateChecking')
    : phase === 'downloading'
      ? t('titlebar.updateDownloadProgress', { version: newVersion ?? '', percent: Math.round(progress ?? 0) })
      : ready
        ? (canAutoInstall ? t('titlebar.updateReady', { version: newVersion ?? '' }) : t('titlebar.updateReadyMac', { version: newVersion ?? '' }))
        : t('titlebar.updateCheckNow')

  const lastCheckedText = state?.lastCheckedAt
    ? t('titlebar.updateLastChecked', { time: new Date(state.lastCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : t('titlebar.updateNeverChecked')

  return (
    <div className="relative max-md:hidden" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <button
        type="button"
        onClick={handleClick}
        disabled={!supported}
        aria-label={statusLine}
        className={`relative flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md3-xs transition-colors ${
          glow
            ? 'bg-md-primary/15 text-md-primary hover:bg-md-primary/25 update-glow'
            : supported
              ? 'bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHighest'
              : 'bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant cursor-default'
        }`}
      >
        {isBusyChecking && <RefreshCw size={10} className="animate-spin shrink-0" />}
        <span className="tabular-nums">{label}</span>
        {ready && canAutoInstall && <RotateCw size={11} className="shrink-0" />}
        {ready && !canAutoInstall && <ExternalLink size={10} className="shrink-0" />}
        {/* 下载进度条：贴标签底边的细线 */}
        {phase === 'downloading' && progress != null && (
          <span className="absolute bottom-0 left-1 right-1 h-[2px] rounded-full bg-md-primary/25 overflow-hidden">
            <span
              className="block h-full bg-md-primary rounded-full transition-[width] duration-300 ease-out"
              style={{ width: `${Math.max(2, Math.round(progress))}%` }}
            />
          </span>
        )}
      </button>

      {/* 悬浮卡片：当前版本 + 检查时间；有新版本时附 Release 正文 */}
      {showTip && (
        <div className="absolute top-full left-0 mt-2 z-50 w-72 rounded-md3-sm bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/15 shadow-xl p-3 select-none">
          <div className="text-xs font-medium text-dark-onSurface">
            {t('titlebar.updateCurrentVersion', { version: pkg.version })}
          </div>
          <div className="text-[11px] text-dark-onSurfaceVariant/70 mt-0.5">{lastCheckedText}</div>
          {newVersion && (
            <>
              <div className="border-t border-dark-onSurfaceVariant/15 my-2" />
              <div className="text-xs font-medium text-md-primary">{statusLine}</div>
              {state?.releaseNotes && (
                <>
                  <div className="text-[11px] font-medium text-dark-onSurfaceVariant mt-2 mb-1">
                    {t('titlebar.updateNotesTitle', { version: newVersion })}
                  </div>
                  <div className="text-[11px] text-dark-onSurfaceVariant leading-relaxed whitespace-pre-wrap max-h-44 overflow-y-auto">
                    {state.releaseNotes}
                  </div>
                </>
              )}
            </>
          )}
          {!newVersion && !isBusyChecking && (
            <div className="text-[11px] text-dark-onSurfaceVariant/70 mt-1.5">{t('titlebar.updateCheckNow')}</div>
          )}
        </div>
      )}
    </div>
  )
}
