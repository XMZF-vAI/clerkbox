import { useState, useEffect, useId, useRef } from 'react'
import {
  Cpu, Palette, RotateCcw, Check, AlertCircle, Info, ChevronRight, Settings as SettingsIcon,
  User, Languages, FileText, Plug, ArrowLeft, Smartphone,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import { useVibeStore } from '../../stores/vibe-store'
import { MACARON_PRESETS, schemeSwatches } from '../../lib/theme-engine'
import { SUPPORTED_LANGUAGES } from '../../i18n'
import ProvidersSection from './ProvidersSection'
import McpSection from './McpSection'
import TokenUsageStats from './TokenUsageStats'
import ConfirmDialog from '../ui/ConfirmDialog'
import { ipc } from '../../lib/ipc-client'

import APP_ICON from '../../assets/icon.png'

type Tab = 'api' | 'mcp' | 'general' | 'appearance' | 'account' | 'about'

const THEME_LABEL_KEY: Record<string, string> = {
  light: 'settings.appearance.light',
  dark: 'settings.appearance.dark',
  system: 'settings.appearance.system',
}

const FONT_LABEL_KEY: Record<string, string> = {
  default: 'settings.appearance.fontDefault',
  serif: 'settings.appearance.fontSerif',
}

/**
 * 移动端 WebUI 设置页：仿 Android 设置的「列表 → 详情」双层结构。
 *
 *  - 根页：分组卡片列表，点击进入详情。
 *  - 详情页：复用桌面设置页的内容，左上角「←」返回根页。
 *  - 账户在移动端刻意禁用（登录/同步涉及 OAuth 与覆盖本地，云端流程需要桌面），
 *    详情内仅展示「请在电脑上操作」占位说明。
 */
export default function MSettingsPage({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>(
    () => useSettingsStore.getState().pendingSettingsTab ?? 'api'
  )
  const [tabStack, setTabStack] = useState<Tab[]>([]) // history for back button
  const settings = useSettingsStore()
  const isVibeMode = useVibeStore((s) => s.isVibeMode)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testError, setTestError] = useState('')
  const [showResetConfirmation, setShowResetConfirmation] = useState(false)
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (useSettingsStore.getState().pendingSettingsTab) {
      useSettingsStore.getState().updateSettings({ pendingSettingsTab: undefined })
    }
  }, [])

  const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
  const activeLabel =
    activeProvider?.models.find((m) => m.id === settings.activeModelId)?.label ||
    settings.model ||
    t('settings.api.noActive')

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (tabStack.length > 0) setTabStack([])
        else onClose()
        return
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus()
    }
  }, [onClose, tabStack.length])

  const handleTestConnection = async () => {
    setTestStatus('testing')
    setTestError('')
    try {
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
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error))
      setTestStatus('error')
    }
  }

  const openTab = (tab: Tab) => {
    setActiveTab(tab)
    setTabStack((prev) => [...prev, tab])
  }

  const goBack = () => {
    setTabStack((prev) => prev.slice(0, -1))
  }

  // ── 列表分组（仿 Android 设置的多组卡片） ──
  const groups: { key: string; items: { tab: Tab; icon: typeof Cpu; label: string; hint: string }[] }[] = [
    {
      key: 'model',
      items: [
        { tab: 'api', icon: Cpu, label: t('settings.tabs.api'), hint: activeLabel },
        { tab: 'mcp', icon: Plug, label: t('settings.tabs.mcp'), hint: t('settings.mcpListHint') },
      ],
    },
    {
      key: 'app',
      items: [
        { tab: 'general', icon: SettingsIcon, label: t('settings.tabs.general'), hint: t('settings.generalTitleHint') },
        { tab: 'appearance', icon: Palette, label: t('settings.tabs.appearance'), hint: t('settings.appearance.themeMode') },
      ],
    },
    {
      key: 'account',
      items: [
        { tab: 'account', icon: User, label: t('settings.tabs.account'), hint: t('settings.accountMobileOnlyHint') },
      ],
    },
    {
      key: 'system',
      items: [
        { tab: 'about', icon: Info, label: t('settings.tabs.about'), hint: t('settings.about.version') },
      ],
    },
  ]

  const inDetail = tabStack.length > 0

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`fixed ${isVibeMode ? 'inset-0' : 'inset-x-0 bottom-0 top-11 max-md:top-14'} z-50 flex flex-col bg-dark-surfaceDim text-dark-onSurface`}
    >
      {/* 顶部导航栏：详情态显示返回 + 标题；列表态只显示标题 + 关闭 */}
      <div className="flex items-center gap-2 px-2 h-12 border-b border-dark-onSurfaceVariant/10 bg-dark-surfaceDim sticky top-0 z-10">
        {inDetail ? (
          <button
            type="button"
            onClick={goBack}
            aria-label={t('common.back')}
            title={t('common.back')}
            className="w-11 h-11 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh active:bg-dark-surfaceContainer transition-colors text-dark-onSurface"
          >
            <ArrowLeft size={20} />
          </button>
        ) : (
          <div className="w-11 h-11 flex items-center justify-center text-md-primary">
            <Smartphone size={20} />
          </div>
        )}
        <h2 id={titleId} className="flex-1 text-base font-semibold truncate">
          {inDetail ? t(`settings.tabs.${activeTab}`) : t('settings.title')}
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="w-11 h-11 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
        >
          <span className="text-xl leading-none">×</span>
        </button>
      </div>

      {/* 内容区：根列表 / 详情 二选一 */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-dark-surface">
        {!inDetail ? (
          <div className="px-3 py-4 space-y-6">
            {groups.map((group) => (
              <section key={group.key}>
                {group.items.map((item, idx) => (
                  <button
                    key={item.tab}
                    type="button"
                    onClick={() => openTab(item.tab)}
                    className={`w-full flex items-center gap-3 px-4 py-3.5 bg-dark-surfaceContainer transition-colors active:bg-dark-surfaceContainerHigh text-left ${
                      idx === 0 ? 'rounded-t-md3-md' : ''
                    } ${idx === group.items.length - 1 ? 'rounded-b-md3-md' : 'border-b border-dark-onSurfaceVariant/5'}`}
                  >
                    <item.icon size={20} className="text-md-primary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-dark-onSurface truncate">{item.label}</div>
                      <div className="text-xs text-dark-onSurfaceVariant/70 truncate mt-0.5">{item.hint}</div>
                    </div>
                    <ChevronRight size={18} className="text-dark-onSurfaceVariant/40 flex-shrink-0" />
                  </button>
                ))}
              </section>
            ))}
            {/* 重置按钮：作为单独一项卡片 */}
            <section>
              <button
                type="button"
                onClick={() => setShowResetConfirmation(true)}
                className="w-full flex items-center gap-3 px-4 py-3.5 bg-dark-surfaceContainer rounded-md3-md transition-colors active:bg-dark-surfaceContainerHigh text-left"
              >
                <RotateCcw size={20} className="text-md-error flex-shrink-0" />
                <span className="text-sm font-medium text-md-error">{t('settings.resetSettings')}</span>
              </button>
            </section>
          </div>
        ) : (
          <div className="px-4 py-5 max-w-screen-md mx-auto">
            {/* 详情：与桌面 SettingsPage 完全一致，只是放在滚动容器内 */}
            {activeTab === 'api' && (
              <div className="space-y-5">
                <div className="flex items-center gap-3 px-4 py-3 rounded-md3-md bg-md-primary/8 border border-md-primary/20">
                  <Cpu size={16} className="text-md-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-dark-onSurface truncate">{activeLabel}</span>
                      {activeProvider && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant flex-shrink-0">
                          {settings.apiCompat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-dark-onSurfaceVariant truncate">
                      {activeProvider ? `${activeProvider.name} · ${settings.model || t('settings.api.noActive')}` : t('settings.api.noActive')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testStatus === 'testing' || !settings.baseUrl}
                    className="px-3 py-1.5 bg-md-primary text-md-onPrimary rounded-md3-sm text-xs font-medium hover:bg-md-primary/90 transition-colors disabled:opacity-50 flex-shrink-0"
                  >
                    {testStatus === 'testing' ? t('settings.api.testing') : t('settings.api.testConnection')}
                  </button>
                </div>
                {testStatus === 'success' && (
                  <span role="status" className="flex items-center gap-1 text-sm text-md-success"><Check size={14} /> {t('settings.api.testSuccess')}</span>
                )}
                {testStatus === 'error' && (
                  <span role="alert" className="flex items-center gap-1 text-sm text-md-error max-w-full truncate"><AlertCircle size={14} /> {testError}</span>
                )}
                <ProvidersSection />
              </div>
            )}

            {activeTab === 'mcp' && <McpSection />}

            {activeTab === 'general' && (
              <div className="space-y-5">
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium mb-2">
                    <Languages size={14} />
                    {t('settings.general.languageTitle')}
                  </label>
                  <div className="flex gap-2">
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <button
                        key={lang.code}
                        type="button"
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

                <div className="space-y-3 p-4 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="text-md-primary flex-shrink-0" />
                    <span className="text-sm font-medium text-dark-onSurface">{t('settings.general.agentsMdTitle')}</span>
                  </div>
                  <p className="text-xs text-dark-onSurfaceVariant/70 leading-relaxed">
                    {t('settings.general.agentsMdDesc')}
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.agentsMdEnabled}
                      onChange={(e) => settings.updateSettings({ agentsMdEnabled: e.target.checked })}
                      className="accent-md-primary"
                    />
                    <span className="text-xs text-dark-onSurfaceVariant">{t('settings.general.agentsMdToggle')}</span>
                  </label>
                  {settings.agentsMdEnabled && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={settings.claudeMdCompat}
                        onChange={(e) => settings.updateSettings({ claudeMdCompat: e.target.checked })}
                        className="accent-md-primary"
                      />
                      <span className="text-xs text-dark-onSurfaceVariant">{t('settings.general.claudeMdCompat')}</span>
                    </label>
                  )}
                </div>

                <TokenUsageStats />
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="space-y-6">
                <div>
                  <label className="text-sm font-medium mb-2 block">{t('settings.appearance.themeMode')}</label>
                  <div className="flex gap-2">
                    {(['light', 'dark', 'system'] as const).map((theme) => (
                      <button
                        key={theme}
                        type="button"
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
                  <label className="text-sm font-medium mb-2 block">{t('settings.appearance.fontTitle')}</label>
                  <div className="flex gap-2">
                    {(['default', 'serif'] as const).map((font) => (
                      <button
                        key={font}
                        type="button"
                        onClick={() => settings.updateSettings({ appFont: font })}
                        className={`flex-1 py-2 rounded-md3-sm text-sm border transition-colors ${
                          settings.appFont === font
                            ? 'border-md-primary/40 bg-md-primary/10 text-md-primary'
                            : 'border-dark-onSurfaceVariant/10 hover:bg-dark-surfaceContainer'
                        }`}
                      >
                        {t(FONT_LABEL_KEY[font])}
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
                          type="button"
                          onClick={() => settings.updateSettings({ colorScheme: p.id })}
                          className="flex flex-col items-center gap-1.5 group"
                          aria-pressed={selected}
                        >
                          <span
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-shadow ${
                              selected
                                ? 'ring-2 ring-md-primary ring-offset-2 ring-offset-dark-surface'
                                : 'group-hover:ring-2 group-hover:ring-md-primary/30 group-hover:ring-offset-2 group-hover:ring-offset-dark-surface'
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

                    {(() => {
                      const sw = schemeSwatches(settings.customSeedColor)
                      const selected = settings.colorScheme === 'custom'
                      return (
                        <label
                          className="flex flex-col items-center gap-1.5 group cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-md-primary focus-within:outline-offset-2 rounded-md3-sm"
                          title={t('settings.appearance.customColor')}
                        >
                          <span
                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-shadow border-2 border-dashed ${
                              selected
                                ? 'ring-2 ring-md-primary ring-offset-2 ring-offset-dark-surface border-transparent'
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
                            className="sr-only"
                            aria-label={t('settings.appearance.customSeedAriaLabel')}
                          />
                        </label>
                      )
                    })()}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'account' && (
              <div className="flex flex-col items-center justify-center text-center py-12 px-4 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
                <div className="w-14 h-14 rounded-full bg-dark-surfaceContainerHigh flex items-center justify-center mb-4">
                  <User size={26} className="text-md-primary" />
                </div>
                <p className="text-base font-medium text-dark-onSurface mb-1">
                  {t('settings.accountMobileOnlyTitle')}
                </p>
                <p className="text-sm text-dark-onSurfaceVariant/70 leading-relaxed max-w-xs">
                  {t('settings.accountMobileOnlyDesc')}
                </p>
              </div>
            )}

            {activeTab === 'about' && (
              <div className="flex flex-col items-center justify-center py-8">
                <img src={APP_ICON} alt="ClerkBox" className="w-16 h-16 rounded-xl mb-4" />
                <h3 className="text-xl font-semibold mb-1">ClerkBox</h3>
                <p className="text-sm text-dark-onSurfaceVariant mb-1">{t('settings.about.version')}</p>
                <p className="text-xs text-dark-onSurfaceVariant/50 mb-6">{t('settings.about.tagline')}</p>
                <div className="w-full max-w-[280px] space-y-3 text-sm">
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
                    <span>Apache-2.0</span>
                  </div>
                </div>
                <p className="mt-8 text-[11px] text-dark-onSurfaceVariant/30 text-center">
                  {t('settings.about.copyright')}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {showResetConfirmation && (
        <ConfirmDialog
          title={t('settings.resetSettings')}
          message={t('settings.resetConfirm')}
          confirmText={t('settings.resetSettings')}
          variant="danger"
          onConfirm={() => {
            settings.resetSettings()
            setTestStatus('idle')
            setShowResetConfirmation(false)
          }}
          onCancel={() => setShowResetConfirmation(false)}
        />
      )}
    </div>
  )
}
