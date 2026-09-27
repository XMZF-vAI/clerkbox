import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import type { MessageRow, SessionRow, McpServerStatus } from '../src/types/ipc'

/**
 * app_* 自我管控工具的桩。
 * 全部走 ipc.* 门面（app-tools.ts 硬约束：不碰渲染层 zustand，因为主进程 agent-host
 * 与渲染层共用同一个 toolRegistry 单例，而主进程没有 zustand）。
 */
const { ipcStub } = vi.hoisted(() => ({
  ipcStub: {
    agentHostMode: vi.fn(),
    mcpStatus: vi.fn(),
    dbGetAllSessions: vi.fn(),
    dbGetMessages: vi.fn(),
    scanSkillDirs: vi.fn(),
    scanAgents: vi.fn(),
    searchMemoryFiles: vi.fn(),
    readMemoryIndex: vi.fn(),
  },
}))
vi.mock('../src/lib/ipc-client', () => ({ ipc: ipcStub }))

import { APP_TOOLS, executeAppTool, isAppTool } from '../src/lib/app-tools'
import { toolRegistry } from '../src/lib/tool-registry'
import { parseAppResult } from '../src/components/chat/tool-renderers/shared'

const APP_TOOL_NAMES = [
  'app_status',
  'app_list_sessions',
  'app_read_session',
  'app_list_skills',
  'app_list_agents',
  'app_search_memory',
  'app_list_mcp_servers',
] as const

const CTX = { workingDir: 'C:\\work\\proj', homeDir: 'C:\\Users\\dev', sessionId: 's_current' }

function sessionRow(id: string, updated: number, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    title: `会话 ${id}`,
    created_at: updated - 1000,
    updated_at: updated,
    working_dir: 'C:\\work\\proj',
    default_work_dir: 'C:\\work\\proj',
    harness_mode: 'default',
    ...extra,
  }
}

function messageRow(id: string, role: string, content: string, extra: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    session_id: 's1',
    role,
    content,
    timestamp: 1_700_000_000_000,
    ...extra,
  }
}

function mcpStatus(over: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    id: 'srv1',
    name: 'github',
    transport: 'stdio',
    enabled: true,
    state: 'connected',
    toolCount: 12,
    tools: [],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ipcStub.agentHostMode.mockResolvedValue('main')
  ipcStub.mcpStatus.mockResolvedValue([])
  ipcStub.dbGetAllSessions.mockResolvedValue([])
  ipcStub.dbGetMessages.mockResolvedValue([])
  ipcStub.scanSkillDirs.mockResolvedValue('[]')
  ipcStub.scanAgents.mockResolvedValue([])
  ipcStub.searchMemoryFiles.mockResolvedValue([])
  ipcStub.readMemoryIndex.mockResolvedValue({ content: '', wasTruncated: false })
})

describe('工具注册', () => {
  it('7 个自我管控工具全部注册进 toolRegistry 的 builtinDefinitions', () => {
    const names = new Set(toolRegistry.definitions.map((d) => d.name))
    for (const name of APP_TOOL_NAMES) expect(names).toContain(name)
    expect(APP_TOOLS).toHaveLength(APP_TOOL_NAMES.length)
  })

  it('每个工具都有非空 description 与 object 型 parameters', () => {
    for (const tool of APP_TOOLS) {
      expect(tool.description.trim().length).toBeGreaterThan(0)
      expect(tool.parameters).toMatchObject({ type: 'object' })
    }
  })

  it('isAppTool 只认这 7 个，不误伤内建与 MCP 工具', () => {
    for (const name of APP_TOOL_NAMES) expect(isAppTool(name)).toBe(true)
    for (const name of ['execute_command', 'read_file', 'todowrite', 'mcp__github__create_issue', 'app', 'app_x']) {
      expect(isAppTool(name)).toBe(false)
    }
  })

  it('未命中时返回 null，让调用方落到 mcp__ / unknown 分支', async () => {
    expect(await executeAppTool('execute_command', {}, CTX)).toBeNull()
    expect(await executeAppTool('mcp__github__x', {}, CTX)).toBeNull()
  })

  it('工具定义与 execute 的可执行名单一一对应（防止加了定义漏了实现）', async () => {
    for (const name of APP_TOOL_NAMES) {
      const result = await executeAppTool(name, {}, CTX)
      expect(result, `${name} 应返回字符串`).not.toBeNull()
      expect(typeof result).toBe('string')
    }
  })
})

describe('app_status', () => {
  it('报告宿主模式与 MCP 连接概况', async () => {
    ipcStub.mcpStatus.mockResolvedValue([mcpStatus(), mcpStatus({ id: 's2', name: 'local', state: 'error', toolCount: 0, error: 'connect failed' })])
    const out = await executeAppTool('app_status', {}, CTX)
    expect(out).toContain('main process')
    expect(out).toContain('2 configured')
    expect(out).toContain('1 connected')
    expect(out).toContain('1 in error')
    expect(out).toContain('connect failed')
  })

  it('不泄漏 token / apiKey / 启动命令（渲染层根本拿不到，也不该出现在输出里）', async () => {
    ipcStub.mcpStatus.mockResolvedValue([mcpStatus()])
    const out = await executeAppTool('app_status', {}, CTX)
    expect(out).not.toMatch(/token|apiKey|api_key|secret/i)
  })

  it('宿主模式查询失败时降级为 unavailable 而不是整体抛错', async () => {
    ipcStub.agentHostMode.mockRejectedValue(new Error('no host'))
    const out = await executeAppTool('app_status', {}, CTX)
    expect(out).toContain('unavailable')
    expect(out).toContain('no host')
  })
})

describe('app_list_mcp_servers', () => {
  it('输出 name / transport / state / toolCount', async () => {
    ipcStub.mcpStatus.mockResolvedValue([mcpStatus()])
    const out = await executeAppTool('app_list_mcp_servers', {}, CTX)
    expect(out).toContain('[App MCP servers: 1 of 1]')
    expect(out).toContain('github (stdio) | connected | 12 tools')
  })

  it('不输出 command / env / headers（配置里可能有凭据）', async () => {
    ipcStub.mcpStatus.mockResolvedValue([mcpStatus()])
    const out = await executeAppTool('app_list_mcp_servers', {}, CTX)
    expect(out).not.toMatch(/command|args|env|headers|npx|uvx/i)
  })

  it('未配置时给出可操作提示而不是空输出', async () => {
    const out = await executeAppTool('app_list_mcp_servers', {}, CTX)
    expect(out).toContain('No MCP servers configured')
  })
})

describe('app_list_sessions', () => {
  it('按 updated_at 倒序（最近更新的在最前）', async () => {
    ipcStub.dbGetAllSessions.mockResolvedValue([
      sessionRow('old', 1000),
      sessionRow('newest', 3000),
      sessionRow('mid', 2000),
    ])
    const out = (await executeAppTool('app_list_sessions', {}, CTX)) as string
    const order = ['newest', 'mid', 'old'].map((id) => out.indexOf(id))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order[0]).toBeLessThan(order[1] as number)
    expect(order[1]).toBeLessThan(order[2] as number)
  })

  it('limit 非法值回落默认、超大值钳到上限', async () => {
    ipcStub.dbGetAllSessions.mockResolvedValue(Array.from({ length: 300 }, (_, i) => sessionRow(`s${i}`, 1000 + i)))
    const fallback = (await executeAppTool('app_list_sessions', { limit: -1 }, CTX)) as string
    expect(fallback).toContain('[App sessions: 50 of 300]')
    const capped = (await executeAppTool('app_list_sessions', { limit: 9999 }, CTX)) as string
    expect(capped).toContain('[App sessions: 200 of 300]')
  })

  it('超出 limit 时明确告知还有多少条没显示', async () => {
    ipcStub.dbGetAllSessions.mockResolvedValue(Array.from({ length: 10 }, (_, i) => sessionRow(`s${i}`, 1000 + i)))
    const out = (await executeAppTool('app_list_sessions', { limit: 3 }, CTX)) as string
    expect(out).toContain('7 older sessions not shown')
  })

  it('标出当前会话（模型据此知道自己正在哪个会话里）', async () => {
    ipcStub.dbGetAllSessions.mockResolvedValue([sessionRow('s_current', 2000, { title: '本体' }), sessionRow('s_other', 1000)])
    const out = (await executeAppTool('app_list_sessions', {}, CTX)) as string
    expect(out).toContain('s_current | 本体')
    expect(out).toMatch(/s_current.*<- current session/)
  })

  it('includeMessages 打开时逐会话读消息计数', async () => {
    ipcStub.dbGetAllSessions.mockResolvedValue([sessionRow('s1', 2000)])
    ipcStub.dbGetMessages.mockResolvedValue([messageRow('m1', 'user', 'hi')])
    const out = (await executeAppTool('app_list_sessions', { includeMessages: true }, CTX)) as string
    expect(out).toContain('1 messages')
  })

  it('空会话列表给出明确说明', async () => {
    expect(await executeAppTool('app_list_sessions', {}, CTX)).toBe('No chat sessions found.')
  })

  it('IPC 失败时返回 Error: 前缀（loop 靠前缀判 isError）', async () => {
    ipcStub.dbGetAllSessions.mockRejectedValue(new Error('db gone'))
    const out = await executeAppTool('app_list_sessions', {}, CTX)
    expect(out).toMatch(/^Error: failed to list sessions - db gone/)
  })
})

describe('app_read_session', () => {
  const three = () => [
    messageRow('m1', 'user', '第一条'),
    messageRow('m2', 'assistant', '第二条'),
    messageRow('m3', 'user', '第三条'),
  ]

  it('fromEnd 默认取尾部最近 N 条', async () => {
    ipcStub.dbGetMessages.mockResolvedValue(three())
    const out = (await executeAppTool('app_read_session', { sessionId: 's1', limit: 2 }, CTX)) as string
    expect(out).toContain('showing 2 from the end')
    expect(out).toContain('第二条')
    expect(out).toContain('第三条')
    expect(out).not.toContain('第一条')
  })

  it('fromEnd=false 取头部', async () => {
    ipcStub.dbGetMessages.mockResolvedValue(three())
    const out = (await executeAppTool('app_read_session', { sessionId: 's1', limit: 1, fromEnd: false }, CTX)) as string
    expect(out).toContain('第一条')
    expect(out).not.toContain('第三条')
  })

  it('超长消息中间省略并留下可解析的标记', async () => {
    ipcStub.dbGetMessages.mockResolvedValue([messageRow('m1', 'user', 'A'.repeat(5000))])
    const out = (await executeAppTool('app_read_session', { sessionId: 's1' }, CTX)) as string
    expect(out).toMatch(/\[\.\.\.(\d+) chars omitted\.\.\.\]/)
    expect(out).not.toContain('A'.repeat(3000))
  })

  it('跳过子 agent 卡片占位行', async () => {
    ipcStub.dbGetMessages.mockResolvedValue([
      messageRow('m1', 'user', '真实消息'),
      messageRow('m2', 'assistant', '卡片', { is_sub_agent_card: 1 }),
    ])
    const out = (await executeAppTool('app_read_session', { sessionId: 's1' }, CTX)) as string
    expect(out).toContain('真实消息')
    expect(out).not.toContain('卡片')
  })

  it('只输出工具调用计数，不回吐 tool_calls / tool_results 全文', async () => {
    ipcStub.dbGetMessages.mockResolvedValue([
      messageRow('m1', 'assistant', '正文', {
        tool_calls: JSON.stringify([{ id: 'tc1', name: 'read_file', arguments: { path: 'C:\\secret\\x' } }]),
        tool_results: JSON.stringify([{ toolCallId: 'tc1', content: '机密内容' }]),
      }),
    ])
    const out = (await executeAppTool('app_read_session', { sessionId: 's1' }, CTX)) as string
    expect(out).toContain('[Tool calls: 1]')
    expect(out).not.toContain('机密内容')
    expect(out).not.toContain('C:\\secret\\x')
  })

  it('缺 sessionId 时直接报错', async () => {
    expect(await executeAppTool('app_read_session', {}, CTX)).toBe('Error: sessionId is required')
  })

  it('全被过滤时说明原因，不返回空字符串', async () => {
    ipcStub.dbGetMessages.mockResolvedValue([messageRow('m1', 'assistant', 'x', { is_sub_agent_card: 1 })])
    const out = await executeAppTool('app_read_session', { sessionId: 's1' }, CTX)
    expect(out).toContain('no readable messages')
  })
})

describe('app_list_skills', () => {
  it('输出 slug / 显示名 / 描述 / 分类', async () => {
    ipcStub.scanSkillDirs.mockResolvedValue(JSON.stringify([
      { slug: 'docx', name: 'Word 文档', description: '生成与编辑 docx', category: 'office' },
    ]))
    const out = (await executeAppTool('app_list_skills', {}, CTX)) as string
    expect(out).toContain('[App skills: 1 of 1]')
    expect(out).toContain('- docx (Word 文档) | 生成与编辑 docx | category=office')
  })

  it('说明「激活技能是用户动作」，避免模型反复尝试自我激活', async () => {
    ipcStub.scanSkillDirs.mockResolvedValue(JSON.stringify([{ slug: 'docx' }]))
    const out = (await executeAppTool('app_list_skills', {}, CTX)) as string
    expect(out).toContain('you cannot enable a skill yourself')
  })

  it('JSON 解析失败返回 Error: 前缀而不是抛错', async () => {
    ipcStub.scanSkillDirs.mockResolvedValue('not json')
    expect(await executeAppTool('app_list_skills', {}, CTX)).toBe('Error: skill scan returned malformed data')
  })

  it('返回非数组也视为形状错误', async () => {
    ipcStub.scanSkillDirs.mockResolvedValue('{"a":1}')
    expect(await executeAppTool('app_list_skills', {}, CTX)).toContain('unexpected shape')
  })

  it('工作目录与主目录都没有时拒绝，且不发起扫描（绝不让空串变成相对路径解析）', async () => {
    const out = await executeAppTool('app_list_skills', {}, {})
    expect(out).toContain('no working directory')
    expect(ipcStub.scanSkillDirs).not.toHaveBeenCalled()
  })

  it('工作目录缺失时回落到 homeDir', async () => {
    ipcStub.scanSkillDirs.mockResolvedValue('[]')
    await executeAppTool('app_list_skills', {}, { homeDir: 'C:\\Users\\dev' })
    expect(ipcStub.scanSkillDirs).toHaveBeenCalledWith('C:\\Users\\dev')
  })
})

describe('app_list_agents', () => {
  it('内置 agent 标 built-in，自定义标 project，并给出 spawn_agent 要用的 agentType', async () => {
    ipcStub.scanAgents.mockResolvedValue([
      {
        filename: 'reviewer.md',
        content: '---\nname: reviewer\ndescription: 代码审查\n---\n你是审查员',
      },
    ])
    const out = (await executeAppTool('app_list_agents', {}, CTX)) as string
    expect(out).toContain('[App agents:')
    expect(out).toContain('explore (built-in)')
    expect(out).toContain('general (built-in)')
    expect(out).toContain('reviewer (project)')
    expect(out).toContain('代码审查')
  })

  it('scanAgents 抛错时降级为空列表（agent-registry 内部已兜底）', async () => {
    ipcStub.scanAgents.mockRejectedValue(new Error('scan failed'))
    const out = (await executeAppTool('app_list_agents', {}, CTX)) as string
    expect(out).toContain('explore (built-in)')
  })
})

describe('app_search_memory', () => {
  const entry = { filename: 'pref.md', name: 'pref', description: '用户偏好', type: 'user', content: '', mtime: 1 }

  it('按 type 白名单校验，非法 type 直接报错且不发起查询', async () => {
    const out = await executeAppTool('app_search_memory', { type: 'nope' }, CTX)
    expect(out).toContain('unknown memory type "nope"')
    expect(ipcStub.searchMemoryFiles).not.toHaveBeenCalled()
  })

  it('把 query / type 透传给底层', async () => {
    ipcStub.searchMemoryFiles.mockResolvedValue([entry])
    await executeAppTool('app_search_memory', { query: 'pref', type: 'user' }, CTX)
    expect(ipcStub.searchMemoryFiles).toHaveBeenCalledWith('C:\\work\\proj', 'pref', 'user')
  })

  it('includeIndex 打开时附带 MEMORY.md 索引', async () => {
    ipcStub.searchMemoryFiles.mockResolvedValue([entry])
    ipcStub.readMemoryIndex.mockResolvedValue({ content: '# 索引\n- pref', wasTruncated: false })
    const out = (await executeAppTool('app_search_memory', { includeIndex: true }, CTX)) as string
    expect(out).toContain('MEMORY.md index:')
    expect(out).toContain('- pref')
  })

  it('无匹配时说明是「无匹配」还是「尚未创建」', async () => {
    expect(await executeAppTool('app_search_memory', {}, CTX)).toContain('No memory entries exist yet')
    ipcStub.searchMemoryFiles.mockResolvedValue([])
    expect(await executeAppTool('app_search_memory', { query: 'zzz' }, CTX)).toContain('No memory entries matched')
  })
})

describe('parseAppResult（渲染层与工具约定的解析）', () => {
  it('剥掉头部计数标记，保留省略/截断标记在正文里', () => {
    const meta = parseAppResult('[App sessions: 3 of 12]\n- a\n- b\n[...900 chars omitted...]')
    expect(meta.count).toBe('3 of 12')
    expect(meta.lines.join('\n')).toBe('- a\n- b\n[...900 chars omitted...]')
  })

  it('app_read_session 的头部也能识别', () => {
    const meta = parseAppResult('[App session: s1] (4 messages, showing 2 from the end)\n[ts] user: hi')
    expect(meta.count).toBe('s1')
  })

  it('无标记时 count 为 null 且原样返回', () => {
    const meta = parseAppResult('plain text')
    expect(meta.count).toBeNull()
    expect(meta.lines).toEqual(['plain text'])
  })

  it('保留空行（app_search_memory 的 index 段靠它分段）', () => {
    const meta = parseAppResult('[App memory: 1 of 1]\n- a\n\nMEMORY.md index:')
    expect(meta.lines).toEqual(['- a', '', 'MEMORY.md index:'])
  })
})

describe('权限白名单防回归', () => {
  /**
   * loop.ts 的 READ_TOOLS 是函数内局部变量，import 不到；和 webui-blocklist.test.ts
   * 同一套路——扫源码断言。挂漏的后果是 plan / spec 规划期把自我管控工具全拒了。
   */
  const loopSource = (): string =>
    fs.readFileSync(path.join(process.cwd(), 'src', 'agent-core', 'loop.ts'), 'utf-8')

  it('loop.ts 的 READ_TOOLS 含全部 7 个 app_*', () => {
    const readToolsMatch = loopSource().match(/const READ_TOOLS = \[([\s\S]*?)\]/)
    expect(readToolsMatch, '未找到 READ_TOOLS 定义').not.toBeNull()
    const readTools = readToolsMatch?.[1] ?? ''
    for (const name of APP_TOOL_NAMES) expect(readTools).toContain(`'${name}'`)
  })

  it('loop.ts 的 MICROCOMPACT_CLEARABLE_TOOLS 含全部 7 个 app_*', () => {
    const match = loopSource().match(/const MICROCOMPACT_CLEARABLE_TOOLS = new Set\(\[([\s\S]*?)\]\)/)
    expect(match, '未找到 MICROCOMPACT_CLEARABLE_TOOLS 定义').not.toBeNull()
    const set = match?.[1] ?? ''
    for (const name of APP_TOOL_NAMES) expect(set).toContain(`'${name}'`)
  })

  it('自我管控工具全为只读：不得出现在副作用串行集合里', () => {
    const match = loopSource().match(/const sideEffectingTools = new Set\(\[([\s\S]*?)\]\)/)
    const set = match?.[1] ?? ''
    for (const name of APP_TOOL_NAMES) expect(set).not.toContain(`'${name}'`)
  })

  it('自我管控工具不得触发审批卡片（只读，不进 APPROVAL_GATED_TOOLS）', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'lib', 'permission-preview.ts'),
      'utf-8',
    )
    const match = source.match(/APPROVAL_GATED_TOOLS = \[([\s\S]*?)\]/)
    const gated = match?.[1] ?? ''
    for (const name of APP_TOOL_NAMES) expect(gated).not.toContain(`'${name}'`)
  })
})

describe('harness 兼容模式的工具面裁剪', () => {
  const namesFor = (mode: Parameters<typeof toolRegistry.getDefinitionsForMode>[0]): string[] =>
    toolRegistry.getDefinitionsForMode(mode).map((d) => d.name)

  it('default / zcode / dsh 全量暴露（zcode 被 harness-modes 测试强制与 default 同名）', () => {
    for (const mode of ['default', 'zcode', 'dsh'] as const) {
      for (const name of APP_TOOL_NAMES) expect(namesFor(mode), mode).toContain(name)
    }
  })

  it('codex / grok-build 裁掉：上游是纯终端 agent，不托管宿主应用状态', () => {
    for (const mode of ['codex', 'grok-build'] as const) {
      for (const name of APP_TOOL_NAMES) expect(namesFor(mode), mode).not.toContain(name)
    }
  })

  it('dsh-minimal 自动裁掉（白名单式 transform，只留 execute_command / search_replace）', () => {
    const names = namesFor('dsh-minimal')
    for (const name of APP_TOOL_NAMES) expect(names).not.toContain(name)
    expect([...names].sort()).toEqual(['execute_command', 'search_replace'])
  })

  it('裁剪只发生在这两个模式：其余模式的工具名集合不含 app_ 前缀', () => {
    for (const mode of ['codex', 'grok-build', 'dsh-minimal'] as const) {
      const leaked = namesFor(mode).filter((n) => n.startsWith('app_'))
      expect(leaked, mode).toEqual([])
    }
    for (const mode of ['default', 'zcode', 'dsh'] as const) {
      const present = namesFor(mode).filter((n) => n.startsWith('app_'))
      expect(present.length, mode).toBe(APP_TOOL_NAMES.length)
    }
  })
})
