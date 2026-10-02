/**
 * loop 侧采集接线单测：工具批次跑完后，锚点用户消息上必须挂着这一轮的快照账本。
 *
 * 钉住四件容易悄悄断掉的事：
 * 1. 每个工具批次结束就增量刷一次账本，而不是等整轮跑完 —— 用户中途按停止时，
 *    已经写到磁盘的文件必须已经有对应快照，否则「崩一次就永久无法回滚」。
 * 2. 子 agent 的写文件也进同一本账（回滚父轮时要连它写的一起滚掉）。
 * 3. shell / 未跟踪工具只要成功就记缺口，带文件的撤回随之 fail-closed。
 * 4. 换新一轮必须重开账本，上一轮的快照不能算进这一轮的范围。
 */
import { describe, it, expect, vi } from 'vitest'
import { runReactLoop } from '../src/agent-core/loop'
import { SessionContext } from '../src/agent-core/session-context'
import type { AgentPorts, AgentSettings, AgentStorePort } from '../src/agent-core/ports'
import type { FileMutation, Message, Session, ToolDefinition } from '../src/types/agent'

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const textDelta = (content: string) => ({ choices: [{ delta: { content } }] })
const toolCallDelta = (index: number, id: string, name: string, args: string) => ({
  choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { ...(name ? { name } : {}), arguments: args } }] } }],
})
const finishChunk = (reason: string) => ({ choices: [{ delta: {}, finish_reason: reason }] })
const streamOf = async function* (lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line
}
const textTurn = (text: string) => [sse(textDelta(text)), sse(finishChunk('stop'))]
const toolTurn = (name: string, args: Record<string, unknown>, id = 'tc1') =>
  [sse(toolCallDelta(0, id, name, JSON.stringify(args))), sse(finishChunk('stop'))]

const settings: AgentSettings = {
  model: 'test-model',
  apiCompat: 'openai',
  activeProviderId: 'p1',
  activeModelId: 'test-model',
  providers: [{ id: 'p1', name: 'Test', apiCompat: 'openai', baseUrl: 'http://localhost', apiKey: 'sk-test', models: [{ id: 'test-model' }] }],
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
}

const TOOLS: ToolDefinition[] = [
  { name: 'write_file', description: 'w', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'execute_command', description: 'e', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'read_file', description: 'r', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]

interface HarnessOptions {
  turns: string[][]
  /**
   * 本轮之前的对话（真实路径里 sendMessage 会先把用户消息 addMessage 进 store 再跑循环，
   * 循环只从 store 更新锚点，所以这里也必须先把它塞进 session.messages）
   */
  history?: Message[]
  /** 假工具注册表：模拟真实工具在成功写入后回调 recordFileMutation */
  onExecute?: (name: string, args: Record<string, unknown>, ctx: { toolCallId?: string; recordFileMutation?: (m: FileMutation) => Promise<void> }) => Promise<string>
  checkpoint?: AgentPorts['checkpoint']
}

function makeHarness(options: HarnessOptions) {
  const session: Session = {
    id: 's1',
    title: 't',
    messages: [...(options.history ?? [])],
    createdAt: 1,
    updatedAt: 1,
    workingDir: 'D:\\proj',
  }
  const store: AgentStorePort = {
    getSession: (sid) => (sid === session.id ? session : undefined),
    addMessage: (sid, msg) => { if (sid === session.id) session.messages.push(msg) },
    updateMessage: (sid, msgId, updates) => {
      const found = session.messages.find((m) => m.id === msgId)
      if (found) Object.assign(found, updates)
    },
    setStatus: vi.fn(),
    compact: vi.fn(),
  }
  let call = 0
  const model = {
    stream: vi.fn(async (): Promise<AsyncIterable<string>> => {
      const turn = options.turns[Math.min(call, options.turns.length - 1)]
      call += 1
      return streamOf(turn)
    }),
  }
  const ports: AgentPorts = {
    sessionId: session.id,
    settings,
    model,
    tools: {
      definitions: () => TOOLS,
      execute: async (name, args, ctx) => {
        if (options.onExecute) return options.onExecute(name, args, ctx as never)
        return '✅ ok'
      },
      findAgent: async () => null,
    },
    store,
    permission: { confirm: async () => ({ approved: true, scope: 'once' as const }) },
    ui: {
      askQuestion: async () => ({}),
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
    },
    goal: { get: () => undefined, setGoal: vi.fn(), updateGoal: vi.fn() },
    skills: { catalog: () => [] },
    env: {
      platform: 'win32',
      osDescription: 'Windows (test)',
      shellDescription: 'PowerShell',
      isDev: false,
      homeDir: () => 'C:\\Users\\tester',
      readFile: async () => '',
      readImageAsDataUrl: async () => null,
      runShell: async () => ({ exitCode: 1, stdout: '' }),
      buildMemoryPrompt: async () => '[memory]',
    },
    checkpoint: options.checkpoint,
    emit: vi.fn(),
  }
  return { ports, session }
}

/** 模拟真实 write_file：成功写盘后按 ToolContext 回调交出变更前正文 */
const emitWriteMutation = (before: string | null, after: string) =>
  async (_name: string, args: Record<string, unknown>, ctx: { toolCallId?: string; recordFileMutation?: (m: FileMutation) => Promise<void> }) => {
    await ctx.recordFileMutation?.({
      toolCallId: ctx.toolCallId ?? '',
      toolName: 'write_file',
      path: String(args.path),
      existedBefore: before !== null,
      before,
      after,
    })
    return `✅ File written: ${String(args.path)}`
  }

const saved = vi.fn(async (_sid: string, m: FileMutation) => ({
  checkpoint: {
    id: `ck-${m.path}`,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    path: m.path,
    existedBefore: m.existedBefore,
    beforeRef: m.existedBefore ? `ck-${m.path}.txt` : null,
    afterHash: `hash:${m.after}`,
    beforeBytes: m.before?.length ?? 0,
    createdAt: 1,
  },
  gap: null,
}))

function userMessage(content = '做个改动'): Message {
  return { id: 'u1', role: 'user', content, timestamp: 1 }
}

describe('锚点账本的采集', () => {
  it('write_file 成功后：快照挂在触发本轮的用户消息上，toolCallId 是循环给的那一个', async () => {
    const anchor = userMessage()
    const { ports } = makeHarness({
      history: [anchor],
      turns: [toolTurn('write_file', { path: 'D:\\proj\\a.ts', content: 'NEW' }), textTurn('改好了')],
      onExecute: emitWriteMutation('OLD', 'NEW'),
      checkpoint: { save: saved },
    })
    const ctx = new SessionContext('s1')
    await runReactLoop(ports, ctx, [anchor], new AbortController())

    expect(anchor.fileCheckpoints).toHaveLength(1)
    const [cp] = anchor.fileCheckpoints!
    expect(cp).toMatchObject({ id: 'ck-D:\\proj\\a.ts', toolCallId: 'tc1', toolName: 'write_file' })
  })

  it('宿主没装配 checkpoint 端口：记一条缺口而不是静默跳过，也不影响写入结果', async () => {
    const anchor = userMessage()
    const { ports, session } = makeHarness({
      history: [anchor],
      turns: [toolTurn('write_file', { path: 'D:\\proj\\a.ts', content: 'NEW' }), textTurn('改好了')],
      onExecute: emitWriteMutation('OLD', 'NEW'),
      // 故意不给 checkpoint
    })
    await runReactLoop(ports, new SessionContext('s1'), [anchor], new AbortController())
    expect(anchor.fileCheckpoints ?? []).toEqual([])
    expect(anchor.mutationGaps).toEqual([
      { toolName: 'write_file', path: 'D:\\proj\\a.ts', reason: 'untracked-tool' },
    ])
    // 采集失败不能污染工具结果本身
    expect(session.messages.some((m) => m.content.includes('File written'))).toBe(true)
  })

  it('shell 工具只要成功就记缺口，写失败的不记（失败没有改动）', async () => {
    const anchor = userMessage()
    const { ports } = makeHarness({
      history: [anchor],
      turns: [toolTurn('execute_command', { command: 'rm -rf build' }, 'tcShell'), textTurn('好的')],
      onExecute: async (name) => (name === 'execute_command' ? '✅ done' : 'ok'),
      checkpoint: { save: saved },
    })
    await runReactLoop(ports, new SessionContext('s1'), [anchor], new AbortController())
    expect(anchor.mutationGaps).toEqual([{ toolName: 'execute_command', reason: 'shell' }])
    expect(anchor.fileCheckpoints).toEqual([])

    const failedAnchor = userMessage()
    const failed = makeHarness({
      history: [failedAnchor],
      turns: [toolTurn('execute_command', { command: 'rm -rf build' }, 'tcShell'), textTurn('算了')],
      onExecute: async () => 'Error: command not found',
      checkpoint: { save: saved },
    })
    await runReactLoop(failed.ports, new SessionContext('s1'), [failedAnchor], new AbortController())
    expect(failedAnchor.mutationGaps ?? []).toEqual([])
  })

  it('中断发生在工具批次之后：本批次的快照已经落进消息，不等整轮跑完', async () => {
    const controller = new AbortController()
    const anchor = userMessage()
    const { ports } = makeHarness({
      history: [anchor],
      turns: [toolTurn('write_file', { path: 'D:\\proj\\a.ts', content: 'NEW' }), textTurn('不会被走到')],
      onExecute: async (name, args, ctx) => {
        const out = await emitWriteMutation('OLD', 'NEW')(name, args, ctx)
        // 写完文件立刻中断：模拟用户按停止
        controller.abort()
        return out
      },
      checkpoint: { save: saved },
    })
    await runReactLoop(ports, new SessionContext('s1'), [anchor], controller)
    expect(anchor.fileCheckpoints).toHaveLength(1)
  })

  it('同一会话连跑两轮：第二轮重开账本，不把第一轮的快照算进自己的范围', async () => {
    const ctx = new SessionContext('s1')
    const u1 = userMessage('第一轮')
    const first = makeHarness({
      history: [u1],
      turns: [toolTurn('write_file', { path: 'D:\\proj\\a.ts', content: 'A' }), textTurn('第一轮的')],
      onExecute: emitWriteMutation('OLD', 'A'),
      checkpoint: { save: saved },
    })
    await runReactLoop(first.ports, ctx, [u1], new AbortController())
    expect(u1.fileCheckpoints).toHaveLength(1)

    const u2 = { ...userMessage('第二轮'), id: 'u2' }
    const second = makeHarness({
      history: [u1, ...first.session.messages.slice(1), u2],
      turns: [textTurn('这一轮没写文件')],
      checkpoint: { save: saved },
    })
    await runReactLoop(second.ports, ctx, second.session.messages, new AbortController())
    expect(u2.fileCheckpoints ?? []).toEqual([])
    // 第一轮的账本没被改写
    expect(u1.fileCheckpoints).toHaveLength(1)
  })
})
