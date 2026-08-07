import { useState, useEffect } from 'react'
import { Cpu, Palette, RotateCcw, Check, AlertCircle, Info, X, Plus, Pencil, Trash2, Sparkles, Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import { useVibeStore } from '../../stores/vibe-store'
import { MACARON_PRESETS, schemeSwatches } from '../../lib/theme-engine'
import { SUPPORTED_LANGUAGES } from '../../i18n'
import { ipc } from '../../lib/ipc-client'
import ProvidersSection from './ProvidersSection'

import APP_ICON from '../../assets/icon.png'

type Tab = 'api' | 'appearance' | 'about'

const THEME_LABEL_KEY: Record<string, string> = {
  light: 'settings.appearance.light',
  dark: 'settings.appearance.dark',
  system: 'settings.appearance.system',
}

export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('api')
  const settings = useSettingsStore()
  const isVibeMode = useVibeStore((s) => s.isVibeMode)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testError, setTestError] = useState('')

  const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
  const activeLabel =
    activeProvider?.models.find((m) => m.id === settings.activeModelId)?.label ||
    settings.model ||
    t('settings.api.noActive')

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // 走主进程代理，两种协议共用一条路径（直连由 provider.directFetch 单独控制）
  const handleTestConnection = async () => {
    setTestStatus('testing')
    setTestError('')
    const res = await ipc.apiTestConnection({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      apiCompat: settings.apiCompat || 'openai',
    })
    if ('error' in res) {
      setTestError(res.error)
      setTestStatus('error')
    } else {
      setTestStatus('success')
    }
  }

  const tabs: { key: Tab; label: string; icon: typeof Cpu }[] = [
    { key: 'api', label: t('settings.tabs.api'), icon: Cpu },
    { key: 'appearance', label: t('settings.tabs.appearance'), icon: Palette },
    { key: 'about', label: t('settings.tabs.about'), icon: Info },
  ]

  return (
    <div className={`fixed ${isVibeMode ? 'inset-0' : 'inset-x-0 bottom-0 top-11'} z-50 flex items-center justify-center ${isVibeMode ? 'bg-black/50 backdrop-blur-sm' : 'bg-black/60'}`}>
      <div className="w-[720px] max-w-[92vw] h-[560px] max-h-[82vh] bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-onSurfaceVariant/10">
          <h2 className="text-lg font-semibold">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-44 flex flex-col gap-1 p-3 border-r border-dark-onSurfaceVariant/10">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-md3-sm text-sm transition-colors text-left ${
                  activeTab === tab.key
                    ? 'bg-dark-surfaceContainerHigh text-dark-onSurface'
                    : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
                }`}
              >
                <tab.icon size={16} />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === 'api' && (
              <div className="space-y-5">
                {/* 当前生效 */}
                <div className="flex items-center gap-3 px-4 py-3 rounded-md3-md bg-md-primary/8 border border-md-primary/20">
                  <Cpu size={16} className="text-md-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-dark-onSurface truncate">
                        {activeLabel}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant flex-shrink-0">
                        {settings.apiCompat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                      </span>
                    </div>
                    <div className="text-xs text-dark-onSurfaceVariant truncate">
                      {activeProvider ? `${activeProvider.name} · ` : ''}{settings.model || t('settings.api.noActive')}
                    </div>
                  </div>
                  <button
                    onClick={handleTestConnection}
                    disabled={testStatus === 'testing' || !settings.baseUrl}
                    className="px-3 py-1.5 bg-md-primary text-md-onPrimary rounded-md3-sm text-xs font-medium hover:bg-md-primary/90 transition-colors disabled:opacity-50 flex-shrink-0"
                  >
                    {testStatus === 'testing' ? t('settings.api.testing') : t('settings.api.testConnection')}
                  </button>
                </div>
                {testStatus === 'success' && (
                  <span className="flex items-center gap-1 text-sm text-md-success"><Check size={14} /> {t('settings.api.testSuccess')}</span>
                )}
                {testStatus === 'error' && (
                  <span className="flex items-center gap-1 text-sm text-md-error max-w-full truncate"><AlertCircle size={14} /> {testError}</span>
                )}

                <ProvidersSection />
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="space-y-6">
                {/* 语言 */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium mb-2">
                    <Languages size={14} />
                    {t('settings.appearance.languageTitle')}
                  </label>
                  <div className="flex gap-2">
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <button
                        key={lang.code}
                        onClick={() => settings.updateSettings({ language: lang.code })}
                        className={`flex-1 px-3 py-2 rounded-md3-sm text-sm transition-colors border ${
                          settings.language === lang.code
                            ? 'border-md-primary/40 bg-md-primary/10 text-md-primary'
                            : 'border-dark-onSurfaceVariant/10 hover:bg-dark-surfaceContainer text-dark-onSurfaceVariant'
                        }`}
                        aria-pressed={settings.language === lang.code}
                      >
                        <div className="font-medium">{lang.label}</div>
                        <div className="text-[10px] opacity-60 mt-0.5">{lang.englishLabel}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">{t('settings.appearance.themeMode')}</label>
                  <div className="flex gap-2">
                    {(['light', 'dark', 'system'] as const).map((theme) => (
                      <button
                        key={theme}
                        onClick={() => settings.updateSettings({ theme })}
                        className={`flex-1 py-2 rounded-md3-sm text-sm border transition-colors ${
                          settings.theme === theme
                            ? 'border-md-primary/40 bg-md-primary/10 text-md-primary'
                            : 'border-dark-onSurfaceVariant/10 hover:bg-dark-surfaceContainer'
                        }`}
                      >
                        {t(THEME_LABEL_KEY[theme])}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium block">{t('settings.appearance.macaronTitle')}</label>
                  <p className="text-xs text-dark-onSurfaceVariant/60 mt-0.5 mb-3">
                    {t('settings.appearance.macaronDesc')}
                  </p>
                  <div className="grid grid-cols-4 gap-y-4">
                    {MACARON_PRESETS.map((p) => {
                      const sw = schemeSwatches(p.seed)
                      const selected = settings.colorScheme === p.id
                      return (
                        <button
                          key={p.id}
                          onClick={() => settings.updateSettings({ colorScheme: p.id })}
                          className="flex flex-col items-center gap-1.5 group"
                          aria-pressed={selected}
                        >
                          <span
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-shadow ${
                              selected
                                ? 'ring-2 ring-md-primary ring-offset-2 ring-offset-dark-surfaceDim'
                                : 'group-hover:ring-2 group-hover:ring-md-primary/30 group-hover:ring-offset-2 group-hover:ring-offset-dark-surfaceDim'
                            }`}
                            style={{
                              background: `conic-gradient(${sw.primary} 0 33%, ${sw.secondary} 33% 66%, ${sw.tertiary} 66% 100%)`,
                            }}
                          >
                            {selected && <Check size={16} className="text-white drop-shadow" />}
                          </span>
                          <span className={`text-xs ${selected ? 'text-md-primary font-medium' : 'text-dark-onSurfaceVariant'}`}>
                            {t(`macaron.${p.id}`)}
                          </span>
                        </button>
                      )
                    })}

                    {/* 自定义种子色 */}
                    {(() => {
                      const sw = schemeSwatches(settings.customSeedColor)
                      const selected = settings.colorScheme === 'custom'
                      return (
                        <label
                          className="flex flex-col items-center gap-1.5 group cursor-pointer"
                          title={t('settings.appearance.customColor')}
                        >
                          <span
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-shadow border-2 border-dashed ${
                              selected
                                ? 'ring-2 ring-md-primary ring-offset-2 ring-offset-dark-surfaceDim border-transparent'
                                : 'border-dark-onSurfaceVariant/30 group-hover:border-md-primary/40'
                            }`}
                            style={{
                              background: `conic-gradient(${sw.primary} 0 33%, ${sw.secondary} 33% 66%, ${sw.tertiary} 66% 100%)`,
                            }}
                          >
                            {selected ? (
                              <Check size={16} className="text-white drop-shadow" />
                            ) : (
                              <Palette size={14} className="text-white drop-shadow" />
                            )}
                          </span>
                          <span className={`text-xs ${selected ? 'text-md-primary font-medium' : 'text-dark-onSurfaceVariant'}`}>
                            {t('settings.appearance.custom')}
                          </span>
                          <input
                            type="color"
                            value={settings.customSeedColor}
                            onChange={(e) =>
                              settings.updateSettings({ customSeedColor: e.target.value, colorScheme: 'custom' })
                            }
                            className="absolute opacity-0 w-0 h-0 pointer-events-none"
                            aria-label={t('settings.appearance.customSeedAriaLabel')}
                          />
                        </label>
                      )
                    })()}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'about' && (
              <div className="flex flex-col items-center justify-center py-8">
                <img src={APP_ICON} alt="ClerkBox" className="w-16 h-16 rounded-xl mb-4" />
                <h3 className="text-xl font-semibold mb-1">ClerkBox</h3>
                <p className="text-sm text-dark-onSurfaceVariant mb-1">{t('settings.about.version')}</p>
                <p className="text-xs text-dark-onSurfaceVariant/50 mb-6">{t('settings.about.tagline')}</p>
                <div className="w-full max-w-[240px] space-y-3 text-sm">
                  <div className="flex justify-between py-2 border-b border-dark-onSurfaceVariant/10">
                    <span className="text-dark-onSurfaceVariant/60">{t('settings.about.developer')}</span>
                    <span className="font-medium">XMZF vAI</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-dark-onSurfaceVariant/10">
                    <span className="text-dark-onSurfaceVariant/60">{t('settings.about.framework')}</span>
                    <span>Electron + React</span>
                  </div>
                  <div className="flex justify-between py-2">
                    <span className="text-dark-onSurfaceVariant/60">{t('settings.about.license')}</span>
                    <span>MIT</span>
                  </div>
                </div>
                <p className="mt-8 text-[11px] text-dark-onSurfaceVariant/30 text-center">
                  {t('settings.about.copyright')}
                </p>
                <button
                  onClick={() => settings.updateSettings({ hasCompletedOnboarding: false, showSettings: false })}
                  className="mt-4 flex items-center gap-1.5 text-xs text-md-primary/80 hover:text-md-primary transition-colors"
                >
                  <Sparkles size={13} />
                  {t('settings.about.reshowOnboarding')}
                </button>
              </div>
            )}

            <div className="mt-8 pt-4 border-t border-dark-onSurfaceVariant/10">
              <button
                onClick={() => {
                  if (window.confirm(t('settings.resetConfirm'))) {
                    settings.resetSettings()
                    setTestStatus('idle')
                  }
                }}
                className="flex items-center gap-2 text-sm text-dark-onSurfaceVariant hover:text-md-error transition-colors"
              >
                <RotateCcw size={14} />
                {t('settings.resetSettings')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
