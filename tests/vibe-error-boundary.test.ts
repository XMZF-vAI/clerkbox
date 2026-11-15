import { Children, createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/shared-storage', () => ({
  sharedStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import VibeModeBoundary, { VibeErrorBoundary, VibeResourceBoundary } from '../src/components/vibe/VibeErrorBoundary'
import { useVibeStore } from '../src/stores/vibe-store'

function exitButton(node: ReactNode): (() => void) | undefined {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return
  if (node.type === 'button') return node.props.onClick
  return Children.toArray(node.props.children).map(exitButton).find(Boolean)
}

describe('VIBE rendering recovery', () => {
  it('keeps the normal VIBE subtree unchanged while it loads successfully', () => {
    const children = createElement('main', null, 'conversation')
    const view = VibeModeBoundary({ children })
    const boundary = new VibeErrorBoundary(view.props)
    expect(boundary.render()).toBe(children)
  })

  it('provides a visible, accessible recovery action after a lazy resource fails', () => {
    const view = VibeModeBoundary({ children: createElement('main', null, 'conversation') })
    const boundary = new VibeErrorBoundary(view.props)
    boundary.state = VibeErrorBoundary.getDerivedStateFromError()
    const html = renderToStaticMarkup(boundary.render())
    expect(html).toContain('role="alert"')
    expect(html).toContain('vibe.loadFailedTitle')
    expect(html).toContain('vibe.returnToWorkspace')
    expect(html).not.toContain('conversation')
  })

  it('returns to the workspace without changing the saved VIBE configuration', () => {
    useVibeStore.getState().toggleVibeMode(true)
    const background = useVibeStore.getState().background
    const view = VibeModeBoundary({ children: null })
    const boundary = new VibeErrorBoundary(view.props)
    boundary.state = VibeErrorBoundary.getDerivedStateFromError()
    const exit = exitButton(boundary.render())
    expect(exit).toBeTypeOf('function')
    exit?.()
    expect(useVibeStore.getState().isVibeMode).toBe(false)
    expect(useVibeStore.getState().background).toBe(background)
  })

  it('leaves a healthy optional resource mounted without adding a work-area wrapper', () => {
    const resource = createElement('audio', { controls: true })
    const boundary = new VibeResourceBoundary({ children: resource, fallback: 'music' })
    expect(boundary.render()).toBe(resource)
  })

  it('drops only a failed wallpaper while its sibling working conversation remains visible', () => {
    const boundary = new VibeResourceBoundary({ children: createElement('img'), fallback: 'background' })
    boundary.state = VibeResourceBoundary.getDerivedStateFromError()
    expect(boundary.render()).toBeNull()
    const html = renderToStaticMarkup(createElement('main', null,
      boundary.render(), createElement('section', { 'aria-label': 'conversation' }, 'draft and terminal stay here')))
    expect(html).toContain('draft and terminal stay here')
    expect(html).not.toContain('<img')
  })

  it.each(['controls', 'music'] as const)('offers recovery confined to a failed %s resource', (fallback) => {
    const background = useVibeStore.getState().background
    const boundary = new VibeResourceBoundary({ children: createElement('div', null, 'failed resource'), fallback })
    boundary.state = VibeResourceBoundary.getDerivedStateFromError()
    const html = renderToStaticMarkup(boundary.render())
    expect(html).toContain('role="alert"')
    expect(html).toContain('common.retry')
    expect(html).toContain('vibe.exit')
    expect(html).not.toContain('failed resource')
    expect(useVibeStore.getState().background).toBe(background)
  })
})
