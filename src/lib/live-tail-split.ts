/**
 * 流式尾行拆分：把「正在流式的最后一个 turn」从虚拟列表里摘出来，放进普通文档流。
 *
 * 为什么需要它：流式行继续待在绝对定位的虚拟行里时，正文 DOM 会先长高，
 * 而 ResizeObserver 要到下一帧才回填 totalSize —— 这期间轮尾的
 * 「Agent 工作状态指示器」位置会跟着抖一下（ZCode 同款问题）。
 *
 * 只拆「真正的最后一个流式 turn」：历史或陈旧的 running 行仍归虚拟列表，
 * 避免扩大常驻 DOM。
 *
 * 纯函数，不依赖 DOM / React。
 */

export interface LiveTailSplit<T> {
  /** 仍归虚拟列表的 turn（不含被拆出的尾行）。 */
  virtualizedTurns: readonly T[]
  /** 被拆到普通文档流的尾行；null 表示当前没有可拆的尾行。 */
  liveTurn: T | null
  /** 尾行在**原始全量** turn 序列里的下标；null 表示没有尾行。 */
  liveTurnIndex: number | null
}

/**
 * 拆出流式尾行。
 *
 * @param turns   全量 turn（顺序即渲染顺序）
 * @param isStreaming 当前是否处于流式中
 */
export function splitLiveTail<T extends { turnId: string }>(
  turns: readonly T[],
  isStreaming: boolean,
): LiveTailSplit<T> {
  const liveTurnIndex = turns.length - 1
  if (!isStreaming || liveTurnIndex < 0) {
    return { virtualizedTurns: turns, liveTurn: null, liveTurnIndex: null }
  }
  const liveTurn = turns[liveTurnIndex]
  if (!liveTurn) {
    return { virtualizedTurns: turns, liveTurn: null, liveTurnIndex: null }
  }
  return {
    virtualizedTurns: turns.slice(0, liveTurnIndex),
    liveTurn,
    liveTurnIndex,
  }
}
