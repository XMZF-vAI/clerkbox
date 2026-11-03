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
import { executeWorkflowTool, WORKFLOW_TOOL_NAME as CREATE_TOOL, SAVE_WORKFLOW_TOOL_NAME as SAVE_TOOL, RESUME_WORKFLOW_TOOL_NAME as RESUME_TOOL } from '../src/lib/workflow-tools'
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
    const reply = await executeWorkflowTool(CREATE_TOOL, { name: '后台跑', script: SIMPLE_SCRIPT }, ctx)
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
    const reply = await executeWorkflowTool(CREATE_TOOL, { name: '要停的', script: SIMPLE_SCRIPT }, ctx)
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
    const reply = await executeWorkflowTool(CREATE_TOOL, { name: 'signal', script: SIMPLE_SCRIPT }, ctx)
    const { run } = parseWorkflowRunTail(reply!)
    const { stopWorkflowRun } = await import('../src/lib/workflow-runtime')
    stopWorkflowRun(run!.runId)
    expect(capturedSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(getWorkflowRun(run!.runId)?.status).toBe('aborted'))
  })

  it('脚本编不过：不启动、不落 journal', async () => {
    const bridge = makeBridge()
    const ctx = makeCtx(bridge)
    const reply = await executeWorkflowTool(CREATE_TOOL, { name: '坏的', script: 'const a = {' }, ctx)
    expect(reply).toContain('未通过校验')
    expect(bridge.journal).toHaveLength(0)
    expect(bridge.notifications).toHaveLength(0)
  })
})

// ── v3：save_workflow / resume_workflow ────────────────────────────

describe('save_workflow / resume_workflow（三期）', () => {
  beforeEach(() => resetWorkflowRunsForTests())

  it('保存后用 saved 复用：脚本装载自文件，跑通同一套后台语义', async () => {
    const bridge = makeBridge()
    const ctx: any = {
      ...makeCtx(bridge),
      workingDir: 'C:/tmp/ws',
      spawnSubAgent: vi.fn(async () => '复用结果\n\nagentId: subagent-resume-1'),
    }
    // mock ipc：writeFile / readFile / listDir（workflow-store 走这三个）
    const savedJson = JSON.stringify({ version: 1, name: '体检', description: 'd', script: SIMPLE_SCRIPT, savedAt: 1 })
    const ipcMod: any = await import('../src/lib/ipc-client')
    const writeSpy = vi.spyOn(ipcMod.ipc, 'writeFile').mockImplementation(async () => {})
    vi.spyOn(ipcMod.ipc, 'readFile').mockImplementation(async () => savedJson)
    vi.spyOn(ipcMod.ipc, 'listDir').mockImplementation(async () => [{ name: '体检.json', isDirectory: false, isFile: true }])

    // 1) 保存
    const saved = await executeWorkflowTool(SAVE_TOOL, { name: '体检', description: 'd', script: SIMPLE_SCRIPT }, ctx)
    expect(saved).toContain('已保存工作流')
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain('.clerkbox/workflows/')

    // 2) saved 复用运行
    const reply = await executeWorkflowTool(CREATE_TOOL, { name: '体检再跑', saved: '体检' }, ctx)
    expect(reply).toContain('已在后台启动')
    expect(reply).toContain('来自已保存的工作流')
    const { run } = parseWorkflowRunTail(reply!)
    expect(run?.status).toBe('running')
    await vi.waitFor(() => expect(bridge.notifications).toHaveLength(1))
  })

  it('script 与 saved 同时给：报错不执行', async () => {
    const bridge = makeBridge()
    const ctx: any = { ...makeCtx(bridge), workingDir: 'C:/tmp/ws' }
    const reply = await executeWorkflowTool(CREATE_TOOL, { name: 'n', script: SIMPLE_SCRIPT, saved: 'x' }, ctx)
    expect(reply).toContain('二选一')
  })

  it('resume：已完成步骤短路（零派发），失败步骤重跑', async () => {
    // 第一轮：两步，第一步成功第二步失败
    const bridge1 = makeBridge()
    let calls = 0
    const ctx1: any = { ...makeCtx(bridge1), workingDir: 'C:/tmp/ws' }
    ctx1.spawnSubAgent = vi.fn(async () => { calls += 1; if (calls === 1) return '第一步结果\n\nagentId: subagent-a'; throw new Error('第二步挂了') })
    const first = await executeWorkflowTool(CREATE_TOOL, {
      name: '要续跑的',
      script: "await agent('一', '任务一')\nawait agent('二', '任务二')",
    }, ctx1)
    const { run } = parseWorkflowRunTail(first!)
    await vi.waitFor(() => expect(parseWorkflowRunTail(bridge1.tails[0]!.content).run?.status).toBe('failed'))
    const failedRunId = run!.runId

    // 第二轮：resume——第一步命中缓存不派发，只有第二步真正 spawn
    const bridge2 = makeBridge()
    const ctx2: any = { ...makeCtx(bridge2), workingDir: 'C:/tmp/ws' }
    ctx2.spawnSubAgent = vi.fn(async () => '第二步重跑成功\n\nagentId: subagent-b')
    // journal 读不到（进程内场景走内存注册表），直接续
    const reply = await executeWorkflowTool(RESUME_TOOL, { runId: failedRunId }, ctx2)
    expect(reply).toContain('已在后台启动')
    expect(reply).toContain('续跑自')
    expect(reply).toContain('缓存')
    const tail = parseWorkflowRunTail(reply!)
    expect(tail.run?.resumedFrom).toBe(failedRunId)
    await vi.waitFor(() => expect(parseWorkflowRunTail(bridge2.tails[0]!.content).run?.status).toBe('completed'))
    // 关键断言：第一步没有重新派发（spawn 只被调用一次）
    expect(ctx2.spawnSubAgent).toHaveBeenCalledTimes(1)
    // 缓存步在终态尾巴上带 cached 标记
    expect(bridge2.tails[0]!.content).toContain('"cached":true')
  })

  it('resume：runId 不存在 / 已完成 / 还在跑，各自给可自纠的错误', async () => {
    const bridge = makeBridge()
    const ctx: any = { ...makeCtx(bridge), workingDir: 'C:/tmp/ws' }
    expect(await executeWorkflowTool(RESUME_TOOL, { runId: 'wf-nope' }, ctx)).toContain('找不到 run')
    const ok = await executeWorkflowTool(CREATE_TOOL, { name: 'ok的', script: "await agent('a', '任务')\nreturn 1" }, ctx)
    const { run } = parseWorkflowRunTail(ok!)
    await vi.waitFor(() => expect(getWorkflowRun(run!.runId)?.status).toBe('completed'))
    expect(await executeWorkflowTool(RESUME_TOOL, { runId: run!.runId }, ctx)).toContain('已成功完成')
    expect(await executeWorkflowTool(RESUME_TOOL, { runId: '' }, ctx)).toContain('需要 runId')
  })
})
