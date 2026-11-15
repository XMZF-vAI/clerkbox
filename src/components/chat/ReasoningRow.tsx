/**
 * 思考行（照抄 ZCode components/ai-elements/reasoning.tsx 的层级与措辞）。
 *
 * 收起态：🧠 思考 · 持续了 N 秒（无计时数据 →「持续了几秒」，ZCode 未计时口径）；
 * 流式中收起：🧠 正在思考（扫光）· 思考末行摘要（单行自动滚到最新）；
 * 展开态：左导线 + 纯文本 pre-wrap，max-h-60 滚动吸底。
 * 行本体是内容宽度（self-start），不是满宽横条；chevron 悬停才显现。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ToolShell } from './tool-renderers/ToolShell'
import { getToolCardOpen, setToolCardOpen } from '../../lib/tool-card-state'
import { isThinkingActive } from './stream-rows'
import type { Message } from '../../types/agent'

/** 思考末行摘要：最后一个非空行（ZCode resolveReasoningStreamingSummary 同口径） */
export function resolveStreamingSummary(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? ''
    if (line.length > 0) return line
  }
  return null
}

// 计时起点与完成耗时按消息 id 记住：虚拟行重挂 / 会话切回不丢实测值。
// 历史消息没有计时数据，落 undefined → ZCode 未计时口径「持续了几秒」，不编造秒数。
const TRACK_LIMIT = 300
const starts = new Map<string, number>()
const durations = new Map<string, number>()

function noteStart(id: string): number {
  const existing = starts.get(id)
  if (existing !== undefined) return existing
  if (starts.size >= TRACK_LIMIT) {
    const oldest = starts.keys().next().value
    if (typeof oldest === 'string') starts.delete(oldest)
  }
  const now = Date.now()
  starts.set(id, now)
  return now
}

function noteEnd(id: string): number {
  const start = starts.get(id) ?? Date.now()
  starts.delete(id)
  const seconds = Math.max(1, Math.ceil((Date.now() - start) / 1000))
  if (durations.size >= TRACK_LIMIT) {
    const oldest = durations.keys().next().value
    if (typeof oldest === 'string') durations.delete(oldest)
  }
  durations.set(id, seconds)
  return seconds
}

/** 单测用 */
export function resetReasoningTrackForTests(): void {
  starts.clear()
  durations.clear()
}

const BOTTOM_LOCK_PX = 2

export function ReasoningRow({ message, vibe }: { message: Message; vibe?: boolean }) {
  const { t } = useTranslation()
  const text = message.thinkingContent ?? ''
  const active = isThinkingActive(message)
  const stateKey = `reasoning:${message.id}`
  const detailId = useId()
  const [open, setOpen] = useState(() => getToolCardOpen(stateKey) ?? false)
  const [duration, setDuration] = useState<number | undefined>(() => durations.get(message.id))

  // 计时：流式开始记起点（重挂续用同一起点），结束算秒数；展开时才每秒补算
  useEffect(() => {
    if (!active) {
      if (starts.has(message.id)) setDuration(noteEnd(message.id))
      return
    }
    const start = noteStart(message.id)
    if (!open) return
    const tick = () => setDuration(Math.max(1, Math.ceil((Date.now() - start) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [active, open, message.id])

  const toggle = () => {
    const next = !open
    setOpen(next)
    setToolCardOpen(stateKey, next, { userAction: true })
  }

  // 流式摘要视口：内容增长后推到末尾，让最新 token 可见（ZCode 同款单行滚动）
  const summary = active && !open ? resolveStreamingSummary(text) : null
  const summaryRef = useRef<HTMLSpanElement | null>(null)
  const [summaryOverflow, setSummaryOverflow] = useState(false)
  useEffect(() => {
    const viewport = summaryRef.current
    if (!viewport || !summary) return
    viewport.scrollLeft = viewport.scrollWidth
    setSummaryOverflow(viewport.scrollWidth > viewport.clientWidth + 1)
  }, [summary])

  // 展开正文吸底：用户离底后暂停跟随，滚回底部恢复（ZCode ReasoningContent 口径）
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)
  useEffect(() => {
    if (!open) {
      followRef.current = true
      return
    }
    const el = scrollRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [text, open])

  const dim = vibe ? 'text-white/75' : 'text-dark-onSurfaceVariant'
  const guide = vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={detailId}
        className={`md-focus group/reasoning inline-flex max-w-full min-w-0 items-center gap-2 self-start rounded-md3-xs py-1 text-left text-ui-sm transition-colors duration-100 max-md:min-h-11 ${dim}`}
      >
        <Brain size={16} className="shrink-0" />
        <span className="shrink-0 whitespace-nowrap">
          {active && !open ? (
            <span className="thinking-shimmer font-medium">{t('chat.reasoning.thinking')}</span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <span className="font-medium">{t('chat.reasoning.thought')}</span>
              <span aria-hidden>·</span>
              <span>
                {duration === undefined
                  ? t('chat.reasoning.durationFewSeconds')
                  : t('chat.reasoning.durationSeconds', { seconds: duration })}
              </span>
            </span>
          )}
        </span>
        {summary && (
          <>
            <span className="shrink-0" aria-hidden>·</span>
            <span
              ref={summaryRef}
              className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/80'}`}
              style={summaryOverflow ? {
                WebkitMaskImage: 'linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)',
                maskImage: 'linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)',
              } : undefined}
            >
              {summary}
            </span>
          </>
        )}
        <ChevronRight
          size={16}
          className={`stream-row-chevron shrink-0 transition-all duration-200 ${open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover/reasoning:opacity-100 group-focus-visible/reasoning:opacity-100'}`}
        />
      </button>
      <ToolShell open={open} id={detailId}>
        <div className="pt-3">
          <div
            ref={scrollRef}
            onScroll={() => {
              const el = scrollRef.current
              if (!el) return
              followRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= BOTTOM_LOCK_PX
            }}
            tabIndex={open ? 0 : -1}
            className={`md-focus ml-2 max-h-60 overflow-auto border-l pl-3.5 text-ui-sm leading-relaxed ${guide} ${dim}`}
          >
            <div className="min-w-0 whitespace-pre-wrap break-words">{text}</div>
          </div>
        </div>
      </ToolShell>
    </div>
  )
}
