import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Folder,
  GitBranch,
  Globe,
  MousePointerClick,
  PanelRight,
  Plus,
  Search,
  SquareTerminal,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isWebUIMode } from '../../lib/ipc-client'
import { useWorkbench, useWorkbenchStore, type WorkbenchTabKind } from '../../stores/workbench-store'
import { useChatStore } from '../../stores/chat-store'
import { useSettingsStore } from '../../stores/settings-store'

// 文件预览包含 PDF/Office/3D 等重依赖，只在用户打开对应标签时下载。
const FilesPanel = lazy(() => import('./FilesPanel'))
const TerminalPanel = lazy(() => import('./TerminalPanel'))
const BrowserPanel = lazy(() => import('./BrowserPanel'))
const AgentBrowserPanel = lazy(() => import('./AgentBrowserPanel'))
const SubAgentDetailContent = lazy(() => import('../chat/SubAgentDetailPanel').then((module) => ({ default: module.SubAgentDetailContent })))
const GitPanel = lazy(() => import('./GitPanel'))

/** 「+」菜单与空态引导条目。子 Agent 为对话产物，刻意不提供任何用户入口 */
type MenuEntry = {
  kind: Exclude<WorkbenchTabKind, 'subagent'>
  icon: typeof Folder
  nameKey: string
  descKey: string
  desktopOnly: boolean
}

/**
 * 「+」菜单只列**用户能自己用的**面板。
 *
 * Agent 浏览器**刻意不在这里**：它不是用户面板，而是「AI 正在操控浏览器」这件事的
 * 视觉载体，由工具层在 AI 真的发出浏览器命令时打开（见 browser-tools 的 ensurePanel）。
 * 给用户一个手动入口等于在宣称「这是个可以自己开的浏览器」，但它的权限模型是反的 ——
 * 页面由模型驱动、用户只能看，手动打开只会得到一个永远停不下来的空面板。
 */
const MENU_ENTRIES: MenuEntry[] = [
  { kind: 'files', icon: Folder, nameKey: 'workbench.tabFiles', descKey: 'workbench.filesDesc', desktopOnly: false },
  { kind: 'git', icon: GitBranch, nameKey: 'workbench.tabGit', descKey: 'workbench.gitDesc', desktopOnly: true },
  { kind: 'terminal', icon: SquareTerminal, nameKey: 'workbench.tabTerminal', descKey: 'workbench.terminalDesc', desktopOnly: true },
  { kind: 'browser', icon: Globe, nameKey: 'workbench.tabBrowser', descKey: 'workbench.browserDesc', desktopOnly: true },
]

const KIND_ICON: Record<WorkbenchTabKind, typeof Folder> = {
  files: Folder,
  git: GitBranch,
  terminal: SquareTerminal,
  browser: Globe,
  'agent-browser': MousePointerClick,
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
  const {
    visible, width, tabs, activeTabId,
    setWidth, openFiles, openGit, openTerminal, openBrowser, activateTab, closeTab, toggleVisible,
  } = useWorkbench()

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

  // 持有 Agent 浏览器标签的所有会话。当前会话的面板在下面的 tabs 里渲染，
  // 其余的走保活挂载点 —— 见那里的注释。
  const slices = useWorkbenchStore((s) => s.slices)
  const foreignAgentBrowserSessions = useMemo(
    () =>
      Object.entries(slices)
        .filter(([, slice]) => slice.tabs.some((t) => t.kind === 'agent-browser'))
        .map(([id]) => id),
    [slices],
  )

  // WebUI（远程浏览器）无桌面 shell/窗口能力：终端与浏览器入口隐藏，仅保留文件浏览。
  // Git 审查只在编程模式提供入口（通用模式隐藏整个 Git 能力面，对齐界面模式分工）。
  const isCodingMode = useSettingsStore((s) => s.interfaceMode === 'coding')
  const availableEntries = useMemo(
    () =>
      MENU_ENTRIES.filter(
        (e) => (isWebUIMode ? !e.desktopOnly : true) && (e.kind !== 'git' || isCodingMode),
      ),
    [isCodingMode],
  )

  const openByKind = (kind: MenuEntry['kind']) => {
    if (kind === 'files') openFiles()
    else if (kind === 'git') openGit()
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

  // Agent 浏览器是「不可见也要活着」的：主进程对该 guest 持有 CDP 附着，
  // 组件卸载即销毁页面，正在进行的任务会直接失败。
  // 所以面板收起时不能 return null —— 改为把整个 aside 挪到视口外的 1px 挂载点，
  // 组件树保持同一份，guest 不重建。代价是收起后文件树/终端也仍在后台挂着，
  // 这与它们在本就「多标签共存」时的行为一致，不引入新的生命周期问题。
  //
  // foreignAgentBrowserSessions 也要算进来：别的会话里可能正跑着浏览器任务，
  // 收起本面板不该顺手把那个 guest 也摘掉。
  const keepAlive = tabs.some((t) => t.kind === 'agent-browser') || foreignAgentBrowserSessions.length > 0
  if (!visible && !keepAlive) return null

  const filteredEntries = availableEntries.filter((e) =>
    t(e.nameKey).toLowerCase().includes(filter.trim().toLowerCase())
  )

  return (
    <>
      {/* 移动端遮罩：点击面板外空白关闭（与左侧会话抽屉行为一致） */}
      {visible && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/55 animate-fade-in"
          onClick={toggleVisible}
          aria-hidden
        />
      )}
      <aside
      aria-hidden={!visible}
      className={`flex flex-col ${
        !visible
          ? 'pointer-events-none fixed left-0 top-0 -z-10 h-px w-px overflow-hidden opacity-[0.001]'
          : `max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-[min(92vw,430px)] max-md:flex-col max-md:shadow-elevation-3 md:relative md:h-full md:max-h-full md:w-[var(--wb-width)] md:min-w-[300px] md:shrink-0 ${
              vibe
                ? 'liquid-glass-strong border-white/15 max-md:rounded-l-xl text-white'
                : 'border-l border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer'
            }`
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
                onClick={() => activateTab(tab.id)}
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
                {/* 真正的子按钮：可 Tab 聚焦、可 Enter 触发，避免嵌 span 只能鼠标点 */}
                <button
                  type="button"
                  aria-label={t('common.close')}
                  title={t('common.close')}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className={`ml-0.5 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/20 focus-visible:outline focus-visible:outline-md-primary/60 ${
                    isActive && 'opacity-60'
                  }`}
                >
                  <X size={11} />
                </button>
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

        {/* 收起按钮：仅 VIBE 模式需要（无标题栏开关，否则面板打开后无法关闭）；普通模式由 TitleBar 负责 */}
        {vibe && (
          <button
            type="button"
            onClick={toggleVisible}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md3-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            aria-label={t('titlebar.toggleWorkbench')}
            title={t('titlebar.toggleWorkbench')}
            data-testid="workbench-collapse"
          >
            <PanelRight size={15} />
          </button>
        )}

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
                {tab.kind === 'files' && <Suspense fallback={null}><FilesPanel vibe={vibe} rootDir={activeWorkingDir} /></Suspense>}
                {tab.kind === 'git' && <Suspense fallback={null}><GitPanel vibe={vibe} workDir={activeWorkingDir} onClose={() => closeTab(tab.id)} /></Suspense>}
                {tab.kind === 'terminal' && <Suspense fallback={null}><TerminalPanel termId={tab.id} active={isActive} vibe={vibe} cwd={activeWorkingDir} /></Suspense>}
                {tab.kind === 'browser' && <Suspense fallback={null}><BrowserPanel vibe={vibe} active={isActive} initialUrl={tab.url} onOpenNewTab={openBrowser} /></Suspense>}
                {tab.kind === 'agent-browser' && <Suspense fallback={null}><AgentBrowserPanel vibe={vibe} /></Suspense>}
                {tab.kind === 'subagent' && (
                  <Suspense fallback={null}>
                    <SubAgentDetailContent
                      sessionId={tab.sessionId!}
                      runId={tab.runId!}
                      titleSnapshot={tab.title}
                      active={isActive}
                      vibe={vibe}
                      onClose={() => closeTab(tab.id)}
                    />
                  </Suspense>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 非当前会话的 Agent 浏览器保活挂载点。
          工具层请面板时开的是**正在跑任务的那个会话**，用户可能正看着别的对话。
          这些面板不在视野里，但 webview 必须真的挂载 —— 卸载即销毁页面，
          而主进程对该 guest 持有 CDP 附着，正在进行的浏览器任务会直接失败。
          所以「不显示」用移到视口外 + aria-hidden 实现，绝不用条件渲染摘掉。 */}
      {foreignAgentBrowserSessions
        .filter((id) => id !== activeSessionId)
        .map((sessionId) => (
          <div
            key={`foreign-agent-browser-${sessionId}`}
            aria-hidden
            className="pointer-events-none fixed left-0 top-0 -z-10 h-px w-px overflow-hidden opacity-[0.001]"
          >
            <Suspense fallback={null}>
              <AgentBrowserPanel vibe={vibe} />
            </Suspense>
          </div>
        ))}

      {/* 拖拽 shield：覆盖视口吸收鼠标事件，避免 webview/xterm 拖穿 */}
      {dragging && <div className="fixed inset-0 z-40 cursor-col-resize" />}
    </aside>
    </>
  )
}
