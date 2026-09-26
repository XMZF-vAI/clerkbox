/**
 * 宿主审批闭环（C2 阶段二）：requested → resolve → settled + 留痕 + 会话级放行。
 *
 * 只把最外层两样换成假的（模型流、落库），窗口用注入点假冒：
 * 「无窗口即 fail-closed」与「有窗口才挂起等待」是这段逻辑的全部价值，不能只靠 GUI 人肉验。
 * 命令本身是 `rm -rf target` —— 命中危险模式，但工作目录是临时目录，且 Windows 下 cmd 无 rm，
 * 批准分支不会真的删到任何东西。
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

// 工具注册表整个换成假的：审批链路不需要真的起 shell，
// 而「批准才执行」这件事正好靠它的调用次数来证。
vi.mock('../src/lib/tool-registry', () => ({
  toolRegistry: {
    getDefinitionsForMode: () => [],
    execute: vi.fn(async () => 'tool ok'),
    findAgent: async () => null,
  },
}))

import { AgentSessionManager, installAgentHostBridge, setAgentHostWindowProbeForTest } from '../electron/agent-host'
import { toolRegistry } from '../src/lib/tool-registry'
import { PERMISSION_AUDIT_PREFIX, parsePermissionAudit } from '../src/lib/permission-preview'
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

function fakeStore(workingDir: string): ChatStore {
  const rows: Array<Record<string, unknown>> = []
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
  // 工具注册表的 mock 是模块级单例，跨用例不清就会把上一轮的执行次数算到这一轮头上
  vi.mocked(toolRegistry.execute).mockClear()
  sent = []
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerkbox-perm-'))
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, payload: { seq: number; event: AgentEvent }) => sent.push(payload.event),
    },
  } as unknown as BrowserWindow
  setAgentHostWindowProbeForTest(() => [win])
  // 模型流走宿主桥（api-proxy 已被 mock）：不装桥的话 openChatStream 会去 fetch('/api/chat-stream')
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
const settled = () => sent.filter((e) => e.type === 'permission.settled')
const audits = (rows: Array<Record<string, unknown>>) =>
  rows
    .filter((r) => typeof r.content === 'string' && (r.content as string).startsWith(PERMISSION_AUDIT_PREFIX))
    .map((r) => parsePermissionAudit(r.content as string))

it('有窗口：请求带 tool/args 广播出去，批准后落 settled + 留痕，本轮不再重复询问', async () => {
  h.turns = [toolTurn('execute_command', DANGER), toolTurn('execute_command', DANGER), textTurn('收尾')]
  const store = fakeStore(workDir)
  const m = new AgentSessionManager(store)
  const running = m.handleCommand({ type: 'run', sessionId: 's1', content: '跑一下', settings })

  await vi.waitFor(() => expect(requested()).toHaveLength(1))
  const [req] = requested() as Array<Extract<AgentEvent, { type: 'permission.requested' }>>
  expect(req).toMatchObject({ tool: 'execute_command', reason: 'dangerous-command', risk: 'dangerous', sessionId: 's1' })
  expect(req.args).toEqual(DANGER)

  await m.handleCommand({ type: 'permission.resolve', sessionId: 's1', requestId: req.requestId, approved: true, scope: 'session' })
  await running

  expect(requested()).toHaveLength(1) // 会话级放行命中：第二个同样的危险命令没再打扰
  expect(settled()).toHaveLength(1)
  expect(settled()[0]).toMatchObject({ requestId: req.requestId, approved: true, timedOut: false })
  const rows = (store.addMessage as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls.map((c) => c[0])
  expect(audits(rows)[0]).toMatchObject({ decision: 'allow_session', tool: 'execute_command' })
  // 批准才执行：两轮同样的危险命令都进了工具层（第二轮靠放行集合，不经询问）
  expect(toolRegistry.execute).toHaveBeenCalledTimes(2)
})

it('拒绝路径：落 denied 留痕并广播 settled，不执行工具', async () => {
  h.turns = [toolTurn('execute_command', DANGER), textTurn('已取消')]
  const store = fakeStore(workDir)
  const m = new AgentSessionManager(store)
  const running = m.handleCommand({ type: 'run', sessionId: 's1', content: '跑一下', settings })
  await vi.waitFor(() => expect(requested()).toHaveLength(1))
  const [req] = requested() as Array<Extract<AgentEvent, { type: 'permission.requested' }>>
  const resultsBefore = (store.addMessage as unknown as { mock: { calls: unknown[] } }).mock.calls.length
  await m.handleCommand({ type: 'permission.resolve', sessionId: 's1', requestId: req.requestId, approved: false })
  await running
  expect(settled()[0]).toMatchObject({ approved: false, timedOut: false })
  const rows = (store.addMessage as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls.map((c) => c[0])
  expect(audits(rows).at(-1)).toMatchObject({ decision: 'deny' })
  expect(rows.length).toBeGreaterThan(resultsBefore)
  expect(toolRegistry.execute).not.toHaveBeenCalled() // 拒绝即不执行，不是"执行后回滚"
})

it('无窗口即 fail-closed：不广播待批事件，直接拒绝并留痕（UI 离线绝不是放行条件）', async () => {
  setAgentHostWindowProbeForTest(() => [])
  h.turns = [toolTurn('execute_command', DANGER), textTurn('结束')]
  const store = fakeStore(workDir)
  const m = new AgentSessionManager(store)
  await m.handleCommand({ type: 'run', sessionId: 's1', content: '跑一下', settings })
  expect(requested()).toHaveLength(0)
  const rows = (store.addMessage as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls.map((c) => c[0])
  expect(audits(rows)[0]).toMatchObject({ decision: 'deny', tool: 'execute_command' })
  expect(toolRegistry.execute).not.toHaveBeenCalled()
})
