import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/shared-storage', () => ({
  sharedStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

import { COMMANDS } from '../src/lib/commands'
import { useUIStore } from '../src/stores/ui-store'
import { useVibeStore } from '../src/stores/vibe-store'

const toggleNavigation = () => COMMANDS.find((command) => command.id === 'sidebar.toggle')!.run()

beforeEach(() => {
  useUIStore.setState({ sidebarCollapsed: false, vibeSidebarOpen: false })
  useVibeStore.setState({ isVibeMode: false })
})

describe('mode-aware navigation command', () => {
  it('opens and closes the visible VIBE drawer without changing the regular sidebar preference', () => {
    useVibeStore.setState({ isVibeMode: true })
    toggleNavigation()
    expect(useUIStore.getState().vibeSidebarOpen).toBe(true)
    expect(useUIStore.getState().sidebarCollapsed).toBe(false)
    toggleNavigation()
    expect(useUIStore.getState().vibeSidebarOpen).toBe(false)
  })

  it('continues to collapse the regular sidebar after leaving VIBE', () => {
    useVibeStore.setState({ isVibeMode: true })
    toggleNavigation()
    useVibeStore.setState({ isVibeMode: false })
    toggleNavigation()
    expect(useUIStore.getState().sidebarCollapsed).toBe(true)
  })
})
