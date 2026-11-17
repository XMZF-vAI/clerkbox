import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProvider } from '../src/types/agent'
import type { JouleModel, JouleStateSnapshot } from '../src/types/joule'

const h = vi.hoisted(() => ({
  login: vi.fn(), refresh: vi.fn(), loadKeys: vi.fn(),
}))

vi.mock('../src/lib/shared-storage', () => ({
  sharedStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))
vi.mock('../src/lib/ipc-client', () => ({
  isWebUIMode: false,
  ipc: {
    jouleStartLogin: h.login,
    jouleRefresh: h.refresh,
    loadApiKeys: h.loadKeys,
    jouleLogout: async () => {},
    saveApiKey: async () => {},
    removeApiKey: async () => {},
    pushAgentSettings: async () => {},
  },
}))

import { useJouleStore } from '../src/stores/joule-store'
import { useSettingsStore } from '../src/stores/settings-store'

const DEEPSEEK_FLASH = 'deepseek-v4.1-flash'
const catalog: JouleModel[] = ['other-model', DEEPSEEK_FLASH].map((id) => ({
  id, displayName: id, contextLength: null, est5h: 100, cap: 100, used: 0, remaining: 100,
}))
function account(overrides: Partial<JouleStateSnapshot> = {}): JouleStateSnapshot {
  return {
    status: 'connected', user: { username: 'test-user' },
    plan: { tier: 'pro', label: 'Pro', monthly: 100, w5h: 100, week: 100, conc: 1, concFree: 1, freeDaily: 0 },
    subscription: { tier: 'pro', label: 'Pro', expiresAt: Date.now() + 60_000 },
    expired: null, quotas: null, desktop: null, login: null,
    lastSyncAt: Date.now(), stale: false, error: null, serverNow: Date.now(),
    models: catalog, ...overrides,
  }
}
function provider(id = 'joule'): ModelProvider {
  return { id, name: id, apiCompat: 'openai', apiKey: 'test-key', baseUrl: 'https://example.test/v1', models: [{ id: 'other-model', temperature: 0.2 }, { id: DEEPSEEK_FLASH }] }
}

beforeEach(async () => {
  await useJouleStore.getState().logout()
  useSettingsStore.getState().resetSettings()
  vi.clearAllMocks()
  h.login.mockResolvedValue({ key: 'test-key', models: catalog, account: account() })
  h.loadKeys.mockResolvedValue({ joule: 'test-key' })
})

describe('Joule default activation', () => {
  it('selects DeepSeek V4.1 Flash on first login even when the catalog starts with another model', async () => {
    await useJouleStore.getState().login()
    expect(useSettingsStore.getState()).toMatchObject({ activeProviderId: 'joule', activeModelId: DEEPSEEK_FLASH, model: DEEPSEEK_FLASH })
  })

  it('preserves a selected Joule model and its user parameters on relogin', async () => {
    useSettingsStore.getState().upsertProvider(provider())
    useSettingsStore.getState().activateModel('joule', 'other-model')
    await useJouleStore.getState().login()
    expect(useSettingsStore.getState()).toMatchObject({ model: 'other-model', temperature: 0.2 })
  })

  it('preserves a selected custom provider on login and catalog refresh', async () => {
    useSettingsStore.getState().upsertProvider(provider('custom'))
    useSettingsStore.getState().activateModel('custom', 'other-model')
    await useJouleStore.getState().login()
    h.refresh.mockResolvedValue(account())
    await useJouleStore.getState().refresh()
    expect(useSettingsStore.getState()).toMatchObject({ activeProviderId: 'custom', model: 'other-model' })
  })

  it('selects the default after a subscription arrives without another model catalog', async () => {
    h.login.mockResolvedValue({ key: 'test-key', models: catalog, account: account({ plan: null, subscription: null }) })
    await useJouleStore.getState().login()
    expect(useSettingsStore.getState().model).toBe('')
    h.refresh.mockResolvedValue(account({ models: undefined }))
    await useJouleStore.getState().refresh()
    expect(useSettingsStore.getState().model).toBe(DEEPSEEK_FLASH)
  })

  it('keeps a custom model chosen while waiting for a subscription', async () => {
    h.login.mockResolvedValue({ key: 'test-key', models: catalog, account: account({ plan: null, subscription: null }) })
    await useJouleStore.getState().login()
    useSettingsStore.getState().upsertProvider(provider('custom'))
    useSettingsStore.getState().activateModel('custom', 'other-model')
    h.refresh.mockResolvedValue(account())
    await useJouleStore.getState().refresh()
    expect(useSettingsStore.getState()).toMatchObject({ activeProviderId: 'custom', model: 'other-model' })
  })

  it('restores an existing account with no selected model using the available default', async () => {
    h.refresh.mockResolvedValue(account())
    await useJouleStore.getState().refresh()
    await vi.waitFor(() => expect(useSettingsStore.getState().model).toBe(DEEPSEEK_FLASH))
  })

  it('uses an available fallback when DeepSeek V4.1 Flash is absent and never selects an unavailable model', async () => {
    const models = [catalog[0]!]
    h.login.mockResolvedValue({ key: 'test-key', models, account: account({ models }) })
    await useJouleStore.getState().login()
    expect(useSettingsStore.getState().model).toBe('other-model')
  })

  it('restores the previously selected Joule model after automatic subscription fallback', async () => {
    useSettingsStore.getState().upsertProvider(provider())
    useSettingsStore.getState().upsertProvider(provider('custom'))
    useSettingsStore.getState().activateModel('joule', 'other-model')
    h.refresh.mockResolvedValue(account({ status: 'expired', plan: null }))
    await useJouleStore.getState().refresh()
    expect(useSettingsStore.getState().activeProviderId).toBe('custom')
    h.refresh.mockResolvedValue(account())
    await useJouleStore.getState().refresh()
    expect(useSettingsStore.getState()).toMatchObject({ activeProviderId: 'joule', model: 'other-model' })
  })
})
