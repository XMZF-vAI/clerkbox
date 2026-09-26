/**
 * 宿主审批事件在渲染层的落点（C2 阶段二的界面半边）。
 * 三种投递来源（实时、缺口补发、F5 整环回放）必须长出同一张卡片，且只有一张。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyAgentEvent } from '../src/lib/agent-event-apply'
import { planAgentEvent } from '../src/lib/agent-reducer'
import { useChatStore } from '../src/stores/chat-store'
import { usePermissionStore } from '../src/stores/permission-store'
import type { AgentEvent } from '../src/agent-core/protocol'

const sid = 'sess-perm'

const rich: AgentEvent = {
  type: 'permission.requested',
  sessionId: sid,
  requestId: 'r1',
  preview: '将执行 rm -rf /tmp/x',
  risk: 'dangerous',
  mode: 'manual',
  tool: 'execute_command',
  args: { command: 'rm -rf /tmp/x' },
  reason: 'dangerous-command',
  workingDir: 'D:/proj',
}

beforeEach(() => {
  usePermissionStore.setState({ bySession: {} })
  useChatStore.setState({
    sessions: [{ id: sid, title: 't', messages: [], createdAt: 1, updatedAt: 1 }],
    sessionStatus: {},
    streamingSessionIds: new Set<string>(),
    sessionErrors: {},
    queuedMessages: {},
  })
})

describe('审批事件的界面映射', () => {
  it('带 tool/args 的请求既置 confirm-danger 又开卡片；精简事件只置状态，不开半张点不动的卡', () => {
    expect(planAgentEvent(rich)).toEqual([
      { kind: 'set-status', sessionId: sid, status: 'confirm-danger' },
      {
        kind: 'open-permission',
        sessionId: sid,
        requestId: 'r1',
        tool: 'execute_command',
        args: { command: 'rm -rf /tmp/x' },
        reason: 'dangerous-command',
        workingDir: 'D:/proj',
        mode: 'manual',
        body: '将执行 rm -rf /tmp/x',
      },
    ])
    const lean: AgentEvent = { type: 'permission.requested', sessionId: sid, requestId: 'r2', preview: 'x', risk: 'dangerous', mode: 'manual' }
    expect(planAgentEvent(lean)).toEqual([{ kind: 'set-status', sessionId: sid, status: 'confirm-danger' }])
  })

  it('重复投递只留一条待批，settled 之后清空', () => {
    applyAgentEvent(rich)
    applyAgentEvent(rich)
    expect(usePermissionStore.getState().bySession[sid]).toHaveLength(1)
    applyAgentEvent({ type: 'permission.settled', sessionId: sid, requestId: 'r1', approved: true, timedOut: false })
    expect(usePermissionStore.getState().bySession[sid] ?? []).toHaveLength(0)
  })

  it('本轮收尾兜底清卡片：宿主漏发 settled 也不留幽灵', () => {
    applyAgentEvent(rich)
    applyAgentEvent({ type: 'run.completed', sessionId: sid, runId: 'run-1' })
    expect(usePermissionStore.getState().bySession[sid]).toBeUndefined()
  })
})
