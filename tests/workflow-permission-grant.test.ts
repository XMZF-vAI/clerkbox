/**
 * 工作流确认的「本会话始终允许」必须真的生效。
 *
 * 曾经的 bug：卡片上给了这个选项，`checkToolPermission` 却把返回的 scope 丢掉，
 * 于是每轮都弹——用户点了等于没点。而脚本每轮都会被模型重写，按脚本指纹记放行
 * 同样等于每次都问，所以放行的粒度是**会话**，不是脚本内容。
 */
import { describe, expect, it } from 'vitest'
import { checkToolPermission } from '../src/agent-core/loop'
import { SessionContext } from '../src/agent-core/session-context'
import type { AgentPermissionRequest, AgentPorts, PermissionApproval } from '../src/agent-core/ports'

function makePorts(approvals: PermissionApproval[]) {
  const calls: AgentPermissionRequest[] = []
  let index = 0
  const next = async (request: AgentPermissionRequest): Promise<PermissionApproval> => {
    calls.push(request)
    return approvals[Math.min(index++, approvals.length - 1)] ?? { approved: false, scope: 'once' }
  }
  const ports = {
    sessionId: 'sess-workflow',
    settings: { approvalMode: 'manual' },
    store: { getSession: () => undefined },
    permission: { confirm: next, confirmInChat: next },
  } as unknown as AgentPorts
  return { ports, calls }
}

const scriptA = `phase('读取')\nawait agent('甲', '读 A')\n`
const scriptB = `phase('读取')\nawait agent('乙', '读 B，完全不同的脚本')\n`

describe('工作流确认的会话级放行', () => {
  it('选「本会话始终允许」后，下一次（脚本不同）直接放行，不再弹卡', async () => {
    const ctx = new SessionContext('sess-workflow')
    const { ports, calls } = makePorts([{ approved: true, scope: 'session' }])

    const first = await checkToolPermission(ports, ctx, 'create_workflow', { name: '甲流程', script: scriptA })
    expect(first.allowed).toBe(true)
    expect(calls).toHaveLength(1)
    expect(ctx.workflowApproved).toBe(true)

    const second = await checkToolPermission(ports, ctx, 'create_workflow', { name: '乙流程', script: scriptB })
    expect(second.allowed).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('只选「仅允许这一次」时不记会话放行，下一轮仍然问', async () => {
    const ctx = new SessionContext('sess-workflow')
    const { ports, calls } = makePorts([{ approved: true, scope: 'once' }, { approved: true, scope: 'once' }])

    await checkToolPermission(ports, ctx, 'create_workflow', { name: '甲流程', script: scriptA })
    expect(ctx.workflowApproved).toBe(false)
    await checkToolPermission(ports, ctx, 'create_workflow', { name: '乙流程', script: scriptB })
    expect(calls).toHaveLength(2)
  })

  it('拒绝时本轮不放行，也不记会话放行', async () => {
    const ctx = new SessionContext('sess-workflow')
    const { ports } = makePorts([{ approved: false, scope: 'once' }])

    const result = await checkToolPermission(ports, ctx, 'create_workflow', { name: '甲流程', script: scriptA })
    expect(result.allowed).toBe(false)
    expect(ctx.workflowApproved).toBe(false)
  })

  it('放行只作用于本会话：另一个会话仍要确认', async () => {
    const a = new SessionContext('sess-a')
    const b = new SessionContext('sess-b')
    const { ports, calls } = makePorts([{ approved: true, scope: 'session' }, { approved: true, scope: 'once' }])

    await checkToolPermission(ports, a, 'create_workflow', { name: '甲', script: scriptA })
    await checkToolPermission(ports, b, 'create_workflow', { name: '乙', script: scriptB })
    expect(calls).toHaveLength(2)
  })

  it('完全访问档位不问也不弹', async () => {
    const ctx = new SessionContext('sess-workflow')
    const { ports, calls } = makePorts([{ approved: true, scope: 'once' }])
    ;(ports.settings as { approvalMode: string }).approvalMode = 'full'

    const result = await checkToolPermission(ports, ctx, 'create_workflow', { name: '甲', script: scriptA })
    expect(result.allowed).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
