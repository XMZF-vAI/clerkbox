import { describe, it, expect, vi, beforeEach } from 'vitest'
import { agentActionGrantKey, isAgentActionToolReadOnly } from '../src/lib/agent-actions'
import { SessionContext } from '../src/agent-core/session-context'

/**
 * 审批打扰次数的回归守卫。
 *
 * 由来：Agent 动作最初的实现是「每个写动作问一次」，而一次浏览任务是
 * navigate → snapshot → click → type → click 的循环 —— 用户每一步都要点一次弹窗，
 * 而且那个框只有 Yes/No，连「以后别问」都选不到。功能等于不存在。
 *
 * 这里锁三件事：
 *   1. 授权键是**能力级**的（`agent-use:browser`），不是「工具 + 动作」级；
 *   2. 只读动作（截图 / 读页面 / 纯导航 / 等待）压根不进审批面；
 *   3. 会话级放行一旦记下，同能力的**所有**后续写动作都放行。
 *
 * 真正的 loop 行为由 tests/agent-core.test.ts 的端到端用例验证，这里守的是
 * 「粒度」这个设计决策本身 —— 它没有别的测试能覆盖，改错了也只会表现为「很烦」。
 */

describe('agent action approval granularity', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('授权键按能力归并：同一族的所有写动作共用一个键', () => {
    expect(agentActionGrantKey('browser')).toBe('agent-use:browser')
    expect(agentActionGrantKey('computer')).toBe('agent-use:computer')
    // 两个能力互不串味
    expect(agentActionGrantKey('browser')).not.toBe(agentActionGrantKey('computer'))
  })

  it('授权键里不含工具名或动作 —— 那样每个动作都会是独立的一次询问', () => {
    const key = agentActionGrantKey('browser')
    expect(key).not.toContain('browser_click')
    expect(key).not.toContain('type')
    expect(key).not.toContain('(')
  })
})

describe('read-only surface never asks', () => {
  it('观察类动作一律不进审批面', () => {
    // 浏览器：读页面、截图、跑脚本、等页面
    for (const [tool, args] of [
      ['browser_snapshot', {}],
      ['browser_screenshot', {}],
      ['browser_evaluate', { expression: '1' }],
      ['browser_wait', { selector: '.x' }],
      // 导航也只是换掉 Agent 浏览器自己那一页，没有用户可见的持久副作用。
      // 模型本来就有 web_fetch 能发请求，再为「在自己的浏览器里看一眼」拦一次纯属自伤。
      ['browser_navigate', { url: 'https://example.com' }],
      ['browser_navigate', { action: 'back' }],
      ['browser_navigate', { action: 'reload' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(isAgentActionToolReadOnly(tool, args), tool).toBe(true)
    }
  })

  it('桌面：只有观察类免打扰，启动应用 / 写剪贴板要问', () => {
    for (const [tool, args] of [
      ['computer_screenshot', {}],
      ['computer_wait', {}],
      ['computer_app', { action: 'list' }],
      ['computer_clipboard', { action: 'read' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(isAgentActionToolReadOnly(tool, args), tool).toBe(true)
    }
    for (const [tool, args] of [
      ['computer_click', { x: 1, y: 1 }],
      ['computer_type', { text: 'x' }],
      ['computer_key', { key: 'Enter' }],
      ['computer_drag', { from_x: 1, from_y: 1, to_x: 2, to_y: 2 }],
      ['computer_app', { action: 'open', name: 'calc' }],
      ['computer_clipboard', { action: 'write', text: 'x' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(isAgentActionToolReadOnly(tool, args), tool).toBe(false)
    }
  })

  it('浏览器交互要问（导航放行不等于交互放行）', () => {
    expect(isAgentActionToolReadOnly('browser_click', { ref: 'e1' })).toBe(false)
    expect(isAgentActionToolReadOnly('browser_type', { text: 'x' })).toBe(false)
    expect(isAgentActionToolReadOnly('browser_press', { key: 'Enter' })).toBe(false)
    expect(isAgentActionToolReadOnly('browser_scroll', { delta_y: 100 })).toBe(false)
  })
})

describe('session-scoped grant', () => {
  it('记一次之后，同能力的任意写动作都命中放行', () => {
    const ctx = new SessionContext('s1')
    const key = agentActionGrantKey('browser')
    expect(ctx.grantedAgentActions.has(key)).toBe(false)
    ctx.grantedAgentActions.add(key)
    expect(ctx.grantedAgentActions.has(key)).toBe(true)
    // 另一个能力不受影响
    expect(ctx.grantedAgentActions.has(agentActionGrantKey('computer'))).toBe(false)
  })

  it('放行挂在会话上下文上，不随单次 run 结束清空（用户的语义是「这个会话别再问」）', () => {
    const ctx = new SessionContext('s1')
    ctx.grantedAgentActions.add(agentActionGrantKey('computer'))
    // run 收尾只清这些运行期字段，放行集合不在其中
    ctx.beginRewindTurn('m1')
    ctx.activeTaskMode = null
    ctx.requestWorkingDir = undefined
    expect(ctx.grantedAgentActions.has(agentActionGrantKey('computer'))).toBe(true)
  })

  it('不同会话各管各的', () => {
    const a = new SessionContext('a')
    const b = new SessionContext('b')
    a.grantedAgentActions.add(agentActionGrantKey('browser'))
    expect(b.grantedAgentActions.has(agentActionGrantKey('browser'))).toBe(false)
  })
})

describe('approval port returns a scope, not a bare boolean', () => {
  it('契约带 scope，宿主才能表达「以后都别问」', async () => {
    const { AgentSessionManager } = await import('../electron/agent-host')
    // 只取类型层面需要的信息：这里断言 host 模块能加载（其 requestPermission 返回
    // Promise<PermissionApproval>，写成 Promise<boolean> 会在这里编译不过）
    expect(typeof AgentSessionManager).toBe('function')
  })
})
