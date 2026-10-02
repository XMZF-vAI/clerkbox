import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * 「按 Esc 停止」与 AI 指针的守卫。
 *
 * 这两件都是**安全/可感知性**设施，出错的方向都是「提示在骗人」或「叫停按不动」，
 * 所以逐条锁死。
 */

const guard = readFileSync(
  fileURLToPath(new URL('../electron/escape-guard.ts', import.meta.url)),
  'utf8',
)
const computerUse = readFileSync(
  fileURLToPath(new URL('../electron/computer-use.ts', import.meta.url)),
  'utf8',
)
const cursor = readFileSync(
  fileURLToPath(new URL('../electron/ai-cursor.ts', import.meta.url)),
  'utf8',
)
const bridge = readFileSync(
  fileURLToPath(new URL('../src/components/workbench/AgentActionBridge.tsx', import.meta.url)),
  'utf8',
)

describe('小岛提示「按 Esc 停止」', () => {
  it('接管失败时必须把提示藏掉（提示一个按不动的键比没提示更糟）', () => {
    expect(computerUse).toMatch(/const guarded = beginEscapeGuard\(/)
    expect(computerUse).toContain('guarded ? DESKTOP_CONTROL_HINT')
    // 失败时传空串 → 小岛不显示提示
    expect(computerUse).not.toMatch(/showComputerUseIndicator\(DESKTOP_CONTROL_TITLE, DESKTOP_CONTROL_HINT\)/)
  })

  it('小岛真的能显示第二行提示', () => {
    const indicator = readFileSync(
      fileURLToPath(new URL('../electron/cua-indicator.ts', import.meta.url)),
      'utf8',
    )
    expect(indicator).toContain('<span class="hint">${escapeHtml(hint)}</span>')
    expect(indicator).toContain('.hint {')
    expect(computerUse).toContain("const DESKTOP_CONTROL_HINT = '按 Esc 停止'")
  })
})

describe('Esc 的接管范围必须与操控期一致', () => {
  it('注册与注销成对，且每个收手路径都注销', () => {
    // 忘了注销 = Esc 被 ClerkBox 永久占着，用户在别的应用里再也按不到 Esc
    expect(guard).toContain("globalShortcut.register('Escape'")
    expect(guard).toContain("globalShortcut.unregister('Escape'")
    expect(computerUse).toMatch(/export function endComputerUseControl\(\): void \{[\s\S]{0,200}endEscapeGuard\(\)/)
    expect(computerUse).toMatch(/export function resetComputerUseFrame\(\): void \{[\s\S]{0,200}endEscapeGuard\(\)/)
    expect(computerUse).toMatch(/export function disposeComputerUseCursors\(\): void \{[\s\S]{0,200}endEscapeGuard\(\)/)
  })

  it('不用新增原生键盘钩子（本仓 npmRebuild: false，新原生模块起不来）', () => {
    expect(guard.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/uiohook|global-keyboard|iohook/i)
    expect(guard).toContain('globalShortcut')
  })

  it('必须真的 abort 那次运行（只关浮块的话 AI 下轮还会继续动鼠标）', () => {
    expect(bridge).toContain('onComputerUseUserStopped')
    expect(bridge).toContain('getSessionAbortController')
    expect(bridge).toContain('ctrl.abort()')
  })
})

describe('AI 指针', () => {
  it('只叠加不替换系统光标（替换了用户就没法在 AI 操作期间用自己的鼠标）', () => {
    expect(cursor).toContain('setIgnoreMouseEvents(true)')
    expect(cursor).toContain('focusable: false')
    expect(cursor).toContain('setContentProtection(true)')
    // 不该有替换系统光标的尝试
    expect(cursor).not.toMatch(/setCursor|cursor:\s*none/)
  })

  it('用小窗口 setPosition 跟随，而不是往 sandbox 页面注入坐标', () => {
    // 整屏窗口写坐标只能靠 executeJavaScript，每跟一步注入一次，慢且脏
    expect(cursor).toContain('created.setPosition(')
    expect(cursor.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('executeJavaScript')
  })

  it('每个指针类动作都跟着走，且用换算后的屏幕物理坐标', () => {
    // pointCursor 必须在 backend.click/move/drag 之前，且喂的是 scaled() 的结果
    const clicks = computerUse.match(/pointCursor\(scaled\(action\)\)/g)
    expect(clicks?.length ?? 0).toBeGreaterThanOrEqual(4)
    expect(computerUse).toContain('pointCursor(scaled(action, \'fromX\', \'fromY\'))')
    // 滚动也跟
    expect(computerUse).toMatch(/pointCursor\(at\)/)
  })

  it('静默后自动隐藏，不留一个看起来坏了的残留物', () => {
    expect(cursor).toMatch(/const IDLE_HIDE_MS = ([\d_]+)/)
    const ms = Number(cursor.match(/const IDLE_HIDE_MS = ([\d_]+)/)![1].replace(/_/g, ''))
    expect(ms).toBeGreaterThan(500)
    expect(cursor).toContain('setTimeout(() => hideAiCursor(), IDLE_HIDE_MS)')
  })

  it('收手时必须一起隐藏', () => {
    expect(computerUse).toMatch(/export function endComputerUseControl\(\): void \{[\s\S]{0,240}hideAiCursor\(\)/)
  })

  it('极简：一个点 + 一圈柔光，不堆细节（屏幕上已有浮块和光晕两个提示）', () => {
    expect(cursor).toMatch(/\.dot \{[\s\S]{0,320}border-radius: 50%/)
    expect(cursor).toContain('0 0 10px 2px rgba(')
    // 不要往指针上加文字或复杂形状
    expect(cursor).not.toMatch(/<span|<svg|<text/)
  })
})
