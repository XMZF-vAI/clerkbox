/**
 * 工作流运行时（一期，对标 ZCode dynamic-workflow 的「能跑」切片）。
 *
 * 模型把「怎么干」写成一段 JS 编排脚本（SOP），本模块负责：校验 → 沙箱化执行 →
 * 步骤簿记 → 结果报告。脚本跑在一个仅注入 facade（agent/parallel/phase/log/args）
 * 的 async 函数体里，每一步 agent() 经宿主端口派发一个真实子代理并等它完成。
 *
 * 信任模型（与 ZCode 同口径，明示不装傻）：脚本在执行前必须经用户确认
 * （loop 的 create_workflow 权限门），「进程/函数隔离不是安全沙箱」——
 * 静态 deny 清单只是第一道粗筛，确认门才是安全边界。
 *
 * v2 语义（对标 ZCode CreateWorkflow 的 backgrounded）：工具调用**立即返回**，
 * 脚本在后台跑（launchWorkflowRun），终态经 onSettle 回调由宿主注回——
 * 通知进 pendingSubagentNotifications 队列（与后台子代理同一信封），UI 尾巴
 * 落回工具结果，journal 落盘。resume-from-journal / Amend / hole / 保存复跑
 * 仍是三期。
 */

/** 脚本体积上限（ZCode 同款 512KB 收窄到 128KB——CB 单工具入参本就有截断） */
export const MAX_WORKFLOW_SCRIPT_BYTES = 128 * 1024

/** 单步结果在报告里的摘录长度 */
export const STEP_EXCERPT_CHARS = 400

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'aborted'
export type WorkflowStepStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface WorkflowStep {
  key: string
  /** facade agent() 的名字（纯展示，子代理卡片的实际名称由 agentType 决定） */
  name: string
  agentType: string
  /** 派发时所在的 phase 名（空串 = 第一个 phase 标记之前）——运行看板据此把步骤挂到站下 */
  phase?: string
  /** 截断后的 prompt（簿记用；完整 prompt 已交给子代理） */
  prompt: string
  agentId?: string
  status: WorkflowStepStatus
  /** 结果摘录（展示与报告用，400 字符） */
  excerpt?: string
  /** 完整结果（journal 续跑用，8KB 截断）——摘录喂下游会退化，这里存真身 */
  result?: string
  /** 命中续跑缓存：结果来自上一次 run 的 journal，本次没有派发子代理（零 token） */
  cached?: boolean
  startedAt: number
  endedAt?: number
}

export interface WorkflowPhase {
  name: string
  at: number
}

export interface WorkflowRun {
  id: string
  sessionId: string
  name: string
  status: WorkflowRunStatus
  phases: WorkflowPhase[]
  steps: WorkflowStep[]
  logs: string[]
  /** 脚本返回值（completed 时） */
  result?: string
  /** failed/aborted 时的错误摘要 */
  error?: string
  startedAt: number
  endedAt?: number
  /** 发起这次运行的工具调用 id（journal 恢复与工具尾巴更新的寻址钥匙） */
  toolCallId?: string
  /** 承载该工具调用的 assistant 消息 id（恢复时把卡死的 running 尾巴补成终态） */
  assistantMessageId?: string
  /** 编排脚本原稿（journal 持久化用——resume 要按原脚本重放） */
  script?: string
  /** 脚本入参（随 script 一起进 journal） */
  args?: Record<string, unknown>
  /** 本 run 是从哪次 run 续跑来的（resume_workflow 的血缘） */
  resumedFrom?: string
}

// ── 实时进度快照（运行看板的数据面） ──────────────────────────────

/**
 * 每步结算后推给宿主的只读快照。刻意是**值拷贝**而不是 WorkflowRun 引用：
 * 运行对象在脚本执行期间持续被改写，直接把引用交给 UI 会让「快照」随下一次
 * 变更一起变形，React 也拿不到新的对象身份去触发重渲染。
 */
export interface WorkflowProgressSnapshot {
  runId: string
  name: string
  status: WorkflowRunStatus
  /** 已经发出的 phase 标记（声明序，允许重名） */
  phases: string[]
  steps: Array<{
    key: string
    name: string
    /** 派发时所在的 phase（空串 = 第一个标记之前） */
    phase: string
    status: WorkflowStepStatus
    startedAt: number
    endedAt?: number
  }>
  startedAt: number
  updatedAt: number
}

// ── 运行注册表（进程内） ──────────────────────────────────────────
const MAX_RUNS = 100
const runs = new Map<string, WorkflowRun>()
/** 在跑的运行各自的停止开关：stopWorkflowRun / 会话级收敛都从这里拿 */
const runControllers = new Map<string, AbortController>()

export function getWorkflowRun(id: string): WorkflowRun | undefined {
  return runs.get(id)
}

/** 最近优先的运行清单（供 get/list 类工具与调试） */
export function listWorkflowRuns(sessionId?: string): WorkflowRun[] {
  const all = Array.from(runs.values()).sort((a, b) => b.startedAt - a.startedAt)
  return sessionId ? all.filter((r) => r.sessionId === sessionId) : all
}

/** 会话内仍在跑的运行（会话停止时要一并收敛的集合） */
export function listRunningWorkflowRuns(sessionId: string): WorkflowRun[] {
  return listWorkflowRuns(sessionId).filter((r) => r.status === 'running')
}

export function resetWorkflowRunsForTests(): void {
  runs.clear()
  runControllers.clear()
}

// ── 脚本校验 ──────────────────────────────────────────────────────

/** 静态 deny 清单：脚本没有理由碰宿主全局。best-effort 粗筛，确认门才是边界。 */
const DENY_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /(^|[^\w.])import\s*\(|(^|[^\w.])import\s+"/, why: '不允许 import（脚本环境只提供 facade，没有模块访问）' },
  { pattern: /require\s*\(/, why: '不允许 require（脚本环境只提供 facade，没有模块访问）' },
  { pattern: /(^|[^\w.])process\b/, why: '不允许访问 process' },
  { pattern: /globalThis\b/, why: '不允许访问 globalThis' },
  { pattern: /(^|[^\w.])window\b/, why: '不允许访问 window' },
  { pattern: /(^|[^\w.])document\b/, why: '不允许访问 document' },
  { pattern: /\beval\s*\(/, why: '不允许 eval' },
  { pattern: /\bnew\s+Function\b/, why: '不允许再套 Function 构造器' },
]

export interface WorkflowScriptCheck {
  ok: boolean
  issues: string[]
}

/**
 * 校验工作流脚本：体积上限 → 静态 deny 清单 → 语法编译（new Function 只编译不执行）。
 */
export function checkWorkflowScript(source: string): WorkflowScriptCheck {
  const issues: string[] = []
  if (!source || !source.trim()) {
    return { ok: false, issues: ['脚本是空的——写出编排逻辑（至少一个 await agent(...)）'] }
  }
  const oversized = source.length > MAX_WORKFLOW_SCRIPT_BYTES
  if (oversized) {
    issues.push(`脚本过大（${source.length} 字符，上限 ${MAX_WORKFLOW_SCRIPT_BYTES}）——把大段常量挪进 args 或拆分工作流`)
  }
  for (const { pattern, why } of DENY_PATTERNS) {
    if (pattern.test(source)) issues.push(why)
  }
  if (!/\bagent\s*\(/.test(source)) {
    issues.push('脚本里没有一次 agent(...) 调用——工作流至少要派发一个子代理；纯顺序逻辑请直接自己做')
  }
  // 语法编译独立于其他问题运行：一次把所有诊断给全（模型好自修），不因前序问题短路
  if (!oversized) {
    try {
      // 只编译不执行：语法错误在此暴露；通过后由调用方真正运行
      void new Function('ctx', 'args', `"use strict";\nreturn (async () => {\n${source}\n})()`)
    } catch (e) {
      issues.push(`脚本语法错误：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { ok: issues.length === 0, issues }
}

// ── 执行 ──────────────────────────────────────────────────────────

/** 宿主端口：脚本环境与真实子代理机制的唯一缝隙（依赖注入，双宿主同构） */
export interface WorkflowHostPort {
  /** 派发一个前台子代理并等它完成。返回干净结果正文与 agentId（续聊钥匙）。 */
  runAgent(step: { name: string; prompt: string; agentType: string; signal?: AbortSignal }): Promise<{ result: string; agentId: string | null }>
  /** 会话级中止信号：停止会话 = 停止工作流 */
  signal?: AbortSignal
  /**
   * 实时进度回调（可选）：每次阶段标记 / 步骤派发 / 步骤结算 / 运行收尾后各推一次快照。
   * 宿主据此点亮运行看板；未装配时工作流行为与今天完全一致。
   */
  onProgress?(snapshot: WorkflowProgressSnapshot): void
  /**
   * 终态回调（可选，v2 后台语义）：run 落进 completed/failed/aborted 时调用一次。
   * 宿主据此注回通知、更新工具尾巴、落 journal。未装配时调用方自行 await。
   */
  onSettle?(run: WorkflowRun): void
}

export interface ExecuteWorkflowInput {
  sessionId: string
  name: string
  script: string
  args?: Record<string, unknown>
  host: WorkflowHostPort
  /** 发起运行的工具调用 id（进 run 记录，journal 与尾巴更新用） */
  toolCallId?: string
  /** 承载工具调用的 assistant 消息 id（恢复时寻址） */
  assistantMessageId?: string
  /**
   * 续跑缓存（resume_workflow）：键 = `phase|name|prompt`，值 = 上次已完成的
   * 完整结果。命中即短路——不派发子代理、零 token，步骤记 cached 标记。
   * 脚本改过一个字都会导致键不匹配 → 照常重跑（诚实的缓存失效）。
   */
  stepCache?: Map<string, string>
  /** 血缘：本次 run 从哪次 run 续跑 */
  resumedFrom?: string
}

/** 续跑缓存的键（phase|name|prompt——脚本重放时同一逻辑步骤的稳定身份） */
export function workflowStepCacheKey(phase: string | undefined, name: string, prompt: string): string {
  return `${phase ?? ''}|${name}|${prompt}`
}

/** 从一次终态 run 构建续跑缓存（completed 步骤才有资格短路） */
export function buildStepCacheFromRun(run: WorkflowRun, fullResults?: Record<string, string>): Map<string, string> {
  const cache = new Map<string, string>()
  for (const step of run.steps) {
    if (step.status !== 'completed') continue
    const full = fullResults?.[step.key] ?? step.excerpt
    if (full) cache.set(workflowStepCacheKey(step.phase, step.name, step.prompt), full)
  }
  return cache
}

function safeText(value: unknown, limit: number): string {
  if (typeof value === 'string') return value.slice(0, limit)
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value).slice(0, limit)
  } catch {
    return String(value).slice(0, limit)
  }
}

/**
 * 执行工作流脚本直到完成。同步语义：resolve 即整个工作流结束（completed/failed/aborted）。
 * 脚本错误不抛出——全部落在 run.status/error 上，调用方拿 run 出报告。
 */
export async function executeWorkflowScript(input: ExecuteWorkflowInput): Promise<WorkflowRun> {
  const run: WorkflowRun = {
    id: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: input.sessionId,
    name: input.name.slice(0, 80) || '未命名工作流',
    status: 'running',
    phases: [],
    steps: [],
    logs: [],
    startedAt: Date.now(),
    toolCallId: input.toolCallId,
    assistantMessageId: input.assistantMessageId,
    script: input.script,
    args: input.args,
    resumedFrom: input.resumedFrom,
  }
  runs.set(run.id, run)
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next()
    if (oldest.done) break
    // 只淘汰已终态的运行；正在跑的绝不动
    const candidate = runs.get(oldest.value)
    if (candidate && candidate.status !== 'running') runs.delete(oldest.value)
    else break
  }

  const aborted = () => input.host.signal?.aborted === true || abortSeen
  // 宿主以 '[aborted]' 字面量回报子代理被停止（mainSpawnSubAgent 的中止哨兵）——
  // 它是比 signal 更早到达的停止信号，见到即记账，后续步骤不再派发
  let abortSeen = false

  /** 当前阶段名（phase() 声明序）；步骤派发时记进 step.phase，看板据此挂站 */
  let currentPhase = ''

  /** 推一次快照。回调由宿主提供，出错绝不能反过来打断工作流 */
  const emitProgress = () => {
    const onProgress = input.host.onProgress
    if (!onProgress) return
    try {
      onProgress({
        runId: run.id,
        name: run.name,
        status: run.status,
        phases: run.phases.map((phase) => phase.name),
        steps: run.steps.map((step) => ({
          key: step.key,
          name: step.name,
          phase: step.phase ?? '',
          status: step.status,
          startedAt: step.startedAt,
          endedAt: step.endedAt,
        })),
        startedAt: run.startedAt,
        updatedAt: Date.now(),
      })
    } catch {
      // 看板故障不影响编排
    }
  }

  const facade = {
    /** 派发一个子代理并等它完成，返回结果正文 */
    agent: async (name: unknown, prompt: unknown): Promise<string> => {
      const stepName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : `步骤 ${run.steps.length + 1}`
      const stepPrompt = typeof prompt === 'string' ? prompt : safeText(prompt, 4000)
      if (!stepPrompt.trim()) {
        throw new Error(`agent("${stepName}") 的 prompt 是空的——子代理看不到主对话，prompt 必须自带全部上下文`)
      }
      if (aborted()) throw new Error('[aborted] 会话已停止')
      // 续跑短路：同一逻辑步骤（phase|name|prompt 全同）在上次 run 已完成 →
      // 直接复用 journal 里的结果，不派发子代理（零 token）。脚本改过一个字
      // 键就不匹配，缓存自动失效照常重跑——诚实优先。
      const cacheHit = input.stepCache?.get(workflowStepCacheKey(currentPhase, stepName, stepPrompt))
      if (cacheHit !== undefined) {
        const step: WorkflowStep = {
          key: `step-${run.steps.length + 1}`,
          name: stepName,
          agentType: 'general',
          phase: currentPhase,
          prompt: stepPrompt.slice(0, 2000),
          status: 'completed',
          cached: true,
          excerpt: cacheHit.slice(0, STEP_EXCERPT_CHARS),
          result: cacheHit.slice(0, RESUME_RESULT_CAP),
          startedAt: Date.now(),
          endedAt: Date.now(),
        }
        run.steps.push(step)
        emitProgress()
        return cacheHit
      }
      const step: WorkflowStep = {
        key: `step-${run.steps.length + 1}`,
        name: stepName,
        agentType: 'general',
        phase: currentPhase,
        prompt: stepPrompt.slice(0, 2000),
        status: 'running',
        startedAt: Date.now(),
      }
      run.steps.push(step)
      emitProgress()
      try {
        // signal 透传给宿主：停止工作流时要能掐断**在飞**的子代理，而不只是挡住下一步
        const { result, agentId } = await input.host.runAgent({ name: stepName, prompt: stepPrompt, agentType: step.agentType, signal: input.host.signal })
        if (result === '[aborted]') {
          abortSeen = true
          throw new Error('[aborted] 会话已停止')
        }
        step.status = 'completed'
        step.endedAt = Date.now()
        step.agentId = agentId ?? undefined
        step.excerpt = result.slice(0, STEP_EXCERPT_CHARS)
        step.result = result.slice(0, RESUME_RESULT_CAP)
        emitProgress()
        return result
      } catch (e) {
        step.status = aborted() ? 'aborted' : 'failed'
        step.endedAt = Date.now()
        step.excerpt = e instanceof Error ? e.message.slice(0, STEP_EXCERPT_CHARS) : String(e).slice(0, STEP_EXCERPT_CHARS)
        emitProgress()
        throw e
      }
    },
    /** 并行派发：parallel([() => agent(...), () => agent(...)])，全部完成后一起返回 */
    parallel: async (fns: unknown): Promise<unknown[]> => {
      if (!Array.isArray(fns)) {
        throw new Error('parallel() 需要一个函数数组：parallel([() => agent("a", "..."), () => agent("b", "...")])')
      }
      return Promise.all(
        fns.map((fn, i) => {
          if (typeof fn !== 'function') {
            return Promise.reject(new Error(`parallel() 第 ${i + 1} 项不是函数——数组元素应当是 () => agent(...)`))
          }
          return (fn as () => Promise<unknown>)()
        }),
      )
    },
    /** 阶段标记：写给用户看的进度锚点 */
    phase: (name: unknown): void => {
      currentPhase = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : `阶段 ${run.phases.length + 1}`
      run.phases.push({ name: currentPhase, at: Date.now() })
      emitProgress()
    },
    /** 进度行（进 run.logs，终态报告附带） */
    log: (msg: unknown): void => {
      run.logs.push(safeText(msg, 200))
    },
  }

  // 起跑即推一帧：确认卡上的空心图换成运行看板的那一刻，灯要先亮成"未到"
  emitProgress()
  try {
    // 脚本以裸标识符使用 facade（agent/parallel/phase/log）——先解构再进入脚本体，
    // 「写脚本的人不该知道 ctx 这个实现细节」
    const factory = new Function(
      'ctx',
      'args',
      `"use strict";\nconst { agent, parallel, phase, log } = ctx;\nreturn (async () => {\n${input.script}\n})()`,
    )
    const value: unknown = await (factory as (ctx: unknown, args: unknown) => Promise<unknown>)(facade, input.args ?? {})
    run.result = safeText(value, 8000)
    run.status = 'completed'
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    run.status = aborted() ? 'aborted' : 'failed'
    run.error = message.slice(0, 2000)
  } finally {
    run.endedAt = Date.now()
    // 收尾：仍在 running 的步骤（脚本抛错时未走到赋值）按运行终态归档
    for (const step of run.steps) {
      if (step.status === 'running') {
        step.status = run.status === 'aborted' ? 'aborted' : 'failed'
        step.endedAt = step.endedAt ?? run.endedAt
      }
    }
    emitProgress()
    runControllers.delete(run.id)
    // 终态回调（v2 后台语义）：宿主注回通知 / 尾巴 / journal 的唯一时机。
    // 回调出错绝不反过来影响 run 的终态归档。
    try {
      input.host.onSettle?.(run)
    } catch {
      /* 注回失败只影响展示，工作流本身已闭环 */
    }
  }
  return run
}

// ── 后台启动与停止（v2） ──────────────────────────────────────────

/**
 * 后台启动一个工作流：立即返回 run（status='running'），脚本在后台跑，
 * 终态经 host.onSettle 注回。runtime 自持每 run 一个 AbortController——
 * stopWorkflowRun / abortWorkflowRunsForSession 都靠它收敛。
 *
 * 与 ZCode CreateWorkflow 的 `status:"backgrounded"` 同口径：调用方拿到
 * run 即可回确认文本，不等待、不轮询。executeWorkflowScript 的注册段
 * （run 创建 + 注册表写入）在首个 await 之前同步完成，所以下方必然查得到。
 */
export function launchWorkflowRun(input: ExecuteWorkflowInput): WorkflowRun {
  const controller = new AbortController()
  const host: WorkflowHostPort = {
    ...input.host,
    signal: controller.signal,
    onSettle: (run) => {
      runControllers.delete(run.id)
      input.host.onSettle?.(run)
    },
  }
  void executeWorkflowScript({ ...input, host })
  const started = listWorkflowRuns(input.sessionId).find(
    (r) => r.toolCallId === input.toolCallId && r.status === 'running',
  )
  if (!started) throw new Error('workflow launch failed: run not registered')
  runControllers.set(started.id, controller)
  return started
}

/** 停止单个运行：掐断在飞子代理 + 阻止后续派发；归档由执行侧 finally 完成 */
export function stopWorkflowRun(runId: string): boolean {
  const controller = runControllers.get(runId)
  if (!controller) return false
  controller.abort(new Error('[aborted] 工作流已被用户停止'))
  return true
}

/** 会话级收敛：停止会话 = 停止该会话所有在跑工作流（兑现工具描述的承诺） */
export function abortWorkflowRunsForSession(sessionId: string): number {
  let stopped = 0
  for (const run of listRunningWorkflowRuns(sessionId)) {
    if (stopWorkflowRun(run.id)) stopped += 1
  }
  return stopped
}

// ── 报告 ──────────────────────────────────────────────────────────

function formatDuration(ms: number | undefined): string {
  if (!Number.isFinite(ms) || ms === undefined) return ''
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

/** 面向模型 + 用户的运行报告（工具结果正文） */
export function formatWorkflowRunReport(run: WorkflowRun): string {
  const lines: string[] = []
  const statusText = run.status === 'completed' ? '✅ 已完成' : run.status === 'failed' ? '❌ 失败' : run.status === 'aborted' ? '⏹ 已停止' : '运行中'
  lines.push(`工作流「${run.name}」${statusText}（runId: ${run.id}${run.resumedFrom ? `，续跑自 ${run.resumedFrom}` : ''}，总耗时 ${formatDuration(run.endedAt ? run.endedAt - run.startedAt : undefined)}）`)
  if (run.phases.length > 0) {
    lines.push(`阶段：${run.phases.map((p) => p.name).join(' → ')}`)
  }
  lines.push('')
  for (const step of run.steps) {
    const icon = step.status === 'completed' ? '✅' : step.status === 'failed' ? '❌' : step.status === 'aborted' ? '⏹' : '⏳'
    const duration = formatDuration(step.endedAt ? step.endedAt - step.startedAt : undefined)
    lines.push(`${icon} ${step.cached ? '⚡' : ''}${step.name}${duration ? `（${duration}）` : ''}${step.agentId ? ` [agentId: ${step.agentId}]` : ''}${step.cached ? ' [缓存]' : ''}`)
    if (step.excerpt) {
      lines.push(`   ${step.excerpt.replace(/\n+/g, ' ').slice(0, STEP_EXCERPT_CHARS)}`)
    }
  }
  if (run.logs.length > 0) {
    lines.push('', '进度：')
    for (const log of run.logs) lines.push(`- ${log}`)
  }
  if (run.error) {
    lines.push('', `错误：${run.error}`)
  }
  if (run.status === 'completed' && run.result) {
    lines.push('', '最终结果：', run.result)
  }
  if (run.status === 'completed') {
    lines.push('', '向用户汇报工作流结果时：如实转述各步骤产出与失败项，不要复述本报告的机械格式。')
  }
  return lines.join('\n')
}

/**
 * 面向注回队列的工作流完成通知（与 <subagent-notification> 同一信封消费）。
 * 正文给模型够用即可：状态 + 失败项 + 最终结果/错误；完整步骤明细在工作流卡片上，
 * 不必塞进通知把上下文撑爆。上限与 SUBAGENT_NOTIFICATION_RESULT_CAP 对齐（4000）。
 */
export const WORKFLOW_NOTIFICATION_CAP = 4000

export function formatWorkflowNotification(run: WorkflowRun): string {
  const statusText = run.status === 'completed' ? '已完成' : run.status === 'failed' ? '失败' : '已停止'
  const failed = run.steps.filter((s) => s.status !== 'completed')
  const lines: string[] = []
  lines.push(`工作流「${run.name}」${statusText}（共 ${run.steps.length} 步${failed.length ? `，${failed.length} 步未完成` : ''}）`)
  for (const step of failed.slice(0, 8)) {
    lines.push(`- ${step.status === 'aborted' ? '⏹' : '❌'} ${step.name}${step.excerpt ? `：${step.excerpt.replace(/\n+/g, ' ').slice(0, 120)}` : ''}`)
  }
  if (failed.length > 8) lines.push(`- …另有 ${failed.length - 8} 步未完成`)
  if (run.status === 'completed' && run.result) lines.push('', run.result)
  if (run.error) lines.push('', `错误：${run.error}`)
  lines.push('', '请向用户如实总结工作流结果（含失败项）；完整步骤明细已在对话的工作流卡片上，不要复述本通知的机械格式。')
  const body = lines.join('\n').slice(0, WORKFLOW_NOTIFICATION_CAP)
  return `<workflow-notification runId="${run.id}" name="${run.name.replace(/"/g, '')}" status="${run.status}">\n${body}\n</workflow-notification>`
}

/**
 * 续跑用的完整步骤结果（journal 落盘专用，比 UI 摘要长得多）。
 * 键 = step.key；单步上限 8KB——超过按截断记（缓存结果质量降级是明示的）。
 */
export const RESUME_RESULT_CAP = 8 * 1024

export function collectResumeResults(run: WorkflowRun): Record<string, string> {
  const out: Record<string, string> = {}
  for (const step of run.steps) {
    if (step.status !== 'completed') continue
    const full = step.result ?? step.excerpt
    if (full) out[step.key] = full.slice(0, RESUME_RESULT_CAP)
  }
  return out
}

/** UI 专用尾巴（随 __EDIT_DIFF__ 同一模式：发模型前剥离，渲染器解析） */
export function encodeWorkflowRunTail(run: WorkflowRun): string {
  const payload = {
    runId: run.id,
    name: run.name,
    status: run.status,
    resumedFrom: run.resumedFrom,
    phases: run.phases.map((p) => p.name),
    durationMs: run.endedAt ? run.endedAt - run.startedAt : undefined,
    error: run.error,
    result: run.result?.slice(0, 2000),
    steps: run.steps.map((s) => ({
      key: s.key,
      name: s.name,
      phase: s.phase ?? '',
      status: s.status,
      agentId: s.agentId,
      excerpt: s.excerpt?.slice(0, 200),
      durationMs: s.endedAt ? s.endedAt - s.startedAt : undefined,
      cached: s.cached,
    })),
  }
  try {
    return `\n__WORKFLOW_RUN__:${JSON.stringify(payload)}`
  } catch {
    return ''
  }
}

export interface WorkflowRunTail {
  runId: string
  name: string
  status: WorkflowRunStatus
  phases: string[]
  durationMs?: number
  error?: string
  result?: string
  resumedFrom?: string
  steps: Array<{ key: string; name: string; phase?: string; status: WorkflowStepStatus; agentId?: string; excerpt?: string; durationMs?: number; cached?: boolean }>
}

/** 渲染器侧解析 UI 尾巴 */
export function parseWorkflowRunTail(content: string): { report: string; run: WorkflowRunTail | null } {
  const marker = '\n__WORKFLOW_RUN__:'
  const idx = content.indexOf(marker)
  if (idx === -1) return { report: content, run: null }
  const report = content.slice(0, idx).trim()
  try {
    const run = JSON.parse(content.slice(idx + marker.length)) as WorkflowRunTail
    return { report, run }
  } catch {
    return { report, run: null }
  }
}
