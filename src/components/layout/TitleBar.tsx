import { Minus, Square, X, Sparkles, Copy, PanelLeft, PanelRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVibeStore } from '../../stores/vibe-store'
import { useWorkbenchStore } from '../../stores/workbench-store'
import ContextUsageIndicator from '../chat/ContextUsageIndicator'
import { isWebUIMode } from '../../lib/ipc-client'
import pkg from '../../../package.json'

interface TitleBarProps {
  onToggleSidebar: () => void
  sidebarVisible: boolean
}

export default function TitleBar({ onToggleSidebar, sidebarVisible }: TitleBarProps) {
  const { t } = useTranslation()
  const vibeMode = useVibeStore((s) => s.isVibeMode)
  const toggleVibeMode = useVibeStore((s) => s.toggleVibeMode)
  // 工作台面板显隐：激活态高亮按钮
  const workbenchVisible = useWorkbenchStore((s) => s.visible)
  const toggleWorkbench = useWorkbenchStore((s) => s.toggleVisible)

  // 监听窗口最大化状态，根据状态切换中间按钮的图标和 hover 提示
  const [isMaximized, setIsMaximized] = useState(false)
  useEffect(() => {
    // 初始值（preload 未主动推送，靠 onWindowStateChange 第一次触达前避免图标错位）
    const off = window.clerkbox?.onWindowStateChange((max) => setIsMaximized(max))
    return () => { off?.() }
  }, [])

  return (
    <div
      className="relative z-30 h-11 max-md:h-14 flex items-center justify-between px-4 max-md:px-3 bg-dark-surface/80 backdrop-blur-md border-b border-dark-onSurfaceVariant/10 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('titlebar.toggleSidebar')}
          title={t('titlebar.toggleSidebar')}
          aria-pressed={sidebarVisible}
          className="w-8 h-8 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant transition-colors"
        >
          <PanelLeft size={16} />
        </button>
        <span className="text-xs px-1.5 py-0.5 rounded-md3-xs bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant max-md:hidden">
          v{pkg.version}
        </span>
      </div>

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* 氛围模式 toggle：默认紧凑「氛围」标签，悬停展开为完整入口文案 */}
        <button
          type="button"
          onClick={() => toggleVibeMode()}
          className="group h-7 max-md:h-10 max-md:px-3 flex items-center px-2 mr-2 rounded-md3-sm bg-md-tertiary/15 text-md-tertiary hover:bg-md-tertiary/25 transition-colors"
          title={t('titlebar.vibeEnter')}
          aria-label={t('titlebar.vibeToggleAria')}
          aria-pressed={vibeMode}
        >
          <Sparkles size={14} className="shrink-0 transition-transform duration-300 ease-out group-hover:rotate-12 group-hover:scale-110" />
          <span className="text-xs font-medium whitespace-nowrap overflow-hidden ml-1 max-w-10 opacity-100 group-hover:max-w-0 group-hover:opacity-0 group-hover:ml-0 transition-all duration-300 ease-out">
            {t('titlebar.vibeCompact')}
          </span>
          <span className="text-xs font-medium whitespace-nowrap overflow-hidden max-w-0 opacity-0 group-hover:max-w-32 group-hover:opacity-100 group-hover:ml-1 transition-all duration-300 ease-out">
            {t('titlebar.vibeEnter')}
          </span>
        </button>

        {/* Context usage indicator：环形用量 + 统计面板（含手动压缩入口） */}
        <ContextUsageIndicator />

        {/* 工作台面板开关（普通模式；VIBE 模式无标题栏，走 VibeControls 里的入口） */}
        <button
          type="button"
          onClick={toggleWorkbench}
          aria-label={t('titlebar.toggleWorkbench')}
          title={t('titlebar.toggleWorkbench')}
          aria-pressed={workbenchVisible}
          className={`w-8 h-8 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-md3-sm transition-colors ${
            workbenchVisible
              ? 'bg-md-primary/15 text-md-primary'
              : 'hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant'
          }`}
        >
          <PanelRight size={16} />
        </button>

        {/* Window controls：WebUI 模式下隐藏（浏览器无窗口控制） */}
        {!isWebUIMode && (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}
