import { ipc } from './ipc-client'
import type {
  ScheduledTask,
  ScheduledTaskDraft,
  ScheduledTaskProposal,
  TaskProposalAction,
  TaskProposalDecision,
  TaskSchedule,
  TaskScheduleKind,
} from '../types/scheduled-task'

/**
 * 智能体提案的存储与校验层。
 *
 * 存在性约定：提案落在独立 KV key，写者只有提交侧（工具），且用进程内互斥把
 * 「读—改—写」串起来；用户裁决记在任务 store（渲染层唯一写者）里，两边不共享
 * 同一个 key，所以不会出现「渲染层整表覆盖把新提案冲掉」这类双写事故。
 */

/** 提案 KV key：整份数组存这里，提交侧单写 */
export const PROPOSALS_KV_KEY = 'clerkbox-scheduled-task-proposals'
/** 任务表 KV key：zustand persist 的信封，本模块只读不写 */
export const TASKS_KV_KEY = 'clerkbox-scheduled-tasks'

/** 提案有效期：超时未裁决即作废，用户不理睬时不积累 */
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000
/** 同时待确认的提案上限 */
export const MAX_PENDING_PROPOSALS = 20
/** 裁决记录保留时长：只需盖过提案有效期 */
export const DECISION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const MAX_NAME_CHARS = 60
const MAX_PROMPT_CHARS = 4000
const MAX_RATIONALE_CHARS = 500
const MAX_WORKING_DIR_CHARS = 500

const SCHEDULE_KINDS: readonly TaskScheduleKind[] = ['daily', 'weekdays', 'weekly', 'monthly']

/** 英文星期名：只出现在给模型看的工具输出里，界面文案另走 i18n */
const WEEKDAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** 一次性/相对时刻的常见写法：命中即给出可转述的拒绝理由，而不是含糊报错 */
const ONE_SHOT_HINTS = [
  'once', 'one_time', 'onetime', 'single', 'at', 'when', 'later', 'after',
  'in', 'interval', 'every_n', 'relative', 'minutes', 'hours', 'tomorrow',
]

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

const fail = (error: string): ParseResult<never> => ({ ok: false, error })

/** 把模型给的整数收紧成区间内的整数；非数字或越界即报错，绝不静默取整 */
function parseInteger(raw: unknown, label: string, min: number, max: number): ParseResult<number> {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
  if (!Number.isFinite(value)) return fail(`Error: ${label} must be a number between ${min} and ${max}`)
  if (!Number.isInteger(value)) return fail(`Error: ${label} must be a whole number between ${min} and ${max}`)
  if (value < min || value > max) return fail(`Error: ${label} must be between ${min} and ${max} (got ${value})`)
  return { ok: true, value }
}

/**
 * 解析计划：只接受「周期 + 本地时刻」。
 * 一次性任务（20 分钟后 / 明天 9 点）在数据模型里不存在，这里给出可转述的拒绝理由。
 */
export function parseTaskSchedule(raw: unknown): ParseResult<TaskSchedule> {
  if (!raw || typeof raw !== 'object') return fail('Error: schedule must be an object with kind, hour and minute')
  const input = raw as Record<string, unknown>
  const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : ''
  if (!kind) return fail('Error: schedule.kind is required (daily | weekdays | weekly | monthly)')
  if (!SCHEDULE_KINDS.includes(kind as TaskScheduleKind)) {
    const looksOneShot = ONE_SHOT_HINTS.some((hint) => kind === hint || kind.startsWith(`${hint}_`))
    if (looksOneShot) {
      return fail(
        `Error: schedule.kind "${kind}" is a one-shot schedule and is not supported. ` +
          'Scheduled tasks are recurring only (daily / weekdays / weekly on a weekday / monthly on a day of month, at a local clock time). ' +
          'Tell the user one-off reminders are unavailable, and propose the nearest recurring plan only if it genuinely fits.',
      )
    }
    return fail(`Error: schedule.kind "${kind}" is invalid; expected daily | weekdays | weekly | monthly`)
  }
  for (const forbidden of ['at', 'every', 'interval', 'delay_minutes', 'in_minutes', 'datetime']) {
    if (input[forbidden] !== undefined) {
      return fail(
        `Error: schedule.${forbidden} is not supported. Scheduled tasks are recurring: ` +
          'give schedule.kind plus a local hour and minute.',
      )
    }
  }
  const hour = parseInteger(input.hour ?? (typeof input.time === 'string' ? input.time.split(':')[0] : undefined), 'schedule.hour', 0, 23)
  if (!hour.ok) return hour
  const minute = parseInteger(input.minute ?? (typeof input.time === 'string' ? input.time.split(':')[1] : undefined), 'schedule.minute', 0, 59)
  if (!minute.ok) return minute

  const schedule: TaskSchedule = { kind: kind as TaskScheduleKind, hour: hour.value, minute: minute.value }
  if (schedule.kind === 'weekly') {
    const weekday = parseInteger(input.weekday ?? input.day_of_week, 'schedule.weekday (0=Sunday … 6=Saturday)', 0, 6)
    if (!weekday.ok) return weekday
    schedule.weekday = weekday.value
  }
  if (schedule.kind === 'monthly') {
    const monthDay = parseInteger(input.month_day ?? input.monthDay ?? input.day_of_month, 'schedule.month_day (1-28)', 1, 28)
    if (!monthDay.ok) return monthDay
    schedule.monthDay = monthDay.value
  }
  return { ok: true, value: schedule }
}

/** 解析任务内容（名称 + 提示词 + 计划 + 可选工作目录） */
export function parseTaskDraft(raw: Record<string, unknown>): ParseResult<ScheduledTaskDraft> {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return fail('Error: name is required (short task title)')
  if (name.length > MAX_NAME_CHARS) return fail(`Error: name is too long (max ${MAX_NAME_CHARS} characters)`)
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : ''
  if (!prompt) return fail('Error: prompt is required (the exact instruction sent to the AI when the task fires)')
  if (prompt.length > MAX_PROMPT_CHARS) return fail(`Error: prompt is too long (max ${MAX_PROMPT_CHARS} characters)`)
  const schedule = parseTaskSchedule(raw.schedule)
  if (!schedule.ok) return schedule
  const workingDirRaw = typeof raw.working_dir === 'string' ? raw.working_dir.trim() : undefined
  if (workingDirRaw && (workingDirRaw.length > MAX_WORKING_DIR_CHARS || /[\r\n]/.test(workingDirRaw))) {
    return fail(`Error: working_dir is invalid (max ${MAX_WORKING_DIR_CHARS} characters, no line breaks)`)
  }
  return {
    ok: true,
    value: {
      name,
      prompt,
      schedule: schedule.value,
      workingDir: workingDirRaw || undefined,
      model: null,
      enabled: true,
    },
  }
}

/** 给模型看的计划摘要（语言中性、可复述；界面文案另走 i18n） */
export function scheduleForModel(schedule: TaskSchedule): string {
  const clock = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
  switch (schedule.kind) {
    case 'weekdays':
      return `weekdays ${clock}`
    case 'weekly':
      return `weekly on ${WEEKDAY_EN[schedule.weekday ?? 1]} ${clock}`
    case 'monthly':
      return `monthly on day ${schedule.monthDay ?? 1} ${clock}`
    case 'daily':
    default:
      return `daily ${clock}`
  }
}

function parseRationale(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (!text) return undefined
  return text.slice(0, MAX_RATIONALE_CHARS)
}

/** 提案记录里的 pending 判定：未过期且未被裁决 */
export function isProposalPending(
  proposal: ScheduledTaskProposal,
  decidedIds: ReadonlySet<string>,
  now: number,
): boolean {
  return proposal.expiresAt > now && !decidedIds.has(proposal.id)
}

/** 宽松解析提案数组：脏数据逐条丢弃，不让一条坏记录把整个待确认区打死 */
function toProposals(raw: unknown): ScheduledTaskProposal[] {
  const list = Array.isArray(raw) ? raw : []
  const actions: readonly TaskProposalAction[] = ['create', 'update', 'delete', 'set_enabled']
  return list.flatMap((item): ScheduledTaskProposal[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id) return []
    if (!actions.includes(record.action as TaskProposalAction)) return []
    if (typeof record.createdAt !== 'number' || typeof record.expiresAt !== 'number') return []
    return [record as unknown as ScheduledTaskProposal]
  })
}

/** 进程内互斥：把「读—改—写」串成一条链，降低同进程并发 run 互盖提案数组的概率 */
let proposalsLock: Promise<unknown> = Promise.resolve()

function withProposalsLock<T>(job: () => Promise<T>): Promise<T> {
  const run = proposalsLock.then(job)
  proposalsLock = run.catch(() => undefined)
  return run
}

/**
 * 写一条提案并确认它真的在。
 *
 * withProposalsLock 只是**进程内**互斥，而 agent 可能同时跑在渲染进程与主进程
 * （AGENT_RUNTIME_MIGRATION_PLAN 的 P3 双宿主），两个进程各有一把锁、互不可见。
 * KV 是单键覆盖、没有 CAS，跨进程互斥做不出来；这里退一步用「写后回读 + 重试」：
 * 自己的提案不在回读结果里，就说明被另一个进程的写覆盖了，重读 kept 再写一次。
 * 冲突窗口只有一次 kvSet 的往返，重试即可收敛；仍失败则明确报错，让模型知道
 * 提案没提交成功，而不是让用户以为提交了却永远看不到。
 */
const PROPOSAL_WRITE_ATTEMPTS = 3

async function writeProposalWithVerify(
  proposal: ScheduledTaskProposal,
  seedKept: ScheduledTaskProposal[],
): Promise<{ ok: true } | { error: string }> {
  let kept = seedKept
  let lastError = ''
  for (let attempt = 0; attempt < PROPOSAL_WRITE_ATTEMPTS; attempt++) {
    try {
      await ipc.kvSet(PROPOSALS_KV_KEY, JSON.stringify([proposal, ...kept]))
    } catch (e) {
      return { error: `Error: could not store the proposal - ${e instanceof Error ? e.message : String(e)}` }
    }
    // 回读确认：并发写覆盖时自己的提案会凭空消失
    const stored = await readProposalRecords()
    if (stored.some((item) => item.id === proposal.id)) return { ok: true }
    kept = stored.filter((item) => item.expiresAt > proposal.createdAt)
    lastError = `another process wrote the proposal list at the same time (attempt ${attempt + 1})`
  }
  return {
    error:
      `Error: the proposal could not be stored - ${lastError}. ` +
      'Tell the user the scheduled-task change did NOT get submitted and ask them to try again.',
  }
}

/** 读提案原始记录（不做过期/裁决过滤）；KV 不可用时返回空表 */
export async function readProposalRecords(): Promise<ScheduledTaskProposal[]> {
  const raw = await ipc.kvGet(PROPOSALS_KV_KEY).catch(() => null)
  if (!raw) return []
  try {
    return toProposals(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 任务表快照 + 已裁决提案 id：两者都在任务 store 的 persist 信封里 */
export async function readTaskStoreSnapshot(): Promise<{ tasks: ScheduledTask[]; decided: Set<string> }> {
  const raw = await ipc.kvGet(TASKS_KV_KEY).catch(() => null)
  if (!raw) return { tasks: [], decided: new Set() }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { tasks: [], decided: new Set() }
  }
  const root = (parsed ?? {}) as Record<string, unknown>
  const state = (root.state ?? root) as Record<string, unknown>
  const tasks = Array.isArray(state.tasks) ? (state.tasks as ScheduledTask[]) : []
  const decisions = (state.proposalDecisions ?? {}) as Record<string, TaskProposalDecision | { at?: number }>
  return { tasks, decided: new Set(Object.keys(decisions)) }
}

/** 待确认提案（已过滤过期与已裁决） */
export async function readPendingProposals(now = Date.now()): Promise<ScheduledTaskProposal[]> {
  const [records, snapshot] = await Promise.all([readProposalRecords(), readTaskStoreSnapshot()])
  return records
    .filter((proposal) => isProposalPending(proposal, snapshot.decided, now))
    .sort((a, b) => b.createdAt - a.createdAt)
}

type ProposalsListener = () => void
const proposalsListeners = new Set<ProposalsListener>()

/** 订阅本进程内的提案提交（同进程 UI 立刻刷新，跨进程靠调度心跳兜底） */
export function onProposalsChanged(listener: ProposalsListener): () => void {
  proposalsListeners.add(listener)
  return () => proposalsListeners.delete(listener)
}

function notifyProposalsChanged(): void {
  for (const listener of proposalsListeners) {
    try {
      listener()
    } catch {
      /* 订阅方异常不影响提案已落盘这一事实 */
    }
  }
}

/**
 * 追加一条提案：顺手清理过期记录，超过上限则拒绝（让模型先让用户处理积压）。
 * 返回新提案 id。
 */
export async function appendProposal(input: {
  action: TaskProposalAction
  draft?: ScheduledTaskDraft
  taskId?: string
  taskName?: string
  enabled?: boolean
  rationale?: string
  sessionId?: string
}): Promise<{ id: string } | { error: string }> {
  return withProposalsLock(async () => {
    const now = Date.now()
    const [records, snapshot] = await Promise.all([readProposalRecords(), readTaskStoreSnapshot()])
    // 上限按「仍待用户裁决」计数，而不是「未过期」：已裁决的记录只剩墓碑作用，
    // 继续占名额会让用户批量批准之后 agent 在 24 小时内一条都提交不进来
    const pending = records.filter((proposal) => isProposalPending(proposal, snapshot.decided, now))
    if (pending.length >= MAX_PENDING_PROPOSALS) {
      return {
        error:
          `Error: ${pending.length} proposals are already waiting for the user to approve them ` +
          `(max ${MAX_PENDING_PROPOSALS}). Ask the user to review the Scheduled Tasks page first.`,
      }
    }
    const proposal: ScheduledTaskProposal = {
      id: `proposal-${now}-${Math.random().toString(36).slice(2, 8)}`,
      action: input.action,
      draft: input.draft,
      taskId: input.taskId,
      taskName: input.taskName,
      enabled: input.enabled,
      rationale: parseRationale(input.rationale),
      sessionId: input.sessionId,
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
    }
    // kept 仍带已裁决的记录：它们是墓碑之外的原始条目，留着不影响展示
    // （isProposalPending 会过滤掉），但会随 TTL 自然过期清理
    const kept = records.filter((proposal) => proposal.expiresAt > now)
    const written = await writeProposalWithVerify(proposal, kept)
    if ('error' in written) return written
    notifyProposalsChanged()
    return { id: proposal.id }
  })
}
