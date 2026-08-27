import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Folder,
  Globe,
  PanelRightClose,
  Plus,
  Search,
  SquareTerminal,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isWebUIMode } from '../../lib/ipc-client'
import { useWorkbenchStore, type WorkbenchTabKind } from '../../stores/workbench-store'
import { useChatStore } from '../../stores/chat-store'
import FilesPanel from './FilesPanel'
import TerminalPanel from './TerminalPanel'
import BrowserPanel from './BrowserPanel'
import { SubAgentDetailContent } from '../chat/SubAgentDetailPanel'

/** 「+」菜单与空态引导条目。子 Agent 为对话产物，刻意不提供任何用户入口 */
type MenuEntry = {
  kind: Exclude<WorkbenchTabKind, 'subagent'>
  icon: typeof Folder
  nameKey: string
  descKey: string
  desktopOnly: boolean
}

const MENU_ENTRIES: MenuEntry[] = [
  { kind: 'files', icon: Folder, nameKey: 'workbench.tabFiles', descKey: 'workbench.filesDesc', desktopOnly: false },
  { kind: 'terminal', icon: SquareTerminal, nameKey: 'workbench.tabTerminal', descKey: 'workbench.terminalDesc', desktopOnly: true },
  { kind: 'browser', icon: Globe, nameKey: 'workbench.tabBrowser', descKey: 'workbench.browserDesc', desktopOnly: true },
]

const KIND_ICON: Record<WorkbenchTabKind, typeof Folder> = {
  files: Folder,
  terminal: SquareTerminal,
  browser: Globe,
  subagent: Bot,
}

/**
 * Trae 式右侧工作台面板坞。
 * - 顶部标签栏 +「+」下拉（带搜索过滤）+ 整体收起按钮
 * - 左缘可拖拽调宽；窄屏（max-md）退化为覆盖式抽屉，不做拖拽
 * - 空标签时展示「从这里开始」三入口引导
 */
export default function WorkbenchPanel({ vibe }: { vibe?: boolean }) {
  const { t } = useTranslation()
  const visible = useWorkbenchStore((s) => s.visible)
  const width = useWorkbenchStore((s) => s.width)
  const tabs = useWorkbenchStore((s) => s.tabs)
  const activeTabId = useWorkbenchStore((s) => s.activeTabId)
  const setVisible = useWorkbenchStore((s) => s.setVisible)
  const setWidth = useWorkbenchStore((s) => s.setWidth)
  const openFiles = useWorkbenchStore((s) => s.openFiles)
  const openTerminal = useWorkbenchStore((s) => s.openTerminal)
  const openBrowser = useWorkbenchStore((s) => s.openBrowser)
  const closeTab = useWorkbenchStore((s) => s.closeTab)

  // 当前会话工作目录：作为新建终端的起始路径（用户未选过则用自动生成的默认目录）
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const activeWorkingDir = useMemo(() => {
    const s = sessions.find((s) => s.id === activeSessionId)
    return s?.workingDir || s?.defaultWorkDir || undefined
  }, [sessions, activeSessionId])

  const [menuOpen, setMenuOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [dragging, setDragging] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // WebUI（远程浏览器）无桌面 shell/窗口能力：终端与浏览器入口隐藏，仅保留文件浏览
  const availableEntries = useMemo(
    () => (isWebUIMode ? MENU_ENTRIES.filter((e) => !e.desktopOnly) : MENU_ENTRIES),
    []
  )

  const openByKind = (kind: MenuEntry['kind']) => {
    if (kind === 'files') openFiles()
    else if (kind === 'terminal') openTerminal()
    else openBrowser()
  }

  useEffect(() => {
    if (!menuOpen) return
    setFilter('')
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // 拖拽调宽：监听一次性 move/up；拖拽期间盖全屏 shield，防止 webview/xterm 吞掉指针事件
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      // 面板贴窗口右缘：宽度 = 视口宽 - 指针 x
      setWidth(window.innerWidth - e.clientX)
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, setWidth])

  if (!visible) return null

  const filteredEntries = availableEntries.filter((e) =>
    t(e.nameKey).toLowerCase().includes(filter.trim().toLowerCase())
  )

  return (
    <aside
      className={`flex max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-[min(92vw,430px)] max-md:flex-col max-md:shadow-2xl md:relative md:h-full md:max-h-full md:w-[var(--wb-width)] md:min-w-[300px] md:shrink-0 flex-col ${
        vibe
          ? 'liquid-glass-strong border-white/15 max-md:rounded-l-xl text-white'
          : 'border-l border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer'
      }`}
      style={{ ['--wb-width']: `${width}px` } as React.CSSProperties}
      role="complementary"
      aria-label={t('workbench.panelAria')}
    >
      {/* 左缘拖拽把手（桌面端） */}
      <div
        onMouseDown={() => setDragging(true)}
        className={`absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize items-stretch md:flex ${
          dragging ? 'bg-md-primary/40' : 'hover:bg-md-primary/25'
        } transition-colors`}
        title={t('workbench.resizeHandleAria')}
        aria-label={t('workbench.resizeHandleAria')}
        data-testid="workbench-resizer"
      />

      {/* 标签栏 */}
      <div className={`relative z-10 flex h-10 shrink-0 items-center gap-1 px-2 ${vibe ? '' : ''}`}>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = KIND_ICON[tab.kind]
            const label =
              tab.kind === 'subagent'
                ? tab.title || t('workbench.subAgentGone')
                : t(`workbench.tab${tab.kind.charAt(0).toUpperCase()}${tab.kind.slice(1)}` as const)
            const isActive = tab.id === activeTabId
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => useWorkbenchStore.setState({ activeTabId: tab.id })}
                className={`group flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md3-md px-2 text-xs transition-colors ${
                  isActive
                    ? vibe
                      ? 'bg-white/15 text-white'
                      : 'bg-md-primary/15 text-md-primary'
                    : vibe
                      ? 'text-white/55 hover:bg-white/8 hover:text-white/85'
                      : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface'
                }`}
                aria-selected={isActive}
                title={label}
              >
                <Icon size={12} className="shrink-0" />
                <span className="max-w-[110px] truncate">{label}</span>
                <span
                  aria-hidden
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className={`ml-0.5 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/20 ${
                    isActive && 'opacity-60'
                  }`}
                >
                  <X size={11} />
                </span>
              </button>
            )
          })}
        </div>

        {/* 「+」菜单 */}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className={`flex h-7 w-7 items-center justify-center rounded-md3-sm transition-colors ${
              vibe ? 'text-white/70 hover:bg-white/10' : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh'
            }`}
            aria-label={t('workbench.addMenu')}
            title={t('workbench.addMenu')}
          >
            <Plus size={15} />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className={`absolute right-0 top-9 z-30 w-64 overflow-hidden rounded-md3-lg shadow-xl ${
                vibe
                  ? 'liquid-glass-strong border border-white/15'
                  : 'border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainerHigh'
              }`}
            >
              <div className={`flex items-center gap-2 px-3 py-2 border-b ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'}`}>
                <Search size={13} className={vibe ? 'text-white/45' : 'text-dark-onSurfaceVariant/50'} />
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && filteredEntries[0]) {
                      openByKind(filteredEntries[0].kind)
                      setMenuOpen(false)
                    }
                    if (e.key === 'Escape') setMenuOpen(false)
                  }}
                  placeholder={t('workbench.menuSearch')}
                  aria-label={t('workbench.menuSearch')}
                  className={`w-full bg-transparent text-xs outline-none ${
                    vibe ? 'text-white placeholder:text-white/35' : 'text-dark-onSurface placeholder:text-dark-onSurfaceVariant/40'
                  }`}
                />
              </div>
              <div className="p-1">
                {filteredEntries.length === 0 ? (
                  <p className={`px-3 py-3 text-center text-xs ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/50'}`}>
                    {t('workbench.menuNoResults')}
                  </p>
                ) : (
                  filteredEntries.map((entry) => {
                    const Icon = entry.icon
                    return (
                      <button
                        key={entry.kind}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          openByKind(entry.kind)
                          setMenuOpen(false)
                        }}
                        className={`flex w-full items-center gap-2.5 rounded-md3-sm px-3 py-2 text-left text-sm transition-colors ${
                          vibe ? 'text-white/85 hover:bg-white/12' : 'text-dark-onSurface hover:bg-dark-surfaceContainerHighest'
                        }`}
                      >
                        <Icon size={15} className={`shrink-0 ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/70'}`} />
                        <span>{t(entry.nameKey)}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </div>

        {/* 收起整块面板 */}
        <button
          type="button"
          onClick={() => setVisible(false)}
          className={`ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md3-sm transition-colors ${
            vibe ? 'text-white/70 hover:bg-white/10' : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh'
          }`}
          aria-label={t('workbench.collapse')}
          title={t('workbench.collapse')}
        >
          <PanelRightClose size={15} />
        </button>
      </div>

      {/* 内容区 */}
      <div className={`min-h-0 flex-1 ${vibe ? 'border-t border-white/10' : 'border-t border-dark-onSurfaceVariant/10'}`}>
        {tabs.length === 0 || !activeTabId ? (
          /* 空态：「从这里开始」引导 */
          <div className="flex h-full flex-col justify-center gap-1 px-8">
            <p className={`mb-4 text-lg font-medium ${vibe ? 'text-white/85' : 'text-dark-onSurfaceVariant/80'}`}>
              {isWebUIMode ? t('workbench.startHereWebUI') : t('workbench.startHere')}
            </p>
            {availableEntries.map((entry) => {
              const Icon = entry.icon
              return (
                <button
                  key={entry.kind}
                  type="button"
                  onClick={() => openByKind(entry.kind)}
                  className={`group flex items-center gap-3 py-2.5 text-left ${vibe ? 'text-white/60 hover:text-white/90' : 'text-dark-onSurfaceVariant/60 hover:text-dark-onSurface'}`}
                >
                  <Icon size={17} className="shrink-0" />
                  <span className="font-medium">{t(entry.nameKey)}</span>
                  <span className={`truncate text-xs ${vibe ? 'text-white/35 group-hover:text-white/55' : 'text-dark-onSurfaceVariant/40 group-hover:text-dark-onSurfaceVariant/70'}`}>
                    {t(entry.descKey)}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <div key={tab.id} className={`h-full ${isActive ? '' : 'hidden'}`}>
                {tab.kind === 'files' && <FilesPanel vibe={vibe} rootDir={activeWorkingDir} />}
                {tab.kind === 'terminal' && <TerminalPanel termId={tab.id} active={isActive} vibe={vibe} cwd={activeWorkingDir} />}
                {tab.kind === 'browser' && <BrowserPanel vibe={vibe} />}
                {tab.kind === 'subagent' && (
                  <SubAgentDetailContent
                    sessionId={tab.sessionId!}
                    runId={tab.runId!}
                    titleSnapshot={tab.title}
                    active={isActive}
                    vibe={vibe}
                    onClose={() => closeTab(tab.id)}
                  />
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 拖拽 shield：覆盖视口吸收鼠标事件，避免 webview/xterm 拖穿 */}
      {dragging && <div className="fixed inset-0 z-40 cursor-col-resize" />}
    </aside>
  )
}
