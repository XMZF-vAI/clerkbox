import { useState, useEffect, useId, useRef } from 'react'
import { Cpu, Palette, RotateCcw, Check, AlertCircle, Info, X, Plus, Pencil, Trash2, Sparkles, Languages, FileText, Settings, User, LogOut, Upload, Download, Loader2, RefreshCw, Plug } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import { useAccountStore, avatarColorFor, initialOf } from '../../stores/account-store'
import { useVibeStore } from '../../stores/vibe-store'
import { MACARON_PRESETS, schemeSwatches } from '../../lib/theme-engine'
import { SUPPORTED_LANGUAGES } from '../../i18n'
import { ipc } from '../../lib/ipc-client'
import ProvidersSection from './ProvidersSection'
import McpSection from './McpSection'
import TokenUsageStats from './TokenUsageStats'
import ConfirmDialog from '../ui/ConfirmDialog'

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

export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  // 初始 tab 消费侧边栏账户入口留下的 transient 标记（useState 初始值只取一次）
  const [activeTab, setActiveTab] = useState<Tab>(() => useSettingsStore.getState().pendingSettingsTab ?? 'api')
  const settings = useSettingsStore()
  const account = useAccountStore()
  const isVibeMode = useVibeStore((s) => s.isVibeMode)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testError, setTestError] = useState('')
  const [showResetConfirmation, setShowResetConfirmation] = useState(false)
  const [confirmDownload, setConfirmDownload] = useState(false)
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // 消费后立即清空标记，下次打开设置页回到默认 tab
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
    const dialog = dialogRef.current
    const focusableSelector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    closeButtonRef.current?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !dialog) return

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus()
    }
  }, [onClose])

  // 走主进程代理，两种协议共用一条路径（直连由 provider.directFetch 单独控制）
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

  const tabs: { key: Tab; label: string; icon: typeof Cpu }[] = [
    { key: 'api', label: t('settings.tabs.api'), icon: Cpu },
    { key: 'mcp', label: t('settings.tabs.mcp'), icon: Plug },
    { key: 'general', label: t('settings.tabs.general'), icon: Settings },
    { key: 'appearance', label: t('settings.tabs.appearance'), icon: Palette },
    { key: 'account', label: t('settings.tabs.account'), icon: User },
    { key: 'about', label: t('settings.tabs.about'), icon: Info },
  ]

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentTab: Tab) => {
    const currentIndex = tabs.findIndex((tab) => tab.key === currentTab)
    const nextIndex = event.key === 'ArrowDown'
      ? (currentIndex + 1) % tabs.length
      : event.key === 'ArrowUp'
        ? (currentIndex - 1 + tabs.length) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : -1
    if (nextIndex === -1) return

    event.preventDefault()
    const nextTab = tabs[nextIndex].key
    setActiveTab(nextTab)
    document.getElementById(`settings-tab-${nextTab}`)?.focus()
  }

  return (
    <div className={`fixed ${isVibeMode ? 'inset-0' : 'inset-x-0 bottom-0 top-11 max-md:top-14'} z-50 flex items-center justify-center ${isVibeMode ? 'bg-black/50 backdrop-blur-sm' : 'bg-black/60'}`}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-[720px] max-w-[92vw] h-[560px] max-h-[82vh] bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-2xl
          max-md:w-screen max-md:h-full max-md:max-w-none max-md:max-h-none max-md:rounded-none max-md:border-0"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-onSurfaceVariant/10">
          <h2 id={titleId} className="text-lg font-semibold">{t('settings.title')}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="w-8 h-8 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0 max-md:flex-col">
          <div role="tablist" aria-orientation="vertical" className="w-44 flex flex-col gap-1 p-3 border-r border-dark-onSurfaceVariant/10
            max-md:w-full max-md:flex-row max-md:items-center max-md:overflow-x-auto max-md:overscroll-contain max-md:gap-1 max-md:p-2 max-md:border-r-0 max-md:border-b">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                id={`settings-tab-${tab.key}`}
                role="tab"
                aria-selected={activeTab === tab.key}
                aria-controls="settings-tabpanel"
                onClick={() => setActiveTab(tab.key)}
                onKeyDown={(event) => handleTabKeyDown(event, tab.key)}
                className={`flex items-center gap-2.5 px-3 py-2.5 max-md:py-3 max-md:px-4 max-md:flex-shrink-0 rounded-md3-sm text-sm transition-colors text-left ${
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

          <div
            id="settings-tabpanel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${activeTab}`}
            className="flex-1 overflow-y-auto overscroll-contain p-6 max-md:p-4"
          >
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

            {activeTab === 'mcp' && (
              <McpSection />
            )}

            {activeTab === 'general' && (
              <div className="space-y-5">
                {/* 语言 */}
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

                {/* 项目指令 AGENTS.md */}
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

                {/* Token 用量统计 */}
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
                          className="flex flex-col items-center gap-1.5 group cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-md-primary focus-within:outline-offset-2 rounded-md3-sm"
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
              <div className="space-y-5">
                {!account.loggedIn || !account.user ? (
                  <>
                    {/* 未登录：说明 + 登录入口 */}
                    <div className="flex items-start gap-3 p-4 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
                      <User size={16} className="text-md-primary flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-dark-onSurfaceVariant/70 leading-relaxed">
                        {t('account.desc')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void account.login()}
                      disabled={account.loggingIn}
                      className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-md3-md bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors text-sm font-medium disabled:opacity-60"
                    >
                      {account.loggingIn
                        ? <Loader2 size={15} className="animate-spin" />
                        : <User size={15} />}
                      <span>{account.loggingIn ? t('account.loginPending') : t('account.login')}</span>
                    </button>
                    {account.lastError && (
                      <p role="alert" className="flex items-center gap-1 text-sm text-md-error">
                        <AlertCircle size={14} className="flex-shrink-0" />
                        <span className="break-all">{account.lastError}</span>
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    {/* 用户信息卡 */}
                    <div className="flex items-center gap-3 p-4 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
                      <span
                        className="w-10 h-10 rounded-full flex items-center justify-center text-white text-base font-semibold flex-shrink-0"
                        style={{ backgroundColor: avatarColorFor(account.user.username) }}
                        aria-hidden
                      >
                        {initialOf(account.user.username)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-dark-onSurface truncate">
                            {account.user.username}
                          </span>
                          {account.user.isBetaUser && (
                            <span className="px-1.5 py-0.5 rounded-md3-xs bg-md-tertiary/15 text-md-tertiary text-[10px] font-medium whitespace-nowrap flex-shrink-0">
                              {t('account.beta')}
                            </span>
                          )}
                        </div>
                        {account.user.email && (
                          <div className="text-xs text-dark-onSurfaceVariant truncate mt-0.5">
                            {account.user.email}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void account.logout()}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-md-error/15 hover:text-md-error transition-colors flex-shrink-0"
                      >
                        <LogOut size={13} />
                        <span>{t('account.logout')}</span>
                      </button>
                    </div>

                    {/* 同步设置卡 */}
                    <div className="space-y-3 p-4 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
                      <div className="flex items-center gap-2">
                        <RefreshCw size={14} className="text-md-primary flex-shrink-0" />
                        <span className="text-sm font-medium text-dark-onSurface">
                          {t('account.sync.title')}
                        </span>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={account.syncMemory}
                          onChange={(e) => account.setSyncMemory(e.target.checked)}
                          className="accent-md-primary"
                        />
                        <span className="text-xs text-dark-onSurfaceVariant">{t('account.sync.memory')}</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={account.syncModels}
                          onChange={(e) => account.setSyncModels(e.target.checked)}
                          className="accent-md-primary"
                        />
                        <span className="text-xs text-dark-onSurfaceVariant">{t('account.sync.models')}</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={account.autoSync}
                          onChange={(e) => account.setAutoSync(e.target.checked)}
                          className="accent-md-primary"
                        />
                        <span className="text-xs text-dark-onSurfaceVariant">{t('account.sync.auto')}</span>
                      </label>
                      <p className="text-xs text-dark-onSurfaceVariant/60 leading-relaxed">
                        {t('account.sync.autoDesc')}
                      </p>
                    </div>

                    {/* 操作行：上传 / 下载 */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void account.upload()}
                        disabled={account.syncing !== 'idle'}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-md3-sm bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors text-xs font-medium disabled:opacity-50"
                      >
                        {account.syncing === 'uploading'
                          ? <Loader2 size={14} className="animate-spin" />
                          : <Upload size={14} />}
                        <span>
                          {account.syncing === 'uploading' ? t('account.sync.uploading') : t('account.sync.upload')}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDownload(true)}
                        disabled={account.syncing !== 'idle'}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-md3-sm bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-xs font-medium text-dark-onSurfaceVariant disabled:opacity-50"
                      >
                        {account.syncing === 'downloading'
                          ? <Loader2 size={14} className="animate-spin" />
                          : <Download size={14} />}
                        <span>
                          {account.syncing === 'downloading' ? t('account.sync.downloading') : t('account.sync.download')}
                        </span>
                      </button>
                    </div>

                    {/* 上次同步时间 */}
                    <div className="space-y-1.5 p-4 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10 text-xs">
                      <div className="text-dark-onSurfaceVariant/60 mb-1">{t('account.sync.lastSyncAt')}</div>
                      <div className="flex items-center justify-between">
                        <span className="text-dark-onSurfaceVariant">{t('account.sync.memory')}</span>
                        <span className="text-dark-onSurfaceVariant/70">
                          {account.lastSyncAt?.memory
                            ? new Date(account.lastSyncAt.memory).toLocaleString()
                            : t('account.sync.never')}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-dark-onSurfaceVariant">{t('account.sync.models')}</span>
                        <span className="text-dark-onSurfaceVariant/70">
                          {account.lastSyncAt?.models
                            ? new Date(account.lastSyncAt.models).toLocaleString()
                            : t('account.sync.never')}
                        </span>
                      </div>
                    </div>

                    {account.lastError && (
                      <p role="alert" className="flex items-center gap-1 text-sm text-md-error">
                        <AlertCircle size={14} className="flex-shrink-0" />
                        <span className="break-all">{account.lastError}</span>
                      </p>
                    )}
                  </>
                )}
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
                    <span>Apache-2.0</span>
                  </div>
                </div>
                <p className="mt-8 text-[11px] text-dark-onSurfaceVariant/30 text-center">
                  {t('settings.about.copyright')}
                </p>
                <button
                  type="button"
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
                type="button"
                  onClick={() => setShowResetConfirmation(true)}
                className="flex items-center gap-2 text-sm text-dark-onSurfaceVariant hover:text-md-error transition-colors"
              >
                <RotateCcw size={14} />
                {t('settings.resetSettings')}
              </button>
            </div>
          </div>
        </div>
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
      {/* 从云端下载：覆盖本地确认 */}
      {confirmDownload && (
        <ConfirmDialog
          title={t('account.sync.confirmTitle')}
          message={t('account.sync.confirmMsg')}
          confirmText={t('account.sync.download')}
          variant="danger"
          onConfirm={() => {
            setConfirmDownload(false)
            void account.download(true)
          }}
          onCancel={() => setConfirmDownload(false)}
        />
      )}
    </div>
  )
}
