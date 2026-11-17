import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createJSONStorage, persist } from 'zustand/middleware'
import { retryStoreHydration, startWorkbenchHydrationRecovery, type WorkbenchHydrationState, type WorkbenchHydrationStore } from '../src/lib/workbench-hydration'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers() })

function savedStore(name: string, get: () => Promise<string | null>) {
  const storage = { getItem: vi.fn(get), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) }
  const store = createStore(persist(() => ({ value: 'local-default' }), { name, storage: createJSONStorage(() => storage) }))
  return { store, storage, entry: { name, persist: store.persist } satisfies WorkbenchHydrationStore }
}

function connection() {
  let connected = false
  const listeners = new Set<() => void>()
  return {
    isConnected: () => connected,
    subscribeConnection: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(value: boolean) { connected = value; for (const listener of listeners) listener() },
  }
}

describe('workbench startup hydration recovery', () => {
  it('recovers real Zustand stores after their initial reads fail, outside the settings hydration gate', async () => {
    vi.useFakeTimers()
    let available = false
    const entries = ['settings', 'vibe', 'skills', 'tasks', 'account', 'joule', 'goals', 'todos', 'usage'].map(name => savedStore(name, async () => {
      if (!available) throw new Error('remoteAccess.cloudDisconnected')
      return JSON.stringify({ state: { value: `host-${name}` }, version: 0 })
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(entries.every(item => !item.store.persist.hasHydrated())).toBe(true)
    const draft = createStore(() => ({ text: 'Unsent conversation draft' }))
    const transport = connection()
    const states: WorkbenchHydrationState[] = []
    const recovery = startWorkbenchHydrationRecovery({ ...transport, loadStores: async () => entries.map(item => item.entry), onState: state => states.push(state) })
    cleanups.push(recovery.stop)
    expect(states.at(-1)?.ready).toBe(false)
    expect(entries.every(item => item.storage.setItem.mock.calls.length === 0)).toBe(true)

    available = true
    transport.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(entries.every(item => item.store.persist.hasHydrated())).toBe(true)
    expect(entries.map(item => item.store.getState().value)).toEqual(['host-settings', 'host-vibe', 'host-skills', 'host-tasks', 'host-account', 'host-joule', 'host-goals', 'host-todos', 'host-usage'])
    expect(states.at(-1)).toMatchObject({ ready: true, loading: false, failed: [], pending: [] })
    expect(entries.every(item => item.storage.setItem.mock.calls.length === 0)).toBe(true)
    expect(draft.getState().text).toBe('Unsent conversation draft')
  })

  it('deduplicates retries across repeated connection events and StrictMode lifecycles', async () => {
    vi.useFakeTimers()
    let resolveRead!: (value: string) => void
    let initial = true
    const item = savedStore('strict', async () => {
      if (initial) throw new Error('disconnected')
      return new Promise<string>(resolve => { resolveRead = resolve })
    })
    await vi.advanceTimersByTimeAsync(0)
    initial = false
    const transport = connection()
    transport.set(true)
    const options = { ...transport, loadStores: async () => [item.entry], onState: vi.fn() }
    const first = startWorkbenchHydrationRecovery(options)
    await vi.advanceTimersByTimeAsync(0)
    first.stop()
    const second = startWorkbenchHydrationRecovery(options)
    cleanups.push(second.stop)
    transport.set(true); transport.set(true); second.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(item.storage.getItem).toHaveBeenCalledTimes(2) // Failed auto-read, one shared retry.
    resolveRead(JSON.stringify({ state: { value: 'host' }, version: 0 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(options.onState).toHaveBeenLastCalledWith({ ready: true, loading: false, pending: [], failed: [] })
    expect(item.store.getState().value).toBe('host')
  })

  it('backs off swallowed persist read failures and retries all unfinished stores on reconnect', async () => {
    vi.useFakeTimers()
    let available = false
    const item = savedStore('backoff', async () => {
      if (!available) throw new Error('temporarily unavailable')
      return JSON.stringify({ state: { value: 'recovered' }, version: 0 })
    })
    await vi.advanceTimersByTimeAsync(0)
    const transport = connection(); transport.set(true)
    const states: WorkbenchHydrationState[] = []
    const recovery = startWorkbenchHydrationRecovery({ ...transport, loadStores: async () => [item.entry], onState: state => states.push(state), retryBaseMs: 1000, retryMaxMs: 3000 })
    cleanups.push(recovery.stop)
    await vi.advanceTimersByTimeAsync(0)
    expect(item.storage.getItem).toHaveBeenCalledTimes(2)
    expect(states.at(-1)).toMatchObject({ ready: false, loading: false, failed: ['backoff'] })
    await vi.advanceTimersByTimeAsync(999)
    expect(item.storage.getItem).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(item.storage.getItem).toHaveBeenCalledTimes(3)
    transport.set(false)
    await vi.advanceTimersByTimeAsync(30000)
    expect(item.storage.getItem).toHaveBeenCalledTimes(3)
    available = true; transport.set(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(item.store.getState().value).toBe('recovered')
    expect(states.at(-1)?.ready).toBe(true)
  })

  it('recognizes auto-hydration that completed before listeners and leaves ready stores untouched', async () => {
    const item = savedStore('already-ready', async () => JSON.stringify({ state: { value: 'host' }, version: 0 }))
    await vi.waitFor(() => expect(item.store.persist.hasHydrated()).toBe(true))
    expect(await retryStoreHydration(item.entry)).toBe(true)
    const states: WorkbenchHydrationState[] = []
    const recovery = startWorkbenchHydrationRecovery({ isConnected: () => true, subscribeConnection: () => () => {}, loadStores: async () => [item.entry], onState: state => states.push(state) })
    cleanups.push(recovery.stop)
    await vi.waitFor(() => expect(states.at(-1)?.ready).toBe(true))
    expect(item.storage.getItem).toHaveBeenCalledTimes(1)
    expect(item.storage.setItem).not.toHaveBeenCalled()
  })

  it('backs off a failed store module load and can retry it without recreating the workbench', async () => {
    vi.useFakeTimers()
    const item = savedStore('late-import', async () => null)
    const loadStores = vi.fn().mockRejectedValueOnce(new Error('module unavailable')).mockResolvedValue([item.entry])
    const states: WorkbenchHydrationState[] = []
    const recovery = startWorkbenchHydrationRecovery({ isConnected: () => true, subscribeConnection: () => () => {}, loadStores, onState: state => states.push(state) })
    cleanups.push(recovery.stop)
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)?.failed).toEqual(['workbench'])
    expect(loadStores).toHaveBeenCalledTimes(1)
    recovery.retry()
    await vi.advanceTimersByTimeAsync(0)
    expect(loadStores).toHaveBeenCalledTimes(2)
    expect(states.at(-1)?.ready).toBe(true)
  })
})
