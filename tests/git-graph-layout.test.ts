/**
 * Git 图谱泳道布局单测：直线/分叉/合并的泳道分配、边的端点、分页窗口外的 stub。
 */
import { describe, expect, it } from 'vitest'
import {
  GRAPH_LANE_GAP,
  edgePath,
  layoutGitGraph,
  nodeX,
  nodeY,
} from '../src/components/git/git-graph-layout'

describe('layoutGitGraph', () => {
  it('线性历史：单泳道直线', () => {
    // log 顺序自顶向下：c → b → a
    const { nodes, edges, laneCount } = layoutGitGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ])
    expect(laneCount).toBe(1)
    expect(nodes.map((n) => [n.hash, n.lane, n.row])).toEqual([
      ['c', 0, 0],
      ['b', 0, 1],
      ['a', 0, 2],
    ])
    expect(edges).toHaveLength(2)
    for (const edge of edges) {
      expect(edge.to).not.toBeNull()
      expect(edge.from.lane).toBe(edge.to!.lane)
    }
  })

  it('合并提交：第一父直线延续，第二父新开泳道汇入', () => {
    const { nodes, edges, laneCount } = layoutGitGraph([
      { hash: 'm', parents: ['p1', 'p2'] },
      { hash: 'p1', parents: [] },
      { hash: 'p2', parents: [] },
    ])
    expect(laneCount).toBe(2)
    expect(nodes.map((n) => [n.hash, n.lane])).toEqual([
      ['m', 0],
      ['p1', 0],
      ['p2', 1],
    ])
    expect(edges).toHaveLength(2)
    const straight = edges.find((e) => e.to?.hash === 'p1')!
    expect(straight.from.lane).toBe(0)
    expect(straight.to!.lane).toBe(0)
    const mergeEdge = edges.find((e) => e.to?.hash === 'p2')!
    expect(mergeEdge.from.lane).toBe(0)
    expect(mergeEdge.to!.lane).toBe(1)
  })

  it('分叉的兄弟分支各自占位且颜色按泳道轮换', () => {
    const { nodes } = layoutGitGraph([
      { hash: 'a', parents: ['b1', 'b2'] },
      { hash: 'b1', parents: [] },
      { hash: 'b2', parents: [] },
    ])
    const b2 = nodes.find((n) => n.hash === 'b2')!
    expect(b2.lane).toBe(1)
    expect(b2.colorIndex).toBe(1)
  })

  it('父提交在分页窗口外：画 stub（to 为 null）', () => {
    const { edges } = layoutGitGraph([{ hash: 'tip', parents: ['outside-of-window'] }])
    expect(edges).toHaveLength(1)
    expect(edges[0].to).toBeNull()
  })

  it('两条分支收敛到同一父：不重复占泳道', () => {
    const { laneCount, nodes } = layoutGitGraph([
      { hash: 'child1', parents: ['root'] },
      { hash: 'child2', parents: ['root'] },
      { hash: 'root', parents: [] },
    ])
    // child1 占 lane0 并为 root 预约 lane0；child2 落新 lane1；root 落在预约的 lane0
    expect(laneCount).toBe(2)
    expect(nodes.find((n) => n.hash === 'root')!.lane).toBe(0)
  })
})

describe('坐标与路径', () => {
  it('nodeX/nodeY 按常量计算', () => {
    expect(nodeX(0)).toBe(14)
    expect(nodeX(2)).toBe(14 + 2 * GRAPH_LANE_GAP)
    expect(nodeY(0)).toBe(21)
    expect(nodeY(3)).toBe(21 + 3 * 42)
  })

  it('边路径是 M/C 贝塞尔且两端点正确；stub 保持同泳道垂下', () => {
    const from = { hash: 'a', lane: 0, row: 0, colorIndex: 0 }
    const to = { hash: 'b', lane: 2, row: 2, colorIndex: 2 }
    const path = edgePath(from, to)
    expect(path).toContain(`M ${nodeX(0)} ${nodeY(0)}`)
    expect(path).toContain(`${nodeX(2)} ${nodeY(2)}`)
    const stub = edgePath(from, null)
    expect(stub).toContain(`M ${nodeX(0)} ${nodeY(0)}`)
    expect(stub).toContain(`${nodeX(0)} ${nodeY(0) + 42 * 0.8}`)
  })
})
