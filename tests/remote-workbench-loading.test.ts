import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createJSONStorage, persist } from 'zustand/middleware'
import { startWorkbenchHydrationRecovery } from '../src/lib/workbench-hydration'

const h = vi.hoisted(() => ({ loader: null as null | (() => Promise<{ default: () => null }>), app: vi.fn(() => null) }))
// Capture the real React.lazy loader without mounting unrelated browser UI.
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  lazy: (loader: typeof h.loader) => { h.loader = loader; return () => null },
}))
vi.mock('../src/App', () => ({ default: h.app }))

import '../src/remote/RemoteEntry'
import { agentClient } from '../src/lib/agent-client'
import * as events from '../src/lib/agent-event-apply'

afterEach(() => { events.detachAgentEvents(); vi.restoreAllMocks(); h.app.mockReset() })

describe('authenticated workbench module startup', () => {
  it('mounts the workbench and recovers failed settings while the first real snapshot is still pending', async () => {
    const order: string[] = []
    let finishSnapshot!: (value: boolean) => void
    let snapshotSettled = false
    const snapshot = new Promise<boolean>(resolve => { finishSnapshot = resolve }).then(value => { snapshotSettled = true; return value })
    vi.spyOn(agentClient, 'subscribe').mockImplementation(() => { order.push('subscribe'); return () => {} })
    vi.spyOn(agentClient, 'start').mockImplementation(() => { order.push('network-start'); return snapshot })

    let hostAvailable = false
    let firstHydrationFinished = false
    const settings = createStore(persist(() => ({ theme: 'default' }), {
      name: 'settings',
      storage: createJSONStorage(() => ({
        getItem: async () => {
          if (!hostAvailable) throw new Error('remoteAccess.cloudDisconnected')
          return JSON.stringify({ state: { theme: 'host-theme' }, version: 0 })
        },
        setItem: async () => {}, removeItem: async () => {},
      })),
      onRehydrateStorage: () => () => { firstHydrationFinished = true },
    }))
    await vi.waitFor(() => expect(firstHydrationFinished).toBe(true))
    expect(settings.persist.hasHydrated()).toBe(false)
    hostAvailable = true
    let recovery: ReturnType<typeof startWorkbenchHydrationRecovery> | undefined
    h.app.mockImplementation(() => {
      recovery = startWorkbenchHydrationRecovery({
        loadStores: async () => [{ name: 'settings', persist: settings.persist }],
        isConnected: () => true, subscribeConnection: () => () => {}, onState: () => {},
      })
      return null
    })
    try {
      let loaded: { default: () => null } | undefined
      const module = h.loader!().then(value => { loaded = value })
      await vi.waitFor(() => expect(loaded).toBeDefined())
      await module
      expect(order).toEqual(['subscribe', 'network-start'])
      loaded!.default()
      await vi.waitFor(() => expect(settings.persist.hasHydrated()).toBe(true))
      expect(settings.getState().theme).toBe('host-theme')
      expect(snapshotSettled).toBe(false)
    } finally { recovery?.stop(); finishSnapshot(true); await snapshot }
  })

  it('contains even an unexpected event-attachment rejection while leaving the app module usable', async () => {
    vi.spyOn(events, 'attachAgentEvents').mockRejectedValueOnce(new Error('unexpected startup failure'))
    const module = await h.loader!()
    expect(module.default).toBe(h.app)
    await Promise.resolve()
    // An unhandled rejection here is also reported as a Vitest run failure.
  })
})
