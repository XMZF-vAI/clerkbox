import { describe, it, expect, beforeEach } from 'vitest'
import {
  NEAR_BOTTOM_PX,
  VIRTUALIZE_MIN_TURNS,
  distanceToBottomPx,
  estimateStartPx,
  estimateTotalSizePx,
  estimateTurnSizePx,
  findTopVisibleRow,
  isNearBottomDistance,
  selectTurnRows,
  shouldVirtualizeTurns,
  streamingTailIndex,
  turnSizeEstimates,
  withPinnedIndex,
  type RowSpan,
} from '../src/lib/message-list-virtual'
import {
  MAX_TRACKED_SESSIONS,
  clearSessionScrollMemory,
  peekSessionScroll,
  rememberSessionScroll,
  resolveScrollRestore,
  type SessionScrollMemory,
} from '../src/lib/session-scroll-memory'
import { groupIntoTurns } from '../src/components/chat/MessageList'

const memory = (over: Partial<SessionScrollMemory> = {}): SessionScrollMemory => ({
  turnId: null,
  offsetWithinTurn: 0,
  offset: 0,
  atBottom: false,
  ...over,
})

describe('estimateTurnSizePx / 估算累计口径', () => {
  it('给出保守（>0 且封顶）的行高', () => {
    expect(estimateTurnSizePx(1)).toBeGreaterThan(0)
    expect(estimateTurnSizePx(100000)).toBeLessThanOrEqual(1200)
  })

  it('消息越多估算越高，且对非法入参兜底为单条消息', () => {
    expect(estimateTurnSizePx(3)).toBeGreaterThan(estimateTurnSizePx(2))
    expect(estimateTurnSizePx(0)).toBe(estimateTurnSizePx(1))
    expect(estimateTurnSizePx(Number.NaN)).toBe(estimateTurnSizePx(1))
    expect(estimateTurnSizePx(-5)).toBe(estimateTurnSizePx(1))
  })

  it('每行按「用户消息 + AI 消息数」估算', () => {
    const sizes = turnSizeEstimates([
      { aiMessages: [] },
      { aiMessages: [{}, {}, {}] as never[] },
    ])
    expect(sizes).toEqual([estimateTurnSizePx(1), estimateTurnSizePx(4)])
  })

  it('start 累加与总高自洽（滚动恢复与列表排布同一口径）', () => {
    const sizes = [100, 200, 300]
    expect(estimateStartPx(sizes, 0)).toBe(0)
    expect(estimateStartPx(sizes, 1)).toBe(100)
    expect(estimateStartPx(sizes, 2)).toBe(300)
    expect(estimateStartPx(sizes, 3)).toBe(600)
    expect(estimateTotalSizePx(sizes)).toBe(estimateStartPx(sizes, sizes.length))
  })

  it('越界下标夹在合法区间，不产生负偏移', () => {
    const sizes = [100, 200]
    expect(estimateStartPx(sizes, -3)).toBe(0)
    expect(estimateStartPx(sizes, 99)).toBe(300)
    expect(estimateStartPx([], 5)).toBe(0)
  })
})

describe('shouldVirtualizeTurns 降级阈值', () => {
  it('turn 数不足 30 一律走全量渲染', () => {
    expect(VIRTUALIZE_MIN_TURNS).toBe(30)
    expect(shouldVirtualizeTurns(VIRTUALIZE_MIN_TURNS - 1, false, true)).toBe(false)
    expect(shouldVirtualizeTurns(1, false, true)).toBe(false)
    expect(shouldVirtualizeTurns(0, false, true)).toBe(false)
  })

  it('达到阈值后要求粘底，避免上翻阅读时切换布局跳位', () => {
    expect(shouldVirtualizeTurns(VIRTUALIZE_MIN_TURNS, false, true)).toBe(true)
    expect(shouldVirtualizeTurns(VIRTUALIZE_MIN_TURNS, false, false)).toBe(false)
    expect(shouldVirtualizeTurns(1000, false, false)).toBe(false)
  })

  it('一旦锁定就不再回落（压缩后 turn 变少也继续虚拟化）', () => {
    expect(shouldVirtualizeTurns(3, true, false)).toBe(true)
    expect(shouldVirtualizeTurns(0, true, true)).toBe(true)
  })
})

describe('streamingTailIndex 流式尾部隔离', () => {
  it('仅流式期间钉住末行，流式结束即解除钉住', () => {
    expect(streamingTailIndex(5, true)).toBe(4)
    expect(streamingTailIndex(5, false)).toBe(null)
    expect(streamingTailIndex(0, true)).toBe(null)
  })

  it('新回合追加后钉住点跟着移到新末行，上一回合可被回收', () => {
    expect(streamingTailIndex(6, true)).toBe(5)
    expect(streamingTailIndex(6, true)).not.toBe(streamingTailIndex(5, true))
  })
})

describe('withPinnedIndex 可见行并入钉住行', () => {
  const topRange = [0, 1, 2]

  it('视口在顶部时仍把流式末行并入，且不打乱原有行', () => {
    expect(withPinnedIndex(topRange, 10, 9)).toEqual([0, 1, 2, 9])
  })

  it('末行本就在范围内时不重复', () => {
    expect(withPinnedIndex([0, 1, 9], 10, 9)).toEqual([0, 1, 9])
  })

  it('无钉住行 / 越界下标 / 非法下标都安全', () => {
    expect(withPinnedIndex(topRange, 10, null)).toEqual(topRange)
    expect(withPinnedIndex(topRange, 2, 9)).toEqual([0, 1])
    expect(withPinnedIndex([0, 1, 2], 10, -1)).toEqual([0, 1, 2])
    expect(withPinnedIndex([0, 1, 2], 10, Number.NaN)).toEqual([0, 1, 2])
  })
})

describe('selectTurnRows 虚拟化只改容器层', () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ turnId: `t${i}` }))

  it('渲染行是全量 turns 的有序无重复子集，内容引用不被改写', () => {
    const items = [{ index: 2, start: 300 }, { index: 0, start: 0 }, { index: 4, start: 900 }]
    const rows = selectTurnRows(turns, items)
    expect(rows.map((r) => r.row.index)).toEqual([0, 2, 4])
    expect(rows.map((r) => r.row.turnId)).toEqual(['t0', 't2', 't4'])
    expect(rows[0].turn).toBe(turns[0])
    expect(rows[2].turn).toBe(turns[4])
  })

  it('全量下标进、全量行出：数量与顺序与不虚拟化时一致', () => {
    const all = turns.map((_, index) => ({ index, start: index * 100 }))
    expect(selectTurnRows(turns, all).map((r) => r.turn)).toEqual(turns)
    expect(selectTurnRows(turns, all)).toHaveLength(turns.length)
  })

  it('越界 / 重复 / 非法下标被丢弃，空集合不报错', () => {
    const items = [{ index: 1, start: 0 }, { index: 1, start: 0 }, { index: 9, start: 0 }, { index: -2, start: 0 }]
    expect(selectTurnRows(turns, items).map((r) => r.row.index)).toEqual([1])
    expect(selectTurnRows([], [])).toEqual([])
    expect(selectTurnRows(turns, [])).toEqual([])
  })
})

describe('粘底判定', () => {
  it('距底算法与虚拟化前一致，阈值仍为 100 且严格小于', () => {
    expect(distanceToBottomPx(900, 1000, 100)).toBe(0)
    expect(NEAR_BOTTOM_PX).toBe(100)
    expect(isNearBottomDistance(NEAR_BOTTOM_PX - 1)).toBe(true)
    expect(isNearBottomDistance(NEAR_BOTTOM_PX)).toBe(false)
  })
})

describe('findTopVisibleRow 滚动锚点', () => {
  const row = (index: number, top: number, bottom: number): RowSpan => ({ index, top, bottom })

  it('取跨越视口顶边的行，并给出行内偏移', () => {
    const spans = [row(0, -500, -200), row(1, -200, 40), row(2, 40, 400)]
    expect(findTopVisibleRow(spans, 0)).toEqual({ index: 1, offsetWithinRow: 200 })
  })

  it('视口顶落在行间距里时记上一行', () => {
    const spans = [row(0, -400, -100), row(1, -76, 200)]
    expect(findTopVisibleRow(spans, -90)).toEqual({ index: 0, offsetWithinRow: 310 })
  })

  it('被钉住的流式尾行在视口下方时不参与锚点判定', () => {
    const spans = [row(7, -800, -300), row(8, -300, 100), row(9, 5000, 5600)]
    expect(findTopVisibleRow(spans, 0)?.index).toBe(8)
  })

  it('全部行都在视口下方 / 无行时返回 null', () => {
    expect(findTopVisibleRow([row(3, 100, 400)], 0)).toBe(null)
    expect(findTopVisibleRow([], 0)).toBe(null)
  })

  it('行完全滚出视口上方时回退到该行（保持单调可读）', () => {
    expect(findTopVisibleRow([row(0, -900, -800), row(1, -700, -600)], 0)).toEqual({
      index: 1,
      offsetWithinRow: 700,
    })
  })
})

describe('session scroll memory', () => {
  beforeEach(() => {
    clearSessionScrollMemory()
  })

  it('按 sessionId 存取，互不串台', () => {
    rememberSessionScroll('a', memory({ turnId: 'ta', offset: 120 }))
    rememberSessionScroll('b', memory({ turnId: 'tb', offset: 999 }))
    expect(peekSessionScroll('a')?.turnId).toBe('ta')
    expect(peekSessionScroll('b')?.offset).toBe(999)
    expect(peekSessionScroll('c')).toBeUndefined()
  })

  it('空 sessionId 不写入也不读取，避免脏数据', () => {
    rememberSessionScroll('', memory({ offset: 5 }))
    expect(peekSessionScroll('')).toBeUndefined()
    expect(peekSessionScroll('')).toBeUndefined()
  })

  it('重复写入覆盖旧值', () => {
    rememberSessionScroll('a', memory({ offset: 1 }))
    rememberSessionScroll('a', memory({ offset: 2 }))
    expect(peekSessionScroll('a')?.offset).toBe(2)
  })

  it('超过上限按最近写入顺序淘汰，不无界增长', () => {
    for (let i = 0; i < MAX_TRACKED_SESSIONS + 5; i++) {
      rememberSessionScroll(`s${i}`, memory({ offset: i }))
    }
    expect(peekSessionScroll('s0')).toBeUndefined()
    expect(peekSessionScroll(`s${MAX_TRACKED_SESSIONS + 4}`)?.offset).toBe(MAX_TRACKED_SESSIONS + 4)
  })

  it('重新写入会刷新新鲜度，存活下来不被 FIFO 挤掉', () => {
    for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) rememberSessionScroll(`x${i}`, memory({ offset: i }))
    rememberSessionScroll('x0', memory({ offset: 99 }))
    for (let i = 0; i < MAX_TRACKED_SESSIONS - 1; i++) rememberSessionScroll(`z${i}`, memory({ offset: i }))
    expect(peekSessionScroll('x0')?.offset).toBe(99)
    expect(peekSessionScroll('x1')).toBeUndefined()
  })
})

describe('resolveScrollRestore 恢复决策', () => {
  const turns = [{ turnId: 't0' }, { turnId: 't1' }, { turnId: 't2' }]

  it('无记忆时贴底，保持「进会话看最新」的现状', () => {
    expect(resolveScrollRestore(turns, undefined)).toEqual({ kind: 'bottom' })
  })

  it('上次贴底仍按贴底恢复', () => {
    expect(resolveScrollRestore(turns, memory({ atBottom: true, offset: 777 }))).toEqual({ kind: 'bottom' })
  })

  it('记住的 turn 仍在：按下标 + 行内偏移恢复', () => {
    const decision = resolveScrollRestore(turns, memory({ turnId: 't1', offsetWithinTurn: 320, offset: 4000 }))
    expect(decision).toEqual({ kind: 'turn', index: 1, offsetWithinTurn: 320 })
  })

  it('turn 已消失（压缩重建等）：退回原始偏移', () => {
    expect(resolveScrollRestore(turns, memory({ turnId: 'gone', offset: 4000 }))).toEqual({
      kind: 'offset',
      offset: 4000,
    })
    expect(resolveScrollRestore(turns, memory({ turnId: null, offset: 4000 }))).toEqual({
      kind: 'offset',
      offset: 4000,
    })
  })

  it('会话清空时贴底；负偏移夹为 0', () => {
    expect(resolveScrollRestore([], memory({ turnId: 't0', offset: 10 }))).toEqual({ kind: 'bottom' })
    expect(resolveScrollRestore(turns, memory({ turnId: null, offset: -50 }))).toEqual({ kind: 'offset', offset: 0 })
    expect(resolveScrollRestore(turns, memory({ turnId: 't2', offsetWithinTurn: -9 })).kind).toBe('turn')
    expect((resolveScrollRestore(turns, memory({ turnId: 't2', offsetWithinTurn: -9 })) as { offsetWithinTurn: number }).offsetWithinTurn).toBe(0)
  })

  it('贴底优先于残留的 turn 锚点', () => {
    const decision = resolveScrollRestore(turns, memory({ atBottom: true, turnId: 't0', offsetWithinTurn: 50 }))
    expect(decision.kind).toBe('bottom')
  })
})

describe('turn 分组在虚拟化下数量/顺序不变', () => {
  const user = (id: string) => ({ id, role: 'user' as const })
  const assistant = (id: string) => ({ id, role: 'assistant' as const })

  it('每个 turn 对应一行，顺序与 turnId 与分组结果一致', () => {
    const messages = [user('u1'), assistant('a1'), user('u2'), assistant('a2'), assistant('a3')] as never[]
    const turns = groupIntoTurns(messages)
    expect(turns.map((t) => t.turnId)).toEqual(['u1', 'u2'])
    const rows = selectTurnRows(turns, turns.map((_, index) => ({ index, start: index * 100 })))
    expect(rows).toHaveLength(turns.length)
    expect(rows.map((r) => r.turn.turnId)).toEqual(turns.map((t) => t.turnId))
  })

  it('钉住流式末行不会额外插入或丢失 turn', () => {
    const messages = [user('u1'), assistant('a1'), user('u2')] as never[]
    const turns = groupIntoTurns(messages)
    const pinned = withPinnedIndex([0], turns.length, streamingTailIndex(turns.length, true))
    expect(selectTurnRows(turns, pinned.map((index) => ({ index, start: index * 100 })))).toHaveLength(turns.length)
  })
})
