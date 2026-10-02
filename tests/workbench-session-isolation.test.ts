import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkbenchStore } from '../src/stores/workbench-store'

/**
 * 工作台按会话隔离的回归守卫。
 *
 * 由来：工作台状态曾经是**全局单例**（一份 tabs / activeTabId / visible），
 * 于是切到新对话时上一个对话的浏览器标签、终端、甚至 Agent 浏览器全都还在 ——
 * 尤其糟糕的是 Agent 浏览器：它是「AI 正在操控浏览器」这件事的视觉载体，
 * 跨对话残留意味着你在新对话里看到的是上一个任务留下的现场。
 *
 * 这里锁三件事：
 *   1. 每个会话各有一份分片，切走再切回能恢复自己那份（不是清空）；
 *   2. 一个会话里开的标签不会漏到另一个会话；
 *   3. `openAgentBrowser` 仍然只开一个（主进程按分区捕获 guest，多开会抢同一个分区）。
 *
 * store 直接在 node 环境里操作，不需要 React —— 它是纯 zustand。
 */

const reset = (): void => {
  useWorkbenchStore.setState({ slices: {}, boundSessionId: null })
}

beforeEach(reset)

describe('per-session workbench slices', () => {
  it('两个会话各有一份分片，互不污染', () => {
    const store = useWorkbenchStore.getState()
    store.bindSession('s1')
    useWorkbenchStore.getState().openBrowser('https://a.com')
    useWorkbenchStore.getState().openTerminal()

    store.bindSession('s2')
    // s2 是干净的：不该看到 s1 的浏览器与终端
    expect(useWorkbenchStore.getState().tabs).toEqual([])
    expect(useWorkbenchStore.getState().visible).toBe(false)

    useWorkbenchStore.getState().openBrowser('https://b.com')
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1)
    expect(useWorkbenchStore.getState().tabs[0]!.url).toBe('https://b.com')
  })

  it('切回旧会话恢复它自己那份分片', () => {
    useWorkbenchStore.getState().bindSession('s1')
    useWorkbenchStore.getState().openBrowser('https://a.com')
    useWorkbenchStore.getState().bindSession('s2')
    useWorkbenchStore.getState().openTerminal()
    useWorkbenchStore.getState().bindSession('s1')

    const restored = useWorkbenchStore.getState().tabs
    expect(restored).toHaveLength(1)
    expect(restored[0]!.kind).toBe('browser')
    expect(restored[0]!.url).toBe('https://a.com')
  })

  it('标签 id 在分片内唯一即可（不同会话可以各有 browser-1）', () => {
    useWorkbenchStore.getState().bindSession('s1')
    useWorkbenchStore.getState().openBrowser()
    useWorkbenchStore.getState().bindSession('s2')
    useWorkbenchStore.getState().openBrowser()
    const s1 = useWorkbenchStore.getState().slices['s1']!
    const s2 = useWorkbenchStore.getState().slices['s2']!
    expect(s1.tabs[0]!.id).toBe(s2.tabs[0]!.id)
    // 但它们是两个独立分片里的两个独立标签
    expect(s1.tabs).not.toBe(s2.tabs)
  })

  it('终端序号也按会话各自递增', () => {
    useWorkbenchStore.getState().bindSession('s1')
    useWorkbenchStore.getState().openTerminal()
    useWorkbenchStore.getState().openTerminal()
    expect(useWorkbenchStore.getState().tabs).toHaveLength(2)
    useWorkbenchStore.getState().bindSession('s2')
    useWorkbenchStore.getState().openTerminal()
    expect(useWorkbenchStore.getState().tabs).toHaveLength(1)
  })

  it('宽度是窗口级偏好，全局共享（切会话不该重置用户调好的宽度）', () => {
    // 走 setState 而非 setWidth：后者要读 window.innerWidth 算上限，node 环境没有 window。
    // 这里要验的是「宽度不属于任何分片」这件事，与上限算法无关
    useWorkbenchStore.setState({ width: 600 })
    useWorkbenchStore.getState().bindSession('s2')
    expect(useWorkbenchStore.getState().width).toBe(600)
    expect(useWorkbenchStore.getState().slices['s2']).toBeUndefined()
  })

  it('Agent 浏览器在同一会话里只有一个实例', () => {
    useWorkbenchStore.getState().bindSession('s1')
    useWorkbenchStore.getState().openAgentBrowser()
    useWorkbenchStore.getState().openAgentBrowser()
    const agentTabs = useWorkbenchStore.getState().tabs.filter((t) => t.kind === 'agent-browser')
    expect(agentTabs).toHaveLength(1)
    // 主进程按分区捕获 guest，多开一个就多一个抢同一个分区
  })

  it('关掉 Agent 浏览器标签会清空呼吸窗口（下次重开不该继承「正在操作」）', () => {
    useWorkbenchStore.getState().bindSession('s1')
    useWorkbenchStore.getState().openAgentBrowser()
    useWorkbenchStore.getState().markAgentBrowserOperation()
    expect(useWorkbenchStore.getState().agentBrowserOperationUntil).toBeGreaterThan(0)
    useWorkbenchStore.getState().closeTab('agent-browser')
    expect(useWorkbenchStore.getState().agentBrowserOperationUntil).toBe(0)
    expect(useWorkbenchStore.getState().tabs.some((t) => t.kind === 'agent-browser')).toBe(false)
  })

  it('activateTab 只切激活态，不会误开不存在的标签', () => {
    useWorkbenchStore.getState().bindSession('s1')
    useWorkbenchStore.getState().openBrowser()
    const id = useWorkbenchStore.getState().activeTabId!
    useWorkbenchStore.getState().activateTab('nope')
    expect(useWorkbenchStore.getState().activeTabId).toBe(id)
    useWorkbenchStore.getState().openTerminal()
    const terminalId = useWorkbenchStore.getState().activeTabId!
    useWorkbenchStore.getState().activateTab(id)
    expect(useWorkbenchStore.getState().activeTabId).toBe(id)
    expect(terminalId).not.toBe(id)
  })

  it('切分片不会把面板的展开状态带过去', () => {
    useWorkbenchStore.getState().bindSession('s1')
    useWorkbenchStore.getState().toggleVisible()
    expect(useWorkbenchStore.getState().visible).toBe(true)
    useWorkbenchStore.getState().bindSession('s2')
    expect(useWorkbenchStore.getState().visible).toBe(false)
  })
})
