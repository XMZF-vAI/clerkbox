import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useModalAccessibility } from '../../hooks/use-modal-accessibility'
import { useUIStore } from '../../stores/ui-store'
import Sidebar from '../layout/Sidebar'

export default function VibeSessionDrawer() {
  const { t } = useTranslation()
  const close = () => useUIStore.getState().setVibeSidebarOpen(false)
  const panelRef = useModalAccessibility(close)
  return createPortal(
    <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm animate-fade-in" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('vibe.sessions')} className="vibe-session-drawer absolute inset-y-0 left-0 w-[85vw] max-w-xs outline-none shadow-elevation-3 animate-slide-in-left">
        <Sidebar collapsed={false} onToggle={close} onNavigate={close} />
      </div>
    </div>, document.body,
  )
}
