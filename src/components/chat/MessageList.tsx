import { useEffect, useRef, useState, memo, useMemo } from 'react'
import { ChevronDown, ChevronUp, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Message } from '../../types/agent'
import MessageItem from './MessageItem'
import ThinkingShimmer from './ThinkingShimmer'

interface MessageListProps {
  messages: Message[]
  isStreaming: boolean
  vibe?: boolean
}

/** A "turn" = user message + all AI messages until the next user message or end */
interface Turn {
  userMsg: Message
  aiMessages: Message[]
  turnId: string
}

/** Group messages into turns */
function groupIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  let currentTurn: Turn | null = null

  for (const msg of messages) {
    // Compact boundary message — ends current turn, starts its own "turn"
    if (msg.role === 'system' && msg.isCompactSummary) {
      if (currentTurn) {
        turns.push(currentTurn)
        currentTurn = null
      }
      turns.push({ userMsg: msg, aiMessages: [], turnId: msg.id })
      continue
    }
    // Compact summary message (user + isCompactSummary) — also starts its own turn
    if (msg.role === 'user' && msg.isCompactSummary) {
      if (currentTurn) {
        turns.push(currentTurn)
        currentTurn = null
      }
      turns.push({ userMsg: msg, aiMessages: [], turnId: msg.id })
      continue
    }
    if (msg.role === 'user') {
      // Start a new turn
      if (currentTurn) turns.push(currentTurn)
      currentTurn = { userMsg: msg, aiMessages: [], turnId: msg.id }
    } else if (currentTurn) {
      currentTurn.aiMessages.push(msg)
    }
  }
  if (currentTurn) turns.push(currentTurn)
  return turns
}

/** Check if a message should be collapsible as a step (has tool calls and is not a sub-agent card) */
function isCollapsibleStep(msg: Message): boolean {
  return (
    msg.role === 'assistant' &&
    !msg.isSubAgentCard &&
    !!msg.toolCalls &&
    msg.toolCalls.length > 0
  )
}

/** Count tool calls in a single message (excluding spawn_agent shown as cards) */
function countMsgToolCalls(msg: Message): number {
  return msg.toolCalls?.filter((tc) => tc.name !== 'spawn_agent').length || 0
}

/** Turn panel - 只保留一个回合级折叠按钮：折叠时只显示最终回复，展开时按自然顺序显示所有中间步骤 */
const TurnPanel = memo(function TurnPanel({ turn, isLastTurn, isStreaming, vibe }: { turn: Turn; isLastTurn: boolean; isStreaming: boolean; vibe?: boolean }) {
  const { t } = useTranslation()
  const [stepsExpanded, setStepsExpanded] = useState(false)

  const isActiveTurn = isLastTurn && isStreaming

  // 最后一条 AI 消息 = 最终回复（含 thinking + content）
  const finalMsg = turn.aiMessages.length > 0
    ? turn.aiMessages[turn.aiMessages.length - 1]
    : null

  // 中间消息 = 除最后一条外的所有 AI 消息
  const intermediateMsgs = turn.aiMessages.length > 1
    ? turn.aiMessages.slice(0, -1)
    : []

  // 中间是否有需要折叠的步骤（含 toolCalls 的消息或子 agent 卡片）
  const hasFoldableSteps = intermediateMsgs.some(
    (m) => isCollapsibleStep(m) || m.isSubAgentCard
  )

  // 统计折叠的步骤数（toolCalls + 子 agent 卡片）
  const stepCount = intermediateMsgs.reduce((sum, m) => {
    if (m.isSubAgentCard) return sum + 1
    return sum + countMsgToolCalls(m)
  }, 0)

  // 最后一条自己若也含 toolCalls（还没出总结），不折叠
  const finalHasTools = !!finalMsg?.toolCalls && finalMsg.toolCalls.length > 0

  // 折叠条件：非流式 + 中间有可折叠步骤 + 最终消息已是总结（无工具调用）
  const shouldFold = hasFoldableSteps && !isActiveTurn && !finalHasTools && stepCount > 0

  return (
    <div className="space-y-3">
      {/* User message */}
      <MessageItem message={turn.userMsg} vibe={vibe} />

      {/* 折叠按钮 —— 一个回合只显示一个 */}
      {shouldFold && (
        <div className="pl-2">
          <button
            onClick={() => setStepsExpanded(!stepsExpanded)}
            className={`flex items-center gap-1.5 text-[11px] transition-colors py-1 ${
              vibe
                ? 'text-white/50 hover:text-white/70'
                : 'text-dark-onSurfaceVariant/40 hover:text-dark-onSurfaceVariant/60'
            }`}
          >
            {stepsExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <Wrench size={11} />
            <span>{stepsExpanded ? t('chat.collapseSteps') : t('chat.expandSteps', { count: stepCount })}</span>
          </button>
          {stepsExpanded && (
            <div className={`mt-1 space-y-2 border-l-2 pl-3 ${
              vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/8'
            }`}>
              {intermediateMsgs.map((msg) => (
                <MessageItem key={msg.id} message={msg} vibe={vibe} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 流式中或无需折叠时，按自然顺序渲染中间消息 */}
      {(!shouldFold || isActiveTurn) && intermediateMsgs.map((msg) => (
        <MessageItem key={msg.id} message={msg} vibe={vibe} />
      ))}

      {/* 最终回复（含 thinking + content） */}
      {finalMsg && <MessageItem message={finalMsg} vibe={vibe} />}

      {/* Extra streaming indicator for when no assistant message exists yet */}
      {isActiveTurn && !finalMsg && !turn.userMsg.isCompactSummary && (
        <ThinkingShimmer />
      )}
    </div>
  )
})

export default function MessageList({ messages, isStreaming, vibe }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  // U3: 监听滚动，只有用户位于底部附近时才自动滚动到底部，避免强制拉回。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const THRESHOLD = 100
    const onScroll = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      isNearBottomRef.current = distanceToBottom < THRESHOLD
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: isStreaming ? 'instant' : 'smooth' })
    }
  }, [messages, isStreaming])

  if (messages.length === 0) {
    return null
  }

  const turns = useMemo(() => groupIntoTurns(messages), [messages])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
      {turns.map((turn, index) => (
        <TurnPanel
          key={turn.turnId}
          turn={turn}
          isLastTurn={index === turns.length - 1}
          isStreaming={isStreaming}
          vibe={vibe}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
