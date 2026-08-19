import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message } from '../../types/agent'

/*
  AgentStatusIndicator —— Agent 工作状态指示器（像素网格）
  Agent 循环工作期间固定显示在消息列表最底部：
  像素网格波前动画 + shimmer 阶段文案 + 挂载起计的耗时计时器。
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

/** 挂载起计的耗时（100ms 粒度，等宽字体展示） */
function useElapsed(): string {
  const [ds, setDs] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setDs((d) => d + 1), 100)
    return () => clearInterval(t)
  }, [])
  const total = ds / 10
  if (total < 60) return `${total.toFixed(1)}s`
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`
}

/** 由最后一条消息推断 Agent 当前所处阶段，显示对应文案 */
function usePhaseLabel(messages: Message[]): string {
  const { t } = useTranslation()
  return useMemo(() => {
    const last = messages[messages.length - 1]
    if (!last) return t('chat.agentWorking')
    if (last._isCompacting) return t('chat.compactingContext')
    if (last._retrying) return t('chat.retrying', { attempt: last._retrying.attempt })
    if (last.role === 'assistant') {
      const stcs = last.streamingToolCalls
      if (stcs && stcs.length > 0) {
        return t('chat.generatingToolCall', { name: stcs[stcs.length - 1].name })
      }
      if (last.toolCalls && last.toolCalls.length > 0) {
        const done = last.toolResults?.length ?? 0
        if (done < last.toolCalls.length) {
          return t('chat.agentExecuting', { name: last.toolCalls[done]?.name ?? '' })
        }
      }
      if (last._isStreaming && last.content) return t('chat.agentResponding')
    }
    return t('chat.thinkingInProgress')
  }, [messages, t])
}

interface AgentStatusIndicatorProps {
  /** 当前会话消息列表，用于推断工作阶段文案 */
  messages: Message[]
  /** 覆盖自动推断的阶段文案 */
  label?: string
  variant?: AgentStatusVariant
  vibe?: boolean
}

export default function AgentStatusIndicator({
  messages,
  label,
  variant = 'drive',
  vibe,
}: AgentStatusIndicatorProps) {
  const phaseLabel = usePhaseLabel(messages)
  const elapsed = useElapsed()
  const { delays, dur, round } = PATTERNS[variant]

  return (
    <div role="status" className="flex w-fit items-center gap-2.5">
      <LoaderGrid delays={delays} dur={dur} round={round} vibe={vibe} />
      <span className={`agent-status-label text-[13px] font-medium ${vibe ? 'agent-status-label-vibe' : ''}`}>
        {label ?? phaseLabel}
      </span>
      <span className={`font-mono text-[12px] tabular-nums ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/60'}`}>
        {elapsed}
      </span>
    </div>
  )
}
