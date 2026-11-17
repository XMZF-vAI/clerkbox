import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({
  cloud: true,
  scope: 'room-a:device-a',
  kvGet: vi.fn(async (_name: string): Promise<string | null> => null),
  kvSet: vi.fn(async (_name: string, _value: string) => {}),
  kvRemove: vi.fn(async (_name: string) => {}),
}))
vi.mock('../src/lib/ipc-client', () => ({ isWebUIMode: true, ipc: { kvGet: h.kvGet, kvSet: h.kvSet, kvRemove: h.kvRemove } }))
vi.mock('../src/remote/browser', () => ({
  isCloudRemoteMode: () => h.cloud,
  getRemoteStorageScope: () => h.scope,
  getRemoteBootstrap: () => ({ settings: { model: 'trusted-desktop-model', apiKey: '', providers: [{ id: 'trusted', apiKey: '' }], theme: 'dark' } }),
}))
import { sharedStorage } from '../src/lib/shared-storage'
let local: Map<string, string>
beforeEach(() => {
  vi.clearAllMocks()
  h.cloud = true
  h.scope = 'room-a:device-a'
  local = new Map()
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) } })
})
afterEach(() => vi.unstubAllGlobals())
describe('remote browser persistence boundary', () => {
  it('uses trusted bootstrap for models and only local visual preferences for overrides', async () => {
    local.set('clerkbox:remote-state:room-a:device-a:clerkbox-settings', JSON.stringify({ state: { theme: 'light', model: 'injected-model', apiKey: 'injected-secret', providers: [{ id: 'injected' }], permissionRules: [{ effect: 'allow' }] } }))
    const saved = await sharedStorage!.getItem('clerkbox-settings')
    expect(saved?.state).toMatchObject({ model: 'trusted-desktop-model', theme: 'light', apiKey: '', providers: [{ id: 'trusted', apiKey: '' }], hasCompletedOnboarding: true })
    expect((saved?.state as Record<string, unknown>).permissionRules).toBeUndefined()
    expect(h.kvGet).not.toHaveBeenCalled()
  })
  it('never writes model or permission data to desktop KV or browser settings storage', async () => {
    await sharedStorage!.setItem('clerkbox-settings', { state: { theme: 'light', language: 'en', apiKey: 'secret', providers: [{ apiKey: 'secret' }], model: 'browser-selected', permissionRules: [{ effect: 'allow' }] }, version: 0 })
    expect(JSON.parse(local.get('clerkbox:remote-state:room-a:device-a:clerkbox-settings')!)).toEqual({ state: { theme: 'light', language: 'en' }, version: 0 })
    expect(h.kvSet).not.toHaveBeenCalled()
  })
  it('isolates drafts by room/device and deletes them only in the current browser', async () => {
    await sharedStorage!.setItem('drafts', { state: { content: 'local draft' }, version: 0 })
    h.scope = 'room-b:device-b'
    expect(await sharedStorage!.getItem('drafts')).toBeNull()
    h.scope = 'room-a:device-a'
    expect(await sharedStorage!.getItem('drafts')).toEqual({ state: { content: 'local draft' }, version: 0 })
    await sharedStorage!.removeItem('drafts')
    expect(await sharedStorage!.getItem('drafts')).toBeNull()
    expect(h.kvGet).not.toHaveBeenCalled()
    expect(h.kvSet).not.toHaveBeenCalled()
    expect(h.kvRemove).not.toHaveBeenCalled()
  })
  it('preserves the existing LAN and desktop KV path outside cloud remote mode', async () => {
    h.cloud = false
    h.kvGet.mockResolvedValueOnce(JSON.stringify({ state: { theme: 'dark' }, version: 0 }))
    expect(await sharedStorage!.getItem('clerkbox-settings')).toEqual({ state: { theme: 'dark' }, version: 0 })
    expect(h.kvGet).toHaveBeenCalledWith('clerkbox-settings')
  })
})
