import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Target, Check, X, AlertTriangle, Loader2, CircleX } from 'lucide-react'
import { useGoalStore } from '../../stores/goal-store'

/**
 * /goal 会话级目标的常驻状态条：
 * - active：目标条件 + 已评估次数 + 已用时 + 最近评估理由 + 停止按钮
 * - achieved / failed：终态结论 + 清除按钮
 * 目标由 agent 循环收尾的独立评估器驱动推进（见 use-agent.ts），此处纯展示。
 */
export default function GoalBanner({ sessionId, vibe = false }: { sessionId: string; vibe?: boolean }) {
  const { t } = useTranslation()
  const goal = useGoalStore((state) => state.bySession[sessionId])
  const clearGoal = useGoalStore((state) => state.clearGoal)
  // 已用时展示用的时钟（仅 active 时每 30s 跳一次）
  const [, setClockTick] = useState(0)

  useEffect(() => {
    if (!goal || goal.status !== 'active') return
    const timer = setInterval(() => setClockTick((v) => v + 1), 30_000)
    return () => clearInterval(timer)
  }, [goal?.status])

  if (!goal) return null

  const isActive = goal.status === 'active'
  const elapsedMin = Math.max(1, Math.round((Date.now() - goal.createdAt) / 60_000))

  const stateMeta = isActive
    ? {
        icon: Target,
        iconCls: vibe ? 'text-white/80' : 'text-md-tertiary',
        pill: t('goal.active'),
        pillCls: vibe ? 'bg-white/15 text-white/85' : 'bg-md-tertiary/15 text-md-tertiary',
        boxCls: vibe
          ? 'border-white/20 bg-white/10 text-white'
          : 'border-md-tertiary/25 bg-md-tertiary/10 text-dark-onSurface',
      }
    : goal.status === 'achieved'
      ? {
          icon: Check,
          iconCls: vibe ? 'text-emerald-300' : 'text-md-success',
          pill: t('goal.achieved'),
          pillCls: vibe ? 'bg-emerald-400/20 text-emerald-200' : 'bg-md-success/15 text-md-success',
          boxCls: vibe
            ? 'border-emerald-300/25 bg-emerald-400/10 text-white'
            : 'border-md-success/25 bg-md-success/10 text-dark-onSurface',
        }
      : {
          icon: AlertTriangle,
          iconCls: vibe ? 'text-amber-300' : 'text-md-error',
          pill: t('goal.failed'),
          pillCls: vibe ? 'bg-amber-400/20 text-amber-200' : 'bg-md-error/15 text-md-error',
          boxCls: vibe
            ? 'border-amber-300/25 bg-amber-400/10 text-white'
            : 'border-md-error/25 bg-md-error/10 text-dark-onSurface',
        }
  const StateIcon = stateMeta.icon

  return (
    <section
      className={`mx-4 mb-3 animate-slide-up rounded-md3-md border px-4 py-3 ${stateMeta.boxCls}`}
      aria-label={t('goal.title')}
    >
      <div className="flex items-start gap-2.5">
        <StateIcon size={16} className={`mt-0.5 flex-shrink-0 ${stateMeta.iconCls}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t('goal.title')}</span>
            <span className={`rounded-md3-sm px-1.5 py-0.5 text-[11px] font-medium ${stateMeta.pillCls}`}>
              {stateMeta.pill}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-sm opacity-90 break-words">{goal.condition}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] opacity-60">
            <span>{t('goal.evaluations', { count: goal.evaluations })}</span>
            {isActive && <span>{t('goal.elapsed', { count: elapsedMin })}</span>}
            {isActive && goal.lastReason && (
              <span className="max-w-full truncate" title={goal.lastReason}>
                {t('goal.lastCheck', { reason: goal.lastReason })}
              </span>
            )}
            {!isActive && goal.conclusion && (
              <span className="max-w-full truncate" title={goal.conclusion}>
                {goal.conclusion}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => clearGoal(sessionId)}
          title={isActive ? t('goal.stop') : t('goal.dismiss')}
          aria-label={isActive ? t('goal.stop') : t('goal.dismiss')}
          className={`flex-shrink-0 rounded-md3-sm p-1.5 transition-colors ${
            vibe ? 'hover:bg-white/15' : 'hover:bg-dark-surfaceContainer'
          }`}
        >
          {isActive ? <CircleX size={15} className="opacity-60" /> : <X size={15} className="opacity-60" />}
        </button>
      </div>
      {isActive && (
        <div className="mt-1.5 flex items-center gap-1.5 pl-[26px] text-[11px] opacity-50">
          <Loader2 size={11} className="animate-spin" />
          <span>{t('goal.hint')}</span>
        </div>
      )}
    </section>
  )
}
