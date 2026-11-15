import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ panel: null as unknown, cleanups: [] as Array<() => void> }))
vi.mock('react', () => ({
  useRef: (initial: unknown) => ({ current: initial === null ? harness.panel : initial }),
  useLayoutEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect()
    if (cleanup) harness.cleanups.push(cleanup)
  },
}))

import { useModalAccessibility } from '../src/hooks/use-modal-accessibility'

class FocusTarget {
  tabIndex = 0
  isConnected = true
  controls: FocusTarget[] = []
  matches() { return false }
  closest() { return null }
  getClientRects() { return [{}] }
  querySelectorAll() { return this.controls }
  contains(target: FocusTarget) { return target === this || this.controls.includes(target) }
  focus() { documentState.activeElement = this }
}

let listener: ((event: KeyboardEvent) => void) | undefined
const documentState = {
  activeElement: null as FocusTarget | null,
  addEventListener: (_: string, callback: (event: KeyboardEvent) => void) => { listener = callback },
  removeEventListener: () => { listener = undefined },
}

function key(key: string, options: { isComposing?: boolean; keyCode?: number; shiftKey?: boolean } = {}) {
  const event = { key, defaultPrevented: false, isComposing: false, keyCode: 0, shiftKey: false,
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...options }
  listener?.(event as unknown as KeyboardEvent)
  return event
}

beforeEach(() => {
  vi.stubGlobal('document', documentState)
  vi.stubGlobal('HTMLElement', FocusTarget)
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }))
  vi.stubGlobal('queueMicrotask', (callback: () => void) => callback())
  harness.panel = new FocusTarget()
  documentState.activeElement = null
})

afterEach(() => {
  harness.cleanups.splice(0).reverse().forEach((cleanup) => cleanup())
  vi.unstubAllGlobals()
})

describe('shared overlay keyboard ownership', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves an IME cancellation to the input method: %j', (ime) => {
    const close = vi.fn()
    useModalAccessibility(close)
    const event = key('Escape', ime)
    expect(close).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    key('Escape')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('lets only the top dialog handle Escape and restores the underlying owner', () => {
    const first = vi.fn()
    const second = vi.fn()
    useModalAccessibility(first)
    harness.panel = new FocusTarget()
    useModalAccessibility(second)
    key('Escape')
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    harness.cleanups.pop()?.()
    key('Escape')
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('cycles Tab within the active dialog while ignoring IME key events', () => {
    const panel = harness.panel as FocusTarget
    const first = new FocusTarget()
    const last = new FocusTarget()
    panel.controls = [first, last]
    useModalAccessibility(vi.fn())
    last.focus()
    key('Tab', { isComposing: true })
    expect(documentState.activeElement).toBe(last)
    key('Tab')
    expect(documentState.activeElement).toBe(first)
    key('Tab', { shiftKey: true })
    expect(documentState.activeElement).toBe(last)
  })
})
