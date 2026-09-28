import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { sharedStorage } from '../lib/shared-storage'
import { ipc } from '../lib/ipc-client'
import { TRIGGER_TOLERANCE_MS, previousTriggerAt, summarizeAssistantReply } from '../lib/scheduled-task'
import { DECISION_RETENTION_MS, onProposalsChanged, readPendingProposals } from '../lib/scheduled-task-proposal'
import { useChatStore } from './chat-store'
import type {
  ScheduledTask,
  ScheduledTaskDraft,
  ScheduledTaskProposal,
  ScheduledTaskRun,
  TaskModelOverride,
  TaskProposalDecision,
  TaskRunNote,
  TaskRunStatus,
  TaskRunTrigger,
} from '../types/scheduled-task'

/**
 * 定时任务 store（渲染进程调度）。
 *
 * - 任务与执行记录随 zustand persist 落到主进程 KV（`clerkbox-scheduled-tasks`），
 *   桌面端与 WebUI 共用同一份数据。
 * - 调度只在应用运行期间生效（与页面提示条「仅在电脑保持唤醒时运行」一致）：
 *   心跳每 20s 检查一次，到点且落在容差窗口内才启动，落后太久只抬高水位线不补跑。
 * - 真正的执行由 `TaskRunHost` 承担（挂载 useAgent 并发出提示词），
 *   本 store 只负责「排队 → 建会话 → 记录状态」，避免把 React hooks 拉进 store。
 * - 智能体提交的任务变更先停在「待确认提案」里：提案本体存在独立 KV key（提交侧单写），
 *   这里只读不写；用户裁决记在本 store（渲染层单写）。两个 key 各自单写，
 *   不会出现整表覆盖把对方的数据冲掉。
 */

/** 执行记录上限：避免 KV 无限膨胀 */
const MAX_RUN_RECORDS = 200
/** 调度心跳间隔：到点后最多滞后这么久启动 */
const TICK_INTERVAL_MS = 20_000
/** 队首卡死判定的宽限期：刚启动的执行（会话已建、尚未流式）不参与判定 */
const STUCK_RUN_GRACE_MS = 30_000

/** 队首等待执行的任务（内存态；应用重启后进行中的记录统一收敛为「已中断」） */
export interface QueuedTaskRun {
  runId: string
  taskId: string
  taskName: string
  sessionId: string
  prompt: string
  workingDir?: string
  model?: TaskModelOverride | null
}

/** 用户对提案的裁决留痕（随任务表持久化：渲染层是这张表的唯一写者） */
export interface ProposalDecisionRecord {
  decision: TaskProposalDecision
  at: number
}

/** 只保留还在保留期内的裁决记录（防止 tombstone 无限增长） */
function pruneProposalDecisions(
  records: Record<string, ProposalDecisionRecord>,
  now: number,
): Record<string, ProposalDecisionRecord> {
  const next: Record<string, ProposalDecisionRecord> = {}
  for (const [id, record] of Object.entries(records)) {
    if (record && now - record.at <= DECISION_RETENTION_MS) next[id] = record
  }
  return next
}

/**
 * 提案能否落到任务表：载荷残缺或目标任务已被删除时不能，
 * 界面据此禁用「确认」，用户仍可以「忽略」把卡片清掉。
 */
export function isProposalApplicable(
  proposal: ScheduledTaskProposal,
  tasks: readonly ScheduledTask[],
): boolean {
  const targetExists = (id?: string) => !!id && tasks.some((task) => task.id === id)
  switch (proposal.action) {
    case 'create':
      return !!proposal.draft?.name.trim() && !!proposal.draft?.prompt.trim()
    case 'update':
      return !!proposal.draft?.name.trim() && targetExists(proposal.taskId)
    case 'delete':
    case 'set_enabled':
      return targetExists(proposal.taskId)
    default:
      return false
  }
}

interface ScheduledTasksState {
  tasks: ScheduledTask[]
  /** 执行记录（倒序，最多 MAX_RUN_RECORDS 条） */
  runs: ScheduledTaskRun[]
  /** 保持系统唤醒：阻止系统休眠，保证到点能跑（随开关持久化） */
  keepAwake: boolean
  /** 待执行队列：队首 = 正在执行的任务（内存态，不持久化） */
  queue: QueuedTaskRun[]
  /** 待确认的智能体提案（内存态：本体存在提交侧的独立 KV key，这里只读） */
  proposals: ScheduledTaskProposal[]
  /** 已裁决提案的留痕：用于把已处理过的提案从待确认列表里滤掉 */
  proposalDecisions: Record<string, ProposalDecisionRecord>
  setKeepAwake: (value: boolean) => void
  addTask: (draft: ScheduledTaskDraft) => string
  updateTask: (id: string, draft: ScheduledTaskDraft) => void
  removeTask: (id: string) => void
  setTaskEnabled: (id: string, enabled: boolean) => void
  duplicateTask: (id: string) => string | null
  /** 从 KV 重读待确认提案（已过滤过期与已裁决） */
  refreshProposals: () => Promise<void>
  /** 用户确认提案：应用到任务表并留痕。无法落地时返回 false 且不改任何状态 */
  acceptProposal: (id: string) => boolean
  /** 用户忽略提案：只留痕，不动任务表 */
  rejectProposal: (id: string) => void
  /** 抬高水位线（错过窗口、避免重复触发时使用） */
  markTriggered: (taskId: string, at: number) => void
  /**
   * 触发一次执行：建会话 + 写记录 + 入队。
   * 同一任务已有排队/进行中的执行时返回 null（串行，避免重叠抢占模型与目录）。
   */
  enqueueRun: (taskId: string, trigger: TaskRunTrigger) => string | null
  /** 执行宿主上报最终状态（成功/失败/中断 + 摘要） */
  finishRun: (runId: string, status: TaskRunStatus, error?: string, note?: TaskRunNote, summary?: string) => void
  clearRuns: () => void
}

const createId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** 统一裁剪任务字段：去掉空目录、规范化可选模型，避免脏数据进入 KV */
function normalizeDraft(draft: ScheduledTaskDraft): ScheduledTaskDraft {
  return {
    name: draft.name.trim(),
    prompt: draft.prompt,
    schedule: draft.schedule,
    workingDir: draft.workingDir?.trim() || undefined,
    model: draft.model ?? null,
    enabled: draft.enabled,
  }
}

export const useScheduledTasksStore = create<ScheduledTasksState>()(
  persist(
    (set, get) => ({
      tasks: [],
      runs: [],
      keepAwake: false,
      queue: [],
      proposals: [],
      proposalDecisions: {},

      setKeepAwake: (value) => {
        set({ keepAwake: value })
        void ipc.setKeepAwake(value).catch((e) => console.error('[scheduled-tasks] setKeepAwake failed:', e))
      },

      addTask: (draft) => {
        const now = Date.now()
        const task: ScheduledTask = {
          id: createId('task'),
          ...normalizeDraft(draft),
          createdAt: now,
          updatedAt: now,
          // 建任务即以当前时刻为水位线：不会立刻回溯触发刚过去的时间点
          lastRunAt: now,
        }
        set((state) => ({ tasks: [task, ...state.tasks] }))
        return task.id
      },

      updateTask: (id, draft) => {
        const now = Date.now()
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === id
              // 计划可变 → 重置水位线，避免改完时间立刻补触发旧时刻
              ? { ...task, ...normalizeDraft(draft), updatedAt: now, lastRunAt: now }
              : task,
          ),
        }))
      },

      removeTask: (id) => {
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== id),
          queue: state.queue.filter((item) => item.taskId !== id),
        }))
      },

      setTaskEnabled: (id, enabled) => {
        const now = Date.now()
        set((state) => ({
          tasks: state.tasks.map((task) =>
            // 重新启用时重置水位线：避免启用瞬间补触发上一次到点
            task.id === id ? { ...task, enabled, updatedAt: now, lastRunAt: now } : task,
          ),
        }))
      },

      duplicateTask: (id) => {
        const source = get().tasks.find((task) => task.id === id)
        if (!source) return null
        const now = Date.now()
        const copy: ScheduledTask = {
          ...source,
          id: createId('task'),
          // 副本默认停用：同名同计划的任务不会双双到点
          enabled: false,
          createdAt: now,
          updatedAt: now,
          lastRunAt: now,
        }
        set((state) => ({ tasks: [copy, ...state.tasks] }))
        return copy.id
      },

      refreshProposals: async () => {
        const pending = await readPendingProposals().catch((e) => {
          console.error('[scheduled-tasks] refreshProposals failed:', e)
          return null
        })
        if (!pending) return
        set((state) => {
          // 内容与顺序都没变就保持原数组引用，避免每次心跳都让页面重渲染
          const unchanged =
            state.proposals.length === pending.length &&
            state.proposals.every((item, index) => item.id === pending[index]?.id)
          return unchanged ? {} : { proposals: pending }
        })
      },

      acceptProposal: (id) => {
        const state = get()
        const proposal = state.proposals.find((item) => item.id === id)
        if (!proposal || !isProposalApplicable(proposal, state.tasks)) return false
        const now = Date.now()
        if (proposal.action === 'create' && proposal.draft) {
          state.addTask(proposal.draft)
        } else if (proposal.action === 'update' && proposal.draft && proposal.taskId) {
          // 只改内容：启用状态、模型、工作目录沿用任务当前值（提案不带这几项的意图）
          const current = state.tasks.find((task) => task.id === proposal.taskId)
          if (!current) return false
          state.updateTask(proposal.taskId, {
            ...proposal.draft,
            enabled: current.enabled,
            model: current.model ?? null,
            workingDir: proposal.draft.workingDir ?? current.workingDir,
          })
        } else if (proposal.action === 'delete' && proposal.taskId) {
          state.removeTask(proposal.taskId)
        } else if (proposal.action === 'set_enabled' && proposal.taskId) {
          state.setTaskEnabled(proposal.taskId, proposal.enabled === true)
        }
        set((prev) => ({
          proposals: prev.proposals.filter((item) => item.id !== id),
          proposalDecisions: pruneProposalDecisions(
            { ...prev.proposalDecisions, [id]: { decision: 'accepted' as TaskProposalDecision, at: now } },
            now,
          ),
        }))
        return true
      },

      rejectProposal: (id) => {
        const now = Date.now()
        set((prev) => ({
          proposals: prev.proposals.filter((item) => item.id !== id),
          proposalDecisions: pruneProposalDecisions(
            { ...prev.proposalDecisions, [id]: { decision: 'rejected' as TaskProposalDecision, at: now } },
            now,
          ),
        }))
      },

      markTriggered: (taskId, at) => {
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId && (task.lastRunAt ?? 0) < at ? { ...task, lastRunAt: at } : task,
          ),
        }))
      },

      enqueueRun: (taskId, trigger) => {
        const state = get()
        const task = state.tasks.find((item) => item.id === taskId)
        if (!task) return null
        if (!task.prompt.trim()) return null
        // 同一任务串行：已有排队/执行中则跳过本次触发
        if (state.queue.some((item) => item.taskId === taskId)) return null

        const startedAt = Date.now()
        // 后台会话：不抢占用户当前视图，消息落库后可在侧边栏点进去复盘
        const sessionId = useChatStore.getState().createSession({
          activate: false,
          title: task.name,
          workingDir: task.workingDir,
        })
        const run: ScheduledTaskRun = {
          id: createId('run'),
          taskId: task.id,
          taskName: task.name,
          sessionId,
          status: 'running',
          trigger,
          startedAt,
        }
        const queued: QueuedTaskRun = {
          runId: run.id,
          taskId: task.id,
          taskName: task.name,
          sessionId,
          prompt: task.prompt,
          workingDir: task.workingDir,
          model: task.model ?? null,
        }
        set((prev) => ({
          runs: [run, ...prev.runs].slice(0, MAX_RUN_RECORDS),
          queue: [...prev.queue, queued],
          tasks: prev.tasks.map((item) => (item.id === taskId ? { ...item, lastRunAt: startedAt } : item)),
        }))
        return run.id
      },

      finishRun: (runId, status, error, note, summary) => {
        set((state) => ({
          runs: state.runs.map((run) =>
            run.id === runId ? { ...run, status, finishedAt: Date.now(), error, note, summary } : run,
          ),
          // 队首完成 → 队列前移，下一个任务由 TaskRunHost 接管
          queue: state.queue.filter((item) => item.runId !== runId),
        }))
      },

      clearRuns: () => set({ runs: [] }),
    }),
    {
      name: 'clerkbox-scheduled-tasks',
      storage: sharedStorage,
      version: 1,
      partialize: (state) => ({
        tasks: state.tasks,
        runs: state.runs,
        keepAwake: state.keepAwake,
        proposalDecisions: state.proposalDecisions,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<ScheduledTasksState>
        const tasks = Array.isArray(stored.tasks) ? stored.tasks : []
        // 上次运行未收尾的记录（应用退出/崩溃）统一标记为「已中断」，避免永久挂在运行中
        const runs = (Array.isArray(stored.runs) ? stored.runs : []).map((run) =>
          run.status === 'running'
            ? {
                ...run,
                status: 'failed' as TaskRunStatus,
                note: 'interrupted' as TaskRunNote,
                finishedAt: run.finishedAt ?? Date.now(),
              }
            : run,
        )
        return {
          ...current,
          tasks,
          runs,
          keepAwake: stored.keepAwake === true,
          // 队列与提案列表是内存态：提案本体在独立 KV key，水合后由心跳/订阅重读
          queue: [],
          proposals: [],
          proposalDecisions: pruneProposalDecisions(
            (stored.proposalDecisions ?? {}) as Record<string, ProposalDecisionRecord>,
            Date.now(),
          ),
        }
      },
    },
  ),
)

/** 提案刷新间隔（拍）：一次刷新要读整份 KV 文件，不必跟着 20s 心跳跑 */
const PROPOSAL_REFRESH_EVERY_TICKS = 3
let scheduleTickCount = 0

/** 心跳：到点检查 + 入队。落后超过容差窗口只抬高水位线（不补跑历史任务） */
function runScheduleTick(): void {
  const store = useScheduledTasksStore.getState()
  const now = Date.now()
  for (const task of store.tasks) {
    if (!task.enabled || !task.prompt.trim()) continue
    const due = previousTriggerAt(task.schedule, now)
    if (due === null) continue
    if ((task.lastRunAt ?? 0) >= due) continue
    if (now - due > TRIGGER_TOLERANCE_MS) {
      store.markTriggered(task.id, due)
      continue
    }
    store.enqueueRun(task.id, 'schedule')
  }
  reconcileStuckHeadRun()
  // 提案由另一个进程（宿主模式的工具）或另一个窗口写入，跨进程没有推送可用，靠这里定期重读
  scheduleTickCount += 1
  if (scheduleTickCount % PROPOSAL_REFRESH_EVERY_TICKS === 0) void store.refreshProposals()
}

/**
 * 看门狗兜底：队首执行若已无任何会话活动（streaming 已停、状态也不是 working），
 * 说明执行宿主没能正常收尾（组件被卸载、热更新、异常路径等），
 * 补一条终态记录，避免执行记录永久停在「运行中」。
 *
 * 排队中的执行不参与判定；等待工具确认 / 等待用户回答的执行仍处于 streaming，
 * 也不会被误判。
 */
function reconcileStuckHeadRun(): void {
  const store = useScheduledTasksStore.getState()
  const head = store.queue[0]
  if (!head) return
  const run = store.runs.find((item) => item.id === head.runId)
  if (!run || run.status !== 'running' || !run.sessionId) return
  // 刚启动不久的执行处于「会话已建、还没开始流式」的空窗期，给它宽限
  if (Date.now() - run.startedAt < STUCK_RUN_GRACE_MS) return
  const chat = useChatStore.getState()
  if (chat.streamingSessionIds.has(run.sessionId)) return
  if (chat.sessionStatus[run.sessionId] === 'working') return
  const session = chat.sessions.find((s) => s.id === run.sessionId)
  const summary = session ? summarizeAssistantReply(session.messages) : undefined
  store.finishRun(run.id, summary ? 'success' : 'aborted', undefined, undefined, summary)
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null

/** 手动触发一次到点检查（页面「刷新」按钮用）：与心跳逻辑完全一致 */
export function checkScheduledTasksNow(): void {
  runScheduleTick()
  void useScheduledTasksStore.getState().refreshProposals()
}

/**
 * 启动调度器：幂等，返回清理函数。
 * 水合完成后立即补一次 tick（应用启动时若刚好落在触发窗口内则照常执行）。
 */
export function initScheduledTasks(): () => void {
  if (!schedulerTimer) {
    schedulerTimer = setInterval(runScheduleTick, TICK_INTERVAL_MS)
  }
  const applyKeepAwake = () => {
    const { keepAwake } = useScheduledTasksStore.getState()
    void ipc.setKeepAwake(keepAwake).catch(() => {
      /* WebUI 等环境不支持时静默忽略 */
    })
  }
  applyKeepAwake()
  const onHydrated = () => {
    applyKeepAwake()
    runScheduleTick()
    // 裁决留痕要水合完才准，否则第一次刷新会把已确认过的提案重新列出来
    void useScheduledTasksStore.getState().refreshProposals()
  }
  const unsub = useScheduledTasksStore.persist.onFinishHydration(onHydrated)
  if (useScheduledTasksStore.persist.hasHydrated()) onHydrated()
  // 同进程提交提案（渲染层跑循环时的工具调用）即时刷新；跨进程靠心跳
  const unsubProposals = onProposalsChanged(() => {
    void useScheduledTasksStore.getState().refreshProposals()
  })

  return () => {
    unsub()
    unsubProposals()
    if (schedulerTimer) {
      clearInterval(schedulerTimer)
      schedulerTimer = null
    }
  }
}

