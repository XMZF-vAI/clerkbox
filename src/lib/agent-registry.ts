import type { AgentDefinition } from '../types/agent'
import { ipc } from './ipc-client'

const MAX_CUSTOM_AGENT_TURNS = 100

// ── 内置 agent 定义 ──

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    agentType: 'explore',
    name: '侦察兵',
    whenToUse:
      '快速探索、查找文件、搜索内容、回答结构问题。只读，不修改任何文件。适合需要大面积搜索或阅读多个文件的场景。',
    description: '只读侦察 agent',
    disallowedTools: ['write_file', 'search_replace', 'execute_command', 'save_memory'],
    tools: ['*'],
    model: undefined,
    maxTurns: 30,
    source: 'built-in',
    color: 'blue',
    systemPrompt: `你是一个只读侦察专家。你的任务是高效地搜索和阅读文件，回答用户的问题。

=== 关键规则：只读模式 ===
- 严禁创建、修改、删除任何文件
- 严禁执行任何修改系统状态的命令
- 只允许：read_file / list_dir / search_files / search_content / web_search / web_fetch

你的优势：
- 快速用 search_files 按模式查找文件
- 快速用 search_content 按正则搜索内容
- 并行读取多个相关文件

工作方式：
- 先用 search_files / search_content 大面积扫描
- 再用 read_file 精读关键文件
- 尽量并行调用工具以提高效率
- 最终用清晰的中文报告你的发现`,
  },
  {
    agentType: 'general',
    name: '通用助手',
    whenToUse:
      '处理独立的复杂子任务，需要读写文件或执行命令。继承父 agent 的全部工具能力，在独立上下文中工作。适合需要多步骤、多工具配合的子任务。',
    description: '通用子任务 agent',
    tools: ['*'],
    model: undefined,
    maxTurns: 50,
    source: 'built-in',
    color: 'green',
    systemPrompt: `你是一个通用子任务 agent。你在独立的上下文中工作，拥有完整的工具能力。

你的任务是完成父 agent 分派的子任务。你应该：
- 高效使用工具完成任务
- 遇到问题自主决策，不要等待用户输入
- 完成后用清晰的中文总结你的工作成果

注意：你的对话上下文与父 agent 隔离，父 agent 只会收到你的最终总结。`,
  },
]

// ── frontmatter 解析 ──

// 解析 agent 文件的 frontmatter 与正文
// 格式：---\nkey: value\n---\n\nbody
export function parseAgentFrontmatter(content: string): {
  frontmatter: Record<string, string>
  body: string
} {
  const result: { frontmatter: Record<string, string>; body: string } = {
    frontmatter: {},
    body: '',
  }
  // 兼容 \r\n 与 \n
  const normalized = content.replace(/\r\n/g, '\n')
  // 必须以 --- 开头
  if (!normalized.startsWith('---\n')) {
    result.body = content
    return result
  }
  // 找到结束的 --- 行
  const endMatch = normalized.match(/\n---\s*\n/)
  if (!endMatch || endMatch.index === undefined) {
    result.body = content
    return result
  }
  const fmBlock = normalized.slice(4, endMatch.index) // 跳过开头的 "---\n"
  const bodyRaw = normalized.slice(endMatch.index + endMatch[0].length)
  // body 去掉开头的空行
  result.body = bodyRaw.replace(/^\n+/, '')

  for (const rawLine of fmBlock.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (!key) continue
    result.frontmatter[key] = value
  }
  return result
}

// 解析数组语法 [a, b, c]：去方括号、按逗号分割、trim
function parseStringArray(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '').trim()
  if (!inner) return []
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// 从 filename 去掉路径与扩展名，作为 agentType 兜底
function basenameNoExt(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || filename
  const dotIdx = base.lastIndexOf('.')
  return dotIdx > 0 ? base.slice(0, dotIdx) : base
}

// ── 自定义 agent 加载 ──

export async function loadCustomAgents(workingDir: string): Promise<AgentDefinition[]> {
  let files: Array<{ filename: string; content: string }>
  try {
    files = await ipc.scanAgents(workingDir)
  } catch {
    return []
  }
  const agents: AgentDefinition[] = []
  for (const file of files) {
    try {
      const { frontmatter, body } = parseAgentFrontmatter(file.content)
      const agentType = frontmatter.name?.trim() || basenameNoExt(file.filename)
      const description = frontmatter.description?.trim() ?? ''
      const displayName = description || agentType
      const whenToUse = frontmatter.whenToUse?.trim() || description
      const tools = parseStringArray(frontmatter.tools)
      const disallowedTools = parseStringArray(frontmatter.disallowedTools)
      const model = frontmatter.model?.trim() || undefined
      const maxTurnsRaw = frontmatter.maxTurns?.trim()
      let maxTurns: number | undefined
      if (maxTurnsRaw) {
        const parsed = parseInt(maxTurnsRaw, 10)
        maxTurns = Number.isFinite(parsed) && parsed > 0
          ? Math.min(parsed, MAX_CUSTOM_AGENT_TURNS)
          : undefined
      }
      const color = frontmatter.color?.trim() || undefined

      agents.push({
        agentType,
        name: displayName,
        whenToUse,
        description,
        tools,
        disallowedTools,
        model,
        maxTurns,
        color,
        systemPrompt: body,
        source: 'custom',
      })
    } catch {
      // 单个文件解析失败跳过，不中断后续文件
      continue
    }
  }
  return agents
}

// ── 合并内置与自定义 agent ──

// Built-in agent identifiers stay reserved so project-local definitions cannot alter
// the permissions or behavior users expect from standard agent types.
export async function getAllAgents(workingDir: string): Promise<AgentDefinition[]> {
  const custom = await loadCustomAgents(workingDir)
  const map = new Map<string, AgentDefinition>()
  for (const a of BUILTIN_AGENTS) map.set(a.agentType, a)
  for (const a of custom) {
    if (!map.has(a.agentType)) map.set(a.agentType, a)
  }
  return Array.from(map.values())
}

// ── 按 agentType 查找 ──

export async function findAgent(
  agentType: string,
  workingDir: string,
): Promise<AgentDefinition | null> {
  const all = await getAllAgents(workingDir)
  return all.find((a) => a.agentType === agentType) ?? null
}
