/**
 * 权限三期集成守卫（源码文本断言，与 security-modes 同口径）。
 *
 * 钉四件事：
 *  1. 规则引擎在 checkToolPermission 里，deny 前置且 allow 免打扰；
 *  2. 所有审批门统一走 askPermission（对话内卡优先、原生框 fallback），
 *     渲染层 confirmInChat 不再挑 reason；
 *  3. 项目级选项写 settings 持久规则，且危险命令/系统目录不落 allow 规则；
 *  4. i18n 键与决策标签齐备。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

const loop = read('agent-core/loop.ts')
const card = read('components/chat/PermissionCard.tsx')
const useAgent = read('hooks/use-agent.ts')
const rules = read('lib/permission-rules.ts')
const store = read('stores/settings-store.ts')
const preview = read('lib/permission-preview.ts')

describe('项目级持久规则接进判定引擎', () => {
  it('规则命中在审批门之前、plan/spec 之后；deny 覆盖 full 档', () => {
    expect(loop).toContain('matchPermissionRule(ports.settings.permissionRules ?? []')
    expect(loop).toContain("if (ruleHit?.verdict === 'deny')")
    expect(loop).toContain("const ruleAllows = ruleHit?.verdict === 'allow'")
    const specEnd = loop.indexOf("if (taskMode === 'spec')")
    const ruleAt = loop.indexOf('const ruleHit = matchPermissionRule')
    expect(ruleAt).toBeGreaterThan(specEnd)
    const fullAt = loop.indexOf("if (approvalMode === 'full') return { allowed: true }")
    expect(ruleAt).toBeLessThan(fullAt)
  })

  it('manual 档的目录外/写确认尊重 allow 规则', () => {
    expect(loop).toContain("approvalMode === 'manual' && !ruleAllows && workingDir")
    expect(loop).toContain('if (approvalMode === \'manual\' && !ruleAllows && workingDir)')
  })

  it('规则随 settings 持久化（不动 db schema）', () => {
    expect(store).toContain('permissionRules: []')
    expect(store).toContain('upsertPermissionRule')
    expect(store).toContain('removePermissionRule')
    expect(store).toContain('Array.isArray(p.permissionRules)')
  })

  it('危险命令与系统目录路径不生成 allow 规则', () => {
    expect(rules).toContain('if (isDangerousCommand(command)) return null')
    expect(rules).toContain('if (isSystemPath(resolved)) return null')
  })
})

describe('审批确认统一进对话', () => {
  it('loop 里 6 个审批门全走 askPermission，只有 helper 内部保留 confirm 回落', () => {
    const asks = loop.match(/askPermission\(ports,/g) ?? []
    expect(asks.length).toBe(6)
    const confirms = loop.match(/ports\.permission\.confirm\(/g) ?? []
    expect(confirms.length).toBe(1) // 仅 askPermission 内部的 fallback
  })

  it('渲染层 confirmInChat 对所有 reason 开放（不再只放行 workflow-script）', () => {
    expect(useAgent).not.toContain("if (request.reason !== 'workflow-script') return null")
    expect(useAgent).toContain('return requestLocalPermission({ sessionId, requestId: makeId(), ...request })')
  })

  it('会话停止时挂起审批被兜底兑现为拒绝', () => {
    expect(useAgent).toContain('cancelLocalPermissions(sessionId)')
  })
})

describe('项目级选项与决策映射', () => {
  it('五种决策都有标签，且危险命令卡片裁掉项目级选项', () => {
    for (const key of ['resultDenyAlways', 'resultAllowProject', 'allowProject', 'denyAlways']) {
      expect(card).toContain(key)
    }
    expect(card).toContain("['allow_session', 'allow_project', 'deny_always'].includes(option.decision)")
    expect(card).toContain('supportsProjectRules')
  })

  it('两张卡片都写规则，且宿主决议的 approved 映射不把 deny_always 当批准', () => {
    expect(card).toContain('persistProjectRule(decision,')
    expect(card).toContain("approved: decision === 'allow_once' || decision === 'allow_session' || decision === 'allow_project'")
  })

  it('decisionApproves / decisionToScope 覆盖新决策', () => {
    expect(preview).toContain("decision === 'allow_project'")
    expect(preview).toContain("decision === 'allow_session' ? 'session' : 'once'")
  })
})
