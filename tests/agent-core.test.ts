/**
 * agent-core 假端口测试（批次 B · P2）
 *
 * 用假的 AgentPorts（各端口均为 vi.fn / 内存实现）驱动 runReactLoop /
 * runSubAgentLoop，覆盖：纯函数、黄金序列（流解析→工具往返→收尾）、
 * 权限与运行时防护（截断/doom-loop/轮次上限）、重试与溢出恢复、
 * 自动压缩衔接（vi.mock compact）、子 agent 循环、goal 评估闭环。
 *
 * 假模型端口输出 OpenAI 兼容 SSE 分片；compactConversation 直接调模型 API，
 * 故 mock 掉（其余纯函数保留真实实现）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { compactConversationMock } = vi.hoisted(() => ({ compactConversationMock: vi.fn() }))
vi.mock('../src/lib/compact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/compact')>()
  return { ...actual, compactConversation: compactConversationMock }
})

import {
  makeId,
  runReactLoop,
  runSubAgentLoop,
  isContextOverflowError,
  isRetryableError,
  extractRetryAfterMs,
  runWithRetry,
  getWorkingDir,
} from '../src/agent-core/loop'
import { createSeqCounter } from '../src/agent-core/protocol'
import { SessionContext, SessionContextStore } from '../src/agent-core/session-context'
import type { AgentPorts, AgentSettings, AgentStorePort } from '../src/agent-core/ports'
import type { SkillCatalogEntry } from '../src/lib/skill-catalog'
import type {
  AgentDefinition,
  Message,
  Session,
  SessionGoal,
  TaskMode,
  ToolDefinition,
} from '../src/types/agent'

// ── SSE 脚本辅助（OpenAI 兼容格式，loop 经 sseLines → parseEvent 归一化）──

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const textDelta = (t: string) => ({ choices: [{ delta: { content: t } }] })
const thinkDelta = (t: string) => ({ choices: [{ delta: { reasoning_content: t } }] })
const toolCallDelta = (index: number, id: string | undefined, name: string | undefined, args: string) => ({
  choices: [{
    delta: {
      tool_calls: [{
        index,
        ...(id ? { id } : {}),
        type: 'function',
        function: { ...(name ? { name } : {}), arguments: args },
      }],
    },
  }],
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

/** 单轮模型行为：SSE 行脚本 / 抛出的错误 / 按调用序号动态生成的工厂（可中途 abort） */
type Turn = string[] | Error | ((callIndex: number) => string[] | Error | AsyncIterable<string>)

// ── 假端口工厂 ──

function makeModel(turns: Turn[]) {
  const bodies: unknown[] = []
  const stream = vi.fn(async (body: unknown): Promise<AsyncIterable<string>> => {
    const call = bodies.length
    bodies.push(body)
    const turn = turns[Math.min(call, turns.length - 1)]
    const resolved = typeof turn === 'function' ? turn(call) : turn
    if (resolved instanceof Error) throw resolved
    if (Array.isArray(resolved)) return streamOf(resolved)
    return resolved
  })
  return { stream, bodies }
}

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
    ...overrides,
  }
}

/** 内存版 store 端口：session.messages 即断言数据源 */
function makeStorePort(sessionInit: Partial<Session> = {}) {
  const session: Session = {
    id: 's1',
    title: 'test',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...sessionInit,
  }
  const addMessage = vi.fn((sid: string, msg: Message) => {
    if (sid === session.id) session.messages.push(msg)
  })
  const updateMessage = vi.fn((sid: string, msgId: string, updates: Partial<Message>) => {
    const m = session.messages.find((x) => x.id === msgId)
    if (m) Object.assign(m, updates)
  })
  const store: AgentStorePort = {
    getSession: (sid: string) => (sid === session.id ? session : undefined),
    addMessage,
    updateMessage,
    setStatus: vi.fn(),
    compact: vi.fn((sid: string, messages: Message[]) => {
      if (sid === session.id) session.messages = [...messages]
    }),
  }
  return { store, session, addMessage, updateMessage }
}

function makeUiPort() {
  return {
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
  }
}

const DEFAULT_TOOLS: ToolDefinition[] = [{
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}]

let dirSeq = 0
/** 每个测试用独立目录，避免 gitRepoCache（模块级 Map）跨用例串扰 */
const uniqueDir = () => `D:\\proj${++dirSeq}`

function makePorts(opts: {
  turns?: Turn[]
  settings?: Partial<AgentSettings>
  workingDir?: string
  goalState?: SessionGoal
  skillsCatalog?: SkillCatalogEntry[]
  toolDefs?: ToolDefinition[]
  execute?: (name: string, args: Record<string, unknown>) => Promise<string>
  findAgent?: AgentDefinition | null
} = {}) {
  const workingDir = opts.workingDir ?? uniqueDir()
  const model = makeModel(opts.turns ?? [textTurn('ok')])
  const settings = makeSettings(opts.settings)
  const { store, session, addMessage, updateMessage } = makeStorePort({ workingDir })
  const ui = makeUiPort()
  const permission = { confirm: vi.fn(async () => true) }
  const goal = {
    get: vi.fn(() => opts.goalState),
    setGoal: vi.fn(),
    updateGoal: vi.fn(),
  }
  const tools = {
    definitions: vi.fn(() => opts.toolDefs ?? DEFAULT_TOOLS),
    execute: vi.fn((opts.execute ?? (async () => 'OK')) as
      (name: string, args: Record<string, unknown>, ctx: unknown) => Promise<string>),
    findAgent: vi.fn(async () => opts.findAgent ?? null),
  }
  const env = {
    platform: 'win32',
    osDescription: 'Windows 11 (test)',
    shellDescription: 'PowerShell',
    homeDir: () => 'C:\\Users\\tester',
    readFile: vi.fn(async () => ''),
    runShell: vi.fn(async () => ({ exitCode: 1, stdout: '' })), // git 探测恒为非仓库
    buildMemoryPrompt: vi.fn(async () => '[memory-prompt]'),
  }
  const ports: AgentPorts = {
    sessionId: 's1',
    settings,
    model,
    tools,
    store,
    permission,
    ui,
    goal,
    skills: { catalog: vi.fn(() => opts.skillsCatalog ?? []) },
    env,
    emit: vi.fn(),
  }
  return { ports, model, session, ui, permission, goal, tools, env, store, addMessage, updateMessage, workingDir }
}

const userMsg = (content = 'hello'): Message => ({ id: 'u1', role: 'user', content, timestamp: Date.now() })

async function runLoop(ports: AgentPorts, opts: { taskMode?: TaskMode; messages?: Message[] } = {}) {
  const ctx = new SessionContext(ports.sessionId)
  // checkToolPermission 在工具执行深处读 ctx.activeTaskMode（宿主 sendMessage 负责设置）
  ctx.activeTaskMode = opts.taskMode ?? null
  const controller = new AbortController()
  await runReactLoop(ports, ctx, opts.messages ?? [userMsg()], controller, opts.taskMode)
  return { ctx, controller }
}

beforeEach(() => {
  compactConversationMock.mockReset()
})

// ═══════════════ 纯函数与工具 ═══════════════

describe('createSeqCounter', () => {
  it('默认从 0 开始单调递增，get 读取不递增', () => {
    const seq = createSeqCounter()
    expect(seq.get()).toBe(0)
    expect(seq.next()).toBe(1)
    expect(seq.next()).toBe(2)
    expect(seq.get()).toBe(2)
  })

  it('支持指定起始值（重连续号）', () => {
    const seq = createSeqCounter(100)
    expect(seq.next()).toBe(101)
    expect(seq.get()).toBe(101)
  })
})

describe('makeId', () => {
  it('生成 msg- 前缀的唯一 id', () => {
    const a = makeId()
    const b = makeId()
    expect(a).toMatch(/^msg-/)
    expect(a).not.toBe(b)
  })
})

describe('isContextOverflowError', () => {
  it('识别各类溢出文案', () => {
    expect(isContextOverflowError(new Error('prompt is too long'))).toBe(true)
    expect(isContextOverflowError(new Error('This model maximum context length is 128000 tokens'))).toBe(true)
    expect(isContextOverflowError(new Error('request too large: context_length_exceeded'))).toBe(true)
  })

  it('AbortError 与普通错误不算溢出', () => {
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    expect(isContextOverflowError(abortErr)).toBe(false)
    expect(isContextOverflowError(new Error('API Error 500: boom'))).toBe(false)
    expect(isContextOverflowError('plain string prompt is too long')).toBe(true)
  })
})

describe('isRetryableError', () => {
  it('瞬时错误可重试，溢出/配额/中断/4xx 不可重试', () => {
    expect(isRetryableError(new Error('API Error 429: rate limited'))).toBe(true)
    expect(isRetryableError(new Error('HTTP 503: unavailable'))).toBe(true)
    expect(isRetryableError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableError(new Error('Request timeout after 30s'))).toBe(true)
    expect(isRetryableError(new Error('insufficient_quota: please add credits'))).toBe(false)
    expect(isRetryableError(new Error('prompt is too long'))).toBe(false)
    expect(isRetryableError(new Error('API Error 400: bad request'))).toBe(false)
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    expect(isRetryableError(abortErr)).toBe(false)
  })
})

describe('extractRetryAfterMs', () => {
  it('提取服务端 Retry-After 毫秒数，缺失返回 null，上限 60s', () => {
    expect(extractRetryAfterMs(new Error('API Error 429 (retry after 8000ms): slow down'))).toBe(8000)
    expect(extractRetryAfterMs(new Error('API Error 429 (retry after 1ms): fast'))).toBe(1)
    expect(extractRetryAfterMs(new Error('API Error 429: no header'))).toBeNull()
    expect(extractRetryAfterMs(new Error('(retry after 999999ms)'))).toBe(60_000)
    expect(extractRetryAfterMs(new Error('(retry after 0ms)'))).toBeNull()
  })
})

describe('runWithRetry', () => {
  it('首次成功直接返回，不触发 onRetry', async () => {
    const onRetry = vi.fn()
    const result = await runWithRetry(async () => 'ok', { onRetry })
    expect(result).toBe('ok')
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('失败后重试成功，onRetry 按次回调并最终返回结果', async () => {
    const onRetry = vi.fn()
    let attempts = 0
    const result = await runWithRetry(async () => {
      attempts++
      if (attempts < 3) throw new Error('API Error 503 (retry after 1ms): down')
      return 'recovered'
    }, { retries: 5, baseDelayMs: 1, onRetry })
    expect(result).toBe('recovered')
    expect(attempts).toBe(3)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0][0]).toBe(1) // attempt 从 1 起
  })

  it('shouldRetry 返回 false 时立即抛出', async () => {
    let attempts = 0
    await expect(runWithRetry(async () => {
      attempts++
      throw new Error('fatal')
    }, { retries: 5, baseDelayMs: 1, shouldRetry: () => false })).rejects.toThrow('fatal')
    expect(attempts).toBe(1)
  })

  it('重试次数耗尽后抛出最后一次错误', async () => {
    let attempts = 0
    await expect(runWithRetry(async () => {
      attempts++
      throw new Error('API Error 429: always')
    }, { retries: 3, baseDelayMs: 1 })).rejects.toThrow('API Error 429')
    expect(attempts).toBe(4) // 1 次初始 + 3 次重试
  })

  it('getRetryAfterMs 提供的延迟优先于指数退避', async () => {
    const delays: number[] = []
    let attempts = 0
    await runWithRetry(async () => {
      attempts++
      if (attempts === 1) throw new Error('slow down')
      return 'ok'
    }, {
      baseDelayMs: 5000,
      getRetryAfterMs: () => 1,
      onRetry: (_attempt, delay) => delays.push(delay),
    })
    expect(delays[0]).toBe(1)
  })
})

describe('getWorkingDir', () => {
  const fakePorts = (session?: Partial<Session>): AgentPorts =>
    ({ sessionId: 's', store: { getSession: () => session } }) as unknown as AgentPorts

  it('优先级：requestWorkingDir > session.workingDir > defaultWorkDir > 空串', () => {
    const ports = fakePorts({ workingDir: 'D:\\a', defaultWorkDir: 'D:\\def' })
    const ctx = new SessionContext('s')
    expect(getWorkingDir(ports, ctx)).toBe('D:\\a')
    ctx.requestWorkingDir = 'D:\\req'
    expect(getWorkingDir(ports, ctx)).toBe('D:\\req')

    const ports2 = fakePorts({ defaultWorkDir: 'D:\\def' })
    expect(getWorkingDir(ports2, new SessionContext('s'))).toBe('D:\\def')

    expect(getWorkingDir(fakePorts(undefined), new SessionContext('s'))).toBe('')
  })
})

describe('SessionContextStore', () => {
  it('get 惰性创建并复用同一实例，peek 未创建返回 undefined', () => {
    const store = new SessionContextStore()
    expect(store.peek('a')).toBeUndefined()
    const ctx = store.get('a')
    expect(ctx).toBeInstanceOf(SessionContext)
    expect(ctx.sessionId).toBe('a')
    expect(store.get('a')).toBe(ctx)
    expect(store.sessionIds()).toEqual(['a'])
  })

  it('delete 后再 get 返回新实例', () => {
    const store = new SessionContextStore()
    const ctx1 = store.get('a')
    store.delete('a')
    expect(store.peek('a')).toBeUndefined()
    expect(store.get('a')).not.toBe(ctx1)
  })
})

// ═══════════════ runReactLoop · 黄金序列 ═══════════════

describe('runReactLoop · 黄金序列', () => {
  it('纯文本回复：分片拼装、最终消息字段完整', async () => {
    const { ports, session } = makePorts({ turns: [[
      sse(textDelta('你好')),
      sse(textDelta('，')),
      sse(textDelta('世界')),
      sse(finishChunk('stop')),
    ]] })
    await runLoop(ports)
    expect(session.messages).toHaveLength(1)
    const a = session.messages[0]
    expect(a.role).toBe('assistant')
    expect(a.content).toBe('你好，世界')
    expect(a.finishReason).toBe('stop')
    expect(a._isStreaming).toBeFalsy()
    expect(a.toolCalls).toBeUndefined()
  })

  it('思考与正文分流：reasoning_content 字段与 <think> 内联标签', async () => {
    const { ports, session } = makePorts({ turns: [[
      sse(thinkDelta('思')),
      sse(thinkDelta('考')),
      sse(textDelta('答案')),
      sse(finishChunk('stop')),
    ]] })
    await runLoop(ports)
    expect(session.messages[0].thinkingContent).toBe('思考')
    expect(session.messages[0].content).toBe('答案')

    // <think> 标签跨分片：尾料冲刷保证结尾不被吞
    const { ports: p2, session: s2 } = makePorts({ turns: [[
      sse(textDelta('<think>re')),
      sse(textDelta('ason</think>ans')),
      sse(finishChunk('stop')),
    ]] })
    await runLoop(p2)
    expect(s2.messages[0].thinkingContent).toBe('reason')
    expect(s2.messages[0].content).toBe('ans')
  })

  it('usage 上报：写入助手消息、ui.recordUsage 与 tokenTracker', async () => {
    const { ports, session, ui, model } = makePorts({ turns: [[
      sse(textDelta('hi')),
      sse(usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })),
      sse(finishChunk('stop')),
    ]] })
    const { ctx } = await runLoop(ports)
    expect(session.messages[0].usage).toMatchObject({ prompt_tokens: 10, total_tokens: 15 })
    expect(ui.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ total_tokens: 15 }),
      sessionId: 's1',
      model: 'test-model',
      providerId: 'p1',
    }))
    expect(ctx.tokenTracker.getLastUsage()).toMatchObject({ total_tokens: 15 })
    expect(model.bodies).toHaveLength(1)
  })

  it('请求体结构：system 首位、tools、model、stream、temperature', async () => {
    const { ports, model } = makePorts({ turns: [textTurn('ok')] })
    await runLoop(ports)
    const body = model.bodies[0] as Record<string, any>
    expect(body.model).toBe('test-model')
    expect(body.stream).toBe(true)
    expect(body.temperature).toBe(0.7)
    const messages = body.messages as Array<Record<string, any>>
    expect(messages[0]!.role).toBe('system')
    expect(messages.some((m) => m.role === 'system' && m.content.includes('Current Working Directory'))).toBe(true)
    expect(messages.at(-1)!.role).toBe('user')
    expect(messages.at(-1)!.content).toContain('hello')
    const tools = body.tools as Array<Record<string, any>>
    expect(tools.some((t) => t.function?.name === 'read_file')).toBe(true)
  })

  it('工具往返：cwd 注入、tool 消息入库、下一轮请求回放 tool 消息', async () => {
    const wd = 'D:\\proj-tool'
    const { ports, session, model, tools, workingDir } = makePorts({
      workingDir: wd,
      execute: async () => 'FILE-CONTENT',
      turns: [toolTurn('read_file', { path: 'a.txt' }), textTurn('ALL DONE')],
    })
    expect(workingDir).toBe(wd)
    await runLoop(ports)

    // 执行参数：相对路径已按会话工作目录解析，ctx 携带 sessionId/workingDir/readFileState
    expect(tools.execute).toHaveBeenCalledTimes(1)
    const [name, args, toolCtx] = tools.execute.mock.calls[0]!
    expect(name).toBe('read_file')
    expect(args).toMatchObject({ path: `${wd}\\a.txt` })
    expect(toolCtx).toMatchObject({ sessionId: 's1', workingDir: wd })
    expect((toolCtx as { readFileState?: unknown }).readFileState).toBeInstanceOf(Map)

    // 消息序列：assistant(带 toolCalls/toolResults) → tool → assistant 总结
    const roles = session.messages.map((m) => m.role)
    expect(roles).toEqual(['assistant', 'tool', 'assistant'])
    expect(session.messages[0].toolCalls).toMatchObject([{ name: 'read_file' }])
    expect(session.messages[1].content).toBe('FILE-CONTENT')
    expect(session.messages[2].content).toBe('ALL DONE')
    expect(session.messages[2].collapsed).toBeUndefined() // 最终总结不折叠

    // 第二轮请求回放：assistant 带 tool_calls，tool 结果以 role:'tool' 进入
    const body2 = model.bodies[1] as Record<string, any>
    const msgs2 = body2.messages as Array<Record<string, any>>
    expect(msgs2.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.function?.name === 'read_file')).toBe(true)
    expect(msgs2.some((m) => m.role === 'tool' && m.content === 'FILE-CONTENT')).toBe(true)
  })

  it('工具调用参数分片累加后正确 JSON 解析', async () => {
    const { ports, tools, workingDir } = makePorts({
      turns: [[
        sse(toolCallDelta(0, 'tc1', 'read_file', '{"pa')),
        sse(toolCallDelta(0, undefined, undefined, 'th": "b.txt"}')),
        sse(finishChunk('stop')),
      ], textTurn('done')],
    })
    await runLoop(ports)
    expect(tools.execute).toHaveBeenCalledWith('read_file', { path: `${workingDir}\\b.txt` }, expect.anything())
  })

  it('read_file 命中技能目录：助手消息记录 loadedSkills 快照', async () => {
    const skillMdPath = 'D:\\proj-skill\\.clerkbox\\skills\\demo\\SKILL.md'
    const entry = {
      id: 'sk1', slug: 'demo', name: 'Demo Skill', description: 'demo',
      triggerKeywords: [], version: '1.0.0', icon: '🧩', skillMdPath, chainsTo: [], active: true,
    } as SkillCatalogEntry
    const { ports, session } = makePorts({
      workingDir: 'D:\\proj-skill',
      skillsCatalog: [entry],
      turns: [toolTurn('read_file', { path: skillMdPath }), textTurn('loaded')],
    })
    await runLoop(ports)
    const withSkills = session.messages.find((m) => m.loadedSkills?.length)
    expect(withSkills).toBeDefined()
    expect(withSkills!.loadedSkills![0]).toMatchObject({ id: 'sk1', name: 'Demo Skill' })
  })

  it('工具执行异常：结果标记 isError，循环继续收尾', async () => {
    const { ports, session } = makePorts({
      execute: async () => { throw new Error('boom') },
      turns: [toolTurn('read_file', { path: 'a.txt' }), textTurn('recovered')],
    })
    await runLoop(ports)
    const toolMsg = session.messages.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.toolResults![0].isError).toBe(true)
    // 注：agent.toolExecFailed 在两份 locale 均缺失（历史缺口），i18n.t 回落为 key 本身
    expect(toolMsg!.content.length).toBeGreaterThan(0)
    expect(session.messages.at(-1)!.content).toBe('recovered')
  })

  it('同批只读工具并行执行且结果保持模型顺序', async () => {
    const { ports, session, tools } = makePorts({
      execute: async (name, args) => {
        if ((args as { path: string }).path.includes('a')) {
          await new Promise((r) => setTimeout(r, 30))
          return 'A-RESULT'
        }
        return 'B-RESULT'
      },
      turns: [[
        sse(toolCallDelta(0, 'tc-a', 'read_file', '{"path":"a.txt"}')),
        sse(toolCallDelta(1, 'tc-b', 'read_file', '{"path":"b.txt"}')),
        sse(finishChunk('stop')),
      ], textTurn('done')],
    })
    await runLoop(ports)
    expect(tools.execute).toHaveBeenCalledTimes(2)
    const assistant = session.messages.find((m) => m.role === 'assistant' && m.toolResults?.length)
    expect(assistant!.toolResults!.map((r) => r.content)).toEqual(['A-RESULT', 'B-RESULT'])
  })
})

// ═══════════════ runReactLoop · 权限与运行时防护 ═══════════════

describe('runReactLoop · 权限与运行时防护', () => {
  it('full 档：危险命令免确认直接执行（cwd 注入）', async () => {
    const { ports, tools, permission } = makePorts({
      settings: { approvalMode: 'full' },
      turns: [toolTurn('execute_command', { command: 'rm -rf /tmp/x' }), textTurn('done')],
    })
    await runLoop(ports)
    expect(permission.confirm).not.toHaveBeenCalled()
    expect(tools.execute).toHaveBeenCalledTimes(1)
    const [name, args] = tools.execute.mock.calls[0]
    expect(name).toBe('execute_command')
    expect(args).toHaveProperty('cwd')
  })

  it('manual 档：危险命令弹确认，用户取消 → 拒绝执行并通知', async () => {
    const { ports, tools, permission, store, session } = makePorts({
      settings: { approvalMode: 'manual' },
      turns: [toolTurn('execute_command', { command: 'rm -rf /tmp/x' }), textTurn('done')],
    })
    permission.confirm.mockResolvedValueOnce(false)
    await runLoop(ports)
    expect(permission.confirm).toHaveBeenCalledTimes(1)
    expect(tools.execute).not.toHaveBeenCalled()
    // 危险命令确认流：先标 confirm-danger + 通知，取消后恢复 working
    expect(store.setStatus).toHaveBeenCalledWith('s1', 'confirm-danger')
    expect(store.setStatus).toHaveBeenCalledWith('s1', 'working')
    const toolMsg = session.messages.find((m) => m.role === 'tool')
    expect(toolMsg!.toolResults![0].isError).toBe(true)
  })

  it('manual 档：危险命令确认通过 → 执行', async () => {
    const { ports, tools, permission } = makePorts({
      settings: { approvalMode: 'manual' },
      turns: [toolTurn('execute_command', { command: 'rm -rf /tmp/x' }), textTurn('done')],
    })
    await runLoop(ports)
    expect(permission.confirm).toHaveBeenCalledTimes(1)
    expect(tools.execute).toHaveBeenCalledTimes(1)
  })

  it('plan 模式只读：write_file 拒绝、read_file 放行', async () => {
    const { ports, tools, session } = makePorts({
      turns: [
        toolTurn('write_file', { path: 'out.txt', content: 'x' }),
        toolTurn('read_file', { path: 'a.txt' }),
        textTurn('done'),
      ],
    })
    await runLoop(ports, { taskMode: 'plan' })
    const names = tools.execute.mock.calls.map((c) => c[0])
    expect(names).toEqual(['read_file'])
    const firstToolMsg = session.messages.find((m) => m.role === 'tool')!
    expect(firstToolMsg.toolResults![0].isError).toBe(true)
  })

  it('spec 模式：仅允许写入 .clerkbox/specs，禁止目录外写入与命令执行', async () => {
    // 目录内写入放行
    const inside = makePorts({
      turns: [toolTurn('write_file', { path: '.clerkbox\\specs\\plan.md', content: 'x' }), textTurn('done')],
    })
    await runLoop(inside.ports, { taskMode: 'spec' })
    expect(inside.tools.execute).toHaveBeenCalledTimes(1)

    // 目录外写入拒绝
    const outside = makePorts({
      turns: [toolTurn('write_file', { path: 'outside.txt', content: 'x' }), textTurn('done')],
    })
    await runLoop(outside.ports, { taskMode: 'spec' })
    expect(outside.tools.execute).not.toHaveBeenCalled()
    const refused = outside.session.messages.find((m) => m.role === 'tool')!
    expect(refused.toolResults![0].isError).toBe(true)

    // 命令一律拒绝
    const cmd = makePorts({
      turns: [toolTurn('execute_command', { command: 'echo hi' }), textTurn('done')],
    })
    await runLoop(cmd.ports, { taskMode: 'spec' })
    expect(cmd.tools.execute).not.toHaveBeenCalled()
  })

  it('残缺参数保护：JSON 解析失败（_raw）→ 本轮全部工具调用拒绝', async () => {
    const { ports, tools, session } = makePorts({
      turns: [[
        sse(toolCallDelta(0, 'tc1', 'write_file', '{"path": "a.txt', )),
        sse(finishChunk('stop')),
      ], textTurn('done')],
    })
    await runLoop(ports)
    expect(tools.execute).not.toHaveBeenCalled()
    const toolMsg = session.messages.find((m) => m.role === 'tool')
    expect(toolMsg!.toolResults![0].isError).toBe(true)
    expect(toolMsg!.content).toContain('was not executed')
  })

  it('截断保护：finish_reason=length → 工具调用一律不执行', async () => {
    const { ports, tools, session } = makePorts({
      turns: [[
        sse(toolCallDelta(0, 'tc1', 'write_file', '{"path": "a.txt", "content": "full"}')),
        sse(finishChunk('length')),
      ], textTurn('done')],
    })
    await runLoop(ports)
    expect(tools.execute).not.toHaveBeenCalled()
    const toolMsg = session.messages.find((m) => m.role === 'tool')
    expect(toolMsg!.toolResults![0].isError).toBe(true)
    expect(toolMsg!.content).toContain('output token limit')
  })

  it('doom-loop：连续第 3 次完全相同的调用被拒绝', async () => {
    const sameTurn = toolTurn('read_file', { path: 'a.txt' })
    const { ports, tools, session } = makePorts({
      turns: [sameTurn, sameTurn, sameTurn, textTurn('done')],
    })
    await runLoop(ports)
    expect(tools.execute).toHaveBeenCalledTimes(2)
    const toolMsgs = session.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(3)
    expect(toolMsgs[2].toolResults![0].isError).toBe(true)
    expect(toolMsgs[2].content).toContain('already been made repeatedly')
  })

  it('轮次上限：工具执行满 100 轮后注入收尾指令并终止', async () => {
    const capTurn: Turn = (call) =>
      [sse(toolCallDelta(0, `tc${call}`, 'read_file', JSON.stringify({ path: `a${call}.txt` }))), sse(finishChunk('stop'))]
    const { ports, tools, session } = makePorts({ turns: [capTurn] })
    await runLoop(ports)
    // 每轮参数不同（绕过 doom-loop），恰好执行 100 次
    expect(tools.execute).toHaveBeenCalledTimes(100)
    // 收尾轮拒绝执行 + 兜底终止消息（注：agent.maxTurnsTerminated 在两份 locale 均缺失，i18n 回落为 key）
    const finalAssistant = session.messages.at(-1)!
    expect(finalAssistant.role).toBe('assistant')
    expect(finalAssistant.content.length).toBeGreaterThan(0)
    expect(finalAssistant.toolCalls).toBeUndefined()
  })
})

// ═══════════════ runReactLoop · 重试与恢复 ═══════════════

describe('runReactLoop · 重试与恢复', () => {
  it('429 瞬时错误：单轮内指数退避重试后成功', async () => {
    const { ports, model, session } = makePorts({
      turns: [
        new Error('API Error 429 (retry after 1ms): rate limited'),
        textTurn('ok-after-retry'),
      ],
    })
    await runLoop(ports)
    expect(model.stream).toHaveBeenCalledTimes(2)
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].content).toBe('ok-after-retry')
    expect(session.messages[0]._retrying).toBeUndefined()
  })

  it('重试耗尽：错误上抛，流未建立时不残留占位消息', async () => {
    const { ports, model, session } = makePorts({
      turns: [new Error('API Error 429 (retry after 1ms): always down')],
    })
    await expect(runLoop(ports)).rejects.toThrow('API Error 429')
    expect(model.stream).toHaveBeenCalledTimes(6) // 1 + 5 retries
    // 占位消息在流成功建立后才创建；连接失败重试耗尽 → 无残留
    expect(session.messages).toHaveLength(0)
  })

  it('流中途 abort：不执行任何工具，无工具消息', async () => {
    const ctx = new SessionContext('s1')
    const controller = new AbortController()
    const { ports, tools, session } = makePorts({
      turns: [() => (async function* () {
        yield sse(toolCallDelta(0, 'tc1', 'read_file', '{"path":"a.txt"}'))
        controller.abort()
        yield sse(finishChunk('stop'))
      })()],
    })
    await runReactLoop(ports, ctx, [userMsg()], controller)
    expect(tools.execute).not.toHaveBeenCalled()
    expect(session.messages.some((m) => m.role === 'tool')).toBe(false)
    expect(session.messages[0]._isStreaming).toBeFalsy()
  })

  it('上下文溢出：强制压缩一次后重放请求成功', async () => {
    compactConversationMock.mockResolvedValueOnce({
      boundaryMessage: { id: 'b1', role: 'system', content: 'compact-boundary', timestamp: 1, isCompactSummary: true },
      summaryMessage: { id: 'sum1', role: 'user', content: 'SUMMARY-TEXT', timestamp: 1, isCompactSummary: true },
      fileAttachments: [],
      preCompactTokenCount: 99999,
      postCompactTokenCount: 10,
    })
    const { ports, model, session, store } = makePorts({
      turns: [
        new Error('API Error 400: prompt is too long'),
        textTurn('recovered'),
      ],
    })
    await runLoop(ports)
    expect(compactConversationMock).toHaveBeenCalledTimes(1)
    expect(store.compact).toHaveBeenCalledTimes(1)
    expect(model.stream).toHaveBeenCalledTimes(2)
    // 重放请求携带压缩摘要
    const body2 = model.bodies[1] as Record<string, any>
    const msgs2 = body2.messages as Array<Record<string, any>>
    expect(msgs2.some((m) => m.content === 'SUMMARY-TEXT')).toBe(true)
    expect(session.messages.at(-1)!.content).toBe('recovered')
    // 压缩占位消息已被 compact 原子替换，不残留 _isCompacting
    expect(session.messages.every((m) => !m._isCompacting)).toBe(true)
  })

  it('自动压缩阈值：超预算长对话在请求前压缩', async () => {
    compactConversationMock.mockResolvedValueOnce({
      boundaryMessage: { id: 'b1', role: 'system', content: 'compact-boundary', timestamp: 1, isCompactSummary: true },
      summaryMessage: { id: 'sum1', role: 'user', content: 'SUMMARY-TEXT', timestamp: 1, isCompactSummary: true },
      fileAttachments: [],
      preCompactTokenCount: 99999,
      postCompactTokenCount: 10,
    })
    // 预算 1000 → 阈值 max(1000-20000, 800)=800；14 条 × 400 token（600 个 CJK 字符）= 5600 > 800
    const big = '长'.repeat(600)
    const messages = Array.from({ length: 14 }, (_, i) =>
      ({ id: `u${i}`, role: 'user' as const, content: big, timestamp: i }))
    const { ports, model, store } = makePorts({
      settings: { maxInputTokens: 1000 },
      turns: [textTurn('after-compact')],
    })
    const { ctx } = await runLoop(ports, { messages })
    expect(compactConversationMock).toHaveBeenCalledTimes(1)
    expect(store.compact).toHaveBeenCalledTimes(1)
    expect(model.stream).toHaveBeenCalledTimes(1)
    // 压缩后 tracker 重置（本轮无 usage 回报）
    expect(ctx.tokenTracker.getLastUsage()).toBeNull()
  })

  it('压缩失败：回落截断继续请求，不残留压缩占位', async () => {
    compactConversationMock.mockRejectedValueOnce(new Error('compact api down'))
    const big = '长'.repeat(600)
    const messages = Array.from({ length: 14 }, (_, i) =>
      ({ id: `u${i}`, role: 'user' as const, content: big, timestamp: i }))
    const { ports, model, session } = makePorts({
      settings: { maxInputTokens: 1000 },
      turns: [textTurn('still-works')],
    })
    await runLoop(ports, { messages })
    expect(compactConversationMock).toHaveBeenCalledTimes(1)
    expect(model.stream).toHaveBeenCalledTimes(1)
    expect(session.messages.at(-1)!.content).toBe('still-works')
    expect(session.messages.every((m) => !m._isCompacting)).toBe(true)
  })
})

// ═══════════════ runSubAgentLoop ═══════════════

const testAgent: AgentDefinition = {
  agentType: 'explorer',
  name: 'Explorer',
  whenToUse: 'explore codebase',
  description: 'explorer agent',
  tools: ['read_file'],
  systemPrompt: 'SUB-SYSTEM-PROMPT',
  maxTurns: 5,
  source: 'built-in',
}

describe('runSubAgentLoop', () => {
  it('正常完成：system prompt 覆盖、白名单工具执行、结果回流', async () => {
    const { ports, model, ui, tools } = makePorts({
      findAgent: testAgent,
      turns: [toolTurn('read_file', { path: 'a.txt' }), textTurn('SUB-RESULT')],
    })
    const ctx = new SessionContext('s1')
    const result = await runSubAgentLoop(ports, ctx, 'explorer', 'explore this', new AbortController())
    expect(result).toBe('SUB-RESULT')
    expect(ui.addSubAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({
      agentType: 'explorer',
      status: 'running',
      prompt: 'explore this',
    }))
    expect(ui.completeSubAgentRun).toHaveBeenCalledWith('s1', expect.any(String), 'SUB-RESULT')
    // 子 agent 请求：system 为 agent 自带 prompt，且注入工作目录解析后的路径
    const body = model.bodies[0] as Record<string, any>
    expect((body.messages as Array<Record<string, any>>)[0]).toMatchObject({
      role: 'system',
      content: 'SUB-SYSTEM-PROMPT',
    })
    expect(tools.execute).toHaveBeenCalledWith('read_file', expect.objectContaining({}), expect.anything())
  })

  it('未知 agent 类型：抛出且不注册运行卡片', async () => {
    const { ports, ui } = makePorts({ findAgent: null })
    const ctx = new SessionContext('s1')
    await expect(runSubAgentLoop(ports, ctx, 'ghost', 'p', new AbortController())).rejects.toThrow()
    expect(ui.addSubAgentRun).not.toHaveBeenCalled()
  })

  it('工具白名单外的调用被拒绝执行', async () => {
    const { ports, tools, ui } = makePorts({
      findAgent: testAgent,
      turns: [toolTurn('write_file', { path: 'a.txt', content: 'x' }), textTurn('done')],
    })
    const ctx = new SessionContext('s1')
    const result = await runSubAgentLoop(ports, ctx, 'explorer', 'p', new AbortController())
    expect(result).toBe('done')
    expect(tools.execute).not.toHaveBeenCalled()
    expect(ui.completeSubAgentRun).toHaveBeenCalled()
  })

  it('父 controller abort：返回 [aborted] 并标记运行中止', async () => {
    const parentController = new AbortController()
    const { ports, ui, tools } = makePorts({
      findAgent: testAgent,
      turns: [() => (async function* () {
        yield sse(toolCallDelta(0, 'tc1', 'read_file', '{"path":"a.txt"}'))
        parentController.abort()
        yield sse(finishChunk('stop'))
      })()],
    })
    const ctx = new SessionContext('s1')
    const result = await runSubAgentLoop(ports, ctx, 'explorer', 'p', parentController)
    expect(result).toBe('[aborted]')
    expect(ui.abortSubAgentRun).toHaveBeenCalledWith('s1', expect.any(String))
    expect(tools.execute).not.toHaveBeenCalled()
  })

  it('模型非重试错误：failSubAgentRun 并上抛', async () => {
    const { ports, ui } = makePorts({
      findAgent: testAgent,
      turns: [new Error('API Error 400: bad request')],
    })
    const ctx = new SessionContext('s1')
    await expect(runSubAgentLoop(ports, ctx, 'explorer', 'p', new AbortController()))
      .rejects.toThrow('API Error 400')
    expect(ui.failSubAgentRun).toHaveBeenCalledWith('s1', expect.any(String), 'API Error 400: bad request')
  })
})

// ═══════════════ goal 评估闭环 ═══════════════

const activeGoal: SessionGoal = {
  condition: 'write tests',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  evaluations: 0,
}

describe('runReactLoop · goal 评估闭环', () => {
  it('评估器判定 achieved：终态卡片 + 目标置达成', async () => {
    const { ports, model, goal, session } = makePorts({
      goalState: activeGoal,
      turns: [
        textTurn('work done'),
        textTurn('{"verdict":"achieved","reason":"all tests pass"}'),
      ],
    })
    await runLoop(ports, { taskMode: 'goal' })
    expect(model.stream).toHaveBeenCalledTimes(2) // 主回复 + 评估器
    // 评估器请求：system 为评估器提示词
    const evalBody = model.bodies[1] as Record<string, any>
    expect((evalBody.messages as Array<Record<string, any>>)[0].role).toBe('system')
    expect(goal.updateGoal).toHaveBeenCalledWith('s1', expect.objectContaining({
      status: 'achieved',
      conclusion: 'all tests pass',
    }))
    const card = session.messages.find((m) => m.goalEvent)
    expect(card?.goalEvent).toMatchObject({ verdict: 'achieved', reason: 'all tests pass' })
  })

  it('评估器判定 in_progress：注入续跑消息后自动继续，直至达成', async () => {
    const { ports, model, goal, session } = makePorts({
      goalState: activeGoal,
      turns: [
        textTurn('attempting'),
        textTurn('{"verdict":"in_progress","reason":"keep going"}'),
        textTurn('more work'),
        textTurn('{"verdict":"achieved","reason":"done now"}'),
      ],
    })
    await runLoop(ports, { taskMode: 'goal' })
    expect(model.stream).toHaveBeenCalledTimes(4) // 主1 + 评估1 + 主2 + 评估2
    // 续跑引导作为 user 消息入库（初始消息不经过 addMessage）
    expect(session.messages.some((m) => m.role === 'user')).toBe(true)
    expect(goal.updateGoal).toHaveBeenLastCalledWith('s1', expect.objectContaining({
      status: 'achieved',
      conclusion: 'done now',
    }))
    const cards = session.messages.filter((m) => m.goalEvent)
    expect(cards.at(-1)!.goalEvent).toMatchObject({ verdict: 'achieved' })
  })

  it('[GOAL_COMPLETE] 快速通道：跳过评估器直接达成', async () => {
    const { ports, model, goal, session } = makePorts({
      goalState: activeGoal,
      turns: [textTurn('final report [GOAL_COMPLETE]')],
    })
    await runLoop(ports, { taskMode: 'goal' })
    expect(model.stream).toHaveBeenCalledTimes(1) // 不跑评估器
    expect(goal.updateGoal).toHaveBeenCalledWith('s1', expect.objectContaining({
      status: 'achieved',
    }))
    // 完成标记从展示内容剥离
    const finalAssistant = session.messages.find((m) => m.role === 'assistant')!
    expect(finalAssistant.content).toBe('final report')
    expect(session.messages.some((m) => m.goalEvent?.verdict === 'achieved')).toBe(true)
  })
})
