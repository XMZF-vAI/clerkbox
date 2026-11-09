import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactElement } from 'react'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { PendingQuestion } from '../src/stores/interactive-store'

const read = (name: string) => readFileSync(new URL(`../src/components/chat/${name}.tsx`, import.meta.url), 'utf8')
const permissionSource = read('PermissionCard')
const questionSource = read('QuestionCard')
type Element = ReactElement<Record<string, any>>

// Node-only handler tests: execute the actual component function with persistent hook slots.
// This is not a DOM renderer; native focus/click delivery is simulated explicitly below.
// Extracting the function avoids importing the Electron/store dependency graph or exporting test-only APIs.
function renderer(source: string, name: string, dependencies: Record<string, unknown> = {}) {
  const file = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)!
  const code = ts.transpileModule(declaration.getText(file).replace(/^export (?:default )?/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText
  const slots: any[] = []
  let cursor = 0
  const useState = (initial: any) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
  }
  const scope = {
    React: { createElement },
    useState,
    useRef: (initial: any) => useState({ current: initial })[0],
    useMemo: (factory: () => unknown) => factory(),
    useTranslation: () => ({ t: (key: string) => key }),
    ...dependencies,
  }
  const component = new Function(...Object.keys(scope), `${code}\nreturn ${name}`)(...Object.values(scope))
  return (props: Record<string, unknown>): Element | null => {
    cursor = 0
    return component(props)
  }
}

function nodes(root: unknown, type: string): Element[] {
  if (Array.isArray(root)) return root.flatMap((child) => nodes(child, type))
  if (!isValidElement<Record<string, any>>(root)) return []
  return [...(root.type === type ? [root] : []), ...nodes(root.props.children, type)]
}

function approval(count = 5) {
  const decisions = ['allow_once', 'allow_session', 'allow_project', 'deny_always', 'deny'].slice(0, count)
  const resolve = vi.fn()
  const render = renderer(permissionSource, 'ApprovalOptionList')
  const props = {
    vibe: false,
    onResolve: (decision: string) => () => resolve(decision),
    options: decisions.map((decision) => ({ decision, label: decision, Icon: 'icon' })),
  }
  let tree: Element
  let buttons: Element[]
  let focused = -1
  const focus = (index: number) => {
    focused = index
    buttons[index].props.onFocus?.()
  }
  const refresh = () => {
    tree = render(props)!
    buttons = nodes(tree, 'button')
    buttons.forEach((button, index) => button.props.ref?.({ focus: () => focus(index) }))
  }
  refresh()
  return {
    resolve,
    get tree() { return tree },
    get buttons() { return buttons },
    get focused() { return focused },
    focus(index: number) { focus(index); refresh() },
    click(index: number) {
      buttons[index].props.onPointerDown?.()
      focus(index)
      refresh() // React can flush the focus update before click.
      buttons[index].props.onClick({ detail: 1 })
      refresh()
    },
    key(index: number, key: string) {
      const preventDefault = vi.fn()
      buttons[index].props.onKeyDown?.({ key, preventDefault })
      if ((key === 'Enter' || key === ' ') && !preventDefault.mock.calls.length) {
        buttons[index].props.onClick({ detail: 0 }) // Native keyboard/assistive click.
      }
      refresh()
      return preventDefault
    },
  }
}

describe('UI-06 permission option interactions', () => {
  it.each(['Enter', ' '])('submits focused deny with %j, never the initial allow_once', (key) => {
    const view = approval()
    view.focus(4) // Tab can reach any native button.
    expect(view.buttons[4].props['aria-pressed']).toBe(true)
    expect(view.buttons[0].props['aria-pressed']).toBe(false)
    view.key(4, key)
    expect(view.resolve.mock.calls).toEqual([['deny']])
  })

  it('keeps native Tab order and visible focus rings without listbox/option roles', () => {
    const view = approval()
    expect(view.tree.props.role).toBe('group')
    expect(view.tree.props.onKeyDown).toBeUndefined()
    for (const button of view.buttons) {
      expect(button.props.type).toBe('button')
      expect(button.props.role).toBeUndefined()
      expect(button.props.tabIndex).toBeUndefined()
      expect(button.props.className).toContain('focus-visible:ring-2')
      expect(button.props.className).toContain('focus-visible:ring-current')
    }
    expect(view.key(0, 'Tab')).not.toHaveBeenCalled()
  })

  it('moves real focus and selection with wrapping arrows, then confirms that target', () => {
    const view = approval()
    view.focus(0)
    expect(view.key(0, 'ArrowUp')).toHaveBeenCalledOnce()
    expect(view.focused).toBe(4)
    expect(view.buttons[4].props['aria-pressed']).toBe(true)
    view.key(4, 'ArrowDown')
    expect(view.focused).toBe(0)
    view.key(0, 'ArrowDown')
    expect(view.focused).toBe(1)
    expect(view.buttons[1].props['aria-pressed']).toBe(true)
    expect(view.resolve).not.toHaveBeenCalled()
    view.key(1, 'Enter')
    expect(view.resolve.mock.calls).toEqual([['allow_session']])
  })

  it('requires two pointer clicks on an unselected option despite the intervening focus update', () => {
    const view = approval()
    view.click(2)
    expect(view.buttons[2].props['aria-pressed']).toBe(true)
    expect(view.resolve).not.toHaveBeenCalled()
    view.click(2)
    expect(view.resolve.mock.calls).toEqual([['allow_project']])
  })

  it.each([1, 2, 3, 4, 5])('digit %i directly submits the corresponding visible option', (digit) => {
    const view = approval()
    view.focus(0)
    expect(view.key(0, String(digit))).toHaveBeenCalledOnce()
    expect(view.focused).toBe(digit - 1)
    expect(view.resolve.mock.calls).toEqual([[view.buttons[digit - 1].key]])
  })

  it('ignores out-of-range digits for trimmed lists', () => {
    const view = approval(2)
    for (const key of ['0', '3', '4', '5', '9']) expect(view.key(0, key)).not.toHaveBeenCalled()
    expect(view.resolve).not.toHaveBeenCalled()
  })

  it('keys both ordinary and workflow lists by request ID so neither inherits selection', () => {
    const mounts = permissionSource.match(/<ApprovalOptionList\s+key=\{request\.id\}/g)
    expect(mounts).toHaveLength(2)
    const old = approval()
    old.click(4)
    const next = approval()
    expect(next.buttons[0].props['aria-pressed']).toBe(true)
    expect(next.buttons[4].props['aria-pressed']).toBe(false)
  })
})

function pending(id = 'request-1', labels = ['A', 'B']): PendingQuestion {
  return { id, sessionId: 'session-1', questions: [{ id: 'q1', header: 'First', question: 'Choose', options: labels.map((label) => ({ label, description: '' })) }] }
}

function questionView() {
  const resolveQuestion = vi.fn()
  const state = { pendingQuestions: {} as Record<string, PendingQuestion | undefined>, resolveQuestion }
  const outer = renderer(questionSource, 'QuestionCard', {
    useInteractiveStore: (selector: (value: typeof state) => unknown) => selector(state),
    QuestionForm: 'question-form',
  })
  let mounted: { key: string | null; render: ReturnType<typeof renderer> } | undefined
  let sessionId = 'session-1'
  let tree: Element | null = null
  const refresh = () => {
    const form = outer({ sessionId })
    if (!form) { mounted = undefined; tree = null; return }
    if (!mounted || mounted.key !== form.key) {
      mounted = { key: form.key, render: renderer(questionSource, 'QuestionForm', { CircleHelp: 'icon', Check: 'icon', ChevronDown: 'icon' }) }
    }
    tree = mounted.render(form.props)
  }
  const button = (label: string) => nodes(tree, 'button').find((node) => node.props.children === label)!
  return {
    resolveQuestion,
    get tree() { return tree },
    button,
    refresh,
    show(request: PendingQuestion | undefined, session = sessionId) {
      sessionId = session
      state.pendingQuestions[sessionId] = request
      refresh()
    },
    choose(index: number) { nodes(tree, 'button')[index + 1].props.onClick(); refresh() },
    toggle() { nodes(tree, 'button')[0].props.onClick(); refresh() },
    type(value: string) { nodes(tree, 'input')[0].props.onChange({ target: { value } }); refresh() },
  }
}

describe('UI-09 question form isolation and validation', () => {
  it('resets answers, Other text and collapsed state for a new request reusing q1', () => {
    const view = questionView()
    view.show(pending())
    view.choose(2)
    view.type('previous answer')
    view.toggle()
    view.show(pending('request-2'))
    expect(nodes(view.tree, 'button')[0].props['aria-expanded']).toBe(true)
    expect(view.button('question.submit').props.disabled).toBe(true)
    view.button('question.submit').props.onClick()
    expect(view.resolveQuestion).not.toHaveBeenCalled()
    view.choose(2)
    expect(nodes(view.tree, 'input')[0].props.value).toBe('')
  })

  it('does not reuse a selected option for another request, even when the labels match', () => {
    const view = questionView()
    view.show(pending())
    view.choose(0)
    view.show(pending('request-2'))
    expect(view.button('question.submit').props.disabled).toBe(true)
    view.button('question.submit').props.onClick()
    expect(view.resolveQuestion).not.toHaveBeenCalled()
    view.choose(1)
    view.button('question.submit').props.onClick()
    expect(view.resolveQuestion.mock.calls).toEqual([['session-1', 'request-2', { q1: ['B'] }]])
  })

  it('isolates sessions even if their pending IDs match, and unmounts when no request remains', () => {
    const view = questionView()
    view.show(pending())
    view.choose(0)
    view.show({ ...pending(), sessionId: 'session-2' }, 'session-2')
    expect(view.button('question.submit').props.disabled).toBe(true)
    view.choose(1)
    view.show(undefined)
    expect(view.tree).toBeNull()
    view.show({ ...pending(), sessionId: 'session-2' })
    expect(view.button('question.submit').props.disabled).toBe(true)
  })

  it('preserves answers and Other text through same-request updates and collapse/reopen', () => {
    const view = questionView()
    view.show(pending())
    view.choose(2)
    view.type('  custom answer  ')
    view.toggle()
    view.show(pending()) // Same identity with a fresh store object.
    expect(nodes(view.tree, 'button')[0].props['aria-expanded']).toBe(false)
    view.toggle()
    expect(nodes(view.tree, 'input')[0].props.value).toBe('  custom answer  ')
    expect(view.button('question.submit').props.disabled).toBe(false)
    view.button('question.submit').props.onClick()
    expect(view.resolveQuestion.mock.calls).toEqual([['session-1', 'request-1', { q1: ['custom answer'] }]])
  })

  it('validates in submit itself, rejects removed options and whitespace-only Other', () => {
    const view = questionView()
    view.show(pending())
    view.button('question.submit').props.onClick()
    view.choose(0)
    view.show(pending('request-1', ['C', 'D']))
    expect(view.button('question.submit').props.disabled).toBe(true)
    view.button('question.submit').props.onClick()
    view.choose(2)
    view.type(' \n\t ')
    view.button('question.submit').props.onClick()
    expect(view.resolveQuestion).not.toHaveBeenCalled()
  })

  it('requires all current questions and does not submit unselected Other text', () => {
    const view = questionView()
    const request = pending()
    request.questions.push({ id: 'q2', header: 'Second', question: 'Second', options: [{ label: 'C', description: '' }] })
    view.show(request)
    view.choose(2)
    view.type('unused')
    view.choose(1)
    expect(view.button('question.submit').props.disabled).toBe(true)
    view.button('question.submit').props.onClick()
    expect(view.resolveQuestion).not.toHaveBeenCalled()
    view.choose(3)
    view.button('question.submit').props.onClick()
    expect(view.resolveQuestion.mock.calls).toEqual([['session-1', 'request-1', { q1: ['B'], q2: ['C'] }]])
  })

  it('treats an option labelled __other__ as an option, not the free-text choice', () => {
    const view = questionView()
    view.show(pending('request-1', ['__other__']))
    view.choose(0)
    expect(nodes(view.tree, 'input')).toHaveLength(0)
    view.button('question.submit').props.onClick()
    expect(view.resolveQuestion.mock.calls).toEqual([['session-1', 'request-1', { q1: ['__other__'] }]])
  })

  it('keeps explicit Ignore available without answering', () => {
    const view = questionView()
    view.show(pending())
    view.button('question.ignore').props.onClick()
    expect(view.resolveQuestion.mock.calls).toEqual([['session-1', 'request-1', {}]])
  })
})
