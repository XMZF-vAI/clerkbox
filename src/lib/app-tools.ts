import { ipc } from './ipc-client'
import { mapMessageRows } from './chat-row'
import { getAllAgents } from './agent-registry'
import type { ToolDefinition, MemoryType, Message } from '../types/agent'
import type { MessageRow } from '../types/ipc'
// ToolContext 定义在 tool-registry.ts（与其他工具共用同一份），从源头引而不重定义，
// 免得两处漂移。从 tool-registry 具名引一个类型不会与默认分支的 import 形成运行时循环。
import type { ToolContext } from './tool-registry'

// ── Shared limits（与工具描述中的数值严格一致，改动时两处同步）──

/** app_list_sessions：默认返回条数 / 硬上限 */
const APP_SESSIONS_DEFAULT = 50
const APP_SESSIONS_MAX = 200
/** app_list_sessions：includeMessages 打开时，逐会话读消息计数的会话数上限（每次多一次 IPC） */
const APP_SESSIONS_WITH_COUNT_MAX = 20
/** app_read_session：默认 / 最大消息条数 */
const APP_MESSAGES_DEFAULT = 40
const APP_MESSAGES_MAX = 200
/** app_read_session：单条消息正文超过此长度则中间省略 */
const APP_MESSAGE_CHARS_MAX = 2000
/** app_read_session：本次返回的总体积上限，超出截断并注明 */
const APP_SESSION_OUTPUT_CHARS_MAX = 30_000
/** app_list_skills / app_list_agents：条目上限 */
const APP_SKILLS_MAX = 100
const APP_AGENTS_MAX = 100
/** app_list_skills：描述截断长度 */
const APP_SKILL_DESC_CHARS_MAX = 200
/** app_search_memory：条目上限 / 标题截断长度 */
const APP_MEMORY_MAX = 50
const APP_MEMORY_TITLE_CHARS_MAX = 120
/** app_list_mcp_servers：服务器数上限 / 错误串截断长度 */
const APP_MCP_SERVERS_MAX = 50
const APP_MCP_ERROR_CHARS_MAX = 200

const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

// ── Tool definitions ──

const appTools: ToolDefinition[] = [
  {
    name: 'app_status',
    description:
      "Read the host application's own state: which process runs the agent loop, and the connection summary of every configured MCP server.\n" +
      'Usage:\n' +
      '- Call this first when you need to know which execution context you are running in (main process vs renderer).\n' +
      '- Read-only: no side effects, never needs approval.\n' +
      '- Never returns API keys, tokens, or MCP launch commands/environment variables.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'app_list_sessions',
    description:
      'List the user\'s chat sessions, most recently updated first.\n' +
      'Usage:\n' +
      '- Returns up to 50 sessions by default (max 200): id, title, working directory, harness mode, and update time.\n' +
      '- Use app_read_session with the returned id to inspect a session\'s messages.\n' +
      '- Use this to recover context from earlier conversations, or to find the session the user is referring to ("the one about X").\n' +
      '- Read-only: no side effects, never needs approval.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `Max sessions to return (default ${APP_SESSIONS_DEFAULT}, max ${APP_SESSIONS_MAX}), most recently updated first.` },
        includeMessages: { type: 'boolean', description: 'If true, also return a per-session message count. Costs one extra read per session, and is skipped beyond the first 20 sessions (default false).' },
      },
      required: [],
    },
  },
  {
    name: 'app_read_session',
    description:
      "Read the messages of one chat session, so you can recover context from an earlier conversation.\n" +
      'Usage:\n' +
      `- Takes the last 40 messages by default (max 200); pass fromEnd=false to take the first N instead.\n` +
      `- Each message body longer than ${APP_MESSAGE_CHARS_MAX} characters is shortened in the middle with a "[...N chars omitted...]" marker.\n` +
      '- Tool call arguments and results are NOT included (only a per-message tool call count), because they are large and rarely what you need.\n' +
      '- Sub-agent card placeholders are skipped.\n' +
      '- Session content may contain sensitive material the user pasted earlier; do not repeat secrets verbatim.\n' +
      '- Read-only: no side effects, never needs approval.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session id, as returned by app_list_sessions.' },
        limit: { type: 'number', description: `Max messages to return (default ${APP_MESSAGES_DEFAULT}, max ${APP_MESSAGES_MAX}).` },
        fromEnd: { type: 'boolean', description: 'Take the last N messages instead of the first N (default true).' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'app_list_skills',
    description:
      'List the skills installed on this machine (user, project, and Claude-compatible directories).\n' +
      'Usage:\n' +
      `- Returns up to ${APP_SKILLS_MAX} skills: slug, display name, short description, category.\n` +
      '- You cannot activate a skill yourself — activation is a user action in the Skills panel. If a skill looks relevant, tell the user which one to activate.\n' +
      '- Read-only: no side effects, never needs approval.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'app_list_agents',
    description:
      'List the sub-agent definitions available for spawn_agent: the built-ins plus any project-local custom agents.\n' +
      'Usage:\n' +
      `- Returns up to ${APP_AGENTS_MAX} entries: agentType (the value to pass to spawn_agent), display name, description, and whether it is built-in or project-defined.\n` +
      '- Read-only: no side effects, never needs approval.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'app_search_memory',
    description:
      'Search the user\'s structured memory notes (the .clerkbox/memory directory) and optionally return the MEMORY.md index.\n' +
      'Usage:\n' +
      `- Returns up to ${APP_MEMORY_MAX} entries: file name, title, type.\n` +
      '- Filter by query (case-insensitive substring of name) and/or type (user | feedback | project | reference).\n' +
      '- To read an entry\'s full body, use read_file on the file NAME under .clerkbox/memory/ in the working directory.\n' +
      '- Read-only: no side effects, never needs approval.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring filter on the entry name (optional; empty lists all).' },
        type: { type: 'string', description: 'Filter by entry type: user | feedback | project | reference (optional).', enum: [...MEMORY_TYPES] },
        includeIndex: { type: 'boolean', description: 'Also return the head of the MEMORY.md index (default false).' },
      },
      required: [],
    },
  },
  {
    name: 'app_list_mcp_servers',
    description:
      'List configured MCP servers with their connection state and tool counts.\n' +
      'Usage:\n' +
      `- Shows at most ${APP_MCP_SERVERS_MAX} servers: name, transport, state (connected / connecting / error / disabled), and tool count.\n` +
      '- Individual tool names and descriptions are not included here; the ones your model can actually call already appear in your tool list as mcp__<server>__<tool>.\n' +
      '- Never returns launch commands, arguments, environment variables, or headers — those may hold credentials.\n' +
      '- Read-only: no side effects, never needs approval.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
]

// ── helpers ──

/** 会话工作目录：会话未设时回落到用户主目录，绝不让空串变成相对路径解析。 */
function resolveWorkDir(ctx: ToolContext | undefined): string | null {
  return ctx?.workingDir || ctx?.homeDir || null
}

function clampInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const marker = `\n[...${text.length - max} chars omitted...]\n`
  const keep = max - marker.length
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`
}

function truncateEnd(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return 'unknown-time'
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

function messageRoleLabel(role: string): string {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  if (role === 'tool') return 'tool'
  return 'system'
}

/** 整篇输出的体积闸门：超限就截断并明确告知模型，省得它以为拿全了。 */
function capOutput(text: string, marker: string): string {
  if (text.length <= APP_SESSION_OUTPUT_CHARS_MAX) return text
  const kept = text.slice(0, APP_SESSION_OUTPUT_CHARS_MAX)
  return `${kept}\n\n[App output truncated at ${APP_SESSION_OUTPUT_CHARS_MAX} chars. ${marker}]`
}

// ── execute implementations ──

async function runAppStatus(): Promise<string> {
  const lines: string[] = []
  let hostMode = 'unknown'
  try {
    hostMode = await ipc.agentHostMode()
  } catch (e) {
    hostMode = `unavailable (${e instanceof Error ? e.message : String(e)})`
  }
  lines.push(`Agent host mode: ${hostMode === 'main' ? 'main process' : hostMode === 'renderer' ? 'renderer process' : hostMode}`)

  let servers: Awaited<ReturnType<typeof ipc.mcpStatus>> = []
  try {
    servers = await ipc.mcpStatus()
  } catch (e) {
    lines.push(`MCP servers: unavailable (${e instanceof Error ? e.message : String(e)})`)
    return capOutput(lines.join('\n'), 'Retry app_status or use mcp__ tools directly.')
  }

  const byState = (state: string) => servers.filter((s) => s.state === state).length
  lines.push(`MCP servers: ${servers.length} configured (${byState('connected')} connected, ${byState('connecting')} connecting, ${byState('error')} in error, ${byState('disabled')} disabled)`)
  for (const s of servers.slice(0, APP_MCP_SERVERS_MAX)) {
    const detail = s.error ? `, error: ${truncateEnd(s.error, APP_MCP_ERROR_CHARS_MAX)}` : ''
    lines.push(`- ${s.name} (${s.transport}) | ${s.state} | ${s.toolCount} tools${detail}`)
  }
  if (servers.length > APP_MCP_SERVERS_MAX) {
    lines.push(`- ... ${servers.length - APP_MCP_SERVERS_MAX} more not shown`)
  }
  return capOutput(lines.join('\n'), 'Call app_list_mcp_servers for the per-server breakdown.')
}

async function runAppListSessions(args: Record<string, unknown>, ctx: ToolContext | undefined): Promise<string> {
  let rows: Awaited<ReturnType<typeof ipc.dbGetAllSessions>>
  try {
    rows = await ipc.dbGetAllSessions()
  } catch (e) {
    return `Error: failed to list sessions - ${e instanceof Error ? e.message : String(e)}`
  }
  if (rows.length === 0) return 'No chat sessions found.'

  const sorted = [...rows].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
  const limit = clampInt(args.limit, APP_SESSIONS_DEFAULT, APP_SESSIONS_MAX)
  const page = sorted.slice(0, limit)
  const wantCounts = args.includeMessages === true
  const countLimit = Math.min(page.length, APP_SESSIONS_WITH_COUNT_MAX)

  const lines: string[] = [`[App sessions: ${page.length} of ${sorted.length}]`]
  for (let i = 0; i < page.length; i++) {
    const row = page[i]!
    const marker = row.id === ctx?.sessionId ? ' <- current session' : ''
    let counts = ''
    if (wantCounts) {
      if (i < countLimit) {
        try {
          const messages = await ipc.dbGetMessages(row.id)
          counts = `, ${messages.length} messages`
        } catch {
          counts = ', message count unavailable'
        }
      } else {
        counts = ', message count not read (limit reached)'
      }
    }
    lines.push(
      `${row.id} | ${truncateEnd(row.title || '(untitled)', 80)} | cwd=${row.working_dir || row.default_work_dir || '(none)'} | harness=${row.harness_mode || 'default'} | updated=${formatTime(row.updated_at)}${counts}${marker}`,
    )
  }
  if (sorted.length > limit) {
    lines.push(`... ${sorted.length - limit} older sessions not shown; pass a larger limit to see more.`)
  }
  return capOutput(lines.join('\n'), 'Pass a larger limit or narrow the request with app_read_session.')
}

async function runAppReadSession(args: Record<string, unknown>): Promise<string> {
  const sessionId = String(args.sessionId ?? '').trim()
  if (!sessionId) return 'Error: sessionId is required'

  // mapMessageRows 吃整批行（chat-row.ts 是渲染层与 agent-host 共用的唯一编解码实现，
  // 必须复用而不是按行单编——另写一份会造成两边漂移）
  let messages: Message[]
  try {
    const rows: MessageRow[] = await ipc.dbGetMessages(sessionId)
    messages = mapMessageRows(rows).filter((m) => !m.isSubAgentCard)
  } catch (e) {
    return `Error: failed to read session - ${e instanceof Error ? e.message : String(e)}`
  }

  if (messages.length === 0) {
    return `Session ${sessionId} has no readable messages (empty, or every message is a sub-agent placeholder).`
  }

  const limit = clampInt(args.limit, APP_MESSAGES_DEFAULT, APP_MESSAGES_MAX)
  const fromEnd = args.fromEnd !== false
  const page = fromEnd ? messages.slice(-limit) : messages.slice(0, limit)

  const lines: string[] = [`[App session: ${sessionId}] (${messages.length} messages, showing ${page.length} ${fromEnd ? 'from the end' : 'from the start'})`]
  for (const m of page) {
    const calls = m.toolCalls?.length ?? 0
    const suffix = calls > 0 ? ` [Tool calls: ${calls}]` : ''
    const body = truncateMiddle((m.content || '').trim() || '(empty message)', APP_MESSAGE_CHARS_MAX)
    lines.push(`[${formatTime(m.timestamp)}] ${messageRoleLabel(m.role)}${suffix}: ${body}`)
  }
  if (!fromEnd && messages.length > limit) {
    lines.push(`... ${messages.length - limit} later messages not shown; pass fromEnd=true to read the tail.`)
  }
  return capOutput(lines.join('\n'), 'Pass a smaller limit to page through this session.')
}

async function runAppListSkills(ctx: ToolContext | undefined): Promise<string> {
  const wd = resolveWorkDir(ctx)
  if (!wd) return 'Error: no working directory is available for this session'

  let raw: string
  try {
    raw = await ipc.scanSkillDirs(wd)
  } catch (e) {
    return `Error: skill scan failed - ${e instanceof Error ? e.message : String(e)}`
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'Error: skill scan returned malformed data'
  }
  if (!Array.isArray(parsed)) return 'Error: skill scan returned an unexpected shape'

  type SkillRow = { slug?: string; name?: string; description?: string; category?: string }
  const skills = parsed as SkillRow[]
  if (skills.length === 0) {
    return 'No skills installed. The user can install some from the Skills panel.'
  }

  const lines: string[] = [`[App skills: ${Math.min(skills.length, APP_SKILLS_MAX)} of ${skills.length}]`]
  for (const s of skills.slice(0, APP_SKILLS_MAX)) {
    const slug = s.slug || '(unnamed)'
    const name = s.name && s.name !== slug ? s.name : ''
    const desc = s.description ? truncateEnd(s.description, APP_SKILL_DESC_CHARS_MAX) : ''
    const cat = s.category ? ` | category=${s.category}` : ''
    lines.push(`- ${slug}${name ? ` (${name})` : ''}${desc ? ` | ${desc}` : ''}${cat}`)
  }
  if (skills.length > APP_SKILLS_MAX) {
    lines.push(`... ${skills.length - APP_SKILLS_MAX} more not shown`)
  }
  lines.push('Activation is a user action in the Skills panel; you cannot enable a skill yourself.')
  return capOutput(lines.join('\n'), 'Narrow the request instead of re-listing all skills.')
}

async function runAppListAgents(ctx: ToolContext | undefined): Promise<string> {
  const wd = resolveWorkDir(ctx)
  if (!wd) return 'Error: no working directory is available for this session'

  let agents: Awaited<ReturnType<typeof getAllAgents>>
  try {
    agents = await getAllAgents(wd)
  } catch (e) {
    return `Error: agent lookup failed - ${e instanceof Error ? e.message : String(e)}`
  }
  if (agents.length === 0) return 'No sub-agents available.'

  const lines: string[] = [`[App agents: ${Math.min(agents.length, APP_AGENTS_MAX)} of ${agents.length}]`]
  for (const a of agents.slice(0, APP_AGENTS_MAX)) {
    const origin = a.source === 'custom' ? 'project' : 'built-in'
    const desc = truncateEnd(a.description || a.whenToUse || '', APP_SKILL_DESC_CHARS_MAX)
    lines.push(`- ${a.agentType} (${origin}) | ${a.name}${desc ? ` | ${desc}` : ''}`)
  }
  if (agents.length > APP_AGENTS_MAX) {
    lines.push(`... ${agents.length - APP_AGENTS_MAX} more not shown`)
  }
  return capOutput(lines.join('\n'), 'Pass the agentType straight to spawn_agent.')
}

async function runAppSearchMemory(args: Record<string, unknown>, ctx: ToolContext | undefined): Promise<string> {
  const wd = resolveWorkDir(ctx)
  if (!wd) return 'Error: no working directory is available for this session'

  const query = args.query ? String(args.query) : undefined
  const rawType = args.type ? String(args.type) : undefined
  if (rawType && !MEMORY_TYPES.includes(rawType as MemoryType)) {
    return `Error: unknown memory type "${rawType}" (expected one of: ${MEMORY_TYPES.join(', ')})`
  }
  const type = rawType as MemoryType | undefined

  let entries: Awaited<ReturnType<typeof ipc.searchMemoryFiles>>
  try {
    entries = await ipc.searchMemoryFiles(wd, query, type)
  } catch (e) {
    return `Error: memory search failed - ${e instanceof Error ? e.message : String(e)}`
  }

  const lines: string[] = []
  if (entries.length === 0) {
    lines.push(query || type ? 'No memory entries matched.' : 'No memory entries exist yet.')
  } else {
    lines.push(`[App memory: ${Math.min(entries.length, APP_MEMORY_MAX)} of ${entries.length}]`)
    for (const e of entries.slice(0, APP_MEMORY_MAX)) {
      const title = truncateEnd(e.description || e.name || e.filename, APP_MEMORY_TITLE_CHARS_MAX)
      lines.push(`- ${e.filename} | ${title}${e.type ? ` | type=${e.type}` : ''}`)
    }
    if (entries.length > APP_MEMORY_MAX) {
      lines.push(`... ${entries.length - APP_MEMORY_MAX} more not shown`)
    }
  }

  if (args.includeIndex === true) {
    try {
      const index = await ipc.readMemoryIndex(wd)
      lines.push('', 'MEMORY.md index:', truncateMiddle(index.content.trim() || '(empty)', APP_MESSAGE_CHARS_MAX))
    } catch (e) {
      lines.push('', `MEMORY.md index unavailable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  lines.push(`Read an entry body with read_file on that file NAME under .clerkbox/memory/ in ${wd}`)
  return capOutput(lines.join('\n'), 'Narrow the query or drop includeIndex.')
}

async function runAppListMcpServers(): Promise<string> {
  let servers: Awaited<ReturnType<typeof ipc.mcpStatus>>
  try {
    servers = await ipc.mcpStatus()
  } catch (e) {
    return `Error: failed to read MCP status - ${e instanceof Error ? e.message : String(e)}`
  }
  if (servers.length === 0) {
    return 'No MCP servers configured. The user can add some in Settings → MCP.'
  }

  const lines: string[] = [`[App MCP servers: ${Math.min(servers.length, APP_MCP_SERVERS_MAX)} of ${servers.length}]`]
  for (const s of servers.slice(0, APP_MCP_SERVERS_MAX)) {
    const detail = s.error ? ` | error: ${truncateEnd(s.error, APP_MCP_ERROR_CHARS_MAX)}` : ''
    lines.push(`- ${s.name} (${s.transport}) | ${s.state} | ${s.toolCount} tools${detail}`)
  }
  if (servers.length > APP_MCP_SERVERS_MAX) {
    lines.push(`... ${servers.length - APP_MCP_SERVERS_MAX} more not shown`)
  }
  return capOutput(lines.join('\n'), 'Launch commands, arguments, environment variables, and headers are deliberately omitted.')
}

// ── public surface ──

export const APP_TOOLS: ToolDefinition[] = appTools

/**
 * 7 个工具名的单一来源。
 * harness 兼容模式的裁剪名单（codex / grok-build / dsh 的 HIDDEN 集合）与
 * tests/app-tools.test.ts 的权限白名单防回归断言都从这里取，避免两处各抄一份名字。
 */
export const APP_TOOL_NAMES: readonly string[] = appTools.map((t) => t.name)

const APP_TOOL_NAME_SET = new Set(APP_TOOL_NAMES)

/** 是否是自我管控工具（供 UI 与权限判定按前缀分流） */
export function isAppTool(name: string): boolean {
  return APP_TOOL_NAME_SET.has(name)
}

/**
 * 执行一个自我管控工具；未命中返回 null，由调用方落到 mcp__ / unknown 分支。
 * 全部 7 个工具都是只读，走的全是已过主进程入口校验的只读 handler。
 * 只用 ipc.* 面、不碰渲染层 zustand——这份代码在渲染进程与主进程 agent-host 里共用同一份
 * toolRegistry 单例，而主进程没有 zustand（它有自己的 sessionCache），摸 store 会静默失效。
 */
export async function executeAppTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
): Promise<string | null> {
  switch (name) {
    case 'app_status':
      return runAppStatus()
    case 'app_list_sessions':
      return runAppListSessions(args, ctx)
    case 'app_read_session':
      return runAppReadSession(args)
    case 'app_list_skills':
      return runAppListSkills(ctx)
    case 'app_list_agents':
      return runAppListAgents(ctx)
    case 'app_search_memory':
      return runAppSearchMemory(args, ctx)
    case 'app_list_mcp_servers':
      return runAppListMcpServers()
    default:
      return null
  }
}
