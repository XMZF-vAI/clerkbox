import { useState, useEffect } from 'react'
import ChatPage from './components/chat/ChatPage'
import SkillStore from './components/chat/SkillStore'
import Sidebar from './components/layout/Sidebar'
import TitleBar from './components/layout/TitleBar'
import SettingsPage from './components/settings/SettingsPage'
import OnboardingFlow from './components/onboarding/OnboardingFlow'
import VibeBackground from './components/vibe/VibeBackground'
import VibeMusicPlayer from './components/vibe/VibeMusicPlayer'
import VibeControls from './components/vibe/VibeControls'
import { useSettingsStore, seedCustomModelsIfEmpty } from './stores/settings-store'
import { useUIStore } from './stores/ui-store'
import { useVibeStore } from './stores/vibe-store'
import { applyColorScheme, resolveSeed } from './lib/theme-engine'
import { I18nProvider } from './components/I18nProvider'

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

  useEffect(() => window.clerkbox?.onWindowStateChange(setIsMaximized), [])
  useEffect(() => useSettingsStore.persist.onFinishHydration(() => setHydrated(true)), [])

  // 老用户迁移：把现有生效配置种子化成第一条自定义模型
  useEffect(() => { seedCustomModelsIfEmpty() }, [])

  // 圆角 + transform 创建包含块，使内部 fixed 元素（弹窗、VIBE 控件）也被圆角裁剪
  const windowShape = isMaximized ? '' : 'rounded-xl [transform:translateZ(0)]'

  if (!hydrated) return null

  // 同一 ThemeProvider 包裹 onboarding 与主界面，避免切换时重新挂载导致主题应用竞态
  // （竞态会使新对话页 ThemeWaves 初次读取 CSS 变量时为空，波浪不显示）
  let content: React.ReactNode
  if (!hasCompletedOnboarding) {
    content = (
      <div className={`app-window relative h-screen w-screen overflow-hidden bg-dark-surface text-dark-onSurface ${windowShape} ${isMaximized ? '' : 'border border-dark-onSurfaceVariant/20'}`}>
        <OnboardingFlow />
      </div>
    )
  } else if (isVibeMode) {
    content = (
      <div className={`app-window relative h-screen w-screen overflow-hidden text-white ${windowShape} ${isMaximized ? '' : 'border border-white/15'}`}>
        <VibeBackground />
        <VibeMusicPlayer />
        <main className="relative z-10 h-full w-full">
          <ChatPage vibe />
        </main>
        <VibeControls />
        {showSettings && <SettingsPage onClose={() => useSettingsStore.getState().updateSettings({ showSettings: false })} />}
      </div>
    )
  } else {
    content = (
      <div className={`app-window flex h-screen w-screen bg-dark-surface text-dark-onSurface overflow-hidden ${windowShape} ${isMaximized ? '' : 'border border-dark-onSurfaceVariant/20'}`}>
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
        <div className="flex flex-col flex-1 min-w-0">
          <TitleBar onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)} />
          <main className="flex-1 min-h-0 overflow-hidden">
            {showSkillStore ? <SkillStore /> : <ChatPage />}
          </main>
        </div>
        {showSettings && <SettingsPage onClose={() => useSettingsStore.getState().updateSettings({ showSettings: false })} />}
      </div>
    )
  }

  return <ThemeProvider><I18nProvider>{content}</I18nProvider></ThemeProvider>
}
