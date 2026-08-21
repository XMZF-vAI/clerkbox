import { useState, useRef, type KeyboardEvent as ReactKeyboardEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, useEffect } from 'react'
import { Send, Brain, FolderOpen, ChevronDown, Hammer, Eye, Square, ClipboardList, Zap, Check, X, Store, Plus, FolderPlus, Paperclip, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import { useSkillsStore } from '../../stores/skills-store'
import { useUIStore } from '../../stores/ui-store'
import { ipc } from '../../lib/ipc-client'
import type { MessageAttachment } from '../../types/agent'
import ConfirmDialog from '../ui/ConfirmDialog'

// 取路径的最后一节作为显示名（兼容 Windows/Unix 两种分隔符）
const basename = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p

// ── 图片附件常量 ──
const MAX_IMAGES = 10
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_DIM = 2048
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']

const isImagePath = (p: string) => IMAGE_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext))

const genAttachmentId = () => `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

/** 客户端压缩图片：最长边 > MAX_IMAGE_DIM 时 canvas 等比重采样（PNG 输出 PNG，其余 JPEG 0.85；GIF 保持原样以免丢动画） */
function compressImage(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const maxDim = Math.max(img.width, img.height)
        if (maxDim <= MAX_IMAGE_DIM) {
          resolve(dataUrl)
          return
        }
        if (dataUrl.startsWith('data:image/gif')) {
          resolve(dataUrl)
          return
        }
        const scale = MAX_IMAGE_DIM / maxDim
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.width * scale))
        canvas.height = Math.max(1, Math.round(img.height * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(dataUrl)
          return
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const output = dataUrl.startsWith('data:image/png')
          ? canvas.toDataURL('image/png')
          : canvas.toDataURL('image/jpeg', 0.85)
        resolve(output)
      } catch (error) {
        reject(error)
      }
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = dataUrl
  })
}

/** FileReader 读 File 为 data URL */
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function comparableFolderPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

interface ChatInputProps {
  onSend: (content: string, attachments?: MessageAttachment[]) => void
  onStop?: () => void
  isStreaming?: boolean
  variant?: 'default' | 'welcome'
  vibe?: boolean
}

export default function ChatInput({ onSend, onStop, isStreaming, variant = 'default', vibe = false }: ChatInputProps) {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [folderSelecting, setFolderSelecting] = useState(false)
  const [attachSelecting, setAttachSelecting] = useState(false)
  const [dragging, setDragging] = useState(false)
  // 附件列表（图片 base64 / 文件路径引用）。用 ref 镜像最新值，
  // 保证多文件批量异步添加时上限校验读到的是同步最新列表（闭包里的 state 会过期）。
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const attachmentsRef = useRef<MessageAttachment[]>([])

  const commitAttachments = (next: MessageAttachment[]) => {
    attachmentsRef.current = next
    setAttachments(next)
  }

  const addImageAttachment = (dataUrl: string, name: string, path?: string) => {
    const prev = attachmentsRef.current
    const images = prev.filter((a) => a.kind === 'image')
    const totalBytes = images.reduce((sum, a) => sum + (a.dataUrl?.length ?? 0), 0) + dataUrl.length
    if (images.length >= MAX_IMAGES || totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      alert(t('chat.attachLimit'))
      return
    }
    commitAttachments([...prev, {
      id: genAttachmentId(),
      kind: 'image',
      name,
      mimeType: dataUrl.slice(5, dataUrl.indexOf(';')),
      dataUrl,
      path: path || undefined,
      size: dataUrl.length,
    }])
  }

  const addFileAttachment = (name: string, path: string) => {
    commitAttachments([...attachmentsRef.current, { id: genAttachmentId(), kind: 'file', name, path }])
  }

  const removeAttachment = (id: string) => {
    commitAttachments(attachmentsRef.current.filter((a) => a.id !== id))
  }
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const settings = useSettingsStore()
  const { sessions, activeSessionId, updateSessionWorkingDir, recentsFolders, pushRecentFolder } = useChatStore()
  const currentSession = sessions.find((s) => s.id === activeSessionId)
  const defaultWorkDir = currentSession?.defaultWorkDir
  const effectiveWorkDir = currentSession?.workingDir || defaultWorkDir

  // Model dropdown state
  const [showModelMenu, setShowModelMenu] = useState(false)
  // 折叠的提供商 id 集合（默认当前生效的提供商展开，其余折叠）
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set())
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const modelTriggerRef = useRef<HTMLButtonElement>(null)

  // 工作目录 popover 状态
  const [showFolderPopover, setShowFolderPopover] = useState(false)
  const folderPopoverRef = useRef<HTMLDivElement>(null)
  const folderTriggerRef = useRef<HTMLButtonElement>(null)

  // 切换到某个目录的授权弹窗：选中的目录在弹窗中确认后才生效
  // 豁免：recents 列表里的目录（已经授权过）+ 会话默认目录（用户从未改过，不算授权过）
  const [pendingFolder, setPendingFolder] = useState<string | null>(null)

  // Mode dropdown state
  const [showModeMenu, setShowModeMenu] = useState(false)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const modeTriggerRef = useRef<HTMLButtonElement>(null)

  // Skill dropdown state
  const [showSkillMenu, setShowSkillMenu] = useState(false)
  const skillMenuRef = useRef<HTMLDivElement>(null)
  const skillTriggerRef = useRef<HTMLButtonElement>(null)
  const [showThinkingMenu, setShowThinkingMenu] = useState(false)
  const thinkingMenuRef = useRef<HTMLDivElement>(null)
  const thinkingTriggerRef = useRef<HTMLButtonElement>(null)
  // 按字段订阅：skills 用于下拉菜单展示所有已安装技能，sessionSkillIds 用于判断激活态
  const skills = useSkillsStore((s) => s.skills)
  const sessionSkillIds = useSkillsStore((s) => s.sessionSkillIds)
  const toggleSessionSkill = useSkillsStore((s) => s.toggleSessionSkill)
  const { setShowSkillStore } = useUIStore()
  const activeSkills = skills.filter((s) => sessionSkillIds.includes(s.id))

  const handleSend = () => {
    const trimmed = content.trim()
    if (isStreaming) return
    if (!trimmed && attachments.length === 0) return
    if (trimmed.length > 50000) {
      alert(t('chat.messageTooLong'))
      return
    }
    // 非视觉模型：无磁盘路径的图片（如粘贴的截图）无法降级为路径引用，直接拦截
    if (!imageSupported && attachments.some((a) => a.kind === 'image' && !a.path)) {
      alert(t('chat.imageBlocked'))
      return
    }
    onSend(trimmed, attachments.length ? attachments : undefined)
    setContent('')
    commitAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  // ── 附件入口 1：附件按钮（系统文件选择器，多选，图片与任意文件） ──
  const openAttachPicker = async () => {
    if (attachSelecting) return
    setAttachSelecting(true)
    try {
      const paths = await ipc.selectChatFiles()
      if (paths) {
        for (const p of paths) {
          if (isImagePath(p)) {
            try {
              const dataUrl = await ipc.readImageFileBase64(p)
              const compressed = await compressImage(dataUrl)
              addImageAttachment(compressed, basename(p), p)
            } catch {
              alert(t('chat.attachReadFailed'))
            }
          } else {
            addFileAttachment(basename(p), p)
          }
        }
      }
    } catch (error) {
      console.error('Failed to select chat files:', error)
    } finally {
      setAttachSelecting(false)
    }
  }

  // ── 附件入口 2：粘贴（剪贴板图片 → base64 图片附件；复制的磁盘文件 → 路径引用） ──
  // 同步遍历 clipboardData.items 取 File（await 之后剪贴板数据可能失效），再异步读取。
  // 只在真正消费了至少一个条目时 preventDefault，绝不拦截纯文本粘贴。
  const handlePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    const pathFiles: Array<{ name: string; path: string }> = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (!file) continue
      if (file.type.startsWith('image/')) {
        imageFiles.push(file)
      } else {
        // file.type 可能为空（部分平台复制的磁盘文件），只要能取到真实路径就按文件引用入列
        const p = ipc.getPathForFile(file)
        if (p) pathFiles.push({ name: file.name, path: p })
      }
    }
    if (imageFiles.length === 0 && pathFiles.length === 0) return
    e.preventDefault()
    void (async () => {
      for (const file of imageFiles) {
        try {
          const dataUrl = await readFileAsDataURL(file)
          const compressed = await compressImage(dataUrl)
          addImageAttachment(compressed, file.name || 'image.png')
        } catch {
          alert(t('chat.attachReadFailed'))
        }
      }
      for (const { name, path } of pathFiles) {
        addFileAttachment(name, path)
      }
    })()
  }

  // ── 附件入口 3：拖拽（图片文件 → 图片附件（带路径）；其他文件 → 路径引用） ──
  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(true)
  }

  const handleDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
  }

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    // 同步取 FileList（事件结束后可能失效），路径解析与读取异步进行
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    void (async () => {
      for (const file of files) {
        const p = ipc.getPathForFile(file)
        if (file.type.startsWith('image/')) {
          try {
            const dataUrl = await readFileAsDataURL(file)
            const compressed = await compressImage(dataUrl)
            addImageAttachment(compressed, file.name, p || undefined)
          } catch {
            alert(t('chat.attachReadFailed'))
          }
        } else if (p) {
          addFileAttachment(file.name, p)
        }
      }
    })()
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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

  // 申请切换到某个目录。规则：
  //  - 等于会话默认目录：免授权
  //  - 已经在 recents 列表里：免授权（之前已授权过）
  //  - 其他：弹授权弹窗让用户确认
  const requestSetFolder = (dir: string) => {
    setShowFolderPopover(false)
    if (!dir || !activeSessionId) return
    if (effectiveWorkDir && comparableFolderPath(dir) === comparableFolderPath(effectiveWorkDir)) return // 已经是这个目录
    const isDefault = defaultWorkDir && comparableFolderPath(dir) === comparableFolderPath(defaultWorkDir)
    const isRecents = recentsFolders.some((p) => comparableFolderPath(p) === comparableFolderPath(dir))
    if (isDefault || isRecents) {
      applyFolder(dir)
    } else {
      setPendingFolder(dir)
    }
  }

  // 真正切换工作目录：更新 session + 加入 recents（默认目录也加入 recents，这样下次切换可以免授权）
  const applyFolder = (dir: string) => {
    if (!activeSessionId) return
    updateSessionWorkingDir(activeSessionId, dir)
    void pushRecentFolder(dir)
  }

  // 授权弹窗：用户同意则切换
  const confirmPendingFolder = () => {
    if (pendingFolder) {
      applyFolder(pendingFolder)
      setPendingFolder(null)
    }
  }
  // 授权弹窗：用户拒绝则什么都不做
  const rejectPendingFolder = () => {
    setPendingFolder(null)
  }

  // popover 的「选择文件夹」按钮：先关 popover 再开系统选择器
  const openSystemFolderPicker = async () => {
    setShowFolderPopover(false)
    if (folderSelecting) return
    setFolderSelecting(true)
    try {
      const folder = await ipc.selectFolder()
      if (folder) requestSetFolder(folder)
    } catch (error) {
      console.error('Failed to select a working directory:', error)
      alert(t('chat.folderSelectionFailed'))
    } finally {
      setFolderSelecting(false)
    }
  }

  const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
  const activeModel = activeProvider?.models.find((m) => m.id === settings.activeModelId)
  const thinkingSupported = activeModel?.supportsThinking ?? false
  const imageSupported = activeModel?.supportsImages ?? false
  const reasoningEfforts = activeModel?.reasoningEfforts ?? []
  const hasReasoningLevels = reasoningEfforts.length > 0
  const selectedReasoningEffort = activeModel?.reasoningEffort ?? settings.reasoningEffort ?? reasoningEfforts[0]
  const currentEffortIndex = Math.max(0, selectedReasoningEffort ? reasoningEfforts.indexOf(selectedReasoningEffort) : 0)

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
    setCollapsedProviders(new Set())
  }

  // 切换某提供商的折叠状态
  const toggleProviderCollapse = (providerId: string) => {
    setCollapsedProviders((prev) => {
      const next = new Set(prev)
      if (next.has(providerId)) next.delete(providerId)
      else next.add(providerId)
      return next
    })
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
      if (folderPopoverRef.current && !folderPopoverRef.current.contains(e.target as Node)) {
        setShowFolderPopover(false)
      }
    }
    if (showModelMenu || showModeMenu || showSkillMenu || showThinkingMenu || showFolderPopover) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModelMenu, showModeMenu, showSkillMenu, showThinkingMenu, showFolderPopover])

  useEffect(() => {
    if (!showModelMenu && !showModeMenu && !showSkillMenu && !showThinkingMenu && !showFolderPopover) return

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const trigger = showModelMenu
        ? modelTriggerRef.current
        : showModeMenu
          ? modeTriggerRef.current
          : showSkillMenu
            ? skillTriggerRef.current
            : showThinkingMenu
              ? thinkingTriggerRef.current
              : folderTriggerRef.current
      event.stopPropagation()
      setShowModelMenu(false)
      setShowModeMenu(false)
      setShowSkillMenu(false)
      setShowThinkingMenu(false)
      setShowFolderPopover(false)
      requestAnimationFrame(() => trigger?.focus())
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [showModelMenu, showModeMenu, showSkillMenu, showThinkingMenu, showFolderPopover])

  const mode = settings.permissionMode
  const modeIcon = mode === 'craft' ? Hammer : mode === 'plan' ? ClipboardList : Eye
  const modeLabel = mode === 'craft' ? t('sidebar.mode.craftLabel') : mode === 'plan' ? t('sidebar.mode.planLabel') : t('sidebar.mode.askLabel')
  const ModeIcon = modeIcon

  // 当前模型显示名：优先取所属提供商里登记的 label，回落到 model id；都没有则提示未配置
  const currentModelLabel = (() => {
    const p = settings.providers.find((x) => x.id === settings.activeProviderId)
    const m = p?.models.find((x) => x.id === settings.activeModelId)
    return m?.label || m?.id || settings.model || t('chat.noModelActive')
  })()

  // 只显示有模型的提供商，避免下拉里出现空组
  // Lunora 永远是第一位（按 presetId 识别，与用户添加顺序无关）
  const providersWithModels = settings.providers
    .filter((p) => p.models.length > 0)
    .slice()
    .sort((a, b) => (a.presetId === 'lunora' ? -1 : b.presetId === 'lunora' ? 1 : 0))

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

      <div
        className={`${boxClass} ${dragging ? 'ring-2 ring-md-primary/50' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Active skills pills - shown when any skill is loaded */}
        {activeSkills.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {activeSkills.map((skill) => (
              <button
                type="button"
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

        {/* Attachments preview - images as thumbnails, files as chips */}
        {attachments.length > 0 && (
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              {attachments.map((a) => a.kind === 'image' ? (
                <div key={a.id} className="relative group">
                  <img
                    src={a.dataUrl}
                    alt={a.name}
                    title={a.path || a.name}
                    className="w-14 h-14 object-cover rounded-md3-sm border border-dark-onSurfaceVariant/15"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={t('chat.attachRemove')}
                    title={t('chat.attachRemove')}
                    className={`absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center transition-opacity ${
                      vibe
                        ? 'bg-white/70 text-dark-surface hover:bg-white'
                        : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/20 text-dark-onSurfaceVariant hover:text-md-error'
                    }`}
                  >
                    <X size={10} />
                  </button>
                </div>
              ) : (
                <div
                  key={a.id}
                  title={a.path}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md3-sm text-[11px] ${
                    vibe ? 'bg-white/10 text-white/80' : 'bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant'
                  }`}
                >
                  <FileText size={11} className="flex-shrink-0" />
                  <span className="truncate max-w-[140px]">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={t('chat.attachRemove')}
                    title={t('chat.attachRemove')}
                    className="opacity-60 hover:opacity-100 flex-shrink-0"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
            {/* 当前模型不支持图片输入时的降级提示 */}
            {attachments.some((a) => a.kind === 'image') && !imageSupported && (
              <div className="text-[10px] text-md-warning mt-1">{t('chat.imageUnsupportedHint')}</div>
            )}
          </div>
        )}

        {/* Textarea - top area */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          disabled={isStreaming}
          aria-label={t('chat.messageInputAria')}
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
          {/* Attach (images / files) button */}
          <button
            type="button"
            onClick={openAttachPicker}
            disabled={attachSelecting}
            className={`h-8 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors disabled:opacity-40 ${
              vibe
                ? 'hover:bg-white/15 text-white/70'
                : 'hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
            }`}
            title={t('chat.attachAria')}
            aria-label={t('chat.attachAria')}
          >
            {attachSelecting ? (
              <div className={`w-3.5 h-3.5 border-2 border-t-transparent rounded-full animate-spin ${vibe ? 'border-white/50' : 'border-dark-onSurfaceVariant/40'}`} />
            ) : (
              <Paperclip size={16} />
            )}
          </button>

          {/* Working folder button + popover */}
          <div className="relative" ref={folderPopoverRef}>
            <button
              ref={folderTriggerRef}
              type="button"
              onClick={() => setShowFolderPopover((v) => !v)}
              disabled={folderSelecting}
              className={`h-8 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors disabled:opacity-40 ${
                vibe
                  ? 'hover:bg-white/15 text-white/70'
                  : 'hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
              }`}
              title={t('chat.selectFolderTitle')}
              aria-label={t('chat.selectFolderAria')}
              aria-controls="chat-folder-menu"
              aria-expanded={showFolderPopover}
            >
              {folderSelecting ? (
                <div className={`w-3.5 h-3.5 border-2 border-t-transparent rounded-full animate-spin ${vibe ? 'border-white/50' : 'border-dark-onSurfaceVariant/40'}`} />
              ) : (
                <FolderOpen size={16} />
              )}
            </button>

            {showFolderPopover && (
              <div id="chat-folder-menu" className={`absolute bottom-full left-0 mb-1 w-72 rounded-md3-md border shadow-2xl z-40 overflow-hidden animate-fade-in ${
                vibe
                  ? 'bg-white/10 border-white/15 backdrop-blur-2xl text-white'
                  : 'bg-dark-surfaceContainer border-dark-onSurfaceVariant/15 text-dark-onSurface'
              }`}>
                {/* Current working dir (with check) */}
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider opacity-50">
                  {t('chat.folderCurrent')}
                </div>
                {effectiveWorkDir ? (
                  <div className={`px-3 py-1.5 mx-1 rounded-md3-sm flex items-center gap-2 text-xs ${vibe ? 'bg-white/10' : 'bg-dark-surfaceContainerHigh'}`}>
                    <FolderOpen size={12} className="opacity-60 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{basename(effectiveWorkDir)}</div>
                      <div className="truncate opacity-50 text-[10px]">{effectiveWorkDir}</div>
                    </div>
                    <Check size={12} className="text-md-primary flex-shrink-0" />
                  </div>
                ) : (
                  <div className="px-3 py-1.5 text-xs opacity-50">{t('chat.folderNone')}</div>
                )}

                {/* Recents list */}
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider opacity-50">
                  {t('chat.folderRecents')}
                </div>
                {recentsFolders.length === 0 ? (
                  <div className="px-3 py-2 text-xs opacity-50">{t('chat.folderNoRecents')}</div>
                ) : (
                  <div className="max-h-56 overflow-y-auto pb-1">
                    {recentsFolders.map((p) => {
                      const isCurrent = effectiveWorkDir && comparableFolderPath(p) === comparableFolderPath(effectiveWorkDir)
                      return (
                        <button
                          type="button"
                          key={p}
                          onClick={() => requestSetFolder(p)}
                          className={`w-full px-3 py-1.5 mx-1 rounded-md3-sm flex items-center gap-2 text-xs text-left transition-colors ${
                            isCurrent
                              ? (vibe ? 'bg-white/10' : 'bg-dark-surfaceContainerHigh')
                              : (vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh')
                          }`}
                          style={{ width: 'calc(100% - 8px)' }}
                        >
                          <FolderOpen size={12} className="opacity-60 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="truncate font-medium">{basename(p)}</div>
                            <div className="truncate opacity-50 text-[10px]">{p}</div>
                          </div>
                          {isCurrent && <Check size={12} className="text-md-primary flex-shrink-0" />}
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* Pick new folder */}
                <div className="border-t border-dark-onSurfaceVariant/10 p-1">
                  <button
                    type="button"
                    onClick={openSystemFolderPicker}
                    className={`w-full px-3 py-1.5 rounded-md3-sm flex items-center gap-2 text-xs transition-colors ${
                      vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh'
                    }`}
                  >
                    <FolderPlus size={12} className="opacity-70" />
                    <span>{t('chat.folderSelect')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Permission mode dropdown */}
          <div className="relative" ref={modeMenuRef}>
            <button
              ref={modeTriggerRef}
              type="button"
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
              aria-label={t('chat.permissionModeAria')}
              aria-controls="chat-permission-mode-menu"
              aria-expanded={showModeMenu}
            >
              <ModeIcon size={14} />
              <span className="text-xs font-medium">{modeLabel}</span>
              <ChevronDown size={12} />
            </button>
            {showModeMenu && (
              <div id="chat-permission-mode-menu" className={`absolute bottom-full mb-1 left-0 w-48 rounded-md3-md overflow-hidden z-50 ${
                vibe
                  ? 'liquid-glass-strong'
                  : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
              }`}>
                <button
                  type="button"
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
                  type="button"
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
                  type="button"
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
              type="button"
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
              aria-label={t('chat.thinkingToggle')}
            >
              <Brain size={16} />
            </button>
            {hasReasoningLevels && (
              <button
                ref={thinkingTriggerRef}
                type="button"
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
                aria-controls="chat-reasoning-menu"
              >
                <span className="text-[10px] capitalize">{reasoningEfforts[currentEffortIndex]}</span>
                <ChevronDown size={11} className={`transition-transform ${showThinkingMenu ? 'rotate-180' : ''}`} />
              </button>
            )}
            {showThinkingMenu && thinkingSupported && hasReasoningLevels && (
              <div id="chat-reasoning-menu" className={`absolute bottom-full mb-1 left-0 w-64 p-3 rounded-md3-md z-50 ${
                vibe ? 'liquid-glass-strong' : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
              }`}>
                <div className="flex items-center justify-between mb-2 text-xs">
                  <span>{t('chat.thinkingLevel')}</span>
                  <button
                    type="button"
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
                  aria-label={t('chat.thinkingLevel')}
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
              ref={skillTriggerRef}
              type="button"
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
              aria-controls="chat-skill-menu"
            >
              <Zap size={14} />
              <span className="text-xs font-medium">{t('chat.skillsAria')}</span>
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
              <div id="chat-skill-menu" className={`absolute bottom-full mb-1 left-0 w-64 rounded-md3-md overflow-hidden z-50 ${
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
                          type="button"
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
                    type="button"
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
              ref={modelTriggerRef}
              type="button"
              onClick={() => setShowModelMenu(!showModelMenu)}
              className={`h-8 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors ${
                vibe ? 'hover:bg-white/15 text-white/70' : 'hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
              }`}
              aria-label={t('chat.modelSelectAria')}
              aria-controls="chat-model-menu"
              aria-expanded={showModelMenu}
            >
              <span className="max-w-[100px] truncate text-xs">{currentModelLabel}</span>
              <ChevronDown size={12} className={`transition-transform ${showModelMenu ? 'rotate-180' : ''}`} />
            </button>
            {showModelMenu && (
              <div id="chat-model-menu" className={`absolute bottom-full mb-1 left-0 w-56 rounded-md3-md overflow-hidden z-50 py-1 max-h-64 overflow-y-auto ${
                vibe
                  ? 'liquid-glass-strong'
                  : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
              }`}>
                {providersWithModels.length === 0 ? (
                  <div className={`px-3 py-3 text-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant'}`}>
                    {t('chat.noModels')}
                  </div>
                ) : (
                  providersWithModels.map((p) => {
                    const collapsed = collapsedProviders.has(p.id)
                    const hasActive = p.id === settings.activeProviderId
                    // 当前生效的提供商默认展开
                    const isExpanded = !collapsed || hasActive
                    return (
                      <div key={p.id}>
                        {/* 提供商分组标题：可点击折叠 */}
                        <button
                          type="button"
                          onClick={() => toggleProviderCollapse(p.id)}
                          className={`sticky top-0 z-10 w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide backdrop-blur-sm transition-colors ${
                            vibe
                              ? 'text-white/60 bg-black/25 hover:bg-black/35'
                              : 'text-dark-onSurfaceVariant/70 bg-dark-surfaceContainerHighest/95 hover:bg-dark-surfaceContainerHighest'
                          }`}
                        >
                          <ChevronDown
                            size={10}
                            className={`flex-shrink-0 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                          />
                          <span className="truncate flex-1 text-left">{p.name}</span>
                          <span
                            className={`px-1 py-px rounded text-[9px] normal-case font-medium flex-shrink-0 ${
                              vibe ? 'bg-white/15 text-white/70' : 'bg-dark-surfaceContainer text-dark-onSurfaceVariant'
                            }`}
                          >
                            {p.apiCompat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                          </span>
                        </button>
                        {isExpanded && p.models.map((m) => {
                          const active = p.id === settings.activeProviderId && m.id === settings.activeModelId
                          return (
                            <button
                              type="button"
                              key={m.id}
                              onClick={() => handleSelectModel(p.id, m.id)}
                              className={`w-full text-left pl-7 pr-3 py-2 transition-colors ${
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
                    )
                  })
                )}
                <div className={`my-1 border-t ${vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'}`} />
                <button
                  type="button"
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
            type="button"
            onClick={isStreaming ? onStop : handleSend}
            disabled={!isStreaming && !content.trim() && attachments.length === 0}
            aria-label={isStreaming ? t('chat.stopResponseAria') : t('chat.sendMessageAria')}
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

      {/* 新文件夹授权弹窗 */}
      {pendingFolder && (
        <ConfirmDialog
          title={t('chat.folderPermissionTitle')}
          message={t('chat.folderPermissionMsg', { folder: pendingFolder })}
          confirmText={t('chat.folderPermissionAllow')}
          cancelText={t('chat.folderPermissionDeny')}
          onConfirm={confirmPendingFolder}
          onCancel={rejectPendingFolder}
        />
      )}
    </div>
  )
}
