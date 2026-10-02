import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ipcStub } = vi.hoisted(() => ({
  ipcStub: {
    agentBrowserCommand: vi.fn(),
    computerUseCommand: vi.fn(),
    writeFile: vi.fn(async (_path: string, _content: string) => {}),
  },
}))
vi.mock('../src/lib/ipc-client', () => ({ ipc: ipcStub }))

import { executeComputerTool, isComputerTool, COMPUTER_TOOLS } from '../src/lib/computer-tools'
import { isComputerAction, type ComputerAction, type ComputerActionResult } from '../src/lib/agent-actions'
import type { ToolContext } from '../src/lib/tool-registry'

const HOME = 'C:\\Users\\tester'
const ctx = (): ToolContext => ({ homeDir: HOME, recordImage: vi.fn() })

function okResult(overrides: Partial<ComputerActionResult> = {}): ComputerActionResult {
  return { ok: true, screen: { width: 1920, height: 1080, scaleFactor: 1 }, elapsedMs: 8, ...overrides }
}

/** 执行器下发的动作 + 契约层校验，两边必须对得上 —— 任一漏就断言失败 */
async function runAndCapture(name: string, args: Record<string, unknown>) {
  await executeComputerTool(name, args, ctx())
  const sent = ipcStub.computerUseCommand.mock.calls.at(-1)?.[0] as unknown
  if (sent === undefined) return undefined
  // 契约层是主进程 handler 的准入门：这里过一遍，早发现动作形状漂移
  expect(isComputerAction(sent), `主进程会拒绝这个动作: ${JSON.stringify(sent)}`).toBe(true)
  return sent as ComputerAction
}

beforeEach(() => {
  vi.clearAllMocks()
  ipcStub.computerUseCommand.mockResolvedValue(okResult())
})

describe('computer tool definitions', () => {
  it('十个工具，名字与 computer_* 前缀约定一致', () => {
    expect(COMPUTER_TOOLS.map((t) => t.name).sort()).toEqual([
      'computer_app',
      'computer_click',
      'computer_clipboard',
      'computer_drag',
      'computer_key',
      'computer_move',
      'computer_screenshot',
      'computer_scroll',
      'computer_type',
      'computer_wait',
    ])
  })

  it('坐标类工具都必须在描述里写明坐标约定（模型最常见的错误就是拿窗口 bounds 当坐标）', () => {
    const coordinateTools = ['computer_click', 'computer_move', 'computer_drag', 'computer_scroll']
    for (const name of coordinateTools) {
      const tool = COMPUTER_TOOLS.find((t) => t.name === name)!
      expect(tool.description, name).toContain('screenshot')
      expect(tool.description, name).toMatch(/absolute integer pixels/i)
      expect(tool.description, name).toMatch(/not.*window bounds/i)
    }
  })

  it('截图工具的描述要求「先截图再动手」', () => {
    const tool = COMPUTER_TOOLS.find((t) => t.name === 'computer_screenshot')!
    expect(tool.description).toMatch(/before any other computer tool/i)
  })

  it('每个工具都带 object schema', () => {
    for (const tool of COMPUTER_TOOLS) {
      expect(tool.parameters).toHaveProperty('type', 'object')
      expect(isComputerTool(tool.name)).toBe(true)
    }
  })
})

describe('computer action shapes', () => {
  it('每个工具都能产出通过主进程校验的动作', async () => {
    const samples: Array<[string, Record<string, unknown>]> = [
      ['computer_screenshot', {}],
      ['computer_screenshot', { region: [0, 0, 800, 600] }],
      ['computer_click', { x: 10, y: 20 }],
      ['computer_click', { x: 10, y: 20, click_count: 2 }],
      ['computer_click', { x: 10, y: 20, button: 'right' }],
      ['computer_move', { x: 5, y: 6 }],
      ['computer_drag', { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }],
      ['computer_scroll', {}],
      ['computer_scroll', { x: 5, y: 6, delta_y: -3 }],
      ['computer_type', { text: 'hello' }],
      ['computer_key', { key: 'Control+s' }],
      ['computer_wait', {}],
      ['computer_app', { action: 'list' }],
      ['computer_app', { action: 'open', name: 'notepad' }],
      ['computer_clipboard', { action: 'read' }],
      ['computer_clipboard', { action: 'write', text: 'x' }],
    ]
    for (const [name, args] of samples) {
      const action = await runAndCapture(name, args)
      expect(action, `${name} ${JSON.stringify(args)}`).toBeDefined()
    }
  })

  it('click_count>=2 收敛为双击，不另造工具', async () => {
    expect((await runAndCapture('computer_click', { x: 1, y: 2, click_count: 2 }))?.action).toBe('double_click')
  })

  it('默认值：scroll 三格向下，wait 走常量', async () => {
    const scroll = await runAndCapture('computer_scroll', {})
    expect(scroll).toEqual({ action: 'scroll', x: undefined, y: undefined, deltaX: undefined, deltaY: -3 })
    const wait = await runAndCapture('computer_wait', {})
    expect(wait?.action).toBe('wait')
    if (wait?.action === 'wait') expect(wait.durationMs).toBe(1000)
  })

  it('app / clipboard 的 action 决定分支', async () => {
    expect((await runAndCapture('computer_app', { action: 'open', name: 'calc' }))?.action).toBe('open_application')
    expect((await runAndCapture('computer_app', { action: 'list' }))?.action).toBe('list_apps')
    expect((await runAndCapture('computer_clipboard', { action: 'write', text: 'y' }))?.action).toBe('write_clipboard')
    expect((await runAndCapture('computer_clipboard', { action: 'read' }))?.action).toBe('read_clipboard')
  })

  it('模型送字符串坐标时收口成数字', async () => {
    const action = await runAndCapture('computer_click', { x: '40', y: '50' })
    expect(action).toMatchObject({ action: 'left_click', x: 40, y: 50 })
  })
})

describe('input clamping (模型会送天文数字与字符串)', () => {
  it('wait 时长被钳到上限', async () => {
    const action = await runAndCapture('computer_wait', { duration_ms: 99_999_999 })
    expect(action?.action).toBe('wait')
    if (action?.action === 'wait') expect(action.durationMs).toBe(30_000)
  })

  it('wait 负数归零而不是变超大延时', async () => {
    const action = await runAndCapture('computer_wait', { duration_ms: -500 })
    expect(action?.action).toBe('wait')
    if (action?.action === 'wait') expect(action.durationMs).toBe(0)
  })

  it('type 文本按上限截断', async () => {
    const action = await runAndCapture('computer_type', { text: 'x'.repeat(10_000) })
    expect(action?.action).toBe('type')
    if (action?.action === 'type') expect(action.text).toHaveLength(4_000)
  })

  it('区域截图四个分量全部转成整数', async () => {
    const action = await runAndCapture('computer_screenshot', { region: [1.4, 2.6, 800.2, 600.8] })
    expect(action?.action).toBe('screenshot')
    if (action?.action === 'screenshot') expect(action.region).toEqual([1, 3, 800, 601])
  })

  it('region 长度不对时退化为全屏，而不是截一个含义不明的矩形', async () => {
    const action = await runAndCapture('computer_screenshot', { region: [1, 2] })
    expect(action).toEqual({ action: 'screenshot' })
  })
})

describe('argument rejection (本地拒绝，不发 IPC)', () => {
  it('缺参数的调用给出可据以自纠的错误', async () => {
    for (const [name, args, hint] of [
      ['computer_click', { x: 1 }, 'both x and y'],
      ['computer_drag', { from_x: 1 }, 'from_x'],
      ['computer_type', {}, 'text'],
      ['computer_key', {}, 'key'],
      ['computer_app', { action: 'open' }, 'name'],
      ['computer_clipboard', { action: 'write' }, 'text'],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const out = await executeComputerTool(name, args, ctx())
      expect(out, name).toMatch(/^Error: /)
      expect(out, name).toContain(hint)
    }
    expect(ipcStub.computerUseCommand).not.toHaveBeenCalled()
  })
})

describe('result rendering', () => {
  it('结果里带回屏幕尺寸，模型据此判断坐标是否越界', async () => {
    const out = await executeComputerTool('computer_click', { x: 1, y: 1 }, ctx())
    expect(out).toContain('Screen: 1920x1080px')
  })

  it('应用列表逐条渲染并标出活跃项', async () => {
    ipcStub.computerUseCommand.mockResolvedValue(
      okResult({ apps: [{ name: 'Explorer', pid: 100 }, { name: 'Code', pid: 200, active: true }] }),
    )
    const out = await executeComputerTool('computer_app', { action: 'list' }, ctx())
    expect(out).toContain('- Explorer (pid 100)')
    expect(out).toContain('- Code (pid 200) [active]')
  })

  it('空应用列表有明确文案，不返回空白', async () => {
    ipcStub.computerUseCommand.mockResolvedValue(okResult({ apps: [] }))
    expect(await executeComputerTool('computer_app', { action: 'list' }, ctx())).toContain('No applications reported.')
  })

  it('错误码原样透出，模型能据此自纠', async () => {
    ipcStub.computerUseCommand.mockResolvedValue({
      ok: false,
      error: { code: 'out_of_bounds', message: 'x=5000 is outside the 1920x1080 screen.' },
      elapsedMs: 1,
    })
    expect(await executeComputerTool('computer_click', { x: 5000, y: 1 }, ctx())).toMatch(/^Error: \[out_of_bounds\]/)
  })

  it('平台不支持时不伪装成成功', async () => {
    ipcStub.computerUseCommand.mockResolvedValue({
      ok: false,
      error: { code: 'platform_unsupported', message: 'Computer use input synthesis is not available on this platform.' },
      elapsedMs: 1,
    })
    expect(await executeComputerTool('computer_click', { x: 1, y: 1 }, ctx())).toMatch(/^Error: \[platform_unsupported\]/)
  })

  it('IPC 抛错回 Error 字符串而不是 reject', async () => {
    ipcStub.computerUseCommand.mockRejectedValue(new Error('no handler'))
    expect(await executeComputerTool('computer_screenshot', {}, ctx())).toMatch(/^Error: computer command failed - no handler/)
  })

  it('畸形结果被识别', async () => {
    ipcStub.computerUseCommand.mockResolvedValue({ nonsense: true })
    expect(await executeComputerTool('computer_screenshot', {}, ctx())).toMatch(/^Error: malformed/)
  })
})

describe('screenshot side channel', () => {
  it('主进程已落盘 → 渲染层只转手上报引用，绝不自己写文件', async () => {
    const toolCtx = ctx()
    const ref = { path: 'C:\\Users\\tester\\.clerkbox\\tmp\\agent-computer-shot-a.jpg', mimeType: 'image/jpeg', width: 1560, height: 880, fullScreen: true }
    ipcStub.computerUseCommand.mockResolvedValue(okResult({ imageRef: ref }))
    const out = await executeComputerTool('computer_screenshot', {}, toolCtx)
    // 写文件必须在主进程：ipc.writeFile 是文本通道，写 base64 会得到「长得像 data URL 的文本文件」，
    // 模型侧随即报 invalid image content: decode image config: image: unknown format
    expect(ipcStub.writeFile).not.toHaveBeenCalled()
    expect(toolCtx.recordImage).toHaveBeenCalledWith(ref)
    expect(out).toContain('Screenshot attached: 1560x880')
  })

  it('主进程没给 imageRef 时不伪造一张图', async () => {
    const toolCtx = ctx()
    ipcStub.computerUseCommand.mockResolvedValue(okResult())
    const out = await executeComputerTool('computer_screenshot', {}, toolCtx)
    expect(toolCtx.recordImage).not.toHaveBeenCalled()
    expect(out).not.toContain('Screenshot attached')
  })

  it('非截图动作不产出图像', async () => {
    const toolCtx = ctx()
    await executeComputerTool('computer_click', { x: 1, y: 1 }, toolCtx)
    expect(toolCtx.recordImage).not.toHaveBeenCalled()
  })
})
