import { useState, useRef, KeyboardEvent, useEffect } from 'react'
import { Send, Brain, FolderOpen, ChevronDown, Hammer, Eye, Square, ClipboardList, Zap, Check, X, Store, Plus } from 'lucide-react'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import { useSkillsStore } from '../../stores/skills-store'
import { useUIStore } from '../../stores/ui-store'
import { ipc } from '../../lib/ipc-client'
import type { CustomModel } from '../../types/agent'

interface ChatInputProps {
  onSend: (content: string) => void
  onStop?: () => void
  isStreaming?: boolean
  variant?: 'default' | 'welcome'
  vibe?: boolean
}

export default function ChatInput({ onSend, onStop, isStreaming, variant = 'default', vibe = false }: ChatInputProps) {
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
  const { skills, sessionSkillIds, toggleSessionSkill } = useSkillsStore()
  const { setShowSkillStore } = useUIStore()
  const activeSkills = skills.filter((s) => sessionSkillIds.includes(s.id))

  const handleSend = () => {
    const trimmed = content.trim()
    if (!trimmed || isStreaming) return
    if (trimmed.length > 50000) {
      alert('消息过长，请控制在 50000 字符以内')
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

  const toggleThinking = () => {
    settings.updateSettings({ enableThinking: !settings.enableThinking })
  }

  const handleSelectModel = (m: CustomModel) => {
    settings.activateCustomModel(m.id)
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
    }
    if (showModelMenu || showModeMenu || showSkillMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModelMenu, showModeMenu, showSkillMenu])

  const mode = settings.permissionMode
  const modeIcon = mode === 'craft' ? Hammer : mode === 'plan' ? ClipboardList : Eye
  const modeLabel = mode === 'craft' ? 'Craft' : mode === 'plan' ? 'Plan' : 'Ask'
  const ModeIcon = modeIcon

  const currentModelLabel =
    settings.customModels.find((m) => m.id === settings.activeCustomModelId)?.label || settings.model

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
            {effectiveWorkDir}{currentSession?.workingDir ? '' : ' (默认)'}
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
                title={`点击卸载 ${skill.name}`}
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
          placeholder={vibe ? '在 VIBE 模式中输入...' : (effectiveWorkDir ? `在 ${effectiveWorkDir.split(/[/\\]/).pop()} 中工作...` : '输入指令，按 Enter 发送...')}
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
            title="选择工作目录"
            aria-label="选择工作目录"
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
                    <div className="font-medium">Craft 模式</div>
                    <div className="text-[10px] opacity-60">可读写文件、执行命令，危险操作需确认</div>
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
                    <div className="font-medium">Ask 模式</div>
                    <div className="text-[10px] opacity-60">仅允许读取文件和目录，不可修改或执行</div>
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
                    <div className="font-medium">Plan 模式</div>
                    <div className="text-[10px] opacity-60">先制定计划写入 plan.md，确认后再执行</div>
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* Thinking mode toggle */}
          <button
            onClick={toggleThinking}
            className={`h-8 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors ${
              settings.enableThinking
                ? vibe
                  ? 'bg-md-tertiary/30 text-md-tertiary'
                  : 'bg-md-tertiary/20 text-md-tertiary'
                : vibe
                  ? 'hover:bg-white/15 text-white/70'
                  : 'hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
            }`}
            title={settings.enableThinking ? '关闭思考模式' : '开启思考模式'}
          >
            <Brain size={16} />
          </button>

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
              title="技能"
              aria-label="技能"
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
                  已安装技能
                </div>
                {skills.length === 0 ? (
                  <div className={`px-3 py-3 text-xs text-center ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/50'}`}>
                    还没有安装任何技能
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
                    <span>获取技能</span>
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
                {settings.customModels.length === 0 ? (
                  <div className={`px-3 py-3 text-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant'}`}>
                    还没有模型，点击下方添加
                  </div>
                ) : (
                  settings.customModels.map((m) => {
                    const active = m.id === settings.activeCustomModelId
                    return (
                      <button
                        key={m.id}
                        onClick={() => handleSelectModel(m)}
                        className={`w-full text-left px-3 py-2 transition-colors ${
                          active
                            ? vibe ? 'text-md-primary bg-md-primary/10' : 'text-md-primary bg-md-primary/5'
                            : vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainer'
                        }`}
                      >
                        <div className="text-xs font-medium truncate">{m.label}</div>
                        <div className={`text-[10px] truncate mt-0.5 ${active ? 'text-md-primary/70' : vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/70'}`}>
                          {m.model}
                        </div>
                      </button>
                    )
                  })
                )}
                <div className={`my-1 border-t ${vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'}`} />
                <button
                  onClick={handleAddCustomModel}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                    vibe ? 'text-md-primary hover:bg-white/10' : 'text-md-primary hover:bg-md-primary/10'
                  }`}
                >
                  <Plus size={13} /> 自定义模型…
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
          <span className={`text-[10px] ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/30'}`}>ClerkBox 可能会产生错误信息，请核实重要内容</span>
        </div>
      )}
    </div>
  )
}
