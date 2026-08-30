import { useState, useEffect } from 'react'
import { LogOut, Settings2, Maximize, Minimize, PanelRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore } from '../../stores/vibe-store'
import { useWorkbenchStore } from '../../stores/workbench-store'
import { useIsMobile } from '../../hooks/use-mobile'
import VibeMusicPlayer from './VibeMusicPlayer'
import VibeCustomizeMenu from './VibeCustomizeMenu'

export default function VibeControls() {
  const { t } = useTranslation()
  const toggleVibeMode = useVibeStore((s) => s.toggleVibeMode)
  // VIBE 模式无标题栏：工作台面板隐藏时提供浮动唤出入口
  const workbenchVisible = useWorkbenchStore((s) => s.visible)
  const workbenchWidth = useWorkbenchStore((s) => s.width)
  const toggleWorkbench = useWorkbenchStore((s) => s.toggleVisible)
  const isMobile = useIsMobile()

  // 面板打开（桌面端）时，右上控制组与退出按钮整体移到面板左侧，避免压住面板
  const dodgeWorkbench = workbenchVisible && !isMobile
  const dodgeStyle = dodgeWorkbench ? { right: workbenchWidth + 16 } : { right: 16 }
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

      {/* Exit button - bottom right（面板打开时左移避让） */}
      <button
        type="button"
        onClick={handleExitVibe}
        style={dodgeStyle}
        className="fixed bottom-4 z-50 flex items-center gap-2 px-4 py-2 liquid-glass-btn rounded-full text-white/90"
      >
        <LogOut size={16} />
        <span className="text-xs font-medium">{t('vibe.exit')}</span>
      </button>

      {/* 顶部右侧统一槽位：唤出按钮与音乐播放器同排、互不叠压；面板打开时整组移到面板左侧，不遮面板标签栏。
          w-max 锁定收缩宽度，防止任何状态下被拉伸成通栏 */}
      <div className="fixed top-4 z-50 flex w-max max-w-[calc(100vw-2rem)] items-start gap-2" style={dodgeStyle}>
        {!workbenchVisible && (
          <button
            type="button"
            onClick={toggleWorkbench}
            className="flex shrink-0 items-center gap-2 px-3 py-2 liquid-glass-btn rounded-full text-white/90"
            aria-label={t('titlebar.toggleWorkbench')}
            title={t('titlebar.toggleWorkbench')}
          >
            <PanelRight size={14} />
            <span className="text-xs font-medium">{t('workbench.launcher')}</span>
          </button>
        )}
        <VibeMusicPlayer />
      </div>

      {showMenu && <VibeCustomizeMenu onClose={() => setShowMenu(false)} />}
    </>
  )
}
