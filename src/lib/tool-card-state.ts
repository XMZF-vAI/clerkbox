/**
 * 工具卡展开状态仓库 + 完成边沿的自动动作决策（纯逻辑，无 DOM / React 依赖）。
 *
 * 为什么需要它（对标 ZCode ToolLayout 的折叠状态机）：
 * - 展开态放组件 useState 里，虚拟行重挂 / 会话切回就丢；模块级 Map 以
 *   toolCall.id（跨重渲稳定）为键持久，重挂后第一帧就恢复用户的展开位置。
 * - 「完成后自动展开 / 收起」对应 ZCode 的 autoOpen / autoCollapseOnComplete：
 *   写类工具完成瞬间自动展开看 diff；长输出工具完成瞬间把流式期间展开的明细
 *   收起，防完成后内容变长把视口摊乱。两者都以「用户手动操作过」为最高否决，
 *   且每行只自动动作一次——自动动作永远不与用户抢方向盘。
 */

/** 展开态记录上限：超长会话防内存膨胀（LRU，写入序 ≈ 行序，旧行先淘汰） */
export const MAX_TOOL_CARD_STATE_ENTRIES = 800

/** 完成边沿的自动动作结果 */
export type ToolCardAutoAction = 'open' | 'collapse' | 'none'

/** 写类工具：完成后自动展开明细——diff 是用户最想立刻看到的东西 */
const WRITE_TOOLS = new Set(['write_file', 'search_replace', 'edit_file'])

const openState = new Map<string, boolean>()
const userTouched = new Set<string>()
const autoActed = new Set<string>()

/** 读取持久展开态；未记录返回 undefined（组件回退到收起） */
export function getToolCardOpen(id: string): boolean | undefined {
  return openState.get(id)
}

/** 记录展开态。userAction=true 表示来自用户点击——该行此后不再被自动动作。 */
export function setToolCardOpen(id: string, open: boolean, options: { userAction?: boolean } = {}): void {
  // 先删再插把该行挪到「最新」端（Map 迭代序 = 插入序）
  openState.delete(id)
  openState.set(id, open)
  while (openState.size > MAX_TOOL_CARD_STATE_ENTRIES) {
    const oldest = openState.keys().next()
    if (oldest.done) break
    openState.delete(oldest.value)
  }
  if (options.userAction) userTouched.add(id)
}

/** 用户是否手动操作过该行（点开/收起过） */
export function hasUserTouched(id: string): boolean {
  return userTouched.has(id)
}

/** 记账：该行已经自动动作过（每行一次封顶） */
export function markAutoActed(id: string): void {
  autoActed.add(id)
}

export function hasAutoActed(id: string): boolean {
  return autoActed.has(id)
}

/**
 * 完成边沿（running→完成）的自动动作裁决：
 * - 非完成边沿 → none；
 * - 用户手动操作过 / 已自动动作过 → none（用户优先、一次性）；
 * - 写类且未展开 → open（完成后立刻看到 diff）；
 * - 非写类且已展开 → collapse（长输出完成后不摊开）；
 * - 其余 → none。
 */
export function resolveToolCardAutoAction(input: {
  wasRunning: boolean
  isRunning: boolean
  isOpen: boolean
  userTouched: boolean
  toolName: string
  hasAutoActed: boolean
}): ToolCardAutoAction {
  if (!input.wasRunning || input.isRunning) return 'none'
  if (input.userTouched || input.hasAutoActed) return 'none'
  if (WRITE_TOOLS.has(input.toolName)) return input.isOpen ? 'none' : 'open'
  return input.isOpen ? 'collapse' : 'none'
}

/** ToolRunGroup 的持久键：锚定组内首行——流式追加不改组身份（ZCode 同款语义） */
export function toolGroupStateKey(firstToolCallId: string): string {
  return `group:${firstToolCallId}`
}

/** 单测用：清空全部模块状态 */
export function resetToolCardStateForTests(): void {
  openState.clear()
  userTouched.clear()
  autoActed.clear()
}
