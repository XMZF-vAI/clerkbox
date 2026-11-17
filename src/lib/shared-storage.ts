import { createJSONStorage, type StateStorage } from 'zustand/middleware'
import { ipc, isWebUIMode } from './ipc-client'
import { getRemoteStorageScope, isCloudRemoteMode } from '../remote/browser'

export const SHARED_STATE_KEYS = new Set([
  'clerkbox-settings', 'clerkbox-skills', 'clerkbox-vibe', 'clerkbox-scheduled-tasks',
  'clerkbox-token-usage', 'clerkbox-account', 'clerkbox-joule',
  'clerkbox-goal-store', 'clerkbox-todo-store',
])
const snapshots = new Map<string, string | null>()
const queues = new Map<string, Promise<void>>()
const dirty = new Set<string>()
const failures = new Map<string, unknown>()
const listeners = new Set<(name: string) => void | Promise<void>>()
let refreshInFlight: Promise<void> | undefined

function localKey(name: string): string {
  return isCloudRemoteMode() ? `clerkbox:remote-state:${getRemoteStorageScope()}:${name}` : name
}
function cache(name: string, value: string | null): void {
  // Credentials/configuration never belong in the browser's disk cache.
  if (isCloudRemoteMode() && SHARED_STATE_KEYS.has(name)) return
  try {
    if (value === null) window.localStorage.removeItem(localKey(name))
    else window.localStorage.setItem(localKey(name), value)
  } catch { /* KV remains authoritative. */ }
}
function emitError(name: string, error: unknown): void {
  console.error(`[shared-storage] ${name} was not saved:`, error)
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('clerkbox-shared-state-error', { detail: { name, conflict: error instanceof Error && error.message.includes('state-conflict') } }))
  }
}
async function readHost(name: string): Promise<string | null> { return ipc.kvGet(name) }
function persist(name: string, value: string | null): Promise<void> {
  const base = snapshots.get(name) ?? null
  snapshots.set(name, value)
  const previous = queues.get(name) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    try {
      if (base === value) return
      const result = await ipc.kvPatch({ name, base, value })
      failures.delete(name)
      cache(name, result.value)
      if (result.value !== value) dirty.add(name)
    } catch (error) {
      failures.set(name, error)
      dirty.add(name)
      emitError(name, error)
    }
  })
  queues.set(name, operation)
  void operation.then(() => { if (queues.get(name) === operation) queues.delete(name) })
  return operation
}

/** Flush edits before sending a run or another action that depends on new settings. */
export async function flushSharedStorage(): Promise<void> {
  while (queues.size) await Promise.all([...queues.values()])
  if (failures.size) throw new Error('remote-state-unsaved')
}
export function subscribeSharedState(listener: (name: string) => void | Promise<void>): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Compare host snapshots and hydrate changed stores without rewriting their saved state. */
export function refreshSharedState(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  const operation = (async () => {
    for (const name of [...snapshots.keys()]) {
      if (!SHARED_STATE_KEYS.has(name) || queues.has(name)) continue
      const previous = snapshots.get(name)
      const value = await readHost(name)
      if (queues.has(name)) continue
      if (previous !== value || dirty.has(name)) {
        // The store still contains its previous value until rehydrate reads it.
        // Advancing its merge base here would turn a concurrent local edit into
        // an unintended reversal of fields just changed on another device.
        dirty.delete(name)
        failures.delete(name)
        cache(name, value)
        await Promise.all([...listeners].map(listener => listener(name)))
      }
    }
  })()
  refreshInFlight = operation
  void operation.then(
    () => { if (refreshInFlight === operation) refreshInFlight = undefined },
    () => { if (refreshInFlight === operation) refreshInFlight = undefined },
  )
  return operation
}

const kvStateStorage: StateStorage = {
  getItem: async (name) => {
    if (isCloudRemoteMode() && !SHARED_STATE_KEYS.has(name)) {
      try { return window.localStorage.getItem(localKey(name)) } catch { return null }
    }
    let value = await readHost(name)
    if (value === null && !isWebUIMode) {
      try { value = window.localStorage.getItem(name) } catch { /* No migration source. */ }
      if (value !== null) await ipc.kvSet(name, value)
    }
    snapshots.set(name, value)
    return value
  },
  setItem: async (name, value) => {
    if (isCloudRemoteMode() && !SHARED_STATE_KEYS.has(name)) { cache(name, value); return }
    if (!SHARED_STATE_KEYS.has(name)) { await ipc.kvSet(name, value); cache(name, value); return }
    // Transient initialization updates must not replace saved host data with defaults.
    if (!snapshots.has(name)) return
    await persist(name, value)
  },
  removeItem: async (name) => {
    if (isCloudRemoteMode() && !SHARED_STATE_KEYS.has(name)) { cache(name, null); return }
    if (SHARED_STATE_KEYS.has(name)) await persist(name, null)
    else await ipc.kvRemove(name)
    cache(name, null)
  },
}

export const sharedStorage = createJSONStorage(() => kvStateStorage)
