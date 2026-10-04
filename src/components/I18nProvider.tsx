import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../stores/settings-store'
import { detectSystemLanguage } from '../i18n'
import { ipc } from '../lib/ipc-client'

/**
 * 在 Zustand persist 水合后，按 settings.language 应用 i18n 语言。
 * 首次启动（未完成 onboarding）且 language 仍为默认 'zh-CN' 时，
 * 用 navigator.language 检测覆盖（非中文系统 → English）。
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const language = useSettingsStore((s) => s.language)
  const hasCompletedOnboarding = useSettingsStore((s) => s.hasCompletedOnboarding)
  const [hydrated, setHydrated] = useState(false)
  const { i18n } = useTranslation()

  useEffect(() => {
    const unsub = useSettingsStore.persist.onFinishHydration(() => setHydrated(true))
    if (useSettingsStore.persist.hasHydrated()) setHydrated(true)
    return unsub
  }, [])

  useEffect(() => {
    if (!hydrated) return
    // 首次启动 + 未被用户改过的默认值 → 跟随系统 locale
    let effective = language
    if (!hasCompletedOnboarding && language === 'zh-CN') {
      const detected = detectSystemLanguage()
      if (detected !== 'zh-CN') effective = detected
    }
    i18n.changeLanguage(effective)
    /**
     * 把当前语言同步进 KV：主进程那份 i18n 是独立实例，渲染层的 changeLanguage 影响不到它，
     * 而 IM 机器人回复的是**手机上的聊天窗口**——英文界面的人收到全中文回复说不通。
     * 走 KV 而不是新增一条 IPC：这是既有的跨模式共享通道（agent-host 读 agentHostMode 同源）。
     */
    void ipc
      .kvSet('appLanguage', effective)
      .catch(() => {
        /* KV 写不进去只影响 IM 回复的语言，界面本身照常 */
      })
  }, [language, hydrated, hasCompletedOnboarding, i18n])

  return <>{children}</>
}
