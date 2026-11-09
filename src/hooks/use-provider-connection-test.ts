import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../lib/ipc-client'
import { useSettingsStore } from '../stores/settings-store'
import type { ModelProvider } from '../types/agent'

const sameConnection = (current: ModelProvider | undefined, snapshot: ModelProvider) =>
  current?.id === snapshot.id && current.baseUrl === snapshot.baseUrl &&
  current.apiKey === snapshot.apiKey && current.apiCompat === snapshot.apiCompat &&
  current.directFetch === snapshot.directFetch && current.presetId === snapshot.presetId

export function useProviderConnectionTest(providerId: string) {
  const { t } = useTranslation()
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testMsg, setTestMsg] = useState('')
  const pending = useRef<{ cancel: () => void } | null>(null)

  useEffect(() => () => { pending.current?.cancel() }, [providerId])

  const testConnection = async () => {
    // The ref closes the gap before React renders the disabled button.
    if (pending.current) return
    const snapshot = useSettingsStore.getState().providers.find((p) => p.id === providerId)
    if (!snapshot) return
    const cfg = { baseUrl: snapshot.baseUrl, apiKey: snapshot.apiKey, apiCompat: snapshot.apiCompat }
    const models = [...snapshot.models]
    const eligible = new Set(models)
    let unsubscribe = () => {}
    const request = {
      cancel: () => {
        if (pending.current === request) pending.current = null
        unsubscribe()
      },
    }
    pending.current = request
    const currentProvider = () => useSettingsStore.getState().providers.find((p) => p.id === providerId)
    const isCurrent = () => pending.current === request && sameConnection(currentProvider(), snapshot)

    // Observe intermediate changes too: switching credentials away and back, or removing/re-adding
    // a model, must not make an old result valid again. Store model edits are immutable.
    unsubscribe = useSettingsStore.subscribe(() => {
      const current = currentProvider()
      if (!sameConnection(current, snapshot)) {
        request.cancel()
        setTestStatus('idle')
        setTestMsg('')
        return
      }
      for (const model of eligible) {
        if (!current!.models.includes(model)) eligible.delete(model)
      }
    })
    setTestStatus('testing')
    setTestMsg('')
    try {
      const res = await ipc.apiTestConnection(cfg)
      if (!isCurrent()) return
      if ('error' in res) throw new Error(res.error)
      if (!models.length) {
        setTestMsg(`${res.latencyMs}ms`)
        setTestStatus('ok')
        return
      }
      setTestMsg(`${res.latencyMs}ms · ${t('settings.api.visionProbing')}`)
      // Keep testing until every probe has settled; ambiguous failures preserve existing values.
      const results = await Promise.allSettled(models.map((m) => ipc.apiTestVision(cfg, m.id)))
      if (!isCurrent()) return
      const visionErrorRe = /image|vision|multimodal|multi-modal|modality|视觉|图片|image_url/i
      const detected = new Map<string, boolean>()
      let unknown = 0
      models.forEach((model, index) => {
        if (!eligible.has(model)) return
        const result = results[index]
        if (result.status === 'fulfilled') {
          const value = result.value
          if (value.ok && value.supported !== null) {
            detected.set(model.id, value.supported)
            return
          }
          if (!value.ok && typeof value.status === 'number' &&
              value.status >= 400 && value.status < 500 && visionErrorRe.test(value.error)) {
            detected.set(model.id, false)
            return
          }
        }
        unknown += 1
      })
      const current = currentProvider()!
      let changed = false
      const updatedModels = current.models.map((model) => {
        const supported = detected.get(model.id)
        if (!eligible.has(model) || supported === undefined || model.supportsImages === supported) return model
        changed = true
        return { ...model, supportsImages: supported }
      })
      if (changed) useSettingsStore.getState().setProviderModels(providerId, updatedModels)
      const supported = updatedModels.filter((m) => m.supportsImages === true).length
      let msg = `${res.latencyMs}ms · ${t('settings.api.visionSummary', { supported, total: updatedModels.length })}`
      if (unknown > 0) msg += ` · ${t('settings.api.visionUnknown', { count: unknown })}`
      setTestMsg(msg)
      setTestStatus('ok')
    } catch (error) {
      if (!isCurrent()) return
      setTestMsg(error instanceof Error ? error.message : String(error))
      setTestStatus('error')
    } finally {
      request.cancel()
    }
  }

  return { testStatus, testMsg, testConnection }
}
