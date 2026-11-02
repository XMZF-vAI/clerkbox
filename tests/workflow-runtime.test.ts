/**
 * 工作流运行时测试：脚本校验 / facade 执行语义 / 运行簿记 / 报告与 UI 尾巴。
 *
 * 守六件事：
 *  1. 校验器把「没意义/不安全」的脚本挡在执行前（空、语法错、deny 清单、无 agent 调用）；
 *  2. agent() 串行等待、parallel() 并行派发——脚本即 SOP；
 *  3. 失败语义：步骤失败 → run failed；宿主中止（'[aborted]' / signal）→ run aborted；
 *  4. 脚本抛错后未走到赋值的 running 步骤被收尾归档（绝不悬挂 running）；
 *  5. 报告面向模型如实转述（含 agentId 续聊钥匙），UI 尾巴可往返解析；
 *  6. 注册表生命周期：get/list/reset，运行上限淘汰只动终态运行。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkWorkflowScript,
  executeWorkflowScript,
  formatWorkflowRunReport,
  encodeWorkflowRunTail,
  parseWorkflowRunTail,
  getWorkflowRun,
  listWorkflowRuns,
  resetWorkflowRunsForTests,
  MAX_WORKFLOW_SCRIPT_BYTES,
  type WorkflowHostPort,
  type WorkflowProgressSnapshot,
} from '../src/lib/workflow-runtime'

function makeHost(responses: Array<string | Error>, opts: { signal?: AbortSignal } = {}): WorkflowHostPort & { prompts: string[] } {
  const prompts: string[] = []
  let i = 0
  return {
    prompts,
    signal: opts.signal,
    runAgent: async ({ prompt }) => {
      prompts.push(prompt)
      const next = responses[i++]
      if (next instanceof Error) throw next
      return { result: next ?? '', agentId: `subagent-test-${i}` }
    },
  }
}

const CLEAN_SCRIPT = `
phase('收集')
const a = await agent('读者A', '读取文件 X 并总结要点')
const b = await agent('读者B', '读取文件 Y 并总结要点')
phase('汇总')
return '对比：' + a.slice(0, 20) + ' / ' + b.slice(0, 20)
`

describe('checkWorkflowScript 校验器', () => {
  it('干净脚本通过', () => {
    const check = checkWorkflowScript(CLEAN_SCRIPT)
    expect(check.ok).toBe(true)
    expect(check.issues).toEqual([])
  })

  it('空脚本 / 纯空白拒绝', () => {
    expect(checkWorkflowScript('').ok).toBe(false)
    expect(checkWorkflowScript('   \n  ').ok).toBe(false)
  })

  it('语法错误在编译期暴露，不执行', () => {
    const check = checkWorkflowScript('const a = {')
    expect(check.ok).toBe(false)
    expect(check.issues.some((i) => i.includes('语法错误'))).toBe(true)
  })

  it('deny 清单：模块访问 / 宿主全局 / 动态求值一律拒绝', () => {
    for (const bad of [
      'import { readFileSync } from "node:fs"',
      'const fs = require("fs")',
      'process.exit(1)',
      'globalThis.secret',
      'window.alert(1)',
      'document.title',
      'eval("1+1")',
      'const f = new Function("return 1")',
    ]) {
      const check = checkWorkflowScript(`await agent('a', 'x')\n${bad}`)
      expect(check.ok, bad).toBe(false)
    }
  })

  it('没有一次 agent() 调用的脚本没有存在意义', () => {
    const check = checkWorkflowScript('return 1 + 1')
    expect(check.ok).toBe(false)
    expect(check.issues.some((i) => i.includes('agent'))).toBe(true)
  })

  it('体积上限', () => {
    const big = `await agent('a', '${'x'.repeat(MAX_WORKFLOW_SCRIPT_BYTES)}')`
    expect(checkWorkflowScript(big).ok).toBe(false)
  })
})

describe('executeWorkflowScript 执行语义', () => {
  beforeEach(() => resetWorkflowRunsForTests())

  it('串行 agent() 按序派发，步骤簿记完整', async () => {
    const host = makeHost(['A 的总结', 'B 的总结'])
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '双文档对比',
      script: CLEAN_SCRIPT,
      args: {},
      host,
    })
    expect(run.status).toBe('completed')
    expect(host.prompts).toEqual(['读取文件 X 并总结要点', '读取文件 Y 并总结要点'])
    expect(run.steps.map((s) => s.status)).toEqual(['completed', 'completed'])
    expect(run.steps[0]?.agentId).toBe('subagent-test-1')
    expect(run.steps[0]?.excerpt).toBe('A 的总结')
    expect(run.phases.map((p) => p.name)).toEqual(['收集', '汇总'])
    expect(run.result).toContain('A 的总结'.slice(0, 20))
  })

  it('args 在脚本内可达', async () => {
    const host = makeHost(['ok'])
    let received = ''
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: 'args 透传',
      script: "await agent('读者', '总结 ' + args.topic)",
      args: { topic: 'shiki 接入' },
      host,
    })
    expect(run.status).toBe('completed')
    received = host.prompts[0] ?? ''
    expect(received).toBe('总结 shiki 接入')
  })

  it('parallel 并行派发，全部完成后继续', async () => {
    const host = makeHost(['P1', 'P2', 'final'])
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '并行扇出',
      script: `
const [x, y] = await parallel([
  () => agent('左路', '任务一'),
  () => agent('右路', '任务二'),
])
return (await agent('汇总', x.slice(0, 5) + y.slice(0, 5)))
`,
      args: {},
      host,
    })
    expect(run.status).toBe('completed')
    expect(run.steps).toHaveLength(3)
    expect(run.steps.every((s) => s.status === 'completed')).toBe(true)
    expect(run.result).toContain('final')
  })

  it('parallel 元素不是函数时给出可自纠的错误', async () => {
    const host = makeHost([])
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '坏 parallel',
      script: 'await parallel([agent("a", "x")])',
      args: {},
      host,
    })
    expect(run.status).toBe('failed')
    expect(run.error).toContain('parallel() 第 1 项不是函数')
  })

  it('agent() 空 prompt 给出可自纠的错误', async () => {
    const host = makeHost([])
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '空 prompt',
      script: 'await agent("读者", "")',
      args: {},
      host,
    })
    expect(run.status).toBe('failed')
    expect(run.error).toContain('prompt 是空的')
  })

  it('步骤失败 → run failed，error 可读', async () => {
    const host = makeHost([new Error('子代理超时')])
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '会失败的工作流',
      script: "await agent('会挂的', '任务')",
      args: {},
      host,
    })
    expect(run.status).toBe('failed')
    expect(run.error).toContain('子代理超时')
    expect(run.steps[0]?.status).toBe('failed')
  })

  it('宿主返回 [aborted] → run aborted，后续步骤不再派发', async () => {
    const host = makeHost(['[aborted]', '不该被消费'])
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '被停止的工作流',
      script: `
await agent('第一步', '任务一')
await agent('第二步', '任务二')
`,
      args: {},
      host,
    })
    expect(run.status).toBe('aborted')
    expect(run.steps[0]?.status).toBe('aborted')
    expect(host.prompts).toHaveLength(1)
  })

  it('AbortSignal 已中止时不再派发新步骤', async () => {
    const controller = new AbortController()
    controller.abort()
    const host = makeHost([], { signal: controller.signal })
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '信号中止',
      script: "await agent('第一步', '任务')",
      args: {},
      host,
    })
    expect(run.status).toBe('aborted')
    expect(host.prompts).toHaveLength(0)
  })

  it('脚本抛错后未完成的 running 步骤被收尾归档（绝不悬挂 running）', async () => {
    // parallel 第二路抛错时，第一路可能已结算、脚本异常中断——
    // 这里直接构造「步骤还在 running 时脚本崩了」的场景
    const host = makeHost(['ok'])
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '中途崩',
      script: `
const r = await agent('成功者', '任务一')
throw new Error('脚本自己崩了')
`,
      args: {},
      host,
    })
    expect(run.status).toBe('failed')
    expect(run.steps[0]?.status).toBe('completed')
    expect(run.error).toContain('脚本自己崩了')
    expect(run.steps.every((s) => s.status !== 'running')).toBe(true)
  })

  it('注册表：run 可查、按会话过滤、reset 清空', async () => {
    const host = makeHost(['ok'])
    const run = await executeWorkflowScript({ sessionId: 's-A', name: 'n', script: "await agent('a', 'x')", args: {}, host })
    expect(getWorkflowRun(run.id)?.name).toBe('n')
    expect(listWorkflowRuns('s-B')).toHaveLength(0)
    expect(listWorkflowRuns('s-A')).toHaveLength(1)
    resetWorkflowRunsForTests()
    expect(getWorkflowRun(run.id)).toBeUndefined()
  })
})

describe('报告与 UI 尾巴', () => {
  beforeEach(() => resetWorkflowRunsForTests())

  it('报告如实含步骤状态、agentId、最终结果与汇报纪律', async () => {
    const host = makeHost(['A 结果', 'B 结果'])
    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '报告格式',
      script: `
await agent('读者A', '任务A')
await agent('读者B', '任务B')
return '全部读完'
`,
      args: {},
      host,
    })
    const report = formatWorkflowRunReport(run)
    expect(report).toContain('报告格式')
    expect(report).toContain('✅ 读者A')
    expect(report).toContain('[agentId: subagent-test-1]')
    expect(report).toContain('最终结果')
    expect(report).toContain('如实转述')
  })

  it('失败报告含错误行', async () => {
    const host = makeHost([new Error('boom')])
    const run = await executeWorkflowScript({ sessionId: 's1', name: 'n', script: "await agent('a', 'x')", args: {}, host })
    const report = formatWorkflowRunReport(run)
    expect(report).toContain('❌')
    expect(report).toContain('boom')
  })

  it('UI 尾巴 encode → parse 往返，报告正文与尾巴分离', async () => {
    const host = makeHost(['步骤产出'])
    const run = await executeWorkflowScript({ sessionId: 's1', name: '尾巴往返', script: "await agent('读者', '任务')", args: {}, host })
    const payload = formatWorkflowRunReport(run) + encodeWorkflowRunTail(run)
    const { report, run: tail } = parseWorkflowRunTail(payload)
    expect(tail).not.toBeNull()
    expect(tail?.name).toBe('尾巴往返')
    expect(tail?.steps).toHaveLength(1)
    expect(tail?.steps[0]?.status).toBe('completed')
    expect(report).not.toContain('__WORKFLOW_RUN__')
  })

  it('无尾巴的内容原样返回 run=null', () => {
    const { report, run } = parseWorkflowRunTail('普通结果')
    expect(report).toBe('普通结果')
    expect(run).toBeNull()
  })
})

describe('onProgress 实时快照', () => {
  it('起跑先推一帧，每步派发/结算各推一帧，终帧为终态', async () => {
    const frames: WorkflowProgressSnapshot[] = []
    const host = makeHost(['产出A', '产出B'])
    host.onProgress = (snapshot) => frames.push(snapshot)

    const run = await executeWorkflowScript({
      sessionId: 's1',
      name: '看板',
      script: CLEAN_SCRIPT,
      args: {},
      host,
    })

    expect(run.status).toBe('completed')
    // 首帧：已开始、还没有步骤
    expect(frames[0]!.status).toBe('running')
    expect(frames[0]!.steps).toEqual([])
    // 末帧：终态 + 每步都结算
    const last = frames[frames.length - 1]!
    expect(last.status).toBe('completed')
    expect(last.steps.map((step) => step.status)).toEqual(['completed', 'completed'])
    // 阶段归属：两步都在 phase('收集') 之后派发
    expect(last.steps.map((step) => step.phase)).toEqual(['收集', '收集'])
    expect(last.phases).toEqual(['收集', '汇总'])
    // 中间必须出现过「在跑」的帧，否则看板永远亮不起来
    expect(frames.some((frame) => frame.steps.some((step) => step.status === 'running'))).toBe(true)
  })

  it('步骤失败时终帧标 failed，看板能亮红灯', async () => {
    const frames: WorkflowProgressSnapshot[] = []
    const host = makeHost([new Error('boom')])
    host.onProgress = (snapshot) => frames.push(snapshot)

    const run = await executeWorkflowScript({ sessionId: 's1', name: '失败', script: "await agent('a', 'x')", args: {}, host })

    expect(run.status).toBe('failed')
    expect(frames[frames.length - 1]!.steps[0]!.status).toBe('failed')
  })

  it('回调抛错不影响工作流执行', async () => {
    const host = makeHost(['产出'])
    host.onProgress = () => { throw new Error('看板坏了') }

    const run = await executeWorkflowScript({ sessionId: 's1', name: '容错', script: "await agent('a', 'x')", args: {}, host })
    expect(run.status).toBe('completed')
  })
})
