import { describe, expect, it } from 'vitest'
import { chooseComposerDensity } from '../src/hooks/use-composer-toolbar-fit'
import { MOBILE_QUERY } from '../src/hooks/use-mobile'

describe('composer toolbar fitting', () => {
  it('keeps labels when their actual content fits', () => {
    expect(chooseComposerDensity(640, [600, 440, 340, 280])).toBe(0)
  })
  it('collapses progressively for a long translated model and narrow workbench column', () => {
    expect(chooseComposerDensity(500, [700, 550, 420, 310])).toBe(2)
    expect(chooseComposerDensity(260, [700, 550, 420, 310])).toBe(3)
  })
  it('tolerates subpixel rounding without repeatedly switching density', () => {
    expect(chooseComposerDensity(400, [400.5, 300, 240, 200])).toBe(0)
  })
  it('uses the same exclusive mobile breakpoint as Tailwind md', () => {
    expect(MOBILE_QUERY).toBe('(max-width: 767.98px)')
  })
})
