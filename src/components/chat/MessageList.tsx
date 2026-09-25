import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react'
import { ChevronDown, ChevronUp, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import type { Message } from '../../types/agent'
import MessageItem from './MessageItem'
import AgentStatusIndicator from './AgentStatusIndicator'
import {
  VIRTUALIZE_MIN_TURNS,
  VIRTUAL_OVERSCAN,
  distanceToBottomPx,
  estimateStartPx,
  estimateTotalSizePx,
  estimateTurnSizePx,
  findTopVisibleRow,
  isNearBottomDistance,
  selectTurnRows,
  shouldVirtualizeTurns,
  streamingTailIndex,
  turnSizeEstimates,
  withPinnedIndex,
  type RowSpan,
} from '../../lib/message-list-virtual'
import {
  peekSessionScroll,
  rememberSessionScroll,
  resolveScrollRestore,
  type SessionScrollMemory,
} from '../../lib/session-scroll-memory'

interface MessageListProps {
  messages: Message[]
  isStreaming: boolean
  /** 滚动记忆按会话隔离，必须由调用方显式下发（同排组件同一约定） */
  sessionId: string
  vibe?: boolean
}

/** A "turn" = user message + all AI messages until the next user message or end */
export interface Turn {
  userMsg: Message
  aiMessages: Message[]
  turnId: string
}

/** Group messages into turns */
export function groupIntoTurns(messages: Message[]): Turn[] {
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
    // Compact summary message (assistant + isCompactSummary) — also starts its own turn
    if (msg.isCompactSummary) {
      if (currentTurn) {
        turns.push(currentTurn)
        currentTurn = null
      }
      turns.push({ userMsg: msg, aiMessages: [], turnId: msg.id })
      continue
    }
    // 正在压缩上下文占位 —— 独立成 turn，确保压缩过程提示可见
    if (msg._isCompacting) {
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
type TurnPanelProps = { turn: Turn; isLastTurn: boolean; isStreaming: boolean; vibe?: boolean }

function areTurnPanelPropsEqual(previous: TurnPanelProps, next: TurnPanelProps): boolean {
  if (
    previous.isLastTurn !== next.isLastTurn ||
    previous.isStreaming !== next.isStreaming ||
    previous.vibe !== next.vibe ||
    previous.turn.turnId !== next.turn.turnId ||
    previous.turn.userMsg !== next.turn.userMsg ||
    previous.turn.aiMessages.length !== next.turn.aiMessages.length
  ) {
    return false
  }
  // groupIntoTurns creates fresh arrays on each stream update. Compare their
  // message references so completed turns remain memoized.
  return previous.turn.aiMessages.every((message, index) => message === next.turn.aiMessages[index])
}

const TurnPanel = memo(function TurnPanel({ turn, isLastTurn, isStreaming, vibe }: TurnPanelProps) {
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
            type="button"
            onClick={() => setStepsExpanded(!stepsExpanded)}
            aria-expanded={stepsExpanded}
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
                <MessageItem key={msg.id} message={msg} vibe={vibe} isIntermediate />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 流式中或无需折叠时，按自然顺序渲染中间消息 */}
      {(!shouldFold || isActiveTurn) && intermediateMsgs.map((msg) => (
        <MessageItem key={msg.id} message={msg} vibe={vibe} isIntermediate />
      ))}

      {/* 最终回复（含 thinking + content） */}
      {finalMsg && <MessageItem message={finalMsg} vibe={vibe} />}
    </div>
  )
}, areTurnPanelPropsEqual)

/** 挂载时的滚动落点：有记忆按记忆恢复，无记忆（或上次贴底）则看最新消息——与虚拟化前一致 */
function planInitialScroll(
  turns: Turn[],
  sizes: number[],
  memory: SessionScrollMemory | undefined
): { offset: number; atBottom: boolean } {
  const decision = resolveScrollRestore(turns, memory)
  if (decision.kind === 'turn') {
    return { offset: estimateStartPx(sizes, decision.index) + decision.offsetWithinTurn, atBottom: false }
  }
  if (decision.kind === 'offset') {
    return { offset: decision.offset, atBottom: false }
  }
  // 'bottom'：写入时浏览器自然夹到真实底部，同时让虚拟列表首帧就渲染末段行
  return { offset: estimateTotalSizePx(sizes), atBottom: true }
}

/** 行矩形取 DOM 真实值，两条渲染分支同一套口径（行用 data-turn-index 标记，与虚拟库共用） */
function readTopTurnRow(el: HTMLDivElement): { index: number; offsetWithinRow: number } | null {
  const scrollerTop = el.getBoundingClientRect().top
  const spans: RowSpan[] = []
  el.querySelectorAll<HTMLElement>('[data-turn-index]').forEach((node) => {
    const index = Number(node.dataset.turnIndex)
    if (!Number.isInteger(index)) return
    const rect = node.getBoundingClientRect()
    spans.push({ index, top: rect.top - scrollerTop, bottom: rect.bottom - scrollerTop })
  })
  return findTopVisibleRow(spans, 0)
}

/** 记下当前视口所在 turn，切走再切回来时原位恢复 */
function captureScrollMemory(el: HTMLDivElement, turns: Turn[], distance: number): SessionScrollMemory {
  const anchor = readTopTurnRow(el)
  const turn = anchor ? turns[anchor.index] : undefined
  return {
    turnId: turn?.turnId ?? null,
    offsetWithinTurn: anchor?.offsetWithinRow ?? 0,
    offset: el.scrollTop,
    atBottom: isNearBottomDistance(distance),
  }
}

export default function MessageList({ messages, isStreaming, sessionId, vibe }: MessageListProps) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)
  const isNearBottomRef = useRef(true)

  const turns = useMemo(() => groupIntoTurns(messages), [messages])
  const turnSizes = useMemo(() => turnSizeEstimates(turns), [turns])

  const [scrollPlan] = useState(() => planInitialScroll(turns, turnSizes, peekSessionScroll(sessionId)))
  // 用户上翻后置 true：配合 isStreaming 控制悬浮「回到底部」按钮的显隐
  const [awayFromBottom, setAwayFromBottom] = useState(!scrollPlan.atBottom)
  const [virtualized, setVirtualized] = useState(() => turns.length >= VIRTUALIZE_MIN_TURNS)

  const useVirtual = shouldVirtualizeTurns(turns.length, virtualized, !awayFromBottom)

  // 流式中的末行永不回收（打字不被卸载导致闪烁）；未虚拟化时 count=0，虚拟库整体惰性、不写任何 DOM。
  const pinnedRef = useRef<number | null>(null)
  pinnedRef.current = streamingTailIndex(useVirtual ? turns.length : 0, isStreaming)

  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const sizesRef = useRef(turnSizes)
  sizesRef.current = turnSizes

  // getItemKey / estimateSize / rangeExtractor 必须保持恒定身份：它们是虚拟库测量缓存的
  // memo 依赖，每个 token 换一次引用会让整列（可达上千行）重算。
  const getItemKey = useCallback((index: number) => turnsRef.current[index]?.turnId ?? index, [])
  const estimateSize = useCallback((index: number) => sizesRef.current[index] ?? estimateTurnSizePx(1), [])
  const rangeExtractor = useCallback(
    (range: Range) => withPinnedIndex(defaultRangeExtractor(range), range.count, pinnedRef.current),
    []
  )

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: useVirtual ? turns.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    indexAttribute: 'data-turn-index',
    overscan: VIRTUAL_OVERSCAN,
    initialOffset: () => scrollPlan.offset,
  })

  // Only auto-scroll while the user is already near the latest message.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const distance = distanceToBottomPx(el.scrollTop, el.scrollHeight, el.clientHeight)
      isNearBottomRef.current = isNearBottomDistance(distance)
      setAwayFromBottom(!isNearBottomRef.current)
      if (sessionId) rememberSessionScroll(sessionId, captureScrollMemory(el, turnsRef.current, distance))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [sessionId])

  // 滚动落位在布局阶段写入：浏览器绘制前就位，长会话首帧不会先画顶部再跳底。
  const restoredRef = useRef(false)
  useLayoutEffect(() => {
    if (restoredRef.current) return
    const el = scrollRef.current
    if (!el) return
    restoredRef.current = true
    el.scrollTop = scrollPlan.offset
    const distance = distanceToBottomPx(el.scrollTop, el.scrollHeight, el.clientHeight)
    isNearBottomRef.current = isNearBottomDistance(distance)
    setAwayFromBottom(!isNearBottomRef.current)
  }, [scrollPlan])

  const scrollToEnd = useCallback((behavior: 'instant' | 'smooth') => {
    const count = virtualizer.options.count
    if (count > 0) {
      // 末项 + align:'end' 命中库内的「真实 maxScrollOffset」分支，与原 bottomRef.scrollIntoView 等价
      virtualizer.scrollToIndex(count - 1, { align: 'end', behavior })
    } else {
      bottomRef.current?.scrollIntoView({ behavior })
    }
  }, [virtualizer])

  useEffect(() => {
    if (isNearBottomRef.current) {
      // Streaming can update state many times per frame. Coalesce scroll work
      // to one layout pass per animation frame instead of forcing a layout on
      // every token.
      if (scrollRafRef.current !== null) return
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null
        scrollToEnd(isStreaming ? 'instant' : 'smooth')
      })
    }
  }, [messages, isStreaming, scrollToEnd])

  // 达到阈值后只在粘底时切入虚拟化：上翻阅读历史时切换布局会让整列按估算重排、视口跳位。
  useEffect(() => {
    if (virtualized || awayFromBottom) return
    if (turns.length >= VIRTUALIZE_MIN_TURNS) setVirtualized(true)
  }, [virtualized, awayFromBottom, turns.length])

  useEffect(() => () => {
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
  }, [])

  /** 悬浮「回到底部」：滚到底并恢复粘底（随后的 scroll 事件会重新校准 isNearBottomRef） */
  const scrollToBottom = () => {
    isNearBottomRef.current = true
    setAwayFromBottom(false)
    scrollToEnd('smooth')
  }

  if (messages.length === 0) {
    return null
  }

  const lastTurnIndex = turns.length - 1
  const rows = useVirtual ? selectTurnRows(turns, virtualizer.getVirtualItems()) : []

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 pb-6">
        {/* 行距由每行自身的 pt-6 承载（rem，随字号缩放），两条分支共用，切换时总高不变 */}
        <div
          className={useVirtual ? 'relative' : undefined}
          style={useVirtual ? { height: virtualizer.getTotalSize() } : undefined}
        >
          {useVirtual
            ? rows.map(({ turn, row }) => (
                <div
                  key={row.turnId}
                  data-turn-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 right-0 top-0 pt-6"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <TurnPanel
                    turn={turn}
                    isLastTurn={row.index === lastTurnIndex}
                    isStreaming={isStreaming}
                    vibe={vibe}
                  />
                </div>
              ))
            : turns.map((turn, index) => (
                <div key={turn.turnId} data-turn-index={index} className="pt-6">
                  <TurnPanel
                    turn={turn}
                    isLastTurn={index === lastTurnIndex}
                    isStreaming={isStreaming}
                    vibe={vibe}
                  />
                </div>
              ))}
        </div>
        {/* 行间距口径与上方一致：指示器前 24、其后再留 24 + 容器 pb-6，等价改造前 space-y-6 + py-6 */}
        {isStreaming && (
          <div className="pt-6">
            {/* Agent 工作状态指示器：像素网格 + 阶段文案 + 耗时，固定在对话最底部 */}
            <AgentStatusIndicator messages={messages} vibe={vibe} />
          </div>
        )}
        <div ref={bottomRef} className="pt-6" />
      </div>
      {/* 流式期间用户上翻：底部中央悬浮「回到底部」按钮 */}
      {awayFromBottom && isStreaming && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label={t('chat.scrollToBottom')}
          title={t('chat.scrollToBottom')}
          className={`absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full border shadow-elevation-2 transition-colors animate-fade-in ${
            vibe
              ? 'bg-black/60 border-white/15 text-white/80 hover:bg-black/80'
              : 'bg-dark-surfaceContainerHigh border-dark-onSurfaceVariant/15 text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHighest'
          }`}
        >
          <ChevronDown size={16} />
        </button>
      )}
    </div>
  )
}
