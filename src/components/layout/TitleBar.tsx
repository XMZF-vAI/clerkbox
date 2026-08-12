import { Menu, Minus, Square, X, Sparkles, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chat-store'
import { useVibeStore } from '../../stores/vibe-store'
import pkg from '../../../package.json'

interface TitleBarProps {
  onToggleSidebar: () => void
}

export default function TitleBar({ onToggleSidebar }: TitleBarProps) {
  const { t } = useTranslation()
  // 多会话并发：TitleBar 只关心"是否有任意会话在 streaming"，不关心具体几个
  const hasStreaming = useChatStore((s) => s.streamingSessionIds.size > 0)
  const vibeMode = useVibeStore((s) => s.isVibeMode)
  const toggleVibeMode = useVibeStore((s) => s.toggleVibeMode)

  // 监听窗口最大化状态，根据状态切换中间按钮的图标和 hover 提示
  const [isMaximized, setIsMaximized] = useState(false)
  useEffect(() => {
    // 初始值（preload 未主动推送，靠 onWindowStateChange 第一次触达前避免图标错位）
    const off = window.clerkbox?.onWindowStateChange((max) => setIsMaximized(max))
    return () => { off?.() }
  }, [])

  return (
    <div
      className="h-11 flex items-center justify-between px-4 bg-dark-surface/80 backdrop-blur-md border-b border-dark-onSurfaceVariant/10 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('titlebar.toggleSidebar')}
          title={t('titlebar.toggleSidebar')}
          className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
        >
          <Menu size={18} />
        </button>
        <span className="text-xs px-1.5 py-0.5 rounded-md3-xs bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant">
          v{pkg.version}
        </span>
      </div>

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* VIBE mode toggle */}
        <button
          type="button"
          onClick={() => toggleVibeMode()}
          className="h-7 flex items-center gap-1 px-2 mr-2 rounded-md3-sm bg-md-tertiary/15 text-md-tertiary hover:bg-md-tertiary/25 transition-colors"
          title={t('titlebar.vibeEnter')}
          aria-label={t('titlebar.vibeToggleAria')}
          aria-pressed={vibeMode}
        >
          <Sparkles size={14} />
          <span className="text-xs font-medium">VIBE</span>
        </button>

        {/* Status indicator */}
        <div className={`flex items-center gap-2 mr-2 px-2 py-1 rounded-md3-sm ${
          hasStreaming ? 'bg-md-info/10' : 'bg-dark-surfaceContainerHigh'
        }`}>
          <div className={`w-2 h-2 rounded-full ${
            hasStreaming ? 'bg-md-info animate-pulse-soft' : 'bg-md-success'
          }`} />
          <span className="text-xs text-dark-onSurfaceVariant">
            {hasStreaming ? t('titlebar.statusExecuting') : t('titlebar.statusReady')}
          </span>
        </div>

        {/* Window controls */}
        <button
          type="button"
          onClick={() => window.clerkbox?.windowAction('minimize')}
          aria-label={t('titlebar.windowMinimize')}
          title={t('titlebar.windowMinimize')}
          className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
        >
          <Minus size={16} />
        </button>
        <button
          type="button"
          onClick={() => window.clerkbox?.windowAction('maximize')}
          title={isMaximized ? t('titlebar.windowRestore') : t('titlebar.windowMaximize')}
          aria-label={isMaximized ? t('titlebar.windowRestore') : t('titlebar.windowMaximize')}
          className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
        >
          {isMaximized ? <Copy size={14} /> : <Square size={14} />}
        </button>
        <button
          type="button"
          onClick={() => window.clerkbox?.windowAction('close')}
          aria-label={t('titlebar.windowClose')}
          title={t('titlebar.windowClose')}
          className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-md-error/20 hover:text-md-error transition-colors"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
