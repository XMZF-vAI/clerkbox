import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ipcStub } = vi.hoisted(() => ({
  ipcStub: {
    agentBrowserCommand: vi.fn(),
    computerUseCommand: vi.fn(),
    agentBrowserReady: vi.fn(async () => true),
    agentBrowserEnsurePanel: vi.fn(async () => true),
    writeFile: vi.fn(async (_path: string, _content: string) => {}),
  },
}))
vi.mock('../src/lib/ipc-client', () => ({ ipc: ipcStub }))

import { BROWSER_TOOLS, executeBrowserTool, isBrowserTool } from '../src/lib/browser-tools'
import { COMPUTER_TOOLS, executeComputerTool, isComputerTool } from '../src/lib/computer-tools'
import { toolRegistry } from '../src/lib/tool-registry'
import type { BrowserCommandResult, ComputerActionResult } from '../src/lib/agent-actions'
import type { ToolContext } from '../src/lib/tool-registry'

const HOME = 'C:\\Users\\tester'
const ctx = (): ToolContext => ({ homeDir: HOME, recordImage: vi.fn() })

function okResult(overrides: Partial<BrowserCommandResult> = {}): BrowserCommandResult {
  return {
    ok: true,
    state: { url: 'https://example.com/', title: 'Example', canGoBack: false, canGoForward: false, loading: false },
    elapsedMs: 12,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ipcStub.agentBrowserCommand.mockResolvedValue(okResult())
  // 默认 guest 已就绪；「等待就绪」相关的用例单独覆盖
  ipcStub.agentBrowserReady.mockResolvedValue(true)
  ipcStub.agentBrowserEnsurePanel.mockResolvedValue(true)
})

// ── 名称与注册 ──

describe('browser tool registry', () => {
  it('恰好九个工具，名字与 browser_* 前缀约定一致', () => {
    expect(BROWSER_TOOLS.map((t) => t.name).sort()).toEqual([
      'browser_click',
      'browser_evaluate',
      'browser_navigate',
      'browser_press',
      'browser_screenshot',
      'browser_scroll',
      'browser_snapshot',
      'browser_type',
      'browser_wait',
    ])
  })

  it('每个工具都带 object schema 与非空描述', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(tool.parameters).toHaveProperty('type', 'object')
      expect(tool.description.length).toBeGreaterThan(40)
      expect(isBrowserTool(tool.name)).toBe(true)
    }
  })

  it('必填参数与契约一致（缺参数时执行层自己兜住，不靠模型自觉）', () => {
    const required = (name: string) => (BROWSER_TOOLS.find((t) => t.name === name)?.parameters as { required?: string[] }).required ?? []
    expect(required('browser_type')).toEqual(['text'])
    expect(required('browser_evaluate')).toEqual(['expression'])
    expect(required('browser_press')).toEqual(['key'])
    expect(required('browser_click')).toEqual([])
  })

  it('computer 工具同样成族且带 schema', () => {
    expect(COMPUTER_TOOLS).toHaveLength(10)
    for (const tool of COMPUTER_TOOLS) {
      expect(tool.parameters).toHaveProperty('type', 'object')
      expect(isComputerTool(tool.name)).toBe(true)
    }
  })

  it('未命中族的名字返回 null，交给 tool-registry 继续分流', async () => {
    await expect(executeBrowserTool('read_file', {}, undefined)).resolves.toBeNull()
    await expect(executeComputerTool('read_file', {}, undefined)).resolves.toBeNull()
  })
})

// ── tool-registry 接入 ──

describe('tool-registry wiring', () => {
  it('开关关闭时模型看不到这十九个工具', () => {
    const visible = toolRegistry.getDefinitionsForMode('default').map((t) => t.name)
    expect(visible.some((n) => n.startsWith('browser_'))).toBe(false)
    expect(visible.some((n) => n.startsWith('computer_'))).toBe(false)
  })

  it('打开浏览器能力后只放出 browser_*，computer_* 仍关闭', () => {
    toolRegistry.setAgentActionCapabilities({ browser: true, computer: false })
    const visible = toolRegistry.getDefinitionsForMode('default').map((t) => t.name)
    expect(visible.filter((n) => n.startsWith('browser_'))).toHaveLength(9)
    expect(visible.some((n) => n.startsWith('computer_'))).toBe(false)
    toolRegistry.setAgentActionCapabilities({ browser: false, computer: false })
  })

  it('兼容 harness 模式下开关同样生效（过滤只有一个出口）', () => {
    toolRegistry.setAgentActionCapabilities({ browser: true, computer: true })
    for (const mode of ['codex', 'grok-build', 'dsh', 'zcode'] as const) {
      const visible = toolRegistry.getDefinitionsForMode(mode).map((t) => t.name)
      expect(visible.filter((n) => n.startsWith('browser_')).length, mode).toBe(9)
      expect(visible.filter((n) => n.startsWith('computer_')).length, mode).toBe(10)
    }
    // dsh-minimal 官方只保留 execute_command + search_replace，Agent 动作工具同理被裁掉
    const minimal = toolRegistry.getDefinitionsForMode('dsh-minimal').map((t) => t.name)
    expect(minimal.some((n) => n.startsWith('browser_'))).toBe(false)
    expect(minimal.some((n) => n.startsWith('computer_'))).toBe(false)
    toolRegistry.setAgentActionCapabilities({ browser: false, computer: false })
  })

  it('开关关闭时即使模型硬调也执行不了（fail-closed，不只是「看不见」）', async () => {
    const out = await toolRegistry.execute('browser_snapshot', {}, ctx())
    expect(out).toMatch(/^Error: browser_snapshot is not available/)
    expect(out).toContain('Browser use')
    expect(ipcStub.agentBrowserCommand).not.toHaveBeenCalled()

    const computerOut = await toolRegistry.execute('computer_screenshot', {}, ctx())
    expect(computerOut).toMatch(/^Error: computer_screenshot is not available/)
    expect(ipcStub.computerUseCommand).not.toHaveBeenCalled()
  })

  it('打开后经 tool-registry 分发到主进程', async () => {
    toolRegistry.setAgentActionCapabilities({ browser: true, computer: false })
    const out = await toolRegistry.execute('browser_navigate', { url: 'https://example.com' }, ctx())
    expect(out).toContain('URL: https://example.com/')
    expect(ipcStub.agentBrowserCommand).toHaveBeenCalledWith({ method: 'navigate', url: 'https://example.com' })
    toolRegistry.setAgentActionCapabilities({ browser: false, computer: false })
  })
})

// ── args → 命令 ──

describe('browser args to command', () => {
  it('navigate 支持 back / forward / reload 三个动作', async () => {
    await executeBrowserTool('browser_navigate', { action: 'back' }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith({ method: 'back' })
    await executeBrowserTool('browser_navigate', { action: 'forward' }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith({ method: 'forward' })
    await executeBrowserTool('browser_navigate', { action: 'reload' }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith({ method: 'reload' })
  })

  it('navigate 缺 url 时本地报参数错，不发 IPC', async () => {
    const out = await executeBrowserTool('browser_navigate', {}, ctx())
    expect(out).toMatch(/^Error: /)
    expect(ipcStub.agentBrowserCommand).not.toHaveBeenCalled()
  })

  it('click 优先用 ref，无 ref 时退回坐标', async () => {
    await executeBrowserTool('browser_click', { ref: 'e7' }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'click', target: { type: 'ref', ref: 'e7' } }),
    )
    await executeBrowserTool('browser_click', { x: 100, y: 200, button: 'right', click_count: 2 }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: 'click', target: { type: 'coordinate', x: 100, y: 200 }, button: 'right', clickCount: 2 }),
    )
  })

  it('click 只有 x 没有 y 时拒绝，不猜坐标', async () => {
    const out = await executeBrowserTool('browser_click', { x: 100 }, ctx())
    expect(out).toMatch(/^Error: .*either a ref, or both x and y/)
    expect(ipcStub.agentBrowserCommand).not.toHaveBeenCalled()
  })

  it('type / press / scroll 透传各自的可选字段', async () => {
    await executeBrowserTool('browser_type', { text: 'hello', ref: 'e3', clear: true }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith({ method: 'type', text: 'hello', ref: 'e3', clear: true })

    await executeBrowserTool('browser_press', { key: 'Control+Enter' }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'press', key: 'Control+Enter' }))

    await executeBrowserTool('browser_scroll', { delta_y: -600 }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'scroll', deltaY: -600 }))
  })

  it('字符串入参被收口成数字（模型偶尔送 "42"）', async () => {
    await executeBrowserTool('browser_click', { x: '40', y: '50' }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: { type: 'coordinate', x: 40, y: 50 } }),
    )
  })

  it('未知入参键不进入命令（不透传给主进程）', async () => {
    await executeBrowserTool('browser_wait', { selector: '.done', timeout_ms: 2000, evil: 'x' }, ctx())
    expect(ipcStub.agentBrowserCommand).toHaveBeenLastCalledWith({ method: 'wait', selector: '.done', timeoutMs: 2000 })
  })
})

// ── 结果 → 文本 ──

describe('browser result rendering', () => {
  it('快照结果带 URL / 标题 / 树，并提示 ref 会失效', async () => {
    ipcStub.agentBrowserCommand.mockResolvedValue(
      okResult({
        snapshot: {
          url: 'https://example.com/',
          title: 'Example',
          tree: '- link "Docs" [e1]\n- textbox "Search" [e2]',
          elements: [],
          truncated: false,
        },
      }),
    )
    const out = await executeBrowserTool('browser_snapshot', {}, ctx())
    expect(out).toContain('- link "Docs" [e1]')
    expect(out).toContain('Re-run browser_snapshot')
  })

  it('truncated 快照给出收窄提示，而不是静默截断', async () => {
    ipcStub.agentBrowserCommand.mockResolvedValue(
      okResult({ snapshot: { url: 'u', title: 't', tree: 'x', elements: [], truncated: true } }),
    )
    expect(await executeBrowserTool('browser_snapshot', {}, ctx())).toContain('Snapshot truncated')
  })

  it('失败结果把错误码带给模型，便于自纠', async () => {
    ipcStub.agentBrowserCommand.mockResolvedValue({
      ok: false,
      error: { code: 'ref_not_found', message: 'Element ref "e9" no longer exists.' },
      elapsedMs: 3,
    })
    const out = await executeBrowserTool('browser_click', { ref: 'e9' }, ctx())
    expect(out).toMatch(/^Error: \[ref_not_found\]/)
  })

  it('IPC 抛错也回 Error 字符串而不是 reject', async () => {
    ipcStub.agentBrowserCommand.mockRejectedValue(new Error('no handler'))
    const out = await executeBrowserTool('browser_navigate', { url: 'https://a.com' }, ctx())
    expect(out).toMatch(/^Error: browser command failed - no handler/)
  })

  it('畸形结果被识别，不当成成功', async () => {
    ipcStub.agentBrowserCommand.mockResolvedValue({ nonsense: true })
    expect(await executeBrowserTool('browser_navigate', { url: 'https://a.com' }, ctx())).toMatch(/^Error: malformed/)
  })

  it('observe 结果总是带上页面状态', async () => {
    const out = await executeBrowserTool('browser_navigate', { url: 'https://a.com' }, ctx())
    expect(out).toContain('Title: Example')
  })
})

describe('agent browser readiness wait', () => {
  it('guest 未就绪时给出可据以自纠的错误，而不是把 backend_unavailable 丢给模型', async () => {
    ipcStub.agentBrowserReady.mockResolvedValue(false)
    const out = await executeBrowserTool('browser_navigate', { url: 'https://example.com' }, ctx())
    expect(out).toMatch(/^Error: \[backend_unavailable\]/)
    expect(out).toContain('could not be started')
    expect(ipcStub.agentBrowserCommand).not.toHaveBeenCalled()
  }, 20_000)

  it('guest 迟到时能等到并照常执行（面板挂载是异步的，第一条命令常常更早到）', async () => {
    let polls = 0
    ipcStub.agentBrowserReady.mockImplementation(async () => ++polls >= 3)
    const out = await executeBrowserTool('browser_navigate', { url: 'https://example.com' }, ctx())
    expect(polls).toBeGreaterThanOrEqual(3)
    expect(out).toContain('URL: https://example.com/')
    expect(ipcStub.agentBrowserCommand).toHaveBeenCalledOnce()
  }, 20_000)

  it('探询本身抛错（远端 / 旧主进程未注册 handler）时立即放弃，不空等', async () => {
    ipcStub.agentBrowserReady.mockRejectedValue(new Error('no handler'))
    const out = await executeBrowserTool('browser_snapshot', {}, ctx())
    expect(out).toMatch(/^Error: \[backend_unavailable\]/)
    expect(ipcStub.agentBrowserCommand).not.toHaveBeenCalled()
  }, 20_000)

  it('执行前一定先请渲染层打开面板 —— 标签该在 AI 真的动手时出现，而不是开设置开关时', async () => {
    await executeBrowserTool('browser_navigate', { url: 'https://example.com' }, ctx())
    expect(ipcStub.agentBrowserEnsurePanel).toHaveBeenCalledOnce()
    // 顺序也对：先请求开面板，再等 guest 就绪，最后才发命令
    expect(ipcStub.agentBrowserEnsurePanel.mock.invocationCallOrder[0]!).toBeLessThan(ipcStub.agentBrowserCommand.mock.invocationCallOrder[0]!)
  }, 20_000)

  it('ensurePanel 通道不可用时不再空等，直接给出可据以自纠的错误', async () => {
    ipcStub.agentBrowserEnsurePanel.mockRejectedValue(new Error('no handler'))
    const out = await executeBrowserTool('browser_snapshot', {}, ctx())
    expect(out).toMatch(/^Error: \[backend_unavailable\]/)
    expect(ipcStub.agentBrowserCommand).not.toHaveBeenCalled()
  }, 20_000)
})

// ── 截图旁路 ──

describe('browser screenshot side channel', () => {
  it('主进程已落盘 → 渲染层只转手上报引用，绝不自己写文件', async () => {
    const toolCtx = ctx()
    ipcStub.agentBrowserCommand.mockResolvedValue(
      okResult({ imageRef: { path: 'C:\\Users\\tester\\.clerkbox\\tmp\\agent-browser-shot-a.png', mimeType: 'image/png', width: 1280, height: 720 } }),
    )
    const out = await executeBrowserTool('browser_screenshot', {}, toolCtx)
    // 写文件必须发生在主进程：ipc.writeFile 是文本通道，写 base64 会得到假图片
    expect(ipcStub.writeFile).not.toHaveBeenCalled()
    expect(toolCtx.recordImage).toHaveBeenCalledWith({
      path: 'C:\\Users\\tester\\.clerkbox\\tmp\\agent-browser-shot-a.png',
      mimeType: 'image/png',
      width: 1280,
      height: 720,
    })
    expect(out).toContain('Screenshot attached: 1280x720')
  })

  it('没有 recordImage 的上下文（理论上不会发生）不报错，只是没图', async () => {
    ipcStub.agentBrowserCommand.mockResolvedValue(
      okResult({ imageRef: { path: 'C:\\tmp\\a.png', mimeType: 'image/png', width: 1, height: 1 } }),
    )
    const out = await executeBrowserTool('browser_screenshot', {}, { homeDir: HOME })
    expect(out).not.toContain('Screenshot attached')
  })

  it('主进程没给 imageRef 时不伪造一张图（宁可没有，不要错的）', async () => {
    const toolCtx = ctx()
    ipcStub.agentBrowserCommand.mockResolvedValue(okResult())
    const out = await executeBrowserTool('browser_screenshot', {}, toolCtx)
    expect(toolCtx.recordImage).not.toHaveBeenCalled()
    expect(out).not.toContain('Screenshot attached')
  })
})

// ── computer 工具 ──

describe('computer tool execution', () => {
  beforeEach(() => {
    ipcStub.computerUseCommand.mockResolvedValue({
      ok: true,
      screen: { width: 1920, height: 1080, scaleFactor: 1 },
      elapsedMs: 5,
    } satisfies ComputerActionResult)
  })

  it('click_count >= 2 收敛成双击动作，不另造一个工具', async () => {
    await executeComputerTool('computer_click', { x: 10, y: 20, click_count: 2 }, ctx())
    expect(ipcStub.computerUseCommand).toHaveBeenLastCalledWith({ action: 'double_click', x: 10, y: 20 }, undefined)
  })

  it('右键映射到 right_click', async () => {
    await executeComputerTool('computer_click', { x: 1, y: 2, button: 'right' }, ctx())
    expect(ipcStub.computerUseCommand).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'right_click' }), undefined)
  })

  it('scroll 默认三格向下（delta_y 取负，与 wheel 方向一致）', async () => {
    await executeComputerTool('computer_scroll', {}, ctx())
    expect(ipcStub.computerUseCommand).toHaveBeenLastCalledWith({ action: 'scroll', x: undefined, y: undefined, deltaX: undefined, deltaY: -3 }, undefined)
  })

  it('wait 时长被钳到上限，不接受模型给出的天文数字', async () => {
    await executeComputerTool('computer_wait', { duration_ms: 99_999_999 }, ctx())
    expect(ipcStub.computerUseCommand).toHaveBeenLastCalledWith({ action: 'wait', durationMs: 30_000 }, undefined)
  })

  it('type 文本被长度上限截断', async () => {
    await executeComputerTool('computer_type', { text: 'x'.repeat(10_000) }, ctx())
    expect((ipcStub.computerUseCommand.mock.calls[0]![0] as { text: string }).text).toHaveLength(4_000)
  })

  it('app / clipboard 缺参数时本地拒绝', async () => {
    expect(await executeComputerTool('computer_app', { action: 'open' }, ctx())).toMatch(/^Error: /)
    expect(await executeComputerTool('computer_clipboard', { action: 'write' }, ctx())).toMatch(/^Error: /)
  })

  it('结果里带回屏幕尺寸，模型据此判断坐标是否越界', async () => {
    const out = await executeComputerTool('computer_click', { x: 1, y: 1 }, ctx())
    expect(out).toContain('Screen: 1920x1080px')
  })

  it('坐标越界的错误码原样透出', async () => {
    ipcStub.computerUseCommand.mockResolvedValue({
      ok: false,
      error: { code: 'out_of_bounds', message: 'x=5000 is outside the 1920x1080 screen.' },
      elapsedMs: 1,
    })
    expect(await executeComputerTool('computer_click', { x: 5000, y: 1 }, ctx())).toMatch(/^Error: \[out_of_bounds\]/)
  })
})
