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
  Package,
  SearchX,
  AlertTriangle,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSkillsStore } from '../../stores/skills-store'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'
import { ipc } from '../../lib/ipc-client'
import type { SkillsMPSkill } from '../../types/skills'

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
    toggleSessionSkill,
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
    try {
      await installOnlineSkill(mpSkill)
    } catch (e) {
      console.error('Install skill failed:', e)
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
    <div className="flex flex-col h-full bg-dark-surface">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-dark-onSurfaceVariant/10">
        <Store size={22} className="text-md-primary" />
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-dark-onSurface">{t('skillstore.title')}</h1>
          <p className="text-xs text-dark-onSurfaceVariant/50">{t('skillstore.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            ref={uploadTriggerRef}
            type="button"
            onClick={openUploadModal}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm text-dark-onSurfaceVariant"
          >
            <Upload size={14} />
            {t('skillstore.loadCustom')}
          </button>
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
      <div className="px-6 py-4">
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-md mx-auto">
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
                          {skill.warnings && skill.warnings.length > 0 && (
                            <p className="text-[10px] text-md-warning/80 mt-0.5 truncate flex items-center gap-1" title={skill.warnings.join('\n')}>
                              <AlertTriangle size={10} className="flex-shrink-0" />
                              <span className="truncate">{skill.warnings[0]}{skill.warnings.length > 1 ? t('skillstore.warningsSuffix', { count: skill.warnings.length }) : ''}</span>
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
                          <button
                            type="button"
                            onClick={() => toggleSessionSkill(skill.id, workingDir)}
                            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex-shrink-0 ${
                              isActive
                                ? 'bg-md-primary text-md-onPrimary hover:bg-md-primary/90'
                                : 'bg-dark-surfaceContainer hover:bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant'
                            }`}
                          >
                            {isActive ? <Check size={11} /> : <Zap size={11} />}
                            {isActive ? t('skillstore.loaded') : t('skillstore.load')}
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
                              onClick={() => toggleSessionSkill(skill.id, workingDir)}
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex-shrink-0 ${
                                isActive
                                  ? 'bg-md-primary text-md-onPrimary hover:bg-md-primary/90'
                                  : 'bg-dark-surfaceContainer hover:bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant'
                              }`}
                            >
                              {isActive ? <Check size={11} /> : <Zap size={11} />}
                              {isActive ? t('skillstore.loaded') : t('skillstore.load')}
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
    </div>
  )
}
