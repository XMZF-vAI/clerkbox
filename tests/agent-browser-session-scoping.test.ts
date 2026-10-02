import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWorkbenchStore } from '../src/stores/workbench-store'

/**
 * Agent 浏览器「不跨会话弹出」的回归守卫。
 *
 * 由来：AI 在会话 A 跑浏览器任务时，用户切到会话 B，Agent 浏览器标签会**凭空出现在 B 里**
 * —— 一个跟 B 毫无关系的面板，覆盖了 B 的内容，而真正在干活的 A 反而什么都没有。
 *
 * 成因：工具层请主进程转发「请打开面板」，主进程只发一个不带任何身份的事件，
 * 渲染层收到就往**当前绑定会话**上开。主进程当时无权可问，渲染层也没问 ——
 * 谁在动都没人知道，于是默认落到「用户正在看的那个」。
 *
 * 现在 sessionId 随请求一路带下来，标签只写进那个分片。两条断言锁住：
 *   1. 定向打开不碰当前绑定会话的 visible / tabs；
 *   2. 不往当前视图镜像顶层字段（否则面板会跟着「跳」过来）。
 */

const reset = (): void => {
  useWorkbenchStore.setState({ slices: {}, boundSessionId: null })
}

beforeEach(reset)

describe('openAgentBrowserFor 不跨会话弹出', () => {
  it('只写目标会话的分片，当前会话毫发无损', () => {
    const store = useWorkbenchStore.getState()
    store.bindSession('a')
    useWorkbenchStore.getState().openAgentBrowser()
    // 用户切到 B，B 是空的
    useWorkbenchStore.getState().bindSession('b')
    expect(useWorkbenchStore.getState().tabs).toEqual([])

    // A 的任务继续发命令
    useWorkbenchStore.getState().openAgentBrowserFor('a')

    const state = useWorkbenchStore.getState()
    expect(state.boundSessionId).toBe('b')
    // 当前视图（B）没被污染
    expect(state.tabs).toEqual([])
    expect(state.visible).toBe(false)
    // A 自己那份已经拿到标签
    expect(state.slices['a']!.tabs.some((t) => t.kind === 'agent-browser')).toBe(true)
  })

  it('不往顶层镜像目标分片（镜像会让面板跳到当前视图）', () => {
    useWorkbenchStore.getState().bindSession('b')
    useWorkbenchStore.getState().openAgentBrowserFor('a')

    const state = useWorkbenchStore.getState()
    expect(state.activeTabId).toBeNull()
    expect(state.visible).toBe(false)
  })

  it('目标就是当前会话时，等价于普通 openAgentBrowser（含顶层镜像）', () => {
    useWorkbenchStore.getState().bindSession('a')
    useWorkbenchStore.getState().openAgentBrowserFor('a')

    const state = useWorkbenchStore.getState()
    // 当前会话的顶层镜像必须跟着更新，否则面板不显示
    expect(state.visible).toBe(true)
    expect(state.activeTabId).toBe('agent-browser')
  })

  it('同一会话重复请求不会开出第二个 Agent 浏览器', () => {
    useWorkbenchStore.getState().bindSession('a')
    useWorkbenchStore.getState().openAgentBrowserFor('a')
    useWorkbenchStore.getState().openAgentBrowserFor('a')
    expect(useWorkbenchStore.getState().slices['a']!.tabs).toHaveLength(1)
  })

  it('面板据此能算出「哪些会话的 guest 需要保活」', () => {
    // WorkbenchPanel 就是按这个清单给非当前会话挂载隐藏 webview 的
    const slices = useWorkbenchStore.getState().slices
    useWorkbenchStore.getState().bindSession('a')
    useWorkbenchStore.getState().openAgentBrowser()
    useWorkbenchStore.getState().bindSession('b')
    useWorkbenchStore.getState().openTerminal()
    useWorkbenchStore.getState().bindSession('c')
    useWorkbenchStore.getState().openAgentBrowserFor('c')
    useWorkbenchStore.getState().bindSession('b')

    const alive = Object.entries(useWorkbenchStore.getState().slices)
      .filter(([, slice]) => slice.tabs.some((t) => t.kind === 'agent-browser'))
      .map(([id]) => id)
    expect(alive.sort()).toEqual(['a', 'c'])
    void slices
  })
})

describe('ensurePanel 必须带 sessionId', () => {
  it('工具层把 ctx.sessionId 透到 IPC（缺失就退化成旧 bug）', async () => {
    const { ipcStub } = vi.hoisted(() => ({
      ipcStub: {
        agentBrowserReady: vi.fn(async () => true),
        agentBrowserEnsurePanel: vi.fn(async () => true),
        agentBrowserCommand: vi.fn(async () => ({ ok: true })),
        writeFile: vi.fn(),
      },
    }))
    vi.doMock('../src/lib/ipc-client', () => ({ ipc: ipcStub }))

    const { executeBrowserTool } = await import('../src/lib/browser-tools')
    await executeBrowserTool(
      'browser_navigate',
      { url: 'https://example.com' },
      { sessionId: 'session-a', homeDir: 'C:\\tmp' },
    )
    expect(ipcStub.agentBrowserEnsurePanel).toHaveBeenCalledWith('session-a')
    vi.doUnmock('../src/lib/ipc-client')
  })
})