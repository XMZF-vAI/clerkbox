import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  webUI: false,
  account: {} as Record<string, any>,
  settings: {} as Record<string, any>,
  chat: {} as Record<string, any>,
  slots: {} as Record<string, any[]>,
  scope: 'guidance',
  cursor: 0,
  login: vi.fn(), cancelLogin: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
  updateSettings: vi.fn(), activateModel: vi.fn(), openExternal: vi.fn(), openDashboard: vi.fn(),
}))

// Exercise the real component handlers with persistent hook slots, without DOM/Electron.
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: vi.fn(),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const slots = h.slots[h.scope] ??= []
    const index = h.cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
  },
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/stores/joule-store', () => ({
  useJouleStore: Object.assign((select: (state: any) => unknown) => select(h.account), { getState: () => h.account }),
}))
vi.mock('../src/stores/settings-store', () => ({
  useSettingsStore: Object.assign((select: (state: any) => unknown) => select(h.settings), { getState: () => h.settings }),
}))
vi.mock('../src/stores/chat-store', () => ({
  useChatStore: Object.assign((select: (state: any) => unknown) => select(h.chat), { getState: () => h.chat }),
  getSessionAbortController: () => undefined,
}))
vi.mock('../src/stores/skills-store', () => ({ useSkillsStore: (select: (state: any) => unknown) => select({}) }))
vi.mock('../src/stores/ui-store', () => ({ useUIStore: { getState: () => ({}) } }))
vi.mock('../src/hooks/use-agent', () => ({ useAgent: () => ({ isCompacting: false, isStopping: false }) }))
vi.mock('../src/lib/ipc-client', () => ({
  get isWebUIMode() { return h.webUI },
  ipc: { openExternal: h.openExternal, jouleOpenDashboard: h.openDashboard },
}))
vi.mock('../src/components/ui/Modal', () => ({ default: () => null }))
vi.mock('../src/components/chat/MessageList', () => ({ default: () => null }))
vi.mock('../src/components/chat/ChatInput', () => ({ default: () => null }))
vi.mock('../src/components/chat/ThemeWaves', () => ({ default: () => null }))
vi.mock('../src/components/chat/QuestionCard', () => ({ default: () => null }))
vi.mock('../src/components/chat/TodoListCard', () => ({ default: () => null }))
vi.mock('../src/components/chat/GoalBanner', () => ({ default: () => null }))
vi.mock('../src/components/chat/ChatErrorBanner', () => ({ default: () => null }))
vi.mock('../src/components/chat/RewindDialog', () => ({ default: () => null }))
vi.mock('../src/components/chat/PermissionCard', () => ({ PermissionApprovalCard: () => null }))

import ModelSetupGuidance, { resolveJouleSetupState } from '../src/components/chat/ModelSetupGuidance'
import JouleAccountCard from '../src/components/settings/JouleAccountCard'
import ChatPage from '../src/components/chat/ChatPage'
import Modal from '../src/components/ui/Modal'
import en from '../src/i18n/locales/en'
import zh from '../src/i18n/locales/zh-CN'

type Element = ReactElement<Record<string, any>>
function nodes(root: ReactNode): Element[] {
  if (Array.isArray(root)) return root.flatMap(nodes)
  if (!isValidElement<Record<string, any>>(root)) return []
  return [root, ...nodes(root.props.children)]
}
function textOf(root: ReactNode): string {
  if (typeof root === 'string') return root
  if (Array.isArray(root)) return root.map(textOf).join(' ')
  return isValidElement<{ children?: ReactNode }>(root) ? textOf(root.props.children) : ''
}
function render(scope: string, component: () => ReactNode): Element[] {
  h.scope = scope
  h.cursor = 0
  return nodes(component())
}
const guidance = () => render('guidance', ModelSetupGuidance)
const card = () => render('card', JouleAccountCard)
function button(elements: Element[], label: string): Element {
  const result = elements.find((element) => element.type === 'button' && textOf(element).trim().replace(/\s+/g, ' ') === label)
  expect(result, `button ${label}`).toBeDefined()
  return result!
}
const plan = { tier: 'pro', label: 'Pro', monthly: 10, w5h: 2, week: 10, conc: 1, concFree: 1, freeDaily: 0 }
const subscription = () => ({ tier: 'pro', label: 'Pro', expiresAt: Date.now() + 60_000 })
function connect() {
  Object.assign(h.account, { status: 'connected', plan, subscription: subscription() })
  h.settings.providers = [{ id: 'joule', models: [{ id: 'first', label: 'First model' }, { id: 'second', label: 'Second model' }] }]
}

beforeEach(() => {
  vi.clearAllMocks()
  h.webUI = false
  h.slots = {}
  h.cursor = 0
  h.account = {
    status: 'unlinked', loggingIn: false, userCode: null, verificationUri: null, loginExpiresAt: null,
    plan: null, subscription: null, stale: false, error: null,
    user: null, expired: null, promo: null, quotas: null, lastSyncAt: null,
    login: h.login, cancelLogin: h.cancelLogin, refresh: h.refresh, logout: h.logout,
  }
  h.settings = { baseUrl: '', model: '', providers: [], interfaceMode: 'coding', updateSettings: h.updateSettings, activateModel: h.activateModel }
  h.chat = { sessions: [{ id: 'chat', messages: [] }], activeSessionId: 'chat', streamingSessionIds: new Set(), initialized: true }
  h.refresh.mockResolvedValue(undefined)
})

describe('Joule-first empty-chat guidance', () => {
  it.each([false, true])('appears without a model in standard/VIBE layout (%s)', (vibe) => {
    expect(render('chat', () => ChatPage({ vibe })).some((node) => node.type === ModelSetupGuidance)).toBe(true)
  })

  it.each([false, true])('leaves configured-model and message layouts unchanged (%s)', (vibe) => {
    h.settings.baseUrl = 'https://custom.example/v1'
    h.settings.model = 'custom'
    expect(render('chat', () => ChatPage({ vibe })).some((node) => node.type === ModelSetupGuidance)).toBe(false)
    h.settings.model = ''
    h.chat.sessions[0].messages = [{ id: 'user', role: 'user', content: 'Hello' }]
    expect(render('chat', () => ChatPage({ vibe })).some((node) => node.type === ModelSetupGuidance)).toBe(false)
    expect(h.activateModel).not.toHaveBeenCalled()
  })

  it('opens a Joule-only dialog, then requires an explicit card click to start login', () => {
    const initial = guidance()
    expect(initial.some((node) => node.type === Modal)).toBe(false)
    expect(h.login).not.toHaveBeenCalled()
    button(initial, 'joule.login').props.onClick()
    const opened = guidance()
    expect(opened.find((node) => node.type === Modal)?.props.title).toBe('joule.accountTitle')
    expect(opened.some((node) => node.type === JouleAccountCard)).toBe(true)
    expect(h.updateSettings).not.toHaveBeenCalled() // Does not route through the unrelated account page.
    expect(h.login).not.toHaveBeenCalled()
    button(card(), 'joule.login').props.onClick()
    expect(h.login).toHaveBeenCalledTimes(1)
  })

  it('keeps manual provider configuration as a secondary, direct API-settings path', () => {
    button(guidance(), 'joule.setup.manualAction').props.onClick()
    expect(h.updateSettings).toHaveBeenCalledWith({ showSettings: true, pendingSettingsTab: 'api' })
    expect(h.login).not.toHaveBeenCalled()
    expect(h.activateModel).not.toHaveBeenCalled()
  })

  it.each([
    [{ loggingIn: true }, 'preparing'],
    [{ loggingIn: true, userCode: 'CODE' }, 'authorizing'],
    [{ loggingIn: false, userCode: 'RESTORED' }, 'authorizing'],
    [{ status: 'expired' }, 'expired'],
    [{ status: 'needs_reauth' }, 'reauth'],
    [{ status: 'error' }, 'error'],
    [{ status: 'connected', error: 'Network unavailable', stale: true }, 'error'],
    [{ status: 'connected', stale: true }, 'syncing'],
    [{ status: 'connected' }, 'subscription'],
    [{ status: 'connected', plan, subscription: null }, 'subscription'],
  ])('distinguishes account state %j as %s without side effects', (overrides, expected) => {
    Object.assign(h.account, overrides)
    expect(resolveJouleSetupState(h.account as never, 0, false)).toBe(expected)
    const view = guidance()
    const primary = view.find((node) => node.type === 'button')!
    primary.props.onClick()
    guidance()
    expect(h.login).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
    expect(h.activateModel).not.toHaveBeenCalled()
  })

  it('offers account refresh when subscribed models have not arrived, without signing in again', () => {
    connect()
    h.settings.providers[0].models = []
    expect(resolveJouleSetupState(h.account as never, 0, false)).toBe('models')
    button(guidance(), 'joule.setup.accountAction').props.onClick()
    expect(textOf(guidance().find((node) => node.type === 'p'))).toBe('joule.setup.modelsDescription')
    expect(h.login).not.toHaveBeenCalled()
  })

  it('selects an existing subscribed model only after an explicit choice', () => {
    connect()
    button(guidance(), 'joule.setup.selectAction').props.onClick()
    let view = guidance()
    const select = view.find((node) => node.type === 'select')!
    expect(select.props.value).toBe('first')
    expect(h.activateModel).not.toHaveBeenCalled()
    select.props.onChange({ target: { value: 'second' } })
    view = guidance()
    button(view, 'joule.setup.useModel').props.onClick()
    expect(h.activateModel).toHaveBeenCalledWith('joule', 'second')
    expect(guidance().some((node) => node.type === Modal)).toBe(false)
    expect(h.login).not.toHaveBeenCalled()
  })

  it.each([null, { tier: 'pro', label: 'Pro', expiresAt: 1 }])('keeps the composer subscription gate when metadata is %j', (metadata) => {
    connect()
    h.account.subscription = metadata
    expect(resolveJouleSetupState(h.account as never, 2, false)).toBe(metadata ? 'expired' : 'subscription')
    guidance().find((node) => node.type === 'button')!.props.onClick()
    expect(guidance().some((node) => node.type === 'select')).toBe(false)
    expect(h.activateModel).not.toHaveBeenCalled()
  })

  it.each(['expired', 'removed', 'subscription_expired'])('rechecks access if it is %s while the model picker is open', (change) => {
    connect()
    button(guidance(), 'joule.setup.selectAction').props.onClick()
    const selectModel = button(guidance(), 'joule.setup.useModel').props.onClick
    if (change === 'expired') h.account.status = 'expired'
    else if (change === 'subscription_expired') h.account.subscription.expiresAt = Date.now() - 1
    else h.settings.providers[0].models = []
    selectModel()
    expect(h.activateModel).not.toHaveBeenCalled()
  })

  it.each(['unlinked', 'connected', 'expired', 'needs_reauth', 'error'])('WebUI %s never exposes device authorization or refresh controls', (status) => {
    h.webUI = true
    Object.assign(h.account, { status })
    const view = guidance()
    expect(view.some((node) => node.type === 'h2' && textOf(node) === 'joule.setup.desktopTitle')).toBe(true)
    button(view, 'joule.setup.desktopAction').props.onClick()
    const accountView = card()
    expect(textOf(accountView.find((node) => node.type === 'p'))).toBe('joule.webuiNote')
    for (const label of ['joule.login', 'joule.relogin', 'joule.cancelLogin', 'joule.retry']) {
      expect(accountView.some((node) => node.type === 'button' && textOf(node) === label)).toBe(false)
    }
    expect(accountView.some((node) => node.props['aria-label'] === 'joule.refresh')).toBe(false)
    expect(h.login).not.toHaveBeenCalled()
    expect(h.cancelLogin).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('ignores restored desktop authorization in WebUI instead of exposing cancel or login', () => {
    h.webUI = true
    Object.assign(h.account, { loggingIn: true, userCode: 'DESKTOP-CODE' })
    expect(resolveJouleSetupState(h.account as never, 0, true)).toBe('desktop')
    const view = card()
    expect(view.some((node) => node.type === 'button' && textOf(node).trim() === 'joule.cancelLogin')).toBe(false)
    expect(h.cancelLogin).not.toHaveBeenCalled()
    expect(h.login).not.toHaveBeenCalled()
  })
})

describe('reused Joule account actions', () => {
  it('shows preparation without a fake code or expired countdown before the code arrives', () => {
    h.account.loggingIn = true
    const view = card()
    const text = textOf(view[0])
    expect(text).toContain('joule.setup.preparingDescription')
    expect(text).not.toContain('joule.userCodeLabel')
    expect(text).not.toContain('----')
    expect(text).not.toContain('00:00')
    expect(view.some((node) => node.type === 'button' && textOf(node).trim() === 'joule.login')).toBe(false)
    const cancel = button(view, 'joule.cancelLogin')
    expect(cancel.props.disabled).toBe(true)
    cancel.props.onClick()
    expect(h.cancelLogin).not.toHaveBeenCalled()
  })

  it('shows a restored pending device code without a duplicate login button', () => {
    Object.assign(h.account, { userCode: 'RESTORED', loginExpiresAt: Date.now() + 60_000, verificationUri: 'https://example.test/device' })
    const view = card()
    expect(textOf(view[0])).toContain('RESTORED')
    expect(view.some((node) => node.type === 'button' && textOf(node).trim() === 'joule.login')).toBe(false)
    button(view, 'joule.cancelLogin').props.onClick()
    expect(h.cancelLogin).toHaveBeenCalledTimes(1)
  })

  it('uses subscription access for an expired account and never starts another login', () => {
    h.account.status = 'expired'
    button(card(), 'joule.subscribe').props.onClick()
    expect(h.openExternal).toHaveBeenCalledWith('https://joule.xmzf.space/console#subscribe')
    expect(h.login).not.toHaveBeenCalled()
  })

  it('offers explicit reauthentication only for needs_reauth', () => {
    h.account.status = 'needs_reauth'
    button(card(), 'joule.relogin').props.onClick()
    expect(h.login).toHaveBeenCalledTimes(1)
  })

  it('refreshes account errors instead of starting device authorization', () => {
    Object.assign(h.account, { status: 'error', error: 'Offline' })
    button(card(), 'joule.retry').props.onClick()
    expect(h.refresh).toHaveBeenCalledTimes(1)
    expect(h.login).not.toHaveBeenCalled()
    expect(h.activateModel).not.toHaveBeenCalled()
  })

  it('keeps all new copy available and symmetric in both languages', () => {
    expect(Object.keys(en.joule.setup).sort()).toEqual(Object.keys(zh.joule.setup).sort())
    for (const locale of [en, zh]) for (const value of Object.values(locale.joule.setup)) expect(value.trim()).not.toBe('')
  })
})
