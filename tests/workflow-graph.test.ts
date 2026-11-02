/**
 * 工作流静态图分析器测试。
 *
 * 守四件事：
 *  1. 阶段按 phase() 声明序切分，标记之前的步骤归隐式阶段；
 *  2. parallel([...]) 数组内的 agent 同组、组外不同组，maxParallel 只反映脚本字面并行度；
 *  3. 注释与字符串里的假调用不算数（遮蔽层不能把 `// phase('x')` 当真）；
 *  4. 视图合并：静态态空心、实况覆盖状态、条件分支多出来的阶段/步骤照实追加。
 */
import { describe, it, expect } from 'vitest'
import {
  analyzeWorkflowScript,
  buildWorkflowGraphView,
  buildWorkflowGraphViewFromTail,
  workflowPillTone,
} from '../src/lib/workflow-graph'
import type { WorkflowProgressSnapshot } from '../src/lib/workflow-runtime'

const SCRIPT = `
const intro = await agent('导读', '读 README')
phase('收集')
const a = await agent('读者A', '读文件 X')
const b = await agent('读者B', '读文件 Y')
phase('汇总')
return 'done'
`

function snapshot(steps: Array<{ name: string; phase?: string; status: WorkflowProgressSnapshot['steps'][number]['status'] }>): WorkflowProgressSnapshot {
  return {
    runId: 'wf-test',
    name: '测试工作流',
    status: 'running',
    phases: [],
    steps: steps.map((step, index) => ({
      key: `step-${index + 1}`,
      name: step.name,
      phase: step.phase ?? '',
      status: step.status,
      startedAt: index,
    })),
    startedAt: 0,
    updatedAt: 0,
  }
}

describe('analyzeWorkflowScript 静态扫描', () => {
  it('按声明序切阶段，标记之前的步骤归隐式阶段', () => {
    const graph = analyzeWorkflowScript(SCRIPT)
    expect(graph.phases.map((phase) => phase.name)).toEqual(['', '收集', '汇总'])
    expect(graph.phases[0]!.implicit).toBe(true)
    expect(graph.phases[0]!.nodes.map((node) => node.name)).toEqual(['导读'])
    expect(graph.phases[1]!.nodes.map((node) => node.name)).toEqual(['读者A', '读者B'])
    // 只有标记没有步骤的阶段也要成站
    expect(graph.phases[2]!.nodes).toEqual([])
    expect(graph.totalSteps).toBe(3)
    expect(graph.source).toBe('static')
  })

  it('parallel([...]) 内的 agent 同组，组外不同组，maxParallel 取最大组', () => {
    const graph = analyzeWorkflowScript(`
      phase('并行')
      await parallel([
        () => agent('甲', 'p1'),
        () => agent('乙', 'p2'),
        () => agent('丙', 'p3'),
      ])
      await agent('串行', 'p4')
    `)
    const nodes = graph.phases[0]!.nodes
    expect(nodes).toHaveLength(4)
    const groups = nodes.map((node) => node.parallelGroup)
    expect(groups[0]).not.toBeNull()
    expect(groups[0]).toBe(groups[1])
    expect(groups[1]).toBe(groups[2])
    expect(groups[3]).toBeNull()
    expect(graph.maxParallel).toBe(3)
  })

  it('没有并行时 maxParallel 为 1', () => {
    expect(analyzeWorkflowScript(SCRIPT).maxParallel).toBe(1)
  })

  it('注释与字符串里的假调用不算数', () => {
    const graph = analyzeWorkflowScript(`
      // phase('假的')
      /* agent('也不是真的', 'x') */
      const note = "phase('还是假的')"
      phase('真的')
      await agent('真步骤', '真的 prompt')
    `)
    expect(graph.phases.map((phase) => phase.name)).toEqual(['真的'])
    expect(graph.phases[0]!.nodes.map((node) => node.name)).toEqual(['真步骤'])
    expect(graph.totalSteps).toBe(1)
  })

  it('名字里的转义引号不提前闭合字符串', () => {
    const graph = analyzeWorkflowScript(`await agent('他说\\'好\\'', 'p')`)
    expect(graph.phases[0]!.nodes[0]!.name).toBe("他说\\'好\\'")
  })

  it('首个实参不是字面量时不当成步骤名（不能把 prompt 当名字）', () => {
    const graph = analyzeWorkflowScript(`
      const label = 'x'
      await agent(label, '这是 prompt，不是名字')
    `)
    expect(graph.phases[0]!.nodes[0]!.name).toBe('')
  })

  it('空脚本 / 括号未配平都不抛错', () => {
    expect(analyzeWorkflowScript('').phases).toEqual([])
    expect(analyzeWorkflowScript('   ').totalSteps).toBe(0)
    const broken = analyzeWorkflowScript(`phase('一')\nawait parallel([() => agent('a','p')`)
    expect(broken.phases).toHaveLength(1)
    expect(broken.totalSteps).toBe(1)
  })

  it('药丸色档位只由名字决定（同名字同色）', () => {
    expect(workflowPillTone('读者A')).toBe(workflowPillTone('读者A'))
    expect(workflowPillTone('读者A')).toBeGreaterThanOrEqual(0)
    expect(workflowPillTone('读者A')).toBeLessThan(4)
  })
})

describe('buildWorkflowGraphView 视图合并', () => {
  const graph = analyzeWorkflowScript(SCRIPT)

  it('没有实况时是静态态：全部空心、staticOnly', () => {
    const view = buildWorkflowGraphView(graph)
    expect(view.staticOnly).toBe(true)
    expect(view.phases.flatMap((phase) => phase.nodes).every((node) => node.status === 'pending')).toBe(true)
    expect(view.doneSteps).toBe(0)
  })

  it('实况按名字点亮，阶段状态折叠正确', () => {
    const view = buildWorkflowGraphView(graph, snapshot([
      { name: '导读', status: 'completed' },
      { name: '读者A', phase: '收集', status: 'running' },
    ]))
    expect(view.staticOnly).toBe(false)
    expect(view.phases[0]!.status).toBe('completed')
    expect(view.phases[1]!.status).toBe('running')
    expect(view.phases[1]!.done).toBe(0)
    expect(view.phases[1]!.total).toBe(2)
    expect(view.runningSteps).toBe(1)
    // 阶段里还没派发的步骤保持 pending
    expect(view.phases[1]!.nodes[1]!.status).toBe('pending')
  })

  it('全部完成时阶段灯为完成', () => {
    const view = buildWorkflowGraphView(graph, snapshot([
      { name: '导读', status: 'completed' },
      { name: '读者A', phase: '收集', status: 'completed' },
      { name: '读者B', phase: '收集', status: 'completed' },
    ]))
    expect(view.phases.map((phase) => phase.status)).toEqual(['completed', 'completed', 'pending'])
    expect(view.doneSteps).toBe(3)
  })

  it('失败优先于完成（同阶段里有一枚红就整站红）', () => {
    const view = buildWorkflowGraphView(graph, snapshot([
      { name: '导读', status: 'completed' },
      { name: '读者A', phase: '收集', status: 'failed' },
      { name: '读者B', phase: '收集', status: 'completed' },
    ]))
    expect(view.phases[1]!.status).toBe('failed')
  })

  it('实况里多出来的阶段与步骤（条件分支）照实追加', () => {
    const view = buildWorkflowGraphView(graph, snapshot([
      { name: '导读', status: 'completed' },
      { name: '临时核查', phase: '补救', status: 'running' },
    ]))
    const extra = view.phases.find((phase) => phase.name === '补救')
    expect(extra).toBeDefined()
    expect(extra!.nodes.map((node) => node.name)).toEqual(['临时核查'])
    expect(extra!.status).toBe('running')
  })

  it('静态图里没有名字的步骤回退成 #序号', () => {
    const anonymous = analyzeWorkflowScript(`
      const label = 'x'
      await agent(label, 'p')
    `)
    expect(buildWorkflowGraphView(anonymous).phases[0]!.nodes[0]!.name).toBe('#1')
  })

  it('终态尾巴走同一条合并路径（按 phase 归属挂站）', () => {
    const view = buildWorkflowGraphViewFromTail(graph, {
      runId: 'wf-tail',
      name: '测试工作流',
      status: 'completed',
      phases: ['收集', '汇总'],
      steps: [
        { key: 'step-1', name: '导读', phase: '', status: 'completed' },
        { key: 'step-2', name: '读者A', phase: '收集', status: 'completed' },
        { key: 'step-3', name: '读者B', phase: '收集', status: 'completed' },
      ],
    })
    expect(view.phases[0]!.status).toBe('completed')
    expect(view.phases[1]!.status).toBe('completed')
    expect(view.phases[2]!.status).toBe('pending')
  })

  it('旧尾巴没有 phase 归属时按声明序分摊，不把步骤全塞进隐式阶段', () => {
    const view = buildWorkflowGraphViewFromTail(graph, {
      runId: 'wf-legacy',
      name: '旧格式',
      status: 'completed',
      phases: ['收集'],
      steps: [
        { key: 'step-1', name: '导读', status: 'completed' },
        { key: 'step-2', name: '读者A', status: 'completed' },
        { key: 'step-3', name: '读者B', status: 'completed' },
      ],
    })
    // 仍是脚本里的三个站，没有凭空多出一个「未分组」
    expect(view.phases.map((phase) => phase.name)).toEqual(['', '收集', '汇总'])
    expect(view.phases[0]!.done).toBe(1)
    expect(view.phases[1]!.done).toBe(2)
  })
})

describe('单实参调用（agent(prompt)）', () => {
  it('不把 prompt 当成步骤名，回退成 #序号', () => {
    const graph = analyzeWorkflowScript(`
      await parallel([
        () => agent(\`只读任务：阅读报告 A，总结 3 条结论\`),
        () => agent(\`只读任务：阅读报告 B，总结 3 条结论\`),
      ])
    `)
    expect(graph.totalSteps).toBe(2)
    expect(graph.phases[0]!.nodes.map((node) => node.name)).toEqual(['', ''])
    // 并行组识别不受影响
    expect(graph.maxParallel).toBe(2)
  })

  it('两实参时仍然取首个字面量作名字', () => {
    const graph = analyzeWorkflowScript(`await agent('读者A', '很长的 prompt')`)
    expect(graph.phases[0]!.nodes[0]!.name).toBe('读者A')
  })
})
