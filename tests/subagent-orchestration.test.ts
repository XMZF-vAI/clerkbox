/**
 * 子代理编排层测试（多 agent 系统升级批次）
 *
 * 覆盖：真并行派发（同一消息多 spawn_agent）、后台运行 + 完成通知注入、
 * send_message_to_agent 三态投递（运行中 steer / 终态续跑 / 未知 id）、
 * schema 级工具裁剪、profile 推理档位、前台结果的 agentId/usage 结构化、
 * frontmatter 解析加固、宿主事件粒度化补丁、单子代理取消注册表。
 *
 * 模型端口按请求体路由：主对话与子代理各自维护独立的 SSE 脚本队列，
 * 子代理请求以 system 首条（= profile systemPrompt）判定。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// agent-registry 经 ipc 扫描自定义 agent 目录；本文件只测解析与编排，mock 掉扫描源
vi.mock('../src/lib/ipc-client', () => ({
  ipc: {
    scanAgents: vi.fn(async () => []),
  },
}))

import { runReactLoop, runSubAgentLoop } from '../src/agent-core/loop'
import {
  SessionContext,
  registerSubagentControl,
  unregisterSubagentControl,
  abortSubagentLocal,
  steerSubagentLocal,
} from '../src/agent-core/session-context'
import { parseAgentFrontmatter } from '../src/lib/agent-registry'
import { planAgentEvent } from '../src/lib/agent-reducer'
import type { AgentPorts, AgentSettings, AgentStorePort, PermissionApproval } from '../src/agent-core/ports'
import type { AgentDefinition, Message, Session, ToolDefinition } from '../src/types/agent'

// ── SSE 辅助（与 agent-core.test.ts 同口径：OpenAI 兼容分片）──

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const textDelta = (t: string) => ({ choices: [{ delta: { content: t } }] })
const toolCallDelta = (index: number, id: string, name: string, args: string) => ({
  choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] } }],
})
const finishChunk = (reason: string) => ({ choices: [{ delta: {}, finish_reason: reason }] })
const usageChunk = (u: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) =>
  ({ choices: [{ delta: {} }], usage: u })

async function* streamOf(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line
}

const textTurn = (text: string) => [sse(textDelta(text)), sse(finishChunk('stop'))]
const toolTurn = (name: string, args: Record<string, unknown>, id = 'tc1') =>
  [sse(toolCallDelta(0, id, name, JSON.stringify(args))), sse(finishChunk('stop'))]

/** 主对话的一轮：同一条消息里两个 spawn_agent（真并行派发的脚本） */
const twoSpawnTurn = () => [
  sse(toolCallDelta(0, 'tcA', 'spawn_agent', JSON.stringify({ agent_type: 'explorer', prompt: 'A' }))),
  sse(toolCallDelta(1, 'tcB', 'spawn_agent', JSON.stringify({ agent_type: 'explorer', prompt: 'B' }))),
  sse(finishChunk('stop')),
]

const userMsg = (content: string): Message => ({ id: `u-${Math.random().toString(36).slice(2, 8)}`, role: 'user', content, timestamp: Date.now() })

const testAgent: AgentDefinition = {
  agentType: 'explorer',
  name: 'Explorer',
  whenToUse: 'explore codebase',
  description: 'explorer agent',
  tools: ['*'],
  systemPrompt: 'SUB-SYSTEM-PROMPT',
  source: 'built-in',
}

// ── 假端口（按请求体路由的双队列模型）──

function makeSettings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    model: 'test-model',
    apiCompat: 'openai',
    activeProviderId: 'p1',
    activeModelId: 'test-model',
    providers: [{
      id: 'p1',
      name: 'Test',
      apiCompat: 'openai',
      baseUrl: 'http://localhost',
      apiKey: 'sk-test',
      models: [{ id: 'test-model' }],
    }],
    temperature: 0.7,
    maxTokens: 16000,
    approvalMode: 'full',
    enableThinking: false,
    baseUrl: 'http://localhost',
    apiKey: 'sk-test',
    directFetch: false,
    maxInputTokens: 184000,
    agentsMdEnabled: false,
    claudeMdCompat: true,
    browserUseEnabled: false,
    computerUseEnabled: false,
    ...overrides,
  }
}

type TurnFactory = () => string[] | Error | AsyncIterable<string>

function isSubBody(body: unknown, subSystemPrompt: string): boolean {
  const messages = (body as { messages?: Array<{ role: string; content?: string }> }).messages ?? []
  return messages[0]?.role === 'system' && messages[0]?.content === subSystemPrompt
}

function makeRoutedModel(subSystemPrompt: string) {
  const mainQueue: TurnFactory[] = []
  const subQueue: TurnFactory[] = []
  const mainBodies: unknown[] = []
  const subBodies: unknown[] = []
  const stream = vi.fn(async (body: unknown): Promise<AsyncIterable<string>> => {
    const sub = isSubBody(body, subSystemPrompt)
    const queue = sub ? subQueue : mainQueue
    ;(sub ? subBodies : mainBodies).push(body)
    const turn = queue.shift()
    if (!turn) throw new Error(`unexpected model call (${sub ? 'sub' : 'main'}) — no scripted turn left`)
    const resolved = turn()
    if (resolved instanceof Error) throw resolved
    if (Array.isArray(resolved)) return streamOf(resolved)
    return resolved
  })
  return { stream, mainQueue, subQueue, mainBodies, subBodies }
}

function makePorts(opts: {
  findAgent?: AgentDefinition | null
  execute?: (name: string, args: Record<string, unknown>, ctx: NonNullable<AgentPorts['tools'] extends never ? never : Parameters<AgentPorts['tools']['execute']>[2]>) => Promise<string>
  toolDefs?: ToolDefinition[]
  settings?: Partial<AgentSettings>
} = {}) {
  const subSystemPrompt = opts.findAgent?.systemPrompt ?? testAgent.systemPrompt
  const model = makeRoutedModel(subSystemPrompt)
  const settings = makeSettings(opts.settings)
  const session: Session = {
    id: 's1',
    title: 'test',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workingDir: `D:\\proj-${Math.random().toString(36).slice(2, 8)}`,
  }
  const addMessage = vi.fn((sid: string, msg: Message) => {
    if (sid === session.id) session.messages.push(msg)
  })
  const store: AgentStorePort = {
    getSession: (sid: string) => (sid === session.id ? session : undefined),
    addMessage,
    updateMessage: vi.fn((sid: string, msgId: string, updates: Partial<Message>) => {
      if (sid !== session.id) return
      const m = session.messages.find((x) => x.id === msgId)
      if (m) Object.assign(m, updates)
    }),
    setStatus: vi.fn(),
    compact: vi.fn(),
  }
  const ui = {
    askQuestion: vi.fn(async () => ({})),
    setTodos: vi.fn(),
    notify: vi.fn(),
    recordUsage: vi.fn(),
    agentMemoryCapture: vi.fn(async () => {}),
    addSubAgentRun: vi.fn(),
    appendSubAgentMessage: vi.fn(),
    updateSubAgentMessage: vi.fn(),
    completeSubAgentRun: vi.fn(),
    abortSubAgentRun: vi.fn(),
    failSubAgentRun: vi.fn(),
    patchSubAgentRun: vi.fn(),
  }
  const tools = {
    definitions: vi.fn(() => opts.toolDefs ?? []),
    execute: vi.fn((opts.execute ?? (async () => 'OK')) as never) as unknown as AgentPorts['tools']['execute'],
    findAgent: vi.fn(async () => (opts.findAgent !== undefined ? opts.findAgent : testAgent)),
  }
  const ports: AgentPorts = {
    sessionId: 's1',
    settings,
    model,
    tools,
    store,
    permission: { confirm: vi.fn(async (_r: Parameters<AgentPorts['permission']['confirm']>[0]): Promise<PermissionApproval> => ({ approved: true, scope: 'once' })) },
    ui,
    goal: { get: vi.fn(() => undefined), setGoal: vi.fn(), updateGoal: vi.fn() },
    skills: { catalog: vi.fn(() => []) },
    env: {
      platform: 'win32',
      osDescription: 'Windows 11 (test)',
      shellDescription: 'PowerShell',
      isDev: false,
      homeDir: () => 'C:\\Users\\tester',
      readFile: vi.fn(async () => ''),
      readImageAsDataUrl: vi.fn(async () => null),
      runShell: vi.fn(async () => ({ exitCode: 1, stdout: '' })),
      buildMemoryPrompt: vi.fn(async () => '[memory-prompt]'),
    },
    emit: vi.fn(),
  }
  return { ports, ui, session, model, store }
}

/** spawn/send_message 都真实走 loop 注入的 ctx 闭包（与 tool-registry handler 同路径） */
const orchestrationExecute = async (
  name: string,
  args: Record<string, unknown>,
  ctx: Parameters<AgentPorts['tools']['execute']>[2]
): Promise<string> => {
  if (name === 'spawn_agent') {
    if (!ctx?.spawnSubAgent) return 'Error: not initialized'
    return await ctx.spawnSubAgent(String(args.agent_type), String(args.prompt), { runInBackground: args.run_in_background === true })
  }
  if (name === 'send_message_to_agent') {
    if (!ctx?.sendMessageToAgent) return 'Error: not initialized'
    return await ctx.sendMessageToAgent(String(args.agent_id), String(args.message))
  }
  return 'OK'
}

const findToolResult = (session: Session, callId: string): string => {
  for (const m of session.messages) {
    const r = m.toolResults?.find((x) => x.toolCallId === callId)
    if (r) return r.content
  }
  return ''
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════ 真并行派发 ═══════════════

describe('spawn_agent 真并行', () => {
  it('同一消息的两个 spawn_agent 并发执行（旧串行实现下 A 会永远等不到 B）', async () => {
    const started: string[] = []
    const waiters = new Map<string, () => void>()
    const { ports, session, model } = makePorts({
      findAgent: testAgent,
      execute: async (name, args, ctx) => {
        if (name === 'spawn_agent') {
          const tag = String(args.prompt)
          started.push(tag)
          const other = tag === 'A' ? 'B' : 'A'
          if (waiters.has(other)) waiters.get(other)!()
          else await new Promise<void>((resolve) => waiters.set(tag, resolve))
          return await ctx!.spawnSubAgent!(String(args.agent_type), String(args.prompt))
        }
        return 'OK'
      },
    })
    model.mainQueue.push(twoSpawnTurn, () => textTurn('main done'))
    model.subQueue.push(() => textTurn('A result'), () => textTurn('B result'))

    const ctx = new SessionContext('s1')
    await runReactLoop(ports, ctx, [userMsg('fan out')], new AbortController())

    // B 在 A 尚未结束时就开始了 —— 串行派发下 A 的门永远等不到 B，测试会超时
    expect(started).toEqual(['A', 'B'])
    // 两个子代理从共享脚本队列各取一轮，谁先拉到 'A result' 是竞速——断言按集合匹配
    const resultA = findToolResult(session, 'tcA')
    const resultB = findToolResult(session, 'tcB')
    expect([resultA, resultB]).toEqual(expect.arrayContaining([
      expect.stringContaining('A result'),
      expect.stringContaining('B result'),
    ]))
    // 前台结果带 agentId 续聊引导
    expect(resultA).toMatch(/agentId: subagent-[\w-]+ \(use send_message_to_agent/)
  }, 8000)
})

// ═══════════════ 后台运行 + 完成通知 ═══════════════

describe('后台运行与通知注入', () => {
  it('run_in_background 立即返回 agentId；完成后通知入队并在下一次运行注入', async () => {
    // 后台子代理的首轮阻塞，保证父 run 先完整结束（时序确定性）
    let releaseSub!: () => void
    const subGate = new Promise<void>((resolve) => { releaseSub = resolve })
    const { ports, ui, session, model } = makePorts({ findAgent: testAgent, execute: orchestrationExecute })
    model.mainQueue.push(
      () => toolTurn('spawn_agent', { agent_type: 'explorer', prompt: 'bg task', run_in_background: true }, 'tc1'),
      () => textTurn('main continues'),
    )
    model.subQueue.push(async function* () {
      await subGate
      yield sse(textDelta('BG RESULT'))
      yield sse(finishChunk('stop'))
    })

    const ctx = new SessionContext('s1')
    await runReactLoop(ports, ctx, [userMsg('go')], new AbortController())

    // 立即返回：tool result 带 agentId，未阻塞父 run
    const spawnResult = findToolResult(session, 'tc1')
    expect(spawnResult).toMatch(/agentId: subagent-[\w-]+/)
    expect(ui.addSubAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({ background: true, status: 'running' }))

    // 后台完成 → 通知入队
    releaseSub()
    await vi.waitFor(() => {
      expect(ctx.pendingSubagentNotifications.length).toBe(1)
    })
    expect(ctx.pendingSubagentNotifications[0]).toContain('status="completed"')
    expect(ctx.pendingSubagentNotifications[0]).toContain('BG RESULT')
    expect(ui.completeSubAgentRun).toHaveBeenCalledWith('s1', expect.any(String), 'BG RESULT')

    // 下一次运行：通知合并注入为 isSubAgentNotice 消息（进模型上下文，UI 渲染成通知条）
    model.mainQueue.push(() => textTurn('noticed'))
    await runReactLoop(ports, ctx, [userMsg('next')], new AbortController())
    const notice = session.messages.find((m) => m.isSubAgentNotice)
    expect(notice).toBeTruthy()
    expect(notice!.role).toBe('user')
    expect(notice!.content).toContain('<subagent-notification')
    expect(ctx.pendingSubagentNotifications.length).toBe(0)
  }, 10000)

  it('usage 统计回填：后台完成的 run 带 token/工具数/时长', async () => {
    const { ports, ui, model } = makePorts({ findAgent: testAgent, execute: orchestrationExecute })
    model.mainQueue.push(
      () => toolTurn('spawn_agent', { agent_type: 'explorer', prompt: 'task', run_in_background: true }, 'tc1'),
      () => textTurn('done'),
    )
    model.subQueue.push(
      () => [
        sse(toolCallDelta(0, 'stc1', 'read_file', JSON.stringify({ path: 'a.txt' }))),
        sse(usageChunk({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })),
        sse(finishChunk('stop')),
      ],
      () => textTurn('final'),
    )
    const ctx = new SessionContext('s1')
    await runReactLoop(ports, ctx, [userMsg('go')], new AbortController())
    await vi.waitFor(() => {
      expect(ui.patchSubAgentRun).toHaveBeenCalled()
    })
    const patch = ui.patchSubAgentRun.mock.calls.find((c) => c[2]?.usage)?.[2]
    expect(patch.usage).toMatchObject({ totalTokens: 120, toolCalls: 1 })
    expect(patch.usage.durationMs).toBeGreaterThanOrEqual(0)
  }, 10000)
})

// ═══════════════ send_message_to_agent 三态 ═══════════════

describe('send_message_to_agent 三态投递', () => {
  it('未知 agentId：报错并列出已知 id', async () => {
    const { ports, session, model } = makePorts({ findAgent: testAgent, execute: orchestrationExecute })
    model.mainQueue.push(
      () => toolTurn('send_message_to_agent', { agent_id: 'ghost-agent', message: 'hi' }, 'tc1'),
      () => textTurn('done'),
    )
    const ctx = new SessionContext('s1')
    await runReactLoop(ports, ctx, [userMsg('go')], new AbortController())
    const result = findToolResult(session, 'tc1')
    expect(result).toContain('ghost-agent')
  })

  it('终态续跑：携带既有对话在后台继续，同一 runId 二次完成 + 续聊代数 +1', async () => {
    let capturedAgentId = ''
    const { ports, ui, session, model } = makePorts({
      findAgent: testAgent,
      execute: async (name, args, ctx) => {
        if (name === 'spawn_agent') {
          const result = await ctx!.spawnSubAgent!(String(args.agent_type), String(args.prompt))
          capturedAgentId = /agentId: (subagent-[\w-]+)/.exec(result)?.[1] ?? ''
          return result
        }
        if (name === 'send_message_to_agent') {
          return await ctx!.sendMessageToAgent!(String(args.agent_id), String(args.message))
        }
        return 'OK'
      },
    })
    model.mainQueue.push(
      () => toolTurn('spawn_agent', { agent_type: 'explorer', prompt: 'first task' }, 'tc1'),
      () => toolTurn('send_message_to_agent', { agent_id: capturedAgentId, message: 'follow up please' }, 'tc2'),
      () => textTurn('main done'),
    )
    model.subQueue.push(() => textTurn('FIRST RESULT'), () => textTurn('RESUMED RESULT'))

    const ctx = new SessionContext('s1')
    await runReactLoop(ports, ctx, [userMsg('go')], new AbortController())

    expect(capturedAgentId).toMatch(/^subagent-/)
    // 续跑回执带 agentId
    expect(findToolResult(session, 'tc2')).toContain(capturedAgentId)
    // 续跑在后台完成同一 run：二次 complete 携带新结果
    await vi.waitFor(() => {
      const completions = ui.completeSubAgentRun.mock.calls.map((c) => c[2])
      expect(completions).toContain('RESUMED RESULT')
    })
    // 续聊代数 +1（patch 或二次 complete 之间的 run 状态）
    expect(ui.patchSubAgentRun).toHaveBeenCalledWith('s1', capturedAgentId, expect.objectContaining({ continuations: 1 }))
    // 后台续跑完成 → 通知入队
    await vi.waitFor(() => {
      expect(ctx.pendingSubagentNotifications.some((n) => n.includes('RESUMED RESULT'))).toBe(true)
    })
    // 记录里持有完整对话（首轮 + 续跑指令 + 新轨迹），供再次续跑
    const record = ctx.subagentRuns.get(capturedAgentId)
    expect(record?.messages.some((m) => m.role === 'user' && m.content === 'follow up please')).toBe(true)
  }, 10000)

  it('运行中 steer：注入的指令在子代理下一轮迭代顶部被消费', async () => {
    let capturedAgentId = ''
    let releaseSub!: () => void
    const subGate = new Promise<void>((resolve) => { releaseSub = resolve })
    const { ports, session, model } = makePorts({
      findAgent: testAgent,
      execute: async (name, args, ctx) => {
        if (name === 'spawn_agent') {
          const result = await ctx!.spawnSubAgent!(String(args.agent_type), String(args.prompt), { runInBackground: args.run_in_background === true })
          // 后台启动回执里带 agentId —— 与 tool-registry handler 同路径
          capturedAgentId = /agentId: (subagent-[\w-]+)/.exec(result)?.[1] ?? ''
          return result
        }
        if (name === 'send_message_to_agent') {
          return await ctx!.sendMessageToAgent!(String(args.agent_id), String(args.message))
        }
        return 'OK'
      },
    })
    model.mainQueue.push(
      () => toolTurn('spawn_agent', { agent_type: 'explorer', prompt: 'long task', run_in_background: true }, 'tc1'),
      () => toolTurn('send_message_to_agent', { agent_id: capturedAgentId, message: 'new directive' }, 'tc2'),
      () => textTurn('main done'),
    )
    model.subQueue.push(
      async function* () {
        await subGate
        yield sse(toolCallDelta(0, 'stc1', 'read_file', JSON.stringify({ path: 'x.txt' })))
        yield sse(finishChunk('stop'))
      },
      () => textTurn('STEERED FINAL'),
    )

    const ctx = new SessionContext('s1')
    await runReactLoop(ports, ctx, [userMsg('go')], new AbortController())
    expect(capturedAgentId).toMatch(/^subagent-/)
    // steer 回执：运行中 → 已投递
    const steerAck = findToolResult(session, 'tc2')
    expect(steerAck).toContain(capturedAgentId)
    expect(ctx.subagentRuns.get(capturedAgentId)?.pendingMessages).toContain('new directive')

    releaseSub()
    await vi.waitFor(() => {
      // 子代理消费 steer 后的第二轮请求携带注入的指令
      const secondBody = model.subBodies[1] as { messages?: Array<{ role: string; content?: string }> } | undefined
      expect(secondBody?.messages?.some((m) => m.content === 'new directive')).toBe(true)
    })
    await vi.waitFor(() => {
      expect(ctx.pendingSubagentNotifications.some((n) => n.includes('STEERED FINAL'))).toBe(true)
    })
  }, 10000)
})

// ═══════════════ schema 级工具裁剪 ═══════════════

describe('子代理 schema 级工具裁剪', () => {
  const richToolDefs: ToolDefinition[] = [
    { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } },
    { name: 'spawn_agent', description: 'spawn', parameters: { type: 'object', properties: {} } },
    { name: 'send_message_to_agent', description: 'msg', parameters: { type: 'object', properties: {} } },
    { name: 'question', description: 'ask', parameters: { type: 'object', properties: {} } },
    { name: 'todowrite', description: 'todo', parameters: { type: 'object', properties: {} } },
    { name: 'scheduled_task', description: 'schedule', parameters: { type: 'object', properties: {} } },
    { name: 'browser_type', description: 'browser', parameters: { type: 'object', properties: {} } },
  ]

  // OpenAI wire 格式：tools[].function.name
  const bodyToolNames = (body: unknown): string[] =>
    ((body as { tools?: Array<{ name?: string; function?: { name?: string } }> }).tools ?? [])
      .map((t) => t.name ?? t.function?.name ?? '')

  it('白名单只放行列表内工具；派发/交互/定时/Agent 动作工具一律隐藏', async () => {
    const agent: AgentDefinition = { ...testAgent, tools: ['read_file', 'write_file'] }
    const { ports, model } = makePorts({ findAgent: agent, toolDefs: richToolDefs })
    model.subQueue.push(() => textTurn('done'))
    await runSubAgentLoop(ports, new SessionContext('s1'), 'explorer', 'p', new AbortController())
    expect(bodyToolNames(model.subBodies[0]).sort()).toEqual(['read_file', 'write_file'])
  })

  it('tools 为 * 时仍隐藏 spawn/send/question/todo/schedule/agent 动作', async () => {
    const { ports, model } = makePorts({ findAgent: { ...testAgent, tools: ['*'] }, toolDefs: richToolDefs })
    model.subQueue.push(() => textTurn('done'))
    await runSubAgentLoop(ports, new SessionContext('s1'), 'explorer', 'p', new AbortController())
    const names = bodyToolNames(model.subBodies[0])
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    for (const hidden of ['spawn_agent', 'send_message_to_agent', 'question', 'todowrite', 'scheduled_task', 'browser_type']) {
      expect(names).not.toContain(hidden)
    }
  })

  it('profile 推理档位覆盖：子代理请求带 reasoning_effort，主对话不带', async () => {
    // effort 型 thinkingStyle 只在 thinking 开启时发送档位 —— 顺带验证 profile.thinking 覆盖
    const agent: AgentDefinition = { ...testAgent, reasoningEffort: 'high', thinking: true }
    const settings = { providers: [{
      id: 'p1', name: 'Test', apiCompat: 'openai' as const, baseUrl: 'http://localhost', apiKey: 'sk-test',
      models: [{ id: 'test-model', thinkingStyle: 'effort' as const, reasoningEfforts: ['low', 'medium', 'high'] as Array<'low' | 'medium' | 'high'> }],
    }] }
    const { ports, model } = makePorts({ findAgent: agent, settings })
    // 主对话先跑一轮（对照组），再跑子代理
    model.mainQueue.push(() => textTurn('main'))
    await runReactLoop(ports, new SessionContext('s1'), [userMsg('go')], new AbortController())
    model.subQueue.push(() => textTurn('sub'))
    await runSubAgentLoop(ports, new SessionContext('s1'), 'explorer', 'p', new AbortController())
    expect((model.mainBodies[0] as Record<string, unknown>).reasoning_effort).toBeUndefined()
    expect((model.subBodies[0] as Record<string, unknown>).reasoning_effort).toBe('high')
  })
})

// ═══════════════ frontmatter 解析加固 ═══════════════

describe('agent frontmatter 解析', () => {
  it('引号值、dash 列表、行内数组、布尔与数字', () => {
    const { frontmatter, body } = parseAgentFrontmatter([
      '---',
      'name: "Code Reviewer"',
      'description: \'Reviews code changes\'',
      'tools:',
      '  - read_file',
      '  - search_content',
      'disallowedTools: [write_file, execute_command]',
      'maxTurns: 25',
      'background: true',
      'reasoningEffort: high',
      'thinkingBudget: 4096',
      '---',
      '',
      'BODY-TEXT',
    ].join('\n'))
    expect(frontmatter.name).toBe('Code Reviewer')
    expect(frontmatter.description).toBe('Reviews code changes')
    expect(frontmatter.tools).toEqual(['read_file', 'search_content'])
    // 行内数组在解析层保留原始标量，数组收敛发生在 loadCustomAgents（见下方用例）
    expect(frontmatter.disallowedTools).toBe('[write_file, execute_command]')
    expect(frontmatter.maxTurns).toBe('25')
    expect(frontmatter.background).toBe('true')
    expect(frontmatter.reasoningEffort).toBe('high')
    expect(frontmatter.thinkingBudget).toBe('4096')
    expect(body).toBe('BODY-TEXT')
  })

  it('嵌套 mapping 被忽略（防注入），正文保留', () => {
    const { frontmatter } = parseAgentFrontmatter([
      '---',
      'name: tester',
      'mcpServers:',
      '  evil: http://attacker.example',
      'description: ok',
      '---',
      'BODY',
    ].join('\n'))
    expect(frontmatter.name).toBe('tester')
    expect(frontmatter.description).toBe('ok')
    expect(frontmatter.mcpServers).toBeUndefined()
  })

  it('loadCustomAgents：dash 列表收敛为数组，maxTurns 封顶 500，profile 推理字段入定义', async () => {
    const { loadCustomAgents } = await import('../src/lib/agent-registry')
    const { ipc } = await import('../src/lib/ipc-client')
    vi.mocked(ipc.scanAgents).mockResolvedValue([
      {
        filename: 'reviewer.md',
        origin: 'project' as const,
        content: [
          '---',
          'name: reviewer',
          'description: Review agent',
          'tools:',
          '  - read_file',
          '  - search_content',
          'maxTurns: 9999',
          'background: true',
          'reasoningEffort: high',
          'thinking: false',
          'thinkingBudget: 2048',
          '---',
          'REVIEW PROMPT',
        ].join('\n'),
      },
    ])
    const agents = await loadCustomAgents('D:/proj-x')
    expect(agents).toHaveLength(1)
    const a = agents[0]!
    expect(a.agentType).toBe('reviewer')
    expect(a.tools).toEqual(['read_file', 'search_content'])
    expect(a.maxTurns).toBe(500) // 显式值封顶主循环上限
    expect(a.background).toBe(true)
    expect(a.reasoningEffort).toBe('high')
    expect(a.thinking).toBe(false)
    expect(a.thinkingBudget).toBe(2048)
    expect(a.systemPrompt).toBe('REVIEW PROMPT')
    expect(a.origin).toBe('project')
  })
})

// ═══════════════ 宿主事件粒度化（O(n²) 修复的渲染层契约）═══════════════

describe('subagent 增量事件补丁', () => {
  const message: Message = { id: 'm1', role: 'assistant', content: 'x', timestamp: 1 }

  it('subagent.message.appended → append-subagent-message 补丁', () => {
    expect(planAgentEvent({ type: 'subagent.message.appended', sessionId: 's1', runId: 'r1', message })).toEqual([
      { kind: 'append-subagent-message', sessionId: 's1', runId: 'r1', message },
    ])
  })

  it('subagent.message.updated → update-subagent-message 补丁', () => {
    expect(planAgentEvent({ type: 'subagent.message.updated', sessionId: 's1', runId: 'r1', messageId: 'm1', updates: { content: 'y' } })).toEqual([
      { kind: 'update-subagent-message', sessionId: 's1', runId: 'r1', messageId: 'm1', updates: { content: 'y' } },
    ])
  })
})

// ═══════════════ 单子代理取消 / steering 注册表 ═══════════════

describe('subagent 控制注册表', () => {
  it('abortSubagentLocal 只中止登记的那个 controller；注销后查不到', () => {
    const controllerA = new AbortController()
    const controllerB = new AbortController()
    registerSubagentControl('s1', 'runA', { controller: controllerA, steer: () => true })
    registerSubagentControl('s1', 'runB', { controller: controllerB, steer: () => true })

    expect(abortSubagentLocal('s1', 'runA')).toBe(true)
    expect(controllerA.signal.aborted).toBe(true)
    expect(controllerB.signal.aborted).toBe(false)
    expect(abortSubagentLocal('s1', 'missing')).toBe(false)

    unregisterSubagentControl('s1', 'runB')
    expect(abortSubagentLocal('s1', 'runB')).toBe(false)
  })

  it('steerSubagentLocal 路由到登记的 sink；sink 拒绝（未运行）返回 false', () => {
    const received: string[] = []
    registerSubagentControl('s1', 'runA', { controller: new AbortController(), steer: (text) => { received.push(text); return true } })
    expect(steerSubagentLocal('s1', 'runA', 'hello')).toBe(true)
    expect(received).toEqual(['hello'])
    // sink 语义：run 不在运行时返回 false
    registerSubagentControl('s1', 'runB', { controller: new AbortController(), steer: () => false })
    expect(steerSubagentLocal('s1', 'runB', 'x')).toBe(false)
    expect(steerSubagentLocal('s1', 'missing', 'x')).toBe(false)
  })
})
