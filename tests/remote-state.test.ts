import { describe, expect, it } from 'vitest'
import { mergeRemoteState, projectRemoteState } from '../electron/remote-state'
const encoded = (state: Record<string, unknown>) => JSON.stringify({ state, version: 0 })
const decoded = (value: string | null) => value ? JSON.parse(value).state : null

describe('shared workbench state conflict protection', () => {
  it('merges concurrent edits to separate fields without overwriting another device', () => {
    const base = encoded({ theme: 'dark', language: 'zh-CN', uiScale: 1 })
    const host = encoded({ theme: 'dark', language: 'en', uiScale: 1 })
    const browser = encoded({ theme: 'light', language: 'zh-CN', uiScale: 1 })
    expect(decoded(mergeRemoteState('clerkbox-settings', host, base, browser))).toEqual({ theme: 'light', language: 'en', uiScale: 1 })
  })

  it('rejects conflicting edits to the same setting or task array', () => {
    expect(() => mergeRemoteState('clerkbox-settings', encoded({ uiScale: 1.5 }), encoded({ uiScale: 1 }), encoded({ uiScale: 2 }))).toThrow('remote-state-conflict')
    expect(() => mergeRemoteState('clerkbox-scheduled-tasks', encoded({ tasks: ['desktop'] }), encoded({ tasks: [] }), encoded({ tasks: ['phone'] }))).toThrow('remote-state-conflict')
  })

  it('redacts API and MCP credentials while preserving empty form placeholders on write', () => {
    const host = encoded({ theme: 'dark', apiKey: 'active-secret', providers: [{ id: 'p1', apiKey: 'provider-secret', name: 'Provider' }], mcpServers: [{ id: 'm1', env: { TOKEN: 'env-secret' }, headers: { Authorization: 'header-secret' } }] })
    const projected = projectRemoteState('clerkbox-settings', host)!
    expect(projected).not.toMatch(/active-secret|provider-secret|env-secret|header-secret/)
    const draft = JSON.parse(projected)
    draft.state.theme = 'light'
    draft.state.providers[0].name = 'Renamed'
    const next = decoded(mergeRemoteState('clerkbox-settings', host, projected, JSON.stringify(draft)))
    expect(next).toMatchObject({ theme: 'light', apiKey: 'active-secret', providers: [{ id: 'p1', apiKey: 'provider-secret', name: 'Renamed' }], mcpServers: [{ env: { TOKEN: 'env-secret' }, headers: { Authorization: 'header-secret' } }] })
    expect(next.providers[0]).not.toHaveProperty('apiKeyConfigured')
  })

  it('does not wipe settings absent from an older client and treats deletion as a conflict when host changed', () => {
    expect(decoded(mergeRemoteState('clerkbox-settings', encoded({ theme: 'dark', newOption: true }), encoded({ theme: 'dark' }), encoded({ theme: 'light' })))).toEqual({ theme: 'light', newOption: true })
    expect(() => mergeRemoteState('clerkbox-settings', encoded({ theme: 'light' }), encoded({ theme: 'dark' }), null)).toThrow('remote-state-conflict')
  })

  it('rejects arbitrary KV names and prototype keys', () => {
    expect(() => projectRemoteState('internal-credentials', encoded({}))).toThrow('remote-forbidden-state')
    expect(() => mergeRemoteState('clerkbox-settings', null, null, '{"state":{"__proto__":{"polluted":true}}}')).toThrow('remote-invalid-state')
  })
})
