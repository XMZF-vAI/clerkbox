import { useEffect, useId, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { LogOut, Settings2, Maximize, Minimize, PanelRight, PanelLeft, Plus, Search, Music2, MoreHorizontal, Settings, Minus, Square, Copy, X, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore } from '../../stores/vibe-store'
import { useWorkbench } from '../../stores/workbench-store'
import { useChatStore } from '../../stores/chat-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useUIStore } from '../../stores/ui-store'
import { useModalAccessibility } from '../../hooks/use-modal-accessibility'
import { isWebUIMode } from '../../lib/ipc-client'
import { COMMANDS } from '../../lib/commands'
import VibeMusicPlayer from './VibeMusicPlayer'
import VibeCustomizeMenu from './VibeCustomizeMenu'
import { VibeResourceBoundary } from './VibeErrorBoundary'

const noDrag = { WebkitAppRegion: 'no-drag' } as CSSProperties

/** An in-flow toolbar leaves the reading area and composer unobstructed. */
export default function VibeControls() {
  const { t } = useTranslation()
  const { visible, toggleVisible } = useWorkbench()
  const sessionTitle = useChatStore((s) => s.sessions.find((session) => session.id === s.activeSessionId)?.title)
  const showSkillStore = useUIStore((s) => s.showSkillStore)
  const showScheduledTasks = useUIStore((s) => s.showScheduledTasks)
  const drawerOpen = useUIStore((s) => s.vibeSidebarOpen)
  const showSettings = useSettingsStore((s) => s.showSettings)
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen)
  const title = showScheduledTasks ? t('scheduledTasks.title') : showSkillStore ? t('sidebar.skills') : sessionTitle || t('sidebar.newChat')
  const [showCustomize, setShowCustomize] = useState(false)
  const [customizeTab, setCustomizeTab] = useState<'background' | 'audio'>('background')
  const [showMusic, setShowMusic] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(() => !!document.fullscreenElement)
  const [isMaximized, setIsMaximized] = useState(() => window.clerkbox?.isWindowMaximized ?? false)
  const isMac = window.clerkbox?.platform === 'darwin'
  const musicId = useId()
  const moreId = useId()
  const musicRef = useModalAccessibility(() => setShowMusic(false), undefined, { active: showMusic })
  const moreRef = useModalAccessibility(() => setShowMore(false), undefined, { active: showMore })

  useEffect(() => {
    if (showSettings || commandPaletteOpen || drawerOpen) {
      setShowMusic(false)
      setShowMore(false)
      setShowCustomize(false)
    }
  }, [showSettings, commandPaletteOpen, drawerOpen])

  useEffect(() => {
    const sync = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    const off = window.clerkbox?.onWindowStateChange(setIsMaximized)
    return () => { document.removeEventListener('fullscreenchange', sync); off?.() }
  }, [])

  const exit = async () => {
    if (document.fullscreenElement) {
      try { await document.exitFullscreen() } catch { /* Mode exit remains available. */ }
    }
    useUIStore.getState().setVibeSidebarOpen(false)
    useVibeStore.getState().toggleVibeMode(false)
  }
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch { /* Browsers can deny fullscreen; keep the current mode usable. */ }
  }
  const openSettings = () => {
    setShowMore(false)
    useSettingsStore.getState().updateSettings({ showSettings: true })
  }
  const newChat = () => COMMANDS.find((command) => command.id === 'session.new')?.run()

  return (
    <>
      <header className={`vibe-toolbar liquid-glass-strong ${isMac && !isWebUIMode && !isFullscreen ? 'vibe-toolbar-mac' : ''}`} style={{ WebkitAppRegion: 'drag' } as CSSProperties}>
        <div className="vibe-toolbar-main">
          <button type="button" onClick={() => useUIStore.getState().toggleVibeSidebar()} className="vibe-icon-button" aria-label={t('vibe.sessions')} title={t('vibe.sessions')} aria-pressed={drawerOpen}><PanelLeft size={17} /></button>
          <button type="button" onClick={newChat} className="vibe-icon-button" aria-label={t('sidebar.newChatAria')} title={t('sidebar.newChatAria')}><Plus size={18} /></button>
          <button type="button" onClick={() => useUIStore.getState().setCommandPaletteOpen(true)} className="vibe-icon-button" aria-label={t('shell.search')} title={t('shell.search')}><Search size={16} /></button>
          <span className="mx-1 h-5 border-l border-white/15" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-ui-xs font-medium tracking-widest text-white/50"><Sparkles size={11} aria-hidden />VIBE</div>
            <h1 className="truncate text-ui-sm font-medium text-white/90" title={title}>{title}</h1>
          </div>
        </div>
        <div className="vibe-toolbar-actions" style={noDrag}>
          <button type="button" onClick={() => { setShowMusic((value) => !value); setShowMore(false) }} className="vibe-icon-button" aria-label={t('vibe.music')} title={t('vibe.music')} aria-expanded={showMusic} aria-controls={musicId}><Music2 size={17} /></button>
          <button type="button" onClick={toggleVisible} className="vibe-icon-button" aria-label={t('titlebar.toggleWorkbench')} title={t('titlebar.toggleWorkbench')} aria-pressed={visible}><PanelRight size={17} /></button>
          <button type="button" onClick={() => { setCustomizeTab('background'); setShowCustomize(true) }} className="vibe-icon-button" aria-label={t('vibe.customize')} title={t('vibe.customize')}><Settings2 size={17} /></button>
          <button type="button" onClick={() => { setShowMore((value) => !value); setShowMusic(false) }} className="vibe-icon-button" aria-label={t('vibe.moreActions')} title={t('vibe.moreActions')} aria-expanded={showMore} aria-controls={moreId}><MoreHorizontal size={18} /></button>
          {!isWebUIMode && !isMac && (
            <div className="ml-1 flex items-center border-l border-white/15 pl-1">
              <button type="button" onClick={() => window.clerkbox?.windowAction('minimize')} className="vibe-icon-button" aria-label={t('titlebar.windowMinimize')} title={t('titlebar.windowMinimize')}><Minus size={16} /></button>
              <button type="button" onClick={() => window.clerkbox?.windowAction('maximize')} className="vibe-icon-button" aria-label={t(isMaximized ? 'titlebar.windowRestore' : 'titlebar.windowMaximize')} title={t(isMaximized ? 'titlebar.windowRestore' : 'titlebar.windowMaximize')}>{isMaximized ? <Copy size={14} /> : <Square size={14} />}</button>
              <button type="button" onClick={() => window.clerkbox?.windowAction('close')} className="vibe-icon-button hover:!bg-md-error/20 hover:!text-md-error" aria-label={t('titlebar.windowClose')} title={t('titlebar.windowClose')}><X size={17} /></button>
            </div>
          )}
        </div>
      </header>
      {/* Keep audio mounted when the panel closes; closing a panel is not stopping playback. */}
      {createPortal(
        <div hidden={!showMusic} inert={!showMusic} className="vibe-popover-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowMusic(false) }}>
          <div id={musicId} ref={musicRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('vibe.music')} className="vibe-popover liquid-glass-strong">
            <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-ui-sm font-medium">{t('vibe.music')}</h2><button type="button" className="vibe-icon-button" onClick={() => setShowMusic(false)} aria-label={t('common.close')}><X size={16} /></button></div>
            <VibeResourceBoundary fallback="music"><VibeMusicPlayer /></VibeResourceBoundary>
            <button type="button" className="mt-3 min-h-10 w-full rounded-md3-sm border border-white/15 px-3 text-ui-xs text-white/70 hover:bg-white/10" onClick={() => { setShowMusic(false); setCustomizeTab('audio'); setShowCustomize(true) }}>{t('vibe.chooseAudioSource')}</button>
          </div>
        </div>, document.body,
      )}
      {showMore && createPortal(
        <div className="vibe-popover-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowMore(false) }}>
          <div id={moreId} ref={moreRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('vibe.moreActions')} className="vibe-popover vibe-more liquid-glass-strong">
            <button type="button" onClick={openSettings}><Settings size={16} />{t('commands.openSettings')}</button>
            <button type="button" onClick={() => { void toggleFullscreen(); setShowMore(false) }}>{isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}{t(isFullscreen ? 'vibe.exitFullscreen' : 'vibe.fullscreen')}</button>
            <button type="button" onClick={() => { void exit() }}><LogOut size={16} />{t('vibe.exit')}</button>
          </div>
        </div>, document.body,
      )}
      {showCustomize && <VibeCustomizeMenu initialTab={customizeTab} onClose={() => setShowCustomize(false)} />}
    </>
  )
}
