import type { AgentDefinition, ReasoningEffort } from '../types/agent'
import { ipc } from './ipc-client'

/**
 * 自定义 agent 的 maxTurns 显式值上限。与主循环 MAX_REACT_ITERATIONS 同值同语义：
 * 子代理轮次是防失控护栏，显式配置也不该越过主循环自己的天花板。
 * （未写 maxTurns 的 profile 走 loop 的 DEFAULT_SUBAGENT_MAX_TURNS 统一默认。）
 */
export const SUBAGENT_MAX_TURNS_CAP = 500

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

type FrontmatterValue = string | string[]

// 解析 agent 文件的 frontmatter 与正文
// 格式：---\nkey: value\n---\n\nbody
//
// 宽松解析（对齐 ZCode 的防注入思路）：刻意不用完整 YAML 引擎——
// 嵌套 mapping（如 mcpServers:）这类能携带结构性注入的字段直接忽略；
// 支持的是用户真正会用到的三件事：引号值、行内数组、dash 列表。
export function parseAgentFrontmatter(content: string): {
  frontmatter: Record<string, FrontmatterValue>
  body: string
} {
  const result: { frontmatter: Record<string, FrontmatterValue>; body: string } = {
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

  const lines = fmBlock.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (!key) continue

    if (value === '') {
      // 空值后面跟缩进 dash 行 → dash 列表；跟其它缩进行（嵌套 mapping）→ 忽略（防注入）
      const items: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j]!
        if (!next.trim() || next.trim().startsWith('#')) { j++; continue }
        if (/^\s+-\s+/.test(next) || /^\s+-\S/.test(next)) {
          items.push(unquoteScalar(next.replace(/^\s+-\s*/, '').trim()))
          j++
          continue
        }
        break
      }
      if (items.length > 0) {
        result.frontmatter[key] = items
        i = j - 1
      }
      continue
    }
    result.frontmatter[key] = unquoteScalar(value)
  }
  return result
}

/** 剥掉成对引号并反转义引号内的 \"（宽松：不成对的引号原样保留） */
function unquoteScalar(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1)
      return first === '"' ? inner.replace(/\\"/g, '"') : inner
    }
  }
  return trimmed
}

/** 工具列表字段：支持 dash 列表、行内 [a, b] 与逗号分隔三种写法 */
function parseStringArray(raw: FrontmatterValue | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) {
    const items = raw.map((s) => s.trim()).filter((s) => s.length > 0)
    return items.length > 0 ? items : undefined
  }
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '').trim()
  if (!inner) return undefined
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function parseBoolean(raw: FrontmatterValue | undefined): boolean | undefined {
  if (raw === undefined || Array.isArray(raw)) return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === 'yes') return true
  if (v === 'false' || v === 'no') return false
  return undefined
}

function parsePositiveInt(raw: FrontmatterValue | undefined, cap?: number): number | undefined {
  if (raw === undefined || Array.isArray(raw)) return undefined
  const parsed = parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return cap !== undefined ? Math.min(parsed, cap) : parsed
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh']

function parseReasoningEffort(raw: FrontmatterValue | undefined): ReasoningEffort | undefined {
  if (raw === undefined || Array.isArray(raw)) return undefined
  const v = raw.trim().toLowerCase() as ReasoningEffort
  return REASONING_EFFORTS.includes(v) ? v : undefined
}

// 从 filename 去掉路径与扩展名，作为 agentType 兜底
function basenameNoExt(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || filename
  const dotIdx = base.lastIndexOf('.')
  return dotIdx > 0 ? base.slice(0, dotIdx) : base
}

// ── 自定义 agent 加载 ──

export async function loadCustomAgents(workingDir: string): Promise<AgentDefinition[]> {
  let files: Array<{ filename: string; content: string; origin?: 'user' | 'project' }>
  try {
    files = await ipc.scanAgents(workingDir)
  } catch {
    return []
  }
  const agents: AgentDefinition[] = []
  for (const file of files) {
    try {
      const { frontmatter, body } = parseAgentFrontmatter(file.content)
      const agentType = (Array.isArray(frontmatter.name) ? '' : frontmatter.name?.trim()) || basenameNoExt(file.filename)
      const description = Array.isArray(frontmatter.description) ? '' : frontmatter.description?.trim() ?? ''
      const displayName = description || agentType
      const whenToUse = Array.isArray(frontmatter.whenToUse) ? '' : frontmatter.whenToUse?.trim() || description
      const tools = parseStringArray(frontmatter.tools)
      const disallowedTools = parseStringArray(frontmatter.disallowedTools)
      const model = Array.isArray(frontmatter.model) ? undefined : frontmatter.model?.trim() || undefined
      const maxTurns = parsePositiveInt(frontmatter.maxTurns, SUBAGENT_MAX_TURNS_CAP)
      const color = Array.isArray(frontmatter.color) ? undefined : frontmatter.color?.trim() || undefined
      const reasoningEffort = parseReasoningEffort(frontmatter.reasoningEffort)
      const thinking = parseBoolean(frontmatter.thinking)
      const thinkingBudget = parsePositiveInt(frontmatter.thinkingBudget)
      const background = parseBoolean(frontmatter.background)

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
        reasoningEffort,
        thinking,
        thinkingBudget,
        background,
        systemPrompt: body,
        source: 'custom',
        origin: file.origin ?? 'project',
      })
    } catch {
      // 单个文件解析失败跳过，不中断后续文件
      continue
    }
  }
  return agents
}

// ── 合并内置与自定义 agent ──

// 三级合并：内置 < 用户级 < 项目级。同名覆盖（ZCode 同款语义）：
// 项目里的 code-reviewer 可以整体换掉内置/用户级的同名定义——
// 这是 profile 系统的主能力而不是漏洞（子代理的权限仍由执行层白/黑名单与
// 审批档位约束，profile 只能收窄、不能提升，见 checkToolPermission）。
export async function getAllAgents(workingDir: string): Promise<AgentDefinition[]> {
  const custom = await loadCustomAgents(workingDir)
  const map = new Map<string, AgentDefinition>()
  for (const a of BUILTIN_AGENTS) map.set(a.agentType, a)
  // 用户级先进、项目级后进 → 同名时项目级覆盖用户级
  for (const origin of ['user', 'project'] as const) {
    for (const a of custom) {
      if (a.origin === origin) map.set(a.agentType, a)
    }
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
