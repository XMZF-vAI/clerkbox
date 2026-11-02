/**
 * 工作流静态因果图分析器（UI 用，纯函数，**不执行脚本**）。
 *
 * ZCode 的工作流图来自 TypeScript AST 编译出的因果图；CB v1 的脚本是 JS 字符串，
 * 没有编译期。这里做的是**源码级静态扫描**：只认 `phase('…')` / `agent('…', …)` /
 * `parallel([...])` 这三种字面形态，不解释控制流。
 *
 * 诚实的边界（写进注释也写进 UI 文案，不装懂）：
 * - 条件分支里的 agent 只在**字面路径**上可见 —— 走 if/else 时静态图会把两条分支的
 *   步骤都画出来；运行时以实况快照覆盖（`buildWorkflowGraphView` 的 progress 入参）。
 * - 模板字符串 `${…}` 里的调用看不到（整段模板被当作一个字符串字面量跳过）。
 * - 变量间接调用 `const a = agent; a(...)` 看不到。
 *
 * 静态图只服务「确认前给人看一张图」与「运行中点亮这张图」两件事，不参与执行，
 * 也不构成任何权限判定。
 */
import type { WorkflowProgressSnapshot, WorkflowRunTail, WorkflowStepStatus } from './workflow-runtime'

export type WorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

export interface WorkflowGraphNode {
  /** 脚本里 agent() 的第一个字面量参数；空串 = 无名字面量（UI 回退为 #序号） */
  name: string
  /** 并行组标识：同一个 parallel([...]) 数组里的步骤同组；null = 顺序执行 */
  parallelGroup: number | null
}

export interface WorkflowGraphPhase {
  /** phase('…') 的名字；隐式阶段为空串（脚本里第一个 phase 标记之前的步骤） */
  name: string
  implicit: boolean
  nodes: WorkflowGraphNode[]
}

export interface WorkflowGraph {
  phases: WorkflowGraphPhase[]
  totalSteps: number
  /** 脚本字面可见的最大并行度（parallel 组内步骤数的最大值，至少 1） */
  maxParallel: number
  source: 'static'
}

export const EMPTY_WORKFLOW_GRAPH: WorkflowGraph = { phases: [], totalSteps: 0, maxParallel: 1, source: 'static' }

// ── 源码遮蔽 ──────────────────────────────────────────────────────

interface StringLiteral {
  start: number
  /** 闭引号的下标（未闭合时为源码长度） */
  end: number
  value: string
}

/**
 * 把注释与字符串**内容**替换成空格（保持长度与下标不变），同时收集字符串字面量。
 *
 * 为什么要遮蔽而不是正则直扫：`// phase('假的')` 与 `agent("phase('x')")` 都不该被当成
 * 真调用。遮蔽后所有括号/引号都在同一层"代码"上配平，括号匹配不会被字符串里的
 * 括号带偏。
 */
function maskSource(source: string): { code: string; literals: StringLiteral[] } {
  const out = source.split('')
  const literals: StringLiteral[] = []
  const len = source.length
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < len; k++) out[k] = ' '
  }

  while (i < len) {
    const ch = source[i]!
    const next = source[i + 1]

    if (ch === '/' && next === '/') {
      const start = i
      while (i < len && source[i] !== '\n') i++
      blank(start, i)
      continue
    }
    if (ch === '/' && next === '*') {
      const start = i
      i += 2
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i++
      i = Math.min(len, i + 2)
      blank(start, i)
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      const start = i
      let value = ''
      i++
      while (i < len) {
        const c = source[i]!
        if (c === '\\') {
          // 转义序列原样收进值里（`\'` 不该提前闭合字符串）
          value += source.slice(i, i + 2)
          i += 2
          continue
        }
        if (c === quote) break
        value += c
        i++
      }
      const end = i
      blank(start, Math.min(len, end + 1))
      literals.push({ start, end, value })
      i++
      continue
    }
    i++
  }

  return { code: out.join(''), literals }
}

/** 从 `[` 的下标找到配平的 `]`；未配平返回 -1 */
function matchBracket(code: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < code.length; i++) {
    const ch = code[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 数一次调用的**顶层实参个数**（遮蔽后字符串已是空格，括号仍配平）。
 * `agent(prompt)` 只有一个实参——那不是「名字 + prompt」，而是把 prompt 当成了第一个参数；
 * 这种脚本在 CB 里跑不起来（facade 要两个参数），静态图也不该把 prompt 当步骤名画出来。
 */
function countArguments(code: string, openIndex: number): number {
  let depth = 0
  let commas = 0
  let sawContent = false
  for (let i = openIndex + 1; i < code.length; i++) {
    const ch = code[i]
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      sawContent = true
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return sawContent ? commas + 1 : 0
      depth--
      sawContent = true
    } else if (ch === ',' && depth === 0) {
      commas++
      sawContent = true
    } else if (ch !== ' ' && ch !== '\n' && ch !== '\t' && ch !== '\r') {
      sawContent = true
    }
  }
  return sawContent ? commas + 1 : 0
}

/**
 * 取调用的**第一个实参**字面量：`(` 与字面量之间只允许空白。
 * 这条约束很关键——`agent(promptVar, '这是 prompt')` 的首个字面量是 prompt，
 * 不该被误认成步骤名。
 */
function firstArgumentLiteral(code: string, literals: StringLiteral[], openIndex: number): string | null {
  for (const literal of literals) {
    if (literal.start < openIndex) continue
    if (code.slice(openIndex, literal.start).trim() !== '') return null
    return literal.value
  }
  return null
}

/** 落在哪个并行组里（取最内层那个；不在任何组里返回 null） */
function innermostGroup(ranges: Array<{ start: number; end: number }>, at: number): number | null {
  let best: { start: number; end: number } | null = null
  for (const range of ranges) {
    if (at <= range.start || at >= range.end) continue
    if (!best || range.end - range.start < best.end - best.start) best = range
  }
  return best ? best.start : null
}

// ── 静态分析 ──────────────────────────────────────────────────────

/**
 * 扫描脚本得到静态图。任何形态异常（未闭合字符串/括号）都不抛错：
 * 已经扫到的部分照常返回，UI 宁可少画几个站，也不能因为一张示意图让确认流程崩掉。
 */
export function analyzeWorkflowScript(source: string): WorkflowGraph {
  if (!source || !source.trim()) return EMPTY_WORKFLOW_GRAPH

  const { code, literals } = maskSource(source)

  const phaseMarks: Array<{ at: number; name: string }> = []
  for (const match of code.matchAll(/\bphase\s*\(/g)) {
    const at = match.index ?? 0
    const open = at + match[0].length
    phaseMarks.push({ at, name: firstArgumentLiteral(code, literals, open) ?? '' })
  }

  const parallelRanges: Array<{ start: number; end: number }> = []
  for (const match of code.matchAll(/\bparallel\s*\(\s*\[/g)) {
    const at = match.index ?? 0
    const bracket = code.indexOf('[', at)
    if (bracket === -1) continue
    const end = matchBracket(code, bracket)
    if (end > bracket) parallelRanges.push({ start: bracket, end })
  }

  const steps: Array<{ at: number; name: string; group: number | null }> = []
  for (const match of code.matchAll(/\bagent\s*\(/g)) {
    const at = match.index ?? 0
    const open = at + match[0].length
    // 单实参 = 把 prompt 写成了第一个参数：名字未知，回退 #序号，绝不把 prompt 当名字
    const named = countArguments(code, open) >= 2
    steps.push({
      at,
      name: named ? (firstArgumentLiteral(code, literals, open) ?? '') : '',
      group: innermostGroup(parallelRanges, at),
    })
  }

  // 按声明序切阶段：步骤归入它之前最近的那个 phase 标记
  const phases: WorkflowGraphPhase[] = []
  let current: WorkflowGraphPhase | null = null
  let markIndex = 0
  for (const step of steps) {
    while (markIndex < phaseMarks.length && phaseMarks[markIndex]!.at < step.at) {
      current = { name: phaseMarks[markIndex]!.name, implicit: false, nodes: [] }
      phases.push(current)
      markIndex++
    }
    if (!current) {
      current = { name: '', implicit: true, nodes: [] }
      phases.push(current)
    }
    current.nodes.push({ name: step.name, parallelGroup: step.group })
  }
  // 尾部只有标记、没有步骤的阶段也要成站（脚本可能在阶段里做纯逻辑）
  while (markIndex < phaseMarks.length) {
    phases.push({ name: phaseMarks[markIndex]!.name, implicit: false, nodes: [] })
    markIndex++
  }

  const groupSizes = new Map<number, number>()
  for (const step of steps) {
    if (step.group === null) continue
    groupSizes.set(step.group, (groupSizes.get(step.group) ?? 0) + 1)
  }
  const maxParallel = Math.max(1, ...groupSizes.values())

  return { phases, totalSteps: steps.length, maxParallel, source: 'static' }
}

// ── 视图模型（静态图 + 实况/终态覆盖） ────────────────────────────

export interface WorkflowGraphViewNode {
  name: string
  status: WorkflowNodeStatus
  /** 头像色档位 0..3：按名字散列，**仅用于区分**，没有任何语义 */
  tone: number
}

export interface WorkflowGraphViewPhase {
  name: string
  implicit: boolean
  status: WorkflowNodeStatus
  done: number
  total: number
  nodes: WorkflowGraphViewNode[]
  /** 出这一站的并行轨道数（0 = 单轨）：只画脚本里真的存在的并行度 */
  lanes: number
}

export interface WorkflowGraphView {
  phases: WorkflowGraphViewPhase[]
  totalSteps: number
  maxParallel: number
  doneSteps: number
  runningSteps: number
  /** true = 还没有任何实况（确认窗里的空心图） */
  staticOnly: boolean
}

/** 药丸头像色档位：散列取模，无语义 */
export function workflowPillTone(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return Math.abs(hash) % 4
}

interface ProgressStep {
  key: string
  name: string
  phase?: string
  status: WorkflowStepStatus
}

function rollupStatus(nodes: WorkflowGraphViewNode[]): WorkflowNodeStatus {
  if (nodes.length === 0) return 'pending'
  if (nodes.some((node) => node.status === 'failed')) return 'failed'
  if (nodes.some((node) => node.status === 'aborted')) return 'aborted'
  if (nodes.every((node) => node.status === 'completed')) return 'completed'
  if (nodes.some((node) => node.status === 'running' || node.status === 'completed')) return 'running'
  return 'pending'
}

function lanesOf(nodes: WorkflowGraphNode[]): number {
  const sizes = new Map<number, number>()
  for (const node of nodes) {
    if (node.parallelGroup === null) continue
    sizes.set(node.parallelGroup, (sizes.get(node.parallelGroup) ?? 0) + 1)
  }
  const largest = Math.max(0, ...sizes.values())
  return Math.min(3, Math.max(0, largest - 1))
}

/**
 * 静态图 + 实况快照 → 可直接渲染的视图。
 *
 * 匹配规则（顺序即优先级）：
 *  1. 同一阶段内按名字配对（工作流里步骤名通常唯一）；
 *  2. 配不上的按"该阶段里第一个还没被认领的步骤"兜底；
 *  3. 实况里有、静态图里没有的阶段/步骤**照实追加**（条件分支走到的路径）。
 */
export function buildWorkflowGraphView(graph: WorkflowGraph, progress?: WorkflowProgressSnapshot): WorkflowGraphView {
  const steps: ProgressStep[] = progress?.steps ?? []
  const buckets = new Map<string, ProgressStep[]>()
  for (const step of steps) {
    const key = step.phase ?? ''
    const list = buckets.get(key)
    if (list) list.push(step)
    else buckets.set(key, [step])
  }
  const claimed = new Set<ProgressStep>()

  const claim = (phaseName: string, nodeName: string): ProgressStep | undefined => {
    const list = buckets.get(phaseName)
    if (!list) return undefined
    const byName = list.find((step) => !claimed.has(step) && step.name === nodeName)
    const picked = byName ?? list.find((step) => !claimed.has(step))
    if (picked) claimed.add(picked)
    return picked
  }

  const toNode = (name: string, status: WorkflowNodeStatus, index: number): WorkflowGraphViewNode => ({
    name: name || `#${index + 1}`,
    status,
    tone: workflowPillTone(name || `#${index + 1}`),
  })

  const phases: WorkflowGraphViewPhase[] = graph.phases.map((phase) => {
    const nodes = phase.nodes.map((node, index) => {
      const step = progress ? claim(phase.name, node.name) : undefined
      return toNode(node.name, step?.status ?? 'pending', index)
    })
    // 运行期才出现、静态图里没有的步骤（条件分支）：照实挂在同一阶段下
    if (progress) {
      for (const step of buckets.get(phase.name) ?? []) {
        if (claimed.has(step)) continue
        claimed.add(step)
        nodes.push(toNode(step.name, step.status, nodes.length))
      }
    }
    return {
      name: phase.name,
      implicit: phase.implicit,
      status: rollupStatus(nodes),
      done: nodes.filter((node) => node.status === 'completed').length,
      total: nodes.length,
      nodes,
      lanes: lanesOf(phase.nodes),
    }
  })

  // 静态图里没有的阶段（条件分支里调用的 phase()）：按实况顺序补在末尾
  if (progress) {
    for (const [name, list] of buckets) {
      if (graph.phases.some((phase) => phase.name === name)) continue
      const leftover = list.filter((step) => !claimed.has(step))
      if (leftover.length === 0) continue
      const nodes = leftover.map((step, index) => {
        claimed.add(step)
        return toNode(step.name, step.status, index)
      })
      phases.push({
        name,
        implicit: name === '',
        status: rollupStatus(nodes),
        done: nodes.filter((node) => node.status === 'completed').length,
        total: nodes.length,
        nodes,
        lanes: 0,
      })
    }
  }

  const allNodes = phases.flatMap((phase) => phase.nodes)
  return {
    phases,
    totalSteps: allNodes.length,
    maxParallel: graph.maxParallel,
    doneSteps: allNodes.filter((node) => node.status === 'completed').length,
    runningSteps: allNodes.filter((node) => node.status === 'running').length,
    staticOnly: !progress,
  }
}

/**
 * 终态尾巴 → 视图。
 *
 * 尾巴带 `phase` 归属时（新格式）与实况走同一条合并路径；旧尾巴没有这个字段，
 * 按**声明序**把步骤分摊到静态图的各个站上——否则它们会全部落进隐式阶段，
 * 前面每个站都显示 0/N，看起来像跑失败了。
 */
export function buildWorkflowGraphViewFromTail(graph: WorkflowGraph, tail: WorkflowRunTail): WorkflowGraphView {
  const withPhase = tail.steps.some((step) => typeof step.phase === 'string' && step.phase !== '')
  const order = graph.phases.flatMap((phase) => phase.nodes.map(() => phase.name))
  const steps = tail.steps.map((step, index) => ({
    key: step.key,
    name: step.name,
    phase: withPhase ? (step.phase ?? '') : (order[index] ?? order[order.length - 1] ?? ''),
    status: step.status,
    startedAt: 0,
  }))
  return buildWorkflowGraphView(graph, {
    runId: tail.runId,
    name: tail.name,
    status: tail.status,
    phases: tail.phases,
    steps,
    startedAt: 0,
    updatedAt: 0,
  })
}
