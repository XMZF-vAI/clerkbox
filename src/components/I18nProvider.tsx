import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../stores/settings-store'
import { detectSystemLanguage } from '../i18n'

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
    if (!hasCompletedOnboarding && language === 'zh-CN') {
      const detected = detectSystemLanguage()
      if (detected !== 'zh-CN') {
        i18n.changeLanguage(detected)
        return
      }
    }
    i18n.changeLanguage(language)
  }, [language, hydrated, hasCompletedOnboarding, i18n])

  return <>{children}</>
}
