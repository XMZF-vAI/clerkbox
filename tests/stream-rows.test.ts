/**
 * 会话流行流构建与分组（照抄 ZCode conversationAssistantWorkItems 的语义守卫）。
 * 重点：连续 ≥2 同类才聚合、单个保持独立、思考/正文打断分组、组身份锚定首项、
 * 只读命令判定与分桶口径与 ZCode 一致。
 */
import { describe, expect, it } from 'vitest'
import type { Message, ToolCall } from '../src/types/agent'
import {
  buildStreamRows, commandSegments, countExploreBuckets, executeGroupStats,
  exploreBucket, isExecuteTool, isExploreTool, isGroupRunning, isReadOnlyCommand,
  isThinkingActive, latestActiveItem, type ToolRowItem,
} from '../src/components/chat/stream-rows'
import { resolveStreamingSummary } from '../src/components/chat/ReasoningRow'

let seq = 0
function call(name: string, args: Record<string, unknown> = {}, id?: string): ToolCall {
  seq += 1
  return { id: id ?? `tc${seq}`, name, arguments: args }
}
function msg(over: Partial<Message> & { role: Message['role'] }): Message {
  seq += 1
  return { id: `m${seq}`, content: '', timestamp: seq, ...over }
}
function assistantWithTools(calls: ToolCall[], over: Partial<Message> = {}): Message {
  return msg({
    role: 'assistant',
    toolCalls: calls,
    toolResults: calls.map((c) => ({ toolCallId: c.id, content: 'ok' })),
    finishReason: 'tool_calls',
    ...over,
  })
}

describe('行流顺序', () => {
  it('一条助手消息摊成 思考 → 正文 → 工具行', () => {
    const c = call('execute_command', { command: 'npm test' })
    const rows = buildStreamRows([msg({ role: 'assistant', thinkingContent: '想一想', content: '说一段', toolCalls: [c], toolResults: [{ toolCallId: c.id, content: 'ok' }] })])
    expect(rows.map((r) => r.kind)).toEqual(['thinking', 'text', 'tool'])
  })

  it('role=tool 的消息不进时间线', () => {
    const rows = buildStreamRows([msg({ role: 'tool', content: '结果' }), msg({ role: 'assistant', content: '正文' })])
    expect(rows.map((r) => r.kind)).toEqual(['text'])
  })

  it('spawn_agent 走统一入口，不进工具行', () => {
    const rows = buildStreamRows([assistantWithTools([call('spawn_agent'), call('read_file', { path: 'a.ts' })])])
    const tools = rows.filter((r) => r.kind === 'tool')
    expect(tools).toHaveLength(1)
  })

  it('特殊卡片原样透传，不参与分组', () => {
    const rows = buildStreamRows([
      assistantWithTools([call('read_file', { path: 'a.ts' }), call('read_file', { path: 'b.ts' })]),
      msg({ role: 'assistant', isSubAgentCard: true }),
      assistantWithTools([call('read_file', { path: 'c.ts' }), call('read_file', { path: 'd.ts' })]),
    ])
    // 子代理卡打断 → 两个独立的查阅组，而不是一个跨卡片的大组
    expect(rows.map((r) => r.kind)).toEqual(['exploreGroup', 'special', 'exploreGroup'])
  })
})

describe('查阅 / 终端聚合', () => {
  it('连续 ≥2 只读工具聚成查阅组，身份锚定首个工具 id', () => {
    const a = call('web_search', { query: 'x' }, 'first')
    const b = call('web_search', { query: 'y' }, 'second')
    const rows = buildStreamRows([assistantWithTools([a, b])])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'exploreGroup', key: 'explore:first' })
    expect((rows[0] as { items: ToolRowItem[] }).items).toHaveLength(2)
  })

  it('单个只读工具保持独立行（不套聚合层）', () => {
    const rows = buildStreamRows([assistantWithTools([call('read_file', { path: 'a.ts' })])])
    expect(rows.map((r) => r.kind)).toEqual(['tool'])
  })

  it('思考行打断分组：两步各 2 个搜索 → 思考/查阅/思考/查阅', () => {
    const rows = buildStreamRows([
      assistantWithTools([call('web_search'), call('web_search')], { thinkingContent: '第一步' }),
      assistantWithTools([call('web_fetch'), call('web_fetch')], { thinkingContent: '第二步' }),
    ])
    expect(rows.map((r) => r.kind)).toEqual(['thinking', 'exploreGroup', 'thinking', 'exploreGroup'])
  })

  it('连续 ≥2 执行命令聚成终端组；只读命令不算执行', () => {
    const rows = buildStreamRows([assistantWithTools([
      call('execute_command', { command: 'npm run build' }),
      call('execute_command', { command: 'npm test' }),
    ])])
    expect(rows.map((r) => r.kind)).toEqual(['executeGroup'])
  })

  it('只读 shell 命令归入查阅组而非终端组', () => {
    const rows = buildStreamRows([assistantWithTools([
      call('execute_command', { command: 'ls src' }),
      call('execute_command', { command: 'cat package.json' }),
    ])])
    expect(rows.map((r) => r.kind)).toEqual(['exploreGroup'])
  })

  it('查阅与执行相邻不混组', () => {
    const rows = buildStreamRows([assistantWithTools([
      call('read_file', { path: 'a.ts' }),
      call('execute_command', { command: 'npm test' }),
      call('read_file', { path: 'b.ts' }),
    ])])
    expect(rows.map((r) => r.kind)).toEqual(['tool', 'tool', 'tool'])
  })
})

describe('只读命令判定（ZCode 口径）', () => {
  it('常见只读命令判 true', () => {
    for (const cmd of ['ls -la', 'cat a.txt', 'rg foo', 'grep -r bar', 'git status', 'git log --oneline', 'git diff HEAD', 'Get-Content a.txt', 'dir', 'head -n 5 a']) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(true)
    }
  })
  it('写命令 / 重定向写 / 写 git 子命令判 false', () => {
    for (const cmd of ['rm -rf x', 'mkdir foo', 'echo hi > a.txt', 'cat a >> b.txt', 'git commit -m x', 'git add .', 'npm install', 'sed -i s/a/b/ f', 'Move-Item a b']) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false)
    }
  })
  it('空命令判 false', () => {
    expect(isReadOnlyCommand('   ')).toBe(false)
  })
  it('for 循环里的只读探查仍判 true', () => {
    expect(isReadOnlyCommand('for f in *.md; do cat "$f"; done')).toBe(true)
  })
  it('bash -lc 包裹会被拆开判定', () => {
    expect(isReadOnlyCommand('bash -lc "git status"')).toBe(true)
    expect(isReadOnlyCommand('bash -lc "rm x"')).toBe(false)
  })
  it('commandSegments 按 && / || / ; 拆段去重', () => {
    expect(commandSegments('ls && cat a ; ls')).toEqual(['ls', 'cat a'])
  })
})

describe('查阅分桶', () => {
  it('工具名直接分桶', () => {
    expect(exploreBucket(call('web_fetch'))).toBe('fetch')
    expect(exploreBucket(call('web_search'))).toBe('search')
    expect(exploreBucket(call('search_content'))).toBe('search')
    expect(exploreBucket(call('list_dir'))).toBe('list')
    expect(exploreBucket(call('read_file'))).toBe('file')
    expect(exploreBucket(call('read_image'))).toBe('file')
  })
  it('只读 shell 按命令内容分桶', () => {
    expect(exploreBucket(call('execute_command', { command: 'rg foo' }))).toBe('search')
    expect(exploreBucket(call('execute_command', { command: 'ls src' }))).toBe('list')
    expect(exploreBucket(call('execute_command', { command: 'cat a.txt' }))).toBe('file')
  })
  it('countExploreBuckets 统计各桶', () => {
    const items: ToolRowItem[] = [
      { call: call('web_fetch'), message: msg({ role: 'assistant' }) },
      { call: call('web_search'), message: msg({ role: 'assistant' }) },
      { call: call('read_file'), message: msg({ role: 'assistant' }) },
      { call: call('read_file'), message: msg({ role: 'assistant' }) },
    ]
    expect(countExploreBuckets(items)).toEqual({ fetch: 1, search: 1, list: 0, file: 2 })
  })
})

describe('终端组统计与运行态', () => {
  it('失败 / 停止计数', () => {
    const done = msg({ role: 'assistant', finishReason: 'stop' })
    const items: ToolRowItem[] = [
      { call: call('execute_command'), result: { toolCallId: 'x', content: 'ok' }, message: done },
      { call: call('execute_command'), result: { toolCallId: 'y', content: 'err', isError: true }, message: done },
      { call: call('execute_command'), message: done }, // 无结果且已完成 = 停止
    ]
    expect(executeGroupStats(items)).toEqual({ total: 3, failed: 1, stopped: 1 })
  })

  it('流式中无结果 = 在跑；latestActiveItem 取最后一个在跑的', () => {
    const streaming = msg({ role: 'assistant', _isStreaming: true })
    const a = call('execute_command', { command: 'first' })
    const b = call('execute_command', { command: 'second' })
    const items: ToolRowItem[] = [
      { call: a, result: { toolCallId: a.id, content: 'ok' }, message: streaming },
      { call: b, message: streaming },
    ]
    expect(isGroupRunning(items)).toBe(true)
    expect(latestActiveItem(items)?.call.id).toBe(b.id)
  })

  it('isExecuteTool 排除只读命令', () => {
    expect(isExecuteTool(call('execute_command', { command: 'npm test' }))).toBe(true)
    expect(isExecuteTool(call('execute_command', { command: 'ls' }))).toBe(false)
    expect(isExecuteTool(call('read_file'))).toBe(false)
  })
})

describe('思考态与末行摘要', () => {
  it('isThinkingActive：流式中且未产出正文/工具/完成原因', () => {
    expect(isThinkingActive(msg({ role: 'assistant', _isStreaming: true, thinkingContent: 'x' }))).toBe(true)
    expect(isThinkingActive(msg({ role: 'assistant', _isStreaming: true, content: 'reply' }))).toBe(false)
    expect(isThinkingActive(msg({ role: 'assistant', _isStreaming: true, toolCalls: [call('read_file')] }))).toBe(false)
    expect(isThinkingActive(msg({ role: 'assistant', thinkingContent: 'x' }))).toBe(false)
  })

  it('resolveStreamingSummary 取最后一个非空行', () => {
    expect(resolveStreamingSummary('first\n\nlast line\n  \n')).toBe('last line')
    expect(resolveStreamingSummary('\n\n')).toBeNull()
    expect(resolveStreamingSummary('only')).toBe('only')
  })
})