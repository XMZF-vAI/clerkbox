import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Search,
  Download,
  Check,
  Trash2,
  Star,
  ArrowLeft,
  Zap,
  Store,
  ExternalLink,
  Loader2,
  TrendingUp,
  Upload,
  FileArchive,
  X,
  FileText,
  Info,
  Package,
  SearchX,
  AlertTriangle,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  Plug,
  RefreshCw,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSkillsStore } from '../../stores/skills-store'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useMcpStore } from '../../stores/mcp-store'
import { ipc } from '../../lib/ipc-client'
import type { SkillsMPSkill, SkillDefinition } from '../../types/skills'
import type { McpMarketServer, McpServerConfig } from '../../types/ipc'

/**
 * Source badge metadata maps an installation source to its visual treatment.
 */
const SOURCE_BADGE: Record<string, { labelKey: string; className: string }> = {
  online: { labelKey: 'skillstore.sourceCocoLoop', className: 'bg-md-info/15 text-md-info' },
  custom: { labelKey: 'skillstore.sourceCustom', className: 'bg-md-tertiary/15 text-md-tertiary' },
  'global-clerkbox': { labelKey: 'skillstore.sourceGlobal', className: 'bg-md-primary/15 text-md-primary' },
  'project-clerkbox': { labelKey: 'skillstore.sourceProject', className: 'bg-md-secondary/15 text-md-secondary' },
  'global-claude': { labelKey: 'skillstore.sourceGlobal', className: 'bg-md-success/15 text-md-success' },
  'project-claude': { labelKey: 'skillstore.sourceProject', className: 'bg-cyan-500/15 text-cyan-300' },
}

/**
 * BSS 安全等级 → 视觉样式映射（CocoLoop Hub 标识：S+/S/A/B/C/D）。
 */
const BSS_LEVEL_BADGE: Record<string, { className: string; label: string }> = {
  'S+': { className: 'bg-emerald-500/15 text-emerald-300', label: 'S+' },
  'S': { className: 'bg-emerald-500/15 text-emerald-300', label: 'S' },
  'A': { className: 'bg-md-success/15 text-md-success', label: 'A' },
  'B': { className: 'bg-md-primary/15 text-md-primary', label: 'B' },
  'C': { className: 'bg-md-warning/15 text-md-warning', label: 'C' },
  'D': { className: 'bg-md-error/15 text-md-error', label: 'D' },
}

/**
 * 详情弹窗目标：online = 商店在线技能（市场元数据），installed = 已安装技能（本地定义）。
 */
type DetailTarget =
  | { kind: 'online'; skill: SkillsMPSkill }
  | { kind: 'installed'; skill: SkillDefinition }

/**
 * 渲染技能图标：严格遵守"严禁 emoji"要求，统一返回 Package SVG。
 * CocoLoop 返回的 emoji 字段一律忽略，确保视觉一致且无 emoji 依赖。
 */
function renderSkillIcon(_icon: string | undefined, size: number = 18, className: string = '') {
  // 严格遵守"严禁 emoji"要求，统一返回 Package SVG，忽略 CocoLoop 返回的 emoji 字段
  return <Package size={size} className={className} />
}

/**
 * Full-page Skill Store that replaces the chat area.
 * Features: recommended skills + search + installed management.
 */
export default function SkillStore() {
  const { t } = useTranslation()
  const {
    skills,
    sessionSkillIds,
    searchResults,
    searchLoading,
    searchQuery,
    searchPage,
    searchTotal,
    searchHasNext,
    recommendedSkills,
    recommendedLoading,
    searchOnlineSkills,
    installOnlineSkill,
    uninstallOnlineSkill,
    loadRecommended,
    installCustomSkill,
  } = useSkillsStore()
  const { sessions, activeSessionId } = useChatStore()
  const { setShowSkillStore } = useUIStore()

  const [query, setQuery] = useState('')
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set())
  const [view, setView] = useState<'home' | 'search'>('home')
  // 已安装技能区块折叠状态：home/search 各自独立，默认展开（首次使用即可见）
  const [installedCollapsedHome, setInstalledCollapsedHome] = useState(false)
  const [installedCollapsedSearch, setInstalledCollapsedSearch] = useState(true)
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [uploadFilePath, setUploadFilePath] = useState<string | null>(null)
  const [uploadFileName, setUploadFileName] = useState<string | null>(null)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  // 在线技能安装失败时的错误提示（显示在主内容区顶部）
  const [installError, setInstallError] = useState<string | null>(null)
  // 技能详情弹窗：online = 商店在线技能，installed = 已安装技能
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null)

  // ── 商店 tab（左侧导航：技能 / MCP 插件；默认技能）──
  const [storeTab, setStoreTab] = useState<'skills' | 'mcp'>('skills')

  // ── MCP 插件市场 ──
  const settings = useSettingsStore()
  const mcpStatuses = useMcpStore((s) => s.statuses)
  const [mcpMarket, setMcpMarket] = useState<McpMarketServer[]>([])
  const [mcpMarketLoading, setMcpMarketLoading] = useState(false)
  const [mcpMarketError, setMcpMarketError] = useState<string | null>(null)
  const [mcpQuery, setMcpQuery] = useState('')
  // 安装弹窗：目标服务器 + 密钥输入 + 测试状态
  const [installTarget, setInstallTarget] = useState<McpMarketServer | null>(null)
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({})
  const [installTesting, setInstallTesting] = useState(false)
  const [installErrorMcp, setInstallErrorMcp] = useState<string | null>(null)
  const [installDone, setInstallDone] = useState<string | null>(null)
  const installDialogRef = useRef<HTMLDivElement>(null)

  /** 检测占位符值（形如 <your-api-key>）：安装前需要用户填写 */
  const isPlaceholderValue = (v: string) => /^<.+>$/.test(v.trim())
  /** 密钥型字段名 → 输入框用密码形态 */
  const isSecretKey = (k: string) => /token|key|secret|password|authorization/i.test(k)

  const loadMcpMarket = useCallback(async () => {
    setMcpMarketLoading(true)
    setMcpMarketError(null)
    try {
      const result = await ipc.mcpSearch()
      if ('servers' in result && Array.isArray(result.servers)) {
        setMcpMarket(result.servers)
      } else {
        setMcpMarketError('error' in result ? result.error : t('mcpstore.loadFailed'))
        setMcpMarket([])
      }
    } catch (e) {
      setMcpMarketError(e instanceof Error ? e.message : String(e))
      setMcpMarket([])
    } finally {
      setMcpMarketLoading(false)
    }
  }, [t])

  // 切到 MCP tab 时首次拉取市场列表
  useEffect(() => {
    if (storeTab === 'mcp' && !mcpMarketLoading && mcpMarket.length === 0 && !mcpMarketError) {
      void loadMcpMarket()
    }
  }, [storeTab, mcpMarket.length, mcpMarketLoading, mcpMarketError, loadMcpMarket])

  // 市场条目是否已安装（按 market-<id> 匹配）
  const isMcpInstalled = (server: McpMarketServer): boolean =>
    (settings.mcpServers ?? []).some((s) => s.id === `market-${server.id}`)

  /** 打开安装预览弹窗：初始化密钥输入框（placeholder 项默认空） */
  const openMcpInstall = (server: McpMarketServer) => {
    setInstallTarget(server)
    setInstallErrorMcp(null)
    setInstallDone(null)
    const initial: Record<string, string> = {}
    const conn = server.connection
    if (conn) {
      for (const [k, v] of Object.entries(conn.env ?? {})) {
        if (isPlaceholderValue(v)) initial[`env.${k}`] = ''
      }
      for (const [k, v] of Object.entries(conn.headers ?? {})) {
        if (isPlaceholderValue(v)) initial[`headers.${k}`] = ''
      }
    }
    setSecretInputs(initial)
  }

  const closeMcpInstall = () => {
    if (installTesting) return
    setInstallTarget(null)
    setSecretInputs({})
    setInstallErrorMcp(null)
    setInstallDone(null)
  }

  /** 确认安装：校验必填 → 测试连接 → 写入配置（settings 变化由 mcp-store 自动同步连接） */
  const confirmMcpInstall = async () => {
    if (!installTarget?.connection || installTesting) return
    const conn = installTarget.connection
    // 未填写的必填项
    const missing = Object.entries(secretInputs).filter(([, v]) => !v.trim())
    if (missing.length > 0) {
      setInstallErrorMcp(t('mcpstore.secretsTitle'))
      return
    }
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(conn.env ?? {})) {
      env[k] = isPlaceholderValue(v) ? (secretInputs[`env.${k}`] ?? v) : v
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(conn.headers ?? {})) {
      headers[k] = isPlaceholderValue(v) ? (secretInputs[`headers.${k}`] ?? v) : v
    }
    const config: McpServerConfig = {
      id: `market-${installTarget.id}`,
      name: installTarget.name,
      transport: conn.type,
      enabled: true,
      ...(conn.command ? { command: conn.command } : {}),
      ...(conn.args?.length ? { args: conn.args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...(conn.url ? { url: conn.url } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    }
    setInstallTesting(true)
    setInstallErrorMcp(null)
    try {
      const test = await ipc.mcpTest(config)
      if ('error' in test) {
        setInstallErrorMcp(test.error)
        return
      }
      // 测试通过：写入配置（已存在则覆盖更新）
      const exists = (settings.mcpServers ?? []).some((s) => s.id === config.id)
      settings.updateSettings({
        mcpServers: exists
          ? (settings.mcpServers ?? []).map((s) => (s.id === config.id ? config : s))
          : [...(settings.mcpServers ?? []), config],
      })
      setInstallDone(t('mcpstore.testOk', { count: test.toolCount }))
      // 短暂展示成功状态后自动关闭
      setTimeout(() => {
        setInstallTarget(null)
        setSecretInputs({})
        setInstallDone(null)
      }, 1800)
    } catch (e) {
      setInstallErrorMcp(e instanceof Error ? e.message : String(e))
    } finally {
      setInstallTesting(false)
    }
  }

  /** 已安装区的开关与移除（与设置页 McpSection 共用 settings 数据） */
  const toggleMcpEnabled = (id: string) => {
    settings.updateSettings({
      mcpServers: (settings.mcpServers ?? []).map((s) =>
        s.id === id ? { ...s, enabled: !s.enabled } : s
      ),
    })
  }
  const removeMcpServer = (id: string) => {
    settings.updateSettings({ mcpServers: (settings.mcpServers ?? []).filter((s) => s.id !== id) })
  }

  // MCP 市场本地过滤（全量约 75 条，直接前端筛）
  const filteredMcpMarket = mcpMarket.filter((s) => {
    const q = mcpQuery.trim().toLowerCase()
    if (!q) return true
    return (
      s.name.toLowerCase().includes(q) ||
      s.qualifiedName.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((tag) => tag.toLowerCase().includes(q))
    )
  })
  const uploadLoadingRef = useRef(false)
  const uploadTriggerRef = useRef<HTMLButtonElement>(null)
  const uploadDialogRef = useRef<HTMLDivElement>(null)

  const currentSession = sessions.find((s) => s.id === activeSessionId)
  const workingDir = currentSession?.workingDir || currentSession?.defaultWorkDir || ''

  const installedSkills = skills.filter(
    (s) =>
      s.source === 'online' ||
      s.source === 'custom' ||
      s.source === 'global-clerkbox' ||
      s.source === 'project-clerkbox' ||
      s.source === 'global-claude' ||
      s.source === 'project-claude'
  )

  useEffect(() => {
    if (recommendedSkills.length === 0) {
      void loadRecommended()
    }
  }, [loadRecommended, recommendedSkills.length])

  useEffect(() => {
    uploadLoadingRef.current = uploadLoading
  }, [uploadLoading])

  // 详情弹窗：Esc 关闭（捕获阶段拦截，避免冒泡到其他全局快捷键）
  useEffect(() => {
    if (!detailTarget) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setDetailTarget(null)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [detailTarget])

  useEffect(() => {
    if (!showUploadModal) return

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      uploadDialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (uploadLoadingRef.current) return
        event.stopPropagation()
        setShowUploadModal(false)
        resetUpload()
        return
      }
      if (event.key !== 'Tab') return

      const dialog = uploadDialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown, true)
      if (previousFocus?.isConnected) previousFocus.focus()
      else uploadTriggerRef.current?.focus()
    }
  }, [showUploadModal])

  const handleSearch = useCallback(() => {
    if (query.trim()) {
      searchOnlineSkills(query.trim())
      setView('search')
    }
  }, [query, searchOnlineSkills])

  const handleInstall = async (mpSkill: SkillsMPSkill) => {
    const id = 'online-' + mpSkill.id.replace(/[^a-zA-Z0-9-_]/g, '_')
    setInstallingIds((prev) => new Set(prev).add(id))
    setInstallError(null)
    try {
      const ok = await installOnlineSkill(mpSkill)
      if (!ok) {
        setInstallError(t('skillstore.installFailed'))
      }
    } catch (e) {
      console.error('Install skill failed:', e)
      setInstallError(t('skillstore.installFailed'))
    }
    setInstallingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const handleUninstall = (id: string) => {
    uninstallOnlineSkill(id, workingDir)
  }

  const isInstalled = (mpSkill: SkillsMPSkill): boolean => {
    const id = 'online-' + mpSkill.id.replace(/[^a-zA-Z0-9-_]/g, '_')
    return skills.some((s) => s.id === id)
  }

  const isInstalling = (mpSkill: SkillsMPSkill): boolean => {
    const id = 'online-' + mpSkill.id.replace(/[^a-zA-Z0-9-_]/g, '_')
    return installingIds.has(id)
  }

  const handleBack = () => {
    if (view === 'search') {
      setView('home')
    } else {
      setShowSkillStore(false)
    }
  }

  const resetUpload = () => {
    setUploadFilePath(null)
    setUploadFileName(null)
    setUploadError(null)
    setUploadLoading(false)
  }

  const openUploadModal = () => {
    resetUpload()
    setShowUploadModal(true)
  }

  const closeUploadModal = () => {
    if (uploadLoading) return
    setShowUploadModal(false)
    resetUpload()
  }

  const selectFile = async () => {
    setUploadError(null)
    try {
      const filePath = await ipc.selectSkillFile()
      if (!filePath) return
      const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath
      setUploadFilePath(filePath)
      setUploadFileName(name)
    } catch (error) {
      console.error('Failed to select a skill file:', error)
      setUploadError(t('skillstore.installFailed'))
    }
  }

  const confirmUpload = async () => {
    if (!uploadFilePath) return
    setUploadLoading(true)
    setUploadError(null)
    try {
      const result = await installCustomSkill(uploadFilePath)
      if (result.success) {
        setShowUploadModal(false)
        resetUpload()
      } else {
        setUploadError(result.error || t('skillstore.installFailed'))
      }
    } catch (error) {
      console.error('Failed to install a custom skill:', error)
      setUploadError(t('skillstore.installFailed'))
    } finally {
      setUploadLoading(false)
    }
  }

  // ── Shared skill card renderer ──
  const renderMPSkill = (mpSkill: SkillsMPSkill, showInstall = true) => {
    const installed = isInstalled(mpSkill)
    const installing = isInstalling(mpSkill)
    const bssBadge = mpSkill.bssLevel ? BSS_LEVEL_BADGE[mpSkill.bssLevel] : undefined
    return (
      <div
        key={mpSkill.id}
        className="flex items-start gap-3 px-4 py-3 rounded-xl border bg-dark-surfaceContainerHigh/30 border-dark-onSurfaceVariant/5 hover:border-dark-onSurfaceVariant/15 transition-all"
      >
        <div className="w-9 h-9 rounded-lg bg-dark-surfaceContainer flex items-center justify-center text-md-primary flex-shrink-0 mt-0.5">
          {renderSkillIcon(mpSkill.emoji, 18)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-dark-onSurface">
              {mpSkill.titleCn || mpSkill.name}
            </span>
            {mpSkill.titleCn && mpSkill.name && mpSkill.titleCn !== mpSkill.name && (
              <span className="text-[10px] text-dark-onSurfaceVariant/40">{mpSkill.name}</span>
            )}
            <span className="text-[10px] text-dark-onSurfaceVariant/30">by {mpSkill.author}</span>
            {bssBadge && (
              <span
                className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${bssBadge.className}`}
                title={`${t('skillstore.bssLevelLabel')}: ${bssBadge.label}`}
              >
                <ShieldCheck size={9} /> {bssBadge.label}
              </span>
            )}
            <span
              className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-md-info/15 text-md-info"
              title={t('skillstore.sourceLabel')}
            >
              {t('skillstore.sourceCocoLoop')}
            </span>
          </div>
          <p className="text-xs text-dark-onSurfaceVariant/50 mt-0.5 line-clamp-2">
            {mpSkill.description}
          </p>
          {(mpSkill.downloads || mpSkill.installs || mpSkill.favorites) && (
            <div className="flex items-center gap-3 mt-1 text-[10px] text-dark-onSurfaceVariant/40">
              {mpSkill.downloads && (
                <span className="flex items-center gap-0.5" title={t('skillstore.downloadsLabel')}>
                  <Download size={9} /> {mpSkill.downloads}
                </span>
              )}
              {mpSkill.installs && (
                <span className="flex items-center gap-0.5" title={t('skillstore.installed')}>
                  <Check size={9} /> {mpSkill.installs}
                </span>
              )}
              {mpSkill.favorites && (
                <span className="flex items-center gap-0.5">
                  <Star size={9} /> {mpSkill.favorites}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
          <button
            type="button"
            onClick={() => setDetailTarget({ kind: 'online', skill: mpSkill })}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-dark-surfaceContainer hover:bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant transition-all flex-shrink-0"
          >
            <Info size={11} />
            {t('skillstore.details')}
          </button>
          {showInstall && (
            installed ? (
              <span className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-md-success/15 text-md-success">
                <Check size={11} /> {t('common.installed')}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => handleInstall(mpSkill)}
                disabled={installing}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-md-primary/15 text-md-primary hover:bg-md-primary/25 disabled:opacity-40 transition-all"
              >
                {installing ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                {installing ? t('common.installing') : t('common.install')}
              </button>
            )
          )}
          <a
            href={mpSkill.skillUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-lg hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant/30 hover:text-dark-onSurfaceVariant transition-all"
            title={t('skillstore.viewOnSkillHub')}
            aria-label={t('skillstore.viewOnSkillHub')}
          >
            <ExternalLink size={12} />
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full bg-dark-surface max-md:flex-col">
      {/* ── 左侧导航：技能 / MCP 插件（桌面竖排，移动端顶部横排）── */}
      <aside className="flex-shrink-0 flex flex-col gap-1 w-40 border-r border-dark-onSurfaceVariant/10 px-3 py-4 max-md:flex-row max-md:w-full max-md:border-r-0 max-md:border-b max-md:py-2.5 max-md:px-4 max-md:gap-2">
        <button
          type="button"
          onClick={() => setStoreTab('skills')}
          aria-pressed={storeTab === 'skills'}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left max-md:flex-1 max-md:justify-center ${
            storeTab === 'skills'
              ? 'bg-md-primary/15 text-md-primary font-medium'
              : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh'
          }`}
        >
          <Zap size={15} className="flex-shrink-0" />
          <span className="truncate">{t('skillstore.tabSkills')}</span>
        </button>
        <button
          type="button"
          onClick={() => setStoreTab('mcp')}
          aria-pressed={storeTab === 'mcp'}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left max-md:flex-1 max-md:justify-center ${
            storeTab === 'mcp'
              ? 'bg-md-primary/15 text-md-primary font-medium'
              : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh'
          }`}
        >
          <Plug size={15} className="flex-shrink-0" />
          <span className="truncate">{t('skillstore.tabMcp')}</span>
        </button>
      </aside>

      {/* ── 右侧主区 ── */}
      <div className="flex flex-col flex-1 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-dark-onSurfaceVariant/10 max-md:px-4">
        <Store size={22} className="text-md-primary" />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold text-dark-onSurface truncate">{t('skillstore.title')}</h1>
          <p className="text-xs text-dark-onSurfaceVariant/50 truncate">
            {storeTab === 'skills' ? t('skillstore.subtitle') : t('mcpstore.marketSubtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {storeTab === 'skills' && (
            <button
              ref={uploadTriggerRef}
              type="button"
              onClick={openUploadModal}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm text-dark-onSurfaceVariant max-md:hidden"
            >
              <Upload size={14} />
              {t('skillstore.loadCustom')}
            </button>
          )}
          {storeTab === 'mcp' && (
            <button
              type="button"
              onClick={() => void loadMcpMarket()}
              disabled={mcpMarketLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm text-dark-onSurfaceVariant max-md:hidden"
            >
              <RefreshCw size={14} className={mcpMarketLoading ? 'animate-spin' : ''} />
              {t('mcpstore.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm text-dark-onSurfaceVariant"
          >
            <ArrowLeft size={14} />
            {view === 'search' ? t('skillstore.backToRecommend') : t('skillstore.backToChat')}
          </button>
        </div>
      </div>

      {/* Search bar */}
      {storeTab === 'skills' ? (
        <div className="px-6 py-4 max-md:px-4">
          <div className="max-w-md mx-auto flex gap-2">
            <div className="flex-1 relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-onSurfaceVariant/40" />
              <input
                id="skill-store-search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && handleSearch()}
                placeholder={t('skillstore.searchPlaceholder')}
                className="w-full pl-9 pr-4 py-2.5 rounded-md3-md bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 focus:border-md-primary/50 focus:ring-1 focus:ring-md-primary/30 outline-none transition-all text-sm placeholder:text-dark-onSurfaceVariant/30"
              />
              <label htmlFor="skill-store-search" className="sr-only">{t('skillstore.search')}</label>
            </div>
            <button
              type="button"
              onClick={handleSearch}
              disabled={searchLoading || !query.trim()}
              className="px-5 py-2.5 rounded-md3-md bg-md-primary hover:bg-md-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm text-md-onPrimary font-medium flex items-center gap-1.5"
            >
              {searchLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              {t('skillstore.search')}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-6 py-4 max-md:px-4">
          <div className="max-w-2xl mx-auto">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-onSurfaceVariant/40" />
              <input
                id="mcp-store-search"
                type="text"
                value={mcpQuery}
                onChange={(e) => setMcpQuery(e.target.value)}
                placeholder={t('mcpstore.searchPlaceholder')}
                className="w-full pl-9 pr-4 py-2.5 rounded-md3-md bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 focus:border-md-primary/50 focus:ring-1 focus:ring-md-primary/30 outline-none transition-all text-sm placeholder:text-dark-onSurfaceVariant/30"
              />
              <label htmlFor="mcp-store-search" className="sr-only">{t('skillstore.search')}</label>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 max-md:px-4">
        {storeTab === 'skills' && (
        <div className="max-w-md mx-auto">
          {/* 在线技能安装失败提示 */}
          {installError && (
            <div
              role="alert"
              className="flex items-center gap-2 mb-4 px-3 py-2.5 rounded-lg text-xs text-md-error bg-md-error/10 border border-md-error/20"
            >
              <AlertTriangle size={14} className="flex-shrink-0" />
              <span className="flex-1">{installError}</span>
              <button
                type="button"
                onClick={() => setInstallError(null)}
                className="p-0.5 rounded hover:bg-md-error/20 transition-colors"
                aria-label={t('common.close')}
              >
                <X size={12} />
              </button>
            </div>
          )}
          {/* ── INSTALLED SECTION (可折叠，搜索时默认折叠) ── */}
          {installedSkills.length > 0 && (
            <div className="mb-6">
              <button
                type="button"
                onClick={() => setInstalledCollapsedHome(!installedCollapsedHome)}
                className="flex items-center gap-2 text-sm font-medium text-md-success mb-3 hover:text-md-success/80 transition-colors w-full"
              >
                {installedCollapsedHome ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <Check size={14} />
                {t('skillstore.installedCount', { count: installedSkills.length })}
              </button>
              {!installedCollapsedHome && (
                <div className="grid gap-2 w-full">
                  {installedSkills.map((skill) => {
                    const isActive = sessionSkillIds.includes(skill.id)
                    const isRemovable = skill.source === 'online' || skill.source === 'custom'
                    const badge = SOURCE_BADGE[skill.source]
                    return (
                      <div
                        key={skill.id}
                        className={`flex items-start gap-3 px-4 py-3 rounded-xl border transition-all max-w-full overflow-hidden ${
                          isActive
                            ? 'bg-md-primary/8 border-md-primary/20'
                            : 'bg-dark-surfaceContainerHigh/50 border-dark-onSurfaceVariant/5'
                        }`}
                      >
                        <span className="text-md-primary flex-shrink-0 mt-1">
                          {renderSkillIcon(skill.icon, 20)}
                        </span>
                        <div className="flex-1 min-w-0 overflow-hidden">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium text-dark-onSurface truncate">{skill.name}</span>
                            {skill.version && (
                              <span className="text-[10px] text-dark-onSurfaceVariant/40">v{skill.version}</span>
                            )}
                            {badge && (
                              <span
                                className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${badge.className}`}
                              >
                                {t(badge.labelKey)}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-dark-onSurfaceVariant/50 truncate">{skill.description}</p>
                          {skill.author && (
                            <p className="text-[10px] text-dark-onSurfaceVariant/40 mt-0.5 truncate">by {skill.author}</p>
                          )}
                          {(skill.triggerKeywords?.length ?? 0) > 0 && (
                            <div className="flex items-center gap-1 flex-wrap mt-1">
                              {skill.triggerKeywords.slice(0, 5).map((kw) => (
                                <span
                                  key={kw}
                                  className="px-1.5 py-0.5 rounded-full bg-dark-surfaceContainer text-dark-onSurfaceVariant/60 text-[10px]"
                                >
                                  {kw}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
                          <button
                            type="button"
                            onClick={() => setDetailTarget({ kind: 'installed', skill })}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-dark-surfaceContainer hover:bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant transition-all flex-shrink-0"
                          >
                            <Info size={11} />
                            {t('skillstore.details')}
                          </button>
                          {isRemovable && (
                            <button
                              type="button"
                              onClick={() => handleUninstall(skill.id)}
                              className="p-1.5 rounded-lg hover:bg-md-error/10 text-dark-onSurfaceVariant/40 hover:text-md-error transition-all flex-shrink-0"
                              title={t('common.uninstall')}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── HOME VIEW: Recommended ── */}
          {view === 'home' && (
            <div>
              <h3 className="flex items-center gap-2 text-sm font-medium text-dark-onSurfaceVariant mb-3">
                <TrendingUp size={14} className="text-md-primary" />
                {t('skillstore.recommended')}
              </h3>
              {recommendedLoading && recommendedSkills.length === 0 ? (
                <div className="flex items-center justify-center py-12 gap-2 text-dark-onSurfaceVariant/40">
                  <Loader2 size={20} className="animate-spin" />
                  <span className="text-sm">{t('skillstore.loadingRecommended')}</span>
                </div>
              ) : recommendedSkills.length > 0 ? (
                <div className="grid gap-2 w-full">
                  {recommendedSkills.map((mpSkill) => renderMPSkill(mpSkill))}
                </div>
              ) : (
                <div className="text-center py-16">
                  <Store size={36} className="text-dark-onSurfaceVariant/30 mb-3 mx-auto" />
                  <p className="text-sm text-dark-onSurfaceVariant/40 mb-1">{t('skillstore.emptyTitle')}</p>
                  <p className="text-xs text-dark-onSurfaceVariant/25">
                    {t('skillstore.emptyHint')}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── SEARCH VIEW ── */}
          {view === 'search' && (
            <div className="space-y-4">
              {/* 搜索视图下已安装技能默认折叠（用户可手动展开管理） */}
              {installedSkills.length > 0 && !installedCollapsedSearch && (
                <div className="mb-4 p-3 rounded-xl border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainerHigh/30">
                  <button
                    type="button"
                    onClick={() => setInstalledCollapsedSearch(true)}
                    className="flex items-center gap-2 text-sm font-medium text-md-success mb-3 hover:text-md-success/80 transition-colors w-full"
                  >
                    <ChevronDown size={14} />
                    <Check size={14} />
                    {t('skillstore.installedCount', { count: installedSkills.length })}
                  </button>
                  <div className="grid gap-2 w-full">
                    {installedSkills.map((skill) => {
                      const isActive = sessionSkillIds.includes(skill.id)
                      const isRemovable = skill.source === 'online' || skill.source === 'custom'
                      const badge = SOURCE_BADGE[skill.source]
                      return (
                        <div
                          key={skill.id}
                          className={`flex items-start gap-3 px-4 py-3 rounded-xl border transition-all max-w-full overflow-hidden ${
                            isActive
                              ? 'bg-md-primary/8 border-md-primary/20'
                              : 'bg-dark-surfaceContainerHigh/50 border-dark-onSurfaceVariant/5'
                          }`}
                        >
                          <span className="text-md-primary flex-shrink-0 mt-1">
                            {renderSkillIcon(skill.icon, 20)}
                          </span>
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-sm font-medium text-dark-onSurface truncate">{skill.name}</span>
                              {badge && (
                                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${badge.className}`}>
                                  {t(badge.labelKey)}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-dark-onSurfaceVariant/50 truncate">{skill.description}</p>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
                            <button
                              type="button"
                              onClick={() => setDetailTarget({ kind: 'installed', skill })}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-dark-surfaceContainer hover:bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant transition-all flex-shrink-0"
                            >
                              <Info size={11} />
                              {t('skillstore.details')}
                            </button>
                            {isRemovable && (
                              <button
                                type="button"
                                onClick={() => handleUninstall(skill.id)}
                                className="p-1.5 rounded-lg hover:bg-md-error/10 text-dark-onSurfaceVariant/40 hover:text-md-error transition-all flex-shrink-0"
                                title={t('common.uninstall')}
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              {installedSkills.length > 0 && installedCollapsedSearch && (
                <button
                  type="button"
                  onClick={() => setInstalledCollapsedSearch(false)}
                  className="flex items-center gap-2 text-xs text-dark-onSurfaceVariant/50 hover:text-dark-onSurfaceVariant mb-3 transition-colors"
                >
                  <ChevronRight size={12} />
                  <Check size={12} />
                  {t('skillstore.installedCount', { count: installedSkills.length })}
                </button>
              )}

              {searchLoading && (
                <div className="flex items-center justify-center py-12 gap-2 text-dark-onSurfaceVariant/40">
                  <Loader2 size={20} className="animate-spin" />
                  <span className="text-sm">{t('skillstore.searching')}</span>
                </div>
              )}

              {!searchLoading && searchResults.length > 0 && (() => {
                // 搜索结果中隐藏已安装技能，避免重复展示
                const visibleResults = searchResults.filter((mpSkill) => !isInstalled(mpSkill))
                if (visibleResults.length === 0) {
                  // 所有结果都已安装，显示"无新技能可安装"提示
                  return (
                    <div className="text-center py-16">
                      <SearchX size={36} className="text-dark-onSurfaceVariant/30 mb-3 mx-auto" />
                      <p className="text-sm text-dark-onSurfaceVariant/40 mb-1">{t('skillstore.noResultsTitle', { query: searchQuery })}</p>
                      <p className="text-xs text-dark-onSurfaceVariant/25">{t('skillstore.noResultsHint')}</p>
                    </div>
                  )
                }
                return (
                  <div>
                    <h3 className="flex items-center gap-2 text-sm font-medium text-dark-onSurfaceVariant mb-3">
                      <Search size={14} />
                      {t('skillstore.searchResults')} {searchTotal > 0 && t('skillstore.searchTotal', { count: searchTotal })}
                    </h3>
                    <div className="grid gap-2 w-full">
                      {visibleResults.map((mpSkill) => renderMPSkill(mpSkill))}
                    </div>

                    {searchHasNext && (
                      <div className="flex justify-center mt-4">
                        <button
                          type="button"
                          onClick={() => searchOnlineSkills(searchQuery, searchPage + 1)}
                          className="flex items-center gap-1.5 px-4 py-2 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm text-dark-onSurfaceVariant"
                        >
                          {t('skillstore.loadMore')}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })()}

              {!searchLoading && searchResults.length === 0 && searchQuery && (
                <div className="text-center py-16">
                  <SearchX size={36} className="text-dark-onSurfaceVariant/30 mb-3 mx-auto" />
                  <p className="text-sm text-dark-onSurfaceVariant/40 mb-1">{t('skillstore.noResultsTitle', { query: searchQuery })}</p>
                  <p className="text-xs text-dark-onSurfaceVariant/25">{t('skillstore.noResultsHint')}</p>
                </div>
              )}
            </div>
          )}
        </div>
        )}

        {/* ── MCP 插件市场 ── */}
        {storeTab === 'mcp' && (
        <div className="max-w-2xl mx-auto">
          {/* 已安装服务器区（含手动添加的 + 市场安装的） */}
          {(settings.mcpServers ?? []).length > 0 && (
            <div className="mb-6">
              <button
                type="button"
                onClick={() => setInstalledCollapsedHome(!installedCollapsedHome)}
                className="flex items-center gap-2 text-sm font-medium text-md-success mb-3 hover:text-md-success/80 transition-colors w-full"
              >
                {installedCollapsedHome ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <Check size={14} />
                {t('mcpstore.installedSection', { count: (settings.mcpServers ?? []).length })}
              </button>
              {!installedCollapsedHome && (
                <div className="grid gap-2 w-full">
                  {(settings.mcpServers ?? []).map((server) => {
                    const status = mcpStatuses.find((s) => s.id === server.id)
                    const state = status?.state ?? (server.enabled ? 'connecting' : 'disabled')
                    const dotCls =
                      state === 'connected' ? 'bg-emerald-500'
                      : state === 'connecting' ? 'bg-amber-500'
                      : state === 'error' ? 'bg-red-500'
                      : 'bg-dark-onSurfaceVariant/30'
                    return (
                      <div
                        key={server.id}
                        className="flex items-start gap-3 px-4 py-3 rounded-xl border bg-dark-surfaceContainerHigh/30 border-dark-onSurfaceVariant/5"
                      >
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-2 ${dotCls}`} aria-label={state} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium text-dark-onSurface">{server.name}</span>
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-dark-surfaceContainer text-dark-onSurfaceVariant/60">
                              {server.transport === 'stdio' ? t('mcpstore.connStdio') : t('mcpstore.connHttp')}
                            </span>
                          </div>
                          <p className="text-xs text-dark-onSurfaceVariant/50 mt-0.5 truncate">
                            {status && status.toolCount > 0
                              ? t('mcpstore.toolsBadge', { count: status.toolCount })
                              : t(`mcpstore.state${state.charAt(0).toUpperCase()}${state.slice(1)}`)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                          <button
                            type="button"
                            onClick={() => toggleMcpEnabled(server.id)}
                            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                              server.enabled
                                ? 'bg-md-primary text-md-onPrimary hover:bg-md-primary/90'
                                : 'bg-dark-surfaceContainer hover:bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant'
                            }`}
                          >
                            {server.enabled ? <Check size={11} /> : <Zap size={11} />}
                            {server.enabled ? t('skillstore.loaded') : t('skillstore.load')}
                          </button>
                          <button
                            type="button"
                            onClick={() => { if (window.confirm(t('mcpstore.removeConfirm'))) removeMcpServer(server.id) }}
                            className="p-1.5 rounded-lg hover:bg-md-error/10 text-dark-onSurfaceVariant/40 hover:text-md-error transition-all"
                            title={t('common.uninstall')}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* 市场列表 */}
          <h3 className="flex items-center gap-2 text-sm font-medium text-dark-onSurfaceVariant mb-3">
            <TrendingUp size={14} className="text-md-primary" />
            {t('mcpstore.marketTitle')}
          </h3>

          {mcpMarketLoading && mcpMarket.length === 0 ? (
            <div className="flex items-center justify-center py-12 gap-2 text-dark-onSurfaceVariant/40">
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm">{t('mcpstore.testing')}</span>
            </div>
          ) : mcpMarketError ? (
            <div className="text-center py-12">
              <AlertTriangle size={32} className="text-md-warning/50 mb-3 mx-auto" />
              <p className="text-sm text-dark-onSurfaceVariant/50 mb-3">{t('mcpstore.loadFailed')}</p>
              <p className="text-xs text-dark-onSurfaceVariant/30 mb-4 break-all px-4">{mcpMarketError}</p>
              <button
                type="button"
                onClick={() => void loadMcpMarket()}
                className="px-4 py-2 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm text-dark-onSurfaceVariant"
              >
                <RefreshCw size={14} className="inline mr-1.5 -mt-0.5" />
                {t('mcpstore.retry')}
              </button>
            </div>
          ) : filteredMcpMarket.length === 0 ? (
            <div className="text-center py-16">
              <SearchX size={36} className="text-dark-onSurfaceVariant/30 mb-3 mx-auto" />
              <p className="text-sm text-dark-onSurfaceVariant/40">{t('mcpstore.noResults')}</p>
            </div>
          ) : (
            <div className="grid gap-2 w-full">
              {filteredMcpMarket.map((server) => {
                const installed = isMcpInstalled(server)
                const hasConn = !!server.connection
                return (
                  <div
                    key={server.id}
                    className="flex items-start gap-3 px-4 py-3 rounded-xl border bg-dark-surfaceContainerHigh/30 border-dark-onSurfaceVariant/5 hover:border-dark-onSurfaceVariant/15 transition-all"
                  >
                    <div className="w-9 h-9 rounded-lg bg-dark-surfaceContainer flex items-center justify-center text-md-primary flex-shrink-0 mt-0.5 overflow-hidden">
                      {server.logo ? (
                        <img src={server.logo} alt="" className="w-5 h-5 object-contain" loading="lazy" />
                      ) : (
                        <Package size={18} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium text-dark-onSurface">{server.name}</span>
                        {server.qualifiedName && server.qualifiedName !== server.name && (
                          <span className="text-[10px] text-dark-onSurfaceVariant/40 break-all">{server.qualifiedName}</span>
                        )}
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-md-info/15 text-md-info">
                          {t('mcpstore.sourceMcpHub')}
                        </span>
                        {server.isDomestic && (
                          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-md-success/15 text-md-success">
                            {t('mcpstore.domestic')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-dark-onSurfaceVariant/50 mt-0.5 line-clamp-2">{server.description}</p>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        <span className="flex items-center gap-0.5 text-[10px] text-dark-onSurfaceVariant/40" title={t('mcpstore.useCountLabel')}>
                          <TrendingUp size={9} /> {(server.useCount / 1000).toFixed(1)}k
                        </span>
                        {server.tags.slice(0, 4).map((tag) => (
                          <span key={tag} className="px-1.5 py-0.5 rounded-full bg-dark-surfaceContainer text-dark-onSurfaceVariant/60 text-[10px]">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
                      {installed ? (
                        <span className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-md-success/15 text-md-success">
                          <Check size={11} /> {t('common.installed')}
                        </span>
                      ) : hasConn ? (
                        <button
                          type="button"
                          onClick={() => openMcpInstall(server)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-md-primary/15 text-md-primary hover:bg-md-primary/25 transition-all"
                        >
                          <Download size={11} />
                          {t('common.install')}
                        </button>
                      ) : (
                        <span className="px-2.5 py-1 rounded-lg text-xs text-dark-onSurfaceVariant/40" title={t('mcpstore.noConnection')}>
                          {t('mcpstore.noConnection')}
                        </span>
                      )}
                      {server.packageUrl && (
                        <a
                          href={server.packageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded-lg hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant/30 hover:text-dark-onSurfaceVariant transition-all"
                          title={server.packageUrl}
                          aria-label={server.packageUrl}
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        )}
      </div>
      </div>

      {/* ── 上传自定义技能弹窗 ── */}
      {showUploadModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={closeUploadModal}
        >
          <div
            ref={uploadDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="skill-upload-title"
            aria-describedby="skill-upload-requirements"
            className="w-full max-w-md rounded-xl bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 shadow-2xl p-5 animate-fade-in"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 id="skill-upload-title" className="text-base font-semibold text-dark-onSurface">{t('skillstore.uploadTitle')}</h3>
              <button
                type="button"
                onClick={closeUploadModal}
                disabled={uploadLoading}
                className="p-1 rounded-md3-sm hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant/60 transition-colors"
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            </div>

            <button
              type="button"
              data-autofocus
              onClick={selectFile}
              disabled={uploadLoading}
              className="relative flex w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-dark-onSurfaceVariant/25 bg-dark-surfaceDim/50 px-6 py-10 transition-colors hover:border-dark-onSurfaceVariant/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploadFileName ? (
                <>
                  <FileText size={32} className="text-md-primary" />
                  <span className="text-sm text-dark-onSurface font-medium">{uploadFileName}</span>
                </>
              ) : (
                <>
                  <FileArchive size={32} className="text-dark-onSurfaceVariant/50" />
                  <span className="text-sm text-dark-onSurfaceVariant">{t('skillstore.uploadHint')}</span>
                </>
              )}
            </button>

            <ul id="skill-upload-requirements" className="mt-4 space-y-1.5 text-xs text-dark-onSurfaceVariant/60 list-disc pl-4">
              <li>{t('skillstore.uploadReq1')}</li>
              <li>{t('skillstore.uploadReq2')}</li>
            </ul>

            {uploadError && (
              <div role="alert" className="mt-3 text-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2">
                {uploadError}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeUploadModal}
                disabled={uploadLoading}
                className="px-4 py-2 rounded-md3-md text-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={confirmUpload}
                disabled={!uploadFilePath || uploadLoading}
                className="px-4 py-2 rounded-md3-md text-sm font-medium bg-md-primary text-md-onPrimary hover:bg-md-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              >
                {uploadLoading && <Loader2 size={14} className="animate-spin" />}
                {t('skillstore.confirmUpload')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 技能详情弹窗：完整介绍 + 元数据（安全提示收敛到此处，卡片不再展示）── */}
      {detailTarget && (() => {
        const mp = detailTarget.kind === 'online' ? detailTarget.skill : null
        const inst = detailTarget.kind !== 'online' ? detailTarget.skill : null
        const badge = inst ? SOURCE_BADGE[inst.source] : undefined
        const bssBadge = mp?.bssLevel ? BSS_LEVEL_BADGE[mp.bssLevel] : undefined
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setDetailTarget(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="skill-detail-title"
              className="w-full max-w-md max-h-[85dvh] overflow-y-auto rounded-xl bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 shadow-2xl p-5 animate-fade-in"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="flex items-start gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-dark-surfaceContainer flex items-center justify-center text-md-primary flex-shrink-0">
                    {renderSkillIcon(mp ? mp.emoji : inst?.icon, 18)}
                  </div>
                  <div className="min-w-0">
                    <h3 id="skill-detail-title" className="text-base font-semibold text-dark-onSurface truncate">
                      {mp ? (mp.titleCn || mp.name) : inst?.name}
                    </h3>
                    {mp?.titleCn && mp.titleCn !== mp.name && (
                      <p className="text-[11px] text-dark-onSurfaceVariant/40 truncate">{mp.name}</p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailTarget(null)}
                  className="p-1 rounded-md3-sm hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant/60 transition-colors flex-shrink-0"
                  aria-label={t('common.close')}
                >
                  <X size={16} />
                </button>
              </div>

              {/* 元信息：作者 / 版本 / 来源 / 安全等级 */}
              <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-dark-onSurfaceVariant/50">
                {(mp ? mp.author : inst?.author) && <span>by {mp ? mp.author : inst?.author}</span>}
                {inst?.version && <span>v{inst.version}</span>}
                {badge ? (
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${badge.className}`}>
                    {t(badge.labelKey)}
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-md-info/15 text-md-info">
                    {t('skillstore.sourceCocoLoop')}
                  </span>
                )}
                {bssBadge && (
                  <span
                    className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${bssBadge.className}`}
                  >
                    <ShieldCheck size={9} /> {bssBadge.label}
                  </span>
                )}
              </div>

              {/* 完整介绍 */}
              <p className="text-xs text-dark-onSurfaceVariant/70 leading-relaxed whitespace-pre-wrap break-words mt-3">
                {mp ? mp.description : inst?.description}
              </p>

              {/* 在线技能统计 */}
              {mp && (mp.downloads || mp.installs || mp.favorites || mp.updatedAt) && (
                <div className="flex items-center gap-3 flex-wrap mt-3 text-[11px] text-dark-onSurfaceVariant/50">
                  {mp.downloads && (
                    <span className="flex items-center gap-1">
                      <Download size={11} /> {t('skillstore.downloadsLabel')} {mp.downloads}
                    </span>
                  )}
                  {mp.installs && (
                    <span className="flex items-center gap-1">
                      <Check size={11} /> {t('skillstore.installsLabel')} {mp.installs}
                    </span>
                  )}
                  {mp.favorites && (
                    <span className="flex items-center gap-1">
                      <Star size={11} /> {t('skillstore.favoritesLabel')} {mp.favorites}
                    </span>
                  )}
                  {mp.updatedAt && (
                    <span>
                      {t('skillstore.detailUpdated')} {mp.updatedAt}
                    </span>
                  )}
                </div>
              )}

              {/* 已安装技能：触发关键词 */}
              {inst && (inst.triggerKeywords?.length ?? 0) > 0 && (
                <div className="mt-3">
                  <p className="text-[11px] text-dark-onSurfaceVariant/40 mb-1">{t('skillstore.detailKeywords')}</p>
                  <div className="flex items-center gap-1 flex-wrap">
                    {inst.triggerKeywords.map((kw) => (
                      <span
                        key={kw}
                        className="px-1.5 py-0.5 rounded-full bg-dark-surfaceContainer text-dark-onSurfaceVariant/60 text-[10px]"
                      >
                        {kw}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 已安装技能：安全提示 */}
              {inst && inst.warnings && inst.warnings.length > 0 && (
                <div className="mt-3">
                  <p className="flex items-center gap-1 text-[11px] font-medium text-md-warning mb-1">
                    <AlertTriangle size={11} /> {t('skillstore.detailWarnings')}
                  </p>
                  <ul className="space-y-0.5 text-[11px] text-md-warning/80 list-disc pl-4">
                    {inst.warnings.map((w, i) => (
                      <li key={i} className="break-words">{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex justify-end gap-2 mt-5">
                {mp && (
                  <a
                    href={mp.skillUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-4 py-2 rounded-md3-md text-sm text-md-primary hover:bg-md-primary/10 transition-colors"
                  >
                    <ExternalLink size={13} />
                    {t('skillstore.viewOnSkillHub')}
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setDetailTarget(null)}
                  className="px-4 py-2 rounded-md3-md text-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors"
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── MCP 安装预览弹窗：先看配置 → 填密钥 → 测试连接 → 安装 ── */}
      {installTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={closeMcpInstall}
        >
          <div
            ref={installDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-install-title"
            className="w-full max-w-lg max-h-[85dvh] overflow-y-auto rounded-xl bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 shadow-2xl p-5 animate-fade-in"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-lg bg-dark-surfaceContainer flex items-center justify-center text-md-primary flex-shrink-0 overflow-hidden">
                  {installTarget.logo ? (
                    <img src={installTarget.logo} alt="" className="w-5 h-5 object-contain" />
                  ) : (
                    <Package size={18} />
                  )}
                </div>
                <div className="min-w-0">
                  <h3 id="mcp-install-title" className="text-base font-semibold text-dark-onSurface truncate">{installTarget.name}</h3>
                  {installTarget.qualifiedName && (
                    <p className="text-[11px] text-dark-onSurfaceVariant/40 truncate">{installTarget.qualifiedName}</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={closeMcpInstall}
                disabled={installTesting}
                className="p-1 rounded-md3-sm hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant/60 transition-colors flex-shrink-0 disabled:opacity-50"
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            </div>

            <p className="text-xs text-dark-onSurfaceVariant/60 mb-4">{installTarget.description}</p>

            {installTarget.connection && (
              <div className="space-y-3">
                {/* 连接方式预览 */}
                <div className="rounded-lg border border-dark-onSurfaceVariant/10 bg-dark-surface/60 px-3 py-2.5">
                  <div className="flex items-center gap-2 text-xs text-dark-onSurfaceVariant/60 mb-1.5">
                    <Plug size={12} className="text-md-primary" />
                    {installTarget.connection.type === 'stdio' ? t('mcpstore.connStdio') : t('mcpstore.connHttp')}
                  </div>
                  {installTarget.connection.type === 'stdio' ? (
                    <div className="text-xs">
                      <p className="text-dark-onSurfaceVariant/50">{t('mcpstore.commandLabel')}</p>
                      <code className="block mt-1 px-2 py-1.5 rounded bg-dark-surfaceContainerHigh text-[11px] text-dark-onSurface break-all">
                        {[installTarget.connection.command, ...(installTarget.connection.args ?? [])].filter(Boolean).join(' ')}
                      </code>
                    </div>
                  ) : (
                    <div className="text-xs">
                      <p className="text-dark-onSurfaceVariant/50">{t('mcpstore.urlLabel')}</p>
                      <code className="block mt-1 px-2 py-1.5 rounded bg-dark-surfaceContainerHigh text-[11px] text-dark-onSurface break-all">
                        {installTarget.connection.url}
                      </code>
                    </div>
                  )}
                </div>

                {/* 需要填写的密钥项（value 为 <placeholder> 形式） */}
                {(() => {
                  const envEntries = Object.entries(installTarget.connection?.env ?? {})
                  const headerEntries = Object.entries(installTarget.connection?.headers ?? {})
                  const secretEnv = envEntries.filter(([, v]) => isPlaceholderValue(v))
                  const secretHeaders = headerEntries.filter(([, v]) => isPlaceholderValue(v))
                  const plainEnv = envEntries.filter(([, v]) => !isPlaceholderValue(v))
                  const plainHeaders = headerEntries.filter(([, v]) => !isPlaceholderValue(v))
                  const hasSecrets = secretEnv.length + secretHeaders.length > 0
                  if (!hasSecrets && plainEnv.length + plainHeaders.length === 0) return null
                  return (
                    <>
                      {hasSecrets && (
                        <div>
                          <p className="flex items-center gap-1.5 text-xs font-medium text-md-warning mb-2">
                            <AlertTriangle size={12} /> {t('mcpstore.secretsTitle')}
                          </p>
                          <div className="space-y-2">
                            {secretEnv.map(([k]) => (
                              <label key={`env.${k}`} className="block">
                                <span className="block text-[11px] text-dark-onSurfaceVariant/60 mb-1 font-mono">{k}</span>
                                <input
                                  type={isSecretKey(k) ? 'password' : 'text'}
                                  value={secretInputs[`env.${k}`] ?? ''}
                                  onChange={(e) => setSecretInputs((prev) => ({ ...prev, [`env.${k}`]: e.target.value }))}
                                  disabled={installTesting || !!installDone}
                                  autoComplete="off"
                                  className="w-full px-3 py-2 rounded-md3-md bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 focus:border-md-primary/50 focus:ring-1 focus:ring-md-primary/30 outline-none transition-all text-sm"
                                />
                              </label>
                            ))}
                            {secretHeaders.map(([k]) => (
                              <label key={`headers.${k}`} className="block">
                                <span className="block text-[11px] text-dark-onSurfaceVariant/60 mb-1 font-mono">{k}</span>
                                <input
                                  type={isSecretKey(k) ? 'password' : 'text'}
                                  value={secretInputs[`headers.${k}`] ?? ''}
                                  onChange={(e) => setSecretInputs((prev) => ({ ...prev, [`headers.${k}`]: e.target.value }))}
                                  disabled={installTesting || !!installDone}
                                  autoComplete="off"
                                  className="w-full px-3 py-2 rounded-md3-md bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 focus:border-md-primary/50 focus:ring-1 focus:ring-md-primary/30 outline-none transition-all text-sm"
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                      {(plainEnv.length > 0 || plainHeaders.length > 0) && (
                        <div className="text-xs">
                          <p className="text-dark-onSurfaceVariant/50 mb-1">{plainEnv.length > 0 ? t('mcpstore.envLabel') : t('mcpstore.headersLabel')}</p>
                          <div className="px-3 py-2 rounded-lg bg-dark-surface/60 border border-dark-onSurfaceVariant/10 space-y-1">
                            {plainEnv.map(([k, v]) => (
                              <p key={k} className="font-mono text-[11px] text-dark-onSurfaceVariant/60 break-all">
                                <span className="text-dark-onSurfaceVariant/40">{k}</span>={v}
                              </p>
                            ))}
                            {plainHeaders.map(([k, v]) => (
                              <p key={k} className="font-mono text-[11px] text-dark-onSurfaceVariant/60 break-all">
                                <span className="text-dark-onSurfaceVariant/40">{k}</span>={v}
                              </p>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )
                })()}

                {installDone && (
                  <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs text-md-success bg-md-success/10 border border-md-success/20">
                    <Check size={14} className="flex-shrink-0" />
                    {installDone}
                  </div>
                )}
                {installErrorMcp && !installDone && (
                  <div role="alert" className="text-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2 break-all">
                    {installErrorMcp}
                  </div>
                )}

                <p className="text-[11px] text-dark-onSurfaceVariant/35">{t('mcpstore.installNote')}</p>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={closeMcpInstall}
                    disabled={installTesting}
                    className="px-4 py-2 rounded-md3-md text-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmMcpInstall()}
                    disabled={installTesting || !!installDone}
                    className="px-4 py-2 rounded-md3-md text-sm font-medium bg-md-primary text-md-onPrimary hover:bg-md-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                  >
                    {installTesting && <Loader2 size={14} className="animate-spin" />}
                    {installTesting ? t('mcpstore.testing') : t('mcpstore.confirmInstall')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
