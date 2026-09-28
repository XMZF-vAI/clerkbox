import {
  MAX_PENDING_PROPOSALS,
  appendProposal,
  parseTaskDraft,
  readPendingProposals,
  readTaskStoreSnapshot,
  scheduleForModel,
} from './scheduled-task-proposal'
import type { TaskProposalAction } from '../types/scheduled-task'
import type { ToolDefinition } from '../types/agent'
import type { ToolContext } from './tool-registry'

/**
 * 智能体侧的定时任务工具。
 *
 * 关键语义：写操作（create/update/delete/set_enabled）**只提交提案**，
 * 由用户在定时任务页确认后才落到任务表。所以这里永远不写任务表，
 * 也就不会出现「宿主模式（工具在主进程）改不动渲染层 store」的分叉。
 */

export const SCHEDULE_TOOL_NAME = 'scheduled_task'

/** list 一次最多回吐的任务数 */
const LIST_MAX_TASKS = 50
/** list 里任务提示词的预览长度 */
const LIST_PROMPT_CLIP = 90

const SCHEDULE_ACTIONS: readonly TaskProposalAction[] = ['create', 'update', 'delete', 'set_enabled']

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function unknownTask(taskId: string): string {
  return `Error: no scheduled task with id "${taskId}". Call action="list" first and use the id it returns.`
}

function needsTaskId(action: TaskProposalAction, taskId: string): string | null {
  if (taskId) return null
  return `Error: action="${action}" needs task_id — read the current tasks with action="list".`
}

export const SCHEDULE_TOOLS: ToolDefinition[] = [
  {
    name: SCHEDULE_TOOL_NAME,
    description:
      "Create or change the user's scheduled tasks: recurring prompts the app runs on a clock while it is open. " +
      'Every write here only SUBMITS A PROPOSAL that the user must approve on the Scheduled Tasks page — nothing becomes live from this tool alone, so never say "the task is set up"; say it is waiting for approval.\n' +
      'Usage:\n' +
      '- Schedule = a recurring period plus a local clock time: kind "daily" | "weekdays" | "weekly" (needs weekday 0=Sunday…6=Saturday) | "monthly" (needs month_day 1-28), with hour 0-23 and minute 0-59. One-off runs ("in 20 minutes", "tomorrow 09:00") do not exist here: tell the user that plainly instead of inventing a plan.\n' +
      '- Always call action="list" before create (to avoid a duplicate plan) and before update/delete/set_enabled (it is the only source of task_id).\n' +
      '- prompt is what the future run receives verbatim, in a fresh session with no memory of this conversation: write it self-contained (goal, paths, expected output).\n' +
      '- update replaces the whole task content, so pass the complete new name, prompt and schedule (keep the unchanged fields as they were). It does not change the enabled switch or the model override — use set_enabled for that; to keep the task\'s working directory, echo the dir= value from action="list".\n' +
      '- At most ' + MAX_PENDING_PROPOSALS + ' proposals can wait at a time; the user must clear them before more are accepted.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...SCHEDULE_ACTIONS],
          description: 'create | list (read tasks and pending proposals) | update | delete | set_enabled',
        },
        name: { type: 'string', description: 'Task title, up to 60 characters (required for create/update)' },
        prompt: {
          type: 'string',
          description: 'The exact instruction the task sends to the AI when it fires; self-contained, up to 4000 characters (required for create/update)',
        },
        schedule: {
          type: 'object',
          description: 'Recurring plan with a local clock time (required for create/update)',
          properties: {
            kind: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly'], description: 'Repeat period' },
            weekday: { type: 'number', description: '0=Sunday … 6=Saturday (required when kind=weekly)' },
            month_day: { type: 'number', description: '1-28 (required when kind=monthly)' },
            hour: { type: 'number', description: '0-23' },
            minute: { type: 'number', description: '0-59' },
          },
          required: ['kind', 'hour', 'minute'],
        },
        working_dir: {
          type: 'string',
          description: 'Directory the run works in (optional; omit to use the session default)',
        },
        task_id: { type: 'string', description: 'Target task id from action="list" (required for update/delete/set_enabled)' },
        enabled: { type: 'boolean', description: 'Desired enabled state (required for set_enabled)' },
        reason: { type: 'string', description: 'One short sentence telling the user why you propose this change; shown on the approval card' },
      },
      required: ['action'],
    },
  },
]

export async function executeScheduledTaskTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  if (name !== SCHEDULE_TOOL_NAME) return `Error: unknown tool "${name}"`
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''

  if (action === 'list') {
    const [{ tasks }, proposals] = await Promise.all([readTaskStoreSnapshot(), readPendingProposals()])
    const lines: string[] = []
    lines.push(tasks.length === 0
      ? 'Scheduled tasks: none yet.'
      : `Scheduled tasks (${tasks.length}${tasks.length > LIST_MAX_TASKS ? `, showing first ${LIST_MAX_TASKS}` : ''}):`)
    for (const task of tasks.slice(0, LIST_MAX_TASKS)) {
      const dir = task.workingDir ? ` | dir=${task.workingDir}` : ''
      lines.push(
        `- id=${task.id} | ${task.enabled ? 'enabled' : 'paused'} | ${task.name} | ${scheduleForModel(task.schedule)}${dir}` +
          ` | prompt: ${clip(task.prompt, LIST_PROMPT_CLIP)}`,
      )
    }
    if (proposals.length === 0) {
      lines.push('Pending proposals awaiting the user: none.')
    } else {
      lines.push(`Pending proposals awaiting the user (${proposals.length}):`)
      for (const proposal of proposals) {
        const target = proposal.taskId ? ` task_id=${proposal.taskId}` : ''
        const detail = proposal.action === 'set_enabled'
          ? `→ ${proposal.enabled ? 'enabled' : 'paused'}`
          : proposal.draft
            ? `“${proposal.draft.name}” ${scheduleForModel(proposal.draft.schedule)}`
            : `“${proposal.taskName ?? '?'}”`
        lines.push(`- id=${proposal.id} ${proposal.action}${target} ${detail} (submitted ${new Date(proposal.createdAt).toISOString()}, expires ${new Date(proposal.expiresAt).toISOString()})`)
      }
    }
    return lines.join('\n')
  }

  if (!SCHEDULE_ACTIONS.includes(action as TaskProposalAction)) {
    return `Error: unknown action "${action}"; expected create | list | update | delete | set_enabled`
  }

  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  const rationale = typeof args.reason === 'string' ? args.reason.trim() : undefined
  const { tasks } = await readTaskStoreSnapshot()

  if (action === 'create') {
    const draft = parseTaskDraft(args)
    if (!draft.ok) return draft.error
    const duplicate = tasks.find(
      (task) =>
        task.enabled &&
        task.schedule.kind === draft.value.schedule.kind &&
        task.schedule.hour === draft.value.schedule.hour &&
        task.schedule.minute === draft.value.schedule.minute &&
        (task.schedule.weekday ?? -1) === (draft.value.schedule.weekday ?? -1) &&
        (task.schedule.monthDay ?? -1) === (draft.value.schedule.monthDay ?? -1),
    )
    const added = await appendProposal({
      action: 'create',
      draft: draft.value,
      rationale,
      sessionId: ctx?.sessionId,
    })
    if ('error' in added) return added.error
    return (
      `✅ Proposal ${added.id} submitted (create): “${draft.value.name}” — ${scheduleForModel(draft.value.schedule)}. ` +
      'It is NOT scheduled yet; the user has to approve it on the Scheduled Tasks page. ' +
      (duplicate ? `Note: an enabled task already covers this same plan (“${duplicate.name}”, id=${duplicate.id}) — mention it to the user. ` : '') +
      'Say what you proposed and where to approve it.'
    )
  }

  if (action === 'update') {
    const missing = needsTaskId('update', taskId)
    if (missing) return missing
    const current = tasks.find((task) => task.id === taskId)
    if (!current) return unknownTask(taskId)
    const draft = parseTaskDraft(args)
    if (!draft.ok) {
      return `${draft.error} (update replaces the whole task content: pass the complete new name, prompt and schedule)`
    }
    const added = await appendProposal({
      action: 'update',
      // 只带内容：启用状态、模型与工作目录沿用任务当时的值（见 store 的 acceptProposal），
      // 否则「先批停用、再批修改」会被修改提案里的 enabled 悄悄重新启用
      draft: draft.value,
      taskId,
      taskName: current.name,
      rationale,
      sessionId: ctx?.sessionId,
    })
    if ('error' in added) return added.error
    return (
      `✅ Proposal ${added.id} submitted (update) for “${current.name}” (id=${taskId}): ` +
      `now “${draft.value.name}” — ${scheduleForModel(draft.value.schedule)}. ` +
      'Nothing changed yet; the user has to approve it on the Scheduled Tasks page.'
    )
  }

  if (action === 'delete') {
    const missing = needsTaskId('delete', taskId)
    if (missing) return missing
    const current = tasks.find((task) => task.id === taskId)
    if (!current) return unknownTask(taskId)
    const added = await appendProposal({
      action: 'delete',
      taskId,
      taskName: current.name,
      rationale,
      sessionId: ctx?.sessionId,
    })
    if ('error' in added) return added.error
    return (
      `✅ Proposal ${added.id} submitted (delete) for “${current.name}” (id=${taskId}). ` +
      'The task is still in place; the user has to approve the deletion on the Scheduled Tasks page.'
    )
  }

  // set_enabled
  const missing = needsTaskId('set_enabled', taskId)
  if (missing) return missing
  if (typeof args.enabled !== 'boolean') return 'Error: action="set_enabled" needs enabled as a boolean (true to activate, false to pause)'
  const current = tasks.find((task) => task.id === taskId)
  if (!current) return unknownTask(taskId)
  if (current.enabled === args.enabled) {
    return `“${current.name}” is already ${args.enabled ? 'enabled' : 'paused'}; nothing to propose.`
  }
  const added = await appendProposal({
    action: 'set_enabled',
    taskId,
    taskName: current.name,
    enabled: args.enabled,
    rationale,
    sessionId: ctx?.sessionId,
  })
  if ('error' in added) return added.error
  return (
    `✅ Proposal ${added.id} submitted (set_enabled) for “${current.name}” (id=${taskId}): ` +
    `${args.enabled ? 'enable' : 'pause'}. The user has to approve it on the Scheduled Tasks page.`
  )
}

/** 提案是否落在本工具的能力面内（供测试与 UI 复用判断） */
export function isScheduleAction(value: unknown): value is TaskProposalAction {
  return typeof value === 'string' && SCHEDULE_ACTIONS.includes(value as TaskProposalAction)
}
