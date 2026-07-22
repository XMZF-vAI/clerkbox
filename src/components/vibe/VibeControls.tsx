import { useState, useEffect } from 'react'
import { LogOut, Settings2, Maximize, Minimize } from 'lucide-react'
import { useVibeStore } from '../../stores/vibe-store'
import VibeCustomizeMenu from './VibeCustomizeMenu'

export default function VibeControls() {
  const toggleVibeMode = useVibeStore((s) => s.toggleVibeMode)
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
      } catch {}
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
        onClick={handleToggleFullscreen}
        className="fixed top-4 left-4 z-50 flex items-center gap-2 px-3 py-2 liquid-glass-btn rounded-full text-white/90"
      >
        {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        <span className="text-xs font-medium">{isFullscreen ? '退出全屏' : '全屏'}</span>
      </button>

      {/* Customize button - bottom left */}
      <button
        onClick={() => setShowMenu(true)}
        className="fixed bottom-4 left-4 z-50 flex items-center gap-2 px-4 py-2 liquid-glass-btn rounded-full text-white/90"
      >
        <Settings2 size={16} />
        <span className="text-xs font-medium">定制</span>
      </button>

      {/* Exit button - bottom right */}
      <button
        onClick={handleExitVibe}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2 liquid-glass-btn rounded-full text-white/90"
      >
        <LogOut size={16} />
        <span className="text-xs font-medium">退出</span>
      </button>

      {showMenu && <VibeCustomizeMenu onClose={() => setShowMenu(false)} />}
    </>
  )
}
