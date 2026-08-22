import { useState, useRef, useEffect, useMemo } from 'react'
import {
  MessageSquare,
  Settings,
  Plus,
  Trash2,
  FolderClosed,
  FolderOpen,
  Zap,
  Store,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  Globe,
  Copy,
  Check,
  ExternalLink,
  X,
  User,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chat-store'
import ConfirmDialog from '../ui/ConfirmDialog'
import { ipc, isWebUIMode } from '../../lib/ipc-client'

import APP_ICON from '../../assets/icon.png'
import { useShallow } from 'zustand/react/shallow'
import { useSkillsStore } from '../../stores/skills-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useUIStore } from '../../stores/ui-store'
import { useAccountStore, avatarColorFor, initialOf } from '../../stores/account-store'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { t } = useTranslation()
  const { sessions, activeSessionId, createSession, setActiveSession, deleteSession } = useChatStore()
  // 订阅 sessionStatus 变化以触发 loading 圈重渲染
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  // 激活技能派生列表：useShallow 对数组元素做浅比较，避免 filter 每次返回新数组引用触发无意义重渲染
  const enabledSkills = useSkillsStore(
    useShallow((s) => s.skills.filter((sk) => s.sessionSkillIds.includes(sk.id)))
  )
  const toggleSessionSkill = useSkillsStore((s) => s.toggleSessionSkill)
  const { showSkillStore, setShowSkillStore } = useUIStore()
  // 账户入口：登录态与用户信息（用于头像/文案切换）
  const accountLoggedIn = useAccountStore((s) => s.loggedIn)
  const accountUser = useAccountStore((s) => s.user)
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  // ── 任务列表分组：每个 workingDir 一组；null/空 workingDir 归到「默认」组 ──
  // 单一布尔控制"全部折叠"：true 表示全部折叠，false 表示按单组状态（默认全展开）
  // 单组状态：当 allCollapsed=false 时，每个组按 defaultExpanded=true 渲染
  const [allCollapsed, setAllCollapsed] = useState(false)

  // ── WebUI 控制 ──
  const [webuiStarting, setWebuiStarting] = useState(false)
  const [webuiInfo, setWebuiInfo] = useState<{ url: string } | null>(null)
  const [webuiCopied, setWebuiCopied] = useState(false)

  const handleStartWebUI = async () => {
    if (webuiStarting) return
    setWebuiStarting(true)
    try {
      const result = await ipc.startWebUI()
      if ('error' in result && result.error) {
        alert(t('sidebar.webuiError'))
      } else if ('url' in result) {
        setWebuiInfo({ url: result.url })
      }
    } catch {
      alert(t('sidebar.webuiError'))
    } finally {
      setWebuiStarting(false)
    }
  }

  const handleStopWebUI = async () => {
    await ipc.stopWebUI()
    setWebuiInfo(null)
  }

  const handleCopyWebUIUrl = async () => {
    if (!webuiInfo) return
    try {
      await navigator.clipboard.writeText(webuiInfo.url)
      setWebuiCopied(true)
      setTimeout(() => setWebuiCopied(false), 2000)
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  }

  // Close picker on outside click
  useEffect(() => {
    if (!showSkillPicker) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowSkillPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSkillPicker])

  // Get current session's workingDir for skill sync (user-picked or default)
  const currentSession = sessions.find((s) => s.id === activeSessionId)
  const workingDir = currentSession?.workingDir || currentSession?.defaultWorkDir || ''

  // 任务列表分组：从 sessions 派生
  //   - 分组键只用 workingDir（用户主动选过的工作目录）
  //   - defaultWorkDir（自动生成的时间戳目录）不作为分组键，全部归入「默认」组，
  //     否则每个默认会话会各自成一个时间戳命名的垃圾分组
  //   - 组内按 updatedAt 降序；分组按组内最近活跃时间戳降序
  // 排除空会话：未发过消息的不算"任务"（与历史行为一致）
  const groups = useMemo(() => {
    const visible = sessions.filter((s) => s.messages.length > 0)
    const byKey = new Map<string, { key: string; label: string; sessions: typeof visible }>()
    for (const s of visible) {
      const dir = (s.workingDir || '').trim()
      const key = dir || 'default'
      const label = dir ? dir.split(/[\\/]/).filter(Boolean).pop() || dir : t('sidebar.defaultGroup')
      if (!byKey.has(key)) byKey.set(key, { key, label, sessions: [] })
      byKey.get(key)!.sessions.push(s)
    }
    const arr = Array.from(byKey.values())
    for (const g of arr) g.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    arr.sort((a, b) => {
      const aMax = a.sessions.reduce((m, s) => Math.max(m, s.updatedAt), 0)
      const bMax = b.sessions.reduce((m, s) => Math.max(m, s.updatedAt), 0)
      return bMax - aMax
    })
    return arr
  }, [sessions, t])

  const handleToggleSkill = (id: string) => {
    toggleSessionSkill(id, workingDir)
  }

  // 账户入口点击：打开设置页并定位到"账户"标签（一次性 transient 标记）
  const handleOpenAccountSettings = () => {
    useSettingsStore.getState().updateSettings({ showSettings: true, pendingSettingsTab: 'account' })
  }

  if (collapsed) {
    return (
      <div className="w-14 flex flex-col items-center py-3 bg-dark-surfaceDim border-r border-dark-onSurfaceVariant/10">
        <div className="mb-2" />
        <img
          src={APP_ICON}
          alt="ClerkBox"
          className="w-8 h-8 rounded-md3-sm mb-2 object-contain"
          title="ClerkBox"
        />
        <button
          onClick={() => { setShowSkillStore(false); createSession() }}
          className="w-8 h-8 flex items-center justify-center rounded-md3-sm bg-dark-surfaceContainerHigh mb-2"
          title={t('sidebar.newChatAria')}
          aria-label={t('sidebar.newChatAria')}
        >
          <Plus size={18} />
        </button>
        <button
          onClick={() => setShowSkillStore(!showSkillStore)}
          className={`w-8 h-8 flex items-center justify-center rounded-md3-sm transition-colors mb-2 ${
            showSkillStore ? 'bg-md-primary/15 text-md-primary' : 'hover:bg-dark-surfaceContainerHigh'
          }`}
          title={t('sidebar.skillStoreAria')}
          aria-label={t('sidebar.skillStoreAria')}
          aria-expanded={showSkillStore}
        >
          <Store size={18} />
        </button>
        <div className="flex-1" />
        {enabledSkills.length > 0 && (
          <div className="relative mb-1">
            <Zap size={16} className="text-md-primary" />
            <span className="absolute -top-1 -right-1.5 w-3 h-3 bg-md-primary rounded-full text-[7px] flex items-center justify-center text-md-onPrimary font-bold">
              {enabledSkills.length}
            </span>
          </div>
        )}
        {!isWebUIMode && (
          <button
            type="button"
            onClick={handleStartWebUI}
            disabled={webuiStarting}
            className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors mb-1 disabled:opacity-50"
            aria-label={t('sidebar.webuiAria')}
            title={t('sidebar.webui')}
          >
            {webuiStarting ? <Loader2 size={18} className="animate-spin" /> : <Globe size={18} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => useSettingsStore.getState().updateSettings({ showSettings: true })}
          className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
          aria-label={t('sidebar.settings')}
          title={t('sidebar.settings')}
        >
          <Settings size={18} />
        </button>
        {/* 账户按钮：未登录=用户图标 / 已登录=首字母圆头像 */}
        <button
          type="button"
          onClick={handleOpenAccountSettings}
          className={`w-8 h-8 mt-1 flex items-center justify-center transition-colors ${
            accountLoggedIn && accountUser
              ? 'rounded-full text-white text-xs font-semibold'
              : 'rounded-md3-sm hover:bg-dark-surfaceContainerHigh'
          }`}
          style={
            accountLoggedIn && accountUser
              ? { backgroundColor: avatarColorFor(accountUser.username) }
              : undefined
          }
          aria-label={accountLoggedIn && accountUser ? accountUser.username : t('sidebar.notLoggedIn')}
          title={accountLoggedIn && accountUser ? accountUser.username : t('sidebar.notLoggedIn')}
        >
          {accountLoggedIn && accountUser ? (
            <span aria-hidden>{initialOf(accountUser.username)}</span>
          ) : (
            <User size={18} />
          )}
        </button>
      </div>
    )
  }

  return (
    <div className="w-64 flex flex-col bg-dark-surfaceDim border-r border-dark-onSurfaceVariant/10">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <img src={APP_ICON} alt="ClerkBox" className="w-8 h-8 rounded" />
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold tracking-wide text-dark-onSurfaceVariant">ClerkBox</span>
            {isWebUIMode && (
              <span className="px-1.5 py-0.5 rounded-md3-xs bg-md-tertiary/15 text-md-tertiary text-[10px] font-medium whitespace-nowrap">
                Web UI [BETA]
              </span>
            )}
          </div>
        </div>
      </div>

      {/* New Chat + Skill Store buttons - vertical stack for better breathing room */}
      <div className="px-3 pb-2 flex flex-col gap-1.5">
        <button
          onClick={() => { setShowSkillStore(false); createSession() }}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm"
        >
          <span>{t('sidebar.newChat')}</span>
        </button>
        <button
          onClick={() => setShowSkillStore(!showSkillStore)}
          className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-md transition-colors text-sm ${
            showSkillStore
              ? 'bg-md-primary/15 text-md-primary hover:bg-md-primary/25'
              : 'bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
          }`}
        >
          <Store size={16} />
          <span>{t('sidebar.skills')}</span>
        </button>
      </div>

      {/* 任务列表标题 + 全部折叠/展开 */}
      <div className="px-3 pt-1 pb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-medium text-dark-onSurfaceVariant/50 uppercase tracking-wider">
          {t('sidebar.taskList')}
        </span>
        <button
          type="button"
          onClick={() => setAllCollapsed((prev) => !prev)}
          className="w-6 h-6 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant/40 hover:bg-dark-surfaceContainer hover:text-dark-onSurfaceVariant/70 transition-colors"
          title={allCollapsed ? t('sidebar.expandAll') : t('sidebar.collapseAll')}
          aria-label={allCollapsed ? t('sidebar.expandAll') : t('sidebar.collapseAll')}
        >
          {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
        </button>
      </div>

      {/* Active skills */}
      <div className="px-3 pb-2">
        {enabledSkills.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {enabledSkills.map((s) => (
              <span
                key={s.id}
                title={s.description || s.name}
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-md-primary/10 text-md-primary text-[10px] cursor-default"
              >
                <span>{s.icon}</span>
                {s.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {groups.length === 0 && (
          <p className="px-3 py-4 text-xs text-dark-onSurfaceVariant/50 text-center">
            {t('sidebar.emptySessions')}
          </p>
        )}
        {groups.map((group) => {
          const groupExpanded = !allCollapsed
          const Icon = groupExpanded ? FolderOpen : FolderClosed
          return (
            <div key={group.key} className="mb-1">
              {/* 分组行 */}
              <button
                type="button"
                onClick={() => setAllCollapsed((prev) => !prev)}
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md3-xs text-xs transition-colors ${
                  groupExpanded
                    ? 'text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainer'
                    : 'text-dark-onSurfaceVariant/60 hover:bg-dark-surfaceContainer'
                }`}
                title={groupExpanded ? t('sidebar.collapseAll') : t('sidebar.expandAll')}
              >
                <Icon size={13} className="flex-shrink-0" />
                <span className="truncate flex-1 text-left">{group.label}</span>
                <span className="text-[10px] text-dark-onSurfaceVariant/40 tabular-nums flex-shrink-0">
                  {group.sessions.length}
                </span>
                <ChevronDown
                  size={12}
                  className={`flex-shrink-0 transition-transform duration-200 ${groupExpanded ? '' : '-rotate-90'}`}
                />
              </button>
              {/* 任务列表 */}
              <div
                className="grid transition-[grid-template-rows,opacity] duration-200"
                style={{
                  gridTemplateRows: groupExpanded ? '1fr' : '0fr',
                  opacity: groupExpanded ? 1 : 0,
                  transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
                }}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="flex flex-col gap-0.5 pl-2 pr-1">
                    {group.sessions.map((s) => (
                      <div
                        key={s.id}
                        onMouseEnter={() => setHoveredSessionId(s.id)}
                        onMouseLeave={() => setHoveredSessionId(null)}
                        className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-md3-xs text-[13px] transition-colors ${
                          activeSessionId === s.id
                            ? 'bg-md-secondaryContainer text-md-onSecondaryContainer'
                            : 'text-dark-onSurfaceVariant/85 hover:bg-dark-surfaceContainer'
                        }`}
                      >
                        <button
                          onClick={() => { setShowSkillStore(false); setActiveSession(s.id) }}
                          className="flex-1 flex items-center gap-2 text-left min-w-0"
                        >
                          <MessageSquare size={13} className="flex-shrink-0 opacity-70" />
                          <span className="truncate">{s.title}</span>
                        </button>
                        {/* per-session 工作状态指示器 */}
                        {(() => {
                          const status = sessionStatus[s.id]
                          if (status === 'working') {
                            return (
                              <span title={t('sidebar.statusWorking')} className="flex-shrink-0">
                                <Loader2 size={13} className="animate-spin text-md-primary" />
                              </span>
                            )
                          }
                          if (status === 'error') {
                            return (
                              <span title={t('sidebar.statusError')} className="flex-shrink-0">
                                <AlertTriangle size={13} className="text-md-error" />
                              </span>
                            )
                          }
                          if (status === 'confirm-danger') {
                            return (
                              <span title={t('sidebar.statusConfirmDanger')} className="flex-shrink-0">
                                <ShieldAlert size={13} className="text-md-warning animate-pulse" />
                              </span>
                            )
                          }
                          return null
                        })()}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmDeleteId(s.id)
                          }}
                          className={`w-6 h-6 flex items-center justify-center rounded-md3-xs hover:bg-md-error/20 hover:text-md-error transition-opacity flex-shrink-0 ${
                            hoveredSessionId === s.id ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100'
                          }`}
                          aria-label={t('sidebar.deleteSessionAria')}
                          title={t('sidebar.deleteSessionAria')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="border-t border-dark-onSurfaceVariant/10 px-3 py-2 flex flex-col gap-0.5">
        {!isWebUIMode && (
          <button
            onClick={handleStartWebUI}
            disabled={webuiStarting}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-sm text-dark-onSurfaceVariant disabled:opacity-50"
            aria-label={t('sidebar.webuiAria')}
          >
            {webuiStarting ? <Loader2 size={16} className="animate-spin" /> : <Globe size={16} />}
            <span>{webuiStarting ? t('sidebar.webuiStarting') : t('sidebar.webui')}</span>
          </button>
        )}
        <button
          onClick={() => useSettingsStore.getState().updateSettings({ showSettings: true })}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-sm text-dark-onSurfaceVariant"
        >
          <Settings size={16} />
          <span>{t('sidebar.settings')}</span>
        </button>
        {/* 账户按钮（最底）：未登录=用户图标+"未登录" / 已登录=首字母圆头像+用户名 */}
        <button
          onClick={handleOpenAccountSettings}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-sm text-dark-onSurfaceVariant"
          aria-label={accountLoggedIn && accountUser ? accountUser.username : t('sidebar.notLoggedIn')}
          title={accountLoggedIn && accountUser ? accountUser.username : t('sidebar.account')}
        >
          {accountLoggedIn && accountUser ? (
            <span
              className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold text-white flex-shrink-0"
              style={{ backgroundColor: avatarColorFor(accountUser.username) }}
              aria-hidden
            >
              {initialOf(accountUser.username)}
            </span>
          ) : (
            <User size={16} className="flex-shrink-0" />
          )}
          <span className="truncate">
            {accountLoggedIn && accountUser ? accountUser.username : t('sidebar.notLoggedIn')}
          </span>
        </button>
      </div>

      {/* Delete confirmation dialog */}
      {confirmDeleteId && (
        <ConfirmDialog
          title={t('sidebar.deleteSessionTitle')}
          message={t('sidebar.deleteSessionMsg')}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          variant="danger"
          onConfirm={() => {
            deleteSession(confirmDeleteId)
            setConfirmDeleteId(null)
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      {/* WebUI info modal */}
      {webuiInfo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setWebuiInfo(null)
          }}
        >
          <div className="w-[440px] max-w-[90vw] rounded-md3-lg bg-dark-surfaceContainer p-6 shadow-xl">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <Globe size={20} className="text-md-primary" />
                <h2 className="text-base font-semibold">{t('sidebar.webuiTitle')}</h2>
              </div>
              <button
                type="button"
                onClick={() => setWebuiInfo(null)}
                className="w-7 h-7 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            </div>

            <p className="text-sm text-dark-onSurfaceVariant mb-3">{t('sidebar.webuiDesc')}</p>

            <div className="flex items-center gap-2 p-2.5 rounded-md3-md bg-dark-surfaceContainerHigh mb-1">
              <code className="flex-1 text-xs break-all text-dark-onSurfaceVariant select-all">
                {webuiInfo.url}
              </code>
              <button
                type="button"
                onClick={handleCopyWebUIUrl}
                className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainer transition-colors"
                aria-label={t('sidebar.webuiCopy')}
                title={t('sidebar.webuiCopy')}
              >
                {webuiCopied ? <Check size={14} className="text-md-primary" /> : <Copy size={14} />}
              </button>
            </div>
            {webuiCopied && (
              <p className="text-xs text-md-primary mb-1">{t('sidebar.webuiCopied')}</p>
            )}
            <p className="text-xs text-dark-onSurfaceVariant/60 mb-4">
              {t('sidebar.webuiSecurityNote')}
            </p>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => ipc.openExternal(webuiInfo.url)}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-md bg-md-primary text-md-onPrimary hover:opacity-90 transition-opacity text-sm"
              >
                <ExternalLink size={15} />
                <span>{t('sidebar.webuiOpen')}</span>
              </button>
              <button
                type="button"
                onClick={handleStopWebUI}
                className="px-3 py-2 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm"
              >
                {t('sidebar.webuiStop')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
