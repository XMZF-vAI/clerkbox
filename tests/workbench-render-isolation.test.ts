import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import WorkbenchPanel from '../src/components/workbench/WorkbenchPanel'

const runtime = vi.hoisted(() => ({
  sessionId: 'session-a',
  boundSessionId: 'session-a',
  visible: true,
  activeTabId: 'terminal-1',
  tabs: [
    { id: 'files', kind: 'files' },
    { id: 'git', kind: 'git' },
    { id: 'terminal-1', kind: 'terminal' },
    { id: 'browser-1', kind: 'browser' },
    { id: 'agent-browser', kind: 'agent-browser' },
  ],
}))

// Inspect React's actual child identities without mounting desktop-only webviews or xterm.
// Store tests already cover slice contents; this guards the renderer reusing a different slice's instances.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useEffect: vi.fn(),
    useId: () => 'workbench-test',
    useMemo: (factory: () => unknown) => factory(),
    useRef: (current: unknown) => ({ current }),
    useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  }
})

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/lib/ipc-client', () => ({ isWebUIMode: false }))
vi.mock('../src/stores/chat-store', () => ({
  useChatStore: (select: (state: unknown) => unknown) => select({
    activeSessionId: runtime.sessionId,
    sessions: [
      { id: 'session-a', workingDir: 'C:\\projects\\a' },
      { id: 'session-b', workingDir: 'C:\\projects\\b' },
    ],
  }),
}))
vi.mock('../src/stores/settings-store', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select({ interfaceMode: 'coding' }),
}))
vi.mock('../src/stores/workbench-store', () => ({
  useWorkbenchStore: (select: (state: unknown) => unknown) => select({ slices: {}, boundSessionId: runtime.boundSessionId }),
  useWorkbench: () => ({
    visible: runtime.visible,
    width: 460,
    tabs: runtime.tabs,
    activeTabId: runtime.activeTabId,
    setWidth: vi.fn(), openFiles: vi.fn(), openGit: vi.fn(), openTerminal: vi.fn(),
    openBrowser: vi.fn(), activateTab: vi.fn(), closeTab: vi.fn(), toggleVisible: vi.fn(),
  }),
}))

type Element = ReactElement<Record<string, unknown>>
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}

function renderElements(props: { vibe?: boolean; suspended?: boolean } = {}) {
  return elements(WorkbenchPanel(props))
}

function panelKeys(nodes: Element[]) {
  return new Map(nodes.filter((node) => node.props.role === 'tabpanel').map((node) => [node.props.id, node.key]))
}

beforeEach(() => {
  runtime.sessionId = 'session-a'
  runtime.boundSessionId = 'session-a'
  runtime.visible = true
  runtime.activeTabId = 'terminal-1'
})

describe('workbench render ownership', () => {
  it('recreates ordinary panel instances when another session has the same local tab ids', () => {
    const first = renderElements()
    const firstKeys = panelKeys(first)
    const firstTerminal = first.find((node) => typeof node.props.termId === 'string')

    runtime.sessionId = 'session-b'
    runtime.boundSessionId = 'session-b'
    const second = renderElements()
    const secondKeys = panelKeys(second)
    const secondTerminal = second.find((node) => typeof node.props.termId === 'string')

    for (const kind of ['files', 'git', 'terminal-1', 'browser-1']) {
      const id = `workbench-test-panel-${kind}`
      expect(secondKeys.get(id), `${kind} must not inherit another session's component state`).not.toBe(firstKeys.get(id))
    }
    expect(firstTerminal?.props.termId).toBeTruthy()
    expect(secondTerminal?.props.termId).not.toBe(firstTerminal?.props.termId)
    expect(secondKeys.get('workbench-test-panel-agent-browser')).toBe(firstKeys.get('workbench-test-panel-agent-browser'))
  })

  it('keeps the old slice identity until the workbench binding catches up with a session switch', () => {
    const before = panelKeys(renderElements())
    runtime.sessionId = 'session-b'
    expect(panelKeys(renderElements())).toEqual(before)
  })

  it('prevents collapsed keepalive panels from entering keyboard navigation', () => {
    runtime.visible = false
    const nodes = renderElements()
    const aside = nodes.find((node) => node.type === 'aside')
    const terminal = nodes.find((node) => typeof node.props.termId === 'string')
    expect(aside?.props.inert).toBe(true)
    expect(terminal?.props.active).toBe(false)
  })

  it('does not let an inactive Git panel own Escape', () => {
    const nodes = renderElements()
    const gitPanel = nodes.find((node) => typeof node.props.workDir === 'string')
    expect(gitPanel?.props.active).toBe(false)
  })

  it.each([false, true])('suspends a covered workbench without discarding tabs or activating its terminal (vibe=%s)', (vibe) => {
    const before = renderElements({ vibe })
    const beforeTerminal = before.find((node) => typeof node.props.termId === 'string')
    expect(beforeTerminal?.props.active).toBe(true)

    const suspended = renderElements({ vibe, suspended: true })
    const aside = suspended.find((node) => node.type === 'aside')
    const terminal = suspended.find((node) => typeof node.props.termId === 'string')
    const resizer = suspended.find((node) => node.props['data-testid'] === 'workbench-resizer')
    expect(panelKeys(suspended)).toEqual(panelKeys(before))
    expect(terminal?.props.termId).toBe(beforeTerminal?.props.termId)
    expect(terminal?.props.active).toBe(false)
    expect(aside?.props.inert).toBe(true)
    expect(aside?.props['aria-hidden']).toBe(true)
    expect(resizer?.props.tabIndex).toBe(-1)

    const restored = renderElements({ vibe, suspended: false })
    const restoredTerminal = restored.find((node) => typeof node.props.termId === 'string')
    expect(panelKeys(restored)).toEqual(panelKeys(before))
    expect(restoredTerminal?.props.termId).toBe(beforeTerminal?.props.termId)
    expect(restoredTerminal?.props.active).toBe(true)
  })
})
