/**
 * create_workflow：把「怎么干」写成脚本，一键编排子代理小队（工作流一期工具面）。
 *
 * 语义对标 ZCode CreateWorkflow：显式点名才启动、点名即绑定；脚本在权限门
 * （workflow-script 确认）放行后同步执行，工具结果即完整报告——不轮询。
 * 实现在 workflow-runtime.ts，这里只有契约与宿主端口桥接。
 */
import type { ToolDefinition, Message } from '../types/agent'
import type { ToolContext } from './tool-registry'
import {
  checkWorkflowScript,
  encodeWorkflowRunTail,
  executeWorkflowScript,
  formatWorkflowRunReport,
  MAX_WORKFLOW_SCRIPT_BYTES,
  type WorkflowHostPort,
} from './workflow-runtime'

export const WORKFLOW_TOOL_NAME = 'create_workflow'

export const WORKFLOW_TOOLS: ToolDefinition[] = [
  {
    name: WORKFLOW_TOOL_NAME,
    description:
      'Create and run a multi-agent workflow: you write a JavaScript orchestration script, it is shown to the user for approval, and on approval it executes immediately — the tool returns the full report when every step settles.\n' +
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
      '- The script runs with the session: stopping the session stops the workflow and all its sub-agents.\n' +
      '- Do not poll and do not duplicate the workflow\'s work while it runs — the result arrives when it settles.',
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
 * 运行全程在这一次工具调用内完成：子代理卡片实时出现，resolve 即终态报告。
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
    runAgent: async ({ prompt }) => {
      const raw = await spawn('general', prompt)
      // mainSpawnSubAgent 中止时返回字面量 [aborted]；透传给 runtime 归档为 aborted
      const clean = raw.startsWith('[aborted]') ? '[aborted]' : raw.split('\n\nagentId:')[0]?.trim() ?? raw
      return { result: clean, agentId: extractAgentId(raw) }
    },
    // 实时进度：宿主装配了看板通道就一路推下去；没装配时 runtime 跳过（行为不变）
    onProgress: ctx?.onWorkflowProgress,
  }

  const run = await executeWorkflowScript({
    sessionId: ctx?.sessionId ?? '',
    name: workflowName,
    script,
    args: scriptArgs,
    host,
  })

  const report = formatWorkflowRunReport(run)
  return `${report}${encodeWorkflowRunTail(run)}`
}

/** 渲染器/摘要侧用的类型再出口（避免 UI 直接依赖 runtime 内部） */
export type WorkflowToolCall = NonNullable<Message['toolCalls']>[0]
