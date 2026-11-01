/**
 * 对话时间线的行高缓存（纯数据结构，无 DOM / React 依赖）。
 *
 * 为什么需要它：@tanstack/react-virtual 自身的 measurementsCache 按 itemKey 缓存，
 * 行在窗口内卸载/重挂不丢测量；但**流式行高度持续增长时 virtualizer 会重置**
 * （turns 数组重建、组件 StrictMode 重挂、错误态 ↔ 时间线切换），
 * 缓存被清回 estimateSize 的固定值，导致滚动条跳动与底部锚定抖动。
 *
 * 这里以 turn 的稳定 id（turnId）为键做一层组件实例内持久缓存，
 * 保证「行卸载重挂 / virtualizer 重建后仍用上次的真实测量」，而不是回落成估算值。
 */

/** 未测量行的兜底估计高度（与虚拟列表的既有估算口径同量级）。 */
export const DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72

/**
 * 缓存上限：超长会话防内存膨胀。
 * 淘汰最久未写入的行（写入序 ≈ 行序，旧行先淘汰）。
 */
export const MAX_ROW_HEIGHT_CACHE_ENTRIES = 4000

type RowHeightCacheKey = string | number

export class TimelineRowHeightCache {
  private readonly sizes = new Map<RowHeightCacheKey, number>()

  constructor(private readonly maxEntries: number = MAX_ROW_HEIGHT_CACHE_ENTRIES) {}

  get size(): number {
    return this.sizes.size
  }

  /** 记录一次真实测量。重复写入会刷新淘汰顺序（活跃行不被淘汰）。 */
  set(key: RowHeightCacheKey, heightPx: number): void {
    if (!Number.isFinite(heightPx) || heightPx <= 0) {
      return
    }
    // Map 迭代序 = 插入序；先删再插把该行挪到「最新」端。
    this.sizes.delete(key)
    this.sizes.set(key, heightPx)
    while (this.sizes.size > this.maxEntries) {
      const oldest = this.sizes.keys().next()
      if (oldest.done) break
      this.sizes.delete(oldest.value)
    }
  }

  get(key: RowHeightCacheKey): number | undefined {
    return this.sizes.get(key)
  }

  /** estimateSize 入口：有测量用测量，无测量回落估计值。 */
  estimate(
    key: RowHeightCacheKey | undefined,
    fallbackPx: number = DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  ): number {
    if (key === undefined) return fallbackPx
    return this.sizes.get(key) ?? fallbackPx
  }

  /**
   * 会话切换时整体重置。
   * turnId 在不同 session 间也不能假设全局唯一（消息 id 会跨会话重复），
   * 串号会让新会话的行拿到旧会话的错高度。
   */
  clear(): void {
    this.sizes.clear()
  }
}
