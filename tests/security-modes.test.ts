/**
 * 三档安全模式语义守卫（变更前确认 / 自主模式 / 完全访问）。
 *
 * 纠偏记录（2026-11-03 用户实机截图）：安全模式只有三档，plan 是独立的
 * planEnabled 协作开关，不在安全菜单里。本文件把三档的**交互安全语义**钉死：
 *  1. 升档到「完全访问」必须过风险确认门（勾选「我已了解风险」，每次重新勾）——
 *     ZCode 的 YOLO 门同款；降档即时生效不加摩擦。
 *  2. 危险命令的审批只给「允许一次」（user-once）——内容每条都不同的高危命令
 *     不能有持久闸门；浏览/桌面的「本会话允许」是能力级授权，不受影响。
 *  3. 三档在 loop 里的判定分支保持现状（manual 全问 / auto 免目录外、危险命令
 *     与系统目录兜底 / full 直通；create_workflow 门仅 full 档免问）。
 *
 * 与 chat-timeline-look 同一种做法：源码文本断言（抄机制不抄视觉）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

const chatInput = read('components/chat/ChatInput.tsx')
const permissionCard = read('components/chat/PermissionCard.tsx')
const loop = read('agent-core/loop.ts')

describe('完全访问切换的风险确认门', () => {
  it('下拉里点「完全访问」不直接落设置——先进确认弹层', () => {
    // 菜单项 onClick：isFull 且当前不是 full 时 return，绝不顺手 updateSettings
    const menuClick = chatInput.slice(chatInput.indexOf('降档/平档切换即时生效'), chatInput.indexOf('降档/平档切换即时生效') + 600)
    expect(menuClick).toContain("if (isFull && approvalMode !== 'full')")
    expect(menuClick).toContain('setFullAccessConfirm(true)')
    expect(menuClick).toContain('return')
    // 菜单项里唯一的 updateSettings 在 return 之后（降档路径）
    const afterReturn = menuClick.slice(menuClick.indexOf('return'))
    expect(afterReturn).toContain("updateSettings({ approvalMode: item.id })")
  })

  it('确认弹层的确认按钮被「我已了解风险」复选框门控，且只在弹层里落 full', () => {
    const dialog = chatInput.slice(chatInput.indexOf('approval-full-confirm-title'))
    expect(dialog).toContain('checked={fullAccessAck}')
    expect(dialog).toContain('disabled={!fullAccessAck}')
    expect(dialog).toContain("updateSettings({ approvalMode: 'full' })")
  })

  it('勾选状态不持久：确认弹层挂载时强制重置为未勾选', () => {
    expect(chatInput).toContain('setFullAccessAck(false)')
  })
})

describe('危险命令的 user-once 语义', () => {
  it('审批卡对危险命令裁掉所有持久/会话级选项（只留允许一次/拒绝）', () => {
    expect(permissionCard).toContain("preview.kind === 'command' && preview.risk === 'dangerous'")
    expect(permissionCard).toContain("!(dangerOnce && ['allow_session', 'allow_project', 'deny_always'].includes(option.decision))")
  })

  it('能力级授权不受影响：浏览/桌面的会话允许仍然存在', () => {
    expect(permissionCard).toContain("'chat.permission.allowAlways'")
    expect(permissionCard).toContain("'chat.permission.allowSessionWorkflow'")
    expect(permissionCard).toContain('dangerOnceHint')
  })

  it('键盘数字直达按选项数收敛（两选项时 3 不再误触）', () => {
    expect(permissionCard).toContain("Number(e.key) <= options.length")
  })
})

describe('三档在 loop 里的判定分支', () => {
  it('manual：危险命令与目录外都确认；auto：危险命令仍兜底；full：全部免问', () => {
    expect(loop).toContain("toolName === 'execute_command' && approvalMode !== 'full'")
    expect(loop).toContain('isDangerousCommand(cmd)')
    expect(loop).toContain("approvalMode === 'manual' && !ruleAllows && workingDir && commandCwd && !isPathInside(commandCwd, workingDir)")
  })

  it('create_workflow / resume_workflow 门仅 full 档免问（其余档脚本必过目）', () => {
    // 门按 WORKFLOW_GATED_TOOLS 表判定：续跑也是执行脚本，同等过目
    expect(loop).toContain('WORKFLOW_GATED_TOOLS.includes(toolName) && approvalMode !== \'full\'')
    expect(read('lib/workflow-tools.ts')).toContain('WORKFLOW_GATED_TOOLS = [WORKFLOW_TOOL_NAME, RESUME_WORKFLOW_TOOL_NAME]')
  })
})

describe('manual 档的写确认（变更前确认语义）', () => {
  it('manual 档每一次写文件都先问：走统一 askPermission（卡优先、原生框 fallback）', () => {
    expect(loop).toContain("approvalMode === 'manual' && !ruleAllows && workingDir")
    expect(loop).toContain("reason: 'file-write' as const")
    expect(loop).toContain('askPermission(ports, {')
    expect(loop).toContain('ports.permission.confirmInChat ? await ports.permission.confirmInChat(request) : null')
  })

  it('auto/full 档不新增写确认（语义不变）', () => {
    // manual 分支整体包在 approvalMode === 'manual' 里；auto 分支不存在写确认
    const manualBlock = loop.slice(loop.indexOf("if (approvalMode === 'manual' && !ruleAllows && workingDir)"), loop.indexOf('return { allowed: true }', loop.indexOf("if (approvalMode === 'manual' && !ruleAllows && workingDir)")))
    expect(manualBlock).toContain("reason: 'file-write' as const")
  })

  it('审批卡渲染执行期同一套 diff（FileDiffPreview 接线）', () => {
    const card = read('components/chat/PermissionCard.tsx')
    expect(card).toContain("preview.kind === 'file'")
    expect(card).toContain('computeEditDiff')
    expect(card).toContain('<DiffLineList')
  })
})
