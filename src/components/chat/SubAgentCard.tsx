import { useEffect, useState } from 'react'
import { Bot, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { useAgentRunsStore } from '../../stores/agent-runs-store'
import { useShallow } from 'zustand/react/shallow'
import type { Message } from '../../types/agent'

interface SubAgentCardProps {
  message: Message  // isSubAgentCard: true 的消息
  sessionId: string
  vibe?: boolean
}

const AGENT_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  blue: { bg: 'bg-md-primary/10', border: 'border-md-primary/30', text: 'text-md-primary', dot: 'bg-md-primary' },
  green: { bg: 'bg-md-success/10', border: 'border-md-success/30', text: 'text-md-success', dot: 'bg-md-success' },
  orange: { bg: 'bg-md-warning/10', border: 'border-md-warning/30', text: 'text-md-warning', dot: 'bg-md-warning' },
  purple: { bg: 'bg-md-tertiary/10', border: 'border-md-tertiary/30', text: 'text-md-tertiary', dot: 'bg-md-tertiary' },
}
const DEFAULT_COLOR = { bg: 'bg-md-primaryContainer', border: 'border-md-primary/30', text: 'text-md-primary', dot: 'bg-md-primary' }

type RunStatus = 'running' | 'completed' | 'failed' | 'aborted'
const STATUS_CONFIG: Record<RunStatus, { icon: React.ReactNode; label: string; labelClass: string }> & { default: { icon: React.ReactNode; label: string; labelClass: string } } = {
  running: { icon: null, label: '运行中', labelClass: '' },
  completed: { icon: <CheckCircle className="h-4 w-4 text-md-success" />, label: '完成', labelClass: 'text-md-success' },
  failed: { icon: <XCircle className="h-4 w-4 text-md-error" />, label: '失败', labelClass: 'text-md-error' },
  aborted: { icon: <XCircle className="h-4 w-4 text-md-onSurfaceVariant" />, label: '已中断', labelClass: 'text-md-onSurfaceVariant' },
  default: { icon: <Loader2 className="h-4 w-4 animate-spin text-md-onSurfaceVariant" />, label: '未知', labelClass: 'text-md-onSurfaceVariant' },
}

export function SubAgentCard({ message, sessionId, vibe }: SubAgentCardProps) {
  // 只订阅卡片需要的字段（status/agentType/agentName/prompt/startedAt/id），
  // 用 useShallow 浅比较：流式期间 run.messages 引用每次都变，但这些字段不变，可跳过重渲染
  const runFields = useAgentRunsStore(useShallow((s) => {
    const r = (s.runsBySession[sessionId] || []).find((r) => r.id === message.subAgentId)
    if (!r) return null
    return {
      id: r.id,
      status: r.status,
      agentType: r.agentType,
      agentName: r.agentName,
      prompt: r.prompt,
      startedAt: r.startedAt,
    }
  }))
  const selectedRunId = useAgentRunsStore((s) => s.selectedRunId)
  const selectRun = useAgentRunsStore((s) => s.selectRun)
  const [elapsed, setElapsed] = useState(0)

  const run = runFields

  // 运行中时计时（必须在 early return 之前调用，遵守 React Hooks 规则）
  useEffect(() => {
    if (!run || run.status !== 'running') return
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - run.startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [run?.status, run?.startedAt])

  if (!run) {
    // run 可能已因会话切换被清除，显示占位
    return (
      <div className={`my-1 rounded-md border p-1.5 text-[11px] ${vibe ? 'liquid-glass-subtle border-white/15 text-white/50' : 'border-md-outlineVariant/30 bg-dark-surfaceContainer/50 text-md-onSurfaceVariant'}`}>
        子 agent 记录已不在
      </div>
    )
  }

  // 根据 agentType 决定颜色（内置 explore=blue, general=green，自定义按 color 字段）
  const colorKey = run.agentType === 'explore' ? 'blue' : run.agentType === 'general' ? 'green' : 'purple'
  const color = AGENT_COLORS[colorKey] || DEFAULT_COLOR

  const isSelected = selectedRunId === run.id
  const baseStatus = STATUS_CONFIG[run.status as RunStatus] || STATUS_CONFIG.default
  // running 状态需要用 agent 颜色，这里覆盖
  const statusConfig = run.status === 'running'
    ? { ...baseStatus, icon: <Loader2 className={`h-3 w-3 animate-spin ${color.text}`} />, labelClass: color.text }
    : baseStatus

  const promptPreview = run.prompt.length > 60 ? run.prompt.slice(0, 60) + '...' : run.prompt

  return (
    <button
      type="button"
      aria-expanded={isSelected}
      aria-label={`子代理 ${run.agentName}，状态：${statusConfig.label}，${isSelected ? '点击关闭详情' : '点击查看干活记录'}`}
      className={`my-1 w-full max-w-full min-w-0 cursor-pointer rounded-md border ${color.border} ${vibe ? 'liquid-glass-subtle' : color.bg} px-2 py-1.5 text-left transition-all hover:border-md-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-md-primary/50 ${isSelected ? 'ring-2 ring-md-primary/50' : ''}`}
      onClick={() => selectRun(isSelected ? null : run.id)}
    >
      <div className="flex items-center gap-1.5">
        {/* agent 类型圆点 */}
        <div className={`h-1.5 w-1.5 rounded-full ${color.dot}`} />
        <Bot className={`h-3 w-3 ${color.text}`} />
        <span className={`text-xs font-medium ${vibe ? 'text-white/90' : 'text-md-onSurface'}`}>{run.agentName}</span>
        <span className={`rounded px-1 py-0 text-[9px] ${color.bg} ${color.text}`}>{run.agentType}</span>
        {/* 状态 */}
        <div className="ml-auto flex items-center gap-1">
          {statusConfig.icon}
          <span className={`text-[10px] ${statusConfig.labelClass}`}>
            {statusConfig.label}
            {run.status === 'running' && elapsed > 0 && ` ${elapsed}s`}
          </span>
        </div>
      </div>
      {/* 任务摘要 */}
      <div className={`mt-0.5 line-clamp-1 text-[10px] ${vibe ? 'text-white/50' : 'text-md-onSurfaceVariant/80'}`}>
        {promptPreview}
      </div>
    </button>
  )
}
