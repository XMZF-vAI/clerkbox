import { useEffect, useState } from 'react'
import { AlertCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Persist failures must be visible; an optimistic switch is not proof it reached the host. */
export default function SharedStateNotice() {
  const { t, i18n } = useTranslation()
  const [notice, setNotice] = useState<{ conflict: boolean } | null>(null)
  useEffect(() => {
    const listener = (event: Event) => setNotice({ conflict: (event as CustomEvent<{ conflict: boolean }>).detail?.conflict === true })
    window.addEventListener('clerkbox-shared-state-error', listener)
    return () => window.removeEventListener('clerkbox-shared-state-error', listener)
  }, [])
  if (!notice) return null
  const chinese = i18n.language.startsWith('zh')
  return <div role="alert" className="fixed bottom-16 left-1/2 z-[120] flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 items-start gap-3 rounded-md3-md border border-md-error/35 bg-dark-surfaceContainerHigh px-4 py-3 text-ui-sm text-dark-onSurface shadow-elevation-3">
    <AlertCircle size={18} className="mt-0.5 shrink-0 text-md-error" aria-hidden />
    <p className="flex-1 leading-relaxed">{t(notice.conflict ? 'remoteAccess.cloudStateConflict' : 'remoteAccess.cloudStateSaveError', { defaultValue: notice.conflict ? (chinese ? '另一台设备刚刚修改了同一项设置，本次修改未保存。已重新同步，请确认最新内容后再修改。' : 'Another device changed the same setting. Your edit was not saved. Review the latest value and try again.') : (chinese ? '修改尚未保存到主机。请检查连接，恢复后确认最新内容并重试。' : 'Your change was not saved to the host. Check the connection and retry after reviewing the latest value.') })}</p>
    <button type="button" onClick={() => setNotice(null)} className="flex min-h-9 min-w-9 items-center justify-center rounded-md3-sm hover:bg-dark-onSurface/10" aria-label={t('common.close')}><X size={16} /></button>
  </div>
}
