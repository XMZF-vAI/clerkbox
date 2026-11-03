/**
 * 工作流工具面（create_workflow / save_workflow / resume_workflow）。
 *
 * create_workflow 对标 ZCode CreateWorkflow 的 backgrounded：脚本在权限门
 * （workflow-script 确认）放行后**立即返回**确认文本，运行在后台进行；终态经
 * 宿主桥注回——通知进 pendingSubagentNotifications 队列（与后台子代理同一信封）、
 * 工具尾巴落回终态、journal 落盘、会话空闲时唤醒续跑。不轮询、不阻塞主对话。
 *
 * 三期「能存能复跑」：save_workflow 把脚本存进 <cwd>/.clerkbox/workflows/
 * （与 spec 文档同一收纳约定）；create_workflow 可用 saved=名字复用；
 * resume_workflow 从失败 run 的 journal 续跑——已完成步骤按
 * phase|name|prompt 短路复用（零 token），脚本改过一个字缓存自动失效。
 * runtime 实现在 workflow-runtime.ts，这里只有契约与宿主端口桥接。
 */
import type { ToolDefinition } from '../types/agent'
import type { ToolContext } from './tool-registry'
import { ipc } from './ipc-client'
import { listSavedWorkflowNames, readWorkflowFile, saveWorkflowFile } from './workflow-store'
import {
  buildStepCacheFromRun,
  checkWorkflowScript,
  collectResumeResults,
  encodeWorkflowRunTail,
  formatWorkflowNotification,
  formatWorkflowRunReport,
  getWorkflowRun,
  launchWorkflowRun,
  MAX_WORKFLOW_SCRIPT_BYTES,
  type WorkflowHostPort,
  type WorkflowRun,
} from './workflow-runtime'

export const WORKFLOW_TOOL_NAME = 'create_workflow'
export const SAVE_WORKFLOW_TOOL_NAME = 'save_workflow'
export const RESUME_WORKFLOW_TOOL_NAME = 'resume_workflow'

/** 需要过 workflow-script 确认门的工具（loop 的权限分支按这张表判定） */
export const WORKFLOW_GATED_TOOLS = [WORKFLOW_TOOL_NAME, RESUME_WORKFLOW_TOOL_NAME]

const RESUME_ACK_NOTE = '- 已完成的步骤直接复用上次结果（⚡ 缓存，零 token）；失败/未到的步骤重新执行。'

export const WORKFLOW_TOOLS: ToolDefinition[] = [
  {
    name: WORKFLOW_TOOL_NAME,
    description:
      'Create and run a multi-agent workflow in the background: you write a JavaScript orchestration script, it is shown to the user for approval, and on approval it starts immediately — the tool returns right away with a run id, the workflow executes in the background, and its completion is delivered back to you as a notification.\n' +
      'When to use: ONLY when the user explicitly asks for a workflow ("用工作流", "use a workflow", "跑个工作流", "workflow"). This tool is mandatory in that case: do not substitute spawn_agent, however small the task. For single delegations without an explicit workflow request, use spawn_agent instead.\n' +
      'Sources: provide exactly one of `script` (write it now) or `saved` (name of a previously saved workflow).\n' +
      'Script environment: the script is the body of an async function. Available bindings:\n' +
      '- `await agent(name, prompt)` — spawn a sub-agent, wait for completion, return its result text. Sub-agents see NONE of this conversation: put the goal, file paths, constraints and expected output format entirely in the prompt.\n' +
      '- `await parallel([() => agent("a", "..."), () => agent("b", "...")])` — run steps concurrently (Promise.all semantics; one failure rejects the phase).\n' +
      '- `phase(name)` — mark a phase boundary (shown to the user as progress).\n' +
      '- `log(message)` — progress line in the report.\n' +
      '- `args` — the arguments object you passed to this tool.\n' +
      'Usage notes:\n' +
      '- `return` a final string to deliver the workflow conclusion; per-step results are reported automatically.\n' +
      `- Script limit: ${MAX_WORKFLOW_SCRIPT_BYTES} chars. No import/require/process/DOM access — only the bindings above.\n` +
      '- The run belongs to the session: stopping the session stops the workflow and all its sub-agents.\n' +
      '- After launching: do NOT poll, do NOT wait for the result, and do NOT duplicate the workflow\'s work — continue with whatever else the user asked, and summarize the result faithfully when the completion notification arrives.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short workflow name shown to the user, e.g. "教程链接体检" or "三文档交叉核对".',
        },
        script: {
          type: 'string',
          description:
            'JavaScript async function body using agent()/parallel()/phase()/log()/args. Every agent prompt must be fully self-contained. Exactly one of `script` / `saved`.',
        },
        saved: {
          type: 'string',
          description: 'Name of a saved workflow (stored via save_workflow) to run instead of writing a script. Exactly one of `script` / `saved`.',
        },
        args: {
          type: 'object',
          description: 'Optional arguments object reachable inside the script as `args` (paths, topics, constants). Keep constants here, not duplicated across prompts.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: SAVE_WORKFLOW_TOOL_NAME,
    description:
      'Save a workflow script for reuse. Call this when a workflow worked well and the user may want to run it again (e.g. after a successful run, or when the user says 保存工作流/存下来). The script is stored under the workspace (.clerkbox/workflows/), survives restarts, and can be run later via create_workflow with `saved: name`.\n' +
      'The script must pass the same validation as create_workflow (only the facade bindings, at least one agent() call) — broken scripts are refused.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Workflow name (also the reuse handle for create_workflow `saved`), e.g. "教程链接体检".',
        },
        description: {
          type: 'string',
          description: 'One-line description of what this workflow does and when to reuse it.',
        },
        script: {
          type: 'string',
          description: 'The exact script that should be stored — usually the one that just ran successfully.',
        },
      },
      required: ['name', 'script'],
    },
  },
  {
    name: RESUME_WORKFLOW_TOOL_NAME,
    description:
      'Resume a failed or stopped workflow run in the background: completed steps are reused from the journal (zero tokens, marked ⚡ cached), only failed/not-reached steps actually re-execute. Use this when a workflow failed and the user wants to continue it (e.g. after transient API errors) — re-running everything via create_workflow would waste the completed work.\n' +
      'Requires the runId from the failed run\'s report or notification. The script is re-run from the journal; if the script changed, completed steps no longer match and re-run honestly.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The failed run to resume, e.g. "wf-1730-abc123".',
        },
      },
      required: ['runId'],
    },
  },
]

/** 从 spawn 结果串里取 agentId（mainSpawnSubAgent 的结果尾行格式） */
export function extractAgentId(raw: string): string | null {
  const match = raw.match(/agentId:\s*(subagent-[^\s)]+)/)
  return match?.[1] ?? null
}

function buildWorkflowHost(ctx: ToolContext | undefined): WorkflowHostPort {
  // 闭包里先落本地产：TS 的窄化不跨异步闭包，直接引用 ctx 会报 possibly undefined
  const spawn = ctx?.spawnSubAgent
  const bridge = ctx?.workflowHost
  const toolCallId = ctx?.toolCallId
  return {
    runAgent: async ({ prompt, signal }) => {
      if (!spawn) return { result: '[aborted]', agentId: null }
      // signal 透传：停止工作流时链式掐断在飞的子代理（mainSpawnSubAgent 侧做链接）
      const raw = await spawn('general', prompt, { signal })
      // mainSpawnSubAgent 中止时返回字面量 [aborted]；透传给 runtime 归档为 aborted
      const clean = raw.startsWith('[aborted]') ? '[aborted]' : raw.split('\n\nagentId:')[0]?.trim() ?? raw
      return { result: clean, agentId: extractAgentId(raw) }
    },
    onProgress: ctx?.onWorkflowProgress,
    onSettle: bridge
      ? (run) => {
          // 工具尾巴换终态：卡片从实时板切到终态图（发模型前剥离，只影响 UI 与恢复）
          bridge.updateToolResultTail(toolCallId ?? '', formatWorkflowRunReport(run) + encodeWorkflowRunTail(run))
          bridge.pushNotification(formatWorkflowNotification(run))
          bridge.journalPut(run)
          // 唤醒：completed/failed 都值得让模型立刻向用户总结；aborted 是用户亲手停的，
          // 再弹一轮总结是打扰——通知静留队列，随下一条用户消息注入。
          if (run.status !== 'aborted') bridge.requestWake()
        }
      : undefined,
  }
}

function launchAck(run: WorkflowRun, extraNotes: string[] = []): string {
  return [
    `⏳ 工作流「${run.name}」已在后台启动（runId: ${run.id}${run.resumedFrom ? `，续跑自 ${run.resumedFrom}` : ''}）。`,
    ...extraNotes,
    '- 完成时会自动通知你，届时请向用户如实总结结果（含失败项）。',
    '- 现在不要轮询、不要等待、也不要重复它的工作——继续做用户交代的其他事即可。',
    '- 运行进度在对话的工作流卡片上实时可见。',
  ].join('\n') + encodeWorkflowRunTail(run)
}

/** create_workflow：script / saved 二选一 → 校验 → 后台启动 */
async function executeCreateWorkflow(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const spawn = ctx?.spawnSubAgent
  if (!spawn) {
    return 'Error: create_workflow 只能在主对话中使用（子代理不能再派发工作流）。'
  }
  const workflowName = String(args.name ?? '').slice(0, 80) || '未命名工作流'
  let script = String(args.script ?? '')
  const savedName = String(args.saved ?? '').trim()
  const scriptArgs = (args.args && typeof args.args === 'object' && !Array.isArray(args.args))
    ? args.args as Record<string, unknown>
    : {}

  if (savedName && script.trim()) {
    return 'Error: `script` 与 `saved` 只能二选一——要么现写脚本，要么给已保存工作流的名字。'
  }
  if (savedName) {
    const workingDir = ctx?.workingDir
    if (!workingDir) return 'Error: 拿不到会话工作目录，无法读取已保存的工作流。'
    const saved = await readWorkflowFile(workingDir, savedName)
    if (!saved) {
      const names = await listSavedWorkflowNames(workingDir)
      return `Error: 找不到已保存的工作流「${savedName}」。已保存的有：${names.join('、') || '（还没有任何保存）'}；没有合适的就先 save_workflow 存一个。`
    }
    script = saved.script
  }
  if (!script.trim()) {
    return 'Error: create_workflow 需要 `script` 或 `saved` 之一——空脚本没有执行的意义。'
  }

  const check = checkWorkflowScript(script)
  if (!check.ok) {
    // 编不过不运行：把诊断还给模型自修（对标 ZCode「编不过不弹窗直接回诊断」）
    return `Error: 工作流脚本未通过校验，未执行。请修复后重新调用 create_workflow：\n${check.issues.map((i) => `- ${i}`).join('\n')}`
  }

  const run = launchWorkflowRun({
    sessionId: ctx?.sessionId ?? '',
    name: workflowName,
    script,
    args: scriptArgs,
    host: buildWorkflowHost(ctx),
    toolCallId: ctx?.toolCallId,
    assistantMessageId: ctx?.assistantMessageId,
  })
  ctx?.workflowHost?.journalPut(run) // 起跑快照也落盘：跑到一半崩溃时恢复侧才知道它是 running

  return launchAck(run, savedName ? [`- 脚本来自已保存的工作流「${savedName}」。`] : [])
}

/** save_workflow：把脚本存进 .clerkbox/workflows/（与 save_memory 同级的受控元数据写入） */
async function executeSaveWorkflow(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const name = String(args.name ?? '').trim()
  const description = String(args.description ?? '')
  const script = String(args.script ?? '')
  if (!name) return 'Error: save_workflow 需要 name（之后 create_workflow 用 `saved: name` 复用）。'
  if (!script.trim()) return 'Error: save_workflow 的 script 不能为空——要存的是能跑的编排脚本。'
  const check = checkWorkflowScript(script)
  if (!check.ok) {
    // 只存能跑的：存一份编不过的脚本，复用那天才暴雷
    return `Error: 脚本未通过校验，未保存。请修好再存：\n${check.issues.map((i) => `- ${i}`).join('\n')}`
  }
  const workingDir = ctx?.workingDir
  if (!workingDir) return 'Error: 拿不到会话工作目录，无法保存。'
  try {
    const filePath = await saveWorkflowFile(workingDir, { name, description, script })
    const names = await listSavedWorkflowNames(workingDir)
    return [
      `💾 已保存工作流「${name}」→ ${filePath}`,
      `复用方式：create_workflow({ name: "...", saved: "${name}" })`,
      `当前已保存：${names.join('、') || '（这是第一个）'}`,
    ].join('\n')
  } catch (e) {
    return `Error: 保存失败：${e instanceof Error ? e.message : String(e)}`
  }
}

/** resume_workflow：从失败 run 的 journal 续跑（completed 步骤短路复用） */
async function executeResumeWorkflow(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const spawn = ctx?.spawnSubAgent
  if (!spawn) {
    return 'Error: resume_workflow 只能在主对话中使用。'
  }
  const runId = String(args.runId ?? '').trim()
  if (!runId) return 'Error: resume_workflow 需要 runId（失败工作流的报告与通知里都带）。'

  // 优先内存注册表（同进程失败）；重启后回落 journal 磁盘记录
  let prev: WorkflowRun | undefined = getWorkflowRun(runId)
  if (!prev) {
    try {
      const entries = (await ipc.workflowJournalList()) as Array<{ runId: string; payload: unknown }>
      const hit = entries.find((e) => e.runId === runId)
      if (hit?.payload) prev = hit.payload as WorkflowRun
    } catch {
      /* journal 读不到（WebUI）：按找不到处理 */
    }
  }
  if (!prev) return `Error: 找不到 run ${runId}——确认 runId 来自失败工作流的报告或通知。`
  if (prev.status === 'running') return 'Error: 该 run 还在跑，不能对它续跑。'
  if (prev.status === 'completed') return 'Error: 该 run 已成功完成，无需续跑——直接向用户转述结果即可。'
  if (!prev.script) return 'Error: 该 run 的 journal 里没有脚本原文（旧版本记录），无法续跑；请用 create_workflow 重写。'

  const workflowName = String(args.name ?? '').trim() || prev.name
  const run = launchWorkflowRun({
    sessionId: ctx?.sessionId ?? '',
    name: workflowName.slice(0, 80),
    script: prev.script,
    args: prev.args ?? {},
    host: buildWorkflowHost(ctx),
    toolCallId: ctx?.toolCallId,
    assistantMessageId: ctx?.assistantMessageId,
    stepCache: buildStepCacheFromRun(prev, collectResumeResults(prev)),
    resumedFrom: runId,
  })
  ctx?.workflowHost?.journalPut(run)

  const doneCount = run.steps.length // 起跑瞬间已短路的缓存步
  return launchAck(run, [
    `- 续跑自 ${runId}：${doneCount > 0 ? `${doneCount} 个已完成步骤已从缓存复用（⚡ 零 token）` : '没有可复用的已完成步骤，全部重新执行'}。`,
    RESUME_ACK_NOTE,
  ])
}

/**
 * 工作流工具族执行入口。未命中返回 null（调用方继续走其他分支）。
 * v2：create_workflow 校验通过即后台启动并立即返回确认文本；
 * v3：save_workflow 落盘复用脚本、resume_workflow 从 journal 续跑。
 */
export async function executeWorkflowTool(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string | null> {
  if (name === WORKFLOW_TOOL_NAME) return executeCreateWorkflow(args, ctx)
  if (name === SAVE_WORKFLOW_TOOL_NAME) return executeSaveWorkflow(args, ctx)
  if (name === RESUME_WORKFLOW_TOOL_NAME) return executeResumeWorkflow(args, ctx)
  return null
}

/** 渲染器/摘要侧用的类型再出口（避免 UI 直接依赖 runtime 内部） */
export type WorkflowToolCall = NonNullable<import('../types/agent').Message['toolCalls']>[0]
