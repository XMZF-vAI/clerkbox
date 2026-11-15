import { useLayoutEffect, useRef } from 'react'

export function chooseComposerDensity(available: number, widths: readonly number[]): number {
  const match = widths.findIndex((width) => width <= available + 1)
  return match < 0 ? Math.max(0, widths.length - 1) : match
}

/** Measure an inert copy so long model names and translated labels cannot push Send offscreen. */
export function useComposerToolbarFit() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const toolbar = ref.current
    const parent = toolbar?.parentElement
    if (!toolbar || !parent || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const measure = () => {
      frame = 0
      if (!toolbar.isConnected || toolbar.clientWidth === 0) return
      const copy = toolbar.cloneNode(true) as HTMLDivElement
      copy.setAttribute('aria-hidden', 'true')
      copy.inert = true
      copy.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'))
      copy.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;width:max-content;max-width:none;flex-wrap:nowrap;z-index:-1;'
      for (const child of Array.from(copy.children)) (child as HTMLElement).style.flexGrow = '0'
      parent.appendChild(copy)
      const widths: number[] = []
      try {
        for (let density = 0; density < 4; density += 1) {
          copy.dataset.composerDensity = String(density)
          const gap = parseFloat(getComputedStyle(copy).columnGap) || 0
          const children = Array.from(copy.children) as HTMLElement[]
          widths.push(children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + Math.max(0, children.length - 1) * gap)
        }
      } finally {
        copy.remove()
      }
      toolbar.dataset.composerDensity = String(chooseComposerDensity(toolbar.clientWidth, widths))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    resize.observe(toolbar)
    const content = new MutationObserver(schedule)
    content.observe(toolbar, { childList: true, characterData: true, subtree: true })
    const appearance = new MutationObserver(schedule)
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    document.fonts?.addEventListener('loadingdone', schedule)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      content.disconnect()
      appearance.disconnect()
      document.fonts?.removeEventListener('loadingdone', schedule)
    }
  }, [])
  return ref
}
