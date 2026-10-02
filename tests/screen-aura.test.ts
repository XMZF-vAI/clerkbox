import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * 屏幕边框光晕的守卫。
 *
 * 由来（用户需求）：「操控的时候，屏幕边框有呼吸的蓝色光晕」，
 * 范围是**整个屏幕**，和那个浮块同级别 —— 即主进程的独立置顶窗口。
 *
 * 三条容易被后人改坏的语义，都在这里锁住：
 *   1. 不能挡鼠标、不能抢焦点 —— 一个声称「我在动你电脑」的提示若吞掉你的输入，
 *      那它本身就是干扰源；
 *   2. 不进录屏/截图 —— 否则用户每张截图都多一圈蓝光，噪声到会想把这功能关掉；
 *   3. 呼吸动的是**强度**不是位置 —— 边框该一直待在边上，一胀一缩会读成「在移动」。
 *
 * 以及两种操控的时长语义不同：电脑操控连续 → 常亮；浏览任务间歇 → 滑窗。
 * 混用会让「AI 正在准备点」被显示成「AI 正在点」。
 */

const aura = readFileSync(
  fileURLToPath(new URL('../electron/screen-aura.ts', import.meta.url)),
  'utf8',
)
const computerUse = readFileSync(
  fileURLToPath(new URL('../electron/computer-use.ts', import.meta.url)),
  'utf8',
)
const agentBrowser = readFileSync(
  fileURLToPath(new URL('../electron/agent-browser.ts', import.meta.url)),
  'utf8',
)
const main = readFileSync(fileURLToPath(new URL('../electron/main.ts', import.meta.url)), 'utf8')

describe('屏幕边框光晕：窗口语义', () => {
  it('不挡鼠标、不抢焦点（提示不得变成障碍）', () => {
    expect(aura).toContain('focusable: false')
    expect(aura).toContain('created.setIgnoreMouseEvents(true)')
  })

  it('不进录屏/截图', () => {
    expect(aura).toContain('created.setContentProtection(true)')
  })

  it('逐屏一个窗口，而不是横跨虚拟桌面的巨窗', () => {
    // 跨屏拼接处会出现两条莫名其妙的竖线
    expect(aura).toContain('screen.getAllDisplays()')
    expect(aura).toContain('const wins = new Map<string, BrowserWindow>()')
  })

  it('透明且无边框（否则是一块灰板不是光晕）', () => {
    expect(aura).toContain('transparent: true')
    expect(aura).toContain("backgroundColor: '#00000000'")
    expect(aura).toContain('frame: false')
  })
})

describe('屏幕边框光晕：呼吸动画', () => {
  it('呼吸的是强度不是位置', () => {
    expect(aura).toMatch(/@keyframes breathe \{[\s\S]{0,200}opacity/)
    // 不能动 inset / transform / box-shadow 的 spread，否则边框看起来在移动
    const keyframes = aura.slice(aura.indexOf('@keyframes breathe'), aura.indexOf('@media'))
    expect(keyframes).not.toMatch(/transform/)
    expect(keyframes).not.toMatch(/inset\s*:/)
  })

it('边框是「厚光带 + 往里渐隐」，不是一根细描边', () => {
    // 用户原话：「不是我要的粗的渐变向里逐渐透明」。1~3px 的描边在满屏内容上等于没有。
    expect(aura).toContain('inset 0 0 0 2px rgba(')
    // 主光带 + 外层柔光，两层才构成连续的「越往里越淡」
    expect(aura).toMatch(/const BAND = (\d+)/)
    const band = Number(aura.match(/const BAND = (\d+)/)![1])
    expect(band).toBeGreaterThanOrEqual(40)
    const shadows = aura.slice(aura.indexOf('box-shadow:'), aura.indexOf('animation: breathe'))
    // 至少三层（实边 + 主带 + 柔光）
    expect(shadows.split('inset').length - 1).toBeGreaterThanOrEqual(3)
  })

  it('不得用 fullscreen: true（Windows 上会按 workArea 缩，任务栏盖不到）', () => {
    expect(aura).not.toMatch(/^\s*fullscreen: true,?$/m)
    expect(aura).toContain('fullscreen: false')
    // 用 display.bounds（含任务栏）显式铺满，而不是 workArea
    expect(aura).toContain('display.bounds')
    expect(aura).not.toMatch(/display\.\w*[Ww]orkArea/)
    // 构造后再钉一次尺寸，防 DPI 缩放改写
    expect(aura).toContain('created.setBounds(bounds)')
  })

  it('prefers-reduced-motion 下不能直接不亮（光晕本身就是提示）', () => {
    expect(aura).toMatch(/prefers-reduced-motion[\s\S]{0,300}animation: none; opacity: \.7/)
  })
})

describe('两种操控的时长语义不同', () => {
  it('电脑操控：动桌面就常亮，收手走 endComputerUseControl', () => {
    expect(computerUse).toContain('void showScreenAura()')
    expect(computerUse).toMatch(/export function endComputerUseControl\(\): void \{[\s\S]{0,120}hideScreenAura\(\)/)
  })

  it('浏览任务：滑窗，不能常亮（截图与推理之间屏幕根本没被碰）', () => {
    expect(agentBrowser).toContain('pulseScreenAura()')
    expect(aura).toMatch(/const PULSE_MS = ([\d_]+)/)
    expect(aura).toMatch(/const PULSE_MS = ([\d_]+)/)
    // 滑窗到期才熄
    expect(aura).toContain('hideScreenAura()\n  }, PULSE_MS)')
  })

  it('应用退出时销毁光晕', () => {
    expect(main).toContain('disposeScreenAura()')
  })
})

describe('浮块卡片不得被窗口切掉圆角', () => {
  it('卡片贴合内容，窗口给足余量', () => {
    // width:100% 会让卡片顶到窗口边缘，右边圆角被裁成直角 —— 用户看到的是「被切了一刀」
    const indicator = readFileSync(
      fileURLToPath(new URL('../electron/cua-indicator.ts', import.meta.url)),
      'utf8',
    )
    expect(indicator).toMatch(/\.pill \{[\s\S]{0,300}width: auto; max-width: 100%;/)
    // 窗口两侧的余量必须够放下圆角（r=12）
    const inset = indicator.match(/INDICATOR_SHADOW_INSET = \{[^}]+\}/)
    expect(inset, '应保留 shadow inset 账').not.toBeNull()
    const right = Number(inset![0].match(/right:\s*(\d+)/)![1])
    const left = Number(inset![0].match(/left:\s*(\d+)/)![1])
    expect(right).toBeGreaterThanOrEqual(16)
    expect(left).toBeGreaterThanOrEqual(16)
  })
})