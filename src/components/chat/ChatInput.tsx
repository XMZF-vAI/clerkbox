import { useState, useRef, KeyboardEvent, useEffect } from 'react'
import { Send, Brain, FolderOpen, ChevronDown, Hammer, Eye, Square, ClipboardList, Zap, Check, X, Store, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import { useSkillsStore } from '../../stores/skills-store'
import { useUIStore } from '../../stores/ui-store'
import { ipc } from '../../lib/ipc-client'

interface ChatInputProps {
  onSend: (content: string) => void
  onStop?: () => void
  isStreaming?: boolean
  variant?: 'default' | 'welcome'
  vibe?: boolean
}

export default function ChatInput({ onSend, onStop, isStreaming, variant = 'default', vibe = false }: ChatInputProps) {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [folderSelecting, setFolderSelecting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const settings = useSettingsStore()
  const { sessions, activeSessionId, updateSessionWorkingDir } = useChatStore()
  const currentSession = sessions.find((s) => s.id === activeSessionId)
  const effectiveWorkDir = currentSession?.workingDir || currentSession?.defaultWorkDir

  // Model dropdown state
  const [showModelMenu, setShowModelMenu] = useState(false)
  const modelMenuRef = useRef<HTMLDivElement>(null)

  // Mode dropdown state
  const [showModeMenu, setShowModeMenu] = useState(false)
  const modeMenuRef = useRef<HTMLDivElement>(null)

  // Skill dropdown state
  const [showSkillMenu, setShowSkillMenu] = useState(false)
  const skillMenuRef = useRef<HTMLDivElement>(null)
  const [showThinkingMenu, setShowThinkingMenu] = useState(false)
  const thinkingMenuRef = useRef<HTMLDivElement>(null)
  // 按字段订阅：skills 用于下拉菜单展示所有已安装技能，sessionSkillIds 用于判断激活态
  const skills = useSkillsStore((s) => s.skills)
  const sessionSkillIds = useSkillsStore((s) => s.sessionSkillIds)
  const toggleSessionSkill = useSkillsStore((s) => s.toggleSessionSkill)
  const { setShowSkillStore } = useUIStore()
  const activeSkills = skills.filter((s) => sessionSkillIds.includes(s.id))

  const handleSend = () => {
    const trimmed = content.trim()
    if (!trimmed || isStreaming) return
    if (trimmed.length > 50000) {
      alert(t('chat.messageTooLong'))
      return
    }
    onSend(trimmed)
    setContent('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    }
  }

  const handleSelectFolder = async () => {
    if (folderSelecting) return
    setFolderSelecting(true)
    try {
      const folder = await ipc.selectFolder()
      if (folder && activeSessionId) {
        updateSessionWorkingDir(activeSessionId, folder)
      }
    } finally {
      setFolderSelecting(false)
    }
  }

  const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
  const activeModel = activeProvider?.models.find((m) => m.id === settings.activeModelId)
  const thinkingSupported = activeModel?.supportsThinking ?? false
  const reasoningEfforts = activeModel?.reasoningEfforts ?? []
  const hasReasoningLevels = reasoningEfforts.length > 0
  const currentEffortIndex = Math.max(0, reasoningEfforts.indexOf((activeModel?.reasoningEffort || settings.reasoningEffort || reasoningEfforts[0]) as never))

  const toggleThinking = () => {
    if (!thinkingSupported) return
    settings.updateSettings({ enableThinking: !settings.enableThinking })
  }

  const setReasoningEffort = (index: number) => {
    if (!activeProvider || !activeModel) return
    const effort = reasoningEfforts[index]
    const models = activeProvider.models.map((m) => m.id === activeModel.id ? { ...m, reasoningEffort: effort } : m)
    settings.setProviderModels(activeProvider.id, models)
    settings.updateSettings({ reasoningEffort: effort, enableThinking: true })
  }

  const handleSelectModel = (providerId: string, modelId: string) => {
    settings.activateModel(providerId, modelId)
    setShowModelMenu(false)
  }

  const handleAddCustomModel = () => {
    setShowModelMenu(false)
    settings.updateSettings({ showSettings: true })
  }

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false)
      }
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setShowModeMenu(false)
      }
      if (skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) {
        setShowSkillMenu(false)
      }
      if (thinkingMenuRef.current && !thinkingMenuRef.current.contains(e.target as Node)) {
        setShowThinkingMenu(false)
      }
    }
    if (showModelMenu || showModeMenu || showSkillMenu || showThinkingMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModelMenu, showModeMenu, showSkillMenu, showThinkingMenu])

  const mode = settings.permissionMode
  const modeIcon = mode === 'craft' ? Hammer : mode === 'plan' ? ClipboardList : Eye
  const modeLabel = mode === 'craft' ? t('sidebar.mode.craftLabel') : mode === 'plan' ? t('sidebar.mode.planLabel') : t('sidebar.mode.askLabel')
  const ModeIcon = modeIcon

  // 当前模型显示名：优先取所属提供商里登记的 label，回落到 model id
  const currentModelLabel = (() => {
    const p = settings.providers.find((x) => x.id === settings.activeProviderId)
    const m = p?.models.find((x) => x.id === settings.activeModelId)
    return m?.label || m?.id || settings.model
  })()

  // 只显示有模型的提供商，避免下拉里出现空组
  const providersWithModels = settings.providers.filter((p) => p.models.length > 0)

  const isWelcome = variant === 'welcome'

  // Outer container: different styling for welcome vs default
  const outerClass = isWelcome
    ? 'px-4 py-2'
    : vibe
      ? 'px-4 py-3 bg-transparent'
      : 'px-4 py-3 bg-dark-surfaceDim border-t border-dark-onSurfaceVariant/10'

  // Input box: wider and more rounded
  const boxMaxWidth = isWelcome ? 'max-w-3xl' : 'max-w-5xl'

  // Box class: vibe uses liquid glass
  const boxClass = vibe
    ? `flex flex-col ${boxMaxWidth} mx-auto liquid-glass rounded-[28px] px-5 py-3.5 gap-2 focus-within:border-white/40 transition-colors`
    : `flex flex-col ${boxMaxWidth} mx-auto bg-dark-surfaceContainerHigh rounded-[28px] px-5 py-3.5 gap-2 border border-dark-onSurfaceVariant/8 focus-within:border-md-primary/30 transition-colors`

  return (
    <div className={outerClass}>
      {/* Working directory indicator - only in default mode */}
      {!isWelcome && effectiveWorkDir && (
        <div className={`flex items-center gap-1.5 mb-2 px-1 max-w-5xl mx-auto ${vibe ? 'text-white/50' : ''}`}>
          <FolderOpen size={12} className={vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/50'} />
          <span className={`text-[11px] truncate max-w-[400px] ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/50'}`}>
            {effectiveWorkDir}{currentSession?.workingDir ? '' : t('chat.defaultWorkDirSuffix')}
          </span>
        </div>
      )}

      <div className={boxClass}>
        {/* Active skills pills - shown when any skill is loaded */}
        {activeSkills.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {activeSkills.map((skill) => (
              <button
                key={skill.id}
                onClick={() => toggleSessionSkill(skill.id, effectiveWorkDir || undefined)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] transition-colors group ${
                  vibe
                    ? 'bg-white/15 text-white/90 hover:bg-white/25'
                    : 'bg-md-primary/15 text-md-primary hover:bg-md-primary/25'
                }`}
                title={t('chat.unloadSkillTitle', { name: skill.name })}
              >
                <span>{skill.icon}</span>
                <span>{skill.name}</span>
                <X size={10} className="opacity-0 group-hover:opacity-70 transition-opacity" />
              </button>
            ))}
          </div>
        )}

        {/* Textarea - top area */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          disabled={isStreaming}
          placeholder={vibe ? t('chat.placeholderVibe') : (effectiveWorkDir ? t('chat.placeholderWorkDir', { name: effectiveWorkDir.split(/[/\\]/).pop() }) : t('chat.placeholderDefault'))}
          rows={1}
          className={`w-full bg-transparent text-sm resize-none outline-none min-h-[20px] max-h-[200px] py-1 ${
            vibe
              ? 'text-white/90 placeholder-white/50'
              : 'text-dark-onSurface placeholder-dark-onSurfaceVariant/40'
          }`}
        />

        {/* Bottom button row - inside the box */}
        <div className="flex items-center gap-1 flex-wrap">
          {/* Working folder button */}
          <button
            onClick={handleSelectFolder}
            disabled={folderSelecting}
            className={`h-8 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors disabled:opacity-40 ${
              vibe
                ? 'hover:bg-white/15 text-white/70'
                : 'hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
            }`}
            title={t('chat.selectFolderTitle')}
            aria-label={t('chat.selectFolderAria')}
          >
            {folderSelecting ? <div className={`w-3.5 h-3.5 border-2 border-t-transparent rounded-full animate-spin ${vibe ? 'border-white/50' : 'border-dark-onSurfaceVariant/40'}`} /> : <FolderOpen size={16} />}
          </button>

          {/* Permission mode dropdown */}
          <div className="relative" ref={modeMenuRef}>
            <button
              onClick={() => setShowModeMenu(!showModeMenu)}
              className={`h-8 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors ${
                vibe
                  ? 'bg-white/10 text-white/80 hover:bg-white/15'
                  : mode === 'craft'
                    ? 'bg-md-warning/15 text-md-warning'
                    : mode === 'plan'
                      ? 'bg-md-info/15 text-md-info'
                      : 'bg-md-success/15 text-md-success'
              }`}
            >
              <ModeIcon size={14} />
              <span className="text-xs font-medium">{modeLabel}</span>
              <ChevronDown size={12} />
            </button>
            {showModeMenu && (
              <div className={`absolute bottom-full mb-1 left-0 w-48 rounded-md3-md overflow-hidden z-50 ${
                vibe
                  ? 'liquid-glass-strong'
                  : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
              }`}>
                <button
                  onClick={() => { settings.updateSettings({ permissionMode: 'craft' }); setShowModeMenu(false) }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors ${
                    mode === 'craft'
                      ? vibe ? 'bg-md-warning/20 text-md-warning' : 'bg-md-warning/10 text-md-warning'
                      : vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainerHigh'
                  }`}
                >
                  <Hammer size={16} />
                  <div className="text-left">
                    <div className="font-medium">{t('chat.modeCraftTitle')}</div>
                    <div className="text-[10px] opacity-60">{t('chat.modeCraftDesc')}</div>
                  </div>
                </button>
                <button
                  onClick={() => { settings.updateSettings({ permissionMode: 'ask' }); setShowModeMenu(false) }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors ${
                    mode === 'ask'
                      ? vibe ? 'bg-md-success/20 text-md-success' : 'bg-md-success/10 text-md-success'
                      : vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainerHigh'
                  }`}
                >
                  <Eye size={16} />
                  <div className="text-left">
                    <div className="font-medium">{t('chat.modeAskTitle')}</div>
                    <div className="text-[10px] opacity-60">{t('chat.modeAskDesc')}</div>
                  </div>
                </button>
                <button
                  onClick={() => { settings.updateSettings({ permissionMode: 'plan' }); setShowModeMenu(false) }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors ${
                    mode === 'plan'
                      ? vibe ? 'bg-md-info/20 text-md-info' : 'bg-md-info/10 text-md-info'
                      : vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainerHigh'
                  }`}
                >
                  <ClipboardList size={16} />
                  <div className="text-left">
                    <div className="font-medium">{t('chat.modePlanTitle')}</div>
                    <div className="text-[10px] opacity-60">{t('chat.modePlanDesc')}</div>
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* Thinking mode + reasoning effort */}
          <div className="relative flex items-center" ref={thinkingMenuRef}>
            <button
              onClick={toggleThinking}
              disabled={!thinkingSupported}
              className={`h-8 flex items-center gap-1 px-2 flex-shrink-0 rounded-l-md3-sm transition-colors ${
                settings.enableThinking && thinkingSupported
                  ? vibe
                    ? 'bg-md-tertiary/30 text-md-tertiary'
                    : 'bg-md-tertiary/20 text-md-tertiary'
                  : vibe
                    ? 'hover:bg-white/15 text-white/70 disabled:opacity-30'
                    : 'hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant disabled:opacity-30'
              }`}
              title={thinkingSupported ? t('chat.thinkingToggle') : t('chat.thinkingUnsupported')}
              aria-pressed={settings.enableThinking && thinkingSupported}
            >
              <Brain size={16} />
            </button>
            {hasReasoningLevels && (
              <button
                onClick={() => setShowThinkingMenu((v) => !v)}
                disabled={!thinkingSupported}
                className={`h-8 flex items-center gap-1 px-1.5 flex-shrink-0 rounded-r-md3-sm transition-colors ${
                  settings.enableThinking && thinkingSupported
                    ? vibe
                      ? 'bg-md-tertiary/30 text-md-tertiary'
                      : 'bg-md-tertiary/20 text-md-tertiary'
                    : vibe
                      ? 'text-white/70 disabled:opacity-30'
                      : 'text-dark-onSurfaceVariant disabled:opacity-30'
                }`}
                title={t('chat.thinkingLevel')}
                aria-expanded={showThinkingMenu}
              >
                <span className="text-[10px] capitalize">{reasoningEfforts[currentEffortIndex]}</span>
                <ChevronDown size={11} className={`transition-transform ${showThinkingMenu ? 'rotate-180' : ''}`} />
              </button>
            )}
            {showThinkingMenu && thinkingSupported && hasReasoningLevels && (
              <div className={`absolute bottom-full mb-1 left-0 w-64 p-3 rounded-md3-md z-50 ${
                vibe ? 'liquid-glass-strong' : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
              }`}>
                <div className="flex items-center justify-between mb-2 text-xs">
                  <span>{t('chat.thinkingLevel')}</span>
                  <button
                    onClick={toggleThinking}
                    className={`px-2 py-0.5 rounded-full text-[10px] ${settings.enableThinking ? 'bg-md-tertiary/20 text-md-tertiary' : 'bg-dark-surfaceContainer text-dark-onSurfaceVariant'}`}
                  >
                    {settings.enableThinking ? t('chat.thinkingOn') : t('chat.thinkingOff')}
                  </button>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, reasoningEfforts.length - 1)}
                  step={1}
                  value={currentEffortIndex}
                  onChange={(e) => setReasoningEffort(Number(e.target.value))}
                  className="w-full accent-md-tertiary"
                />
                <div className="mt-1 flex justify-between text-[9px] text-dark-onSurfaceVariant/70">
                  {reasoningEfforts.map((effort) => <span key={effort} className="capitalize">{effort}</span>)}
                </div>
              </div>
            )}
          </div>

          {/* Skill selector dropdown */}
          <div className="relative" ref={skillMenuRef}>
            <button
              onClick={() => setShowSkillMenu(!showSkillMenu)}
              className={`h-8 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors ${
                activeSkills.length > 0
                  ? vibe
                    ? 'bg-md-primary/25 text-md-primary hover:bg-md-primary/35'
                    : 'bg-md-primary/15 text-md-primary hover:bg-md-primary/25'
                  : vibe
                    ? 'hover:bg-white/15 text-white/70'
                    : 'hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
              }`}
              title={t('chat.skillsAria')}
              aria-label={t('chat.skillsAria')}
              aria-expanded={showSkillMenu}
            >
              <Zap size={14} />
              <span className="text-xs font-medium">Skill</span>
              {activeSkills.length > 0 && (
                <span className={`text-[10px] px-1 rounded-full ${
                  vibe ? 'bg-md-primary/30 text-md-primary' : 'bg-md-primary/25 text-md-primary'
                }`}>
                  {activeSkills.length}
                </span>
              )}
              <ChevronDown size={12} className={`transition-transform ${showSkillMenu ? 'rotate-180' : ''}`} />
            </button>
            {showSkillMenu && (
              <div className={`absolute bottom-full mb-1 left-0 w-64 rounded-md3-md overflow-hidden z-50 ${
                vibe
                  ? 'liquid-glass-strong'
                  : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
              }`}>
                <div className={`px-3 py-2 text-[10px] uppercase tracking-wide ${
                  vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/40'
                }`}>
                  {t('chat.installedSkills')}
                </div>
                {skills.length === 0 ? (
                  <div className={`px-3 py-3 text-xs text-center ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/50'}`}>
                    {t('chat.noSkills')}
                  </div>
                ) : (
                  <div className="max-h-56 overflow-y-auto">
                    {skills.map((skill) => {
                      const isActive = sessionSkillIds.includes(skill.id)
                      return (
                        <button
                          key={skill.id}
                          onClick={() => toggleSessionSkill(skill.id, effectiveWorkDir || undefined)}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                            isActive
                              ? vibe
                                ? 'bg-md-primary/20 text-md-primary'
                                : 'bg-md-primary/10 text-md-primary'
                              : vibe
                                ? 'text-white/90 hover:bg-white/10'
                                : 'text-dark-onSurface hover:bg-dark-surfaceContainerHigh'
                          }`}
                        >
                          <span className="flex-shrink-0">{skill.icon}</span>
                          <div className="flex-1 text-left min-w-0">
                            <div className="truncate font-medium">{skill.name}</div>
                            {skill.description && (
                              <div className={`text-[10px] truncate ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/40'}`}>
                                {skill.description}
                              </div>
                            )}
                          </div>
                          {isActive && <Check size={14} className="flex-shrink-0 text-md-primary" />}
                        </button>
                      )
                    })}
                  </div>
                )}
                <div className={`border-t ${vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'}`}>
                  <button
                    onClick={() => { setShowSkillMenu(false); setShowSkillStore(true) }}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm transition-colors ${
                      vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainerHigh'
                    }`}
                  >
                    <Store size={14} />
                    <span>{t('chat.getSkills')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Model selector dropdown */}
          <div className="relative" ref={modelMenuRef}>
            <button
              onClick={() => setShowModelMenu(!showModelMenu)}
              className={`h-8 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors ${
                vibe ? 'hover:bg-white/15 text-white/70' : 'hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
              }`}
            >
              <span className="max-w-[100px] truncate text-xs">{currentModelLabel}</span>
              <ChevronDown size={12} className={`transition-transform ${showModelMenu ? 'rotate-180' : ''}`} />
            </button>
            {showModelMenu && (
              <div className={`absolute bottom-full mb-1 left-0 w-56 rounded-md3-md overflow-hidden z-50 py-1 max-h-64 overflow-y-auto ${
                vibe
                  ? 'liquid-glass-strong'
                  : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
              }`}>
                {providersWithModels.length === 0 ? (
                  <div className={`px-3 py-3 text-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant'}`}>
                    {t('chat.noModels')}
                  </div>
                ) : (
                  providersWithModels.map((p) => (
                    <div key={p.id}>
                      {/* 提供商分组标题：滚动时吸附在顶部 */}
                      <div
                        className={`sticky top-0 z-10 flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide backdrop-blur-sm ${
                          vibe
                            ? 'text-white/50 bg-black/25'
                            : 'text-dark-onSurfaceVariant/70 bg-dark-surfaceContainerHighest/95'
                        }`}
                      >
                        <span className="truncate">{p.name}</span>
                        <span
                          className={`px-1 py-px rounded text-[9px] normal-case font-medium flex-shrink-0 ${
                            vibe ? 'bg-white/15 text-white/70' : 'bg-dark-surfaceContainer text-dark-onSurfaceVariant'
                          }`}
                        >
                          {p.apiCompat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                        </span>
                      </div>
                      {p.models.map((m) => {
                        const active = p.id === settings.activeProviderId && m.id === settings.activeModelId
                        return (
                          <button
                            key={m.id}
                            onClick={() => handleSelectModel(p.id, m.id)}
                            className={`w-full text-left px-3 py-2 transition-colors ${
                              active
                                ? vibe ? 'text-md-primary bg-md-primary/10' : 'text-md-primary bg-md-primary/5'
                                : vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainer'
                            }`}
                          >
                            <div className="text-xs font-medium truncate">{m.label || m.id}</div>
                            {m.label && (
                              <div className={`text-[10px] truncate mt-0.5 ${active ? 'text-md-primary/70' : vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/70'}`}>
                                {m.id}
                              </div>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  ))
                )}
                <div className={`my-1 border-t ${vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'}`} />
                <button
                  onClick={handleAddCustomModel}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                    vibe ? 'text-md-primary hover:bg-white/10' : 'text-md-primary hover:bg-md-primary/10'
                  }`}
                >
                  <Plus size={13} /> {t('chat.customModel')}
                </button>
              </div>
            )}
          </div>

          {/* Spacer to push send button to the right */}
          <div className="flex-1" />

          {/* Send / Stop button */}
          <button
            onClick={isStreaming ? onStop : handleSend}
            disabled={!isStreaming && !content.trim()}
            className={`h-9 w-9 flex-shrink-0 flex items-center justify-center rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              isStreaming
                ? 'bg-md-error text-md-onError hover:bg-md-error/90'
                : vibe
                  ? 'bg-white/25 text-white hover:bg-white/35'
                  : 'bg-md-primary text-md-onPrimary hover:bg-md-primary/90'
            }`}
          >
            {isStreaming ? <Square size={14} /> : <Send size={16} />}
          </button>
        </div>
      </div>

      {/* Disclaimer - only in default mode */}
      {!isWelcome && (
        <div className="text-center mt-1.5 max-w-5xl mx-auto">
          <span className={`text-[10px] ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/30'}`}>{t('chat.disclaimer')}</span>
        </div>
      )}
    </div>
  )
}
