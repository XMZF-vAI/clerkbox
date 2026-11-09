/**
 * 宿主运行期生命周期（BE-03 / BE-06）。
 *
 * 两条都发生在「宿主已经在跑、用户又从别处下手」的交叉口：
 * - BE-03：手动压缩与新运行没有共用互斥。压缩结束时会拿开头那份消息快照整段替换本会话消息，
 *   压缩期间并发跑一轮，新消息就被旧快照覆盖。
 * - BE-06：删除正在等待审批/提问的会话，只清了 timer 与 Map，没有兑现等待中的 Promise，
 *   于是 ReAct 循环的闭包与外部等待者永远挂着。
 *
 * 骨架沿用 agent-host-permission.test.ts：模型流与工具注册表整个换成假的，
 * 被测的两件事都不需要真的起 shell。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ChatStore } from '../electron/db'
import type { AgentSettings } from '../src/agent-core/ports'

type SsePayload = { chunk?: string; done?: boolean; error?: string }
const h = vi.hoisted(() => ({
  turns: [] as SsePayload[][],
  calls: 0,
}))

vi.mock('../electron/api-proxy', () => ({
  startChatStream: (_cfg: unknown, _body: unknown, requestId: string, send: (p: Record<string, unknown>) => void) => {
    for (const payload of h.turns[h.calls++] ?? []) send({ requestId, ...payload })
  },
  abortChatStream: vi.fn(),
}))

vi.mock('../src/lib/tool-registry', () => ({
  toolRegistry: {
    getDefinitionsForMode: () => [],
    setAgentActionCapabilities: () => {},
    execute: vi.fn(async () => 'tool ok'),
    findAgent: async () => null,
  },
}))

// 压缩走的是非流式 postJson（src/lib/compact.ts），不是宿主那条流。
// 把它挂成一个永不 resolve 的 Promise，压缩就停在「等摘要」这一步——
// 正是 BE-03 要防的那个窗口：压缩在飞，同时来了新任务。
vi.mock('../src/lib/api-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api-transport')>()
  return { ...actual, postJson: vi.fn(() => new Promise(() => {})) }
})

import { AgentSessionManager, installAgentHostBridge, setAgentHostWindowProbeForTest } from '../electron/agent-host'
import { toolRegistry } from '../src/lib/tool-registry'
import type { AgentEvent } from '../src/agent-core/protocol'
import type { BrowserWindow } from 'electron'

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const toolTurn = (name: string, args: Record<string, unknown>) => [
  {
    chunk: sse({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    }),
  },
  { chunk: sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
  { done: true },
]
const textTurn = (text: string) => [
  { chunk: sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }) },
  { done: true },
]

/** 有历史消息的假库：压缩需要足够多��消息才会真的去调模型 */
function fakeStore(workingDir: string, seed = 0): ChatStore {
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < seed; i += 1) {
    rows.push({ id: `seed${i}`, session_id: 's1', role: i % 2 === 0 ? 'user' : 'assistant', content: `历史 ${i}`, timestamp: 1000 + i })
  }
  return {
    kind: 'sqlite',
    getMessages: vi.fn(async () => rows.filter((r) => r.session_id === 's1')),
    getAllSessions: vi.fn(async () => [
      {
        id: 's1',
        title: '测试会话',
        created_at: 1,
        updated_at: 1,
        working_dir: workingDir,
        default_work_dir: workingDir,
        harness_mode: 'default',
      },
    ]),
    addMessage: vi.fn(async (row: Record<string, unknown>) => {
      rows.push(row)
    }),
    updateMessage: vi.fn(async () => undefined),
    compactMessages: vi.fn(async () => undefined),
  } as unknown as ChatStore
}

const settings = {
  model: 'test-model',
  apiCompat: 'openai',
  baseUrl: 'https://api.invalid.test/v1',
  apiKey: 'sk-test',
  directFetch: false,
  temperature: 0.7,
  maxTokens: 1024,
  maxInputTokens: 184000,
  approvalMode: 'manual',
  enableThinking: false,
  providers: [],
} as unknown as AgentSettings

const DANGER = { command: 'rm -rf target' }

let workDir: string
let sent: AgentEvent[]

beforeEach(() => {
  h.turns = []
  h.calls = 0
  vi.mocked(toolRegistry.execute).mockClear()
  sent = []
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerkbox-lifecycle-'))
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, payload: { seq: number; event: AgentEvent }) => sent.push(payload.event),
    },
  } as unknown as BrowserWindow
  setAgentHostWindowProbeForTest(() => [win])
  installAgentHostBridge()
})

afterEach(() => {
  setAgentHostWindowProbeForTest(null)
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
})

const requested = () => sent.filter((e) => e.type === 'permission.requested')
const addMessageCalls = (store: ChatStore): number =>
  (store.addMessage as unknown as { mock: { calls: unknown[] } }).mock.calls.length

describe('BE-06 删除会话时兑现等待中的 Promise', () => {
  it('待批期间删除会话：等待收尾、工具不执行、迟到回调不再写库', async () => {
    h.turns = [toolTurn('execute_command', DANGER), textTurn('收尾')]
    const store = fakeStore(workDir)
    const m = new AgentSessionManager(store)
    const running = m.handleCommand({ type: 'run', sessionId: 's1', content: '跑一下', settings })

    await vi.waitFor(() => expect(requested()).toHaveLength(1))
    const before = addMessageCalls(store)

    m.dropSession('s1')

    // 回归点：旧实现只清 timer 与 Map，等待审批的 Promise 永远不返回，
    // 于是这里的 await 永远挂着，ReAct 循环的闭包也一起泄漏。
    await running

    expect(toolRegistry.execute).not.toHaveBeenCalled()
    expect(m.inspect()).toHaveLength(0)
    // 会话已删：迟到的回调不许再往库里写消息（那等于把用户删掉的会话复活）
    expect(addMessageCalls(store)).toBe(before)
  })

  it('删除后再来的 permission.resolve 按 stale-request 拒收，不复活会话', async () => {
    h.turns = [toolTurn('execute_command', DANGER), textTurn('收尾')]
    const store = fakeStore(workDir)
    const m = new AgentSessionManager(store)
    const running = m.handleCommand({ type: 'run', sessionId: 's1', content: '跑一下', settings })
    await vi.waitFor(() => expect(requested()).toHaveLength(1))
    const [req] = requested() as Array<Extract<AgentEvent, { type: 'permission.requested' }>>

    m.dropSession('s1')
    await running

    expect(await m.handleCommand({ type: 'permission.resolve', sessionId: 's1', requestId: req.requestId, approved: true }))
      .toEqual({ ok: false, error: 'stale-request' })
  })
})

describe('BE-03 手动压缩与新运行共用互斥', () => {
  it('运行进行中不受理手动压缩（压缩会用旧快照整段替换消息）', async () => {
    h.turns = [toolTurn('execute_command', DANGER), textTurn('收尾')]
    const store = fakeStore(workDir, 12)
    const m = new AgentSessionManager(store)
    const running = m.handleCommand({ type: 'run', sessionId: 's1', content: '跑一下', settings })
    await vi.waitFor(() => expect(requested()).toHaveLength(1))

    await m.handleCommand({ type: 'manual.compact', sessionId: 's1' })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(store.compactMessages).not.toHaveBeenCalled()

    const [req] = requested() as Array<Extract<AgentEvent, { type: 'permission.requested' }>>
    await m.handleCommand({ type: 'permission.resolve', sessionId: 's1', requestId: req.requestId, approved: false })
    await running
  })

  it('压缩进行中提交的新任务排队，不与压缩并发', async () => {
    // 第一轮跑完并灌入设置快照；摘要流不给 done → 压缩一直挂着
    h.turns = [textTurn('第一轮'), [{ chunk: sse({ choices: [{ delta: { content: '摘要' } }] }) }]]
    const store = fakeStore(workDir, 12)
    const m = new AgentSessionManager(store)
    await m.handleCommand({ type: 'run', sessionId: 's1', content: '第一轮', settings })

    await m.handleCommand({ type: 'manual.compact', sessionId: 's1' })
    await vi.waitFor(() => expect(m.inspect().find((s) => s.sessionId === 's1')?.compacting).toBe(true))

    // 压缩期间提交新任务：必须排队，不能并发开跑
    await m.handleCommand({ type: 'run', sessionId: 's1', content: '压缩期间来的', settings })
    const state = m.inspect().find((s) => s.sessionId === 's1')
    expect(state?.queued).toBe(1)
    expect(state?.hasRun).toBe(false)
    // 压缩没有并发开跑：工具层不该被第二次调用
    expect(toolRegistry.execute).not.toHaveBeenCalled()
  })
})
