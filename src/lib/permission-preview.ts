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
import type { Message } from '../types/agent'

export type PermissionRiskLevel = 'dangerous' | 'warning' | 'info'
export type PermissionPreviewKind = 'command' | 'file' | 'network' | 'mcp' | 'generic'
export type PermissionDecision = 'deny' | 'allow_once' | 'allow_session'
/** 审批请求生命周期：待批准 / 已批准或已拒绝 / 已超时（阶段二宿主 fail-closed 时用） */
export type PermissionRequestStatus = 'pending' | 'resolved' | 'expired'

/** 会触发审批确认的工具（agent-core 的弹窗分支只覆盖命令执行与文件写入） */
export const APPROVAL_GATED_TOOLS = ['execute_command', 'write_file', 'search_replace', 'edit_file'] as const

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
  return name.startsWith(MCP_PREFIX)
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
      if (!call || settled.has(call.id) || !isApprovalGatedTool(call.name)) continue
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
      (raw.decision !== 'deny' && raw.decision !== 'allow_once' && raw.decision !== 'allow_session') ||
      typeof raw.tool !== 'string' ||
      typeof raw.target !== 'string' ||
      typeof raw.at !== 'number'
    ) {
      return null
    }
    return {
      decision: raw.decision,
      tool: raw.tool,
      target: raw.target,
      risk: raw.risk === 'dangerous' || raw.risk === 'warning' ? raw.risk : 'info',
      at: raw.at,
    }
  } catch {
    return null
  }
}
