/**
 * create_workflow：把「怎么干」写成脚本，一键编排子代理小队（工作流工具面）。
 *
 * 语义对标 ZCode CreateWorkflow 的 backgrounded：脚本在权限门（workflow-script
 * 确认）放行后**立即返回**确认文本，运行在后台进行；终态经宿主桥注回——
 * 通知进 pendingSubagentNotifications 队列（与后台子代理同一信封）、工具尾巴
 * 落回终态、journal 落盘、会话空闲时唤醒续跑。不轮询、不阻塞主对话。
 * 实现在 workflow-runtime.ts，这里只有契约与宿主端口桥接。
 */
import type { ToolDefinition } from '../types/agent'
import type { ToolContext } from './tool-registry'
import {
  checkWorkflowScript,
  encodeWorkflowRunTail,
  formatWorkflowNotification,
  formatWorkflowRunReport,
  launchWorkflowRun,
  MAX_WORKFLOW_SCRIPT_BYTES,
  type WorkflowHostPort,
} from './workflow-runtime'

export const WORKFLOW_TOOL_NAME = 'create_workflow'

export const WORKFLOW_TOOLS: ToolDefinition[] = [
  {
    name: WORKFLOW_TOOL_NAME,
    description:
      'Create and run a multi-agent workflow in the background: you write a JavaScript orchestration script, it is shown to the user for approval, and on approval it starts immediately — the tool returns right away with a run id, the workflow executes in the background, and its completion is delivered back to you as a notification.\n' +
      'When to use: ONLY when the user explicitly asks for a workflow ("用工作流", "use a workflow", "跑个工作流", "workflow"). This tool is mandatory in that case: do not substitute spawn_agent, however small the task. For single delegations without an explicit workflow request, use spawn_agent instead.\n' +
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
            'JavaScript async function body using agent()/parallel()/phase()/log()/args. Every agent prompt must be fully self-contained.',
        },
        args: {
          type: 'object',
          description: 'Optional arguments object reachable inside the script as `args` (paths, topics, constants). Keep constants here, not duplicated across prompts.',
        },
      },
      required: ['name', 'script'],
    },
  },
]

/** 从 spawn 结果串里取 agentId（mainSpawnSubAgent 的结果尾行格式） */
export function extractAgentId(raw: string): string | null {
  const match = raw.match(/agentId:\s*(subagent-[^\s)]+)/)
  return match?.[1] ?? null
}

/**
 * 工作流工具执行入口。未命中返回 null（调用方继续走其他分支）。
 * v2：校验通过即后台启动并立即返回确认文本——工具调用不再阻塞到跑完。
 */
export async function executeWorkflowTool(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string | null> {
  if (name !== WORKFLOW_TOOL_NAME) return null
  const spawn = ctx?.spawnSubAgent
  if (!spawn) {
    return 'Error: create_workflow 只能在主对话中使用（子代理不能再派发工作流）。'
  }
  const workflowName = String(args.name ?? '').slice(0, 80) || '未命名工作流'
  const script = String(args.script ?? '')
  const scriptArgs = (args.args && typeof args.args === 'object' && !Array.isArray(args.args))
    ? args.args as Record<string, unknown>
    : {}

  const check = checkWorkflowScript(script)
  if (!check.ok) {
    // 编不过不运行：把诊断还给模型自修（对标 ZCode「编不过不弹窗直接回诊断」）
    return `Error: 工作流脚本未通过校验，未执行。请修复后重新调用 create_workflow：\n${check.issues.map((i) => `- ${i}`).join('\n')}`
  }

  const host: WorkflowHostPort = {
    runAgent: async ({ prompt, signal }) => {
      // signal 透传：停止工作流时链式掐断在飞的子代理（mainSpawnSubAgent 侧做链接）
      const raw = await spawn('general', prompt, { signal })
      // mainSpawnSubAgent 中止时返回字面量 [aborted]；透传给 runtime 归档为 aborted
      const clean = raw.startsWith('[aborted]') ? '[aborted]' : raw.split('\n\nagentId:')[0]?.trim() ?? raw
      return { result: clean, agentId: extractAgentId(raw) }
    },
    onProgress: ctx?.onWorkflowProgress,
    onSettle: ctx?.workflowHost
      ? (run) => {
          const bridge = ctx.workflowHost!
          // 工具尾巴换终态：卡片从实时板切到终态图（发模型前剥离，只影响 UI 与恢复）
          bridge.updateToolResultTail(ctx.toolCallId ?? '', formatWorkflowRunReport(run) + encodeWorkflowRunTail(run))
          bridge.pushNotification(formatWorkflowNotification(run))
          bridge.journalPut(run)
          // 唤醒：completed/failed 都值得让模型立刻向用户总结；aborted 是用户亲手停的，
          // 再弹一轮总结是打扰——通知静留队列，随下一条用户消息注入。
          if (run.status !== 'aborted') bridge.requestWake()
        }
      : undefined,
  }

  const run = launchWorkflowRun({
    sessionId: ctx?.sessionId ?? '',
    name: workflowName,
    script,
    args: scriptArgs,
    host,
    toolCallId: ctx?.toolCallId,
    assistantMessageId: ctx?.assistantMessageId,
  })
  ctx?.workflowHost?.journalPut(run) // 起跑快照也落盘：跑到一半崩溃时恢复侧才知道它是 running

  return [
    `⏳ 工作流「${run.name}」已在后台启动（runId: ${run.id}）。`,
    '- 完成时会自动通知你，届时请向用户如实总结结果（含失败项）。',
    '- 现在不要轮询、不要等待、也不要重复它的工作——继续做用户交代的其他事即可。',
    '- 运行进度在对话的工作流卡片上实时可见。',
  ].join('\n') + encodeWorkflowRunTail(run)
}

/** 渲染器/摘要侧用的类型再出口（避免 UI 直接依赖 runtime 内部） */
export type WorkflowToolCall = NonNullable<import('../types/agent').Message['toolCalls']>[0]
