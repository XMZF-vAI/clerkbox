import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpDown,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  FolderOpen,
  Info,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useScheduledTasksStore, checkScheduledTasksNow } from '../../stores/scheduled-tasks-store'
import { useChatStore, getSessionAbortController } from '../../stores/chat-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useUIStore } from '../../stores/ui-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import {
  WEEKDAY_KEYS,
  formatDuration,
  formatMoment,
  nextTriggerAt,
  scheduleLabelText,
} from '../../lib/scheduled-task'
import HostFolderPicker from '../ui/HostFolderPicker'
import ConfirmDialog from '../ui/ConfirmDialog'
import type {
  ScheduledTask,
  ScheduledTaskDraft,
  ScheduledTaskRun,
  TaskModelOverride,
  TaskScheduleKind,
} from '../../types/scheduled-task'

/**
 * 定时任务页：仿 QoderWork「定时任务」界面，整屏替换聊天区（与 SkillStore 同形态）。
 *
 * 结构：顶部标题 + 提示条（保持唤醒开关） + 「我的定时任务 / 执行记录」两个 Tab。
 * 创建/编辑弹窗：名称、计划时间（每天/工作日/每周/每月 + 时刻）、任务内容、
 * 工作目录、模型覆盖。执行由全局 TaskRunHost 接管（见 App.tsx）。
 */

type TaskSortMode = 'createdDesc' | 'createdAsc' | 'name' | 'nextRun'
type RunRangeMode = 'day' | 'week' | 'month'
type EditorTarget = { mode: 'create' } | { mode: 'edit'; task: ScheduledTask }

/** 状态徽标配色（成功=绿 / 失败=红 / 中断=琥珀 / 运行中=主色） */
const RUN_STATUS_STYLE: Record<string, { className: string; icon: typeof CheckCircle2 }> = {
  running: { className: 'bg-md-primary/15 text-md-primary', icon: Loader2 },
  success: { className: 'bg-md-success/15 text-md-success', icon: CheckCircle2 },
  failed: { className: 'bg-md-error/15 text-md-error', icon: XCircle },
  aborted: { className: 'bg-md-warning/15 text-md-warning', icon: AlertTriangle },
}

/** 汇总当前任务正在执行 / 排队中的运行，卡片据此显示「停止」并禁用重复触发 */
function useRunningByTask(): Record<string, { runId: string; sessionId?: string }> {
  const queue = useScheduledTasksStore((s) => s.queue)
  const runs = useScheduledTasksStore((s) => s.runs)
  return useMemo(() => {
    const map: Record<string, { runId: string; sessionId?: string }> = {}
    for (const item of queue) {
      const run = runs.find((r) => r.id === item.runId)
      map[item.taskId] = { runId: item.runId, sessionId: run?.sessionId }
    }
    return map
  }, [queue, runs])
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`w-9 h-5 rounded-full relative transition-colors flex-shrink-0 ${checked ? 'bg-md-primary' : 'bg-dark-onSurfaceVariant/25'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}

function Select({
  value,
  onChange,
  options,
  ariaLabel,
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
  ariaLabel: string
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className="w-full appearance-none pl-3 pr-8 py-2 rounded-md3-md border border-dark-onSurfaceVariant/15 bg-dark-surfaceContainer text-sm text-dark-onSurface outline-none focus:border-md-primary/50 cursor-pointer"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={14}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-dark-onSurfaceVariant/60 pointer-events-none"
      />
    </div>
  )
}

function EmptyState({ icon: Icon, title, hint }: { icon: typeof Clock; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="w-16 h-16 rounded-md3-lg bg-dark-surfaceContainerHigh flex items-center justify-center">
        <Icon size={26} className="text-dark-onSurfaceVariant/50" />
      </div>
      <p className="mt-4 text-base text-dark-onSurfaceVariant">{title}</p>
      <p className="mt-1 text-sm text-dark-onSurfaceVariant/50">{hint}</p>
    </div>
  )
}


// ── 任务编辑弹窗 ─────────────────────────────────────────────────────────────

function TaskEditorModal({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const { t } = useTranslation()
  const task = target.mode === 'edit' ? target.task : null
  const addTask = useScheduledTasksStore((s) => s.addTask)
  const updateTask = useScheduledTasksStore((s) => s.updateTask)

  const [name, setName] = useState(task?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [kind, setKind] = useState<TaskScheduleKind>(task?.schedule.kind ?? 'daily')
  const [timeValue, setTimeValue] = useState(
    task ? `${String(task.schedule.hour).padStart(2, '0')}:${String(task.schedule.minute).padStart(2, '0')}` : '09:00',
  )
  const [weekday, setWeekday] = useState(task?.schedule.weekday ?? 1)
  const [monthDay, setMonthDay] = useState(task?.schedule.monthDay ?? 1)
  const [workingDir, setWorkingDir] = useState<string | undefined>(task?.workingDir)
  const [modelKey, setModelKey] = useState(task?.model ? `${task.model.providerId}|${task.model.modelId}` : '')
  const [pickingFolder, setPickingFolder] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  // 模型选项：Auto（跟随全局）+ 各提供商已启用模型
  const providers = useSettingsStore((s) => s.providers)
  const modelOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [
      { value: '', label: t('scheduledTasks.editor.modelAuto') },
    ]
    for (const provider of providers) {
      for (const model of provider.models) {
        opts.push({ value: `${provider.id}|${model.id}`, label: `${provider.name} · ${model.label || model.id}` })
      }
    }
    return opts
  }, [providers, t])

  const canSave = name.trim().length > 0 && prompt.trim().length > 0

  // 原生目录选择：WebUI 无原生对话框（返回 null）→ 降级为宿主目录浏览器
  const handlePickFolder = async () => {
    const dir = await ipc.selectFolder().catch(() => null)
    if (dir) setWorkingDir(dir)
    else if (isWebUIMode) setPickingFolder(true)
  }


  const handleSave = () => {
    setSubmitted(true)
    if (!canSave) return
    const [h, m] = timeValue.split(':').map((v) => Number.parseInt(v, 10))
    const schedule = {
      kind,
      hour: Number.isFinite(h) ? h : 9,
      minute: Number.isFinite(m) ? m : 0,
      ...(kind === 'weekly' ? { weekday } : {}),
      ...(kind === 'monthly' ? { monthDay } : {}),
    }
    let model: TaskModelOverride | null = null
    if (modelKey) {
      const [providerId, modelId] = modelKey.split('|')
      model = providerId && modelId ? { providerId, modelId } : null
    }
    const draft: ScheduledTaskDraft = {
      name: name.trim(),
      prompt,
      schedule,
      workingDir,
      model,
      enabled: task?.enabled ?? true,
    }
    if (task) updateTask(task.id, draft)
    else addTask(draft)
    onClose()
  }

  const inputClass =
    'w-full px-3 py-2 rounded-md3-md border border-dark-onSurfaceVariant/15 bg-dark-surfaceContainer text-sm text-dark-onSurface placeholder:text-dark-onSurfaceVariant/40 outline-none focus:border-md-primary/50'

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 animate-fade-in" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={task ? t('scheduledTasks.editor.titleEdit') : t('scheduledTasks.editor.titleNew')}
        onClick={(e) => e.stopPropagation()}
        className="w-[560px] max-w-full max-h-[88vh] overflow-y-auto rounded-md3-xl bg-dark-surfaceDim border border-dark-onSurfaceVariant/10 p-6 shadow-elevation-3"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-dark-onSurface">
              {task ? t('scheduledTasks.editor.titleEdit') : t('scheduledTasks.editor.titleNew')}
            </h2>
            <p className="mt-1 text-sm text-dark-onSurfaceVariant/70">{t('scheduledTasks.editor.desc')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh"
            aria-label={t('common.close')}
          >
            <X size={17} />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <label className="block text-sm text-dark-onSurfaceVariant mb-1.5" htmlFor="task-name">
              {t('scheduledTasks.editor.nameLabel')}
            </label>
            <input
              id="task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('scheduledTasks.editor.namePlaceholder')}
              className={inputClass}
            />
          </div>


          <div>
            <span className="block text-sm text-dark-onSurfaceVariant mb-1.5">
              {t('scheduledTasks.editor.scheduleLabel')}
            </span>
            <div className="flex flex-wrap gap-2">
              <Select
                value={kind}
                onChange={(v) => setKind(v as TaskScheduleKind)}
                ariaLabel={t('scheduledTasks.editor.scheduleLabel')}
                options={[
                  { value: 'daily', label: t('scheduledTasks.editor.kindDaily') },
                  { value: 'weekdays', label: t('scheduledTasks.editor.kindWeekdays') },
                  { value: 'weekly', label: t('scheduledTasks.editor.kindWeekly') },
                  { value: 'monthly', label: t('scheduledTasks.editor.kindMonthly') },
                ]}
                className="w-32 flex-shrink-0"
              />
              {kind === 'weekly' && (
                <Select
                  value={String(weekday)}
                  onChange={(v) => setWeekday(Number(v))}
                  ariaLabel={t('scheduledTasks.editor.weekdayLabel')}
                  options={WEEKDAY_KEYS.map((key, index) => ({
                    value: String(index),
                    label: t(`scheduledTasks.weekday.${key}`),
                  }))}
                  className="w-28 flex-shrink-0"
                />
              )}
              {kind === 'monthly' && (
                <Select
                  value={String(monthDay)}
                  onChange={(v) => setMonthDay(Number(v))}
                  ariaLabel={t('scheduledTasks.editor.monthDayLabel')}
                  options={Array.from({ length: 28 }, (_, i) => ({
                    value: String(i + 1),
                    label: t('scheduledTasks.editor.monthDayOption', { day: i + 1 }),
                  }))}
                  className="w-32 flex-shrink-0"
                />
              )}
              <input
                type="time"
                value={timeValue}
                onChange={(e) => setTimeValue(e.target.value)}
                aria-label={t('scheduledTasks.editor.timeLabel')}
                className={`${inputClass} w-32 flex-shrink-0`}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-dark-onSurfaceVariant mb-1.5" htmlFor="task-prompt">
              {t('scheduledTasks.editor.promptLabel')}
            </label>
            <textarea
              id="task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('scheduledTasks.editor.promptPlaceholder')}
              rows={6}
              className={`${inputClass} resize-y leading-relaxed`}
            />
          </div>


          <div>
            <span className="block text-sm text-dark-onSurfaceVariant mb-1.5">
              {t('scheduledTasks.editor.workDirLabel')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handlePickFolder()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer text-sm text-dark-onSurface transition-colors flex-shrink-0"
              >
                <FolderOpen size={15} />
                <span>{t('scheduledTasks.editor.workDirPick')}</span>
              </button>
              {workingDir ? (
                <>
                  <code className="flex-1 min-w-0 truncate text-xs text-dark-onSurfaceVariant/70" title={workingDir}>
                    {workingDir}
                  </code>
                  <button
                    type="button"
                    onClick={() => setWorkingDir(undefined)}
                    className="px-2 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors flex-shrink-0"
                  >
                    {t('scheduledTasks.editor.workDirClear')}
                  </button>
                </>
              ) : (
                <span className="text-xs text-dark-onSurfaceVariant/50">
                  {t('scheduledTasks.editor.workDirNone')}
                </span>
              )}
            </div>
          </div>

          <div>
            <span className="block text-sm text-dark-onSurfaceVariant mb-1.5">
              {t('scheduledTasks.editor.modelLabel')}
            </span>
            <Select
              value={modelKey}
              onChange={setModelKey}
              ariaLabel={t('scheduledTasks.editor.modelLabel')}
              options={modelOptions}
              className="w-72 max-w-full"
            />
          </div>
        </div>

        {submitted && !canSave && (
          <p role="alert" className="mt-3 text-xs text-md-error">
            {t('scheduledTasks.editor.validation')}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md3-md text-sm text-dark-onSurface hover:bg-dark-surfaceContainerHigh transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="px-5 py-2 rounded-md3-md bg-md-primary text-md-onPrimary text-sm font-medium hover:opacity-90 transition-opacity"
          >
            {t('common.save')}
          </button>
        </div>
      </div>

      <HostFolderPicker
        open={pickingFolder}
        onClose={() => setPickingFolder(false)}
        onSelect={(dir) => setWorkingDir(dir)}
        initialPath={workingDir}
      />
    </div>
  )
}


// ── 任务卡片 ─────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  running,
  onToggle,
  onEdit,
  onRun,
  onStop,
  onDuplicate,
  onDelete,
  onViewSession,
}: {
  task: ScheduledTask
  /** 非空 = 该任务有排队/执行中的运行 */
  running?: { runId: string; sessionId?: string }
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onRun: () => void
  onStop: () => void
  onDuplicate: () => void
  onDelete: () => void
  onViewSession: (sessionId: string) => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const nextRun = nextTriggerAt(task.schedule, Date.now())

  const menuItems: Array<{ key: string; label: string; icon: typeof Play; danger?: boolean; action: () => void }> = [
    running
      ? { key: 'stop', label: t('scheduledTasks.menu.stop'), icon: Square, action: onStop }
      : { key: 'run', label: t('scheduledTasks.menu.runNow'), icon: Play, action: onRun },
    { key: 'edit', label: t('scheduledTasks.menu.edit'), icon: Pencil, action: onEdit },
    { key: 'duplicate', label: t('scheduledTasks.menu.duplicate'), icon: Copy, action: onDuplicate },
    { key: 'delete', label: t('scheduledTasks.menu.delete'), icon: Trash2, danger: true, action: onDelete },
  ]

  return (
    <div className="relative rounded-md3-lg border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer p-4 flex flex-col min-h-[170px]">
      <div className="flex items-start justify-between">
        <Toggle checked={task.enabled} onChange={onToggle} label={t('scheduledTasks.enabledAria')} />
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="w-7 h-7 -mr-1 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors"
          aria-label={t('scheduledTasks.moreActions')}
          aria-expanded={menuOpen}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>

      <h3 className="mt-2 text-[15px] font-medium text-dark-onSurface truncate">{task.name}</h3>
      <p className="mt-1 text-xs leading-relaxed text-dark-onSurfaceVariant/70 line-clamp-2 whitespace-pre-line">
        {task.prompt}
      </p>

        {/* 执行中的任务：进度提示 + 查看入口 */}
      {running?.sessionId && (
        <button
          type="button"
          onClick={() => onViewSession(running.sessionId as string)}
          className="mt-2 inline-flex items-center gap-1.5 self-start px-2 py-1 rounded-md3-sm bg-md-primary/10 text-xs text-md-primary hover:bg-md-primary/20 transition-colors"
        >
          <Loader2 size={12} className="animate-spin" />
          <span>{t('scheduledTasks.status.running')}</span>
        </button>
      )}

      <div className="mt-auto pt-3">
        <div className="border-t border-dashed border-dark-onSurfaceVariant/15 pt-2.5 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md3-sm bg-dark-surfaceContainerHigh text-xs text-dark-onSurfaceVariant">
            <Clock size={12} />
            {scheduleLabelText(task.schedule, t)}
          </span>
          {!running && task.enabled && nextRun && (
            <span className="text-[11px] text-dark-onSurfaceVariant/50 truncate">
              {t('scheduledTasks.nextRun', {
                time: t(`scheduledTasks.moment.${formatMoment(nextRun).kind}`, {
                  time: formatMoment(nextRun).time,
                  date: formatMoment(nextRun).date ?? '',
                }),
              })}
            </span>
          )}
        </div>
      </div>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} aria-hidden />
          <div
            role="menu"
            className="absolute right-2 top-9 z-30 w-40 rounded-md3-md bg-dark-surfaceContainerHigh border border-dark-onSurfaceVariant/10 shadow-elevation-3 py-1 animate-fade-in"
          >
            {menuItems.map((item) => {
              const ItemIcon = item.icon
              return (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    item.action()
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-dark-surface ${
                    item.danger ? 'text-md-error' : 'text-dark-onSurface'
                  }`}
                >
                  <ItemIcon size={14} />
                  {item.label}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}


// ── 执行记录行 ───────────────────────────────────────────────────────────────

function RunRow({
  run,
  taskName,
  onViewSession,
  onStop,
}: {
  run: ScheduledTaskRun
  taskName: string
  onViewSession: (sessionId: string) => void
  onStop: (sessionId: string) => void
}) {
  const { t } = useTranslation()
  const style = RUN_STATUS_STYLE[run.status] ?? RUN_STATUS_STYLE.failed
  const StatusIcon = style.icon
  const moment = formatMoment(run.startedAt)
  const duration = run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : undefined

  const statusText = t(`scheduledTasks.status.${run.status}`)

  return (
    <div className="rounded-md3-lg border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer p-4">
      <div className="flex items-start gap-3">
        <span className={`w-7 h-7 mt-0.5 rounded-md3-sm flex items-center justify-center flex-shrink-0 ${style.className}`}>
          <StatusIcon size={15} className={run.status === 'running' ? 'animate-spin' : undefined} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-dark-onSurface truncate">{taskName}</span>
            <span className={`px-1.5 py-0.5 rounded-md3-xs text-[11px] ${style.className}`}>{statusText}</span>
            <span className="px-1.5 py-0.5 rounded-md3-xs text-[11px] bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant/70">
              {t(`scheduledTasks.trigger.${run.trigger}`)}
            </span>
          </div>
          {(run.error || run.note || run.summary) && (
            <p className="mt-1 text-xs text-dark-onSurfaceVariant/60 line-clamp-2">
              {run.error ? run.error : run.note ? t(`scheduledTasks.note.${run.note}`) : run.summary}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className="text-xs text-dark-onSurfaceVariant/60">
            {t(`scheduledTasks.moment.${moment.kind}`, { time: moment.time, date: moment.date ?? '' })}
            {duration ? ` · ${duration}` : ''}
          </span>
          <div className="flex items-center gap-1.5">
            {run.status === 'running' && run.sessionId && (
              <button
                type="button"
                onClick={() => onStop(run.sessionId as string)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md3-sm text-xs text-md-warning hover:bg-dark-surfaceContainerHigh transition-colors"
              >
                <Square size={11} />
                {t('scheduledTasks.runs.stop')}
              </button>
            )}
            {run.sessionId && run.status !== 'running' && (
              <button
                type="button"
                onClick={() => onViewSession(run.sessionId as string)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md3-sm text-xs text-md-primary hover:bg-dark-surfaceContainerHigh transition-colors"
              >
                {t('scheduledTasks.runs.viewSession')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}


// ── 页面 ─────────────────────────────────────────────────────────────────────

export default function ScheduledTasksPage() {
  const { t } = useTranslation()
  const {
    tasks,
    runs,
    keepAwake,
    setKeepAwake,
    setTaskEnabled,
    removeTask,
    duplicateTask,
    enqueueRun,
    clearRuns,
  } = useScheduledTasksStore(
    useShallow((s) => ({
      tasks: s.tasks,
      runs: s.runs,
      keepAwake: s.keepAwake,
      setKeepAwake: s.setKeepAwake,
      setTaskEnabled: s.setTaskEnabled,
      removeTask: s.removeTask,
      duplicateTask: s.duplicateTask,
      enqueueRun: s.enqueueRun,
      clearRuns: s.clearRuns,
    })),
  )
  const runningByTask = useRunningByTask()
  const setShowScheduledTasks = useUIStore((s) => s.setShowScheduledTasks)
  const setActiveSession = useChatStore((s) => s.setActiveSession)

  const [tab, setTab] = useState<'tasks' | 'runs'>('tasks')
  const [sortMode, setSortMode] = useState<TaskSortMode>('createdDesc')
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null)
  const [deletingTask, setDeletingTask] = useState<ScheduledTask | null>(null)
  const [clearingRuns, setClearingRuns] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 执行记录筛选：时间范围 + 任务 + 状态
  const [runRange, setRunRange] = useState<RunRangeMode>('day')
  const [runTaskFilter, setRunTaskFilter] = useState('all')
  const [runStatusFilter, setRunStatusFilter] = useState('all')

  useEffect(() => () => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
  }, [])

  const taskNameOf = (taskId: string): string =>
    tasks.find((task) => task.id === taskId)?.name ?? t('scheduledTasks.runs.deletedTask')

  const sortedTasks = useMemo(() => {
    const list = [...tasks]
    const now = Date.now()
    switch (sortMode) {
      case 'createdAsc':
        return list.sort((a, b) => a.createdAt - b.createdAt)
      case 'name':
        return list.sort((a, b) => a.name.localeCompare(b.name))
      case 'nextRun':
        return list.sort(
          (a, b) => (nextTriggerAt(a.schedule, now) ?? Infinity) - (nextTriggerAt(b.schedule, now) ?? Infinity),
        )
      case 'createdDesc':
      default:
        return list.sort((a, b) => b.createdAt - a.createdAt)
    }
  }, [tasks, sortMode])

  const filteredRuns = useMemo(() => {
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    const from = runRange === 'day' ? now - DAY : runRange === 'week' ? now - 7 * DAY : now - 30 * DAY
    return runs.filter(
      (run) =>
        run.startedAt >= from &&
        (runTaskFilter === 'all' || run.taskId === runTaskFilter) &&
        (runStatusFilter === 'all' || run.status === runStatusFilter),
    )
  }, [runs, runRange, runTaskFilter, runStatusFilter])

  const handleViewSession = (sessionId: string) => {
    setActiveSession(sessionId)
    setShowScheduledTasks(false)
  }

  const handleStopRun = (sessionId: string) => {
    getSessionAbortController(sessionId)?.abort()
  }

  /** 刷新：立即跑一次到点检查（数据本身是实时的，按钮给出明确反馈） */
  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    checkScheduledTasksNow()
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => setRefreshing(false), 600)
  }


  return (
    <div className="relative flex h-full flex-col bg-dark-surface overflow-hidden">
      {/* 顶栏：返回 / 刷新 / 新建 */}
      <header className="flex items-center gap-3 px-5 py-3 border-b border-dark-onSurfaceVariant/10 flex-shrink-0">
        <button
          type="button"
          onClick={() => setShowScheduledTasks(false)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md3-md text-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors"
        >
          <ChevronDown size={15} className="rotate-90" />
          <span>{t('common.back')}</span>
        </button>
        <div className="flex-1 min-w-0" />
        <button
          type="button"
          onClick={handleRefresh}
          className="w-9 h-9 flex items-center justify-center rounded-md3-md text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors"
          aria-label={t('scheduledTasks.refresh')}
          title={t('scheduledTasks.refresh')}
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : undefined} />
        </button>
        <button
          type="button"
          onClick={() => setEditorTarget({ mode: 'create' })}
          className="flex items-center gap-1.5 px-4 py-2 rounded-md3-md bg-dark-onSurface text-dark-surface text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Plus size={16} />
          <span>{t('scheduledTasks.newTask')}</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-10">
        <div className="max-w-5xl mx-auto">
          <h1 className="mt-5 text-2xl font-semibold text-dark-onSurface">{t('scheduledTasks.title')}</h1>
          <p className="mt-1.5 text-sm text-dark-onSurfaceVariant/80">{t('scheduledTasks.subtitle')}</p>

          {/* 唤醒提示条 */}
          <div className="mt-4 flex items-center gap-2.5 rounded-md3-md bg-md-info/10 px-4 py-3">
            <Info size={15} className="text-md-info flex-shrink-0" />
            <span className="flex-1 min-w-0 text-sm text-dark-onSurface/90 truncate">
              {t('scheduledTasks.wakeHint')}
            </span>
            <button
              type="button"
              onClick={() => setKeepAwake(!keepAwake)}
              className="text-sm text-md-info hover:underline flex-shrink-0"
            >
              {t('scheduledTasks.keepAwake')}
            </button>
            <Toggle checked={keepAwake} onChange={setKeepAwake} label={t('scheduledTasks.keepAwake')} />
          </div>

          {/* Tab 行：左侧主 Tab，右侧排序 / 记录筛选 */}
          <div className="mt-6 flex items-end justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-6">
              {(['tasks', 'runs'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`text-lg transition-colors ${
                    tab === key
                      ? 'font-semibold text-dark-onSurface'
                      : 'text-dark-onSurfaceVariant/50 hover:text-dark-onSurfaceVariant'
                  }`}
                >
                  {t(key === 'tasks' ? 'scheduledTasks.tabTasks' : 'scheduledTasks.tabRuns')}
                </button>
              ))}
            </div>


            {tab === 'tasks' ? (
              <Select
                value={sortMode}
                onChange={(v) => setSortMode(v as TaskSortMode)}
                ariaLabel={t('scheduledTasks.sort.createdDesc')}
                options={[
                  { value: 'createdDesc', label: t('scheduledTasks.sort.createdDesc') },
                  { value: 'createdAsc', label: t('scheduledTasks.sort.createdAsc') },
                  { value: 'name', label: t('scheduledTasks.sort.name') },
                  { value: 'nextRun', label: t('scheduledTasks.sort.nextRun') },
                ]}
                className="w-52"
              />
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex rounded-md3-md bg-dark-surfaceContainerHigh p-0.5">
                  {(['day', 'week', 'month'] as const).map((range) => (
                    <button
                      key={range}
                      type="button"
                      onClick={() => setRunRange(range)}
                      className={`px-3 py-1.5 rounded-md3-sm text-xs transition-colors ${
                        runRange === range
                          ? 'bg-dark-surface text-dark-onSurface shadow-sm'
                          : 'text-dark-onSurfaceVariant/70 hover:text-dark-onSurface'
                      }`}
                    >
                      {t(`scheduledTasks.runs.range${range.charAt(0).toUpperCase()}${range.slice(1)}`)}
                    </button>
                  ))}
                </div>
                <Select
                  value={runTaskFilter}
                  onChange={setRunTaskFilter}
                  ariaLabel={t('scheduledTasks.runs.allTasks')}
                  options={[
                    { value: 'all', label: t('scheduledTasks.runs.allTasks') },
                    ...tasks.map((task) => ({ value: task.id, label: task.name })),
                  ]}
                  className="w-40"
                />
                <Select
                  value={runStatusFilter}
                  onChange={setRunStatusFilter}
                  ariaLabel={t('scheduledTasks.runs.allStatus')}
                  options={[
                    { value: 'all', label: t('scheduledTasks.runs.allStatus') },
                    { value: 'running', label: t('scheduledTasks.status.running') },
                    { value: 'success', label: t('scheduledTasks.status.success') },
                    { value: 'failed', label: t('scheduledTasks.status.failed') },
                    { value: 'aborted', label: t('scheduledTasks.status.aborted') },
                  ]}
                  className="w-36"
                />
              </div>
            )}
          </div>


          {/* 内容区 */}
          {tab === 'tasks' ? (
            sortedTasks.length === 0 ? (
              <div className="mt-4 rounded-md3-lg border border-dashed border-dark-onSurfaceVariant/15">
                <EmptyState
                  icon={CalendarClock}
                  title={t('scheduledTasks.taskEmpty')}
                  hint={t('scheduledTasks.taskEmptyHint')}
                />
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                {sortedTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    running={runningByTask[task.id]}
                    onToggle={(enabled) => setTaskEnabled(task.id, enabled)}
                    onEdit={() => setEditorTarget({ mode: 'edit', task })}
                    onRun={() => void enqueueRun(task.id, 'manual')}
                    onStop={() => {
                      const sessionId = runningByTask[task.id]?.sessionId
                      if (sessionId) handleStopRun(sessionId)
                    }}
                    onDuplicate={() => void duplicateTask(task.id)}
                    onDelete={() => setDeletingTask(task)}
                    onViewSession={handleViewSession}
                  />
                ))}
              </div>
            )
          ) : filteredRuns.length === 0 ? (
            <div className="mt-4 rounded-md3-lg border border-dashed border-dark-onSurfaceVariant/15">
              <EmptyState
                icon={Clock}
                title={t('scheduledTasks.runs.empty')}
                hint={t('scheduledTasks.runs.emptyHint')}
              />
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setClearingRuns(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors"
                >
                  <Trash2 size={13} />
                  {t('scheduledTasks.runs.clear')}
                </button>
              </div>
              {filteredRuns.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  taskName={taskNameOf(run.taskId)}
                  onViewSession={handleViewSession}
                  onStop={handleStopRun}
                />
              ))}
            </div>
          )}
        </div>
      </div>


      {/* 弹窗与确认框 */}
      {editorTarget && <TaskEditorModal target={editorTarget} onClose={() => setEditorTarget(null)} />}
      {deletingTask && (
        <ConfirmDialog
          title={t('scheduledTasks.deleteTitle')}
          message={t('scheduledTasks.deleteMessage', { name: deletingTask.name })}
          variant="danger"
          onConfirm={() => {
            removeTask(deletingTask.id)
            setDeletingTask(null)
          }}
          onCancel={() => setDeletingTask(null)}
        />
      )}
      {clearingRuns && (
        <ConfirmDialog
          title={t('scheduledTasks.clearRunsTitle')}
          message={t('scheduledTasks.clearRunsMessage')}
          variant="danger"
          onConfirm={() => {
            clearRuns()
            setClearingRuns(false)
          }}
          onCancel={() => setClearingRuns(false)}
        />
      )}
    </div>
  )
}
