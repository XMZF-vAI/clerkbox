import { lazy, Suspense, useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { AlertCircle, Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ChatPage from './components/chat/ChatPage'
import Sidebar from './components/layout/Sidebar'
import TitleBar from './components/layout/TitleBar'
import WorkbenchPanel from './components/workbench/WorkbenchPanel'
import { AgentActionBridge } from './components/workbench/AgentActionBridge'
import { useSettingsStore, migrateProvidersIfNeeded, hydrateProviderApiKeys } from './stores/settings-store'
import { useChatStore } from './stores/chat-store'
import { initMcp } from './stores/mcp-store'
import { useUpdaterStore } from './stores/updater-store'
import { useAccountStore } from './stores/account-store'
import { useJouleStore } from './stores/joule-store'
import { useUIStore } from './stores/ui-store'
import { useVibeStore } from './stores/vibe-store'
import { initScheduledTasks, useScheduledTasksStore } from './stores/scheduled-tasks-store'
import TaskRunHost from './components/scheduled/TaskRunHost'
import TrayBridge from './components/system/TrayBridge'
import CommandPalette from './components/ui/CommandPalette'
import { applyColorScheme, applyAppFont, applyUiScale, resolveSeed } from './lib/theme-engine'
import { I18nProvider } from './components/I18nProvider'
import { isWebUIMode } from './lib/ipc-client'
import { getRemoteConnection, isCloudRemoteMode, subscribeRemoteConnection } from './remote/browser'
import { useIsMobile } from './hooks/use-mobile'
import { useGlobalShortcuts } from './hooks/use-global-shortcuts'
import { VibeResourceBoundary } from './components/vibe/VibeErrorBoundary'
import VibeSessionDrawer from './components/vibe/VibeSessionDrawer'
import SharedStateNotice from './components/remote/SharedStateNotice'
import { startWorkbenchSync } from './lib/workbench-sync'
import { loadSharedWorkbenchHydrationStores, startWorkbenchHydrationRecovery, type WorkbenchHydrationState } from './lib/workbench-hydration'

// 非首屏模块按需加载，避免普通聊天启动时加载设置、技能商店和 VIBE 资源。
const SkillStore = lazy(() => import('./components/chat/SkillStore'))
const ScheduledTasksPage = lazy(() => import('./components/scheduled/ScheduledTasksPage'))
const SettingsPage = lazy(() => import('./components/settings/SettingsPage'))
// 移动端 WebUI：仿 Android 设置的列表/详情页（手机/窄屏使用，电脑仍走 SettingsPage）
const MSettingsPage = lazy(() => import('./components/settings/MSettingsPage'))
const OnboardingFlow = lazy(() => import('./components/onboarding/OnboardingFlow'))
const VibeBackground = lazy(() => import('./components/vibe/VibeBackground'))
// VibeMusicPlayer 已并入 VibeControls 的顶部右侧统一槽位，避免与唤出按钮互相叠压
const VibeControls = lazy(() => import('./components/vibe/VibeControls'))

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSettingsStore((s) => s.theme)
  const colorScheme = useSettingsStore((s) => s.colorScheme)
  const customSeedColor = useSettingsStore((s) => s.customSeedColor)
  const appFont = useSettingsStore((s) => s.appFont)
  const uiScale = useSettingsStore((s) => s.uiScale)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    // Wait for zustand persist to rehydrate
    const unsub = useSettingsStore.persist.onFinishHydration(() => {
      setHydrated(true)
    })
    // In case already hydrated
    if (useSettingsStore.persist.hasHydrated()) {
      setHydrated(true)
    }
    return unsub
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const root = document.documentElement
    const applyTheme = () => {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
      root.classList.toggle('dark', isDark)
      applyColorScheme(resolveSeed(colorScheme, customSeedColor), isDark)
    }
    applyTheme()
    // 跟随系统时监听系统主题变化
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', applyTheme)
    return () => mq.removeEventListener('change', applyTheme)
  }, [theme, colorScheme, customSeedColor, hydrated])

  // 全局字体档位：水合前由 theme-init.js 预设防闪，水合后此处与设置保持一致
  useEffect(() => {
    if (!hydrated) return
    applyAppFont(appFont)
  }, [appFont, hydrated])

  // 字号缩放：同上，theme-init.js 先于 React 预设 --ui-font-size
  useEffect(() => {
    if (!hydrated) return
    applyUiScale(uiScale ?? 1)
  }, [uiScale, hydrated])

  return <>{children}</>
}

export default function App() {
  const { t } = useTranslation()
  const cloudRemote = isCloudRemoteMode()
  const remoteConnection = useSyncExternalStore(subscribeRemoteConnection, getRemoteConnection)
  const [hydrationRecovery, setHydrationRecovery] = useState<WorkbenchHydrationState>({ ready: !cloudRemote, loading: true, pending: [], failed: [] })
  const retryHydration = useRef<(() => void) | null>(null)
  // 侧边栏折叠态在 ui-store（命令面板/快捷键可驱动）；移动端抽屉仍为本地状态
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  useGlobalShortcuts()
  const showSettings = useSettingsStore((s) => s.showSettings)
  const requestedSkillStore = useUIStore((s) => s.showSkillStore)
  const requestedScheduledTasks = useUIStore((s) => s.showScheduledTasks)
  const showSkillStore = requestedSkillStore
  const showScheduledTasks = requestedScheduledTasks
  // 定时任务执行队列：队首任务由不可见的 TaskRunHost 承载
  const headTaskRun = useScheduledTasksStore((s) => s.queue[0])
  const isVibeMode = useVibeStore((s) => s.isVibeMode)
  const readingOpacity = useVibeStore((s) => s.readingOpacity)
  const vibeSidebarOpen = useUIStore((s) => s.vibeSidebarOpen)
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen)
  const hasCompletedOnboarding = useSettingsStore((s) => s.hasCompletedOnboarding)
  // 等待 zustand persist 水合，避免老配置闪烁成欢迎页
  const [hydrated, setHydrated] = useState(() => useSettingsStore.persist.hasHydrated())
  // 圆角窗口：最大化时取消圆角
  const [isMaximized, setIsMaximized] = useState(() => window.clerkbox?.isWindowMaximized ?? false)
  // 移动端（WebUI 窄屏）：侧边栏变为覆盖式抽屉
  const isMobile = useIsMobile()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  useEffect(() => {
    if (showSettings || commandPaletteOpen || !isVibeMode) useUIStore.getState().setVibeSidebarOpen(false)
  }, [showSettings, commandPaletteOpen, isVibeMode])

  useEffect(() => window.clerkbox?.onWindowStateChange(setIsMaximized), [])
  useEffect(() => {
    const off = useSettingsStore.persist.onFinishHydration(() => setHydrated(true))
    if (useSettingsStore.persist.hasHydrated()) setHydrated(true)
    return off
  }, [])

  // This must run before the hydrated gate: a rejected first KV read never
  // calls Zustand's finish callback, so the normal sync loop cannot rescue it.
  useEffect(() => {
    if (!cloudRemote) return
    const recovery = startWorkbenchHydrationRecovery({
      loadStores: loadSharedWorkbenchHydrationStores,
      isConnected: () => getRemoteConnection().state === 'connected',
      subscribeConnection: subscribeRemoteConnection,
      onState: setHydrationRecovery,
    })
    retryHydration.current = recovery.retry
    return () => { retryHydration.current = null; recovery.stop() }
  }, [cloudRemote])

  useEffect(() => {
    if (!hydrated || !hasCompletedOnboarding) return
    return startWorkbenchSync()
  }, [hydrated, hasCompletedOnboarding])

  // 窗口重新聚焦时刷新 Joule 额度/模型（主进程 30 秒节流；WebUI 远程不读本机凭据）
  useEffect(() => {
    if (isWebUIMode && !cloudRemote) return
    const onFocus = () => { void useJouleStore.getState().refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [cloudRemote])

  // 启动遮罩退场信号（见 index.html 的 #clerkbox-startup 与 public/startup-init.js）：
  // 设置水合与会话载入都完成才派发，遮罩不会在数据未就绪时提前揭开空列表。
  // 欢迎页不挂载 ChatPage、不会触发 loadFromDb，此时界面本身已可交互，同样视为就绪。
  const sessionsReady = useChatStore((s) => s.initialized)
  useEffect(() => {
    if (!hydrated) return
    if (!sessionsReady && hasCompletedOnboarding) return
    window.dispatchEvent(new Event('clerkbox-startup-ready'))
  }, [hydrated, sessionsReady, hasCompletedOnboarding])

  // 启动后稍作空闲预取设置页 chunk，首次打开即点即开、不再闪白（延迟加载，不影响启动）
  useEffect(() => {
    if (cloudRemote) return
    const timer = window.setTimeout(() => {
      void import('./components/settings/SettingsPage')
      void import('./components/settings/MSettingsPage')
    }, 2500)
    return () => window.clearTimeout(timer)
  }, [cloudRemote])

  // 老用户迁移：把扁平 customModels 归并成 providers（必须等水合完成再读 state）
  useEffect(() => {
    if (!hydrated) return
    if (!cloudRemote) {
      migrateProvidersIfNeeded()
      void hydrateProviderApiKeys()
    }
    void useAccountStore.getState().init()
    // Joule 账号：订阅主进程快照（模型合并与过期回落都在 store 内）
    const cleanupJoule = useJouleStore.getState().init()
    // MCP 服务器：首次同步 + 订阅配置变化与主进程状态推送
    const cleanupMcp = initMcp()
    // 自动更新：订阅主进程状态推送 + agent 活跃心跳上报（WebUI 模式内部自动跳过）
    const cleanupUpdater = useUpdaterStore.getState().init()
    // 定时任务：启动 20s 心跳调度 + 恢复「保持系统唤醒」
    const cleanupScheduledTasks = cloudRemote ? () => {} : initScheduledTasks()
    return () => {
      cleanupJoule()
      cleanupMcp()
      cleanupUpdater()
      cleanupScheduledTasks()
    }
  }, [hydrated, cloudRemote])

  // 圆角 + transform 创建包含块，使内部 fixed 元素（弹窗、VIBE 控件）也被圆角裁剪
  // WebUI 模式运行在浏览器标签页中，不需要窗口圆角和细边框
  //保佑别崩溃
  const windowShape = isWebUIMode || isMaximized ? '' : 'rounded-xl [transform:translateZ(0)]'

  if (!hydrated || (cloudRemote && !hydrationRecovery.ready)) {
    const offline = cloudRemote && remoteConnection.state !== 'connected'
    const failed = hydrationRecovery.failed.length > 0
    return (
      <main className="flex min-h-screen w-full items-center justify-center bg-[#131417] px-6 pb-24 pt-12 text-[#eeeef2]" aria-busy={!offline && hydrationRecovery.loading}>
        <section className="w-full max-w-md rounded-2xl border border-white/15 bg-[#1b1b21] p-7 shadow-2xl" aria-labelledby="workbench-loading-title">
          {offline ? <WifiOff size={25} className="mb-5 text-[#c8b5f5]" aria-hidden /> : failed ? <AlertCircle size={25} className="mb-5 text-[#c8b5f5]" aria-hidden /> : <Loader2 size={25} className="mb-5 animate-spin text-[#c8b5f5] motion-reduce:animate-none" aria-hidden />}
          <h1 id="workbench-loading-title" className="text-xl font-semibold">{t('remoteAccess.cloudLoadingWorkbench')}</h1>
          <p className="mt-3 text-sm leading-relaxed text-[#b6b3c1]" role={failed && !offline ? 'alert' : 'status'}>{t(offline ? 'remoteAccess.cloudHydrationOffline' : failed ? 'remoteAccess.cloudHydrationFailed' : 'remoteAccess.cloudLoadingWorkbenchNote')}</p>
          {cloudRemote && !offline && failed && <button type="button" onClick={() => retryHydration.current?.()} disabled={hydrationRecovery.loading} className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#c8b5f5] px-4 py-2 text-sm font-medium text-[#251c3a] disabled:opacity-50"><RefreshCw size={15} aria-hidden />{t('remoteAccess.cloudHydrationRetry')}</button>}
        </section>
      </main>
    )
  }

  // 同一 ThemeProvider 包裹 onboarding 与主界面，避免切换时重新挂载导致主题应用竞态
  // （竞态会使新对话页 ThemeWaves 初次读取 CSS 变量时为空，波浪不显示）
  let content: React.ReactNode
  if (!hasCompletedOnboarding) {
    content = (
      <div className={`app-window relative h-screen max-md:h-dvh w-screen max-md:w-full overflow-hidden bg-dark-surface text-dark-onSurface ${windowShape} ${isWebUIMode || isMaximized ? '' : 'border border-dark-onSurfaceVariant/20'}`}>
        <OnboardingFlow />
      </div>
    )
  } else {
    const auxiliaryPageOpen = showSkillStore || showScheduledTasks
    content = (
      <div
        className={`app-window relative flex h-screen max-md:h-dvh w-screen max-md:w-full overflow-hidden ${isVibeMode ? 'vibe-shell text-white' : 'bg-dark-surface text-dark-onSurface'} ${windowShape} ${isWebUIMode || isMaximized ? '' : 'border border-dark-onSurfaceVariant/20'}`}
        style={{ '--vibe-reading-opacity': readingOpacity / 100 } as React.CSSProperties}
      >
        {/* Optional atmosphere never owns the work component lifecycle. */}
        {isVibeMode && (
          <VibeResourceBoundary key="background" fallback="background">
            <Suspense fallback={null}><VibeBackground /></Suspense>
          </VibeResourceBoundary>
        )}
        <div key="navigation" className={isVibeMode ? 'hidden' : 'contents'}>
          {!isMobile && <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />}
          {isMobile && mobileSidebarOpen && (
            <div className="fixed inset-0 z-40">
              <div className="absolute inset-0 bg-black/55" onClick={() => setMobileSidebarOpen(false)} aria-hidden />
              <div className="absolute inset-y-0 left-0 w-[85vw] max-w-xs shadow-elevation-3 animate-slide-in-left">
                <Sidebar collapsed={false} onToggle={() => setMobileSidebarOpen(false)} onNavigate={() => setMobileSidebarOpen(false)} />
              </div>
            </div>
          )}
        </div>
        <div key="workspace" className="workspace-shell relative z-10 flex flex-1 flex-col min-h-0 min-w-0">
          {isVibeMode ? (
            <VibeResourceBoundary fallback="controls">
              <Suspense fallback={<div className="h-16 shrink-0" />}><VibeControls /></Suspense>
            </VibeResourceBoundary>
          ) : (
            <TitleBar sidebarVisible={isMobile ? mobileSidebarOpen : !sidebarCollapsed} onToggleSidebar={isMobile ? () => setMobileSidebarOpen(true) : toggleSidebar} />
          )}
          <main className={`workspace-main relative flex flex-1 min-h-0 min-w-0 overflow-hidden ${isVibeMode ? 'vibe-workspace' : ''}`}>
            <div className={`workspace-chat min-h-0 min-w-0 flex-1 overflow-hidden ${isVibeMode ? 'vibe-reading-surface' : ''}`} aria-hidden={auxiliaryPageOpen} inert={auxiliaryPageOpen}>
              <ChatPage vibe={isVibeMode} />
            </div>
            {/* Keep terminal and browser instances mounted when changing mode or pages. */}
            <div className={auxiliaryPageOpen ? 'pointer-events-none fixed -left-[10000px] top-0 h-px w-px overflow-hidden' : 'contents'} aria-hidden={auxiliaryPageOpen} inert={auxiliaryPageOpen}>
              <WorkbenchPanel vibe={isVibeMode} suspended={auxiliaryPageOpen} />
            </div>
            {auxiliaryPageOpen && (
              <div className="absolute inset-0 z-20 overflow-hidden bg-dark-surface text-dark-onSurface">
                <Suspense fallback={null}>{showScheduledTasks ? <ScheduledTasksPage /> : <SkillStore />}</Suspense>
              </div>
            )}
          </main>
        </div>
        {!cloudRemote && <AgentActionBridge key="agent-bridge" />}
        {isVibeMode && vibeSidebarOpen && <VibeSessionDrawer />}
        <Suspense fallback={null}>
          {showSettings && (
            isMobile && !cloudRemote ? (
              <MSettingsPage onClose={() => useSettingsStore.getState().updateSettings({ showSettings: false })} />
            ) : (
              <SettingsPage onClose={() => useSettingsStore.getState().updateSettings({ showSettings: false })} />
            )
          )}
        </Suspense>
      </div>
    )
  }

  return (
    <ThemeProvider>
      <I18nProvider>
        {/* 系统托盘桥接：下发文案/配置 + 接收托盘点选对话（WebUI 模式内部 no-op） */}
        <TrayBridge />
        {/* 命令面板（Ctrl/Cmd+K）：全局可用，WebUI 模式同样生效 */}
        <CommandPalette />
        <SharedStateNotice />
        <Suspense fallback={null}>{content}</Suspense>
        {/* 定时任务执行宿主：全局唯一实例，队首任务到点即在此运行（onboarding 完成后） */}
        {!cloudRemote && hasCompletedOnboarding && headTaskRun && (
          <TaskRunHost
            key={headTaskRun.runId}
            runId={headTaskRun.runId}
            sessionId={headTaskRun.sessionId}
            prompt={headTaskRun.prompt}
            workingDir={headTaskRun.workingDir}
            model={headTaskRun.model}
          />
        )}
      </I18nProvider>
    </ThemeProvider>
  )
}

//别蹦别蹦别蹦
