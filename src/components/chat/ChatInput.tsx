import { useState, useRef, type KeyboardEvent as ReactKeyboardEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type ChangeEvent as ReactChangeEvent, useEffect } from 'react'
import { Send, Brain, FolderOpen, ChevronDown, Square, Zap, Check, X, Store, Plus, FolderPlus, Paperclip, FileText, ShieldCheck, Hand, TriangleAlert, Slash, BookOpen, GitBranch, Target, Plug, Settings2, FoldVertical, Loader2, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import { useSkillsStore } from '../../stores/skills-store'
import { useMcpStore } from '../../stores/mcp-store'
import { useUIStore } from '../../stores/ui-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import type { MessageAttachment, TaskMode } from '../../types/agent'
import type { FileEntry, WebUICapabilities } from '../../types/ipc'
import ConfirmDialog from '../ui/ConfirmDialog'
import { useIsMobile } from '../../hooks/use-mobile'

// ── "/" 命令菜单里的命令（任务工作流 + 上下文压缩；工作流对齐 TRAE：Spec / Plan / Goal；Browser 模式不做） ──
// 上下文压缩命令：选中后出现芯片，回车即手动压缩（输入文本作为可选的压缩重点指令）
const COMPACT_COMMAND = { id: 'compact' as const, name: '压缩', icon: FoldVertical, descKey: 'chat.cmdCompactDesc' }
const TASK_COMMANDS: Array<{ id: TaskMode | 'compact'; name: string; icon: LucideIcon; descKey: string }> = [
  { id: 'spec', name: 'Spec', icon: BookOpen, descKey: 'chat.cmdSpecDesc' },
  { id: 'plan', name: 'Plan', icon: GitBranch, descKey: 'chat.cmdPlanDesc' },
  { id: 'goal', name: 'Goal', icon: Target, descKey: 'chat.cmdGoalDesc' },
  COMPACT_COMMAND,
]

// 取路径的最后一节作为显示名（兼容 Windows/Unix 两种分隔符）
const basename = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p
const appendFolderPath = (parent: string, name: string) => {
  const separator = parent.includes('\\') ? '\\' : '/'
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`
}

// ── 图片附件常量 ──
const MAX_IMAGES = 10
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_DIM = 2048
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']

const isImagePath = (p: string) => IMAGE_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext))

const genAttachmentId = () => `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const FALLBACK_WEBUI_UPLOAD_LIMIT = 10 * 1024 * 1024

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

function parentFolderPath(value: string): string | null {
  const trimmed = value.replace(/[\\/]+$/, '') || value
  const separatorIndex = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (separatorIndex < 0) return null
  // Keep filesystem roots navigable but never produce an empty path.
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`
  if (separatorIndex === 0) return trimmed.slice(0, 1)
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(trimmed)) return `${trimmed.slice(0, 3)}`
  const parent = trimmed.slice(0, separatorIndex)
  return parent || null
}

interface ChatInputProps {
  onSend: (content: string, attachments?: MessageAttachment[], taskMode?: TaskMode) => void
  onManualCompact?: (instructions?: string) => void | Promise<void>
  isCompacting?: boolean
  onStop?: () => void
  isStreaming?: boolean
  variant?: 'default' | 'welcome'
  vibe?: boolean
}

export default function ChatInput({ onSend, onManualCompact, isCompacting, onStop, isStreaming, variant = 'default', vibe = false }: ChatInputProps) {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  // 任务工作流芯片（/ 命令菜单选择的 Spec/Plan/Goal，随下一条消息一次性生效）
  const [taskMode, setTaskMode] = useState<TaskMode | null>(null)
  // 上下文压缩芯片（/ 命令菜单选择的「压缩」，回车触发手动压缩，输入文本作为可选压缩重点）
  const [compactMode, setCompactMode] = useState(false)
  const [folderSelecting, setFolderSelecting] = useState(false)
  const [attachSelecting, setAttachSelecting] = useState(false)
  const [dragging, setDragging] = useState(false)
  // 附件列表（图片 base64 / 文件路径引用）。用 ref 镜像最新值，
  // 保证多文件批量异步添加时上限校验读到的是同步最新列表（闭包里的 state 会过期）。
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const attachmentsRef = useRef<MessageAttachment[]>([])
  const remoteFileInputRef = useRef<HTMLInputElement>(null)
  const [webuiCapabilities, setWebuiCapabilities] = useState<WebUICapabilities | null>(null)
  const [remoteFolderPickerOpen, setRemoteFolderPickerOpen] = useState(false)
  const [remoteFolderPath, setRemoteFolderPath] = useState('')
  const [remoteFolderEntries, setRemoteFolderEntries] = useState<FileEntry[]>([])
  const [remoteFolderLoading, setRemoteFolderLoading] = useState(false)

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

  const webuiUploadEnabled = isWebUIMode
  const hostFolderEnabled = isWebUIMode
  const remoteUploadLimit = webuiCapabilities?.maxUploadBytes || FALLBACK_WEBUI_UPLOAD_LIMIT
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const settings = useSettingsStore()
  const { sessions, activeSessionId, updateSessionWorkingDir, recentsFolders, pushRecentFolder } = useChatStore()
  const currentSession = sessions.find((s) => s.id === activeSessionId)
  const defaultWorkDir = currentSession?.defaultWorkDir
  const effectiveWorkDir = currentSession?.workingDir || defaultWorkDir

  useEffect(() => {
    if (!isWebUIMode) return
    void ipc.getWebUICapabilities()
      .then(setWebuiCapabilities)
      .catch((error) => console.error('Failed to load WebUI capabilities:', error))
  }, [])

  // 移动端（WebUI 窄屏）适配：更大的触控目标、底部抽屉面板、虚拟键盘避让
  const isMobile = useIsMobile()
  // 虚拟键盘遮挡高度（visualViewport 与布局视口的高度差），>0 时抬高输入区
  const [kbOffset, setKbOffset] = useState(0)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv || !isMobile) { setKbOffset(0); return }
    const update = () => {
      const overlap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      setKbOffset(overlap)
    }
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [isMobile])

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

  // Approval dropdown state（Agent 操作审批：手动 / 自动 / 完全访问）
  const [showApprovalMenu, setShowApprovalMenu] = useState(false)
  const approvalMenuRef = useRef<HTMLDivElement>(null)
  const approvalTriggerRef = useRef<HTMLButtonElement>(null)

  // "/" 命令菜单状态（任务工作流 + 技能；输入框即过滤框，"/" 后文本为过滤词）
  const [showCommandMenu, setShowCommandMenu] = useState(false)
  const commandMenuRef = useRef<HTMLDivElement>(null)
  const inputBoxRef = useRef<HTMLDivElement>(null)
  const [commandHighlight, setCommandHighlight] = useState(0)

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

  // MCP 服务器（"/" 菜单里可快速启停；连接状态点来自主进程推送）
  const mcpServers = settings.mcpServers ?? []
  const mcpStatuses = useMcpStore((s) => s.statuses)

  // ── "/" 命令菜单：过滤 + 键盘导航 + 选择 ──
  // 过滤词 = 输入框中 "/" 之后的文本（菜单打开时输入框即搜索框，对齐 TRAE 交互）
  const commandQuery = showCommandMenu && content.startsWith('/') ? content.slice(1).trim().toLowerCase() : ''
  const filteredCommands = TASK_COMMANDS.filter((c) =>
    !commandQuery || c.name.toLowerCase().includes(commandQuery) || t(c.descKey).toLowerCase().includes(commandQuery)
  )
  const filteredSkills = skills.filter((s) =>
    !commandQuery || s.name.toLowerCase().includes(commandQuery) || (s.description || '').toLowerCase().includes(commandQuery)
  )
  const filteredMcp = mcpServers.filter((s) =>
    !commandQuery || s.name.toLowerCase().includes(commandQuery)
  )
  const commandFlatCount = filteredCommands.length + filteredSkills.length + filteredMcp.length
  const commandSafeHighlight = commandFlatCount > 0 ? Math.min(commandHighlight, commandFlatCount - 1) : 0

  /** 关闭命令菜单；若输入框只剩触发用的 "/" 则一并清掉 */
  const closeCommandMenu = () => {
    setShowCommandMenu(false)
    setContent((v) => (v.trim() === '/' ? '' : v))
  }

  /** 点击 "/" 按钮打开命令菜单：空输入时补一个 "/" 作为过滤前缀并聚焦输入框 */
  const openCommandMenu = () => {
    if (isStreaming) return
    setShowCommandMenu(true)
    setCommandHighlight(0)
    setContent((v) => (v.trim() === '' ? '/' : v))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  /** 选中命令菜单某项：命令 → 设置任务芯片并关闭；压缩 → 设置压缩芯片并关闭；技能 → 切换激活态并保持菜单（可连续多选）；MCP → 切换启停 */
  const selectCommandItem = (kind: 'command' | 'skill' | 'mcp', id: string) => {
    if (kind === 'command') {
      // 只清掉以 "/" 开头的过滤前缀（菜单触发态），保留用户已输入的正文，避免临时切换模式时丢字
      // 压缩与任务工作流互斥：选中其一即清除另一个，避免残留脏状态
      if (id === COMPACT_COMMAND.id) {
        setTaskMode(null)
        setCompactMode(true)
        setContent((v) => (v.startsWith('/') ? '' : v))
        setShowCommandMenu(false)
        requestAnimationFrame(() => textareaRef.current?.focus())
        return
      }
      setCompactMode(false)
      setTaskMode(id as TaskMode)
      setContent((v) => (v.startsWith('/') ? '' : v))
      setShowCommandMenu(false)
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    if (kind === 'mcp') {
      // 翻转 enabled；settings 变化由 mcp-store 订阅自动同步到主进程（连接/断开 + 工具注入）
      settings.updateSettings({
        mcpServers: mcpServers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)),
      })
      return
    }
    toggleSessionSkill(id, effectiveWorkDir || undefined)
  }

  const handleSend = () => {
    const trimmed = content.trim()
    if (isStreaming || isCompacting) return
    // 压缩模式：回车执行手动压缩（输入文本作为可选自定义指令），不走普通消息发送
    if (compactMode) {
      void onManualCompact?.(trimmed || undefined)
      setContent('')
      setCompactMode(false)
      commitAttachments([])
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
      return
    }
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
    onSend(trimmed, attachments.length ? attachments : undefined, taskMode ?? undefined)
    setContent('')
    setTaskMode(null)
    commitAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const attachRemoteFile = async (file: File) => {
    if (file.size > remoteUploadLimit) {
      alert(t('chat.attachSizeLimit', { name: file.name, limit: Math.round(remoteUploadLimit / (1024 * 1024)) }))
      return
    }
    try {
      const uploaded = await ipc.uploadWebUIFile(file)
      if (file.type.startsWith('image/') || isImagePath(file.name)) {
        const dataUrl = await readFileAsDataURL(file)
        const compressed = await compressImage(dataUrl)
        addImageAttachment(compressed, file.name || uploaded.name, uploaded.path)
      } else {
        addFileAttachment(file.name || uploaded.name, uploaded.path)
      }
    } catch (error) {
      console.error('Failed to upload WebUI file:', error)
      alert(t('chat.attachUploadFailed', { name: file.name || 'file' }))
    }
  }

  const handleRemoteFiles = async (files: File[]) => {
    if (files.length === 0) return
    setAttachSelecting(true)
    try {
      for (const file of files) await attachRemoteFile(file)
    } finally {
      setAttachSelecting(false)
    }
  }

  const handleRemoteFileInputChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    void handleRemoteFiles(files)
  }

  // ── 附件入口 1：附件按钮（系统文件选择器，多选，图片与任意文件） ──
  const openAttachPicker = async () => {
    if (attachSelecting) return
    if (isWebUIMode) {
      remoteFileInputRef.current?.click()
      return
    }
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
    const remoteFiles: File[] = []
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
        else if (webuiUploadEnabled) remoteFiles.push(file)
      }
    }
    if (imageFiles.length === 0 && pathFiles.length === 0 && remoteFiles.length === 0) return
    e.preventDefault()
    void (async () => {
      for (const file of imageFiles) {
        try {
          if (webuiUploadEnabled && file.size > remoteUploadLimit) {
            alert(t('chat.attachSizeLimit', { name: file.name, limit: Math.round(remoteUploadLimit / (1024 * 1024)) }))
            continue
          }
          const dataUrl = await readFileAsDataURL(file)
          const compressed = await compressImage(dataUrl)
          if (webuiUploadEnabled) {
            const uploaded = await ipc.uploadWebUIFile(file)
            addImageAttachment(compressed, file.name || 'image.png', uploaded.path)
          } else {
            addImageAttachment(compressed, file.name || 'image.png')
          }
        } catch {
          alert(t('chat.attachReadFailed'))
        }
      }
      for (const { name, path } of pathFiles) {
        addFileAttachment(name, path)
      }
      if (remoteFiles.length > 0) await handleRemoteFiles(remoteFiles)
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
    if (webuiUploadEnabled) {
      void handleRemoteFiles(files)
      return
    }
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

  /** 输入框 onChange：空输入框输入 "/" 打开命令菜单；菜单打开时 "/" 后文本即过滤词；
   *  删掉 "/" 或改为普通文本则关闭菜单 */
  const handleTextareaChange = (e: ReactChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setContent(v)
    if (v.startsWith('/')) {
      if (!showCommandMenu) {
        setShowCommandMenu(true)
        setCommandHighlight(0)
      }
    } else if (showCommandMenu) {
      closeCommandMenu()
    }
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // 命令菜单打开时：↑↓ 导航、Enter 选中、Esc 关闭（优先于发送逻辑）
    if (showCommandMenu && commandFlatCount > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommandHighlight((commandSafeHighlight + 1) % commandFlatCount)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandHighlight((commandSafeHighlight - 1 + commandFlatCount) % commandFlatCount)
        return
      }
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (commandSafeHighlight < filteredCommands.length) {
          selectCommandItem('command', filteredCommands[commandSafeHighlight].id)
        } else if (commandSafeHighlight < filteredCommands.length + filteredSkills.length) {
          selectCommandItem('skill', filteredSkills[commandSafeHighlight - filteredCommands.length].id)
        } else {
          selectCommandItem('mcp', filteredMcp[commandSafeHighlight - filteredCommands.length - filteredSkills.length].id)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeCommandMenu()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
    // 空输入框按 Backspace：先移除任务工作流芯片 / 压缩芯片
    if (e.key === 'Backspace' && !content) {
      if (taskMode) {
        e.preventDefault()
        setTaskMode(null)
      } else if (compactMode) {
        e.preventDefault()
        setCompactMode(false)
      }
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
    if (isWebUIMode) {
      const homeDir = await ipc.getHomeDir().catch(() => '')
      const candidates = [effectiveWorkDir, ...recentsFolders, homeDir].filter((p): p is string => Boolean(p))
      setRemoteFolderPath('')
      setRemoteFolderEntries([])
      setRemoteFolderPickerOpen(true)
      for (const candidate of candidates) {
        try {
          await loadRemoteFolder(candidate)
          return
        } catch {
          // Try the next known host directory.
        }
      }
      setRemoteFolderLoading(false)
      alert(t('chat.folderSelectionFailed'))
      return
    }
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

  const loadRemoteFolder = async (dir: string) => {
    if (!dir) return
    setRemoteFolderLoading(true)
    try {
      const entries = await ipc.listDir(dir)
      setRemoteFolderPath(dir)
      setRemoteFolderEntries(entries.filter((entry) => entry.isDirectory).sort((a, b) => a.name.localeCompare(b.name)))
    } finally {
      setRemoteFolderLoading(false)
    }
  }

  const selectRemoteFolder = () => {
    if (!remoteFolderPath) return
    setRemoteFolderPickerOpen(false)
    requestSetFolder(remoteFolderPath)
  }

  const navigateRemoteParent = () => {
    const parent = parentFolderPath(remoteFolderPath)
    if (parent && parent !== remoteFolderPath) void loadRemoteFolder(parent).catch(() => {})
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
      if (approvalMenuRef.current && !approvalMenuRef.current.contains(e.target as Node)) {
        setShowApprovalMenu(false)
      }
      // 命令菜单锚定在整个输入框上：框内点击（输入过滤词等）不关闭，框外点击关闭
      if (inputBoxRef.current && !inputBoxRef.current.contains(e.target as Node)) {
        if (showCommandMenu) {
          setShowCommandMenu(false)
          setContent((v) => (v.trim() === '/' ? '' : v))
        }
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
    if (showModelMenu || showApprovalMenu || showCommandMenu || showSkillMenu || showThinkingMenu || showFolderPopover) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showModelMenu, showApprovalMenu, showCommandMenu, showSkillMenu, showThinkingMenu, showFolderPopover])

  useEffect(() => {
    if (!showModelMenu && !showApprovalMenu && !showCommandMenu && !showSkillMenu && !showThinkingMenu && !showFolderPopover) return

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const trigger = showModelMenu
        ? modelTriggerRef.current
        : showApprovalMenu
          ? approvalTriggerRef.current
          : showCommandMenu
            ? textareaRef.current
            : showSkillMenu
              ? skillTriggerRef.current
              : showThinkingMenu
                ? thinkingTriggerRef.current
                : folderTriggerRef.current
      event.stopPropagation()
      setShowModelMenu(false)
      setShowApprovalMenu(false)
      setShowCommandMenu(false)
      setShowSkillMenu(false)
      setShowThinkingMenu(false)
      setShowFolderPopover(false)
      if (showCommandMenu) setContent((v) => (v.trim() === '/' ? '' : v))
      requestAnimationFrame(() => trigger?.focus())
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [showModelMenu, showApprovalMenu, showCommandMenu, showSkillMenu, showThinkingMenu, showFolderPopover])

  // 审批档位元数据（图标 + 标签；完全访问用警告色，对齐 TRAE）
  const approvalMode = settings.approvalMode
  const approvalMeta = {
    manual: { icon: Hand, label: t('chat.approvalManualTitle') },
    auto: { icon: ShieldCheck, label: t('chat.approvalAutoTitle') },
    full: { icon: TriangleAlert, label: t('chat.approvalFullTitle') },
  }[approvalMode]
  const ApprovalIcon = approvalMeta.icon
  // 任务工作流芯片配色（spec=info / plan=primary / goal=tertiary）
  const taskChipClass = taskMode === 'spec'
    ? (vibe ? 'bg-md-info/25 text-md-info' : 'bg-md-info/15 text-md-info')
    : taskMode === 'plan'
      ? (vibe ? 'bg-md-primary/25 text-md-primary' : 'bg-md-primary/15 text-md-primary')
      : (vibe ? 'bg-md-tertiary/25 text-md-tertiary' : 'bg-md-tertiary/15 text-md-tertiary')
  // 压缩芯片配色（primary，与 Plan 同色系）
  const compactChipClass = vibe ? 'bg-md-primary/25 text-md-primary' : 'bg-md-primary/15 text-md-primary'

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
      : 'px-4 py-3 max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-dark-surfaceDim border-t border-dark-onSurfaceVariant/10'
  // 虚拟键盘弹出时抬高输入区（压缩消息列表），避免输入框被遮挡
  const outerStyle = !isWelcome && isMobile && kbOffset > 0 ? { paddingBottom: kbOffset } : undefined

  // Input box: wider and more rounded
  const boxMaxWidth = isWelcome ? 'max-w-3xl' : 'max-w-5xl'

  // Box class: vibe uses liquid glass（relative 供 "/" 命令菜单 absolute 锚定）
  const boxClass = vibe
    ? `relative flex flex-col ${boxMaxWidth} mx-auto liquid-glass rounded-[28px] px-5 py-3.5 gap-2 focus-within:border-white/40 transition-colors`
    : `relative flex flex-col ${boxMaxWidth} mx-auto bg-dark-surfaceContainerHigh rounded-[28px] px-5 py-3.5 gap-2 border border-dark-onSurfaceVariant/8 focus-within:border-md-primary/30 transition-colors`

  return (
    <div className={outerClass} style={outerStyle}>
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
        ref={inputBoxRef}
        className={`${boxClass} ${dragging ? 'ring-2 ring-md-primary/50' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isWebUIMode && (
          <input
            ref={remoteFileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleRemoteFileInputChange}
            aria-hidden="true"
          />
        )}
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

        {/* Textarea - top area（左侧可带任务工作流芯片，如 Goal；或压缩芯片，点击芯片可移除） */}
        <div className="flex items-start gap-2">
          {taskMode && (() => {
            const chipMeta = TASK_COMMANDS.find((c) => c.id === taskMode)
            if (!chipMeta) return null
            const ChipIcon = chipMeta.icon
            return (
              <button
                type="button"
                onClick={() => setTaskMode(null)}
                title={t('chat.taskChipRemove')}
                className={`flex items-center gap-1.5 mt-1 px-2 py-0.5 rounded-md3-sm text-sm font-medium flex-shrink-0 transition-colors ${taskChipClass}`}
              >
                <ChipIcon size={14} />
                <span>{chipMeta.name}</span>
                <X size={11} className="opacity-50" />
              </button>
            )
          })()}
          {compactMode && (
            <button
              type="button"
              onClick={() => setCompactMode(false)}
              title={t('chat.compactChipRemove')}
              className={`flex items-center gap-1.5 mt-1 px-2 py-0.5 rounded-md3-sm text-sm font-medium flex-shrink-0 transition-colors ${compactChipClass}`}
            >
              <COMPACT_COMMAND.icon size={14} />
              <span>{COMPACT_COMMAND.name}</span>
              <X size={11} className="opacity-50" />
            </button>
          )}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onPaste={handlePaste}
            disabled={isStreaming || isCompacting}
            aria-label={t('chat.messageInputAria')}
            placeholder={isCompacting
              ? t('chat.compactingContext')
              : compactMode
                ? t('chat.compactPlaceholder')
                : taskMode
                  ? t('chat.taskPlaceholder')
                  : vibe
                    ? t('chat.placeholderVibe')
                    : (effectiveWorkDir ? t('chat.placeholderWorkDir', { name: effectiveWorkDir.split(/[/\\]/).pop() }) : t('chat.placeholderDefault'))}
            rows={1}
            className={`w-full bg-transparent text-sm max-md:text-base resize-none outline-none min-h-[20px] max-md:min-h-6 max-h-[200px] py-1 ${
              vibe
                ? 'text-white/90 placeholder-white/50'
                : 'text-dark-onSurface placeholder-dark-onSurfaceVariant/40'
            }`}
          />
        </div>

        {/* "/" 命令菜单：任务工作流（Spec/Plan/Goal）+ 已安装技能，锚定输入框上方 */}
        {showCommandMenu && (
          <>
            <div
              className="max-md:block hidden fixed inset-0 z-[64] bg-black/55 animate-fade-in"
              onClick={closeCommandMenu}
              aria-hidden
            />
            <div
              ref={commandMenuRef}
              className={`absolute bottom-full left-0 right-0 mb-1 rounded-md3-md border shadow-2xl z-50 overflow-y-auto overscroll-contain max-h-[min(50dvh,300px)]
                max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:left-auto max-md:right-auto max-md:mb-0 max-md:w-full max-md:max-h-[60dvh]
                max-md:rounded-t-2xl max-md:rounded-b-none max-md:z-[66]
                max-md:pb-[calc(env(safe-area-inset-bottom)+8px)] ${
                vibe
                  ? 'bg-black/60 border-white/15 backdrop-blur-2xl text-white'
                  : 'bg-dark-surfaceContainerHighest border-dark-onSurfaceVariant/15 text-dark-onSurface'
              }`}
            >
              <div className="hidden max-md:flex justify-center pt-2 pb-1 flex-shrink-0 sticky top-0" aria-hidden>
                <div className={`w-10 h-1 rounded-full ${vibe ? 'bg-white/25' : 'bg-dark-onSurfaceVariant/25'}`} />
              </div>
              {/* 命令 section */}
              {filteredCommands.length > 0 && (
                <>
                  <div className={`px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/40'}`}>
                    {t('chat.cmdSection')}
                  </div>
                  {filteredCommands.map((c, i) => {
                    const highlighted = i === commandSafeHighlight
                    const CmdIcon = c.icon
                    return (
                      <button
                        type="button"
                        key={c.id}
                        onMouseEnter={() => setCommandHighlight(i)}
                        onClick={() => selectCommandItem('command', c.id)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 max-md:py-3 text-left transition-colors ${
                          highlighted ? (vibe ? 'bg-white/10' : 'bg-dark-surfaceContainerHigh') : ''
                        }`}
                      >
                        <CmdIcon size={16} className="flex-shrink-0 text-md-primary" />
                        <span className={`text-sm font-medium flex-shrink-0 ${vibe ? 'text-white/90' : 'text-dark-onSurface'}`}>{c.name}</span>
                        <span className={`text-xs truncate flex-1 ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/60'}`}>{t(c.descKey)}</span>
                        {highlighted && <span className={`text-xs flex-shrink-0 ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/40'}`}>↵</span>}
                      </button>
                    )
                  })}
                </>
              )}
              {/* 技能 section（对齐 TRAE 的「插件」区：列出已安装技能，点击切换激活态） */}
              <div className={`px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/40'}`}>
                {t('chat.skillsSection')}
              </div>
              {filteredSkills.length === 0 ? (
                <div className={`px-3 py-3 text-xs text-center ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/50'}`}>
                  {skills.length === 0 ? t('chat.noSkills') : t('chat.cmdNoMatch')}
                </div>
              ) : (
                filteredSkills.map((skill, j) => {
                  const flatIndex = filteredCommands.length + j
                  const highlighted = flatIndex === commandSafeHighlight
                  const isActive = sessionSkillIds.includes(skill.id)
                  return (
                    <button
                      type="button"
                      key={skill.id}
                      onMouseEnter={() => setCommandHighlight(flatIndex)}
                      onClick={() => selectCommandItem('skill', skill.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 max-md:py-3 text-left transition-colors ${
                        highlighted ? (vibe ? 'bg-white/10' : 'bg-dark-surfaceContainerHigh') : ''
                      }`}
                    >
                      <span className="flex-shrink-0 text-base leading-none">{skill.icon}</span>
                      <span className="flex-1 min-w-0">
                        <span className={`block text-sm font-medium truncate ${isActive ? 'text-md-primary' : vibe ? 'text-white/90' : 'text-dark-onSurface'}`}>{skill.name}</span>
                        {skill.description && (
                          <span className={`block text-xs truncate ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/60'}`}>{skill.description}</span>
                        )}
                      </span>
                      {isActive && <Check size={14} className="flex-shrink-0 text-md-primary" />}
                    </button>
                  )
                })
              )}
              {/* MCP section：列出已配置的 MCP 服务器，点击切换启停（状态点：绿=已连接 黄=连接中 红=出错 灰=停用） */}
              <div className={`px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/40'}`}>
                {t('chat.mcpSection')}
              </div>
              {filteredMcp.length === 0 ? (
                <div className={`px-3 py-3 text-xs text-center ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/50'}`}>
                  {mcpServers.length === 0 ? t('chat.noMcpServers') : t('chat.cmdNoMatch')}
                </div>
              ) : (
                filteredMcp.map((server, k) => {
                  const flatIndex = filteredCommands.length + filteredSkills.length + k
                  const highlighted = flatIndex === commandSafeHighlight
                  const status = mcpStatuses.find((s) => s.id === server.id)
                  const state = status?.state ?? (server.enabled ? 'connecting' : 'disabled')
                  const dotCls =
                    state === 'connected' ? 'bg-emerald-500'
                    : state === 'connecting' ? 'bg-amber-500'
                    : state === 'error' ? 'bg-red-500'
                    : vibe ? 'bg-white/25' : 'bg-dark-onSurfaceVariant/30'
                  return (
                    <button
                      type="button"
                      key={server.id}
                      onMouseEnter={() => setCommandHighlight(flatIndex)}
                      onClick={() => selectCommandItem('mcp', server.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 max-md:py-3 text-left transition-colors ${
                        highlighted ? (vibe ? 'bg-white/10' : 'bg-dark-surfaceContainerHigh') : ''
                      }`}
                    >
                      <span className="flex-shrink-0 text-md-primary"><Plug size={16} /></span>
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotCls}`} aria-label={state} />
                      <span className="flex-1 min-w-0">
                        <span className={`block text-sm font-medium truncate ${server.enabled ? 'text-md-primary' : vibe ? 'text-white/90' : 'text-dark-onSurface'}`}>{server.name}</span>
                        <span className={`block text-xs truncate ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/60'}`}>
                          {status && status.toolCount > 0 ? t('chat.mcpToolCount', { count: status.toolCount }) : t(`chat.mcpState.${state}`)}
                        </span>
                      </span>
                      {server.enabled && <Check size={14} className="flex-shrink-0 text-md-primary" />}
                    </button>
                  )
                })
              )}
              <div className={`border-t mt-1 ${vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'}`}>
                <button
                  type="button"
                  onClick={() => { setShowCommandMenu(false); setContent((v) => (v.trim() === '/' ? '' : v)); setShowSkillStore(true) }}
                  className={`w-full flex items-center gap-2 px-3 py-2 max-md:py-3.5 text-sm transition-colors ${
                    vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainerHigh'
                  }`}
                >
                  <Store size={14} />
                  <span>{t('chat.getSkills')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCommandMenu(false); setContent((v) => (v.trim() === '/' ? '' : v)); settings.updateSettings({ showSettings: true, pendingSettingsTab: 'mcp' }) }}
                  className={`w-full flex items-center gap-2 px-3 py-2 max-md:py-3.5 text-sm transition-colors ${
                    vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainerHigh'
                  }`}
                >
                  <Settings2 size={14} />
                  <span>{t('chat.manageMcp')}</span>
                </button>
              </div>
            </div>
          </>
        )}

        {/* Bottom button row - inside the box */}
        <div className="flex items-center gap-1 flex-wrap">
          {/* Attach (images / files) button */}
          <button
            type="button"
            onClick={openAttachPicker}
            disabled={attachSelecting}
            className={`h-8 max-md:h-11 max-md:px-3 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors disabled:opacity-40 ${
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

          {/* "/" 命令菜单按钮：打开工作流命令 + 技能选择列表（也可在空输入框直接输入 / 触发） */}
          <button
            type="button"
            onClick={openCommandMenu}
            disabled={isStreaming}
            className={`h-8 max-md:h-11 max-md:px-3 flex items-center px-2 flex-shrink-0 rounded-md3-sm transition-colors disabled:opacity-40 ${
              showCommandMenu
                ? vibe
                  ? 'bg-white/15 text-white/90'
                  : 'bg-dark-surfaceContainer text-md-primary'
                : vibe
                  ? 'hover:bg-white/15 text-white/70'
                  : 'hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
            }`}
            title={t('chat.commandMenuAria')}
            aria-label={t('chat.commandMenuAria')}
            aria-expanded={showCommandMenu}
          >
            <Slash size={15} />
          </button>

          {/* Working folder button + popover */}
          <div className="relative" ref={folderPopoverRef}>
            <button
              ref={folderTriggerRef}
              type="button"
              onClick={() => setShowFolderPopover((v) => !v)}
              disabled={folderSelecting}
              className={`h-8 max-md:h-11 max-md:px-3 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors disabled:opacity-40 ${
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
              <>
                <div
                  className="max-md:block hidden fixed inset-0 z-[64] bg-black/55 animate-fade-in"
                  onClick={() => setShowFolderPopover(false)}
                  aria-hidden
                />
                <div id="chat-folder-menu" className={`absolute bottom-full left-0 mb-1 w-72 rounded-md3-md border shadow-2xl z-40 overflow-hidden animate-fade-in
                  max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:left-auto max-md:mb-0 max-md:w-full max-md:max-h-[72dvh] max-md:overflow-y-auto max-md:overscroll-contain
                  max-md:rounded-t-2xl max-md:rounded-b-none max-md:z-[66]
                  max-md:pb-[calc(env(safe-area-inset-bottom)+8px)] ${
                  vibe
                    ? 'bg-white/10 border-white/15 backdrop-blur-2xl text-white'
                    : 'bg-dark-surfaceContainer border-dark-onSurfaceVariant/15 text-dark-onSurface'
                }`}>
                  <div className="hidden max-md:flex justify-center pt-2 pb-1 flex-shrink-0" aria-hidden>
                    <div className={`w-10 h-1 rounded-full ${vibe ? 'bg-white/25' : 'bg-dark-onSurfaceVariant/25'}`} />
                  </div>
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
                    <div className="max-h-56 overflow-y-auto overscroll-contain pb-1">
                      {recentsFolders.map((p) => {
                        const isCurrent = effectiveWorkDir && comparableFolderPath(p) === comparableFolderPath(effectiveWorkDir)
                        return (
                          <button
                            type="button"
                            key={p}
                            onClick={() => requestSetFolder(p)}
                            className={`w-full px-3 py-1.5 max-md:py-3 mx-1 rounded-md3-sm flex items-center gap-2 text-xs max-md:text-sm text-left transition-colors ${
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
                      className={`w-full px-3 py-1.5 max-md:py-3 rounded-md3-sm flex items-center gap-2 text-xs max-md:text-sm transition-colors ${
                        vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh'
                      }`}
                    >
                      <FolderPlus size={12} className="opacity-70" />
                      <span>{hostFolderEnabled ? t('chat.folderBrowseHost') : t('chat.folderSelect')}</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Approval mode dropdown（Agent 操作审批：手动 / 自动 / 完全访问，对齐 TRAE） */}
          <div className="relative" ref={approvalMenuRef}>
            <button
              ref={approvalTriggerRef}
              type="button"
              onClick={() => setShowApprovalMenu((v) => !v)}
              className={`h-8 max-md:h-11 max-md:px-3 flex items-center gap-1.5 px-2.5 flex-shrink-0 rounded-md3-sm transition-colors ${
                approvalMode === 'full'
                  ? vibe
                    ? 'bg-md-warning/25 text-md-warning hover:bg-md-warning/35'
                    : 'bg-md-warning/15 text-md-warning hover:bg-md-warning/25'
                  : vibe
                    ? 'bg-white/10 text-white/80 hover:bg-white/15'
                    : 'bg-dark-surfaceContainerHighest/70 text-dark-onSurface hover:bg-dark-surfaceContainerHighest'
              }`}
              aria-label={t('chat.approvalAria')}
              aria-controls="chat-approval-menu"
              aria-expanded={showApprovalMenu}
            >
              <ApprovalIcon size={14} />
              <span className="text-xs font-medium">{approvalMeta.label}</span>
              <ChevronDown size={12} className={`transition-transform ${showApprovalMenu ? 'rotate-180' : ''}`} />
            </button>
            {showApprovalMenu && (
              <>
                <div
                  className="max-md:block hidden fixed inset-0 z-[65] bg-black/55 animate-fade-in"
                  onClick={() => setShowApprovalMenu(false)}
                  aria-hidden
                />
                <div id="chat-approval-menu" className={`absolute bottom-full mb-1 left-0 w-80 max-md:w-full rounded-md3-md overflow-hidden z-50 py-1
                  max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:left-auto max-md:mb-0
                  max-md:rounded-t-2xl max-md:rounded-b-none max-md:border-t max-md:border-dark-onSurfaceVariant/15
                  max-md:z-[66] max-md:pb-[calc(env(safe-area-inset-bottom)+8px)] ${
                  vibe
                    ? 'bg-black/60 border-white/15 backdrop-blur-2xl text-white'
                    : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
                }`}>
                  <div className="hidden max-md:flex justify-center pt-2 pb-1 flex-shrink-0" aria-hidden>
                    <div className={`w-10 h-1 rounded-full ${vibe ? 'bg-white/25' : 'bg-dark-onSurfaceVariant/25'}`} />
                  </div>
                  {/* 弹层标题 + 了解更多 */}
                  <div className="flex items-center justify-between px-3 pt-2 pb-1.5">
                    <span className={`text-xs ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/70'}`}>{t('chat.approvalHeader')}</span>
                    <a
                      href="https://github.com/XMZF-vAI/clerkbox#readme"
                      target="_blank"
                      rel="noreferrer"
                      className={`text-xs underline underline-offset-2 transition-opacity hover:opacity-100 ${
                        vibe ? 'text-white/60 opacity-80' : 'text-dark-onSurfaceVariant/80 opacity-90'
                      }`}
                    >
                      {t('chat.approvalLearnMore')}
                    </a>
                  </div>
                  {([
                    { id: 'manual' as const, icon: Hand, title: t('chat.approvalManualTitle'), desc: t('chat.approvalManualDesc') },
                    { id: 'auto' as const, icon: ShieldCheck, title: t('chat.approvalAutoTitle'), desc: t('chat.approvalAutoDesc') },
                    { id: 'full' as const, icon: TriangleAlert, title: t('chat.approvalFullTitle'), desc: t('chat.approvalFullDesc') },
                  ]).map((item) => {
                    const active = approvalMode === item.id
                    const isFull = item.id === 'full'
                    const ItemIcon = item.icon
                    return (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => { settings.updateSettings({ approvalMode: item.id }); setShowApprovalMenu(false) }}
                        className={`w-full flex items-start gap-2.5 px-3 py-2.5 max-md:py-3.5 text-left transition-colors ${
                          active
                            ? vibe ? 'bg-white/10' : 'bg-dark-surfaceContainerHigh'
                            : vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh'
                        }`}
                      >
                        <ItemIcon size={16} className={`mt-0.5 flex-shrink-0 ${isFull ? 'text-md-warning' : vibe ? 'text-white/80' : 'text-dark-onSurfaceVariant'}`} />
                        <span className="flex-1 min-w-0">
                          <span className={`block text-sm font-medium ${isFull ? 'text-md-warning' : vibe ? 'text-white/90' : 'text-dark-onSurface'}`}>
                            {item.title}
                          </span>
                          <span className={`block text-xs mt-0.5 ${isFull ? 'text-md-warning/80' : vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/50'}`}>
                            {item.desc}
                          </span>
                        </span>
                        {active && <Check size={14} className="mt-1 flex-shrink-0 text-md-primary" />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          {/* Thinking mode + reasoning effort */}
          <div className="relative flex items-center" ref={thinkingMenuRef}>
            <button
              type="button"
              onClick={toggleThinking}
              disabled={!thinkingSupported}
              className={`h-8 max-md:h-11 flex items-center gap-1 px-2 flex-shrink-0 rounded-l-md3-sm transition-colors ${
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
                className={`h-8 max-md:h-11 flex items-center gap-1 px-1.5 flex-shrink-0 rounded-r-md3-sm transition-colors ${
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
              <>
                <div
                  className="max-md:block hidden fixed inset-0 z-[65] bg-black/55 animate-fade-in"
                  onClick={() => setShowThinkingMenu(false)}
                  aria-hidden
                />
                <div id="chat-reasoning-menu" className={`absolute bottom-full mb-1 left-0 w-64 p-3 rounded-md3-md z-50
                  max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:left-auto max-md:mb-0 max-md:w-full max-md:p-4
                  max-md:rounded-t-2xl max-md:rounded-b-none max-md:border-t max-md:border-dark-onSurfaceVariant/15
                  max-md:z-[66] max-md:pb-[calc(env(safe-area-inset-bottom)+16px)] ${
                  vibe ? 'liquid-glass-strong' : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
                }`}>
                  <div className="hidden max-md:flex justify-center pt-0 pb-3 -mt-1 flex-shrink-0" aria-hidden>
                    <div className={`w-10 h-1 rounded-full ${vibe ? 'bg-white/25' : 'bg-dark-onSurfaceVariant/25'}`} />
                  </div>
                  <div className="flex items-center justify-between mb-2 text-xs max-md:text-sm">
                    <span>{t('chat.thinkingLevel')}</span>
                    <button
                      type="button"
                      onClick={toggleThinking}
                      className={`px-2 py-0.5 max-md:py-1.5 max-md:px-3 rounded-full text-[10px] max-md:text-xs ${settings.enableThinking ? 'bg-md-tertiary/20 text-md-tertiary' : 'bg-dark-surfaceContainer text-dark-onSurfaceVariant'}`}
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
                    className="w-full accent-md-tertiary max-md:h-2"
                  />
                  <div className="mt-1 flex justify-between text-[9px] max-md:text-xs text-dark-onSurfaceVariant/70">
                    {reasoningEfforts.map((effort) => <span key={effort} className="capitalize">{effort}</span>)}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Skill selector dropdown */}
          <div className="relative" ref={skillMenuRef}>
            <button
              ref={skillTriggerRef}
              type="button"
              onClick={() => setShowSkillMenu(!showSkillMenu)}
              className={`h-8 max-md:h-11 max-md:px-3 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors ${
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
              <>
                <div
                  className="max-md:block hidden fixed inset-0 z-[65] bg-black/55 animate-fade-in"
                  onClick={() => setShowSkillMenu(false)}
                  aria-hidden
                />
                <div id="chat-skill-menu" className={`absolute bottom-full mb-1 left-0 w-64 rounded-md3-md overflow-hidden z-50
                  max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:left-auto max-md:mb-0 max-md:w-full max-md:max-h-[72dvh]
                  max-md:rounded-t-2xl max-md:rounded-b-none max-md:border-t max-md:border-dark-onSurfaceVariant/15
                  max-md:z-[66] max-md:pb-[calc(env(safe-area-inset-bottom)+8px)] ${
                  vibe
                    ? 'liquid-glass-strong'
                    : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
                }`}>
                  <div className="hidden max-md:flex justify-center pt-2 pb-1 flex-shrink-0" aria-hidden>
                    <div className={`w-10 h-1 rounded-full ${vibe ? 'bg-white/25' : 'bg-dark-onSurfaceVariant/25'}`} />
                  </div>
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
                    <div className="max-h-56 max-md:max-h-none overflow-y-auto overscroll-contain">
                      {skills.map((skill) => {
                        const isActive = sessionSkillIds.includes(skill.id)
                        return (
                          <button
                            type="button"
                            key={skill.id}
                            onClick={() => toggleSessionSkill(skill.id, effectiveWorkDir || undefined)}
                            className={`w-full flex items-center gap-2 px-3 py-2 max-md:py-3 text-sm transition-colors ${
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
                                <div className={`text-[10px] max-md:text-xs truncate ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/40'}`}>
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
                      className={`w-full flex items-center gap-2 px-3 py-2 max-md:py-3.5 text-sm transition-colors ${
                        vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainerHigh'
                      }`}
                    >
                      <Store size={14} />
                      <span>{t('chat.getSkills')}</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Model selector dropdown */}
          <div className="relative" ref={modelMenuRef}>
            <button
              ref={modelTriggerRef}
              type="button"
              onClick={() => setShowModelMenu(!showModelMenu)}
              className={`h-8 max-md:h-11 max-md:px-3 flex items-center gap-1 px-2 flex-shrink-0 rounded-md3-sm transition-colors ${
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
              <>
                {/* 移动端遮罩：点击关闭 */}
                <div
                  className="max-md:block hidden fixed inset-0 z-[65] bg-black/55 animate-fade-in"
                  onClick={() => setShowModelMenu(false)}
                  aria-hidden
                />
                <div id="chat-model-menu" className={`absolute bottom-full mb-1 left-0 w-56 rounded-md3-md overflow-hidden z-50 py-1 max-h-64 overflow-y-auto
                  max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:left-auto max-md:mb-0 max-md:w-full max-md:max-h-[72dvh]
                  max-md:rounded-t-2xl max-md:rounded-b-none max-md:border-t max-md:border-dark-onSurfaceVariant/15
                  max-md:z-[66] max-md:pb-[calc(env(safe-area-inset-bottom)+8px)] ${
                  vibe
                    ? 'liquid-glass-strong'
                    : 'bg-dark-surfaceContainerHighest border border-dark-onSurfaceVariant/10 shadow-lg'
                }`}>
                  {/* 移动端拖动指示条 */}
                  <div className="hidden max-md:flex justify-center pt-2 pb-1 flex-shrink-0" aria-hidden>
                    <div className={`w-10 h-1 rounded-full ${vibe ? 'bg-white/25' : 'bg-dark-onSurfaceVariant/25'}`} />
                  </div>
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
                          className={`sticky top-0 z-10 w-full flex items-center gap-1.5 px-3 py-1.5 max-md:py-3 text-[10px] max-md:text-xs font-semibold uppercase tracking-wide backdrop-blur-sm transition-colors ${
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
                              className={`w-full text-left pl-7 pr-3 py-2 max-md:py-3.5 max-md:pl-5 transition-colors ${
                                active
                                  ? vibe ? 'text-md-primary bg-md-primary/10' : 'text-md-primary bg-md-primary/5'
                                  : vibe ? 'text-white/90 hover:bg-white/10' : 'text-dark-onSurface hover:bg-dark-surfaceContainer'
                              }`}
                            >
                              <div className="text-xs max-md:text-[15px] font-medium truncate">{m.label || m.id}</div>
                              {m.label && (
                                <div className={`text-[10px] max-md:text-xs truncate mt-0.5 ${active ? 'text-md-primary/70' : vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/70'}`}>
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
                  className={`w-full flex items-center gap-2 px-3 py-2 max-md:py-3.5 text-xs max-md:text-sm transition-colors ${
                    vibe ? 'text-md-primary hover:bg-white/10' : 'text-md-primary hover:bg-md-primary/10'
                  }`}
                >
                  <Plus size={13} /> {t('chat.customModel')}
                </button>
                </div>
              </>
            )}
          </div>

          {/* Spacer to push send button to the right */}
          <div className="flex-1" />

          {/* Send / Stop button */}
          <button
            type="button"
            onClick={isStreaming ? onStop : handleSend}
            disabled={isCompacting || (!isStreaming && !compactMode && !content.trim() && attachments.length === 0)}
            aria-label={isStreaming ? t('chat.stopResponseAria') : t('chat.sendMessageAria')}
            className={`h-9 w-9 max-md:h-12 max-md:w-12 flex-shrink-0 flex items-center justify-center rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              isStreaming
                ? 'bg-md-error text-md-onError hover:bg-md-error/90'
                : vibe
                  ? 'bg-white/25 text-white hover:bg-white/35'
                  : 'bg-md-primary text-md-onPrimary hover:bg-md-primary/90'
            }`}
          >
            {isCompacting
              ? <Loader2 size={isMobile ? 18 : 14} className="animate-spin" />
              : isStreaming
                ? <Square size={isMobile ? 18 : 14} />
                : <Send size={isMobile ? 20 : 16} />}
          </button>
        </div>
      </div>

      {remoteFolderPickerOpen && (
        <>
          <div className="fixed inset-0 z-[70] bg-black/55 animate-fade-in" onClick={() => setRemoteFolderPickerOpen(false)} aria-hidden />
          <div className={`fixed z-[71] inset-x-4 top-1/2 -translate-y-1/2 max-w-lg mx-auto rounded-md3-md border shadow-2xl overflow-hidden animate-fade-in ${
            vibe ? 'bg-white/10 border-white/15 backdrop-blur-2xl text-white' : 'bg-dark-surfaceContainer border-dark-onSurfaceVariant/15 text-dark-onSurface'
          }`} role="dialog" aria-modal="true" aria-label={t('chat.folderBrowseHost')}>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-dark-onSurfaceVariant/10">
              <button type="button" onClick={navigateRemoteParent} disabled={!parentFolderPath(remoteFolderPath) || remoteFolderLoading} className="p-1.5 rounded-md3-sm hover:bg-dark-surfaceContainerHigh disabled:opacity-30" title={t('chat.folderParent')} aria-label={t('chat.folderParent')}>
                <ChevronDown size={15} className="rotate-90" />
              </button>
              <span className="text-xs truncate flex-1" title={remoteFolderPath}>{remoteFolderPath || t('chat.folderNone')}</span>
              <button type="button" onClick={() => setRemoteFolderPickerOpen(false)} className="p-1.5 max-md:p-3 rounded-md3-sm hover:bg-dark-surfaceContainerHigh" title={t('common.close')} aria-label={t('common.close')}>
                <X size={15} />
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {remoteFolderLoading ? (
                <div className="px-3 py-6 text-center text-xs opacity-60">{t('chat.folderLoading')}</div>
              ) : remoteFolderEntries.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs opacity-60">{t('chat.folderNoSubfolders')}</div>
              ) : (
                remoteFolderEntries.map((entry) => {
                  const childPath = appendFolderPath(remoteFolderPath, entry.name)
                  return (
                    <button key={childPath} type="button" onClick={() => void loadRemoteFolder(childPath).catch(() => {})} className="w-full flex items-center gap-2 px-3 py-2 rounded-md3-sm text-left text-xs hover:bg-dark-surfaceContainerHigh">
                      <FolderOpen size={14} className="text-md-info flex-shrink-0" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  )
                })
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-dark-onSurfaceVariant/10">
              <button type="button" onClick={() => setRemoteFolderPickerOpen(false)} className="px-3 py-1.5 text-xs rounded-md3-sm hover:bg-dark-surfaceContainerHigh">{t('common.cancel')}</button>
              <button type="button" onClick={selectRemoteFolder} disabled={!remoteFolderPath || remoteFolderLoading} className="px-3 py-1.5 text-xs rounded-md3-sm bg-md-primary text-md-onPrimary hover:bg-md-primary/90 disabled:opacity-40">{t('chat.folderUseThis')}</button>
            </div>
          </div>
        </>
      )}

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
