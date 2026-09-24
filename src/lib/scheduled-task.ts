import type { TaskSchedule } from '../types/scheduled-task'

/**
 * 定时任务的时间计算与文案映射。
 *
 * - 触发时刻只做「本地时间」计算（用户写 18:30 就是本机 18:30）
 * - 文案不在这里拼中文：返回 i18n key + 参数，由 UI 层用 t() 翻译（项目 i18n 约定）
 */

/** 星期文案的 i18n key 后缀，下标与 Date.getDay() 对齐（0=周日） */
export const WEEKDAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const

/** 计划摘要的 key（scheduledTasks.schedule.*）+ 插值参数 */
export interface ScheduleLabel {
  key: string
  params: Record<string, string | number>
}

/** 把 0-23 / 0-59 格式化成 HH:mm */
export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 计划摘要：每天 18:30 / 工作日 12:30 / 每周一 10:00 / 每月 1 日 09:00 */
export function scheduleLabel(schedule: TaskSchedule): ScheduleLabel {
  const time = formatClock(schedule.hour, schedule.minute)
  switch (schedule.kind) {
    case 'weekdays':
      return { key: 'scheduledTasks.schedule.weekdays', params: { time } }
    case 'weekly':
      return {
        key: 'scheduledTasks.schedule.weekly',
        // 周几文案本身要翻译 → 由调用方再翻一层（见 scheduleLabelText）
        params: { weekday: WEEKDAY_KEYS[schedule.weekday ?? 1], time },
      }
    case 'monthly':
      return { key: 'scheduledTasks.schedule.monthly', params: { day: schedule.monthDay ?? 1, time } }
    case 'daily':
    default:
      return { key: 'scheduledTasks.schedule.daily', params: { time } }
  }
}

/** 供 UI 层直接取用的计划摘要 key（周几文案已在 UI 层翻译后回填） */
export function scheduleLabelText(
  schedule: TaskSchedule,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const { key, params } = scheduleLabel(schedule)
  const translated: Record<string, string | number> = { ...params }
  if (schedule.kind === 'weekly') {
    translated.weekday = t(`scheduledTasks.weekday.${WEEKDAY_KEYS[schedule.weekday ?? 1]}`)
  }
  return t(key, translated)
}

/** 该日期是否符合计划的「日」约束 */
function matchesDay(schedule: TaskSchedule, date: Date): boolean {
  const day = date.getDay()
  switch (schedule.kind) {
    case 'weekdays':
      return day >= 1 && day <= 5
    case 'weekly':
      return day === (schedule.weekday ?? 1)
    case 'monthly':
      return date.getDate() === (schedule.monthDay ?? 1)
    case 'daily':
    default:
      return true
  }
}

/** 指定日期上的触发时刻（本地时区） */
function triggerOn(date: Date, schedule: TaskSchedule): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    schedule.hour,
    schedule.minute,
    0,
    0,
  ).getTime()
}

/**
 * 最近一次「应当已经触发」的时刻（当天已过时刻则取当天，否则往前找）。
 * 400 天足够覆盖任意月度/周度计划，找不到（非法配置）返回 null。
 */
export function previousTriggerAt(schedule: TaskSchedule, now: number): number | null {
  const base = new Date(now)
  for (let offset = 0; offset <= 400; offset += 1) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset)
    if (!matchesDay(schedule, day)) continue
    const at = triggerOn(day, schedule)
    if (at <= now) return at
  }
  return null
}

/** 下一次触发时刻（用于列表展示「下次运行」） */
export function nextTriggerAt(schedule: TaskSchedule, now: number): number | null {
  const base = new Date(now)
  for (let offset = 0; offset <= 400; offset += 1) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    if (!matchesDay(schedule, day)) continue
    const at = triggerOn(day, schedule)
    if (at > now) return at
  }
  return null
}

/**
 * 触发容差：到点后超出该窗口（例如应用当时没在运行）不补跑，只抬高水位线。
 * 与页面提示条「定时任务仅在电脑保持唤醒时运行」的语义一致。
 */
export const TRIGGER_TOLERANCE_MS = 5 * 60 * 1000

/** 执行耗时：12s / 1m 05s / 1h 02m（语言无关，UI 直接拼单位） */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** 记录/任务时间的紧凑展示：今天 18:30 / 昨天 09:00 / 03-12 10:00 */
export function formatMoment(ms: number, now = Date.now()): { kind: 'today' | 'yesterday' | 'date'; time: string; date?: string } {
  const target = new Date(ms)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const time = formatClock(target.getHours(), target.getMinutes())
  if (ms >= startOfToday) return { kind: 'today', time }
  if (ms >= startOfToday - 24 * 60 * 60 * 1000) return { kind: 'yesterday', time }
  const date = `${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`
  return { kind: 'date', time, date }
}

/** 取最后一条助手回复的摘要（执行记录列表预览用）；无回复返回 undefined */
export function summarizeAssistantReply(
  messages: ReadonlyArray<{ role: string; content: string }>,
  limit = 200,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const text = msg.content.replace(/\s+/g, ' ').trim()
    if (!text) continue
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  }
  return undefined
}
