import { useState, useEffect } from 'react'
import ChatPage from './components/chat/ChatPage'
import SkillStore from './components/chat/SkillStore'
import Sidebar from './components/layout/Sidebar'
import TitleBar from './components/layout/TitleBar'
import WorkbenchPanel from './components/workbench/WorkbenchPanel'
import SettingsPage from './components/settings/SettingsPage'
import OnboardingFlow from './components/onboarding/OnboardingFlow'
import VibeBackground from './components/vibe/VibeBackground'
import VibeMusicPlayer from './components/vibe/VibeMusicPlayer'
import VibeControls from './components/vibe/VibeControls'
import { useSettingsStore, migrateProvidersIfNeeded, hydrateProviderApiKeys } from './stores/settings-store'
import { initMcp } from './stores/mcp-store'
import { useAccountStore } from './stores/account-store'
import { useUIStore } from './stores/ui-store'
import { useVibeStore } from './stores/vibe-store'
import { applyColorScheme, resolveSeed } from './lib/theme-engine'
import { I18nProvider } from './components/I18nProvider'
import { isWebUIMode } from './lib/ipc-client'
import { useIsMobile } from './hooks/use-mobile'

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSettingsStore((s) => s.theme)
  const colorScheme = useSettingsStore((s) => s.colorScheme)
  const customSeedColor = useSettingsStore((s) => s.customSeedColor)
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

  return <>{children}</>
}

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const showSettings = useSettingsStore((s) => s.showSettings)
  const showSkillStore = useUIStore((s) => s.showSkillStore)
  const isVibeMode = useVibeStore((s) => s.isVibeMode)
  const hasCompletedOnboarding = useSettingsStore((s) => s.hasCompletedOnboarding)
  // 等待 zustand persist 水合，避免老配置闪烁成欢迎页
  const [hydrated, setHydrated] = useState(() => useSettingsStore.persist.hasHydrated())
  // 圆角窗口：最大化时取消圆角
  const [isMaximized, setIsMaximized] = useState(() => window.clerkbox?.isWindowMaximized ?? false)
  // 移动端（WebUI 窄屏）：侧边栏变为覆盖式抽屉
  const isMobile = useIsMobile()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  useEffect(() => window.clerkbox?.onWindowStateChange(setIsMaximized), [])
  useEffect(() => useSettingsStore.persist.onFinishHydration(() => setHydrated(true)), [])

  // 老用户迁移：把扁平 customModels 归并成 providers（必须等水合完成再读 state）
  useEffect(() => {
    if (!hydrated) return
    migrateProvidersIfNeeded()
    void hydrateProviderApiKeys()
    void useAccountStore.getState().init()
    // MCP 服务器：首次同步 + 订阅配置变化与主进程状态推送
    const cleanupMcp = initMcp()
    return cleanupMcp
  }, [hydrated])

  // 圆角 + transform 创建包含块，使内部 fixed 元素（弹窗、VIBE 控件）也被圆角裁剪
  // WebUI 模式运行在浏览器标签页中，不需要窗口圆角和细边框
  //保佑别崩溃
  const windowShape = isWebUIMode || isMaximized ? '' : 'rounded-xl [transform:translateZ(0)]'

  if (!hydrated) return null

  // 同一 ThemeProvider 包裹 onboarding 与主界面，避免切换时重新挂载导致主题应用竞态
  // （竞态会使新对话页 ThemeWaves 初次读取 CSS 变量时为空，波浪不显示）
  let content: React.ReactNode
  if (!hasCompletedOnboarding) {
    content = (
      <div className={`app-window relative h-screen max-md:h-dvh w-screen overflow-hidden bg-dark-surface text-dark-onSurface ${windowShape} ${isWebUIMode || isMaximized ? '' : 'border border-dark-onSurfaceVariant/20'}`}>
        <OnboardingFlow />
      </div>
    )
  } else if (isVibeMode) {
    content = (
      <div className={`app-window relative h-screen max-md:h-dvh w-screen overflow-hidden text-white ${windowShape} ${isWebUIMode || isMaximized ? '' : 'border border-white/15'}`}>
        <VibeBackground />
        <VibeMusicPlayer />
        <main className="relative z-10 flex h-full w-full">
          <div className="min-w-0 flex-1">
            <ChatPage vibe />
          </div>
          {/* VIBE 模式下工作台走玻璃拟态皮肤；面板自身控制显隐 */}
          <WorkbenchPanel vibe />
        </main>
        <VibeControls />
        {showSettings && <SettingsPage onClose={() => useSettingsStore.getState().updateSettings({ showSettings: false })} />}
      </div>
    )
  } else {
    content = (
      <div className={`app-window flex h-screen max-md:h-dvh w-screen bg-dark-surface text-dark-onSurface overflow-hidden ${windowShape} ${isWebUIMode || isMaximized ? '' : 'border border-dark-onSurfaceVariant/20'}`}>
        {isMobile ? (
          <>
            {/* 移动端：覆盖式抽屉 + 遮罩 */}
            {mobileSidebarOpen && (
              <div className="fixed inset-0 z-40 md:hidden">
                <div
                  className="absolute inset-0 bg-black/55 animate-fade-in"
                  onClick={() => setMobileSidebarOpen(false)}
                  aria-hidden
                />
                <div className="absolute inset-y-0 left-0 w-[85vw] max-w-xs shadow-2xl animate-slide-in-left">
                  <Sidebar
                    collapsed={false}
                    onToggle={() => setMobileSidebarOpen(false)}
                    onNavigate={() => setMobileSidebarOpen(false)}
                  />
                </div>
              </div>
            )}
          </>
        ) : (
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
          />
        )}
        <div className="flex flex-col flex-1 min-w-0">
          <TitleBar onToggleSidebar={isMobile ? () => setMobileSidebarOpen(true) : () => setSidebarCollapsed(!sidebarCollapsed)} />
          <main className="flex-1 min-h-0 overflow-hidden">
            <div className="flex h-full">
              <div className="min-w-0 flex-1 overflow-hidden">
                {showSkillStore ? <SkillStore /> : <ChatPage />}
              </div>
              {/* 技能商店页为独立全屏页，工作台仅在聊天视图挂载 */}
              {!showSkillStore && <WorkbenchPanel />}
            </div>
          </main>
        </div>
        {showSettings && <SettingsPage onClose={() => useSettingsStore.getState().updateSettings({ showSettings: false })} />}
      </div>
    )
  }

  return <ThemeProvider><I18nProvider>{content}</I18nProvider></ThemeProvider>
}
//别蹦别蹦别蹦