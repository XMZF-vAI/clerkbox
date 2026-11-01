/**
 * 行高缓存与流式尾行拆分的测试。
 *
 * 行高缓存守的是「virtualizer 重建后仍能用上次的真实测量」：
 * 流式行高持续增长时 virtualizer 会重置并把测量清回估算值，
 * 滚动条因此跳动、底部锚定跟着抖。
 *
 * live tail 拆分守的是「正在流式的最后一个 turn 不再留在绝对定位的虚拟行里」：
 * 它留在虚拟行里时正文 DOM 先长高、ResizeObserver 下一帧才回填 totalSize，
 * 轮尾的工作状态指示器会跟着抖一下。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  MAX_ROW_HEIGHT_CACHE_ENTRIES,
  TimelineRowHeightCache,
} from '../src/lib/timeline-row-height-cache'
import { splitLiveTail } from '../src/lib/live-tail-split'

describe('TimelineRowHeightCache', () => {
  it('记录后能取回真实测量', () => {
    const cache = new TimelineRowHeightCache()
    cache.set('turn-1', 420)
    expect(cache.get('turn-1')).toBe(420)
    expect(cache.size).toBe(1)
  })

  it('未测量的行回落估计值', () => {
    const cache = new TimelineRowHeightCache()
    expect(cache.estimate('turn-unknown')).toBe(DEFAULT_ROW_HEIGHT_ESTIMATE_PX)
    expect(cache.estimate('turn-unknown', 200)).toBe(200)
    expect(cache.estimate(undefined, 200)).toBe(200)
  })

  it('有测量时优先用测量（这是缓存存在的意义）', () => {
    const cache = new TimelineRowHeightCache()
    cache.set('turn-1', 900)
    expect(cache.estimate('turn-1', 100)).toBe(900)
  })

  it('非法高度不入缓存', () => {
    const cache = new TimelineRowHeightCache()
    cache.set('turn-1', 0)
    cache.set('turn-2', -10)
    cache.set('turn-3', Number.NaN)
    cache.set('turn-4', Number.POSITIVE_INFINITY)
    expect(cache.size).toBe(0)
  })

  it('重复写入刷新淘汰顺序（活跃行不被淘汰）', () => {
    const cache = new TimelineRowHeightCache(3)
    cache.set('a', 10)
    cache.set('b', 20)
    cache.set('c', 30)
    cache.set('a', 11)
    // 再写一条即触发淘汰：最久未写入的 b 先走（a 已被刷新到最新端）
    cache.set('d', 40)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(11)
    expect(cache.get('c')).toBe(30)
    expect(cache.get('d')).toBe(40)
  })

  it('超出上限按最久未写入淘汰，不无界增长', () => {
    const cache = new TimelineRowHeightCache(5)
    for (let i = 0; i < 50; i++) cache.set(`turn-${i}`, i + 1)
    expect(cache.size).toBe(5)
    expect(cache.get('turn-49')).toBe(50)
    expect(cache.get('turn-0')).toBeUndefined()
  })

  it('clear 清空（会话切换时必须调用，避免行高跨会话串号）', () => {
    const cache = new TimelineRowHeightCache()
    cache.set('turn-1', 100)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('turn-1')).toBeUndefined()
  })

  it('默认上限为 4000 条', () => {
    expect(MAX_ROW_HEIGHT_CACHE_ENTRIES).toBe(4000)
  })
})

describe('splitLiveTail 流式尾行拆分', () => {
  const turns = [
    { turnId: 't1' },
    { turnId: 't2' },
    { turnId: 't3' },
  ]

  it('流式期间：最后一个 turn 拆出虚拟列表', () => {
    const split = splitLiveTail(turns, true)
    expect(split.liveTurn?.turnId).toBe('t3')
    expect(split.liveTurnIndex).toBe(2)
    expect(split.virtualizedTurns.map((t) => t.turnId)).toEqual(['t1', 't2'])
  })

  it('非流式期间：不拆分，全部留在虚拟列表', () => {
    const split = splitLiveTail(turns, false)
    expect(split.liveTurn).toBeNull()
    expect(split.liveTurnIndex).toBeNull()
    expect(split.virtualizedTurns).toHaveLength(3)
  })

  it('空列表不拆（liveTurnIndex 不得为 -1）', () => {
    const split = splitLiveTail([], true)
    expect(split.liveTurn).toBeNull()
    expect(split.liveTurnIndex).toBeNull()
    expect(split.virtualizedTurns).toHaveLength(0)
  })

  it('单行时拆出后虚拟列表为空', () => {
    const split = splitLiveTail([{ turnId: 'only' }], true)
    expect(split.liveTurn?.turnId).toBe('only')
    expect(split.virtualizedTurns).toHaveLength(0)
  })

  it('拆分不改动原数组（虚拟列表与尾行各自持有引用）', () => {
    const source = [...turns]
    const split = splitLiveTail(source, true)
    expect(source).toHaveLength(3)
    expect(split.virtualizedTurns).not.toBe(source)
    expect(split.liveTurn).toBe(source[2])
  })
})
