import { Minus, Square, X, Sparkles, Copy, PanelLeft, PanelRight, FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVibeStore } from '../../stores/vibe-store'
import { useWorkbench } from '../../stores/workbench-store'
import ContextUsageIndicator from '../chat/ContextUsageIndicator'
import JouleQuotaButton from '../joule/JouleQuotaButton'
import UpdateBadge from './UpdateBadge'
import { isWebUIMode } from '../../lib/ipc-client'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'
import { isCloudRemoteMode } from '../../remote/browser'

interface TitleBarProps {
  onToggleSidebar: () => void
  sidebarVisible: boolean
}

export default function TitleBar({ onToggleSidebar, sidebarVisible }: TitleBarProps) {
  const { t } = useTranslation()
  const cloudRemote = isCloudRemoteMode()
  const vibeMode = useVibeStore((s) => s.isVibeMode)
  const toggleVibeMode = useVibeStore((s) => s.toggleVibeMode)
  const sessionTitle = useChatStore((s) => s.sessions.find((session) => session.id === s.activeSessionId)?.title)
  const workingDir = useChatStore((s) => {
    const session = s.sessions.find((item) => item.id === s.activeSessionId)
    return session?.workingDir
  })
  const showSkillStore = useUIStore((s) => s.showSkillStore)
  const showScheduledTasks = useUIStore((s) => s.showScheduledTasks)
  const pageTitle = showScheduledTasks ? t('scheduledTasks.title') : showSkillStore ? t('sidebar.skills') : sessionTitle || t('sidebar.newChat')
  const workingDirLabel = workingDir?.split(/[\\/]/).filter(Boolean).pop() || workingDir
  // 工作台面板显隐：激活态高亮按钮
  const { visible: workbenchVisible, toggleVisible: toggleWorkbench } = useWorkbench()
  // mac：窗口控制走系统红绿灯（左上角），自绘三键隐藏，左侧为红绿灯留位
  const isMac = window.clerkbox?.platform === 'darwin'

  // 监听窗口最大化状态，根据状态切换中间按钮的图标和 hover 提示
  const [isMaximized, setIsMaximized] = useState(false)
  useEffect(() => {
    // 初始值（preload 未主动推送，靠 onWindowStateChange 第一次触达前避免图标错位）
    const off = window.clerkbox?.onWindowStateChange((max) => setIsMaximized(max))
    return () => { off?.() }
  }, [])

  return (
    <div
      className="relative z-30 h-11 shrink-0 max-md:h-14 flex items-center justify-between gap-3 px-3 max-md:gap-1 max-md:px-2 bg-dark-surface/90 border-b border-dark-onSurfaceVariant/10 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className={`flex min-w-0 flex-1 items-center gap-2 ${isMac ? 'ml-[84px]' : ''}`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('titlebar.toggleSidebar')}
          title={t('titlebar.toggleSidebar')}
          aria-pressed={sidebarVisible}
          className="md-focus w-8 h-8 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant transition-colors"
        >
          <PanelLeft size={16} />
        </button>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="truncate text-ui-xs font-medium text-dark-onSurface" title={pageTitle}>{pageTitle}</span>
          {!showSkillStore && !showScheduledTasks && workingDir && (
            <span title={workingDir} className="hidden xl:flex min-w-0 max-w-52 items-center gap-1.5 border-l border-dark-onSurfaceVariant/15 pl-2.5 text-ui-xs text-dark-onSurfaceVariant/60">
              <FolderOpen size={13} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{workingDirLabel}</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 max-md:gap-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {!cloudRemote && <div className="mr-1 hidden md:block"><UpdateBadge /></div>}
        <button
          type="button"
          onClick={() => toggleVibeMode()}
          className="md-focus h-8 max-md:h-11 max-md:w-11 flex shrink-0 items-center justify-center gap-1.5 px-2 rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
          title={t('titlebar.vibeEnter')}
          aria-label={t('titlebar.vibeToggleAria')}
          aria-pressed={vibeMode}
        >
          <Sparkles size={15} className="shrink-0" />
          <span className="hidden lg:inline text-ui-xs font-medium whitespace-nowrap">
            {t('titlebar.vibeCompact')}
          </span>
        </button>

        {/* Context usage indicator：环形用量 + 统计面板（含手动压缩入口） */}
        <ContextUsageIndicator />

        {/* Joule 5 小时额度：长条用量 + 详情入口（未连接 Joule 时不渲染） */}
        <JouleQuotaButton />

        {/* 工作台面板开关（普通模式；VIBE 模式无标题栏，走 VibeControls 里的入口） */}
        <button
          type="button"
          onClick={toggleWorkbench}
          aria-label={t('titlebar.toggleWorkbench')}
          title={t('titlebar.toggleWorkbench')}
          aria-pressed={workbenchVisible}
          className={`md-focus w-8 h-8 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-md3-sm transition-colors ${
            workbenchVisible
              ? 'bg-md-primary/15 text-md-primary'
              : 'hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant'
          }`}
        >
          <PanelRight size={16} />
        </button>

        {/* Window controls：WebUI 模式下隐藏（浏览器无窗口控制）；mac 走系统红绿灯 */}
        {!isWebUIMode && !isMac && (
          <>
            <button
              type="button"
              onClick={() => window.clerkbox?.windowAction('minimize')}
              aria-label={t('titlebar.windowMinimize')}
              title={t('titlebar.windowMinimize')}
              className="md-focus w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
            >
              <Minus size={16} />
            </button>
            <button
              type="button"
              onClick={() => window.clerkbox?.windowAction('maximize')}
              title={isMaximized ? t('titlebar.windowRestore') : t('titlebar.windowMaximize')}
              aria-label={isMaximized ? t('titlebar.windowRestore') : t('titlebar.windowMaximize')}
              className="md-focus w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
            >
              {isMaximized ? <Copy size={14} /> : <Square size={14} />}
            </button>
            <button
              type="button"
              onClick={() => window.clerkbox?.windowAction('close')}
              aria-label={t('titlebar.windowClose')}
              title={t('titlebar.windowClose')}
              className="md-focus w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-md-error/20 hover:text-md-error transition-colors"
            >
              <X size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
