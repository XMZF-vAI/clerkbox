import { isValidElement, type ReactElement, type ReactNode } from 'react'
import type { StateCreator } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  webUI: false, scope: 'menu', cursor: 0, slots: {} as Record<string, any[]>,
  effects: [] as Array<{ effect: () => void | (() => void); deps: unknown }>,
  modal: vi.fn(), write: vi.fn(), selectImage: vi.fn(), selectAudio: vi.fn(), selectFolder: vi.fn(),
  fileExists: vi.fn(), listDir: vi.fn(), readImage: vi.fn(), glassSet: vi.fn(), glassClear: vi.fn(), wallpaper: vi.fn(),
}))
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useId: () => 'vibe-test',
  useState: (initial: any) => {
    const slots = h.slots[h.scope] ??= []
    const index = h.cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
  },
  useRef: (initial: any) => {
    const slots = h.slots[h.scope] ??= []
    const index = h.cursor++
    return slots[index] ??= { current: initial }
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps: unknown) => h.effects.push({ effect, deps }),
}))
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>()
  const create = <T>(initializer?: StateCreator<T>): unknown => {
    if (!initializer) return (next: StateCreator<T>) => create(next)
    const store = actual.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  }
  return { ...actual, create }
})
vi.mock('../src/lib/shared-storage', () => ({ sharedStorage: { getItem: () => null, setItem: h.write, removeItem: vi.fn() } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../src/hooks/use-modal-accessibility', () => ({ useModalAccessibility: (...args: unknown[]) => { h.modal(...args); return { current: null } } }))
vi.mock('../src/components/ui/HostFolderPicker', () => ({ default: () => null }))
vi.mock('../src/lib/ipc-client', () => ({
  get isWebUIMode() { return h.webUI },
  ipc: { selectImageFile: h.selectImage, selectAudioFile: h.selectAudio, selectFolder: h.selectFolder, selectMusicFolder: h.selectFolder,
    homeDir: () => 'D:/host', fileExists: h.fileExists, listDir: h.listDir, readImageFileBase64: h.readImage,
    vibeGlassSet: h.glassSet, vibeGlassClear: h.glassClear, vibeGetWallpaper: h.wallpaper },
}))

import { useVibeStore, mergeVibePreferences } from '../src/stores/vibe-store'
import VibeBackground from '../src/components/vibe/VibeBackground'
import VibeCustomizeMenu, { isVibeMediaUrl } from '../src/components/vibe/VibeCustomizeMenu'
import en from '../src/i18n/locales/en'
import zh from '../src/i18n/locales/zh-CN'

const initial = useVibeStore.getState()
type Element = ReactElement<Record<string, any>>
function nodes(root: ReactNode): Element[] {
  if (Array.isArray(root)) return root.flatMap(nodes)
  if (!isValidElement<Record<string, any>>(root)) return []
  return [root, ...nodes(root.props.children)]
}
function render(scope: string, component: () => ReactNode) {
  h.scope = scope; h.cursor = 0; h.effects = []
  return nodes(component())
}
function backgroundChild(name: string) {
  return render('background', VibeBackground).find((node) => typeof node.type === 'function' && node.type.name === name)!
}
function renderChild(child: Element, scope = 'child') { return render(scope, () => (child.type as (props: any) => ReactNode)(child.props)) }
async function settle() { for (let index = 0; index < 10; index++) await Promise.resolve() }
const close = vi.fn()
const menu = (initialTab: 'background' | 'audio' = 'background') => render('menu', () => VibeCustomizeMenu({ onClose: close, initialTab }))
function text(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join(' ')
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : ''
}
function button(view: Element[], label: string) { return view.find((node) => node.type === 'button' && text(node).trim() === label)! }

beforeEach(() => {
  vi.clearAllMocks()
  useVibeStore.setState(initial)
  h.webUI = false; h.slots = {}; h.effects = []; h.cursor = 0
  h.fileExists.mockResolvedValue(true)
  h.listDir.mockResolvedValue([])
  h.readImage.mockResolvedValue('data:image/png;base64,eA==')
  h.glassSet.mockResolvedValue({ track: 'acrylic' })
  h.glassClear.mockResolvedValue(undefined)
  h.wallpaper.mockResolvedValue(null)
  h.selectImage.mockResolvedValue(null)
  h.selectAudio.mockResolvedValue(null)
  h.selectFolder.mockResolvedValue(null)
})

describe('VIBE preference compatibility', () => {
  it('defaults old preferences without restoring an explicitly disabled music source', () => {
    const restored = mergeVibePreferences({ music: null }, initial)
    expect(restored.music).toBeNull()
    expect(restored.musicFolder).toBeNull()
    expect(restored.readingOpacity).toBe(60)
    expect(restored.volume).toBe(35)
    expect(mergeVibePreferences({}, initial).music).toEqual(initial.music)
  })
  it('clamps migration and setters, retaining zero instead of treating it as missing', () => {
    const restored = mergeVibePreferences({ readingOpacity: 1000, volume: -10, glassLevel: NaN, slideshowIntervalSec: 2 }, initial)
    expect(restored).toMatchObject({ readingOpacity: 100, volume: 0, glassLevel: 35, slideshowIntervalSec: 5 })
    const store = useVibeStore.getState()
    store.setReadingOpacity(0); store.setVolume(0)
    expect(useVibeStore.getState()).toMatchObject({ readingOpacity: 0, volume: 0 })
    store.setReadingOpacity(Infinity); store.setVolume(40.7)
    expect(useVibeStore.getState()).toMatchObject({ readingOpacity: 60, volume: 41 })
  })
  it('makes single-track, folder, and off selections mutually exclusive', () => {
    const store = useVibeStore.getState()
    store.setMusicFolder('D:/music')
    expect(useVibeStore.getState()).toMatchObject({ musicFolder: 'D:/music', music: null })
    store.setMusic({ type: 'url', value: 'https://example.test/song.mp3' })
    expect(useVibeStore.getState().musicFolder).toBeNull()
    store.setMusic(null)
    expect(useVibeStore.getState()).toMatchObject({ musicFolder: null, music: null })
    const restored = mergeVibePreferences({ musicFolder: 'D:/music', music: initial.music }, initial)
    expect(restored.music).toBeNull()
  })
  it('persists user preferences while discarding runtime retries and status', () => {
    const store = useVibeStore.getState()
    store.setReadingOpacity(42); store.setVolume(18); store.setBackgroundState('error', 'single'); store.retryBackground()
    const saved = h.write.mock.calls.at(-1)?.[1].state
    expect(saved).toMatchObject({ readingOpacity: 42, volume: 18 })
    expect(saved).not.toHaveProperty('backgroundStatus')
    expect(saved).not.toHaveProperty('backgroundRetryToken')
    expect(mergeVibePreferences({ ...saved, backgroundStatus: 'error', isVibeMode: true }, initial)).toMatchObject({ backgroundStatus: 'loading', isVibeMode: false })
  })
})

describe('recoverable VIBE backgrounds', () => {
  it('keeps a missing local background configuration and exposes an explicit retry', async () => {
    const source = { type: 'local' as const, value: 'D:/missing.png' }
    useVibeStore.getState().setBackground(source)
    h.fileExists.mockResolvedValue(false)
    const child = backgroundChild('SingleBackground')
    renderChild(child)
    h.effects[0].effect()
    await settle()
    expect(useVibeStore.getState()).toMatchObject({ background: source, backgroundStatus: 'error', backgroundIssue: 'single' })
    useVibeStore.getState().retryBackground()
    h.fileExists.mockResolvedValue(true)
    renderChild(child)
    h.effects[0].effect()
    await settle()
    const loaded = renderChild(child).find((node) => node.type === 'img')!
    loaded.props.onLoad()
    expect(useVibeStore.getState()).toMatchObject({ background: source, backgroundStatus: 'ready' })
  })
  it('reports broken image URLs without overwriting the selected URL', async () => {
    const source = { type: 'url' as const, value: 'https://example.test/missing.png' }
    useVibeStore.getState().setBackground(source)
    const child = backgroundChild('SingleBackground')
    renderChild(child); h.effects[0].effect(); await settle()
    renderChild(child).find((node) => node.type === 'img')!.props.onError()
    expect(useVibeStore.getState()).toMatchObject({ background: source, backgroundStatus: 'error' })
  })
  it.each(['empty', 'unreadable'])('reports an %s slideshow while retaining its folder', async (failure) => {
    useVibeStore.setState({ backgroundMode: 'slideshow', slideshowFolder: 'D:/images' })
    if (failure === 'unreadable') h.listDir.mockRejectedValue(new Error('Unavailable'))
    renderChild(backgroundChild('SlideshowBackground'))
    h.effects[0].effect(); await settle()
    expect(useVibeStore.getState()).toMatchObject({ slideshowFolder: 'D:/images', backgroundStatus: failure === 'empty' ? 'empty' : 'error', backgroundIssue: 'slideshow' })
  })
  it('never falls back to an inaccessible file URL after a WebUI image read fails', async () => {
    h.webUI = true
    useVibeStore.getState().setBackground({ type: 'local', value: 'D:/host.png' })
    h.readImage.mockRejectedValue(new Error('No host access'))
    const child = backgroundChild('SingleBackground')
    renderChild(child); h.effects[0].effect(); await settle()
    expect(renderChild(child).some((node) => node.type === 'img')).toBe(false)
    expect(useVibeStore.getState().backgroundStatus).toBe('error')
  })
  it('changes glass strength without clearing the native effect until unmount', async () => {
    useVibeStore.setState({ backgroundMode: 'glass' })
    const child = backgroundChild('GlassBackground')
    renderChild(child)
    const unmount = h.effects[0].effect()
    const replace = h.effects[1].effect()
    await settle()
    if (replace) replace()
    useVibeStore.getState().setGlassLevel(75)
    renderChild(child)
    h.effects[1].effect(); await settle()
    expect(h.glassSet).toHaveBeenLastCalledWith(75)
    expect(h.glassClear).not.toHaveBeenCalled()
    if (unmount) unmount()
    expect(h.glassClear).toHaveBeenCalledTimes(1)
  })
})

describe('accessible VIBE source settings', () => {
  it('uses the shared modal owner and a bounded, internally scrolling panel', () => {
    const view = menu()
    expect(h.modal).toHaveBeenCalledWith(close)
    expect(view.find((node) => node.props.role === 'dialog')?.props.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(view.some((node) => node.props.className?.includes('overflow-y-auto'))).toBe(true)
    expect(view.find((node) => node.props['aria-label'] === 'vibe.readingOpacity')?.props.value).toBe(60)
  })
  it('switches an existing folder to a URL or off without leaving the old folder active', () => {
    useVibeStore.getState().setMusicFolder('D:/music')
    let view = menu('audio')
    view.find((node) => node.type === 'select')!.props.onChange({ target: { value: 'url' } })
    expect(useVibeStore.getState()).toMatchObject({ audioMode: 'local', musicFolder: null, music: null })
    view = menu('audio')
    view.find((node) => node.type === 'select')!.props.onChange({ target: { value: 'off' } })
    expect(useVibeStore.getState().music).toBeNull()
  })
  it('validates URL forms before changing preferences and accepts Enter through form submit', () => {
    expect(isVibeMediaUrl('javascript:alert(1)')).toBe(false)
    expect(isVibeMediaUrl('file:///D:/song.mp3')).toBe(false)
    expect(isVibeMediaUrl(' https://example.test/image.png ')).toBe(true)
    const old = useVibeStore.getState().background
    menu().find((node) => node.type === 'input' && node.props.type === 'url')!.props.onChange({ target: { value: 'not-a-url' } })
    menu().find((node) => node.type === 'form')!.props.onSubmit({ preventDefault: vi.fn() })
    expect(useVibeStore.getState().background).toBe(old)
    expect(menu().some((node) => node.props.role === 'alert' && text(node) === 'vibe.invalidImageUrl')).toBe(true)
  })
  it('shows file-picker failures and does not silently change the source', async () => {
    const original = useVibeStore.getState().background
    menu().find((node) => node.type === 'select')!.props.onChange({ target: { value: 'file' } })
    h.selectImage.mockRejectedValue(new Error('Cancelled by host'))
    await button(menu(), 'vibe.selectLocalImage').props.onClick()
    await settle()
    expect(menu().some((node) => node.props.role === 'alert' && text(node) === 'vibe.sourceSelectionFailed')).toBe(true)
    expect(useVibeStore.getState().background).toBe(original)
  })
  it('registers the nested WebUI host picker as a separate modal keyboard owner', () => {
    h.webUI = true
    useVibeStore.setState({ backgroundMode: 'slideshow' })
    button(menu(), 'vibe.sourceHostFolder').props.onClick()
    const child = menu().find((node) => typeof node.type === 'function' && node.type.name === 'VibeHostFolderPicker')!
    renderChild(child, 'picker')
    expect(h.modal.mock.calls.at(-1)?.[0]).toBe(child.props.onClose)
    expect(child.props.onClose).not.toBe(close)
  })
  it('keeps all VIBE copy symmetric in both languages', () => {
    expect(Object.keys(en.vibe).sort()).toEqual(Object.keys(zh.vibe).sort())
  })
})
