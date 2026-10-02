import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 坐标换算的回归守卫。
 *
 * 由来：「AI 点击屏幕总是失败 / 点不到东西」。真凶有三个，全都在这里锁死：
 *
 *   1. 截屏按最长边上限降采样过，模型给的 x/y 是**缩放后那张图**的像素，
 *      而 SendInput/osascript/xdotool 要**屏幕物理像素**。1080p 及以下 scale=1 恰好相等，
 *      一到 1440p/4K 就整体偏出去 —— 所以现象是「在有些屏幕上怎么点都不对」而不是「永远错」。
 *   2. Windows 侧归一化基准原本问 `[System.Windows.Forms.Screen]`，那条 PowerShell
 *      进程没有 DPI 感知，拿回的是**逻辑**像素；SendInput 吃物理像素。125%/150% 屏再偏一次。
 *   3. ABSOLUTE 不带 VIRTUALDESK 只映射主屏，且没减虚拟桌面原点，多屏副屏（尤其左侧负偏移）全错。
 *
 * 这里 mock 掉 electron 的 screen / desktopCapturer / clipboard，把 computer-use 的真实逻辑
 * 跑起来，断言「模型给的坐标最终变成什么物理坐标下发给 backend」。
 */

const { electronMock, backendMock } = vi.hoisted(() => {
  const displays = [
    { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, size: { width: 2560, height: 1440 }, scaleFactor: 1 },
  ]
  const backend = {
    platform: 'win32',
    setVirtualDesktop: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    drag: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    key: vi.fn(async () => {}),
    listApps: vi.fn(async () => []),
    openApp: vi.fn(async () => {}),
    dispose: vi.fn(),
  }
  return {
    electronMock: {
      screen: {
        getPrimaryDisplay: () => displays[0],
        getAllDisplays: () => displays,
      },
      desktopCapturer: {
        // 模拟 Electron 按 thumbnailSize 比例缩：不传就是全尺寸
        getSources: async ({ thumbnailSize }: { thumbnailSize: { width: number; height: number } }) => [
          {
            thumbnail: {
              isEmpty: () => false,
              getSize: () => ({ width: thumbnailSize.width, height: thumbnailSize.height }),
              crop: () => ({
                isEmpty: () => false,
                getSize: () => ({ width: thumbnailSize.width, height: thumbnailSize.height }),
                toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
              }),
              toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            },
          },
        ],
      },
      clipboard: { readText: () => '', writeText: vi.fn() },
    },
    backendMock: backend,
  }
})

vi.mock('electron', () => electronMock)
vi.mock('../electron/computer-input', async () => {
  const actual = await vi.importActual<typeof import('../electron/computer-input')>('../electron/computer-input')
  return { ...actual, getDesktopInputBackend: () => backendMock }
})
vi.mock('../electron/agent-image', () => ({
  fitImageToInlineBudget: (image: unknown) => image,
  persistImageToTmp: (image: { width: number; height: number }) => ({ path: 'shot.png', width: image.width, height: image.height }),
}))
vi.mock('../electron/cua-indicator', () => ({
  showComputerUseIndicator: vi.fn(),
  hideComputerUseIndicator: vi.fn(),
}))

import { runComputerAction, resetComputerUseFrame } from '../electron/computer-use'
import { AGENT_ACTION_LIMITS } from '../src/lib/agent-actions'

const MAX = AGENT_ACTION_LIMITS.computerShotMaxDimension

beforeEach(() => {
  vi.clearAllMocks()
  resetComputerUseFrame()
})

/** 先截一帧，把「模型当前看到的坐标系」建立起来 */
async function frame(): Promise<{ width: number; height: number }> {
  const res = await runComputerAction({ action: 'screenshot' })
  expect(res.ok).toBe(true)
  return res.screen!
}

describe('coordinate space', () => {
  it('1440p 上截屏被降到上限，模型坐标必须按比例还原成物理坐标再下发', async () => {
    await frame()
    // 2560 宽的上限是 1560 → scale = 1560/2560 = 0.609375
    const scale = MAX / 2560
    const bitmapWidth = Math.round(2560 * scale)
    const bitmapHeight = Math.round(1440 * scale)

    // 模型在缩放后的图上点 (800, 500)
    const res = await runComputerAction({ action: 'left_click', x: 800, y: 500 })
    expect(res.ok).toBe(true)

    const [clickedX, clickedY] = backendMock.click.mock.calls[0] as unknown as [number, number]
    // 期望：800 / scale ≈ 1313
    expect(clickedX).toBeCloseTo(Math.round(800 / scale), 0)
    expect(clickedY).toBeCloseTo(Math.round(500 / scale), 0)

    // 关键守卫：绝不能把模型坐标原样透传（旧 bug）
    expect(clickedX).not.toBe(800)
    expect(clickedY).not.toBe(500)
    // 也不该越出屏幕
    expect(clickedX).toBeLessThan(2560)
    expect(clickedY).toBeLessThan(1440)
    expect(bitmapWidth).toBeGreaterThan(0)
    expect(bitmapHeight).toBeGreaterThan(0)
  })

  it('屏幕尺寸不超过上限时坐标原样透传（换算不能引入回归）', async () => {
    // 注意：1920x1080 的最长边 1920 > 1560，**照样会被降采样**。
    // 真正 scale=1 的前提是最长边 <= computerShotMaxDimension，用 1366x768。
    const displays = electronMock.screen.getAllDisplays()
    const original = displays[0]!
    displays[0] = { bounds: { x: 0, y: 0, width: 1366, height: 768 }, size: { width: 1366, height: 768 }, scaleFactor: 1 }
    try {
      resetComputerUseFrame()
      await frame()
      await runComputerAction({ action: 'left_click', x: 683, y: 384 })
      expect(backendMock.click).toHaveBeenCalledWith(683, 384, 'left', 1)
    } finally {
      displays[0] = original
      resetComputerUseFrame()
    }
  })

  it('没有可用帧时照搬模型坐标（越界校验兜底，不凭空猜 scaleFactor）', async () => {
    resetComputerUseFrame()
    const res = await runComputerAction({ action: 'left_click', x: 300, y: 200 })
    expect(res.ok).toBe(true)
    expect(backendMock.click).toHaveBeenCalledWith(300, 200, 'left', 1)
  })

  it('move / drag / scroll 走同一条换算，不能只修 click', async () => {
    await frame()
    const scale = MAX / 2560
    await runComputerAction({ action: 'mouse_move', x: 400, y: 300 })
    expect(backendMock.move).toHaveBeenCalledWith(Math.round(400 / scale), Math.round(300 / scale))

    await runComputerAction({ action: 'left_click_drag', fromX: 200, fromY: 100, toX: 600, toY: 700 })
    expect(backendMock.drag).toHaveBeenCalledWith(
      { x: Math.round(200 / scale), y: Math.round(100 / scale) },
      { x: Math.round(600 / scale), y: Math.round(700 / scale) },
    )

    await runComputerAction({ action: 'scroll', x: 500, y: 500, deltaY: -3 })
    expect(backendMock.scroll).toHaveBeenCalledWith(
      Math.round(500 / scale),
      Math.round(500 / scale),
      0,
      -3,
    )
  })

  it('不带坐标的 scroll 不该被塞进 (0,0)', async () => {
    await frame()
    await runComputerAction({ action: 'scroll', deltaY: -5 })
    expect(backendMock.scroll).toHaveBeenCalledWith(undefined, undefined, 0, -5)
  })

  it('每次动作都把虚拟桌面几何下发一次（helper 查不到物理像素）', async () => {
    await runComputerAction({ action: 'left_click', x: 10, y: 10 })
    expect(backendMock.setVirtualDesktop).toHaveBeenCalledWith({ x: 0, y: 0, width: 2560, height: 1440 })
  })

  it('scale 用错方向会立刻被抓到（乘除之间只差一个反比，但不换算等于没修）', async () => {
    // 这条不是测产品，是给改这段代码的人留的绊：scale 到底是「位图像素/屏幕像素」
    // 还是反过来，两种写法都能编译过、都不报错，只有结果差一个反比。
    // 这里断言「还原后的坐标必须比模型给的更大」—— 屏幕比模型看到的图大，方向反了就不成立
    await frame()
    await runComputerAction({ action: 'left_click', x: 800, y: 500 })
    const [clickedX] = backendMock.click.mock.calls[0] as unknown as [number, number]
    expect(clickedX).toBeGreaterThan(800)
    expect(clickedX).toBeLessThanOrEqual(2560)
  })

  it('越界校验仍然按「模型看到的那张图」的尺寸，而不是屏幕尺寸', async () => {
    // 缩放后图高 877；若拿 1440 当上界，y=1200 这种值会被放过，实际早就飞出去了
    await frame()
    const bitmapHeight = Math.round(1440 * (MAX / 2560))
    const res = await runComputerAction({ action: 'left_click', x: 100, y: bitmapHeight + 50 })
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('out_of_bounds')
    expect(backendMock.click).not.toHaveBeenCalled()
  })
})

describe('virtual desktop geometry', () => {
  it('左侧副屏（负原点）算出的并集矩形带负 x，且动作会带着它下发', async () => {
    const displays = electronMock.screen.getAllDisplays()
    const original = displays.slice()
    displays.length = 0
    displays.push(
      { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 } as never,
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 } as never,
    )
    try {
      await runComputerAction({ action: 'left_click', x: 10, y: 10 })
      // 旧 bug：只报主屏 1920x1080，且没减负原点 → 副屏落点全错
      expect(backendMock.setVirtualDesktop).toHaveBeenCalledWith({ x: -1920, y: 0, width: 3840, height: 1080 })
    } finally {
      displays.length = 0
      displays.push(...(original as never[]))
    }
  })
})

describe('windows helper geometry contract', () => {
  it('C# 里不再用 Windows Forms 查屏宽，且启用 VIRTUALDESK', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync(new URL('../electron/computer-input.ts', import.meta.url), 'utf8')
    // 这两条是正则扫源码字符串：注释里可以提，代码里不能再依赖
    const csBody = src.slice(src.indexOf('Add-Type -TypeDefinition'), src.indexOf('"@\n\nWrite-Output'))
    // 注释里可以解释为什么不用它，代码里不能真的调它
    expect(csBody).not.toMatch(/Screen\.PrimaryScreen/)
    expect(csBody).not.toMatch(/static int Screen[WH]\(\)/)
    expect(csBody).not.toMatch(/Add-Type -AssemblyName System\.Windows\.Forms/)
    expect(csBody).toContain('MOUSEEVENTF_VIRTUALDESK')
    // 归一化必须减掉虚拟桌面原点（副屏在左侧时是负数）
    expect(csBody).toMatch(/Norm\(x - DeskX, DeskW\)/)
    expect(csBody).toMatch(/Norm\(y - DeskY, DeskH\)/)
    // 几何由 Node 侧下发
    expect(src).toContain("'desk' { [ClerkBoxInput]::SetDesktop(")
  })

  it('桌面矩形由所有显示器并集算出，边界不漏', async () => {
    const { virtualDesktopRect } = await import('../electron/computer-input')
    const displays = electronMock.screen.getAllDisplays()
    const original = displays.slice()
    displays.length = 0
    displays.push(
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } } as never,
      { bounds: { x: 1920, y: -200, width: 2560, height: 1440 } } as never,
    )
    try {
      // 并集 x: min(0,1920)=0 → max(1920, 1920+2560)=4480，宽 4480
      //      y: min(0,-200)=-200 → max(1080, -200+1440=1240)=1240，高 1240-(-200)=1440
      expect(virtualDesktopRect()).toEqual({ x: 0, y: -200, width: 4480, height: 1440 })
    } finally {
      displays.length = 0
      displays.push(...(original as never[]))
    }
  })

  it('单屏时就是那块屏自己（不引入多余的负原点）', async () => {
    const { virtualDesktopRect } = await import('../electron/computer-input')
    expect(virtualDesktopRect()).toEqual({ x: 0, y: 0, width: 2560, height: 1440 })
  })
})