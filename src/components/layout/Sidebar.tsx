import { useState, useEffect, useMemo } from 'react'
import {
  MessageSquare,
  Settings,
  Plus,
  Trash2,
  FolderClosed,
  FolderOpen,
  Store,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  Globe,
  X,
  User,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CalendarClock,
  Search,
  CircleHelp,
  Bot,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chat-store'
import ConfirmDialog from '../ui/ConfirmDialog'
import RemoteAccessDialog from '../remote/RemoteAccessDialog'
import BotsDialog from '../bots/BotsDialog'
import ModeToggle from './ModeToggle'
import { isWebUIMode } from '../../lib/ipc-client'
import { isCloudRemoteMode } from '../../remote/browser'

import APP_ICON from '../../assets/icon.png'
import { useShallow } from 'zustand/react/shallow'
import { useSettingsStore } from '../../stores/settings-store'
import { useUIStore } from '../../stores/ui-store'
import { useScheduledTasksStore } from '../../stores/scheduled-tasks-store'
import { useAccountStore, avatarColorFor, initialOf } from '../../stores/account-store'
import { useIsMobile } from '../../hooks/use-mobile'
import { formatShortcut } from '../../lib/commands'
import { usePermissionStore } from '../../stores/permission-store'
import { useInteractiveStore } from '../../stores/interactive-store'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  /** 导航类操作后回调（新建会话/切换会话/技能商店/设置），移动端抽屉用于自动关闭 */
  onNavigate?: () => void
}

export default function Sidebar({ collapsed, onToggle, onNavigate }: SidebarProps) {
  const { t } = useTranslation()
  const cloudRemote = isCloudRemoteMode()
  const { sessions, activeSessionId, createSession, setActiveSession, deleteSession } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      createSession: s.createSession,
      setActiveSession: s.setActiveSession,
      deleteSession: s.deleteSession,
    }))
  )
  // 智能体提交的定时任务提案：确认入口在定时任务页，这里只做计数提醒
  const pendingProposals = useScheduledTasksStore((s) => s.proposals.length)
  // 订阅 sessionStatus 变化以触发 loading 圈重渲染
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  const hostPermissions = usePermissionStore((s) => s.bySession)
  const localPermissions = usePermissionStore((s) => s.localBySession)
  const pendingQuestions = useInteractiveStore((s) => s.pendingQuestions)
  const { showSkillStore, setShowSkillStore, showScheduledTasks, setShowScheduledTasks } = useUIStore()
  // 账户入口：登录态与用户信息（用于头像/文案切换）
  const accountLoggedIn = useAccountStore((s) => s.loggedIn)
  const accountUser = useAccountStore((s) => s.user)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // ── 任务列表分组：每个 workingDir 一组；null/空 workingDir 归到「默认」组 ──
  // 每组独立折叠状态：Set 里存的是"已折叠"的分组 key，不在 Set 内 = 展开（默认）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // 手机端布局开关：账户入口据此禁用（Hook 必须在组件顶层调用，不能放进事件回调）
  const isMobile = useIsMobile()

  // ── 远程访问弹窗（WebUI 与 IM 机器人的入口都搬进了弹窗，侧栏只管开关）──
  const [remoteAccessOpen, setRemoteAccessOpen] = useState(false)
  const [botsOpen, setBotsOpen] = useState(false)

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

  const activeGroupKey = sessions.find((session) => session.id === activeSessionId)?.workingDir?.trim() || 'default'
  // 仅在切换任务/工作目录时自动展开；流式消息更新不能反复展开用户刚折叠的分组。
  useEffect(() => {
    if (!activeSessionId) return
    setCollapsedGroups((prev) => (prev.has(activeGroupKey) ? new Set([...prev].filter((key) => key !== activeGroupKey)) : prev))
  }, [activeSessionId, activeGroupKey])

  const openSearch = () => {
    useUIStore.getState().setCommandPaletteOpen(true)
    onNavigate?.()
  }

  /** 折叠/展开单个分组 */
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 账户入口点击：打开设置页并定位到"账户"标签（一次性 transient 标记）
  const handleOpenAccountSettings = () => {
    // 配对浏览器通过主机完成账户操作；普通移动 WebUI 仍保留原限制。
    if (isMobile && !cloudRemote) {
      alert(t('sidebar.account.mobileOnlyAlert'))
      return
    }
    useSettingsStore.getState().updateSettings({ showSettings: true, pendingSettingsTab: 'account' })
  }

  if (collapsed) {
    return (
      <aside aria-label={t('shell.workspace')} className="h-full min-h-0 w-14 shrink-0 flex flex-col items-center gap-1 py-3 bg-dark-surfaceDim border-r border-dark-onSurfaceVariant/10">
        <img
          src={APP_ICON}
          alt="ClerkBox"
          className="w-8 h-8 rounded-md3-sm mb-3 object-contain"
          title="ClerkBox"
        />
        <button
          type="button"
          onClick={() => { setShowSkillStore(false); setShowScheduledTasks(false); createSession() }}
          className="md-focus w-9 h-9 flex items-center justify-center rounded-md3-md bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors"
          title={t('sidebar.newChatAria')}
          aria-label={t('sidebar.newChatAria')}
        >
          <Plus size={18} />
        </button>
        <button
          type="button"
          onClick={openSearch}
          className="md-focus w-9 h-9 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
          title={`${t('shell.search')} (${formatShortcut({ key: 'k' })})`}
          aria-label={t('shell.search')}
        >
          <Search size={17} />
        </button>
        <button
          type="button"
          onClick={() => { setShowScheduledTasks(false); setShowSkillStore(!showSkillStore) }}
          className={`md-focus w-9 h-9 flex items-center justify-center rounded-md3-sm transition-colors ${
            showSkillStore ? 'bg-md-primary/15 text-md-primary' : 'hover:bg-dark-surfaceContainerHigh'
          }`}
          title={t('sidebar.skillStoreAria')}
          aria-label={t('sidebar.skillStoreAria')}
          aria-expanded={showSkillStore}
        >
          <Store size={18} />
        </button>
        <button
          type="button"
          onClick={() => { setShowSkillStore(false); setShowScheduledTasks(!showScheduledTasks) }}
          className={`md-focus relative w-9 h-9 flex items-center justify-center rounded-md3-sm transition-colors ${
            showScheduledTasks ? 'bg-md-primary/15 text-md-primary' : 'hover:bg-dark-surfaceContainerHigh'
          }`}
          title={t('scheduledTasks.title')}
          aria-label={
            pendingProposals > 0
              ? `${t('scheduledTasks.title')} (${t('scheduledTasks.proposal.sectionTitle')}: ${pendingProposals})`
              : t('scheduledTasks.title')
          }
          aria-expanded={showScheduledTasks}
        >
          <CalendarClock size={18} />
          {pendingProposals > 0 && (
            <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-md-primary text-ui-xs leading-5 text-center text-md-onPrimary font-medium">
              {pendingProposals > 9 ? '9+' : pendingProposals}
            </span>
          )}
        </button>
        <div className="flex-1" />
        {cloudRemote && (
          <button
            type="button"
            onClick={() => setBotsOpen(true)}
            className="md-focus w-9 h-9 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant transition-colors"
            aria-label={t('remoteAccess.botsManage')}
            title={t('remoteAccess.botsManage')}
          >
            <Bot size={18} />
          </button>
        )}
        {!isWebUIMode && (
          <button
            type="button"
            onClick={() => setRemoteAccessOpen(true)}
            className="md-focus w-9 h-9 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant transition-colors"
            aria-label={t('sidebar.remoteAccessAria')}
            title={t('sidebar.remoteAccess')}
          >
            <Globe size={18} />
          </button>
        )}
        <button
          type="button"
          onClick={() => useSettingsStore.getState().updateSettings({ showSettings: true })}
          className="md-focus w-9 h-9 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant transition-colors"
          aria-label={t('sidebar.settings')}
          title={t('sidebar.settings')}
        >
          <Settings size={18} />
        </button>
        {/* 账户按钮：未登录=用户图标 / 已登录=首字母圆头像 */}
        <button
          type="button"
          onClick={handleOpenAccountSettings}
          className={`md-focus w-9 h-9 mt-1 flex items-center justify-center transition-colors ${
            accountLoggedIn && accountUser
              ? 'rounded-full text-white text-ui-xs font-semibold'
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
        {remoteAccessOpen && <RemoteAccessDialog onClose={() => setRemoteAccessOpen(false)} />}
        {botsOpen && <BotsDialog onClose={() => setBotsOpen(false)} />}
      </aside>
    )
  }

  return (
    <aside aria-label={t('shell.workspace')} className="h-full min-h-0 w-64 shrink-0 max-md:w-full flex flex-col overflow-y-auto bg-dark-surfaceDim border-r border-dark-onSurfaceVariant/10">
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-5 pb-4 max-md:pt-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <img src={APP_ICON} alt="" className="w-8 h-8 rounded-md3-sm shrink-0" />
          <div className="min-w-0">
            <span className="text-ui-sm font-semibold text-dark-onSurface">ClerkBox</span>
            <p className="text-ui-xs text-dark-onSurfaceVariant/60">{t('shell.workspace')}</p>
          </div>
          {isWebUIMode && (
            <span className="px-1.5 py-0.5 rounded-md3-xs bg-md-tertiary/15 text-md-tertiary text-ui-xs font-medium whitespace-nowrap">
              Web UI
            </span>
          )}
        </div>
        {/* 移动端抽屉关闭按钮 */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={t('common.close')}
          className="md-focus hidden max-md:flex w-11 h-11 -mr-1 shrink-0 items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
        >
          <X size={18} />
        </button>
      </div>

      <nav aria-label={t('shell.workspace')} className="shrink-0 px-3 pb-4 flex flex-col gap-1">
        <button
          type="button"
          onClick={() => { setShowSkillStore(false); setShowScheduledTasks(false); createSession(); onNavigate?.() }}
          className="md-focus w-full flex min-h-10 items-center gap-2.5 px-3 py-2 max-md:min-h-11 rounded-md3-md bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors text-ui-sm font-medium"
        >
          <Plus size={16} />
          <span className="flex-1 text-left">{t('sidebar.newChat')}</span>
          <kbd aria-hidden="true" className="text-ui-xs font-normal opacity-60 max-md:hidden">{formatShortcut({ key: 'n' })}</kbd>
        </button>
        <button
          type="button"
          onClick={openSearch}
          className="md-focus mt-2 mb-3 w-full min-h-10 flex items-center gap-2.5 rounded-md3-sm border border-dark-onSurfaceVariant/15 bg-dark-surface/60 px-3 py-2 text-ui-xs text-dark-onSurfaceVariant hover:border-dark-onSurfaceVariant/30 hover:bg-dark-surfaceContainer transition-colors max-md:min-h-11"
          title={`${t('shell.search')} (${formatShortcut({ key: 'k' })})`}
        >
          <Search size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{t('shell.search')}</span>
          <kbd aria-hidden="true" className="shrink-0 font-sans text-dark-onSurfaceVariant/60 max-md:hidden">{formatShortcut({ key: 'k' })}</kbd>
        </button>
        <div className="mb-2"><ModeToggle /></div>
        <button
          type="button"
          onClick={() => { setShowScheduledTasks(false); setShowSkillStore(!showSkillStore); onNavigate?.() }}
          aria-pressed={showSkillStore}
          className={`md-focus w-full flex min-h-10 items-center gap-2.5 px-3 py-2 max-md:min-h-11 rounded-md3-sm transition-colors text-ui-sm ${
            showSkillStore
              ? 'bg-md-primary/10 text-md-primary font-medium'
              : 'hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant'
          }`}
        >
          <Store size={16} />
          <span>{t('sidebar.skills')}</span>
        </button>
        <button
          type="button"
          onClick={() => { setShowSkillStore(false); setShowScheduledTasks(!showScheduledTasks); onNavigate?.() }}
          aria-pressed={showScheduledTasks}
          className={`md-focus w-full flex min-h-10 items-center gap-2.5 px-3 py-2 max-md:min-h-11 rounded-md3-sm transition-colors text-ui-sm ${
            showScheduledTasks
              ? 'bg-md-primary/10 text-md-primary font-medium'
              : 'hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant'
          }`}
        >
          <CalendarClock size={16} />
          <span>{t('scheduledTasks.title')}</span>
          {pendingProposals > 0 && (
            <span className="ml-auto min-w-5 h-5 px-1.5 rounded-full bg-md-primary text-ui-xs leading-5 text-center text-md-onPrimary font-medium">
              {pendingProposals > 9 ? '9+' : pendingProposals}
            </span>
          )}
        </button>
      </nav>

      {/* 任务列表标题 + 全部折叠/展开 */}
      <div className="mx-3 shrink-0 border-t border-dark-onSurfaceVariant/10 pt-3 pb-2 pl-2 flex items-center justify-between gap-2">
        <span className="text-ui-xs font-medium text-dark-onSurfaceVariant/60">
          {t('sidebar.taskList')}
        </span>
        <button
          type="button"
          disabled={groups.length === 0}
          onClick={() => {
            // 有任一分组展开 → 全部折叠；全已折叠 → 全部展开
            const anyExpanded = groups.some((g) => !collapsedGroups.has(g.key))
            setCollapsedGroups(anyExpanded ? new Set(groups.map((g) => g.key)) : new Set())
          }}
          className="md-focus w-7 h-7 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant/60 hover:bg-dark-surfaceContainer hover:text-dark-onSurface transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title={groups.some((g) => !collapsedGroups.has(g.key)) ? t('sidebar.collapseAll') : t('sidebar.expandAll')}
          aria-label={groups.some((g) => !collapsedGroups.has(g.key)) ? t('sidebar.collapseAll') : t('sidebar.expandAll')}
        >
          {groups.some((g) => !collapsedGroups.has(g.key)) ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
        {groups.length === 0 && (
          <div className="rounded-md3-md border border-dashed border-dark-onSurfaceVariant/15 px-3 py-5">
            <MessageSquare size={18} className="mb-3 text-dark-onSurfaceVariant/40" aria-hidden="true" />
            <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{t('sidebar.emptySessions')}</p>
            <p className="mt-1.5 text-ui-xs text-dark-onSurfaceVariant/60 leading-relaxed">{t('shell.sidebarHint')}</p>
          </div>
        )}
        {groups.map((group) => {
          const groupExpanded = !collapsedGroups.has(group.key)
          const Icon = groupExpanded ? FolderOpen : FolderClosed
          return (
            <div key={group.key} className="mb-2">
              {/* 分组行 */}
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                className={`md-focus w-full flex min-h-8 items-center gap-2 px-2 py-1.5 max-md:min-h-11 rounded-md3-sm text-ui-xs transition-colors ${
                  groupExpanded
                    ? 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
                    : 'text-dark-onSurfaceVariant/60 hover:bg-dark-surfaceContainer'
                }`}
                aria-expanded={groupExpanded}
                title={group.key === 'default' ? group.label : group.key}
              >
                <Icon size={13} className="flex-shrink-0" />
                <span className="truncate flex-1 text-left">{group.label}</span>
                <span className="text-ui-xs text-dark-onSurfaceVariant/60 tabular-nums flex-shrink-0">
                  {group.sessions.length}
                </span>
                <ChevronDown
                  size={12}
                  className={`flex-shrink-0 transition-transform duration-200 ${groupExpanded ? '' : '-rotate-90'}`}
                />
              </button>
              {/* 任务列表 */}
              <div
                className="grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none"
                style={{
                  gridTemplateRows: groupExpanded ? '1fr' : '0fr',
                  opacity: groupExpanded ? 1 : 0,
                  transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
                }}
              >
                <div className="min-h-0 overflow-hidden" inert={!groupExpanded} aria-hidden={!groupExpanded}>
                  <div className="flex flex-col gap-1 pt-1">
                    {group.sessions.map((s) => {
                      const waitingApproval = !!hostPermissions[s.id]?.length || !!localPermissions[s.id]?.length || sessionStatus[s.id] === 'confirm-danger'
                      const waitingAnswer = !!pendingQuestions[s.id]
                      const statusLabel = waitingApproval ? t('shell.waitingApproval') : waitingAnswer ? t('shell.waitingAnswer') : sessionStatus[s.id] === 'working' ? t('sidebar.statusWorking') : sessionStatus[s.id] === 'error' ? t('sidebar.statusError') : undefined
                      return (
                      <div
                        key={s.id}
                        className={`sidebar-session-row relative flex items-center gap-1 rounded-md3-sm border transition-colors ${
                          activeSessionId === s.id && !showSkillStore && !showScheduledTasks
                            ? 'border-dark-onSurfaceVariant/10 bg-dark-surfaceBright text-dark-onSurface'
                            : 'border-transparent text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => { setShowSkillStore(false); setShowScheduledTasks(false); setActiveSession(s.id); onNavigate?.() }}
                          aria-current={activeSessionId === s.id && !showSkillStore && !showScheduledTasks ? 'page' : undefined}
                          title={statusLabel ? `${s.title} · ${statusLabel}` : s.title}
                          className="md-focus min-h-9 flex-1 flex items-center gap-2.5 py-2 pl-3 text-ui-sm text-left min-w-0 rounded-md3-sm max-md:min-h-11"
                        >
                          <span aria-hidden="true" className="shrink-0">
                            {waitingApproval ? <ShieldAlert size={14} className="text-md-askForeground" /> : waitingAnswer ? <CircleHelp size={14} className="text-md-primary" /> : sessionStatus[s.id] === 'working' ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none text-md-primary" /> : sessionStatus[s.id] === 'error' ? <AlertTriangle size={14} className="text-md-error" /> : <MessageSquare size={14} className="text-dark-onSurfaceVariant/60" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{s.title || t('commandPalette.untitled')}</span>
                            {statusLabel && <span className={`mt-0.5 block truncate text-ui-xs ${waitingApproval ? 'text-md-askForeground' : sessionStatus[s.id] === 'error' ? 'text-md-error' : 'text-dark-onSurfaceVariant'}`}>{statusLabel}</span>}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmDeleteId(s.id)
                          }}
                          className="sidebar-session-delete md-focus mr-1 w-7 h-8 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant/60 hover:bg-md-error/15 hover:text-md-error transition-opacity flex-shrink-0"
                          aria-label={t('sidebar.deleteSessionAria')}
                          title={t('sidebar.deleteSessionAria')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )})}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="shrink-0 border-t border-dark-onSurfaceVariant/10 px-3 py-3 max-md:pb-[calc(0.75rem+env(safe-area-inset-bottom))] flex flex-col gap-1">
        {cloudRemote && (
          <button
            type="button"
            onClick={() => setBotsOpen(true)}
            className="md-focus w-full flex min-h-9 items-center gap-2.5 px-3 py-2 max-md:min-h-11 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-ui-sm text-dark-onSurfaceVariant"
          >
            <Bot size={16} />
            <span>{t('remoteAccess.botsManage')}</span>
          </button>
        )}
        {!isWebUIMode && (
          <button
            type="button"
            onClick={() => setRemoteAccessOpen(true)}
            className="md-focus w-full flex min-h-9 items-center gap-2.5 px-3 py-2 max-md:min-h-11 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-ui-sm text-dark-onSurfaceVariant"
            aria-label={t('sidebar.remoteAccessAria')}
          >
            <Globe size={16} />
            <span>{t('sidebar.remoteAccess')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => { useSettingsStore.getState().updateSettings({ showSettings: true }); onNavigate?.() }}
          className="md-focus w-full flex min-h-9 items-center gap-2.5 px-3 py-2 max-md:min-h-11 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-ui-sm text-dark-onSurfaceVariant"
        >
          <Settings size={16} />
          <span>{t('sidebar.settings')}</span>
        </button>
        {/* 账户按钮（最底）：未登录=用户图标+"未登录" / 已登录=首字母圆头像+用户名 */}
        <button
          type="button"
          onClick={() => { handleOpenAccountSettings(); onNavigate?.() }}
          className="md-focus w-full flex min-h-10 items-center gap-2.5 px-3 py-2 max-md:min-h-11 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-ui-sm text-dark-onSurfaceVariant"
          aria-label={accountLoggedIn && accountUser ? accountUser.username : t('sidebar.notLoggedIn')}
          title={accountLoggedIn && accountUser ? accountUser.username : t('sidebar.account.label')}
        >
          {accountLoggedIn && accountUser ? (
            <span
              className="w-7 h-7 rounded-full flex items-center justify-center text-ui-xs font-semibold text-white flex-shrink-0"
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

      {/* 远程访问弹窗：WebUI 的启动/停止/二维码与 IM 机器人管理都搬进了弹窗，侧栏只留开关 */}
      {remoteAccessOpen && <RemoteAccessDialog onClose={() => setRemoteAccessOpen(false)} />}
      {botsOpen && <BotsDialog onClose={() => setBotsOpen(false)} />}
    </aside>
  )
}
