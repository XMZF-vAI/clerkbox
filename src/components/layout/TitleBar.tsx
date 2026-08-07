import { Menu, Minus, Square, X, Sparkles } from 'lucide-react'
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

  return (
    <div
      className="h-11 flex items-center justify-between px-4 bg-dark-surface/80 backdrop-blur-md border-b border-dark-onSurfaceVariant/10 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={onToggleSidebar}
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
          onClick={() => window.clerkbox?.windowAction('minimize')}
          className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
        >
          <Minus size={16} />
        </button>
        <button
          onClick={() => window.clerkbox?.windowAction('maximize')}
          className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
        >
          <Square size={14} />
        </button>
        <button
          onClick={() => window.clerkbox?.windowAction('close')}
          className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-md-error/20 hover:text-md-error transition-colors"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
