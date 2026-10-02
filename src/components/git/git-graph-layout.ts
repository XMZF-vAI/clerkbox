/**
 * Git 图谱泳道布局（纯函数，tests/git-graph-layout.test.ts 钉住）。
 *
 * 算法对齐 ZCode 的 git-graph/layout 思路的简化版：
 * - 泳道表 lanes[i] 记录「该泳道正在等待的父提交 hash」；
 * - 提交落到等它的泳道，没人等就落到第一个空泳道（没有就新开）；
 * - 第一父提交继承当前泳道（直线），合并父提交新开泳道或汇入已有泳道（曲线）；
 * - 边在第二遍画：子→父两端都渲染在窗口内就连贝塞尔曲线，
 *   父在分页窗口外就向下画一小段 stub（泳道不再延伸到窗口底部）。
 */

export const GRAPH_ROW_HEIGHT = 42
export const GRAPH_LANE_GAP = 18
export const GRAPH_LANE_PADDING = 14
export const GRAPH_NODE_RADIUS = 4
/** 泳道配色轮换数（与 GitGraphDialog 里的 stroke/fill class 数组一一对应） */
export const GRAPH_LANE_COLORS = 4

export interface GraphCommitInput {
  hash: string
  parents: string[]
}

export interface GraphNode {
  hash: string
  lane: number
  row: number
  colorIndex: number
}

export interface GraphEdge {
  from: GraphNode
  /** 父提交已在窗口内时才有 to；否则画 stub */
  to: GraphNode | null
  colorIndex: number
}

export interface GraphLayout {
  nodes: GraphNode[]
  edges: GraphEdge[]
  laneCount: number
}

export function nodeX(lane: number): number {
  return GRAPH_LANE_PADDING + lane * GRAPH_LANE_GAP
}

export function nodeY(row: number): number {
  return GRAPH_ROW_HEIGHT / 2 + row * GRAPH_ROW_HEIGHT
}

/** 子→父的贝塞尔路径；to 为 null 时画向下的 stub */
export function edgePath(from: GraphNode, to: GraphNode | null): string {
  const x1 = nodeX(from.lane)
  const y1 = nodeY(from.row)
  const x2 = to ? nodeX(to.lane) : x1
  const y2 = to ? nodeY(to.row) : y1 + GRAPH_ROW_HEIGHT * 0.8
  const k = Math.min(GRAPH_ROW_HEIGHT, Math.max((y2 - y1) / 2, 8))
  return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`
}

export function layoutGitGraph(commits: GraphCommitInput[]): GraphLayout {
  const lanes: Array<string | null> = []
  const nodes: GraphNode[] = []

  const firstFreeLane = (): number => {
    const idx = lanes.indexOf(null)
    return idx === -1 ? lanes.length : idx
  }

  commits.forEach((commit, row) => {
    let lane = lanes.indexOf(commit.hash)
    if (lane === -1) lane = firstFreeLane()
    if (lane === lanes.length) lanes.push(null)
    // 当前节点落位，释放本泳道等待位
    lanes[lane] = null
    nodes.push({ hash: commit.hash, lane, row, colorIndex: lane % GRAPH_LANE_COLORS })

    commit.parents.forEach((parent, parentIdx) => {
      const reserved = lanes.indexOf(parent)
      if (reserved !== -1) return // 已有泳道等它：多条子提交边汇入同一泳道
      if (parentIdx === 0) {
        lanes[lane] = parent // 第一父沿当前泳道直线向下
        return
      }
      const target = firstFreeLane()
      lanes[target] = parent
    })
  })

  // 第二遍画边：此时每个提交的 (row, lane) 都已确定
  const positions = new Map(nodes.map((n) => [n.hash, n]))
  const edges: GraphEdge[] = []
  for (const commit of commits) {
    const child = positions.get(commit.hash)
    if (!child) continue
    for (const parent of commit.parents) {
      edges.push({ from: child, to: positions.get(parent) ?? null, colorIndex: child.colorIndex })
    }
  }

  return { nodes, edges, laneCount: lanes.length }
}
