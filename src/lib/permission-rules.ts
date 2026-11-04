/**
 * 持久权限规则（权限三期 · 报告 04 第一期）。
 *
 * ZCode 的规则化本质：审批不再只活在「这一次会话的内存里」，而是按项目作用域
 * 落一条可审计的 allow/deny，重启后仍然生效。CB 这里刻意做**轻量版**：
 * 纯函数 + 随 settings 的 zustand/persist 一起序列化，不动 clerkbox.db schema。
 *
 * 三类 subject（先做最有把握的精确匹配，稳定前缀规则放在二期）：
 *  - exact-command：`execute_command` 的命令行原文（trim 后完全一致）
 *  - exact-path    ：写类工具的绝对路径（与 preview.target 同源）
 *  - command-prefix：命令行以给定前缀开头（`npm run ` 这类可复用的安全族）
 *
 * 判定方向 fail-closed：deny 永远优先于 allow，且 deny 不受「完全访问」档位绕过
 * （修 ZCode 瀑布里 disallowedTools 排在 yolo 直通之后的历史顺序问题）。
 * 危险命令不写规则：调用方在生成建议规则时已过滤，见 buildSuggestedRule。
 */
import { buildPermissionPreview } from './permission-preview'
import { isDangerousCommand } from './permission-engine'
import { isSystemPath, resolveToolPath } from './path-safety'

export type RuleVerdict = 'allow' | 'deny'
export type RuleSubjectKind = 'exact-command' | 'exact-path' | 'command-prefix'

export interface PermissionRule {
  /** 稳定 id：subject + projectRoot 去重 */
  id: string
  verdict: RuleVerdict
  subject: RuleSubjectKind
  /** 归一化后的匹配值 */
  value: string
  /** 作用域：项目根路径（空串=全局，仅老数据兼容用） */
  projectRoot: string
  createdAt: number
}

/** 规则按项目根分桶后的持久化形状（随 settings 一起存） */
export type PermissionRuleBuckets = Record<string, PermissionRule[]>

/** 展示/生成建议规则用的一次审批上下文 */
export interface RuleTarget {
  tool: string
  args: Record<string, unknown>
  workingDir: string
}

export const PERMISSION_RULE_MAX_PER_PROJECT = 200

function normalizeRoot(root: string): string {
  return (root || '').trim().replace(/[\\/]+$/, '')
}

export function normalizeRuleValue(subject: RuleSubjectKind, value: string): string {
  const v = (value || '').trim()
  if (subject === 'exact-command') return v.replace(/\s+/g, ' ')
  return v
}

/** 建议规则：稳定、可解释、且绝不给危险命令开持久闸门 */
export function buildSuggestedRule(
  target: RuleTarget,
  verdict: RuleVerdict,
  projectRoot: string,
  now = Date.now()
): PermissionRule | null {
  const preview = buildPermissionPreview(target.tool, target.args, { workingDir: target.workingDir })
  let subject: RuleSubjectKind
  let value: string

  if (target.tool === 'execute_command') {
    const command = String(target.args.command ?? '').trim()
    if (!command) return null
    // 危险命令一律不落规则（user-once 语义）：哪怕用户点了「始终允许」也不写
    if (isDangerousCommand(command)) return null
    subject = 'exact-command'
    value = command
  } else if (target.tool === 'write_file' || target.tool === 'search_replace' || target.tool === 'edit_file') {
    const raw = String(target.args.path ?? '')
    if (!raw) return null
    const resolved = target.workingDir ? resolveToolPath(target.workingDir, raw) : raw
    // 系统目录写入是最后一道防线：不能让一条 allow 规则把它变成永久免问
    if (isSystemPath(resolved)) return null
    subject = 'exact-path'
    value = resolved
  } else if (preview.kind === 'browser' || preview.kind === 'computer') {
    // 能力级授权按会话走（ctx.grantedAgentActions），不写成项目规则：
    // 浏览器/桌面动作的参数每次都不同，精确匹配永远命中不了，写了就是骗人
    return null
  } else {
    // 其余工具（MCP / 网络 / 工作流）先不支持项目规则，避免过度授权
    return null
  }

  const normalized = normalizeRuleValue(subject, value)
  if (!normalized) return null
  const root = normalizeRoot(projectRoot)
  return {
    id: `${subject}:${normalized}:${root}`,
    verdict,
    subject,
    value: normalized,
    projectRoot: root,
    createdAt: now,
  }
}

function ruleMatches(rule: PermissionRule, target: RuleTarget): boolean {
  const preview = buildPermissionPreview(target.tool, target.args, { workingDir: target.workingDir })
  if (rule.subject === 'exact-command') {
    if (target.tool !== 'execute_command') return false
    return normalizeRuleValue('exact-command', String(target.args.command ?? '')) === rule.value
  }
  if (rule.subject === 'command-prefix') {
    if (target.tool !== 'execute_command') return false
    return normalizeRuleValue('exact-command', String(target.args.command ?? '')).startsWith(rule.value)
  }
  if (rule.subject === 'exact-path') {
    if (!['write_file', 'search_replace', 'edit_file'].includes(target.tool)) return false
    const raw = String(target.args.path ?? '')
    const resolved = target.workingDir ? resolveToolPath(target.workingDir, raw) : raw
    return resolved === rule.value || preview.target === rule.value
  }
  return false
}

/**
 * 在一个项目的规则集合里查最优先结果。deny 优先；同 verdict 取最新一条。
 * 纯函数：不读写 store，调用方（checkToolPermission）自行取快照。
 */
export function matchPermissionRule(
  rules: PermissionRule[],
  target: RuleTarget,
  projectRoot: string
): { verdict: RuleVerdict; rule: PermissionRule } | null {
  const root = normalizeRoot(projectRoot)
  const scoped = rules.filter((r) => normalizeRoot(r.projectRoot) === root || !r.projectRoot)
  let hit: PermissionRule | null = null
  for (const rule of scoped) {
    if (!ruleMatches(rule, target)) continue
    if (rule.verdict === 'deny') return { verdict: 'deny', rule }
    if (!hit || rule.createdAt >= hit.createdAt) hit = rule
  }
  return hit ? { verdict: hit.verdict, rule: hit } : null
}

/** 写入/删除规则（返回新数组，不 mutate 入参）；同 id 覆盖，超出上限丢最旧的 */
export function upsertPermissionRule(rules: PermissionRule[], rule: PermissionRule): PermissionRule[] {
  const next = rules.filter((r) => r.id !== rule.id)
  next.push(rule)
  const root = normalizeRoot(rule.projectRoot)
  const sameRoot = next.filter((r) => normalizeRoot(r.projectRoot) === root)
  if (sameRoot.length <= PERMISSION_RULE_MAX_PER_PROJECT) return next
  const oldest = [...sameRoot].sort((a, b) => a.createdAt - b.createdAt)[0]
  return oldest ? next.filter((r) => r.id !== oldest.id) : next
}

export function removePermissionRule(rules: PermissionRule[], id: string): PermissionRule[] {
  return rules.filter((r) => r.id !== id)
}
