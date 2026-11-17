import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeRemoteState } from '../electron/remote-state'
import { createStore } from 'zustand/vanilla'
import { persist } from 'zustand/middleware'
import { startWorkbenchHydrationRecovery } from '../src/lib/workbench-hydration'
const h = vi.hoisted(() => ({
  cloud: true, scope: 'room-a:device-a', host: new Map<string, string>(),
  kvGet: vi.fn(async (_name: string): Promise<string | null> => null),
  kvPatch: vi.fn(async (_patch: { name: string; base: string | null; value: string | null }): Promise<{ value: string | null }> => ({ value: null })),
  kvSet: vi.fn(async (_name: string, _value: string) => {}),
  kvRemove: vi.fn(async (_name: string) => {}),
}))
vi.mock('../src/lib/ipc-client', () => ({ isWebUIMode: true, ipc: { kvGet: h.kvGet, kvPatch: h.kvPatch, kvSet: h.kvSet, kvRemove: h.kvRemove } }))
vi.mock('../src/remote/browser', () => ({ isCloudRemoteMode: () => h.cloud, getRemoteStorageScope: () => h.scope }))
import { flushSharedStorage, refreshSharedState, sharedStorage, subscribeSharedState } from '../src/lib/shared-storage'
let local: Map<string, string>
let events: unknown[]
const saved = (state: Record<string, unknown>) => JSON.stringify({ state, version: 0 })
beforeEach(async () => {
  await flushSharedStorage().catch(() => {})
  vi.clearAllMocks()
  h.host.clear(); h.cloud = true; h.scope = 'room-a:device-a'
  local = new Map(); events = []
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public detail: unknown) {} })
  vi.stubGlobal('window', { dispatchEvent: (event: unknown) => { events.push(event) }, localStorage: { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) } })
  h.kvGet.mockImplementation(async name => h.host.get(name) ?? null)
  h.kvPatch.mockImplementation(async patch => {
    const value = mergeRemoteState(patch.name, h.host.get(patch.name) ?? null, patch.base, patch.value)
    if (value === null) h.host.delete(patch.name); else h.host.set(patch.name, value)
    return { value }
  })
})
afterEach(() => vi.unstubAllGlobals())
describe('shared paired workbench persistence', () => {
  it('keeps a failed real persist hydration unwritable until the host returns, then recovers without remounting', async () => {
    h.kvGet.mockRejectedValueOnce(new Error('remoteAccess.cloudDisconnected'))
    const finished: unknown[] = []
    const store = createStore(persist(() => ({ bySession: {}, transient: false }), {
      name: 'clerkbox-goal-store', storage: sharedStorage,
      onRehydrateStorage: () => (_state, error) => { finished.push(error) },
    }))
    await vi.waitFor(() => expect(finished).toHaveLength(1))
    expect(store.persist.hasHydrated()).toBe(false)
    store.setState({ transient: true })
    await flushSharedStorage()
    expect(h.kvPatch).not.toHaveBeenCalled()
    expect(h.kvSet).not.toHaveBeenCalled()
    h.host.set('clerkbox-goal-store', saved({ bySession: { hostSession: { condition: 'Preserve host goal' } } }))
    let onConnection = () => {}
    let connected = false
    const recovery = startWorkbenchHydrationRecovery({
      loadStores: async () => [{ name: 'clerkbox-goal-store', persist: store.persist }],
      isConnected: () => connected,
      subscribeConnection: listener => { onConnection = listener; return () => {} },
      onState: () => {},
    })
    try {
      connected = true; onConnection()
      await vi.waitFor(() => expect(store.persist.hasHydrated()).toBe(true))
      expect(store.getState()).toMatchObject({ bySession: { hostSession: { condition: 'Preserve host goal' } }, transient: true })
      expect(h.kvPatch).not.toHaveBeenCalled()
    } finally { recovery.stop() }
  })
  it('hydrates model configuration from the host and ignores obsolete browser-only settings', async () => {
    h.host.set('clerkbox-settings', saved({ model: 'host-model', theme: 'dark', providers: [{ id: 'host', apiKey: '' }] }))
    local.set('clerkbox:remote-state:room-a:device-a:clerkbox-settings', saved({ model: 'obsolete', theme: 'light' }))
    const result = await sharedStorage!.getItem('clerkbox-settings')
    expect(result?.state).toMatchObject({ model: 'host-model', theme: 'dark', providers: [{ id: 'host', apiKey: '' }] })
    expect(h.kvGet).toHaveBeenCalledWith('clerkbox-settings')
  })
  it('persists changed settings to the host through a field merge without disk-caching configuration', async () => {
    h.host.set('clerkbox-settings', saved({ model: 'before', theme: 'dark' }))
    await sharedStorage!.getItem('clerkbox-settings')
    await sharedStorage!.setItem('clerkbox-settings', { state: { model: 'after', theme: 'dark' }, version: 0 })
    expect(JSON.parse(h.host.get('clerkbox-settings')!).state.model).toBe('after')
    expect(h.kvPatch).toHaveBeenCalledTimes(1)
    expect(h.kvSet).not.toHaveBeenCalled()
    expect(local.size).toBe(0)
  })
  it('preserves an unrelated setting changed by another device before the local edit arrives', async () => {
    h.host.set('clerkbox-settings', saved({ model: 'before', theme: 'dark' }))
    await sharedStorage!.getItem('clerkbox-settings')
    h.host.set('clerkbox-settings', saved({ model: 'before', theme: 'light' }))
    await sharedStorage!.setItem('clerkbox-settings', { state: { model: 'after', theme: 'dark' }, version: 0 })
    expect(JSON.parse(h.host.get('clerkbox-settings')!).state).toEqual({ model: 'after', theme: 'light' })
    const changed = vi.fn(); const off = subscribeSharedState(changed)
    await refreshSharedState(); off()
    expect(changed).toHaveBeenCalledWith('clerkbox-settings')
  })
  it('reports conflicting edits and reloads host state instead of overwriting it', async () => {
    h.host.set('clerkbox-settings', saved({ model: 'before' }))
    await sharedStorage!.getItem('clerkbox-settings')
    h.host.set('clerkbox-settings', saved({ model: 'other-device' }))
    await sharedStorage!.setItem('clerkbox-settings', { state: { model: 'this-device' }, version: 0 })
    await expect(flushSharedStorage()).rejects.toThrow('remote-state-unsaved')
    expect(events).toHaveLength(1)
    expect(JSON.parse(h.host.get('clerkbox-settings')!).state.model).toBe('other-device')
    await refreshSharedState()
    await expect(flushSharedStorage()).resolves.toBeUndefined()
  })
  it('keeps the previous merge base until the changed host state reaches the store', async () => {
    h.host.set('clerkbox-settings', saved({ model: 'before', theme: 'dark' }))
    await sharedStorage!.getItem('clerkbox-settings')
    h.host.set('clerkbox-settings', saved({ model: 'before', theme: 'light' }))
    let resume!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const paused = new Promise<void>(resolve => { resume = resolve })
    const off = subscribeSharedState(async name => {
      if (name !== 'clerkbox-settings') return
      entered()
      await paused
      await sharedStorage!.getItem(name)
    })
    const refresh = refreshSharedState()
    await started
    try {
      await sharedStorage!.setItem('clerkbox-settings', { state: { model: 'after', theme: 'dark' }, version: 0 })
      expect(JSON.parse(h.host.get('clerkbox-settings')!).state).toEqual({ model: 'after', theme: 'light' })
    } finally { resume(); await refresh; off() }
  })
  it('waits for an already running refresh and its store hydration', async () => {
    h.host.set('clerkbox-settings', saved({ model: 'before' }))
    await sharedStorage!.getItem('clerkbox-settings')
    h.host.set('clerkbox-settings', saved({ model: 'after' }))
    let resume!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const paused = new Promise<void>(resolve => { resume = resolve })
    const off = subscribeSharedState(async name => {
      if (name !== 'clerkbox-settings') return
      entered(); await paused; await sharedStorage!.getItem(name)
    })
    const first = refreshSharedState()
    await started
    const second = refreshSharedState()
    expect(second).toBe(first)
    let completed = false
    void second.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    resume(); await second; off()
    expect(completed).toBe(true)
  })
  it('keeps unsent drafts isolated by room/device and out of host KV', async () => {
    await sharedStorage!.setItem('drafts', { state: { content: 'local draft' }, version: 0 })
    h.scope = 'room-b:device-b'
    expect(await sharedStorage!.getItem('drafts')).toBeNull()
    h.scope = 'room-a:device-a'
    expect(await sharedStorage!.getItem('drafts')).toEqual({ state: { content: 'local draft' }, version: 0 })
    await sharedStorage!.removeItem('drafts')
    expect(await sharedStorage!.getItem('drafts')).toBeNull()
    expect(h.kvPatch).not.toHaveBeenCalled()
  })
})
