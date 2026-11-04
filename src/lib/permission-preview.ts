/**
 * 权限审批预览（批次 C · C2 阶段一）
 *
 * 纯函数层：从工具入参提取「给人看」的命令/路径原文 + 风险等级 + 会话放行匹配键，
 * 供 PermissionCard 渲染与审批留痕编解码使用。判定语义与 agent-core 的确认分支
 * 保持一致（危险命令走 permission-engine，路径边界走 path-safety），此处只做展示，
 * 不构成第二道权限判定，也不会放宽任何拦截。
 */
import { isDangerousCommand } from './permission-engine'
import { isPathInside, isSystemPath, resolveToolPath } from './path-safety'
import { agentActionFamily, isAgentActionToolReadOnly } from './agent-actions'
import { analyzeWorkflowScript, type WorkflowGraph } from './workflow-graph'
import type { Message } from '../types/agent'

export type PermissionRiskLevel = 'dangerous' | 'warning' | 'info'
export type PermissionPreviewKind = 'command' | 'file' | 'network' | 'mcp' | 'browser' | 'computer' | 'generic'
/**
 * 审批决策。前三档是原有语义；后两档（权限三期）写项目级持久规则：
 *  - allow_project：本项目内同类操作以后都放行
 *  - deny_always  ：本项目内同类操作以后都拒绝（连 full 档也不绕过）
 * 危险命令的卡片会过滤掉这两个选项，保持 user-once。
 */
export type PermissionDecision = 'deny' | 'allow_once' | 'allow_session' | 'allow_project' | 'deny_always'
/** 审批请求生命周期：待批准 / 已批准或已拒绝 / 已超时（阶段二宿主 fail-closed 时用） */
export type PermissionRequestStatus = 'pending' | 'resolved' | 'expired'

/** 会触发审批确认的工具（agent-core 的弹窗分支只覆盖命令执行、文件写入与 Agent 动作） */
export const APPROVAL_GATED_TOOLS = ['execute_command', 'write_file', 'search_replace', 'edit_file'] as const

/** 是否是有持久规则选项的决策（本地卡片据此写 settings.permissionRules） */
export function isPersistentDecision(decision: PermissionDecision): boolean {
  return decision === 'allow_project' || decision === 'deny_always'
}

/** 审批结果 → loop 需要的授权范围；项目级规则只放行本次，后续由规则引擎命中 */
export function decisionToScope(decision: PermissionDecision): 'once' | 'session' {
  return decision === 'allow_session' ? 'session' : 'once'
}

export function decisionApproves(decision: PermissionDecision): boolean {
  return decision === 'allow_once' || decision === 'allow_session' || decision === 'allow_project'
}

/** MCP 工具命名约定：mcp__<server>__<tool> */
const MCP_PREFIX = 'mcp__'

/** 等宽区最多展示的字符数（超出截断，卡片提示原文更长） */
export const PERMISSION_MONOSPACE_LIMIT = 4000

export interface PermissionPreview {
  /** 来源工具名（原始 name，UI 侧用 t(`tools.${tool}`) 取标签） */
  tool: string
  kind: PermissionPreviewKind
  risk: PermissionRiskLevel
  /** 等宽可横滚原文：命令行 / 目标路径 / URL / 参数 JSON */
  monospace: string
  /** 原文是否被截断 */
  truncated: boolean
  /** 风险说明的 i18n key（顺序即展示顺序） */
  reasonKeys: string[]
  /** 审计行与「本会话始终允许」用的目标（命令原文或绝对路径） */
  target: string
  /** 会话级放行匹配键：工具名 + 归一化目标 */
  grantKey: string
  /** MCP 服务器名（仅 mcp 类工具有值） */
  serverName?: string
  /**
   * 工作流静态图（仅 create_workflow）。确认卡据此画泳道流程图——
   * 这是**静态分析**的结果，不是执行真值，UI 必须一并说明。
   */
  graph?: WorkflowGraph
  /** 工作流脚本原文（仅 create_workflow）：「显示完整脚本」折叠块用它，而不是截断的预览 */
  script?: string
}

function truncate(text: string): { monospace: string; truncated: boolean } {
  if (text.length <= PERMISSION_MONOSPACE_LIMIT) return { monospace: text, truncated: false }
  return { monospace: text.slice(0, PERMISSION_MONOSPACE_LIMIT), truncated: true }
}

/** 拆解 MCP 工具名；非 MCP 工具返回 null */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return { server: rest, tool: '' }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/** 工具是否属于「需要审批」的那一类（决定卡片是否出现） */
export function isApprovalGatedTool(name: string): boolean {
  if ((APPROVAL_GATED_TOOLS as readonly string[]).includes(name)) return true
  if (name.startsWith(MCP_PREFIX)) return true
  // Agent 动作按「这次调用是否只读」判定：截图、读页面不必打断用户，点击和按键要
  return isAgentActionGated(name, {})
}

/** 门控工具名（不带入参）：用于无法拿到 args 的场景（列表渲染、审计解码） */
export function isAgentActionGated(name: string, args: Record<string, unknown>): boolean {
  if (!agentActionFamily(name)) return false
  return !isAgentActionToolReadOnly(name, args)
}

function stringifyArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2) ?? ''
  } catch {
    return String(args)
  }
}

/**
 * 由工具入参构造审批预览。
 * opts.workingDir 缺省时跳过「目录外」判定（宁可不提示，也不误报风险）。
 */
export function buildPermissionPreview(
  tool: string,
  args: Record<string, unknown>,
  opts: { workingDir?: string } = {}
): PermissionPreview {
  const workingDir = opts.workingDir || ''
  const base = { tool } as const

  if (tool === 'execute_command') {
    const command = String(args.command ?? '')
    const cwd = String(args.cwd ?? '')
    const reasonKeys: string[] = []
    let risk: PermissionRiskLevel = 'info'
    if (isDangerousCommand(command)) {
      risk = 'dangerous'
      reasonKeys.push('chat.permission.reasonDangerousCommand')
    }
    if (workingDir && cwd) {
      const resolvedCwd = resolveToolPath(workingDir, cwd)
      if (!isPathInside(resolvedCwd, workingDir)) {
        if (risk !== 'dangerous') risk = 'warning'
        reasonKeys.push('chat.permission.reasonOutsideWorkDir')
      }
    }
    const target = command
    return {
      ...base,
      kind: 'command',
      risk,
      ...truncate(target),
      reasonKeys,
      target,
      grantKey: `execute_command:${target.trim()}`,
    }
  }

  if (tool === 'write_file' || tool === 'search_replace' || tool === 'edit_file') {
    const rawPath = String(args.path ?? '')
    const resolved = workingDir ? resolveToolPath(workingDir, rawPath) : rawPath
    const reasonKeys: string[] = []
    let risk: PermissionRiskLevel = 'info'
    if (isSystemPath(resolved)) {
      risk = 'dangerous'
      reasonKeys.push('chat.permission.reasonSystemPath')
    }
    if (workingDir && resolved && !isPathInside(resolved, workingDir)) {
      if (risk !== 'dangerous') risk = 'warning'
      reasonKeys.push('chat.permission.reasonOutsideWorkDir')
    }
    const edits = Array.isArray(args.edits) ? args.edits.length : 0
    const monospace = edits > 1 ? `${resolved}\n× ${edits} 处编辑` : resolved
    return {
      ...base,
      kind: 'file',
      risk,
      ...truncate(monospace),
      reasonKeys,
      target: resolved,
      grantKey: `${tool}:${resolved}`,
    }
  }

  if (tool === 'web_fetch') {
    const url = String(args.url ?? '')
    return {
      ...base,
      kind: 'network',
      risk: 'info',
      ...truncate(url),
      reasonKeys: ['chat.permission.reasonExternalNetwork'],
      target: url,
      grantKey: `web_fetch:${url}`,
      serverName: undefined,
    }
  }

  const mcp = parseMcpToolName(tool)
  if (mcp) {
    const monospace = stringifyArgs(args)
    const target = mcp.tool ? `${mcp.server} · ${mcp.tool}` : mcp.server
    return {
      ...base,
      kind: 'mcp',
      risk: 'warning',
      ...truncate(monospace),
      reasonKeys: ['chat.permission.reasonMcpTool'],
      target,
      grantKey: `${tool}:${monospace}`,
      serverName: mcp.server,
    }
  }

  // Agent 动作：等宽区展示真正会被执行的那几个参数（坐标/URL/文本/键位），
  // 而不是把整个 args 摊开 —— 摊开会让「点了哪里」这件唯一重要的事淹没在默认值里
  const family = agentActionFamily(tool)
  if (family) {
    const monospace = renderAgentActionArgs(args)
    return {
      ...base,
      kind: family,
      risk: 'dangerous',
      ...truncate(monospace),
      reasonKeys: [family === 'computer' ? 'chat.permission.reasonComputerUse' : 'chat.permission.reasonBrowserUse'],
      target: monospace.split('\n')[0] || tool,
      // 会话级放行按「族 + 动作」归并：允许一次点击不该顺带允许下一次导航
      grantKey: `${tool}:${agentActionGrantScope(args)}`,
      serverName: undefined,
    }
  }

  // 续跑：过同一道脚本门，但内容只是 runId（脚本原文在 journal 里，与上次确认的一致）
  if (tool === 'resume_workflow') {
    const runId = String(args.runId ?? '')
    return {
      ...base,
      kind: 'generic',
      risk: 'warning',
      ...truncate(runId),
      reasonKeys: ['chat.permission.reasonWorkflowScript'],
      target: runId,
      grantKey: `resume_workflow:${runId}`,
      serverName: undefined,
    }
  }

  if (tool === 'create_workflow') {
    const name = String(args.name ?? '未命名工作流')
    const script = String(args.script ?? '')
    const head = script.split('\n').slice(0, 5).join('\n')
    const monospace = `${name}\n${head}${script.split('\n').length > 5 ? '\n…' : ''}`
    return {
      ...base,
      kind: 'generic',
      risk: 'warning',
      ...truncate(monospace),
      reasonKeys: ['chat.permission.reasonWorkflowScript'],
      target: name,
      // 会话级放行按**会话**归并，不按脚本指纹：模型每轮都会重写脚本，
      // 指纹级匹配让「本会话始终允许」永远命中不了（点了还是每次问）。
      // 语义与卡片上的文案一致：本会话内运行工作流不再询问。
      grantKey: 'create_workflow:session',
      serverName: undefined,
      // 静态图：确认卡画泳道流程图用；脚本没写成字面形态时可能只有少量站，UI 照实画
      graph: analyzeWorkflowScript(script),
      script,
    }
  }

  const monospace = stringifyArgs(args)
  return {
    ...base,
    kind: 'generic',
    risk: 'info',
    ...truncate(monospace),
    reasonKeys: [],
    target: tool,
    grantKey: `${tool}:${monospace}`,
    serverName: undefined,
  }
}

/**
 * Agent 动作的审批等宽区：只列会被执行的关键参数。
 * 顺序按「人最需要确认的那个」排：坐标 > 目标 > 内容。
 */
function renderAgentActionArgs(args: Record<string, unknown>): string {
  const lines: string[] = []
  const push = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    lines.push(`${label}: ${String(value)}`)
  }
  if (args.x !== undefined || args.y !== undefined) push('at', `(${args.x}, ${args.y})`)
  if (args.from_x !== undefined) push('from', `(${args.from_x}, ${args.from_y}) → (${args.to_x}, ${args.to_y})`)
  if (args.ref) push('ref', args.ref)
  if (args.url) push('url', args.url)
  if (args.selector) push('selector', args.selector)
  if (args.name) push('application', args.name)
  if (args.key) push('key', args.key)
  if (args.button) push('button', args.button)
  if (args.action) push('action', args.action)
  if (args.text !== undefined) {
    const text = String(args.text)
    lines.push(`text: ${text.length > 120 ? `${text.slice(0, 120)}… (${text.length} chars)` : text}`)
  }
  if (lines.length === 0) return stringifyArgs(args)
  return lines.join('\n')
}

/**
 * 会话级放行的归并键：同一族的同类动作放行一次。
 * 刻意不把坐标/文本纳入键 —— 否则「本会话始终允许」几乎永远命中不了，
 * 用户点了也只放行这一次，等于没有这个选项。
 */
function agentActionGrantScope(args: Record<string, unknown>): string {
  const key = typeof args.key === 'string' ? args.key.split('+').pop() ?? '' : ''
  return [
    typeof args.action === 'string' ? args.action : '',
    typeof args.button === 'string' ? args.button : '',
    key,
  ].filter(Boolean).join('|') || '*'
}

/** 尚未产出结果、且属于审批门控的最后一次工具调用（阶段一卡片的待审数据来源） */
export interface PendingApprovalCall {
  toolCallId: string
  tool: string
  args: Record<string, unknown>
}

/**
 * 从会话消息尾部定位「已发起但未收到结果」的门控工具调用。
 * 结果可能挂在 assistant 消息的 toolResults 上，也可能落在独立的 tool 消息里，
 * 两处都要计入已完成集合，否则卡片会在执行后继续残留。
 */
export function findPendingApprovalCall(messages: Message[]): PendingApprovalCall | null {
  const settled = new Set<string>()
  for (const msg of messages) {
    for (const res of msg.toolResults ?? []) settled.add(res.toolCallId)
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant' || !msg.toolCalls?.length) continue
    // 同一轮内按声明顺序执行，第一个未收尾的门控调用就是当前等待批准的那个
    for (const call of msg.toolCalls) {
      if (!call || settled.has(call.id)) continue
      // Agent 动作按入参判定门控（只读的截图不必打断用户），所以这里不能复用无参版本
      const gated = isApprovalGatedTool(call.name) || isAgentActionGated(call.name, call.arguments ?? {})
      if (!gated) continue
      return { toolCallId: call.id, tool: call.name, args: call.arguments ?? {} }
    }
    // 只在最后一条含工具调用的助手消息里找，更早的调用必然已收尾
    return null
  }
  return null
}

/** 审批留痕在对话流里的编码前缀（role=system 不进模型上下文，只做 UI 留痕） */
export const PERMISSION_AUDIT_PREFIX = '__PERMISSION_AUDIT__'

export interface PermissionAuditRecord {
  decision: PermissionDecision
  tool: string
  target: string
  risk: PermissionRiskLevel
  at: number
}

/** 审批结果 → 可折叠 system 行的 content（JSON 负载，UI 侧按 i18n 渲染） */
export function formatPermissionAuditContent(record: PermissionAuditRecord): string {
  return `${PERMISSION_AUDIT_PREFIX}${JSON.stringify(record)}`
}

/** 解析审批留痕行；非留痕或负载损坏时返回 null（回落到普通消息渲染） */
export function parsePermissionAudit(content: string): PermissionAuditRecord | null {
  if (!content.startsWith(PERMISSION_AUDIT_PREFIX)) return null
  try {
    const raw = JSON.parse(content.slice(PERMISSION_AUDIT_PREFIX.length)) as Partial<PermissionAuditRecord>
    if (
      !raw ||
      !['deny', 'deny_always', 'allow_once', 'allow_session', 'allow_project'].includes(raw.decision as string) ||
      typeof raw.tool !== 'string' ||
      typeof raw.target !== 'string' ||
      typeof raw.at !== 'number'
    ) {
      return null
    }
    return {
      decision: raw.decision as PermissionDecision,
      tool: raw.tool,
      target: raw.target,
      risk: raw.risk === 'dangerous' || raw.risk === 'warning' ? raw.risk : 'info',
      at: raw.at,
    }
  } catch {
    return null
  }
}
