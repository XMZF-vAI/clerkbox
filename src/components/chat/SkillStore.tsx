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
} from 'lucide-react'
import { useSkillsStore } from '../../stores/skills-store'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'
import type { SkillsMPSkill } from '../../types/skills'

/**
 * Full-page Skill Store that replaces the chat area.
 * Features: recommended skills + search + installed management.
 */
export default function SkillStore() {
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
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [uploadFilePath, setUploadFilePath] = useState<string | null>(null)
  const [uploadFileName, setUploadFileName] = useState<string | null>(null)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const currentSession = sessions.find((s) => s.id === activeSessionId)
  const workingDir = currentSession?.workingDir || currentSession?.defaultWorkDir || ''

  const installedSkills = skills.filter((s) => s.source === 'online' || s.source === 'custom')

  // Load recommended on mount
  useEffect(() => {
    if (recommendedSkills.length === 0) {
      loadRecommended()
    }
  }, [])

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
    setIsDragging(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openUploadModal = () => {
    resetUpload()
    setShowUploadModal(true)
  }

  const closeUploadModal = () => {
    setShowUploadModal(false)
    resetUpload()
  }

  const selectFile = async () => {
    setUploadError(null)
    const filePath = await window.clerkbox.selectSkillFile()
    if (!filePath) return
    const name = filePath.replace(/\\/g, '/').split('/').pop() || filePath
    setUploadFilePath(filePath)
    setUploadFileName(name)
  }

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const name = file.name
    const ext = name.split('.').pop()?.toLowerCase()
    if (ext !== 'skill' && ext !== 'zip') {
      setUploadError('仅支持 .skill 或 .zip 文件')
      return
    }
    // 拖拽文件无法直接拿到 Electron 主进程需要的绝对路径，提示用户点击选择
    setUploadError('请通过点击选择文件上传（浏览器安全限制无法获取拖拽文件路径）')
  }

  const confirmUpload = async () => {
    if (!uploadFilePath) return
    setUploadLoading(true)
    setUploadError(null)
    const result = await installCustomSkill(uploadFilePath)
    setUploadLoading(false)
    if (result.success) {
      closeUploadModal()
    } else {
      setUploadError(result.error || '安装失败')
    }
  }

  // ── Shared skill card renderer ──
  const renderMPSkill = (mpSkill: SkillsMPSkill, showInstall = true) => {
    const installed = isInstalled(mpSkill)
    const installing = isInstalling(mpSkill)
    return (
      <div
        key={mpSkill.id}
        className="flex items-start gap-3 px-4 py-3 rounded-xl border bg-dark-surfaceContainerHigh/30 border-dark-onSurfaceVariant/5 hover:border-dark-onSurfaceVariant/15 transition-all"
      >
        <div className="w-9 h-9 rounded-lg bg-dark-surfaceContainer flex items-center justify-center text-lg flex-shrink-0 mt-0.5">
          ⚡
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-dark-onSurface">{mpSkill.name}</span>
            <span className="text-[10px] text-dark-onSurfaceVariant/30">by {mpSkill.author}</span>
            {mpSkill.stars > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-md-warning/70">
                <Star size={9} className="fill-md-warning/70" /> {mpSkill.stars}
              </span>
            )}
          </div>
          <p className="text-xs text-dark-onSurfaceVariant/50 mt-0.5 line-clamp-2">
            {mpSkill.description}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
          {showInstall && (
            installed ? (
              <span className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-md-success/15 text-md-success">
                <Check size={11} /> 已安装
              </span>
            ) : (
              <button
                onClick={() => handleInstall(mpSkill)}
                disabled={installing}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-md-primary/15 text-md-primary hover:bg-md-primary/25 disabled:opacity-40 transition-all"
              >
                {installing ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                {installing ? '安装中' : '安装'}
              </button>
            )
          )}
          <a
            href={mpSkill.skillUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-lg hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant/30 hover:text-dark-onSurfaceVariant transition-all"
            title="在 SkillHub 查看"
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
          <h1 className="text-lg font-semibold text-dark-onSurface">技能商店</h1>
          <p className="text-xs text-dark-onSurfaceVariant/50">浏览、安装技能，增强 AI 能力</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openUploadModal}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm text-dark-onSurfaceVariant"
          >
            <Upload size={14} />
            加载自定义技能
          </button>
          <button
            onClick={handleBack}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm text-dark-onSurfaceVariant"
          >
            <ArrowLeft size={14} />
            {view === 'search' ? '返回推荐' : '返回对话'}
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="px-6 py-4">
        <div className="max-w-md mx-auto flex gap-2">
          <div className="flex-1 relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dark-onSurfaceVariant/40" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="搜索在线技能（SkillHub）..."
              className="w-full pl-9 pr-4 py-2.5 rounded-md3-md bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 focus:border-md-primary/50 focus:ring-1 focus:ring-md-primary/30 outline-none transition-all text-sm placeholder:text-dark-onSurfaceVariant/30"
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={searchLoading || !query.trim()}
            className="px-5 py-2.5 rounded-md3-md bg-md-primary hover:bg-md-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm text-md-onPrimary font-medium flex items-center gap-1.5"
          >
            {searchLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            搜索
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-md mx-auto">
          {/* ── INSTALLED SECTION (always visible at top) ── */}
          {installedSkills.length > 0 && (
            <div className="mb-6">
              <h3 className="flex items-center gap-2 text-sm font-medium text-md-success mb-3">
                <Check size={14} />
                已安装 ({installedSkills.length})
              </h3>
              <div className="grid gap-2 w-full">
                {installedSkills.map((skill) => {
                  const isActive = sessionSkillIds.includes(skill.id)
                  return (
                    <div
                      key={skill.id}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all max-w-full overflow-hidden ${
                        isActive
                          ? 'bg-md-primary/8 border-md-primary/20'
                          : 'bg-dark-surfaceContainerHigh/50 border-dark-onSurfaceVariant/5'
                      }`}
                    >
                      <span className="text-xl flex-shrink-0">{skill.icon}</span>
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <span className="text-sm font-medium text-dark-onSurface block truncate">{skill.name}</span>
                        <p className="text-xs text-dark-onSurfaceVariant/50 truncate">{skill.description}</p>
                        {skill.warnings && skill.warnings.length > 0 && (
                          <p className="text-[10px] text-md-warning/80 mt-0.5 truncate" title={skill.warnings.join('\n')}>
                            ⚠️ {skill.warnings[0]}{skill.warnings.length > 1 ? ` 等 ${skill.warnings.length} 条提示` : ''}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => toggleSessionSkill(skill.id, workingDir)}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all flex-shrink-0 ${
                          isActive
                            ? 'bg-md-primary text-md-onPrimary hover:bg-md-primary/90'
                            : 'bg-dark-surfaceContainer hover:bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant'
                        }`}
                      >
                        {isActive ? <Check size={11} /> : <Zap size={11} />}
                        {isActive ? '已加载' : '加载'}
                      </button>
                      <button
                        onClick={() => handleUninstall(skill.id)}
                        className="p-1.5 rounded-lg hover:bg-md-error/10 text-dark-onSurfaceVariant/40 hover:text-md-error transition-all flex-shrink-0"
                        title="卸载"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── HOME VIEW: Recommended ── */}
          {view === 'home' && (
            <div>
              <h3 className="flex items-center gap-2 text-sm font-medium text-dark-onSurfaceVariant mb-3">
                <TrendingUp size={14} className="text-md-primary" />
                推荐技能
              </h3>
              {recommendedLoading && recommendedSkills.length === 0 ? (
                <div className="flex items-center justify-center py-12 gap-2 text-dark-onSurfaceVariant/40">
                  <Loader2 size={20} className="animate-spin" />
                  <span className="text-sm">加载推荐...</span>
                </div>
              ) : recommendedSkills.length > 0 ? (
                <div className="grid gap-2 w-full">
                  {recommendedSkills.map((mpSkill) => renderMPSkill(mpSkill))}
                </div>
              ) : (
                <div className="text-center py-16">
                  <div className="text-4xl mb-3">🏪</div>
                  <p className="text-sm text-dark-onSurfaceVariant/40 mb-1">搜索技能开始使用</p>
                  <p className="text-xs text-dark-onSurfaceVariant/25">
                    从 SkillHub 市场搜索 AI 技能
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── SEARCH VIEW ── */}
          {view === 'search' && (
            <div className="space-y-4">
              {searchLoading && (
                <div className="flex items-center justify-center py-12 gap-2 text-dark-onSurfaceVariant/40">
                  <Loader2 size={20} className="animate-spin" />
                  <span className="text-sm">搜索中...</span>
                </div>
              )}

              {!searchLoading && searchResults.length > 0 && (
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-medium text-dark-onSurfaceVariant mb-3">
                    <Search size={14} />
                    搜索结果 {searchTotal > 0 && `(共 ${searchTotal} 个)`}
                  </h3>
                  <div className="grid gap-2 w-full">
                    {searchResults.map((mpSkill) => renderMPSkill(mpSkill))}
                  </div>

                  {searchHasNext && (
                    <div className="flex justify-center mt-4">
                      <button
                        onClick={() => searchOnlineSkills(searchQuery, searchPage + 1)}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm text-dark-onSurfaceVariant"
                      >
                        加载更多
                      </button>
                    </div>
                  )}
                </div>
              )}

              {!searchLoading && searchResults.length === 0 && searchQuery && (
                <div className="text-center py-16">
                  <div className="text-4xl mb-3">🤷</div>
                  <p className="text-sm text-dark-onSurfaceVariant/40 mb-1">未找到 "{searchQuery}" 相关技能</p>
                  <p className="text-xs text-dark-onSurfaceVariant/25">试试其他关键词</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── 上传自定义技能弹窗 ── */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-xl bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 shadow-2xl p-5 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-dark-onSurface">上传技能</h3>
              <button
                onClick={closeUploadModal}
                className="p-1 rounded-md3-sm hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant/60 transition-colors"
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </div>

            <div
              onClick={selectFile}
              onDrop={handleFileDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              className={`relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 cursor-pointer transition-colors ${
                isDragging
                  ? 'border-md-primary bg-md-primary/5'
                  : 'border-dark-onSurfaceVariant/25 hover:border-dark-onSurfaceVariant/40 bg-dark-surfaceDim/50'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".skill,.zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const ext = file.name.split('.').pop()?.toLowerCase()
                  if (ext !== 'skill' && ext !== 'zip') {
                    setUploadError('仅支持 .skill 或 .zip 文件')
                    return
                  }
                  setUploadError('请通过点击选择文件上传（浏览器安全限制无法获取文件路径）')
                }}
              />
              {uploadFileName ? (
                <>
                  <FileText size={32} className="text-md-primary" />
                  <span className="text-sm text-dark-onSurface font-medium">{uploadFileName}</span>
                </>
              ) : (
                <>
                  <FileArchive size={32} className="text-dark-onSurfaceVariant/50" />
                  <span className="text-sm text-dark-onSurfaceVariant">拖放或点击上传</span>
                </>
              )}
            </div>

            <ul className="mt-4 space-y-1.5 text-xs text-dark-onSurfaceVariant/60 list-disc pl-4">
              <li>包含根级 SKILL.md 文件的 zip 或 .skill 文件</li>
              <li>SKILL.md 包含以 YAML 格式编写的技能名称和描述</li>
            </ul>

            {uploadError && (
              <div className="mt-3 text-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2">
                {uploadError}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={closeUploadModal}
                className="px-4 py-2 rounded-md3-md text-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmUpload}
                disabled={!uploadFilePath || uploadLoading}
                className="px-4 py-2 rounded-md3-md text-sm font-medium bg-md-primary text-md-onPrimary hover:bg-md-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              >
                {uploadLoading && <Loader2 size={14} className="animate-spin" />}
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
