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
import { useShallow } from 'zustand/react/shallow'
import { useSkillsStore } from '../../stores/skills-store'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useMcpStore } from '../../stores/mcp-store'
import { ipc } from '../../lib/ipc-client'
import ConfirmDialog from '../ui/ConfirmDialog'
import Modal from '../ui/Modal'
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
  'project-claude': { labelKey: 'skillstore.sourceProject', className: 'bg-md-info/15 text-md-info' },
}

/**
 * BSS 安全等级 → 视觉样式映射（CocoLoop Hub 标识：S+/S/A/B/C/D）。
 */
const BSS_LEVEL_BADGE: Record<string, { className: string; label: string }> = {
  'S+': { className: 'bg-md-success/15 text-md-success', label: 'S+' },
  'S': { className: 'bg-md-success/15 text-md-success', label: 'S' },
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
  // 按字段订阅：避免商店内任何无关字段变化（如安装态）触发整页重渲染
  const {
    skills,
    sessionSkillIds,
    searchResults,
    searchLoading,
    searchError,
    searchQuery,
    searchPage,
    searchTotal,
    searchHasNext,
    recommendedSkills,
    recommendedLoading,
    recommendedError,
    searchOnlineSkills,
    installOnlineSkill,
    uninstallOnlineSkill,
    loadRecommended,
    installCustomSkill,
  } = useSkillsStore(useShallow((s) => ({
    skills: s.skills,
    sessionSkillIds: s.sessionSkillIds,
    searchResults: s.searchResults,
    searchLoading: s.searchLoading,
    searchError: s.searchError,
    searchQuery: s.searchQuery,
    searchPage: s.searchPage,
    searchTotal: s.searchTotal,
    searchHasNext: s.searchHasNext,
    recommendedSkills: s.recommendedSkills,
    recommendedLoading: s.recommendedLoading,
    recommendedError: s.recommendedError,
    searchOnlineSkills: s.searchOnlineSkills,
    installOnlineSkill: s.installOnlineSkill,
    uninstallOnlineSkill: s.uninstallOnlineSkill,
    loadRecommended: s.loadRecommended,
    installCustomSkill: s.installCustomSkill,
  })))
  const { sessions, activeSessionId } = useChatStore(useShallow((s) => ({
    sessions: s.sessions,
    activeSessionId: s.activeSessionId,
  })))
  const { setShowSkillStore } = useUIStore()

  // 卸载技能 / 移除 MCP 服务器的二次确认弹窗目标
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null)
  const [removingMcpId, setRemovingMcpId] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set())
  const [uninstallingIds, setUninstallingIds] = useState<Set<string>>(new Set())
  const [view, setView] = useState<'home' | 'search'>('home')
  // 已安装技能区块折叠状态：home/search 各自独立，默认展开（首次使用即可见）
  const [installedCollapsedHome, setInstalledCollapsedHome] = useState(false)
  const [installedCollapsedSearch, setInstalledCollapsedSearch] = useState(true)
  const [installedMcpCollapsed, setInstalledMcpCollapsed] = useState(false)
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [uploadFilePath, setUploadFilePath] = useState<string | null>(null)
  const [uploadFileName, setUploadFileName] = useState<string | null>(null)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  // 在线技能安装失败时的错误提示（显示在主内容区顶部）
  const [installError, setInstallError] = useState<string | null>(null)
  // 技能详情弹窗：online = 商店在线技能，installed = 已安装技能
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null)

  // 商店分区：技能 / MCP 插件；默认技能。
  const [storeTab, setStoreTab] = useState<'skills' | 'mcp'>('skills')

  // ── MCP 插件市场 ──
  const settings = useSettingsStore(useShallow((s) => ({
    mcpServers: s.mcpServers,
    updateSettings: s.updateSettings,
  })))
  const mcpStatuses = useMcpStore((s) => s.statuses)
  const [mcpMarket, setMcpMarket] = useState<McpMarketServer[]>([])
  const [mcpMarketLoading, setMcpMarketLoading] = useState(false)
  const [mcpMarketLoaded, setMcpMarketLoaded] = useState(false)
  const [mcpMarketError, setMcpMarketError] = useState<string | null>(null)
  const [mcpQuery, setMcpQuery] = useState('')
  // 安装弹窗：目标服务器 + 密钥输入 + 测试状态
  const [installTarget, setInstallTarget] = useState<McpMarketServer | null>(null)
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({})
  const [installTesting, setInstallTesting] = useState(false)
  const [installErrorMcp, setInstallErrorMcp] = useState<string | null>(null)
  const [installDone, setInstallDone] = useState<string | null>(null)
  const installCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recommendedRequested = useRef(false)
  const mcpRequestSequence = useRef(0)

  /** 检测占位符值（形如 <your-api-key>）：安装前需要用户填写 */
  const isPlaceholderValue = (v: string) => /^<.+>$/.test(v.trim())
  /** 密钥型字段名 → 输入框用密码形态 */
  const isSecretKey = (k: string) => /token|key|secret|password|authorization/i.test(k)

  const loadMcpMarket = useCallback(async () => {
    const sequence = ++mcpRequestSequence.current
    setMcpMarketLoading(true)
    setMcpMarketError(null)
    try {
      const result = await ipc.mcpSearch()
      if (sequence !== mcpRequestSequence.current) return
      if ('servers' in result && Array.isArray(result.servers)) {
        setMcpMarket(result.servers)
      } else {
        setMcpMarketError('error' in result ? result.error : t('mcpstore.loadFailed'))
        setMcpMarket([])
      }
    } catch (e) {
      if (sequence !== mcpRequestSequence.current) return
      setMcpMarketError(e instanceof Error ? e.message : String(e))
      setMcpMarket([])
    } finally {
      if (sequence === mcpRequestSequence.current) {
        setMcpMarketLoading(false)
        setMcpMarketLoaded(true)
      }
    }
  }, [t])

  // 切到 MCP tab 时首次拉取市场列表
  useEffect(() => {
    if (storeTab === 'mcp' && !mcpMarketLoaded && !mcpMarketLoading) {
      void loadMcpMarket()
    }
  }, [storeTab, mcpMarketLoaded, mcpMarketLoading, loadMcpMarket])

  useEffect(() => () => {
    if (installCloseTimer.current) clearTimeout(installCloseTimer.current)
    ++mcpRequestSequence.current
  }, [])

  // 市场条目是否已安装（按 market-<id> 匹配）
  const isMcpInstalled = (server: McpMarketServer): boolean =>
    (settings.mcpServers ?? []).some((s) => s.id === `market-${server.id}`)

  /** 打开安装预览弹窗：初始化密钥输入框（placeholder 项默认空） */
  const openMcpInstall = (server: McpMarketServer) => {
    if (installCloseTimer.current) clearTimeout(installCloseTimer.current)
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
    if (installCloseTimer.current) clearTimeout(installCloseTimer.current)
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
      const latestSettings = useSettingsStore.getState()
      const exists = (latestSettings.mcpServers ?? []).some((s) => s.id === config.id)
      latestSettings.updateSettings({
        mcpServers: exists
          ? (latestSettings.mcpServers ?? []).map((s) => (s.id === config.id ? config : s))
          : [...(latestSettings.mcpServers ?? []), config],
      })
      setInstallDone(t('mcpstore.testOk', { count: test.toolCount }))
      // 短暂展示成功状态后自动关闭
      installCloseTimer.current = setTimeout(() => {
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
    if (!recommendedRequested.current && recommendedSkills.length === 0 && !recommendedLoading) {
      recommendedRequested.current = true
      void loadRecommended()
    }
  }, [loadRecommended, recommendedSkills.length, recommendedLoading])

  const handleSearch = useCallback(() => {
    if (query.trim()) {
      void searchOnlineSkills(query.trim())
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

  const handleUninstall = async (id: string) => {
    setUninstallingIds((previous) => new Set(previous).add(id))
    setInstallError(null)
    try {
      await uninstallOnlineSkill(id, workingDir)
      if (useSkillsStore.getState().skills.some((skill) => skill.id === id)) {
        setInstallError(t('skillstore.uninstallFailed'))
      }
    } catch {
      setInstallError(t('skillstore.uninstallFailed'))
    } finally {
      setUninstallingIds((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    }
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
    if (storeTab === 'skills' && view === 'search') {
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
      setUploadError(t('skillstore.selectFileFailed'))
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

  const secondaryButton = 'md-focus inline-flex min-h-9 max-md:min-h-11 items-center justify-center gap-1.5 rounded-md3-sm border border-dark-onSurfaceVariant/10 bg-dark-surface px-3 py-2 text-ui-xs font-medium text-dark-onSurfaceVariant transition-colors hover:bg-dark-surfaceContainerHigh disabled:cursor-not-allowed disabled:opacity-50'
  const primaryButton = 'md-focus inline-flex min-h-9 max-md:min-h-11 items-center justify-center gap-1.5 rounded-md3-sm bg-md-primary px-3 py-2 text-ui-xs font-medium text-md-onPrimary transition-colors hover:bg-md-primary/90 disabled:cursor-not-allowed disabled:opacity-50'
  const iconButton = 'md-focus inline-flex h-9 w-9 max-md:h-11 max-md:w-11 shrink-0 items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant transition-colors hover:bg-dark-surfaceContainerHigh'
  const cardBase = 'flex min-w-0 flex-wrap items-start gap-4 rounded-md3-md border p-4 transition-colors hover:border-dark-onSurfaceVariant/20'
  const cardClass = `${cardBase} border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/40`
  const badgeClass = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-ui-xs font-medium'
  const inputClass = 'md-focus w-full min-w-0 rounded-md3-md border border-dark-onSurfaceVariant/20 bg-dark-surface px-3 py-2.5 text-ui-sm text-dark-onSurface outline-none transition-colors placeholder:text-dark-onSurfaceVariant/60 focus:border-md-primary focus:ring-1 focus:ring-md-primary/30 disabled:opacity-50'
  const installedCollapsed = view === 'home' ? installedCollapsedHome : installedCollapsedSearch
  const setInstalledCollapsed = view === 'home' ? setInstalledCollapsedHome : setInstalledCollapsedSearch

  const renderLoading = (label: string) => (
    <div role="status" className="flex items-center justify-center gap-3 rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/30 px-4 py-12 text-ui-sm text-dark-onSurfaceVariant">
      <Loader2 size={18} className="shrink-0 animate-spin" aria-hidden />{label}
    </div>
  )

  const renderRequestError = (label: string, error: string, retry: () => void) => (
    <div role="alert" className="mb-4 flex flex-wrap items-start gap-3 rounded-md3-md border border-md-error/20 bg-md-error/10 p-4 text-md-error">
      <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-ui-sm font-medium">{label}</p>
        {error !== 'MARKET_REQUEST_FAILED' && <p className="mt-1 break-words text-ui-xs leading-relaxed">{error}</p>}
      </div>
      <button type="button" onClick={retry} className={secondaryButton}><RefreshCw size={14} aria-hidden />{t('common.retry')}</button>
    </div>
  )

  const renderMPSkill = (mpSkill: SkillsMPSkill) => {
    const installed = isInstalled(mpSkill)
    const installing = isInstalling(mpSkill)
    const bssBadge = mpSkill.bssLevel ? BSS_LEVEL_BADGE[mpSkill.bssLevel] : undefined
    return (
      <article key={mpSkill.id} className={cardClass}>
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surface text-md-primary" aria-hidden>{renderSkillIcon(mpSkill.emoji, 18)}</span>
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-ui-sm font-semibold text-dark-onSurface">{mpSkill.titleCn || mpSkill.name}</h3>
            {mpSkill.titleCn && mpSkill.titleCn !== mpSkill.name && <p className="mt-0.5 break-words text-ui-xs text-dark-onSurfaceVariant">{mpSkill.name}</p>}
            <p className="mt-1.5 line-clamp-2 break-words text-ui-sm leading-relaxed text-dark-onSurfaceVariant">{mpSkill.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={`${badgeClass} bg-md-info/15 text-md-info`}>{t('skillstore.sourceCocoLoop')}</span>
              {bssBadge && <span className={`${badgeClass} ${bssBadge.className}`} title={`${t('skillstore.bssLevelLabel')}: ${bssBadge.label}`}><ShieldCheck size={12} aria-hidden />{bssBadge.label}</span>}
              {mpSkill.author && <span className="min-w-0 break-words text-ui-xs text-dark-onSurfaceVariant">{t('skillstore.authorBy', { author: mpSkill.author })}</span>}
            </div>
            {(mpSkill.downloads || mpSkill.installs || mpSkill.favorites) && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-ui-xs tabular-nums text-dark-onSurfaceVariant">
                {mpSkill.downloads && <span className="inline-flex items-center gap-1" title={t('skillstore.downloadsLabel')}><Download size={12} aria-hidden />{mpSkill.downloads}</span>}
                {mpSkill.installs && <span className="inline-flex items-center gap-1" title={t('skillstore.installsLabel')}><Check size={12} aria-hidden />{mpSkill.installs}</span>}
                {mpSkill.favorites && <span className="inline-flex items-center gap-1" title={t('skillstore.favoritesLabel')}><Star size={12} aria-hidden />{mpSkill.favorites}</span>}
              </div>
            )}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2 self-start">
          <button type="button" onClick={() => setDetailTarget({ kind: 'online', skill: mpSkill })} className={secondaryButton}><Info size={14} aria-hidden />{t('skillstore.details')}</button>
          {installed ? <span className="inline-flex min-h-9 items-center gap-1.5 px-2 text-ui-xs font-medium text-md-success"><Check size={14} aria-hidden />{t('common.installed')}</span> : (
            <button type="button" onClick={() => void handleInstall(mpSkill)} disabled={installing} className={primaryButton}>
              {installing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Download size={14} aria-hidden />}{installing ? t('common.installing') : t('common.install')}
            </button>
          )}
          <a href={mpSkill.skillUrl} target="_blank" rel="noopener noreferrer" className={iconButton} title={t('skillstore.viewOnSkillHub')} aria-label={t('skillstore.viewOnSkillHub')}><ExternalLink size={16} aria-hidden /></a>
        </div>
      </article>
    )
  }

  const renderInstalledSkill = (skill: SkillDefinition) => {
    const active = sessionSkillIds.includes(skill.id)
    const removable = skill.source === 'online' || skill.source === 'custom'
    const removing = uninstallingIds.has(skill.id)
    const badge = SOURCE_BADGE[skill.source]
    return (
      <article key={skill.id} className={`${cardBase} ${active ? 'border-md-primary/20 bg-md-primary/10' : 'border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/40'}`}>
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surface text-md-primary" aria-hidden>{renderSkillIcon(skill.icon, 18)}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="break-words text-ui-sm font-semibold text-dark-onSurface">{skill.name}</h3>
              {skill.version && <span className="text-ui-xs text-dark-onSurfaceVariant">v{skill.version}</span>}
              {active && <span className={`${badgeClass} bg-md-primary/15 text-md-primary`}><Check size={12} aria-hidden />{t('skillstore.loaded')}</span>}
            </div>
            <p className="mt-1.5 line-clamp-2 break-words text-ui-sm leading-relaxed text-dark-onSurfaceVariant">{skill.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {badge && <span className={`${badgeClass} ${badge.className}`}>{t(badge.labelKey)}</span>}
              {skill.author && <span className="break-words text-ui-xs text-dark-onSurfaceVariant">{t('skillstore.authorBy', { author: skill.author })}</span>}
            </div>
            {(skill.triggerKeywords?.length ?? 0) > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{skill.triggerKeywords.slice(0, 5).map((word) => <span key={word} className="max-w-full break-words rounded-md3-xs bg-dark-surface px-2 py-1 text-ui-xs text-dark-onSurfaceVariant">{word}</span>)}</div>}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setDetailTarget({ kind: 'installed', skill })} className={secondaryButton}><Info size={14} aria-hidden />{t('skillstore.details')}</button>
          {removable && <button type="button" onClick={() => setUninstallTarget(skill.id)} disabled={removing} className={`${iconButton} hover:bg-md-error/10 hover:text-md-error disabled:opacity-50`} title={t('common.uninstall')} aria-label={`${t('common.uninstall')} ${skill.name}`}>{removing ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={16} aria-hidden />}</button>}
        </div>
      </article>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-dark-surface text-dark-onSurface">
      <header className="shrink-0 border-b border-dark-onSurfaceVariant/10 px-6 pt-6 max-md:px-4 max-md:pt-4">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1 basis-64">
              <div className="flex items-center gap-2.5"><Store size={22} className="shrink-0 text-md-primary" aria-hidden /><h1 className="text-ui-xl font-semibold">{t('skillstore.title')}</h1></div>
              <p className="mt-2 max-w-2xl text-ui-sm leading-relaxed text-dark-onSurfaceVariant">{storeTab === 'skills' ? t('skillstore.subtitle') : t('mcpstore.marketSubtitle')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {storeTab === 'skills' ? <button type="button" onClick={openUploadModal} className={secondaryButton}><Upload size={14} aria-hidden />{t('skillstore.loadCustom')}</button> : <button type="button" onClick={() => void loadMcpMarket()} disabled={mcpMarketLoading} className={secondaryButton}><RefreshCw size={14} className={mcpMarketLoading ? 'animate-spin' : ''} aria-hidden />{t('mcpstore.retry')}</button>}
              <button type="button" onClick={handleBack} className={secondaryButton}><ArrowLeft size={14} aria-hidden />{storeTab === 'skills' && view === 'search' ? t('skillstore.backToRecommend') : t('skillstore.backToChat')}</button>
            </div>
          </div>
          <nav className="mt-5 flex gap-1" aria-label={t('skillstore.title')}>
            {(['skills', 'mcp'] as const).map((tab) => (
              <button key={tab} type="button" onClick={() => setStoreTab(tab)} aria-pressed={storeTab === tab} className={`md-focus -mb-px inline-flex min-h-11 items-center justify-center gap-2 border-b-2 px-4 py-3 text-ui-sm font-medium transition-colors ${storeTab === tab ? 'border-md-primary text-md-primary' : 'border-transparent text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer/50'}`}>
                {tab === 'skills' ? <Zap size={16} aria-hidden /> : <Plug size={16} aria-hidden />}{t(tab === 'skills' ? 'skillstore.tabSkills' : 'skillstore.tabMcp')}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 max-md:px-4">
        <div className="mx-auto max-w-5xl space-y-6">
          {storeTab === 'skills' ? (
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); handleSearch() }} role="search">
              <div className="relative min-w-0 flex-1">
                <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dark-onSurfaceVariant" aria-hidden />
                <input id="skill-store-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} placeholder={t('skillstore.searchPlaceholder')} className={`${inputClass} pl-11`} />
                <label htmlFor="skill-store-search" className="sr-only">{t('skillstore.search')}</label>
              </div>
              <button type="submit" disabled={searchLoading || !query.trim()} className={`${primaryButton} px-4 text-ui-sm`}>{searchLoading ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Search size={16} aria-hidden />}{t('skillstore.search')}</button>
            </form>
          ) : (
            <div role="search" className="relative">
              <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dark-onSurfaceVariant" aria-hidden />
              <input id="mcp-store-search" type="search" value={mcpQuery} onChange={(event) => setMcpQuery(event.target.value)} placeholder={t('mcpstore.searchPlaceholder')} className={`${inputClass} pl-11`} />
              <label htmlFor="mcp-store-search" className="sr-only">{t('mcpstore.searchPlaceholder')}</label>
            </div>
          )}

          {storeTab === 'skills' && <>
            {installError && <div role="alert" className="flex items-start gap-3 rounded-md3-md border border-md-error/20 bg-md-error/10 p-4 text-ui-sm text-md-error"><AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden /><span className="min-w-0 flex-1 break-words">{installError}</span><button type="button" onClick={() => setInstallError(null)} className="md-focus inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md3-xs hover:bg-md-error/10" aria-label={t('common.close')}><X size={16} aria-hidden /></button></div>}
            {installedSkills.length > 0 && <section>
              <button type="button" onClick={() => setInstalledCollapsed(!installedCollapsed)} aria-expanded={!installedCollapsed} aria-controls="installed-skills" className="md-focus mb-3 flex min-h-9 w-full items-center gap-2 rounded-md3-sm py-1 text-left text-ui-sm font-semibold text-dark-onSurface">
                {installedCollapsed ? <ChevronRight size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}<Check size={16} className="text-md-success" aria-hidden />{t('skillstore.installedCount', { count: installedSkills.length })}
              </button>
              {!installedCollapsed && <div id="installed-skills" className="grid gap-3">{installedSkills.map(renderInstalledSkill)}</div>}
            </section>}
            {view === 'home' ? <section aria-busy={recommendedLoading}>
              <h2 className="mb-3 flex items-center gap-2 text-ui-sm font-semibold"><TrendingUp size={16} className="text-md-primary" aria-hidden />{t('skillstore.recommended')}</h2>
              {recommendedError && renderRequestError(t('skillstore.recommendedFailed'), recommendedError, () => void loadRecommended())}
              {recommendedLoading && recommendedSkills.length === 0 ? renderLoading(t('skillstore.loadingRecommended')) : recommendedSkills.length > 0 ? <div className="grid gap-3">{recommendedSkills.map(renderMPSkill)}</div> : !recommendedError && <div className="rounded-md3-md border border-dashed border-dark-onSurfaceVariant/20 px-4 py-14 text-center"><Store size={32} className="mx-auto mb-3 text-dark-onSurfaceVariant/60" aria-hidden /><p className="text-ui-sm font-medium">{t('skillstore.emptyTitle')}</p><p className="mt-2 text-ui-sm text-dark-onSurfaceVariant">{t('skillstore.emptyHint')}</p></div>}
            </section> : <section aria-busy={searchLoading}>
              <h2 className="mb-3 flex flex-wrap items-center gap-2 text-ui-sm font-semibold"><Search size={16} className="text-md-primary" aria-hidden />{t('skillstore.searchResults')}{searchTotal > 0 && <span className="font-normal text-dark-onSurfaceVariant">{t('skillstore.searchTotal', { count: searchTotal })}</span>}</h2>
              {searchError && renderRequestError(t('skillstore.searchFailed'), searchError, () => void searchOnlineSkills(searchQuery, searchResults.length > 0 ? searchPage + 1 : 1))}
              {searchLoading && searchResults.length === 0 ? renderLoading(t('skillstore.searching')) : searchResults.length > 0 ? <div className="grid gap-3">{searchResults.map(renderMPSkill)}</div> : !searchError && <div className="rounded-md3-md border border-dashed border-dark-onSurfaceVariant/20 px-4 py-14 text-center"><SearchX size={32} className="mx-auto mb-3 text-dark-onSurfaceVariant/60" aria-hidden /><p className="text-ui-sm font-medium">{t('skillstore.noResultsTitle', { query: searchQuery })}</p><p className="mt-2 text-ui-sm text-dark-onSurfaceVariant">{t('skillstore.noResultsHint')}</p></div>}
              {searchHasNext && <div className="mt-5 flex justify-center"><button type="button" onClick={() => void searchOnlineSkills(searchQuery, searchPage + 1)} disabled={searchLoading} className={secondaryButton}>{searchLoading && <Loader2 size={14} className="animate-spin" aria-hidden />}{t('skillstore.loadMore')}</button></div>}
            </section>}
          </>}
          {storeTab === 'mcp' && <>
            {(settings.mcpServers ?? []).length > 0 && <section>
              <button type="button" onClick={() => setInstalledMcpCollapsed(!installedMcpCollapsed)} aria-expanded={!installedMcpCollapsed} aria-controls="installed-mcp-servers" className="md-focus mb-3 flex min-h-9 w-full items-center gap-2 rounded-md3-sm py-1 text-left text-ui-sm font-semibold">
                {installedMcpCollapsed ? <ChevronRight size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}<Check size={16} className="text-md-success" aria-hidden />{t('mcpstore.installedSection', { count: (settings.mcpServers ?? []).length })}
              </button>
              {!installedMcpCollapsed && <div id="installed-mcp-servers" className="grid gap-3">
                {(settings.mcpServers ?? []).map((server) => {
                  const status = mcpStatuses.find((entry) => entry.id === server.id)
                  const state = !server.enabled ? 'disabled' : status?.state ?? 'connecting'
                  const statusClass = state === 'connected' ? 'bg-md-success' : state === 'connecting' ? 'bg-md-warning' : state === 'error' ? 'bg-md-error' : 'bg-dark-onSurfaceVariant/40'
                  return <article key={server.id} className={cardClass}>
                    <div className="min-w-0 flex-1 basis-64">
                      <div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-ui-sm font-semibold">{server.name}</h3><span className={`${badgeClass} bg-dark-surface text-dark-onSurfaceVariant`}>{t(server.transport === 'stdio' ? 'mcpstore.connStdio' : 'mcpstore.connHttp')}</span></div>
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-ui-xs text-dark-onSurfaceVariant"><span className={`h-2 w-2 shrink-0 rounded-full ${statusClass}`} aria-hidden />{t(`mcpstore.state${state.charAt(0).toUpperCase()}${state.slice(1)}`)}{state === 'connected' && status && status.toolCount > 0 && <span>· {t('mcpstore.toolsBadge', { count: status.toolCount })}</span>}</p>
                      {state === 'error' && status?.error && <p className="mt-2 break-words text-ui-xs leading-relaxed text-md-error">{status.error}</p>}
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      <button type="button" onClick={() => toggleMcpEnabled(server.id)} aria-pressed={server.enabled} className={server.enabled ? primaryButton : secondaryButton}>{server.enabled ? <Check size={14} aria-hidden /> : <Zap size={14} aria-hidden />}{t(server.enabled ? 'skillstore.loaded' : 'skillstore.load')}</button>
                      <button type="button" onClick={() => setRemovingMcpId(server.id)} className={`${iconButton} hover:bg-md-error/10 hover:text-md-error`} title={t('common.uninstall')} aria-label={`${t('common.uninstall')} ${server.name}`}><Trash2 size={16} aria-hidden /></button>
                    </div>
                  </article>
                })}
              </div>}
            </section>}
            <section aria-busy={mcpMarketLoading}>
              <h2 className="mb-3 flex items-center gap-2 text-ui-sm font-semibold"><TrendingUp size={16} className="text-md-primary" aria-hidden />{t('mcpstore.marketTitle')}</h2>
              {mcpMarketError && renderRequestError(t('mcpstore.loadFailed'), mcpMarketError, () => void loadMcpMarket())}
              {mcpMarketLoading && mcpMarket.length === 0 ? renderLoading(t('mcpstore.marketLoading')) : filteredMcpMarket.length === 0 ? !mcpMarketError && <div className="rounded-md3-md border border-dashed border-dark-onSurfaceVariant/20 px-4 py-14 text-center"><SearchX size={32} className="mx-auto mb-3 text-dark-onSurfaceVariant/60" aria-hidden /><p className="text-ui-sm text-dark-onSurfaceVariant">{t('mcpstore.noResults')}</p></div> : <div className="grid gap-3">{filteredMcpMarket.map((server) => <article key={server.id} className={cardClass}>
                <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surface text-md-primary" aria-hidden>{server.logo ? <img src={server.logo} alt="" className="h-6 w-6 object-contain" loading="lazy" /> : <Package size={18} />}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words text-ui-sm font-semibold">{server.name}</h3>
                    {server.qualifiedName && server.qualifiedName !== server.name && <p className="mt-0.5 break-all text-ui-xs text-dark-onSurfaceVariant">{server.qualifiedName}</p>}
                    <p className="mt-1.5 line-clamp-2 break-words text-ui-sm leading-relaxed text-dark-onSurfaceVariant">{server.description}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2"><span className={`${badgeClass} bg-md-info/15 text-md-info`}>{t('mcpstore.sourceMcpHub')}</span>{server.isDomestic && <span className={`${badgeClass} bg-md-success/15 text-md-success`}>{t('mcpstore.domestic')}</span>}<span className="inline-flex items-center gap-1 text-ui-xs tabular-nums text-dark-onSurfaceVariant" title={t('mcpstore.useCountLabel')}><TrendingUp size={12} aria-hidden />{(server.useCount / 1000).toFixed(1)}k</span></div>
                    {server.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{server.tags.slice(0, 4).map((tag) => <span key={tag} className="max-w-full break-words rounded-md3-xs bg-dark-surface px-2 py-1 text-ui-xs text-dark-onSurfaceVariant">{tag}</span>)}</div>}
                  </div>
                </div>
                <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
                  {isMcpInstalled(server) ? <span className="inline-flex min-h-9 items-center gap-1.5 px-2 text-ui-xs font-medium text-md-success"><Check size={14} aria-hidden />{t('common.installed')}</span> : server.connection ? <button type="button" onClick={() => openMcpInstall(server)} className={primaryButton}><Download size={14} aria-hidden />{t('common.install')}</button> : <span className="inline-flex min-h-9 items-center text-ui-xs text-dark-onSurfaceVariant">{t('mcpstore.noConnection')}</span>}
                  {server.packageUrl && <a href={server.packageUrl} target="_blank" rel="noopener noreferrer" className={iconButton} title={t('mcpstore.viewSource')} aria-label={`${t('mcpstore.viewSource')} ${server.name}`}><ExternalLink size={16} aria-hidden /></a>}
                </div>
              </article>)}</div>}
            </section>
          </>}
        </div>
      </div>
      {showUploadModal && <Modal title={t('skillstore.uploadTitle')} titleIcon={<Upload size={18} />} onClose={closeUploadModal} footer={<>
        <button type="button" onClick={closeUploadModal} disabled={uploadLoading} className={secondaryButton}>{t('common.cancel')}</button>
        <button type="button" onClick={() => void confirmUpload()} disabled={!uploadFilePath || uploadLoading} className={primaryButton}>{uploadLoading && <Loader2 size={14} className="animate-spin" aria-hidden />}{t('skillstore.confirmUpload')}</button>
      </>}>
        <button type="button" onClick={() => void selectFile()} disabled={uploadLoading} className="md-focus flex min-h-40 w-full flex-col items-center justify-center gap-3 rounded-md3-md border-2 border-dashed border-dark-onSurfaceVariant/20 bg-dark-surfaceContainer/30 px-5 py-8 transition-colors hover:border-md-primary/50 hover:bg-md-primary/5 disabled:cursor-not-allowed disabled:opacity-50">
          {uploadFileName ? <FileText size={30} className="text-md-primary" aria-hidden /> : <FileArchive size={30} className="text-dark-onSurfaceVariant" aria-hidden />}
          <span className="max-w-full break-all text-ui-sm font-medium">{uploadFileName || t('skillstore.uploadHint')}</span>
        </button>
        <ul className="list-disc space-y-2 pl-5 text-ui-sm leading-relaxed text-dark-onSurfaceVariant"><li>{t('skillstore.uploadReq1')}</li><li>{t('skillstore.uploadReq2')}</li></ul>
        {uploadError && <div role="alert" className="rounded-md3-sm border border-md-error/20 bg-md-error/10 px-3 py-2 text-ui-sm text-md-error">{uploadError}</div>}
      </Modal>}

      {detailTarget && (() => {
        const mp = detailTarget.kind === 'online' ? detailTarget.skill : null
        const inst = detailTarget.kind === 'installed' ? detailTarget.skill : null
        const badge = inst ? SOURCE_BADGE[inst.source] : undefined
        const bssBadge = mp?.bssLevel ? BSS_LEVEL_BADGE[mp.bssLevel] : undefined
        const author = mp?.author || inst?.author
        return <Modal title={mp ? mp.titleCn || mp.name : inst?.name || t('skillstore.details')} description={mp?.titleCn && mp.titleCn !== mp.name ? mp.name : undefined} titleIcon={<Package size={18} />} onClose={() => setDetailTarget(null)} widthClass="w-[640px]" footer={<>
          {mp && <a href={mp.skillUrl} target="_blank" rel="noopener noreferrer" className={secondaryButton}><ExternalLink size={14} aria-hidden />{t('skillstore.viewOnSkillHub')}</a>}
          <button type="button" onClick={() => setDetailTarget(null)} className={primaryButton}>{t('common.close')}</button>
        </>}>
          <div className="flex flex-wrap items-center gap-2 text-ui-xs text-dark-onSurfaceVariant">
            {author && <span className="break-words">{t('skillstore.authorBy', { author })}</span>}{inst?.version && <span>v{inst.version}</span>}
            <span className={`${badgeClass} ${badge?.className || 'bg-md-info/15 text-md-info'}`}>{t(badge?.labelKey || 'skillstore.sourceCocoLoop')}</span>
            {bssBadge && <span className={`${badgeClass} ${bssBadge.className}`} title={t('skillstore.bssLevelLabel')}><ShieldCheck size={12} aria-hidden />{bssBadge.label}</span>}
          </div>
          <p className="whitespace-pre-wrap break-words text-ui-sm leading-relaxed text-dark-onSurfaceVariant">{mp?.description || inst?.description}</p>
          {mp && <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-dark-onSurfaceVariant/10 pt-4 text-ui-xs text-dark-onSurfaceVariant">
            {mp.downloads && <span className="inline-flex items-center gap-1.5"><Download size={14} aria-hidden />{t('skillstore.downloadsLabel')} {mp.downloads}</span>}
            {mp.installs && <span className="inline-flex items-center gap-1.5"><Check size={14} aria-hidden />{t('skillstore.installsLabel')} {mp.installs}</span>}
            {mp.favorites && <span className="inline-flex items-center gap-1.5"><Star size={14} aria-hidden />{t('skillstore.favoritesLabel')} {mp.favorites}</span>}
            {mp.updatedAt && <span>{t('skillstore.detailUpdated')} {mp.updatedAt}</span>}
          </div>}
          {inst && (inst.triggerKeywords?.length ?? 0) > 0 && <section><h3 className="mb-2 text-ui-sm font-medium">{t('skillstore.detailKeywords')}</h3><div className="flex flex-wrap gap-2">{inst.triggerKeywords.map((word) => <span key={word} className="max-w-full break-words rounded-md3-xs bg-dark-surfaceContainer px-2 py-1 text-ui-xs text-dark-onSurfaceVariant">{word}</span>)}</div></section>}
          {inst?.warnings && inst.warnings.length > 0 && <section className="rounded-md3-md border border-md-warning/20 bg-md-warning/10 p-4"><h3 className="mb-2 flex items-center gap-2 text-ui-sm font-medium text-md-warning"><AlertTriangle size={16} aria-hidden />{t('skillstore.detailWarnings')}</h3><ul className="list-disc space-y-2 pl-4 text-ui-sm leading-relaxed text-dark-onSurfaceVariant">{inst.warnings.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}</ul></section>}
        </Modal>
      })()}
      {installTarget && <Modal title={installTarget.name} description={installTarget.qualifiedName || t('mcpstore.installTitle')} titleIcon={<Plug size={18} />} onClose={closeMcpInstall} widthClass="w-[640px]" footer={<>
        <button type="button" onClick={closeMcpInstall} disabled={installTesting} className={secondaryButton}>{t(installDone ? 'common.close' : 'common.cancel')}</button>
        {!installDone && <button type="button" onClick={() => void confirmMcpInstall()} disabled={installTesting} className={primaryButton}>{installTesting && <Loader2 size={14} className="animate-spin" aria-hidden />}{t(installTesting ? 'mcpstore.testing' : 'mcpstore.confirmInstall')}</button>}
      </>}>
        <p className="text-ui-sm leading-relaxed text-dark-onSurfaceVariant">{installTarget.description}</p>
        {installTarget.connection && <>
          <section className="rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/40 p-4">
            <h3 className="mb-3 flex items-center gap-2 text-ui-sm font-medium"><Plug size={16} className="text-md-primary" aria-hidden />{t(installTarget.connection.type === 'stdio' ? 'mcpstore.connStdio' : 'mcpstore.connHttp')}</h3>
            <p className="text-ui-xs text-dark-onSurfaceVariant">{t(installTarget.connection.type === 'stdio' ? 'mcpstore.commandLabel' : 'mcpstore.urlLabel')}</p>
            <code className="mt-2 block break-all rounded-md3-sm bg-dark-surface px-3 py-2 font-mono text-ui-xs leading-relaxed">{installTarget.connection.type === 'stdio' ? [installTarget.connection.command, ...(installTarget.connection.args ?? [])].filter(Boolean).join(' ') : installTarget.connection.url}</code>
          </section>
          {(() => {
            const groups = [
              { kind: 'env', label: t('mcpstore.envLabel'), entries: Object.entries(installTarget.connection?.env ?? {}) },
              { kind: 'headers', label: t('mcpstore.headersLabel'), entries: Object.entries(installTarget.connection?.headers ?? {}) },
            ]
            const required = groups.flatMap((group) => group.entries.filter(([, value]) => isPlaceholderValue(value)).map(([key]) => ({ kind: group.kind, key })))
            return <>
              {required.length > 0 && <section>
                <h3 className="mb-3 flex items-center gap-2 text-ui-sm font-medium"><AlertTriangle size={16} className="text-md-warning" aria-hidden />{t('mcpstore.secretsTitle')}</h3>
                <div className="space-y-3">{required.map(({ kind, key }) => <label key={`${kind}.${key}`} className="block">
                  <span className="mb-1.5 block break-all font-mono text-ui-xs text-dark-onSurfaceVariant">{key}</span>
                  <input type={isSecretKey(key) ? 'password' : 'text'} value={secretInputs[`${kind}.${key}`] ?? ''} onChange={(event) => setSecretInputs((previous) => ({ ...previous, [`${kind}.${key}`]: event.target.value }))} disabled={installTesting || !!installDone} autoComplete="off" spellCheck={false} className={inputClass} />
                </label>)}</div>
              </section>}
              {groups.map((group) => {
                const plain = group.entries.filter(([, value]) => !isPlaceholderValue(value))
                return plain.length > 0 && <section key={group.kind}><h3 className="mb-2 text-ui-sm font-medium">{group.label}</h3><div className="space-y-2 rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/40 p-3">{plain.map(([key, value]) => <p key={key} className="break-all font-mono text-ui-xs leading-relaxed text-dark-onSurfaceVariant"><span className="font-medium text-dark-onSurface">{key}</span>={isSecretKey(key) ? '••••••••' : value}</p>)}</div></section>
              })}
            </>
          })()}
        </>}
        {installDone && <div role="status" className="flex items-center gap-2 rounded-md3-md border border-md-success/20 bg-md-success/10 px-3 py-3 text-ui-sm text-md-success"><Check size={16} className="shrink-0" aria-hidden />{installDone}</div>}
        {installErrorMcp && !installDone && <div role="alert" className="break-words rounded-md3-md border border-md-error/20 bg-md-error/10 px-3 py-3 text-ui-sm text-md-error">{installErrorMcp}</div>}
        <p className="text-ui-xs leading-relaxed text-dark-onSurfaceVariant">{t('mcpstore.installNote')}</p>
      </Modal>}

      {uninstallTarget && <ConfirmDialog title={t('skillstore.uninstallConfirmTitle')} message={t('skillstore.uninstallConfirmMsg', { name: skills.find((skill) => skill.id === uninstallTarget)?.name ?? uninstallTarget })} confirmText={t('common.uninstall')} cancelText={t('common.cancel')} variant="danger" onConfirm={() => { void handleUninstall(uninstallTarget); setUninstallTarget(null) }} onCancel={() => setUninstallTarget(null)} />}
      {removingMcpId && <ConfirmDialog title={t('mcpstore.removeTitle')} message={t('mcpstore.removeConfirm')} confirmText={t('common.delete')} cancelText={t('common.cancel')} variant="danger" onConfirm={() => { removeMcpServer(removingMcpId); setRemovingMcpId(null) }} onCancel={() => setRemovingMcpId(null)} />}
    </div>
  )
}
