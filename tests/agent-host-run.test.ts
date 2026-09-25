/**
 * 宿主运行闭环（批次 B · P4 前置验证）
 *
 * 用真的 AgentSessionManager + 真的 agent-core 循环 + 真的 ipc-client 宿主桥，
 * 只把最外层两样换成假的：api-proxy 的模型流、ChatStore 落库。目的是在动渲染层
 * 之前把"指令进 → 带 seq 事件出 → 消息落库 → 运行收尾"这条链跑实。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStore } from '../electron/db'

/** 记录被发出的 SSE 分片请求，并按脚本回吐分片 */
const streamCalls: Array<{ requestId: string; body: unknown }> = []
let script: Array<{ chunk?: string; done?: boolean; error?: string }> = []

vi.mock('../electron/api-proxy', () => ({
  startChatStream: (_cfg: unknown, _body: unknown, requestId: string, send: (p: Record<string, unknown>) => void) => {
    streamCalls.push({ requestId, body: _body })
    for (const payload of script) send({ requestId, ...payload })
  },
  abortChatStream: vi.fn(),
}))

import { AgentSessionManager, installAgentHostBridge } from '../electron/agent-host'
import type { AgentEvent } from '../src/agent-core/protocol'
import type { AgentSettings } from '../src/agent-core/ports'

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function textStream(text: string) {
  return [
    { chunk: sse({ choices: [{ delta: { content: text }, finish_reason: null }] }) },
    { chunk: sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) },
    { done: true },
  ]
}

function fakeStore() {
  const rows: Array<Record<string, unknown>> = []
  const store = {
    kind: 'sqlite',
    getMessages: vi.fn(async () => rows.filter((r) => r.session_id === 's1')),
    getAllSessions: vi.fn(async () => [{ id: 's1', title: '测试会话', created_at: 1, updated_at: 1, working_dir: process.cwd(), default_work_dir: process.cwd(), harness_mode: 'default' }]),
    addMessage: vi.fn(async (row: Record<string, unknown>) => {
      rows.push(row)
    }),
    updateMessage: vi.fn(async () => undefined),
    compactMessages: vi.fn(async () => undefined),
  }
  return { store: store as unknown as ChatStore, rows }
}

const settings: AgentSettings = {
  model: 'test-model',
  apiCompat: 'openai',
  baseUrl: 'https://api.invalid.test/v1',
  apiKey: 'sk-test',
  directFetch: false,
  temperature: 0.7,
  maxTokens: 1024,
  maxInputTokens: 184000,
  approvalMode: 'auto',
  enableThinking: false,
  providers: [],
  activeProviderId: undefined,
  activeModelId: undefined,
  agentsMdEnabled: false,
  claudeMdCompat: false,
}

function kinds(events: AgentEvent[]): string[] {
  return events.map((e) => e.type)
}

beforeEach(() => {
  streamCalls.length = 0
  script = []
  installAgentHostBridge()
})

describe('宿主跑完一轮纯文本对话', () => {
  it('run 指令 → 事件带单调 seq 入环 → 用户消息落库 → run.completed', async () => {
    script = textStream('收到')
    const { store, rows } = fakeStore()
    const m = new AgentSessionManager(store)
    const res = await m.handleCommand({ type: 'run', sessionId: 's1', content: '说句话', settings })
    expect(res.ok).toBe(true)

    const ring = m.peekRing('s1')
    const types = kinds(ring)
    expect(types[0]).toBe('run.started')
    expect(types).toContain('message.added')
    expect(types[types.length - 1]).toBe('run.status')
    expect(types).toContain('run.completed')

    // seq 必须严格递增，渲染层靠它判缺口
    const seqs = ring.map((_, i) => i)
    expect(seqs.length).toBeGreaterThan(3)

    // 用户消息真的落库了（宿主独占运行期写入）
    expect(rows.some((r) => r.role === 'user' && r.content === '说句话')).toBe(true)
    // 收尾后不在运行态
    expect(m.inspect()[0]).toMatchObject({ sessionId: 's1', status: 'idle', hasRun: false })
  })

  it('流式正文走 stream.delta 增量回流，不再逐帧把全文搬过进程边界', async () => {
    script = [
      { chunk: sse({ choices: [{ delta: { content: '第一段' }, finish_reason: null }] }) },
      { chunk: sse({ choices: [{ delta: { content: '第二段' }, finish_reason: null }] }) },
      { chunk: sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
      { done: true },
    ]
    const m = new AgentSessionManager(fakeStore().store)
    await m.handleCommand({ type: 'run', sessionId: 's1', content: 'hi', settings })
    const ring = m.peekRing('s1')
    const deltas = ring.filter((e): e is Extract<AgentEvent, { type: 'stream.delta' }> => e.type === 'stream.delta')
    expect(deltas.length).toBeGreaterThan(0)
    // 协议里一直挂着 stream.delta，却没有生产者：宿主只能靠 message.updated 携带「已累计全文」
    // 逐帧外发，长回答既是指数字节的 structured clone，也是环溢出的主因。
    expect(deltas.map((d) => d.text).join('')).toContain('第一段')
    const fullContent = ring.filter(
      (e) => e.type === 'message.updated' && typeof (e as { updates?: { content?: string } }).updates?.content === 'string'
    )
    expect(fullContent.length).toBeLessThanOrEqual(2) // 只容许收尾覆盖与最终落库那两次
  })

  it('模型请求体带上了下发的设置快照，而不是猜默认值', async () => {
    script = textStream('ok')
    const m = new AgentSessionManager(fakeStore().store)
    await m.handleCommand({ type: 'run', sessionId: 's1', content: 'hi', settings })
    expect(streamCalls).toHaveLength(1)
    const body = streamCalls[0].body as { model: string; messages: unknown[] }
    expect(body.model).toBe('test-model')
    expect(Array.isArray(body.messages)).toBe(true)
    expect((body.messages as Array<{ role: string }>).length).toBeGreaterThan(1)
  })

  it('缺 settings 的 run 明确拒收，不启动任何流', async () => {
    const m = new AgentSessionManager(fakeStore().store)
    const res = await m.handleCommand({ type: 'run', sessionId: 's1', content: 'hi' })
    expect(res).toEqual({ ok: false, error: 'run-command-missing-settings' })
    expect(streamCalls).toHaveLength(0)
  })
})

describe('宿主侧中断与排队', () => {
  it('abort 落到 run.aborted 并释放运行位', async () => {
    // 只给半条流且不收尾：循环会挂在等待上，正好给 abort 留窗口
    script = [{ chunk: sse({ choices: [{ delta: { content: '半' }, finish_reason: null }] }) }]
    const m = new AgentSessionManager(fakeStore().store)
    const running = m.handleCommand({ type: 'run', sessionId: 's1', content: 'hi', settings })
    await vi.waitFor(() => expect(streamCalls.length).toBe(1))
    await m.handleCommand({ type: 'abort', sessionId: 's1' })
    await running
    const types = kinds(m.peekRing('s1'))
    expect(types).toContain('run.aborted')
    expect(m.inspect()[0]).toMatchObject({ status: 'idle', hasRun: false })
  })

  it('运行中再来一条按 FIFO 入队，中断后队首自动接手', async () => {
    script = [{ chunk: sse({ choices: [{ delta: { content: 'x' }, finish_reason: null }] }) }]
    const { store, rows } = fakeStore()
    const m = new AgentSessionManager(store)
    const first = m.handleCommand({ type: 'run', sessionId: 's1', content: '第一条', settings })
    await vi.waitFor(() => expect(streamCalls.length).toBe(1))
    const second = await m.handleCommand({ type: 'run', sessionId: 's1', content: '第二条', settings })
    expect(second.ok).toBe(true)
    expect(m.inspect()[0]).toMatchObject({ hasRun: true, queued: 1 })

    await m.handleCommand({ type: 'abort', sessionId: 's1' })
    await first
    // 排队语义：中断释放运行位后，队首自动发出，不丢消息也不并发
    await vi.waitFor(() => expect(streamCalls.length).toBe(2))
    expect(m.inspect()[0].queued).toBe(0)
    const userRows = rows.filter((r) => r.role === 'user').map((r) => r.content)
    expect(userRows).toEqual(['第一条', '第二条'])
  })
})
