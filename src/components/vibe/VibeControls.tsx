import { useState, useEffect } from 'react'
import { LogOut, Settings2, Maximize, Minimize, PanelRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore } from '../../stores/vibe-store'
import { useWorkbenchStore } from '../../stores/workbench-store'
import VibeCustomizeMenu from './VibeCustomizeMenu'

export default function VibeControls() {
  const { t } = useTranslation()
  const toggleVibeMode = useVibeStore((s) => s.toggleVibeMode)
  // VIBE 模式无标题栏：工作台面板隐藏时提供浮动唤出入口
  const workbenchVisible = useWorkbenchStore((s) => s.visible)
  const toggleWorkbench = useWorkbenchStore((s) => s.toggleVisible)
  const [showMenu, setShowMenu] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const handleToggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
        setIsFullscreen(true)
      } else {
        await document.exitFullscreen()
        setIsFullscreen(false)
      }
    } catch {
      // Ignore fullscreen errors
    }
  }

  const handleExitVibe = async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen()
      } catch { /* Leaving VIBE mode should continue even when fullscreen exit is denied. */ }
      setIsFullscreen(false)
    }
    toggleVibeMode(false)
  }

  // Keep state in sync when ESC is pressed
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  return (
    <>
      {/* Fullscreen toggle - top left */}
      <button
        type="button"
        onClick={handleToggleFullscreen}
        className="fixed top-4 left-4 z-50 flex items-center gap-2 px-3 py-2 liquid-glass-btn rounded-full text-white/90"
      >
        {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        <span className="text-xs font-medium">{isFullscreen ? t('vibe.exitFullscreen') : t('vibe.fullscreen')}</span>
      </button>

      {/* Customize button - bottom left */}
      <button
        type="button"
        onClick={() => setShowMenu(true)}
        className="fixed bottom-4 left-4 z-50 flex items-center gap-2 px-4 py-2 liquid-glass-btn rounded-full text-white/90"
      >
        <Settings2 size={16} />
        <span className="text-xs font-medium">{t('vibe.customize')}</span>
      </button>

      {/* Exit button - bottom right */}
      <button
        type="button"
        onClick={handleExitVibe}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2 liquid-glass-btn rounded-full text-white/90"
      >
        <LogOut size={16} />
        <span className="text-xs font-medium">{t('vibe.exit')}</span>
      </button>

      {/* Workbench launcher - top right（面板已开时由其自带收起按钮负责） */}
      {!workbenchVisible && (
        <button
          type="button"
          onClick={toggleWorkbench}
          className="fixed top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 liquid-glass-btn rounded-full text-white/90"
          aria-label={t('titlebar.toggleWorkbench')}
          title={t('titlebar.toggleWorkbench')}
        >
          <PanelRight size={14} />
          <span className="text-xs font-medium">{t('workbench.launcher')}</span>
        </button>
      )}

      {showMenu && <VibeCustomizeMenu onClose={() => setShowMenu(false)} />}
    </>
  )
}
