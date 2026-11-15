import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Message } from '../../types/agent'
import { useChatStore } from '../../stores/chat-store'
import { usePermissionStore } from '../../stores/permission-store'
import { useInteractiveStore } from '../../stores/interactive-store'

/*
  AgentStatusIndicator —— Agent 工作状态指示器（像素网格）
  Agent 循环工作期间固定显示在消息列表最底部：
  像素网格波前动画 + shimmer 阶段文案 + 活动消息的真实耗时。
  变体：
    drive — 方形格子，V 形波前向右推进；650ms 周期短于扫掠全程，
            始终有两个波前同时在飞
    dots  — 同款波前，圆点格子
    orbit — 彗星沿网格外圈巡游
  prefers-reduced-motion 时网格冻结为暗态，计时器照常走。
*/

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3)
  const c = i % 3
  return (c + Math.abs(r - 1)) * 90
})

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i)
  return k === -1 ? null : k * 110
})

const PATTERNS = {
  drive: { delays: chevron, dur: 650, round: false },
  dots: { delays: chevron, dur: 650, round: true },
  orbit: { delays: orbit, dur: 950, round: false },
} as const

export type AgentStatusVariant = keyof typeof PATTERNS

function LoaderGrid({
  delays,
  dur,
  round,
  vibe,
}: {
  delays: readonly (number | null)[]
  dur: number
  round: boolean
  vibe?: boolean
}) {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,5px)] gap-[2px]">
      {delays.map((delay, index) => (
        <span
          key={index}
          className={`agent-status-cell size-[5px] ${vibe ? 'bg-white' : 'bg-md-onSurface'} ${round ? 'rounded-full' : 'rounded-[1px]'}`}
          style={{
            opacity: delay === null ? 0.12 : 0.2,
            animation: delay === null ? 'none' : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  )
}

export interface AgentActivity {
  active: boolean
  compacting: boolean
  stopping: boolean
  awaitingPermission: boolean
  awaitingQuestion: boolean
  permissionRequestedAt: number | null
}

/** 两处指示器共用同一份会话状态，等待用户时不再显示为模型思考。 */
export function useAgentActivity(sessionId: string, isStreaming: boolean): AgentActivity {
  const runtime = useChatStore(useShallow((state) => ({
    compacting: state.compactingSessionIds.has(sessionId),
    stopping: state.stoppingSessionIds.has(sessionId),
    confirmDanger: state.sessionStatus[sessionId] === 'confirm-danger',
  })))
  const permission = usePermissionStore(useShallow((state) => {
    const requests = [...(state.bySession[sessionId] ?? []), ...(state.localBySession[sessionId] ?? [])]
    const timestamps = requests.map((request) => request.requestedAt).filter((time) => Number.isFinite(time) && time > 0)
    return {
      awaitingPermission: requests.length > 0,
      permissionRequestedAt: timestamps.length > 0 ? Math.min(...timestamps) : null,
    }
  }))
  const awaitingQuestion = useInteractiveStore((state) => Boolean(state.pendingQuestions[sessionId]))
  const awaitingPermission = runtime.confirmDanger || permission.awaitingPermission
  return {
    active: isStreaming || runtime.compacting || runtime.stopping || awaitingPermission || awaitingQuestion,
    compacting: runtime.compacting,
    stopping: runtime.stopping,
    awaitingPermission,
    awaitingQuestion,
    permissionRequestedAt: permission.permissionRequestedAt,
  }
}

interface AgentPhase {
  key: string
  values?: { name?: string; attempt?: number }
  startedAt: number | null
}

/** 真实运行状态优先；消息只补充当前活动阶段，不沿用历史轮次的瞬态标志。 */
export function resolveAgentPhase(messages: Message[], activity: AgentActivity): AgentPhase {
  if (activity.stopping) return { key: 'chat.stopping', startedAt: null }
  if (activity.compacting) {
    const compacting = [...messages].reverse().find((message) => message._isCompacting)
    return { key: 'chat.compactingContext', startedAt: compacting?.timestamp ?? null }
  }
  if (activity.awaitingPermission) return { key: 'shell.waitingApproval', startedAt: activity.permissionRequestedAt }
  if (activity.awaitingQuestion) return { key: 'shell.waitingAnswer', startedAt: null }
  if (!activity.active) return { key: 'chat.agentWorking', startedAt: null }

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user' && !message.isSubAgentNotice) break
    if (message.subAgentId || message.isSubAgentCard || message.isCompactSummary) continue
    if (message._isCompacting) return { key: 'chat.compactingContext', startedAt: message.timestamp }
    if (message.role !== 'assistant') continue
    if (message._retrying && message._isStreaming) {
      return { key: 'chat.retrying', values: { attempt: message._retrying.attempt }, startedAt: message.timestamp }
    }
    if (message._isStreaming && message.streamingToolCalls?.length) {
      const tool = message.streamingToolCalls[message.streamingToolCalls.length - 1]
      return { key: 'chat.generatingToolCall', values: { name: tool.name }, startedAt: message.timestamp }
    }
    if (message.toolCalls?.length) {
      const completed = new Set(messages.slice(index).flatMap((item) => item.toolResults?.map((result) => result.toolCallId) ?? []))
      const pending = message.toolCalls.find((tool) => !completed.has(tool.id))
      if (pending) return { key: 'chat.agentExecuting', values: { name: pending.name }, startedAt: message.timestamp }
    }
    if (message._isStreaming) {
      return { key: message.content ? 'chat.agentResponding' : 'chat.thinkingInProgress', startedAt: message.timestamp }
    }
    break
  }
  return { key: 'chat.thinkingInProgress', startedAt: null }
}

/** 无可靠起点时不编造耗时；按墙钟计算，后台节流与重新挂载不会累积误差。 */
export function formatAgentElapsed(startedAt: number | null, now: number): string | null {
  if (startedAt === null || !Number.isFinite(startedAt) || startedAt <= 0 || startedAt > now) return null
  const seconds = Math.floor((now - startedAt) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function useElapsed(startedAt: number | null, sessionId: string): string | null {
  const [, refresh] = useState(0)
  useEffect(() => {
    if (formatAgentElapsed(startedAt, Date.now()) === null) return
    const timer = setInterval(() => refresh(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt, sessionId])
  return formatAgentElapsed(startedAt, Date.now())
}

interface AgentStatusIndicatorProps {
  /** 当前会话消息列表，用于推断工作阶段文案 */
  messages: Message[]
  sessionId: string
  activity: AgentActivity
  /** 覆盖自动推断的阶段文案 */
  label?: string
  variant?: AgentStatusVariant
  vibe?: boolean
}

export default function AgentStatusIndicator({
  messages,
  sessionId,
  activity,
  label,
  variant = 'drive',
  vibe,
}: AgentStatusIndicatorProps) {
  const { t } = useTranslation()
  const phase = useMemo(() => resolveAgentPhase(messages, activity), [messages, activity])
  const phaseLabel = label ?? t(phase.key, phase.values)
  const elapsed = useElapsed(phase.startedAt, sessionId)
  const { delays, dur, round } = PATTERNS[variant]

  return (
    <div role="status" className="flex w-fit min-w-0 max-w-full items-center gap-2.5">
      <LoaderGrid delays={delays} dur={dur} round={round} vibe={vibe} />
      <span title={phaseLabel} className={`agent-status-label min-w-0 truncate text-ui-sm font-medium ${vibe ? 'agent-status-label-vibe' : ''}`}>
        {phaseLabel}
      </span>
      {elapsed !== null && (
        <span aria-hidden className={`shrink-0 font-mono text-ui-xs tabular-nums ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/60'}`}>
          {elapsed}
        </span>
      )}
    </div>
  )
}
