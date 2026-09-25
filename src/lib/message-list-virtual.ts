/**
 * C3 消息列表虚拟滚动的纯策略层：启用阈值、行高估算、粘底判定、可见行选择、滚动锚点。
 * 不依赖 DOM / React，也不 import 虚拟库运行时，便于单测覆盖「虚拟化只改容器层」的不变量。
 */

/** turn 数不足该阈值时走原有全量渲染路径（小会话零风险） */
export const VIRTUALIZE_MIN_TURNS = 30

/** 距底小于该像素视为「贴着最新消息」，沿用虚拟化前的 THRESHOLD */
export const NEAR_BOTTOM_PX = 100

/** 视口外额外挂载的行数，用于缓冲快速滚动时的白屏 */
export const VIRTUAL_OVERSCAN = 4

/**
 * 行间距不写在这里：它由行自身的 `pt-6`（rem）承载，被 measureElement 计入行高，
 * 于是虚拟化列表与全量列表共用同一套节奏，且随 --ui-font-size 一起缩放（DESIGN §3.1/§3.3）。
 * 因此下面的估算值同样按「含行顶间距」的口径给出。
 */
const TURN_BASE_PX = 184
const TURN_PER_MESSAGE_PX = 72
const TURN_MAX_PX = 1200

/**
 * 单个 turn 的保守行高估算：只按消息数线性外推并封顶。
 * 估大估小都会由 measureElement 动态修正，封顶是为了避免超长 agentic 回合把
 * 滚动条撑到离谱、进而放大首次测量的补偿抖动。
 */
export function estimateTurnSizePx(messageCount: number): number {
  const n = Number.isFinite(messageCount) ? Math.max(1, Math.floor(messageCount)) : 1
  return Math.min(TURN_BASE_PX + (n - 1) * TURN_PER_MESSAGE_PX, TURN_MAX_PX)
}

/** 每行估算高度（含行顶间距），供虚拟列表与滚动恢复共用同一份口径 */
export function turnSizeEstimates(turns: ReadonlyArray<{ aiMessages: unknown[] }>): number[] {
  return turns.map((turn) => estimateTurnSizePx(1 + turn.aiMessages.length))
}

/** index 之前的累计偏移：paddingStart / gap 均为 0，行距已含在行高里 */
export function estimateStartPx(sizes: readonly number[], index: number): number {
  const safeIndex = Math.max(0, Math.min(Math.floor(index), sizes.length))
  let start = 0
  for (let i = 0; i < safeIndex; i++) start += sizes[i]
  return start
}

/** 全部行的估算总高，也是「贴底」时的估算滚动偏移 */
export function estimateTotalSizePx(sizes: readonly number[]): number {
  return estimateStartPx(sizes, sizes.length)
}

/**
 * 是否启用虚拟化。未锁定时要求「达到阈值且正粘底」才翻转：
 * 上翻阅读历史时切换布局会让整列按估算重排，视口会跳位，所以等到回到底部再切。
 * 一旦锁定就不再回落（压缩后 turn 变少也继续虚拟化，避免来回抖动）。
 */
export function shouldVirtualizeTurns(turnCount: number, latched: boolean, nearBottom: boolean): boolean {
  if (latched) return true
  return turnCount >= VIRTUALIZE_MIN_TURNS && nearBottom
}

/** 需要「永不回收」的流式尾部行下标：只有正在流式的最后一个 turn */
export function streamingTailIndex(count: number, isStreaming: boolean): number | null {
  if (!isStreaming || count <= 0) return null
  return count - 1
}

/** 把钉住行并入可见下标集合：去重 + 越界忽略，顺序由调用方渲染前统一排序 */
export function withPinnedIndex(base: readonly number[], count: number, pinnedIndex: number | null): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const push = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) return
    seen.add(index)
    out.push(index)
  }
  for (const index of base) push(index)
  if (pinnedIndex !== null) push(pinnedIndex)
  return out
}

export interface TurnRow {
  turnId: string
  index: number
  start: number
}

/**
 * 虚拟化下要渲染的行：必须是全量 turns 的「有序、无重复、下标合法」子集，
 * 且不改写、不复制 turn 数据本身（分组逻辑仍归 groupIntoTurns）。
 */
export function selectTurnRows<T extends { turnId: string }>(
  turns: readonly T[],
  items: ReadonlyArray<{ index: number; start: number }>
): Array<{ turn: T; row: TurnRow }> {
  const rows: Array<{ turn: T; row: TurnRow }> = []
  const seen = new Set<number>()
  for (const item of items) {
    const index = item.index
    if (!Number.isInteger(index) || index < 0 || index >= turns.length || seen.has(index)) continue
    seen.add(index)
    rows.push({ turn: turns[index], row: { turnId: turns[index].turnId, index, start: item.start } })
  }
  return rows.sort((a, b) => a.row.index - b.row.index)
}

/** 距底像素（与虚拟化前同一套算法，直接取 DOM 真实值） */
export function distanceToBottomPx(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  return scrollHeight - scrollTop - clientHeight
}

/** 粘底判定：与虚拟化前的 `distance < 100` 完全同式 */
export function isNearBottomDistance(distance: number): boolean {
  return distance < NEAR_BOTTOM_PX
}

export interface RowSpan {
  index: number
  /** 行顶相对容器视口顶边的距离，行滚出视口上方时为负 */
  top: number
  bottom: number
}

/**
 * 视口顶部落在哪一行：入参为按文档顺序排列的行矩形（相对容器视口顶边）。
 * 顶边已在视口之下的行直接截断——被钉住不回收的流式尾行永远排在最后，
 * 若不截断会被误判成「当前所在行」。落在行间距里时取上一行。
 */
export function findTopVisibleRow(
  spans: readonly RowSpan[],
  viewportTop: number
): { index: number; offsetWithinRow: number } | null {
  let fallback: RowSpan | null = null
  for (const span of spans) {
    if (span.top > viewportTop) break
    if (span.bottom > viewportTop) return { index: span.index, offsetWithinRow: viewportTop - span.top }
    fallback = span
  }
  return fallback ? { index: fallback.index, offsetWithinRow: viewportTop - fallback.top } : null
}
