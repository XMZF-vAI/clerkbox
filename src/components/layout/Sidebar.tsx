import { useState, useRef, useEffect, useMemo } from 'react'
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
import QrCode from '../ui/QrCode'
import { ipc, isWebUIMode } from '../../lib/ipc-client'

import APP_ICON from '../../assets/icon.png'
import { useShallow } from 'zustand/react/shallow'
import { useSettingsStore } from '../../stores/settings-store'
import { useUIStore } from '../../stores/ui-store'
import { useAccountStore, avatarColorFor, initialOf } from '../../stores/account-store'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  /** 导航类操作后回调（新建会话/切换会话/技能商店/设置），移动端抽屉用于自动关闭 */
  onNavigate?: () => void
}

export default function Sidebar({ collapsed, onToggle, onNavigate }: SidebarProps) {
  const { t } = useTranslation()
  const { sessions, activeSessionId, createSession, setActiveSession, deleteSession } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      createSession: s.createSession,
      setActiveSession: s.setActiveSession,
      deleteSession: s.deleteSession,
    }))
  )
  // 订阅 sessionStatus 变化以触发 loading 圈重渲染
  const sessionStatus = useChatStore((s) => s.sessionStatus)
  const { showSkillStore, setShowSkillStore } = useUIStore()
  // 账户入口：登录态与用户信息（用于头像/文案切换）
  const accountLoggedIn = useAccountStore((s) => s.loggedIn)
  const accountUser = useAccountStore((s) => s.user)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  // ── 任务列表分组：每个 workingDir 一组；null/空 workingDir 归到「默认」组 ──
  // 每组独立折叠状态：Set 里存的是"已折叠"的分组 key，不在 Set 内 = 展开（默认）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // ── WebUI 控制 ──
  const [webuiStarting, setWebuiStarting] = useState(false)
  const [webuiInfo, setWebuiInfo] = useState<{ url: string } | null>(null)
  const [webuiCopied, setWebuiCopied] = useState(false)
  const [webuiRestarting, setWebuiRestarting] = useState(false)
  // 二维码内容：仅在「允许局域网访问」且检测到局域网 IP 时才生成（绝不指向 localhost）
  const [webuiQrUrl, setWebuiQrUrl] = useState<string | null>(null)
  // 开启了局域网访问但没探测到可用网卡地址
  const [webuiLanMissing, setWebuiLanMissing] = useState(false)
  const webuiLanAccess = useSettingsStore((s) => s.webuiLanAccess)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  /** 解析二维码 URL：lanAllowed 时取第一个非内部 IPv4 拼 URL，否则不生成二维码 */
  const resolveQrUrl = async (result: { port: number; token: string; url: string }, lanAllowed: boolean) => {
    const ips = await ipc.getLanAddresses().catch(() => [] as string[])
    const ip = lanAllowed ? ips[0] : undefined
    setWebuiQrUrl(ip ? `http://${ip}:${result.port}/?token=${result.token}` : null)
    setWebuiLanMissing(lanAllowed && !ip)
  }

  const handleStartWebUI = async () => {
    if (webuiStarting) return
    setWebuiStarting(true)
    try {
      const result = await ipc.startWebUI(webuiLanAccess)
      if ('error' in result && result.error) {
        alert(t('sidebar.webuiError'))
      } else if ('url' in result) {
        setWebuiInfo({ url: result.url })
        void resolveQrUrl(result, webuiLanAccess)
      }
    } catch {
      alert(t('sidebar.webuiError'))
    } finally {
      setWebuiStarting(false)
    }
  }

  // 切换局域网访问：写设置后重启 WebUI 以应用新的绑定范围（127.0.0.1 ↔ 0.0.0.0）
  const handleToggleLanAccess = async () => {
    if (webuiRestarting) return
    setWebuiRestarting(true)
    const next = !webuiLanAccess
    updateSettings({ webuiLanAccess: next })
    try {
      await ipc.stopWebUI()
      const result = await ipc.startWebUI(next)
      if ('url' in result) {
        setWebuiInfo({ url: result.url })
        // 用新设置重算二维码（开启局域网后指向 LAN IP，关闭则不显示）
        void resolveQrUrl(result, next)
      }
    } catch {
      /* 重启失败时保留原弹窗状态，用户可手动重试 */
    } finally {
      setWebuiRestarting(false)
    }
  }

  const handleStopWebUI = async () => {
    await ipc.stopWebUI()
    setWebuiInfo(null)
    setWebuiQrUrl(null)
    setWebuiLanMissing(false)
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

  // 激活任务所在分组自动展开（切换任务时，即使该分组被手动折叠也展开，保证当前任务可见）
  useEffect(() => {
    if (!activeSessionId) return
    const active = sessions.find((s) => s.id === activeSessionId)
    if (!active) return
    const key = (active.workingDir || '').trim() || 'default'
    setCollapsedGroups((prev) => (prev.has(key) ? new Set([...prev].filter((k) => k !== key)) : prev))
  }, [activeSessionId, sessions])

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
    <div className="w-64 max-md:w-full flex flex-col bg-dark-surfaceDim border-r border-dark-onSurfaceVariant/10">
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
        {/* 移动端抽屉关闭按钮 */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={t('common.close')}
          className="hidden max-md:flex w-10 h-10 -mr-1 items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
        >
          <X size={18} />
        </button>
      </div>

      {/* New Chat + Skill Store buttons - vertical stack for better breathing room */}
      <div className="px-3 pb-2 flex flex-col gap-1.5">
        <button
          onClick={() => { setShowSkillStore(false); createSession(); onNavigate?.() }}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 max-md:py-3 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-sm max-md:text-base"
        >
          <Plus size={16} />
          <span>{t('sidebar.newChat')}</span>
        </button>
        <button
          onClick={() => { setShowSkillStore(!showSkillStore); onNavigate?.() }}
          className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 max-md:py-3 rounded-md3-md transition-colors text-sm max-md:text-base ${
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
          onClick={() => {
            // 有任一分组展开 → 全部折叠；全已折叠 → 全部展开
            const anyExpanded = groups.some((g) => !collapsedGroups.has(g.key))
            setCollapsedGroups(anyExpanded ? new Set(groups.map((g) => g.key)) : new Set())
          }}
          className="w-6 h-6 max-md:w-9 max-md:h-9 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant/40 hover:bg-dark-surfaceContainer hover:text-dark-onSurfaceVariant/70 transition-colors"
          title={groups.some((g) => !collapsedGroups.has(g.key)) ? t('sidebar.collapseAll') : t('sidebar.expandAll')}
          aria-label={groups.some((g) => !collapsedGroups.has(g.key)) ? t('sidebar.collapseAll') : t('sidebar.expandAll')}
        >
          {groups.some((g) => !collapsedGroups.has(g.key)) ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {groups.length === 0 && (
          <p className="px-3 py-4 text-xs text-dark-onSurfaceVariant/50 text-center">
            {t('sidebar.emptySessions')}
          </p>
        )}
        {groups.map((group) => {
          const groupExpanded = !collapsedGroups.has(group.key)
          const Icon = groupExpanded ? FolderOpen : FolderClosed
          return (
            <div key={group.key} className="mb-1">
              {/* 分组行 */}
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 max-md:py-2.5 max-md:text-sm rounded-md3-xs text-xs transition-colors ${
                  groupExpanded
                    ? 'text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainer'
                    : 'text-dark-onSurfaceVariant/60 hover:bg-dark-surfaceContainer'
                }`}
                aria-expanded={groupExpanded}
                title={group.label}
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
                        className={`group flex items-center gap-2 px-2.5 py-1.5 max-md:py-2.5 rounded-md3-xs text-[13px] max-md:text-sm transition-colors ${
                          activeSessionId === s.id
                            ? 'bg-md-secondaryContainer text-md-onSecondaryContainer'
                            : 'text-dark-onSurfaceVariant/85 hover:bg-dark-surfaceContainer'
                        }`}
                      >
                        <button
                          onClick={() => { setShowSkillStore(false); setActiveSession(s.id); onNavigate?.() }}
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
                          className={`w-6 h-6 max-md:w-9 max-md:h-9 flex items-center justify-center rounded-md3-xs hover:bg-md-error/20 hover:text-md-error transition-opacity flex-shrink-0 ${
                            hoveredSessionId === s.id || activeSessionId === s.id
                              ? 'opacity-100'
                              : 'opacity-0 group-focus-within:opacity-100 max-md:opacity-60'
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

      <div className="border-t border-dark-onSurfaceVariant/10 px-3 py-2 max-md:pb-[calc(0.5rem+env(safe-area-inset-bottom))] flex flex-col gap-0.5">
        {!isWebUIMode && (
          <button
            onClick={handleStartWebUI}
            disabled={webuiStarting}
            className="w-full flex items-center gap-2 px-3 py-2 max-md:py-3 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-sm max-md:text-base text-dark-onSurfaceVariant disabled:opacity-50"
            aria-label={t('sidebar.webuiAria')}
          >
            {webuiStarting ? <Loader2 size={16} className="animate-spin" /> : <Globe size={16} />}
            <span>{webuiStarting ? t('sidebar.webuiStarting') : t('sidebar.webui')}</span>
          </button>
        )}
        <button
          onClick={() => { useSettingsStore.getState().updateSettings({ showSettings: true }); onNavigate?.() }}
          className="w-full flex items-center gap-2 px-3 py-2 max-md:py-3 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-sm max-md:text-base text-dark-onSurfaceVariant"
        >
          <Settings size={16} />
          <span>{t('sidebar.settings')}</span>
        </button>
        {/* 账户按钮（最底）：未登录=用户图标+"未登录" / 已登录=首字母圆头像+用户名 */}
        <button
          onClick={() => { handleOpenAccountSettings(); onNavigate?.() }}
          className="w-full flex items-center gap-2 px-3 py-2 max-md:py-3 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-sm max-md:text-base text-dark-onSurfaceVariant"
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
                className="w-7 h-7 max-md:w-9 max-md:h-9 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors"
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
                className="flex-shrink-0 w-7 h-7 max-md:w-9 max-md:h-9 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainer transition-colors"
                aria-label={t('sidebar.webuiCopy')}
                title={t('sidebar.webuiCopy')}
              >
                {webuiCopied ? <Check size={14} className="text-md-primary" /> : <Copy size={14} />}
              </button>
            </div>
            {webuiCopied && (
              <p className="text-xs text-md-primary mb-1">{t('sidebar.webuiCopied')}</p>
            )}

            {/* 扫码直达：仅在允许局域网访问且探测到网卡地址时展示 */}
            {webuiLanAccess && webuiQrUrl && (
              <div className="flex flex-col items-center gap-1.5 py-3">
                <QrCode text={webuiQrUrl} size={168} />
                <p className="text-xs text-dark-onSurfaceVariant/60 text-center">
                  {t('sidebar.webuiScanHint')}
                </p>
                <code className="text-[10px] break-all text-center text-dark-onSurfaceVariant/50 px-4 select-all">
                  {webuiQrUrl}
                </code>
              </div>
            )}
            {webuiLanAccess && webuiLanMissing && (
              <p className="text-xs text-md-warning text-center py-2">
                {t('sidebar.webuiNoLanIp')}
              </p>
            )}

            <p className="text-xs text-dark-onSurfaceVariant/60 mb-3">
              {t('sidebar.webuiSecurityNote')}
            </p>

            {/* 局域网访问开关：默认仅本机 127.0.0.1；开启后绑定 0.0.0.0 并重启服务 */}
            <div className="mb-4 p-2.5 rounded-md3-md bg-dark-surfaceContainerHigh">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={webuiLanAccess}
                  onChange={handleToggleLanAccess}
                  disabled={webuiRestarting}
                  className="accent-md-primary"
                />
                <span className="text-xs text-dark-onSurface">{t('sidebar.webuiLanAccess')}</span>
              </label>
              <p className="text-xs text-dark-onSurfaceVariant/60 leading-relaxed mt-1">
                {t('sidebar.webuiLanHint')}
              </p>
            </div>

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
