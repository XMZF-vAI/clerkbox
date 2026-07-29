import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Minus, Moon, Monitor, Palette, Sparkles, Sun, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import { MACARON_PRESETS, schemeSwatches } from '../../lib/theme-engine'
import ThemeWaves from '../chat/ThemeWaves'
import { SUPPORTED_LANGUAGES } from '../../i18n'

import APP_ICON from '../../assets/icon.png'

const THEME_OPTIONS = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const

const THEME_LABEL_KEY: Record<string, string> = {
  light: 'onboarding.theme.light',
  dark: 'onboarding.theme.dark',
  system: 'onboarding.theme.system',
}

/** 主按钮：MD3 filled 风格，跟随当前种子色实时变化 */
function PrimaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full bg-md-primary px-8 py-2.5 text-sm font-medium text-md-onPrimary shadow-lg shadow-md-primary/25 transition-all hover:brightness-110 hover:shadow-md-primary/40 active:scale-95"
    >
      {children}
    </button>
  )
}

/** 首次启动欢迎流程：欢迎 → 主题选择 → 启程 */
export default function OnboardingFlow() {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const theme = useSettingsStore((s) => s.theme)
  const colorScheme = useSettingsStore((s) => s.colorScheme)
  const customSeedColor = useSettingsStore((s) => s.customSeedColor)
  const language = useSettingsStore((s) => s.language)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const finish = () => {
    setLeaving(true)
    // 等淡出动画播完再写入完成标记，切换到主界面
    setTimeout(() => updateSettings({ hasCompletedOnboarding: true }), 320)
  }

  return (
    <div
      className={`relative h-full w-full transition-opacity duration-300 ${leaving ? 'opacity-0' : 'opacity-100'}`}
    >
      {/* 顶部拖拽区 + 窗口控制（欢迎页不渲染 TitleBar，需自带） */}
      <div
        className="absolute inset-x-0 top-0 z-20 flex h-11 items-center justify-end pr-2"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => window.clerkbox?.windowAction('minimize')}
            className="rounded-md p-1.5 text-dark-onSurfaceVariant/70 transition-colors hover:bg-dark-onSurfaceVariant/10"
            aria-label={t('common.close')}
          >
            <Minus size={15} />
          </button>
          <button
            onClick={() => window.clerkbox?.windowAction('close')}
            className="rounded-md p-1.5 text-dark-onSurfaceVariant/70 transition-colors hover:bg-md-error hover:text-md-onError"
            aria-label={t('common.close')}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* 步骤内容（key 驱动重挂载，实现切换动画） */}
      <div key={step} className="relative z-10 flex h-full flex-col items-center justify-center px-10 animate-fade-in">
        {step === 0 && (
          <div className="flex flex-col items-center animate-slide-up">
            <div className="relative mb-8">
              <div className="absolute inset-0 scale-125 rounded-[28px] bg-md-primary/30 blur-2xl" aria-hidden="true" />
              <img src={APP_ICON} alt="ClerkBox" className="relative h-24 w-24 rounded-[28px] shadow-xl" />
            </div>
            <h1 className="text-4xl font-bold tracking-wide">{t('onboarding.welcome.title')}</h1>
            <p className="mt-3 text-sm text-dark-onSurfaceVariant/70">{t('onboarding.welcome.subtitle')}</p>

            {/* 语言选择 - 仅首屏 */}
            <div className="mt-8 flex flex-col items-center">
              <p className="text-xs text-dark-onSurfaceVariant/60 mb-2.5">
                {t('onboarding.language.title')} / {t('onboarding.language.subtitle')}
              </p>
              <div className="flex gap-2">
                {SUPPORTED_LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => updateSettings({ language: lang.code })}
                    className={`px-4 py-1.5 rounded-full text-xs font-medium transition ${
                      language === lang.code
                        ? 'bg-md-primary text-md-onPrimary'
                        : 'bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHighest'
                    }`}
                    aria-pressed={language === lang.code}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-8">
              <PrimaryButton onClick={() => setStep(1)}>
                {t('onboarding.welcome.next')}
                <ArrowRight size={16} />
              </PrimaryButton>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="flex w-full max-w-sm flex-col animate-slide-up">
            <h2 className="text-center text-2xl font-semibold">{t('onboarding.theme.title')}</h2>
            <p className="mt-2 text-center text-xs text-dark-onSurfaceVariant/60">{t('onboarding.theme.subtitle')}</p>

            {/* 亮暗模式 */}
            <div className="mt-8 flex gap-2">
              {THEME_OPTIONS.map(({ value, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => updateSettings({ theme: value })}
                  aria-pressed={theme === value}
                  className={`flex flex-1 flex-col items-center gap-1.5 rounded-md3-md border py-3 text-sm transition-colors ${
                    theme === value
                      ? 'border-md-primary/40 bg-md-primary/10 text-md-primary'
                      : 'border-dark-onSurfaceVariant/15 text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
                  }`}
                >
                  <Icon size={18} />
                  {t(THEME_LABEL_KEY[value])}
                </button>
              ))}
            </div>

            {/* MD3 马卡龙色系 */}
            <div className="mt-8">
              <p className="mb-4 text-center text-xs text-dark-onSurfaceVariant/60">{t('onboarding.theme.macaronTitle')}</p>
              <div className="grid grid-cols-4 gap-y-4">
                {MACARON_PRESETS.map((p) => {
                  const sw = schemeSwatches(p.seed)
                  const selected = colorScheme === p.id
                  return (
                    <button
                      key={p.id}
                      onClick={() => updateSettings({ colorScheme: p.id })}
                      className="group flex flex-col items-center gap-1.5"
                      aria-pressed={selected}
                    >
                      <span
                        className={`flex h-10 w-10 items-center justify-center rounded-full transition-shadow ${
                          selected
                            ? 'ring-2 ring-md-primary ring-offset-2 ring-offset-dark-surfaceDim'
                            : 'group-hover:ring-2 group-hover:ring-md-primary/30 group-hover:ring-offset-2 group-hover:ring-offset-dark-surfaceDim'
                        }`}
                        style={{ background: `conic-gradient(${sw.primary} 0 33%, ${sw.secondary} 33% 66%, ${sw.tertiary} 66% 100%)` }}
                      >
                        {selected && <Check size={16} className="text-white drop-shadow" />}
                      </span>
                      <span className={`text-xs ${selected ? 'font-medium text-md-primary' : 'text-dark-onSurfaceVariant'}`}>
                        {t(`macaron.${p.id}`)}
                      </span>
                    </button>
                  )
                })}

                {/* 自定义种子色 */}
                {(() => {
                  const sw = schemeSwatches(customSeedColor)
                  const selected = colorScheme === 'custom'
                  return (
                    <label className="group flex cursor-pointer flex-col items-center gap-1.5" title={t('onboarding.theme.customColor')}>
                      <span
                        className={`flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed transition-shadow ${
                          selected
                            ? 'border-transparent ring-2 ring-md-primary ring-offset-2 ring-offset-dark-surfaceDim'
                            : 'border-dark-onSurfaceVariant/30 group-hover:border-md-primary/40'
                        }`}
                        style={{ background: `conic-gradient(${sw.primary} 0 33%, ${sw.secondary} 33% 66%, ${sw.tertiary} 66% 100%)` }}
                      >
                        {selected ? <Check size={16} className="text-white drop-shadow" /> : <Palette size={14} className="text-white drop-shadow" />}
                      </span>
                      <span className={`text-xs ${selected ? 'font-medium text-md-primary' : 'text-dark-onSurfaceVariant'}`}>{t('onboarding.theme.custom')}</span>
                      <input
                        type="color"
                        value={customSeedColor}
                        onChange={(e) => updateSettings({ customSeedColor: e.target.value, colorScheme: 'custom' })}
                        className="pointer-events-none absolute h-0 w-0 opacity-0"
                        aria-label={t('onboarding.theme.customSeedAriaLabel')}
                      />
                    </label>
                  )
                })()}
              </div>
            </div>

            <div className="mt-10 flex items-center justify-center gap-3">
              <button
                onClick={() => setStep(0)}
                className="inline-flex items-center gap-1.5 rounded-full border border-dark-onSurfaceVariant/20 px-6 py-2.5 text-sm text-dark-onSurfaceVariant transition-colors hover:bg-dark-surfaceContainer"
              >
                <ArrowLeft size={15} />
                {t('onboarding.theme.prev')}
              </button>
              <PrimaryButton onClick={() => setStep(2)}>
                {t('onboarding.theme.next')}
                <ArrowRight size={16} />
              </PrimaryButton>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col items-center animate-slide-up">
            <div className="relative mb-8">
              <div className="absolute inset-0 scale-125 rounded-full bg-md-tertiary/25 blur-2xl" aria-hidden="true" />
              <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-md-primary/15 ring-1 ring-md-primary/30">
                <Sparkles size={44} className="text-md-primary" />
              </div>
            </div>
            <h2 className="text-3xl font-semibold">{t('onboarding.done.title')}</h2>
            <p className="mt-3 text-sm text-dark-onSurfaceVariant/70">{t('onboarding.done.subtitle')}</p>
            <div className="mt-12">
              <PrimaryButton onClick={finish}>
                <Sparkles size={16} />
                {t('onboarding.done.start')}
              </PrimaryButton>
            </div>
          </div>
        )}
      </div>

      {/* 进度指示 */}
      <div className="absolute bottom-10 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              i === step ? 'w-6 bg-md-primary' : 'w-1.5 bg-dark-onSurfaceVariant/25'
            }`}
          />
        ))}
      </div>

      {/* 主题色波浪：第 2 步选色时实时跟随 */}
      <ThemeWaves />
    </div>
  )
}
