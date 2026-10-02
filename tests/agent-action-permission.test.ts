import { describe, it, expect } from 'vitest'
import {
  buildPermissionPreview,
  findPendingApprovalCall,
  isAgentActionGated,
  isApprovalGatedTool,
  parseMcpToolName,
  parsePermissionAudit,
  formatPermissionAuditContent,
  type PermissionPreview,
} from '../src/lib/permission-preview'
import { agentActionFamily, isAgentActionToolReadOnly, isBrowserCommand, isComputerAction } from '../src/lib/agent-actions'
import type { Message } from '../src/types/agent'

describe('agent action gating', () => {
  it('只读动作不打断用户，写动作要', () => {
    expect(isAgentActionGated('browser_snapshot', {})).toBe(false)
    expect(isAgentActionGated('browser_screenshot', {})).toBe(false)
    expect(isAgentActionGated('browser_evaluate', {})).toBe(false)
    expect(isAgentActionGated('computer_screenshot', {})).toBe(false)
    expect(isAgentActionGated('computer_wait', {})).toBe(false)
    expect(isAgentActionGated('browser_click', { ref: 'e1' })).toBe(true)
    expect(isAgentActionGated('computer_type', { text: 'x' })).toBe(true)
  })

  it('纯导航只读 —— 导航只换掉 Agent 浏览器自己那一页，没有用户可见的持久副作用', () => {
    expect(isAgentActionGated('browser_navigate', { action: 'back' })).toBe(false)
    expect(isAgentActionGated('browser_navigate', { action: 'forward' })).toBe(false)
    expect(isAgentActionGated('browser_navigate', { action: 'reload' })).toBe(false)
    // 打开新页面同样放行：模型本来就有 web_fetch 能发请求，
    // 再为「在自己的隔离浏览器里看一眼」弹一次纯属自伤。真正要拦的是交互。
    expect(isAgentActionGated('browser_navigate', { action: 'navigate', url: 'https://a.com' })).toBe(false)
    // 不给 action 时默认按 navigate 处理
    expect(isAgentActionGated('browser_navigate', { url: 'https://a.com' })).toBe(false)
  })

  it('列应用只读，启动应用不是', () => {
    expect(isAgentActionGated('computer_app', { action: 'list' })).toBe(false)
    expect(isAgentActionGated('computer_app', { action: 'open', name: 'notepad' })).toBe(true)
    expect(isAgentActionGated('computer_clipboard', { action: 'read' })).toBe(false)
    expect(isAgentActionGated('computer_clipboard', { action: 'write', text: 'x' })).toBe(true)
  })

  it('非 Agent 动作工具不经这条门', () => {
    expect(isAgentActionGated('read_file', {})).toBe(false)
    expect(isAgentActionGated('execute_command', { command: 'ls' })).toBe(false)
  })

  it('与动作级判定口径一致（工具层与权限层不许各判各的）', () => {
    expect(isAgentActionToolReadOnly('browser_snapshot', {})).toBe(true)
    expect(isAgentActionToolReadOnly('browser_navigate', { action: 'back' })).toBe(true)
    expect(isAgentActionToolReadOnly('browser_navigate', { url: 'https://a.com' })).toBe(true)
    expect(isAgentActionToolReadOnly('browser_click', { ref: 'e1' })).toBe(false)
    expect(isAgentActionToolReadOnly('computer_app', { action: 'open' })).toBe(false)
  })
})

describe('agent action permission preview', () => {
  it('browser 动作给 dangerous 风险 + 对应说明', () => {
    const preview = buildPermissionPreview('browser_click', { ref: 'e12' })
    expect(preview.kind).toBe('browser')
    expect(preview.risk).toBe('dangerous')
    expect(preview.reasonKeys).toEqual(['chat.permission.reasonBrowserUse'])
    expect(preview.monospace).toContain('ref: e12')
  })

  it('computer 动作的风险说明与 browser 区分开', () => {
    const preview = buildPermissionPreview('computer_click', { x: 820, y: 441 })
    expect(preview.kind).toBe('computer')
    expect(preview.reasonKeys).toEqual(['chat.permission.reasonComputerUse'])
    // 坐标是这张卡上唯一重要的事，必须顶在最前面
    expect(preview.monospace.split('\n')[0]).toBe('at: (820, 441)')
  })

  it('拖拽一行写全起止点', () => {
    const preview = buildPermissionPreview('computer_drag', { from_x: 10, from_y: 20, to_x: 30, to_y: 40 })
    expect(preview.monospace).toContain('(10, 20) → (30, 40)')
  })

  it('长文本被截断并标注原长度（整段贴进卡片会把坐标挤没）', () => {
    const preview = buildPermissionPreview('computer_type', { text: 'x'.repeat(400) })
    expect(preview.monospace).toContain('400 chars')
    expect(preview.monospace.length).toBeLessThan(200)
  })

  it('会话放行键按「族 + 动作」归并：同坐标连点两次能命中放行，不同动作不能', () => {
    const first = buildPermissionPreview('computer_click', { x: 100, y: 200 })
    const sameAgain = buildPermissionPreview('computer_click', { x: 999, y: 888 })
    const other = buildPermissionPreview('computer_type', { text: 'hello' })
    expect(first.grantKey).toBe(sameAgain.grantKey)
    expect(first.grantKey).not.toBe(other.grantKey)
  })

  it('组合键的放行键保留主键：Shift+s 与 Shift+a 风险不同，不能归成同一种', () => {
    const save = buildPermissionPreview('computer_key', { key: 'Shift+s' })
    const selectAll = buildPermissionPreview('computer_key', { key: 'Shift+a' })
    expect(save.grantKey).not.toBe(selectAll.grantKey)
    // 完全相同的组合键要能命中已有放行
    const saveAgain = buildPermissionPreview('computer_key', { key: 'Shift+s' })
    expect(save.grantKey).toBe(saveAgain.grantKey)
  })

  it('非 Agent 工具的判定与既有行为一致（不被 Agent 分支截胡）', () => {
    const cmd = buildPermissionPreview('execute_command', { command: 'rm -rf /' })
    expect(cmd.kind).toBe('command')
    expect(cmd.risk).toBe('dangerous')
    // write_file 走 file 分支（Agent 分支插在 mcp 之后、generic 之前）
    expect(buildPermissionPreview('write_file', { path: 'a.txt' }).kind).toBe('file')
    // read_file 不在任何写分支里，落 generic 是既有行为，这里只锁住它没被 Agent 分支改道
    expect(buildPermissionPreview('read_file', { path: 'a.txt' }).kind).toBe('generic')
  })

  it('isApprovalGatedTool 覆盖 Agent 写动作，不覆盖读动作', () => {
    expect(isApprovalGatedTool('computer_click')).toBe(true)
    expect(isApprovalGatedTool('computer_screenshot')).toBe(false)
  })
})

describe('pending approval detection with agent actions', () => {
  const messages: Message[] = [
    {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: 0,
      toolCalls: [{ id: 'c1', name: 'computer_screenshot', arguments: {} }],
    },
  ]

  it('只读 Agent 调用不会被误判为待审（否则每张截图都弹一次审批）', () => {
    expect(findPendingApprovalCall(messages)).toBeNull()
  })

  it('写调用会被定位出来，并带回原始入参', () => {
    const withClick: Message[] = [
      ...messages,
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        timestamp: 0,
        toolCalls: [{ id: 'c2', name: 'computer_click', arguments: { x: 1, y: 2 } }],
      },
    ]
    expect(findPendingApprovalCall(withClick)).toEqual({
      toolCallId: 'c2',
      tool: 'computer_click',
      args: { x: 1, y: 2 },
    })
  })

  it('已收尾的调用不再算待审', () => {
    const settled: Message[] = [
      {
        ...messages[0]!,
        toolResults: [{ toolCallId: 'c1', content: 'ok' }],
      },
    ]
    expect(findPendingApprovalCall(settled)).toBeNull()
  })
})

describe('permission audit codec', () => {
  it('往返编解码保留全部字段', () => {
    const record = { decision: 'allow_session' as const, tool: 'computer_click', target: 'at: (1, 2)', risk: 'dangerous' as const, at: 1700000000000 }
    const decoded = parsePermissionAudit(formatPermissionAuditContent(record))
    expect(decoded).toEqual(record)
  })

  it('非留痕内容返回 null', () => {
    expect(parsePermissionAudit('just a message')).toBeNull()
  })

  it('载荷损坏时返回 null 而不是半截对象', () => {
    expect(parsePermissionAudit('__PERMISSION_AUDIT__{"decision":"nope"}')).toBeNull()
    expect(parsePermissionAudit('__PERMISSION_AUDIT__not json')).toBeNull()
  })
})

describe('legacy helpers still work', () => {
  it('MCP 工具名拆解', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' })
    expect(parseMcpToolName('read_file')).toBeNull()
  })

  it('action family 判定', () => {
    expect(agentActionFamily('browser_snapshot')).toBe('browser')
    expect(agentActionFamily('computer_wait')).toBe('computer')
    expect(agentActionFamily('web_fetch')).toBeNull()
  })
})

describe('IPC payload validation (whitelist, not blacklist)', () => {
  it('拒绝未知方法名', () => {
    expect(isBrowserCommand({ method: 'evalArbitraryCdp' })).toBe(false)
    expect(isBrowserCommand({ method: 'constructor' })).toBe(false)
    expect(isBrowserCommand(null)).toBe(false)
    expect(isBrowserCommand('navigate')).toBe(false)
  })

  it('navigate 必须带字符串 url', () => {
    expect(isBrowserCommand({ method: 'navigate', url: 'https://a.com' })).toBe(true)
    expect(isBrowserCommand({ method: 'navigate' })).toBe(false)
    expect(isBrowserCommand({ method: 'navigate', url: 42 })).toBe(false)
  })

  it('click 的 target 必须是 ref 或完整的坐标对', () => {
    expect(isBrowserCommand({ method: 'click', target: { type: 'ref', ref: 'e1' } })).toBe(true)
    expect(isBrowserCommand({ method: 'click', target: { type: 'coordinate', x: 1, y: 2 } })).toBe(true)
    // 只有 x 没有 y：静默补 0 会点在屏幕边缘，危险
    expect(isBrowserCommand({ method: 'click', target: { type: 'coordinate', x: 1 } })).toBe(false)
    expect(isBrowserCommand({ method: 'click', target: { type: 'selector', value: '#a' } })).toBe(false)
    expect(isBrowserCommand({ method: 'click' })).toBe(false)
  })

  it('computer 动作的必填参数被逐一校验', () => {
    expect(isComputerAction({ action: 'left_click', x: 1, y: 2 })).toBe(true)
    expect(isComputerAction({ action: 'left_click', x: 1 })).toBe(false)
    expect(isComputerAction({ action: 'type' })).toBe(false)
    expect(isComputerAction({ action: 'type', text: 'hi' })).toBe(true)
    expect(isComputerAction({ action: 'key', key: 'Enter' })).toBe(true)
    expect(isComputerAction({ action: 'open_application' })).toBe(false)
    expect(isComputerAction({ action: 'rm_rf', x: 1, y: 1 })).toBe(false)
  })

  it('NaN / Infinity 不被当作合法坐标', () => {
    expect(isComputerAction({ action: 'left_click', x: Number.NaN, y: 1 })).toBe(false)
    expect(isComputerAction({ action: 'left_click', x: Number.POSITIVE_INFINITY, y: 1 })).toBe(false)
  })
})

describe('preview shape stability', () => {
  it('Agent 预览不带 serverName（否则 UI 会把它当 MCP 卡片渲染）', () => {
    const preview: PermissionPreview = buildPermissionPreview('browser_click', { ref: 'e1' })
    expect(preview.serverName).toBeUndefined()
  })
})
