import { useState, useEffect, useId, useRef } from 'react'
import {
  Plus, Trash2, ChevronRight, RefreshCw, Check, AlertCircle,
  Search, ExternalLink, X, Pencil, Eye, EyeOff, Settings2, Thermometer, Hash, Brain,
  Image as ImageIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import {
  PROVIDER_PRESETS, PROVIDER_GROUPS, getPreset, inferThinkingDefaults,
  type ProviderPreset, type ProviderGroup,
} from '../../lib/provider-catalog'
import { ipc } from '../../lib/ipc-client'
import type { ApiCompat, ModelProvider, ProviderModel, ReasoningEffort } from '../../types/agent'
import { REASONING_EFFORTS } from '../../types/agent'
import type { FetchedModel } from '../../types/ipc'

/**
 * 思考模式只有两种（用户可见）：
 * - toggle 开关：开/关思考，不发强度参数
 * - tier 档位：选定一个档位，按协议自动映射（reasoning_effort / thinking_budget / budget_tokens）
 * payload 风格（thinkingStyle）是内部序列化细节，由供应商预设推断，不再暴露给用户。
 */
type ThinkingMode = 'toggle' | 'tier'

const thinkingModeOf = (m: ProviderModel): ThinkingMode =>
  (m.reasoningEfforts?.length ?? 0) > 0 ? 'tier' : 'toggle'

const inputCls =
  'w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors'

/** Keep transient modal focus and keyboard behavior consistent across settings dialogs. */
function useModalAccessibility(onClose: () => void, initialFocus: { current: HTMLElement | null }) {
  const dialogRef = useRef<HTMLDivElement>(null)

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

    if (initialFocus.current) initialFocus.current.focus()
    else dialog?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialog) return

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus()
    }
  }, [initialFocus, onClose])

  return dialogRef
}

const GROUP_LABEL_KEY: Record<ProviderGroup, string> = {
  official: 'settings.providers.groupOfficial',
  international: 'settings.providers.groupInternational',
  china: 'settings.providers.groupChina',
  aggregator: 'settings.providers.groupAggregator',
  local: 'settings.providers.groupLocal',
  custom: 'settings.providers.groupCustom',
}

/** 协议徽章 */
function CompatBadge({ compat }: { compat: ApiCompat }) {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant flex-shrink-0">
      {compat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
    </span>
  )
}

export default function ProvidersSection() {
  const { t } = useTranslation()
  const settings = useSettingsStore()
  const [showCatalog, setShowCatalog] = useState(false)
  const [modelPicker, setModelPicker] = useState<string | null>(null)
  const selectedProvider = modelPicker ? settings.providers.find((provider) => provider.id === modelPicker) : null

  const addFromPreset = (preset: ProviderPreset) => {
    const provider: ModelProvider = {
      id: `p-${Date.now()}`,
      name: preset.name,
      presetId: preset.id === 'custom' ? undefined : preset.id,
      apiCompat: preset.apiCompat,
      baseUrl: preset.baseUrl,
      apiKey: '',
      models: [],
      collapsed: false,
    }
    settings.upsertProvider(provider)
    setShowCatalog(false)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium">{t('settings.providers.title')}</label>
        <button
          type="button"
          onClick={() => setShowCatalog(true)}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md3-sm text-xs text-md-primary hover:bg-md-primary/10 transition-colors"
        >
          <Plus size={14} /> {t('settings.providers.add')}
        </button>
      </div>

      {settings.providers.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-dark-onSurfaceVariant/60 border border-dashed border-dark-onSurfaceVariant/20 rounded-md3-md">
          {t('settings.providers.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {settings.providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              onPickModels={() => setModelPicker(p.id)}
            />
          ))}
        </div>
      )}

      {showCatalog && (
        <CatalogModal onClose={() => setShowCatalog(false)} onPick={addFromPreset} />
      )}
      {selectedProvider && (
        <ModelPickerModal
          provider={selectedProvider}
          onClose={() => setModelPicker(null)}
        />
      )}
    </div>
  )
}

/** 单个提供商卡片：可折叠，内含连接配置与已启用模型 */
function ProviderCard({ provider, onPickModels }: { provider: ModelProvider; onPickModels: () => void }) {
  const { t } = useTranslation()
  const settings = useSettingsStore()
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [manualId, setManualId] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(provider.name)
  const [showKey, setShowKey] = useState(false)
  const [advancedModelId, setAdvancedModelId] = useState<string | null>(null)

  const preset = getPreset(provider.presetId)
  const isActiveProvider = settings.activeProviderId === provider.id
  const expanded = !provider.collapsed

  const patch = (partial: Partial<ModelProvider>) =>
    settings.upsertProvider({ ...provider, ...partial })

  const testConnection = async () => {
    setTestStatus('testing')
    setTestMsg('')
    const cfg = {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiCompat: provider.apiCompat,
    }
    const res = await ipc.apiTestConnection(cfg)
    if ('error' in res) {
      setTestMsg(res.error)
      setTestStatus('error')
      return
    }
    // 连通性通过；无模型则直接出结果
    if (provider.models.length === 0) {
      setTestMsg(`${res.latencyMs}ms`)
      setTestStatus('ok')
      return
    }
    // 连接成功先立即报一声，图片探测完成后再补结果（不憋到最后一起报）
    setTestMsg(`${res.latencyMs}ms · ${t('settings.api.visionProbing')}`)
    setTestStatus('ok')
    // 对全部已启用模型并行探测图片输入支持
    const visionErrorRe = /image|vision|multimodal|multi-modal|modality|视觉|图片|image_url/i
    const results = await Promise.allSettled(
      provider.models.map((m) => ipc.apiTestVision(cfg, m.id))
    )
    let unknown = 0
    let changed = false
    const updatedModels = provider.models.map((m, i) => {
      const r = results[i]
      if (r.status !== 'fulfilled') {
        unknown += 1
        return m
      }
      const v = r.value
      if (v.ok) {
        // 内容判定：说出图里颜色→支持；明确说看不到→不支持；瞎猜颜色等歧义回复→无法判定保持现值
        if (v.supported === null) {
          unknown += 1
          return m
        }
        if (m.supportsImages !== v.supported) changed = true
        return { ...m, supportsImages: v.supported }
      }
      const rejectedForImages =
        typeof v.status === 'number' &&
        v.status >= 400 && v.status < 500 &&
        visionErrorRe.test(v.error)
      if (rejectedForImages) {
        if (m.supportsImages) changed = true
        return { ...m, supportsImages: false }
      }
      // 网络错误/超时/鉴权/限流/5xx/与图片无关的 4xx：无法判定，保持现值
      unknown += 1
      return m
    })
    if (changed) settings.setProviderModels(provider.id, updatedModels)
    const supported = updatedModels.filter((m) => m.supportsImages === true).length
    let msg = `${res.latencyMs}ms · ${t('settings.api.visionSummary', { supported, total: provider.models.length })}`
    if (unknown > 0) msg += ` · ${t('settings.api.visionUnknown', { count: unknown })}`
    setTestMsg(msg)
    setTestStatus('ok')
  }

  const addManualModel = () => {
    const id = manualId.trim()
    if (!id || provider.models.some((m) => m.id === id)) return
    const thinking = inferThinkingDefaults(provider.presetId, id)
    patch({
      models: [...provider.models, {
        id,
        supportsThinking: thinking.supportsThinking,
        thinkingStyle: thinking.thinkingStyle,
        reasoningEfforts: thinking.reasoningEfforts,
        reasoningEffort: thinking.reasoningEfforts[0],
      }],
    })
    setManualId('')
  }

  /** 切换协议：若目录里登记了对应协议的 baseUrl，一并切过去 */
  const switchCompat = (next: ApiCompat) => {
    if (next === provider.apiCompat) return
    if (preset?.altCompat?.apiCompat === next) {
      patch({ apiCompat: next, baseUrl: preset.altCompat.baseUrl })
    } else if (preset && preset.apiCompat === next) {
      patch({ apiCompat: next, baseUrl: preset.baseUrl })
    } else {
      patch({ apiCompat: next })
    }
  }

  return (
    <div
      className={`rounded-md3-md border transition-colors ${
        isActiveProvider
          ? 'border-md-primary/40 bg-md-primary/8'
          : 'border-dark-onSurfaceVariant/10 bg-dark-surfaceContainerHigh'
      }`}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => patch({ collapsed: !provider.collapsed })}
          className="w-5 h-5 flex items-center justify-center text-dark-onSurfaceVariant flex-shrink-0"
          aria-label={expanded ? t('settings.providers.collapse') : t('settings.providers.expand')}
        >
          <ChevronRight size={14} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>

        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => { patch({ name: nameDraft.trim() || provider.name }); setRenaming(false) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { patch({ name: nameDraft.trim() || provider.name }); setRenaming(false) }
              if (e.key === 'Escape') { setNameDraft(provider.name); setRenaming(false) }
            }}
            className="flex-1 min-w-0 px-2 py-1 bg-dark-surfaceContainerHighest rounded-md3-xs text-sm outline-none border border-md-primary/40"
          />
        ) : (
          <button
            type="button"
            onClick={() => patch({ collapsed: !provider.collapsed })}
            className="flex-1 min-w-0 flex items-center gap-2 text-left"
          >
            <span className="text-sm font-medium text-dark-onSurface truncate">{provider.name}</span>
            <CompatBadge compat={provider.apiCompat} />
            <span className="text-xs text-dark-onSurfaceVariant flex-shrink-0">
              {t('settings.providers.modelCount', { count: provider.models.length })}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={() => { setNameDraft(provider.name); setRenaming(true) }}
          className="w-7 h-7 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHighest transition-colors flex-shrink-0"
          aria-label={t('settings.providers.rename')}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          onClick={() => settings.removeProvider(provider.id)}
          className="w-7 h-7 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant hover:text-md-error hover:bg-md-error/10 transition-colors flex-shrink-0"
          aria-label={t('settings.providers.remove')}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {expanded && (
        <div className="px-3.5 pb-3.5 space-y-3 border-t border-dark-onSurfaceVariant/10 pt-3">
          {/* 协议选择 */}
          <div>
            <div className="text-xs text-dark-onSurfaceVariant mb-1.5">{t('settings.providers.compat')}</div>
            <div className="flex gap-2">
              {(['openai', 'anthropic'] as ApiCompat[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => switchCompat(c)}
                  aria-pressed={provider.apiCompat === c}
                  className={`flex-1 px-3 py-1.5 rounded-md3-sm text-xs border transition-colors ${
                    provider.apiCompat === c
                      ? 'border-md-primary/50 bg-md-primary/12 text-md-primary font-medium'
                      : 'border-dark-onSurfaceVariant/15 text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
                  }`}
                >
                  {c === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat'}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-dark-onSurfaceVariant/60 mt-1">
              {t('settings.providers.compatHint')}
            </div>
          </div>

          <input
            type="text"
            aria-label={t('settings.api.baseUrlPlaceholder')}
            value={provider.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
            placeholder={t('settings.api.baseUrlPlaceholder')}
            className={inputCls}
          />
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showKey ? 'text' : 'password'}
                aria-label={t('settings.api.apiKeyPlaceholder')}
                value={provider.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
                placeholder={t('settings.api.apiKeyPlaceholder')}
                className={`${inputCls} pr-9`}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant/60 hover:text-dark-onSurface hover:bg-dark-surfaceContainer transition-colors"
                aria-label={showKey ? t('settings.providers.hideKey') : t('settings.providers.showKey')}
                tabIndex={-1}
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            {preset?.apiKeyUrl && (
              <button
                type="button"
                onClick={() => ipc.openExternal(preset.apiKeyUrl!)}
                className="px-2.5 flex items-center gap-1 rounded-md3-sm text-xs text-md-primary hover:bg-md-primary/10 transition-colors flex-shrink-0 whitespace-nowrap"
              >
                <ExternalLink size={12} /> {t('settings.providers.getKey')}
              </button>
            )}
          </div>

          {/* 直连开关 */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={provider.directFetch ?? false}
              onChange={(e) => patch({ directFetch: e.target.checked })}
              className="accent-md-primary"
            />
            <span className="text-xs text-dark-onSurfaceVariant">{t('settings.providers.directFetch')}</span>
          </label>

          {/* 操作条 */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onPickModels}
              disabled={!provider.baseUrl.trim()}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md3-sm text-xs bg-md-primary text-md-onPrimary font-medium hover:bg-md-primary/90 transition-colors disabled:opacity-40"
            >
              <RefreshCw size={12} /> {t('settings.providers.fetchModels')}
            </button>
            <button
              type="button"
              onClick={testConnection}
              disabled={testStatus === 'testing' || !provider.baseUrl.trim()}
              className="px-2.5 py-1.5 rounded-md3-sm text-xs border border-dark-onSurfaceVariant/15 text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors disabled:opacity-40"
            >
              {testStatus === 'testing' ? t('settings.api.testing') : t('settings.api.testConnection')}
            </button>
            {testStatus === 'ok' && (
              <span role="status" className="flex items-center gap-1 text-xs text-md-success"><Check size={12} /> {testMsg}</span>
            )}
            {testStatus === 'error' && (
              <span role="alert" className="flex items-center gap-1 text-xs text-md-error min-w-0 truncate" title={testMsg}>
                <AlertCircle size={12} className="flex-shrink-0" /> <span className="truncate">{testMsg}</span>
              </span>
            )}
          </div>

          {/* 已启用模型 */}
          {provider.models.length > 0 && (
            <div className="space-y-1">
              {provider.models.map((m) => {
                const active = isActiveProvider && settings.activeModelId === m.id
                const advancedOpen = advancedModelId === m.id
                const patchModel = (partial: Partial<ProviderModel>) => {
                  const models = provider.models.map((x) => (x.id === m.id ? { ...x, ...partial } : x))
                  settings.setProviderModels(provider.id, models)
                  // 若正在编辑当前生效模型，立刻同步派生字段
                  if (active) settings.activateModel(provider.id, m.id)
                }
                return (
                  <div
                    key={m.id}
                    className={`rounded-md3-sm overflow-hidden ${
                      active ? 'bg-md-primary/12' : 'bg-dark-surfaceContainerHighest/50'
                    }`}
                  >
                    <div className="flex items-center gap-2 px-2.5 py-1.5">
                      <button
                        type="button"
                        onClick={() => settings.activateModel(provider.id, m.id)}
                        aria-pressed={active}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span className={`text-xs truncate ${active ? 'text-md-primary font-medium' : 'text-dark-onSurface'}`}>
                            {m.label || m.id}
                          </span>
                          {active && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-md-primary text-md-onPrimary flex-shrink-0">
                              {t('settings.api.currentBadge')}
                            </span>
                          )}
                        </div>
                        {m.label && <div className="text-[10px] text-dark-onSurfaceVariant/70 truncate">{m.id}</div>}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAdvancedModelId(advancedOpen ? null : m.id)}
                        className={`w-6 h-6 flex items-center justify-center rounded-md3-xs transition-colors flex-shrink-0 ${
                          advancedOpen
                            ? 'text-md-primary bg-md-primary/15'
                            : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
                        }`}
                        aria-label={t('settings.providers.modelAdvanced')}
                        aria-expanded={advancedOpen}
                        title={t('settings.providers.modelAdvanced')}
                      >
                        <Settings2 size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => settings.removeProviderModel(provider.id, m.id)}
                        className="w-6 h-6 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant hover:text-md-error hover:bg-md-error/10 transition-colors flex-shrink-0"
                        aria-label={t('settings.api.delete')}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    {advancedOpen && (
                      <div className="px-2.5 pb-2.5 pt-1 border-t border-dark-onSurfaceVariant/8 space-y-2">
                        <label className="flex items-center justify-between text-[10px] text-dark-onSurfaceVariant">
                          <span className="flex items-center gap-1"><Brain size={10} /> {t('settings.api.thinkingSupport')}</span>
                          <input
                            type="checkbox"
                            checked={m.supportsThinking ?? false}
                            onChange={(e) => patchModel({
                              supportsThinking: e.target.checked,
                              reasoningEfforts: [],
                              reasoningEffort: undefined,
                            })}
                            className="accent-md-primary"
                          />
                        </label>
                        <label className="flex items-center justify-between text-[10px] text-dark-onSurfaceVariant">
                          <span className="flex items-center gap-1"><ImageIcon size={10} /> {t('settings.api.imageSupport')}</span>
                          <input
                            type="checkbox"
                            checked={m.supportsImages ?? false}
                            onChange={(e) => patchModel({ supportsImages: e.target.checked })}
                            className="accent-md-primary"
                          />
                        </label>
                        {(m.supportsThinking ?? false) && (
                          <>
                            <div>
                              <div className="text-[10px] text-dark-onSurfaceVariant mb-1">{t('settings.api.thinkingMode')}</div>
                              <div className="flex gap-1">
                                {(['toggle', 'tier'] as const).map((mode) => (
                                  <button
                                    key={mode}
                                    type="button"
                                    onClick={() => {
                                      if (mode === 'tier') {
                                        // 档位模式：可用档位优先取供应商预设，否则放开全部标准档位
                                        const inferred = inferThinkingDefaults(provider.presetId, m.id).reasoningEfforts
                                        const levels: ReasoningEffort[] = inferred.length ? [...inferred] : [...REASONING_EFFORTS]
                                        const keep = m.reasoningEffort && levels.includes(m.reasoningEffort)
                                          ? m.reasoningEffort
                                          : levels.includes('medium') ? 'medium' : levels[0]
                                        patchModel({ reasoningEfforts: levels, reasoningEffort: keep })
                                      } else {
                                        patchModel({ reasoningEfforts: [], reasoningEffort: undefined })
                                      }
                                    }}
                                    className={`px-2 py-1 rounded-md3-xs text-[10px] transition-colors ${
                                      thinkingModeOf(m) === mode
                                        ? 'bg-md-primary/20 text-md-primary'
                                        : 'bg-dark-surfaceContainer text-dark-onSurfaceVariant/60'
                                    }`}
                                  >{t(mode === 'toggle' ? 'settings.api.thinkingModeToggle' : 'settings.api.thinkingModeTier')}</button>
                                ))}
                              </div>
                            </div>
                            {(m.reasoningEfforts?.length ?? 0) > 0 && (
                              <div>
                                <div className="text-[10px] text-dark-onSurfaceVariant mb-1">{t('settings.api.reasoningLevels')}</div>
                                <div className="flex flex-wrap gap-1">
                                  {REASONING_EFFORTS.map((effort) => {
                                    const selected = (m.reasoningEfforts ?? []).includes(effort)
                                    return (
                                      <button
                                        key={effort}
                                        type="button"
                                        onClick={() => {
                                          const next = selected
                                            ? (m.reasoningEfforts ?? []).filter((x) => x !== effort)
                                            : [...(m.reasoningEfforts ?? []), effort].sort(
                                                (a, b) => REASONING_EFFORTS.indexOf(a) - REASONING_EFFORTS.indexOf(b)
                                              )
                                          if (next.length === 0) return // 至少保留一个档位
                                          patchModel({
                                            reasoningEfforts: next,
                                            reasoningEffort: next.includes(m.reasoningEffort || 'medium')
                                              ? (m.reasoningEffort ?? next[0])
                                              : next[0],
                                          })
                                        }}
                                        className={`px-2 py-1 rounded-md3-xs text-[10px] capitalize transition-colors ${
                                          selected
                                            ? 'bg-md-primary/20 text-md-primary'
                                            : 'bg-dark-surfaceContainer text-dark-onSurfaceVariant/60'
                                        }`}
                                      >{effort}</button>
                                    )
                                  })}
                                </div>
                                <div className="text-[9px] text-dark-onSurfaceVariant/60 mt-1">{t('settings.api.reasoningLevelsHint')}</div>
                              </div>
                            )}
                          </>
                        )}
                        <div>
                          <label className="flex items-center gap-1 text-[10px] text-dark-onSurfaceVariant mb-1">
                            <Thermometer size={10} />
                            {t('settings.api.temperature')}
                          </label>
                          <input
                            type="number"
                            aria-label={t('settings.api.temperature')}
                            min={0}
                            max={2}
                            step={0.1}
                            value={m.temperature ?? 0.7}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value)
                              patchModel({ temperature: isNaN(val) ? 0.7 : Math.min(2, Math.max(0, val)) })
                            }}
                            className="w-full px-2 py-1.5 bg-dark-surfaceContainer rounded-md3-xs text-xs border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="flex items-center gap-1 text-[10px] text-dark-onSurfaceVariant mb-1">
                              <Hash size={10} />
                              {t('settings.api.maxInputTokens')}
                            </label>
                            <input
                              type="number"
                              aria-label={t('settings.api.maxInputTokens')}
                              min={4096}
                              max={1000000}
                              step={1024}
                              value={m.maxInputTokens ?? 184000}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10)
                                patchModel({ maxInputTokens: isNaN(val) ? 184000 : Math.min(1000000, Math.max(4096, val)) })
                              }}
                              className="w-full px-2 py-1.5 bg-dark-surfaceContainer rounded-md3-xs text-xs border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                            />
                          </div>
                          <div>
                            <label className="flex items-center gap-1 text-[10px] text-dark-onSurfaceVariant mb-1">
                              <Hash size={10} />
                              {t('settings.api.maxOutputTokens')}
                            </label>
                            <input
                              type="number"
                              aria-label={t('settings.api.maxOutputTokens')}
                              min={256}
                              max={128000}
                              step={256}
                              value={m.maxTokens ?? 16000}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10)
                                patchModel({ maxTokens: isNaN(val) ? 16000 : Math.min(128000, Math.max(256, val)) })
                              }}
                              className="w-full px-2 py-1.5 bg-dark-surfaceContainer rounded-md3-xs text-xs border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* 手填 model id（拉取失败时的兜底） */}
          <div className="flex gap-2">
            <input
              type="text"
              aria-label={t('settings.providers.manualIdPlaceholder')}
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addManualModel() }}
              placeholder={t('settings.providers.manualIdPlaceholder')}
              className={inputCls}
            />
            <button
              type="button"
              onClick={addManualModel}
              disabled={!manualId.trim()}
              aria-label={t('settings.providers.add')}
              className="px-2.5 rounded-md3-sm text-xs border border-dark-onSurfaceVariant/15 text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors disabled:opacity-40 flex-shrink-0"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 添加提供商：分组目录 + 搜索 */
function CatalogModal({ onClose, onPick }: { onClose: () => void; onPick: (p: ProviderPreset) => void }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const titleId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useModalAccessibility(onClose, searchRef)
  const q = query.trim().toLowerCase()

  const matches = (p: ProviderPreset) =>
    !q || p.name.toLowerCase().includes(q) || p.id.includes(q) || p.baseUrl.toLowerCase().includes(q)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-[420px] max-w-[90vw] max-h-[70vh] bg-dark-surfaceDim rounded-md3-lg border border-dark-onSurfaceVariant/10 flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-dark-onSurfaceVariant/10">
          <h2 id={titleId} className="text-sm font-medium">{t('settings.providers.catalogTitle')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="w-7 h-7 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-3 border-b border-dark-onSurfaceVariant/10">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dark-onSurfaceVariant/60" />
            <input
              ref={searchRef}
              aria-label={t('settings.providers.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.providers.searchPlaceholder')}
              className={`${inputCls} pl-8`}
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {PROVIDER_GROUPS.map((g) => {
            const items = PROVIDER_PRESETS.filter((p) => p.group === g && matches(p))
            if (items.length === 0) return null
            return (
              <div key={g} className="mb-2">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-dark-onSurfaceVariant/60">
                  {t(GROUP_LABEL_KEY[g])}
                </div>
                {items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onPick(p)}
                    className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-left"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-dark-onSurface truncate">{p.name}</div>
                      <div className="text-[10px] text-dark-onSurfaceVariant/70 truncate">{p.baseUrl || t('settings.providers.customHint')}</div>
                    </div>
                    <CompatBadge compat={p.apiCompat} />
                    {p.altCompat && (
                      <span className="text-[9px] px-1 py-px rounded bg-md-primary/15 text-md-primary flex-shrink-0">
                        +{p.altCompat.apiCompat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** 在线拉取模型列表 + 多选 */
function ModelPickerModal({ provider, onClose }: { provider: ModelProvider; onClose: () => void }) {
  const { t } = useTranslation()
  const settings = useSettingsStore()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fetched, setFetched] = useState<FetchedModel[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(provider.models.map((m) => m.id))
  )
  const titleId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogRef = useModalAccessibility(onClose, searchRef)
  const requestSequence = useRef(0)

  const load = async () => {
    const requestId = ++requestSequence.current
    setLoading(true)
    setError('')
    try {
      const res = await ipc.apiFetchModels({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        apiCompat: provider.apiCompat,
      })
      if (requestId !== requestSequence.current) return
      if ('error' in res) {
        setError(res.error === 'EMPTY_LIST' ? t('settings.providers.emptyList') : res.error)
        setFetched([])
      } else {
        setFetched(res.models)
      }
    } catch (error) {
      if (requestId !== requestSequence.current) return
      setError(error instanceof Error ? error.message : String(error))
      setFetched([])
    } finally {
      if (requestId === requestSequence.current) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    return () => { requestSequence.current += 1 }
  }, [])

  const q = query.trim().toLowerCase()
  const visible = fetched.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q))

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = () => {
    // 保留已有模型的自定义 label，新选中的取拉取到的 label
    // 新模型按提供商预设自动推断思考能力/档位/风格，避免各家档位名称不一致
    const models: ProviderModel[] = []
    for (const id of selected) {
      const existing = provider.models.find((m) => m.id === id)
      if (existing) models.push(existing)
      else {
        const f = fetched.find((m) => m.id === id)
        const thinking = inferThinkingDefaults(provider.presetId, id)
        models.push({
          id,
          ...(f?.label ? { label: f.label } : {}),
          supportsThinking: thinking.supportsThinking,
          thinkingStyle: thinking.thinkingStyle,
          reasoningEfforts: thinking.reasoningEfforts,
          reasoningEffort: thinking.reasoningEfforts[0],
        })
      }
    }
    models.sort((a, b) => a.id.localeCompare(b.id))
    settings.setProviderModels(provider.id, models)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-[440px] max-w-[90vw] max-h-[70vh] bg-dark-surfaceDim rounded-md3-lg border border-dark-onSurfaceVariant/10 flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-dark-onSurfaceVariant/10">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-medium truncate">{t('settings.providers.pickTitle')}</h2>
            <div className="text-[11px] text-dark-onSurfaceVariant truncate">{provider.name}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="w-7 h-7 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant flex-shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-dark-onSurfaceVariant/10 flex gap-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dark-onSurfaceVariant/60" />
            <input
              ref={searchRef}
              aria-label={t('settings.providers.searchModelPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.providers.searchModelPlaceholder')}
              className={`${inputCls} pl-8`}
            />
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="px-2.5 rounded-md3-sm text-xs border border-dark-onSurfaceVariant/15 text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors disabled:opacity-40 flex-shrink-0"
            aria-label={t('settings.providers.retry')}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 min-h-[120px]">
          {loading ? (
            <div className="px-3 py-6 text-center text-xs text-dark-onSurfaceVariant/60">
              {t('settings.providers.loading')}
            </div>
          ) : error ? (
            <div className="px-3 py-4 space-y-2">
              <div className="flex items-start gap-1.5 text-xs text-md-error">
                <AlertCircle size={13} className="flex-shrink-0 mt-px" />
                <span className="break-all">{error}</span>
              </div>
              <div className="text-[11px] text-dark-onSurfaceVariant/60">
                {t('settings.providers.fetchFailHint')}
              </div>
            </div>
          ) : visible.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-dark-onSurfaceVariant/60">
              {t('settings.providers.noMatch')}
            </div>
          ) : (
            visible.map((m) => {
              const on = selected.has(m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggle(m.id)}
                  aria-pressed={on}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md3-sm transition-colors text-left ${
                    on ? 'bg-md-primary/10' : 'hover:bg-dark-surfaceContainerHigh'
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-md3-xs border flex items-center justify-center flex-shrink-0 ${
                      on ? 'bg-md-primary border-md-primary' : 'border-dark-onSurfaceVariant/30'
                    }`}
                  >
                    {on && <Check size={11} className="text-md-onPrimary" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-xs truncate ${on ? 'text-md-primary' : 'text-dark-onSurface'}`}>
                      {m.label || m.id}
                    </div>
                    {m.label && <div className="text-[10px] text-dark-onSurfaceVariant/70 truncate">{m.id}</div>}
                  </div>
                </button>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-dark-onSurfaceVariant/10">
          <span className="text-[11px] text-dark-onSurfaceVariant">
            {t('settings.providers.selectedCount', { count: selected.size })}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors">
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={save}
              className="px-3 py-1.5 bg-md-primary text-md-onPrimary rounded-md3-sm text-xs font-medium hover:bg-md-primary/90 transition-colors"
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
