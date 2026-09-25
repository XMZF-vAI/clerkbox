import { describe, it, expect } from 'vitest'
import {
  buildPermissionPreview,
  findPendingApprovalCall,
  formatPermissionAuditContent,
  parseMcpToolName,
  parsePermissionAudit,
  isApprovalGatedTool,
} from '../src/lib/permission-preview'
import type { Message } from '../src/types/agent'

const WD = 'C:\\work\\proj'

const msg = (partial: Partial<Message> & { id: string; role: Message['role'] }): Message =>
  ({ content: '', timestamp: 0, ...partial }) as Message

describe('buildPermissionPreview', () => {
  it('危险命令 → dangerous 并给出高危理由', () => {
    const p = buildPermissionPreview('execute_command', { command: 'rm -rf /' }, { workingDir: WD })
    expect(p.kind).toBe('command')
    expect(p.risk).toBe('dangerous')
    expect(p.reasonKeys).toContain('chat.permission.reasonDangerousCommand')
    expect(p.monospace).toBe('rm -rf /')
    expect(p.truncated).toBe(false)
  })

  it('常规命令 → info 且无风险提示', () => {
    const p = buildPermissionPreview('execute_command', { command: 'npm run build' }, { workingDir: WD })
    expect(p.risk).toBe('info')
    expect(p.reasonKeys).toEqual([])
  })

  it('命令 cwd 越出工作目录 → warning + 目录外理由', () => {
    const p = buildPermissionPreview(
      'execute_command',
      { command: 'dir', cwd: 'C:\\Windows\\Temp' },
      { workingDir: WD }
    )
    expect(p.risk).toBe('warning')
    expect(p.reasonKeys).toContain('chat.permission.reasonOutsideWorkDir')
  })

  it('命令 cwd 在工作目录内（相对路径）→ 不报目录外', () => {
    const p = buildPermissionPreview('execute_command', { command: 'dir', cwd: 'src' }, { workingDir: WD })
    expect(p.reasonKeys).toEqual([])
  })

  it('缺少工作目录时跳过目录外判定，不误报风险', () => {
    const p = buildPermissionPreview('execute_command', { command: 'dir', cwd: 'D:\\other' })
    expect(p.risk).toBe('info')
    expect(p.reasonKeys).toEqual([])
  })

  it('写入系统目录 → dangerous + 系统路径理由', () => {
    const p = buildPermissionPreview('write_file', { path: 'C:\\Windows\\System32\\x.txt', content: 'a' })
    expect(p.kind).toBe('file')
    expect(p.risk).toBe('dangerous')
    expect(p.reasonKeys).toContain('chat.permission.reasonSystemPath')
    expect(p.monospace).toContain('x.txt')
  })

  it('写入工作目录内文件 → info', () => {
    const p = buildPermissionPreview('write_file', { path: 'src/a.ts', content: 'a' }, { workingDir: WD })
    expect(p.risk).toBe('info')
    expect(p.reasonKeys).toEqual([])
  })

  it('批量编辑在等宽区追加编辑条数', () => {
    const p = buildPermissionPreview(
      'search_replace',
      { path: 'src/a.ts', edits: [{ old_str: 'a', new_str: 'b' }, { old_str: 'c', new_str: 'd' }] },
      { workingDir: WD }
    )
    expect(p.monospace).toContain('× 2 处编辑')
  })

  it('超长命令截断并标记 truncated', () => {
    const long = 'echo ' + 'x'.repeat(5000)
    const p = buildPermissionPreview('execute_command', { command: long })
    expect(p.truncated).toBe(true)
    expect(p.monospace.length).toBeLessThanOrEqual(4000)
    expect(p.target).toBe(long)
  })

  it('web_fetch → network 且等宽区是 URL', () => {
    const p = buildPermissionPreview('web_fetch', { url: 'https://example.com/a' })
    expect(p.kind).toBe('network')
    expect(p.monospace).toBe('https://example.com/a')
  })

  it('未知工具 → generic 且等宽区是参数 JSON', () => {
    const p = buildPermissionPreview('custom_tool', { foo: 'bar' })
    expect(p.kind).toBe('generic')
    expect(p.risk).toBe('info')
    expect(JSON.parse(p.monospace)).toEqual({ foo: 'bar' })
  })

  it('grantKey 对同一命令稳定、对不同目标可变', () => {
    const a = buildPermissionPreview('execute_command', { command: 'git status' })
    const b = buildPermissionPreview('execute_command', { command: 'git status' })
    const c = buildPermissionPreview('execute_command', { command: 'git push' })
    expect(a.grantKey).toBe(b.grantKey)
    expect(a.grantKey).not.toBe(c.grantKey)
  })
})

describe('MCP 工具名解析与门控判定', () => {
  it('mcp__<server>__<tool> 拆出服务器名并归为 mcp 预览', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' })
    const p = buildPermissionPreview('mcp__github__create_issue', { title: 'x' })
    expect(p.kind).toBe('mcp')
    expect(p.serverName).toBe('github')
    expect(p.target).toBe('github · create_issue')
  })

  it('非 MCP 名返回 null，门控只覆盖命令与写入类', () => {
    expect(parseMcpToolName('read_file')).toBeNull()
    expect(isApprovalGatedTool('execute_command')).toBe(true)
    expect(isApprovalGatedTool('mcp__x__y')).toBe(true)
    expect(isApprovalGatedTool('read_file')).toBe(false)
  })
})

describe('findPendingApprovalCall', () => {
  const callOf = (id: string, name: string, args: Record<string, unknown> = {}) => ({
    id,
    name,
    arguments: args,
  })

  it('无消息 / 无工具调用 → null', () => {
    expect(findPendingApprovalCall([])).toBeNull()
    expect(findPendingApprovalCall([msg({ id: 'u1', role: 'user', content: 'hi' })])).toBeNull()
  })

  it('门控调用尚无结果 → 返回该调用', () => {
    const messages = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1', role: 'assistant', toolCalls: [callOf('c1', 'execute_command', { command: 'rm -rf /' })] }),
    ]
    expect(findPendingApprovalCall(messages)).toEqual({
      toolCallId: 'c1',
      tool: 'execute_command',
      args: { command: 'rm -rf /' },
    })
  })

  it('结果挂在同一条 assistant 消息的 toolResults 上 → 视为已完成', () => {
    const messages = [
      msg({
        id: 'a1',
        role: 'assistant',
        toolCalls: [callOf('c1', 'execute_command', { command: 'ls' })],
        toolResults: [{ toolCallId: 'c1', content: 'ok' }],
      }),
    ]
    expect(findPendingApprovalCall(messages)).toBeNull()
  })

  it('结果落在独立的 tool 消息里 → 同样视为已完成', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant', toolCalls: [callOf('c1', 'write_file', { path: 'a.ts' })] }),
      msg({ id: 't1', role: 'tool', toolResults: [{ toolCallId: 'c1', content: 'done' }] }),
    ]
    expect(findPendingApprovalCall(messages)).toBeNull()
  })

  it('非门控工具（read_file）待返回不出卡片', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant', toolCalls: [callOf('c1', 'read_file', { path: 'a.ts' })] }),
    ]
    expect(findPendingApprovalCall(messages)).toBeNull()
  })

  it('多调用混合：只报告尚未完成的门控调用', () => {
    const messages = [
      msg({
        id: 'a1',
        role: 'assistant',
        toolCalls: [
          callOf('c1', 'read_file', { path: 'a.ts' }),
          callOf('c2', 'execute_command', { command: 'shutdown /s' }),
        ],
        toolResults: [{ toolCallId: 'c1', content: 'data' }],
      }),
    ]
    expect(findPendingApprovalCall(messages)?.toolCallId).toBe('c2')
  })

  it('只看最后一条含工具调用的助手消息（更早的调用必然已收尾）', () => {
    const messages = [
      msg({ id: 'a1', role: 'assistant', toolCalls: [callOf('c1', 'execute_command', { command: 'a' })] }),
      msg({ id: 't1', role: 'tool', toolResults: [{ toolCallId: 'c1', content: 'done' }] }),
      msg({ id: 'a2', role: 'assistant', content: '完成了' }),
    ]
    expect(findPendingApprovalCall(messages)).toBeNull()
  })
})

describe('审批留痕编解码', () => {
  it('编解码往返一致', () => {
    const record = { decision: 'allow_session' as const, tool: 'execute_command', target: 'rm -rf /', risk: 'dangerous' as const, at: 1700000000000 }
    const content = formatPermissionAuditContent(record)
    expect(content.startsWith('__PERMISSION_AUDIT__')).toBe(true)
    expect(parsePermissionAudit(content)).toEqual(record)
  })

  it('普通消息正文解析为 null', () => {
    expect(parsePermissionAudit('正常回复内容')).toBeNull()
    expect(parsePermissionAudit('__PERMISSION_AUDIT__{损坏的 json')).toBeNull()
  })
})
