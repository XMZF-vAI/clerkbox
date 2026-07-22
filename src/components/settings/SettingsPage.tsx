import { useState, useEffect } from 'react'
import { Cpu, Thermometer, Hash, Palette, RotateCcw, Check, AlertCircle, Info, X, Plus, Pencil, Trash2, Sparkles } from 'lucide-react'
import { useSettingsStore } from '../../stores/settings-store'
import { useVibeStore } from '../../stores/vibe-store'
import { MODEL_PRESETS } from '../../lib/model-presets'
import { MACARON_PRESETS, schemeSwatches } from '../../lib/theme-engine'
import type { CustomModel } from '../../types/agent'

import APP_ICON from '../../assets/icon.png'

type Tab = 'api' | 'appearance' | 'about'

export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>('api')
  const settings = useSettingsStore()
  const isVibeMode = useVibeStore((s) => s.isVibeMode)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [testError, setTestError] = useState('')
  // 模型表单：null=收起，'new'=新增，CustomModel=编辑
  const [editing, setEditing] = useState<null | 'new' | CustomModel>(null)
  const emptyForm = { label: '', model: '', baseUrl: '', apiKey: '' }
  const [form, setForm] = useState(emptyForm)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleTestConnection = async () => {
    setTestStatus('testing')
    setTestError('')
    try {
      const response = await fetch(`${settings.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${settings.apiKey}` },
      })
      if (response.ok) {
        setTestStatus('success')
      } else {
        setTestError(`HTTP ${response.status}: ${await response.text().catch(() => 'Unknown error')}`)
        setTestStatus('error')
      }
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e))
      setTestStatus('error')
    }
  }

  const handlePreset = (preset: typeof MODEL_PRESETS[number]) => {
    setForm((f) => ({ ...f, label: preset.label, model: preset.model, baseUrl: preset.baseUrl }))
  }

  const startAdd = () => { setForm(emptyForm); setEditing('new') }
  const startEdit = (m: CustomModel) => {
    setForm({ label: m.label, model: m.model, baseUrl: m.baseUrl, apiKey: m.apiKey })
    setEditing(m)
  }
  const saveModel = () => {
    if (!form.model.trim() || !form.baseUrl.trim()) return
    const label = form.label.trim() || form.model.trim()
    const wasFirst = settings.customModels.length === 0
    const model: CustomModel = editing === 'new'
      ? { id: `m-${Date.now()}`, label, model: form.model.trim(), baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim() }
      : { ...(editing as CustomModel), label, model: form.model.trim(), baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim() }
    settings.upsertCustomModel(model)
    // 新增的第一个模型自动设为当前
    if (editing === 'new' && wasFirst) settings.activateCustomModel(model.id)
    setEditing(null)
    setForm(emptyForm)
  }

  const tabs: { key: Tab; label: string; icon: typeof Cpu }[] = [
    { key: 'api', label: 'API 配置', icon: Cpu },
    { key: 'appearance', label: '外观', icon: Palette },
    { key: 'about', label: '关于', icon: Info },
  ]

  return (
    // 普通模式下让出标题栏区域（top-11），保证窗口控制按钮始终可见可用；
    // 普通模式不用背景模糊（与清晰标题栏产生割裂感），仅均匀变暗
    <div className={`fixed ${isVibeMode ? 'inset-0' : 'inset-x-0 bottom-0 top-11'} z-50 flex items-center justify-center ${isVibeMode ? 'bg-black/50 backdrop-blur-sm' : 'bg-black/60'}`}>
      <div className="w-[720px] max-w-[92vw] h-[560px] max-h-[82vh] bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-onSurfaceVariant/10">
          <h2 className="text-lg font-semibold">设置</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-44 flex flex-col gap-1 p-3 border-r border-dark-onSurfaceVariant/10">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-md3-sm text-sm transition-colors text-left ${
                  activeTab === t.key
                    ? 'bg-dark-surfaceContainerHigh text-dark-onSurface'
                    : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
                }`}
              >
                <t.icon size={16} />
                <span>{t.label}</span>
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
                    <div className="text-sm font-medium text-dark-onSurface truncate">
                      {settings.customModels.find((m) => m.id === settings.activeCustomModelId)?.label || settings.model}
                    </div>
                    <div className="text-xs text-dark-onSurfaceVariant truncate">{settings.model} · {settings.baseUrl}</div>
                  </div>
                  <button
                    onClick={handleTestConnection}
                    disabled={testStatus === 'testing' || !settings.apiKey}
                    className="px-3 py-1.5 bg-md-primary text-md-onPrimary rounded-md3-sm text-xs font-medium hover:bg-md-primary/90 transition-colors disabled:opacity-50 flex-shrink-0"
                  >
                    {testStatus === 'testing' ? '测试中…' : '测试连接'}
                  </button>
                </div>
                {testStatus === 'success' && (
                  <span className="flex items-center gap-1 text-sm text-md-success"><Check size={14} /> 连接成功</span>
                )}
                {testStatus === 'error' && (
                  <span className="flex items-center gap-1 text-sm text-md-error max-w-full truncate"><AlertCircle size={14} /> {testError}</span>
                )}

                {/* 我的模型 */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">我的模型</label>
                    <button
                      onClick={startAdd}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-md3-sm text-xs text-md-primary hover:bg-md-primary/10 transition-colors"
                    >
                      <Plus size={14} /> 添加模型
                    </button>
                  </div>

                  {settings.customModels.length === 0 && editing === null && (
                    <div className="px-4 py-6 text-center text-sm text-dark-onSurfaceVariant/60 border border-dashed border-dark-onSurfaceVariant/20 rounded-md3-md">
                      还没有模型，点右上角"添加模型"接入你的第一个平台
                    </div>
                  )}

                  <div className="space-y-2">
                    {settings.customModels.map((m) => {
                      const active = m.id === settings.activeCustomModelId
                      return (
                        <div
                          key={m.id}
                          className={`flex items-center gap-3 px-3.5 py-2.5 rounded-md3-md border transition-colors ${
                            active
                              ? 'border-md-primary/40 bg-md-primary/10'
                              : 'border-dark-onSurfaceVariant/10 bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer'
                          }`}
                        >
                          <button onClick={() => settings.activateCustomModel(m.id)} className="flex-1 min-w-0 text-left">
                            <div className="flex items-center gap-2">
                              <span className={`text-sm font-medium truncate ${active ? 'text-md-primary' : 'text-dark-onSurface'}`}>{m.label}</span>
                              {active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-md-primary text-md-onPrimary flex-shrink-0">当前</span>}
                            </div>
                            <div className="text-xs text-dark-onSurfaceVariant truncate mt-0.5">{m.model} · {m.baseUrl}</div>
                          </button>
                          <button onClick={() => startEdit(m)} className="w-7 h-7 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHighest transition-colors flex-shrink-0" aria-label="编辑">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => settings.removeCustomModel(m.id)} className="w-7 h-7 flex items-center justify-center rounded-md3-xs text-dark-onSurfaceVariant hover:text-md-error hover:bg-md-error/10 transition-colors flex-shrink-0" aria-label="删除">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  {/* 添加/编辑表单 */}
                  {editing !== null && (
                    <div className="mt-3 p-4 rounded-md3-md border border-md-primary/20 bg-dark-surfaceContainerHigh space-y-3">
                      <div className="text-sm font-medium">{editing === 'new' ? '添加模型' : '编辑模型'}</div>
                      {/* 推荐模板 */}
                      <div className="flex flex-wrap gap-1.5">
                        {MODEL_PRESETS.map((p) => (
                          <button
                            key={p.model}
                            onClick={() => handlePreset(p)}
                            className="px-2 py-1 rounded-md3-xs text-[11px] border border-dark-onSurfaceVariant/15 text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors"
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <input
                        type="text" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })}
                        placeholder="显示名（可选，默认用模型名）"
                        className="w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                      />
                      <input
                        type="text" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}
                        placeholder="模型 id，如 deepseek-chat / gpt-4o"
                        className="w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                      />
                      <input
                        type="text" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                        placeholder="Base URL，如 https://api.deepseek.com/v1"
                        className="w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                      />
                      <input
                        type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                        placeholder="API Key（该平台专属）"
                        className="w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                      />
                      <div className="flex justify-end gap-2 pt-1">
                        <button onClick={() => { setEditing(null); setForm(emptyForm) }} className="px-3 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer transition-colors">取消</button>
                        <button
                          onClick={saveModel}
                          disabled={!form.model.trim() || !form.baseUrl.trim()}
                          className="px-3 py-1.5 bg-md-primary text-md-onPrimary rounded-md3-sm text-xs font-medium hover:bg-md-primary/90 transition-colors disabled:opacity-40"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="flex items-center gap-2 text-sm font-medium mb-2">
                      <Thermometer size={14} />
                      Temperature
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={settings.temperature}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value)
                        settings.updateSettings({ temperature: isNaN(val) ? 0.7 : val })
                      }}
                      className="w-full px-3 py-2 bg-dark-surfaceContainerHigh rounded-md3-sm text-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="flex items-center gap-2 text-sm font-medium mb-2">
                      <Hash size={14} />
                      Max Tokens
                    </label>
                    <input
                      type="number"
                      min={256}
                      max={128000}
                      step={256}
                      value={settings.maxTokens}
                      onChange={(e) => {
                        const val = parseInt(e.target.value)
                        settings.updateSettings({ maxTokens: isNaN(val) ? 8192 : val })
                      }}
                      className="w-full px-3 py-2 bg-dark-surfaceContainerHigh rounded-md3-sm text-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                    />
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="space-y-6">
                <div>
                  <label className="text-sm font-medium mb-2 block">主题模式</label>
                  <div className="flex gap-2">
                    {(['light', 'dark', 'system'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => settings.updateSettings({ theme: t })}
                        className={`flex-1 py-2 rounded-md3-sm text-sm border transition-colors ${
                          settings.theme === t
                            ? 'border-md-primary/40 bg-md-primary/10 text-md-primary'
                            : 'border-dark-onSurfaceVariant/10 hover:bg-dark-surfaceContainer'
                        }`}
                      >
                        {t === 'light' ? '浅色' : t === 'dark' ? '深色' : '跟随系统'}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium block">马卡龙色系</label>
                  <p className="text-xs text-dark-onSurfaceVariant/60 mt-0.5 mb-3">
                    MD3 动态色彩：从种子色生成整套界面配色
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
                            {p.label}
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
                          title="自定义颜色"
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
                            自定义
                          </span>
                          <input
                            type="color"
                            value={settings.customSeedColor}
                            onChange={(e) =>
                              settings.updateSettings({ customSeedColor: e.target.value, colorScheme: 'custom' })
                            }
                            className="absolute opacity-0 w-0 h-0 pointer-events-none"
                            aria-label="自定义种子色"
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
                <p className="text-sm text-dark-onSurfaceVariant mb-1">v1.6.0</p>
                <p className="text-xs text-dark-onSurfaceVariant/50 mb-6">Single AI Agent Desktop Workbench</p>
                <div className="w-full max-w-[240px] space-y-3 text-sm">
                  <div className="flex justify-between py-2 border-b border-dark-onSurfaceVariant/10">
                    <span className="text-dark-onSurfaceVariant/60">开发者</span>
                    <span className="font-medium">XMZF vAI</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-dark-onSurfaceVariant/10">
                    <span className="text-dark-onSurfaceVariant/60">框架</span>
                    <span>Electron + React</span>
                  </div>
                  <div className="flex justify-between py-2">
                    <span className="text-dark-onSurfaceVariant/60">许可</span>
                    <span>MIT</span>
                  </div>
                </div>
                <p className="mt-8 text-[11px] text-dark-onSurfaceVariant/30 text-center">
                  Copyright 2025 XMZF vAI. All rights reserved.
                </p>
                <button
                  onClick={() => settings.updateSettings({ hasCompletedOnboarding: false, showSettings: false })}
                  className="mt-4 flex items-center gap-1.5 text-xs text-md-primary/80 hover:text-md-primary transition-colors"
                >
                  <Sparkles size={13} />
                  重新显示欢迎页
                </button>
              </div>
            )}

            <div className="mt-8 pt-4 border-t border-dark-onSurfaceVariant/10">
              <button
                onClick={() => {
                  if (window.confirm('确定要恢复所有设置到默认值吗？此操作不可撤销。')) {
                    settings.resetSettings()
                    setTestStatus('idle')
                  }
                }}
                className="flex items-center gap-2 text-sm text-dark-onSurfaceVariant hover:text-md-error transition-colors"
              >
                <RotateCcw size={14} />
                恢复默认设置
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
