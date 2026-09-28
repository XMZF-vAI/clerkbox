/**
 * 定时任务类型定义。
 *
 * 设计要点：
 * - 计划用「周期 + 时刻」的结构化描述表达（而不是 cron 字符串），
 *   既能给出「每天 18:30」这类人类可读标签，也能确定性地算出下一次触发时刻。
 * - 执行记录与任务共用一份持久化（KV），运行状态在应用重启时统一收敛为「已中断」。
 */

/** 计划周期：每天 / 工作日 / 每周某天 / 每月某天 */
export type TaskScheduleKind = 'daily' | 'weekdays' | 'weekly' | 'monthly'

export interface TaskSchedule {
  kind: TaskScheduleKind
  /** 周几（kind=weekly 生效）：0=周日 … 6=周六 */
  weekday?: number
  /** 每月几号（kind=monthly 生效）：1-28（避开月末缺失日期） */
  monthDay?: number
  /** 触发小时：0-23 */
  hour: number
  /** 触发分钟：0-59 */
  minute: number
}

/** 本次执行的触发来源：到点自动 / 用户手动「立即运行」 */
export type TaskRunTrigger = 'schedule' | 'manual'

export type TaskRunStatus = 'running' | 'success' | 'failed' | 'aborted'

/**
 * 机器可读的备注码（UI 按码翻译，避免把中文写进持久化数据）。
 * interrupted = 应用在该次执行结束前退出/崩溃，运行被中断
 */
export type TaskRunNote = 'interrupted'

/** 一次执行的记录 */
export interface ScheduledTaskRun {
  id: string
  taskId: string
  /** 任务名快照：任务被删除/改名后记录仍可读 */
  taskName: string
  /** 执行所在会话 id：点记录可跳进会话查看完整过程 */
  sessionId?: string
  status: TaskRunStatus
  trigger: TaskRunTrigger
  startedAt: number
  finishedAt?: number
  /** 失败原因（模型/网络返回的原文） */
  error?: string
  /** 备注码（如应用关闭导致中断） */
  note?: TaskRunNote
  /** 助手最终回复摘要（列表里预览结果） */
  summary?: string
}

/** 任务的运行模型覆盖；未设置 = 跟随全局当前生效模型 */
export interface TaskModelOverride {
  providerId: string
  modelId: string
}

export interface ScheduledTask {
  id: string
  name: string
  /** 到点发给 AI 的完整指令 */
  prompt: string
  schedule: TaskSchedule
  /** 本次任务的工作目录（不设则用会话默认目录） */
  workingDir?: string
  model?: TaskModelOverride | null
  enabled: boolean
  createdAt: number
  updatedAt: number
  /**
   * 上次触发时间（水位线）：调度器只在「应触发时刻晚于水位线」时才启动任务，
   * 既避免同一时刻重复触发，也让编辑/启用任务后不会立刻回溯触发历史时刻。
   */
  lastRunAt?: number
}

/** 新建/编辑任务时的表单数据 */
export interface ScheduledTaskDraft {
  name: string
  prompt: string
  schedule: TaskSchedule
  workingDir?: string
  model?: TaskModelOverride | null
  enabled: boolean
}

/** 提案要做的动作：新建 / 改内容 / 删除 / 改启用状态 */
export type TaskProposalAction = 'create' | 'update' | 'delete' | 'set_enabled'

/**
 * 智能体提交的任务变更提案，用户在定时任务页确认后才落到任务表。
 *
 * 写入方是提交侧（工具，跑在主进程或渲染层都可能），落点是独立 KV key
 * `clerkbox-scheduled-task-proposals`；裁决结果记在任务 store 里（唯一写者是渲染层）。
 * 两个 key 各自单写，渲染层的整表覆盖不会把新提案冲掉，反之亦然。
 */
export interface ScheduledTaskProposal {
  id: string
  action: TaskProposalAction
  /**
   * create = 完整的新任务内容；update = 只带新内容（名称/提示词/计划，可选工作目录）。
   * update 不改启用状态与模型覆盖，那两项在确认时沿用任务当前值（set_enabled 另有专门的提案）。
   */
  draft?: ScheduledTaskDraft
  /** 目标任务 id（update/delete/set_enabled） */
  taskId?: string
  /** 目标任务名快照：任务随后被删也读得懂这张卡片 */
  taskName?: string
  /** set_enabled 的目标状态 */
  enabled?: boolean
  /** 智能体自述的提交理由（卡片上给用户看） */
  rationale?: string
  /** 提交提案的会话 id：点卡片可回去看上下文 */
  sessionId?: string
  createdAt: number
  /** 过期即从待确认列表消失（用户不理睬时不积累垃圾） */
  expiresAt: number
}

/** 用户对提案的裁决 */
export type TaskProposalDecision = 'accepted' | 'rejected'
