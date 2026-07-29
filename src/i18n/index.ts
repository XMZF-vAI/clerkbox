import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en'
import zhCN from './locales/zh-CN'

export const SUPPORTED_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文', englishLabel: 'Simplified Chinese' },
  { code: 'en', label: 'English', englishLabel: 'English' },
] as const

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code']

/** 根据 navigator.language 检测首选语言：zh* → 简体中文，其他 → English */
export function detectSystemLanguage(): LanguageCode {
  const lang = navigator.language.toLowerCase()
  return lang.startsWith('zh') ? 'zh-CN' : 'en'
}

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
  },
  lng: 'zh-CN',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
})

export default i18n
