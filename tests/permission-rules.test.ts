/**
 * 持久权限规则（权限三期）：纯函数层测试。
 * 守五件事：建议规则生成、危险命令绝不落规则、deny 优先、项目作用域隔离、
 * 上限收敛与删除，且不 mutate 入参。
 */
import { describe, expect, it } from 'vitest'
import {
  buildSuggestedRule,
  matchPermissionRule,
  upsertPermissionRule,
  removePermissionRule,
  PERMISSION_RULE_MAX_PER_PROJECT,
  type PermissionRule,
} from '../src/lib/permission-rules'

const ROOT = 'D:/proj'
const target = (tool: string, args: Record<string, unknown>, workingDir = ROOT) => ({ tool, args, workingDir })

describe('buildSuggestedRule', () => {
  it('命令 → exact-command（空白归一化）', () => {
    const rule = buildSuggestedRule(target('execute_command', { command: '  npm   run   build  ' }), 'allow', ROOT, 1)
    expect(rule?.subject).toBe('exact-command')
    expect(rule?.value).toBe('npm run build')
    expect(rule?.projectRoot).toBe(ROOT)
  })

  it('写文件 → exact-path（解析成绝对路径）', () => {
    const rule = buildSuggestedRule(target('write_file', { path: 'src/a.ts', content: 'x' }), 'allow', ROOT, 2)
    expect(rule?.subject).toBe('exact-path')
    expect(rule?.value).toContain('a.ts')
  })

  it('危险命令绝不生成规则（user-once 语义）', () => {
    expect(buildSuggestedRule(target('execute_command', { command: 'rm -rf build' }), 'allow', ROOT)).toBeNull()
    expect(buildSuggestedRule(target('execute_command', { command: 'git reset --hard' }), 'allow', ROOT)).toBeNull()
  })

  it('浏览器/桌面/MCP/工作流不生成规则（避免假授权）', () => {
    expect(buildSuggestedRule(target('browser_click', { x: 1, y: 2 }), 'allow', ROOT)).toBeNull()
    expect(buildSuggestedRule(target('mcp__srv__tool', {}), 'allow', ROOT)).toBeNull()
    expect(buildSuggestedRule(target('create_workflow', { name: 'w', script: '' }), 'allow', ROOT)).toBeNull()
  })
})

describe('matchPermissionRule', () => {
  const allow = buildSuggestedRule(target('execute_command', { command: 'npm run test' }), 'allow', ROOT, 10)!
  const deny = buildSuggestedRule(target('execute_command', { command: 'npm run test' }), 'deny', ROOT, 20)!

  it('命中 allow / 未命中返回 null', () => {
    expect(matchPermissionRule([allow], target('execute_command', { command: 'npm run test' }), ROOT)?.verdict).toBe('allow')
    expect(matchPermissionRule([allow], target('execute_command', { command: 'npm run build' }), ROOT)).toBeNull()
  })

  it('deny 优先于 allow（且不受顺序影响）', () => {
    expect(matchPermissionRule([allow, deny], target('execute_command', { command: 'npm run test' }), ROOT)?.verdict).toBe('deny')
    expect(matchPermissionRule([deny, allow], target('execute_command', { command: 'npm run test' }), ROOT)?.verdict).toBe('deny')
  })

  it('项目作用域隔离：别的项目规则不命中', () => {
    expect(matchPermissionRule([allow], target('execute_command', { command: 'npm run test' }), 'D:/other')).toBeNull()
  })

  it('命令前缀规则可复用', () => {
    const prefix: PermissionRule = { ...allow, id: 'p', subject: 'command-prefix', value: 'npm run ' }
    expect(matchPermissionRule([prefix], target('execute_command', { command: 'npm run lint' }), ROOT)?.verdict).toBe('allow')
  })
})

describe('upsert / remove', () => {
  it('同 id 覆盖而不是累积', () => {
    const a = buildSuggestedRule(target('execute_command', { command: 'a' }), 'allow', ROOT, 1)!
    const b = { ...a, verdict: 'deny' as const, createdAt: 2 }
    const out = upsertPermissionRule([a], b)
    expect(out).toHaveLength(1)
    expect(out[0]?.verdict).toBe('deny')
  })

  it('不 mutate 入参', () => {
    const a = buildSuggestedRule(target('execute_command', { command: 'a' }), 'allow', ROOT, 1)!
    const input = [a]
    upsertPermissionRule(input, { ...a, id: 'b' })
    expect(input).toHaveLength(1)
  })

  it('超过上限丢最旧的一条', () => {
    let rules: PermissionRule[] = []
    for (let i = 0; i < PERMISSION_RULE_MAX_PER_PROJECT + 5; i++) {
      rules = upsertPermissionRule(rules, {
        id: `r${i}`, verdict: 'allow', subject: 'exact-command', value: `cmd${i}`,
        projectRoot: ROOT, createdAt: i,
      })
    }
    expect(rules).toHaveLength(PERMISSION_RULE_MAX_PER_PROJECT)
    expect(rules.some((r) => r.id === 'r0')).toBe(false)
  })

  it('按 id 删除', () => {
    const rule = buildSuggestedRule(target('execute_command', { command: 'x' }), 'allow', ROOT, 1)!
    expect(removePermissionRule([rule], rule.id)).toHaveLength(0)
  })
})
