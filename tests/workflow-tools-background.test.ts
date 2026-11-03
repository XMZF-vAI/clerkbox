/**
 * create_workflow v2 后台语义（工具层）：立即返回 + settle 注回桥。
 *
 * 守四件事：
 *  1. 工具调用立即返回确认文本（含 runId 与 running 尾巴），不再阻塞到跑完；
 *  2. settle 时宿主桥按序收到：尾巴换终态、通知入队、journal 落盘、请求唤醒；
 *  3. 中止的 run：run 归档 aborted，不请求唤醒（用户亲手停的不打扰）；
 *  4. signal 透传到 spawnSubAgent（停止工作流要能掐断在飞子代理）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { executeWorkflowTool, WORKFLOW_TOOL_NAME } from '../src/lib/workflow-tools'
import { resetWorkflowRunsForTests, parseWorkflowRunTail, getWorkflowRun } from '../src/lib/workflow-runtime'

function makeBridge() {
  return {
    tails: [] as Array<{ toolCallId: string; content: string }>,
    notifications: [] as string[],
    journal: [] as unknown[],
    wakes: 0,
  }
}

function makeCtx(bridge: ReturnType<typeof makeBridge>, spawnImpl?: (prompt: string, signal?: AbortSignal) => Promise<string>) {
  return {
    sessionId: 's1',
    toolCallId: 'call-1',
    assistantMessageId: 'msg-1',
    spawnSubAgent: vi.fn((_: string, prompt: string, opts?: { signal?: AbortSignal }) =>
      (spawnImpl ?? (async () => '子代理结果\n\nagentId: subagent-123'))(prompt, opts?.signal)),
    onWorkflowProgress: vi.fn(),
    workflowHost: {
      updateToolResultTail: (toolCallId: string, content: string) => bridge.tails.push({ toolCallId, content }),
      pushNotification: (text: string) => bridge.notifications.push(text),
      requestWake: () => { bridge.wakes += 1 },
      journalPut: (run: unknown) => bridge.journal.push(run),
    },
  }
}

const SIMPLE_SCRIPT = "await agent('读者', '任务一')\nreturn '结论'"

describe('create_workflow 后台语义', () => {
  beforeEach(() => resetWorkflowRunsForTests())

  it('立即返回确认文本 + running 尾巴；settle 后桥按序注回', async () => {
    const bridge = makeBridge()
    const ctx = makeCtx(bridge)
    const reply = await executeWorkflowTool(WORKFLOW_TOOL_NAME, { name: '后台跑', script: SIMPLE_SCRIPT }, ctx)
    // 立即返回：此时子代理刚派发、工具结果已拿到
    expect(reply).toContain('已在后台启动')
    expect(reply).toContain('不要轮询')
    const { run } = parseWorkflowRunTail(reply!)
    expect(run?.status).toBe('running')
    expect((reply as string).includes('__WORKFLOW_RUN__:')).toBe(true)
    // launch 快照已落 journal
    expect(bridge.journal).toHaveLength(1)
    // 等脚本跑完：settle 注回
    await vi.waitFor(() => expect(bridge.notifications).toHaveLength(1))
    expect(bridge.notifications[0]).toContain('<workflow-notification')
    expect(bridge.notifications[0]).toContain('status="completed"')
    expect(bridge.tails).toHaveLength(1)
    expect(bridge.tails[0]!.toolCallId).toBe('call-1')
    const settledTail = parseWorkflowRunTail(bridge.tails[0]!.content).run
    expect(settledTail?.status).toBe('completed')
    // journal 两次（launch + settle），唤醒恰好一次
    expect(bridge.journal).toHaveLength(2)
    expect(bridge.wakes).toBe(1)
    // run 终态可查
    expect(getWorkflowRun(run!.runId)?.status).toBe('completed')
  })

  it('中止的 run：归档 aborted，不请求唤醒', async () => {
    const bridge = makeBridge()
    let release: ((v: string) => void) | undefined
    const ctx = makeCtx(bridge, (prompt, signal) => new Promise<string>((resolve) => {
      signal?.addEventListener('abort', () => resolve('[aborted]'), { once: true })
      release = (v) => resolve(v)
    }))
    const reply = await executeWorkflowTool(WORKFLOW_TOOL_NAME, { name: '要停的', script: SIMPLE_SCRIPT }, ctx)
    const { run } = parseWorkflowRunTail(reply!)
    // 在飞时停止（直接走 runtime 的停止注册表，与停止按钮同路径）
    const { stopWorkflowRun } = await import('../src/lib/workflow-runtime')
    expect(stopWorkflowRun(run!.runId)).toBe(true)
    release?.('不该被消费')
    await vi.waitFor(() => expect(getWorkflowRun(run!.runId)?.status).toBe('aborted'))
    await vi.waitFor(() => expect(bridge.notifications).toHaveLength(1))
    expect(bridge.notifications[0]).toContain('status="aborted"')
    expect(bridge.wakes).toBe(0)
  })

  it('signal 透传到 spawnSubAgent（停止要能掐断在飞子代理）', async () => {
    const bridge = makeBridge()
    let capturedSignal: AbortSignal | undefined
    const ctx = makeCtx(bridge, (_prompt, signal) => {
      capturedSignal = signal
      return new Promise<string>((resolve) => {
        signal?.addEventListener('abort', () => resolve('[aborted]'), { once: true })
        setTimeout(() => resolve('晚到的结果'), 50)
      })
    })
    const reply = await executeWorkflowTool(WORKFLOW_TOOL_NAME, { name: 'signal', script: SIMPLE_SCRIPT }, ctx)
    const { run } = parseWorkflowRunTail(reply!)
    const { stopWorkflowRun } = await import('../src/lib/workflow-runtime')
    stopWorkflowRun(run!.runId)
    expect(capturedSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(getWorkflowRun(run!.runId)?.status).toBe('aborted'))
  })

  it('脚本编不过：不启动、不落 journal', async () => {
    const bridge = makeBridge()
    const ctx = makeCtx(bridge)
    const reply = await executeWorkflowTool(WORKFLOW_TOOL_NAME, { name: '坏的', script: 'const a = {' }, ctx)
    expect(reply).toContain('未通过校验')
    expect(bridge.journal).toHaveLength(0)
    expect(bridge.notifications).toHaveLength(0)
  })
})
