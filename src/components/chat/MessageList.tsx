import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react'
import { ChevronDown, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import type { Message } from '../../types/agent'
import { lastRewindableTurnIndex } from '../../lib/rewind'
import MessageItem from './MessageItem'
import AgentStatusIndicator from './AgentStatusIndicator'
import RewindActions from './RewindActions'
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
  type ScrollRestoreDecision,
  type SessionScrollMemory,
} from '../../lib/session-scroll-memory'

interface MessageListProps {
  messages: Message[]
  isStreaming: boolean
  /** 滚动记忆按会话隔离，必须由调用方显式下发（同排组件同一约定） */
  sessionId: string
  vibe?: boolean
  /** 编辑重发：撤回成功后由 ChatPage 用既有的 sendMessage 发新文本 */
  onResend: (content: string, anchor: Message) => void
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

/** 折叠头统计「改了几处文件」用的工具名集合 —— 与 diff chips 的口径一致（能产出 __EDIT_DIFF__ 的那几个） */
const EDIT_TOOL_NAMES = new Set(['search_replace', 'edit_file', 'write_file'])

/** 折叠头的耗时口径：5 秒以内不显示（一轮本来就该几秒，写出来只是噪声） */
function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 5000) return ''
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** 一轮的耗时 = 该轮内所有消息时间戳的跨度；缺时间戳的历史数据按 0 处理，不显示 */
function turnDurationMs(turn: Turn): number {
  let min = turn.userMsg.timestamp
  let max = turn.userMsg.timestamp
  for (const m of turn.aiMessages) {
    if (m.timestamp > max) max = m.timestamp
    if (m.timestamp < min) min = m.timestamp
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0
}

/**
 * 吸顶条的步数：只回扫当前这一轮（遇到上一条用户消息就停）。
 * 不做 useMemo —— 它每 token 随 messages 求值，但一轮的消息数量是个位数到几十，
 * 而整列扫描才是长会话里真正会累积的成本。
 */
function tailTurnStepCount(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role === 'user') break
    if (m.isSubAgentCard) count += 1
    else count += m.toolCalls?.filter((tc) => tc.name !== 'spawn_agent').length ?? 0
  }
  return count
}

/** Turn panel - 只保留一个回合级折叠按钮：折叠时只显示最终回复，展开时按自然顺序显示所有中间步骤 */
type TurnPanelProps = {
  turn: Turn
  isLastTurn: boolean
  isStreaming: boolean
  vibe?: boolean
  sessionId: string
  /** 这一轮是不是「最后一条可撤回的用户消息」——撤回/编辑的唯一合法锚点 */
  canRewindAnchor: boolean
  onResend: (content: string, anchor: Message) => void
}

function areTurnPanelPropsEqual(previous: TurnPanelProps, next: TurnPanelProps): boolean {
  if (
    previous.isLastTurn !== next.isLastTurn ||
    previous.isStreaming !== next.isStreaming ||
    previous.vibe !== next.vibe ||
    previous.sessionId !== next.sessionId ||
    previous.canRewindAnchor !== next.canRewindAnchor ||
    previous.onResend !== next.onResend ||
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

const TurnPanel = memo(function TurnPanel({ turn, isLastTurn, isStreaming, vibe, sessionId, canRewindAnchor, onResend }: TurnPanelProps) {
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

  /**
   * 折叠头上的另外两项：改了几处文件、这一轮跑了多久。
   * 不挂 useMemo —— shouldFold 在活动轮恒为 false，而带 shouldFold 的轮被
   * areTurnPanelPropsEqual 挡在不重渲染那一侧，这两行只在消息数真变了时求值。
   */
  const editCount = intermediateMsgs.reduce(
    (sum, m) => sum + (m.toolCalls?.filter((tc) => EDIT_TOOL_NAMES.has(tc.name)).length ?? 0),
    0,
  )
  const duration = formatTurnDuration(turnDurationMs(turn))

  // 最后一条自己若也含 toolCalls（还没出总结），不折叠
  const finalHasTools = !!finalMsg?.toolCalls && finalMsg.toolCalls.length > 0

  // 折叠条件：非流式 + 中间有可折叠步骤 + 最终消息已是总结（无工具调用）
  const shouldFold = hasFoldableSteps && !isActiveTurn && !finalHasTools && stepCount > 0

  /**
   * 「复制」的复制范围（对标 ZCode：轮尾复制的是整轮，不是最后一段）。
   *
   * 一轮里模型可能分几段说话（边干活边汇报），只复制最后一段会丢掉它前面的说明。
   * 只有一轮确实说了多段时才改语义，单段情形保持「复制这条」的直觉。
   */
  const turnText = useMemo(
    () => turn.aiMessages
      .filter((m) => m.role === 'assistant' && !m.isSubAgentCard && !!m.content.trim())
      .map((m) => m.content.trim())
      .join('\n\n'),
    [turn.aiMessages]
  )
  const mergedIsMoreThanFinal = !!finalMsg && turnText.trim() !== finalMsg.content.trim()

  return (
    <div className="space-y-1.5">
      {/* User message（动作条里的 编辑 / 撤回 / 撤销文件 由 RewindActions 提供，仅最后一轮出现） */}
      <MessageItem
        message={turn.userMsg}
        vibe={vibe}
        extraActions={canRewindAnchor ? (
          <RewindActions
            sessionId={sessionId}
            anchor={turn.userMsg}
            canRewindAnchor={canRewindAnchor}
            isStreaming={isStreaming}
            vibe={vibe}
            onResend={onResend}
          />
        ) : undefined}
      />
      {/* 折叠头 —— 一个回合只显示一个。整行可点（不是左边一小块），
          统计口径直接写在行上：步数 / 改了几处 / 耗时，展开后同一行只翻转箭头。 */}
      {shouldFold && (
        <button
          type="button"
          onClick={() => setStepsExpanded(!stepsExpanded)}
          aria-expanded={stepsExpanded}
          className={`flex h-7 w-full items-center gap-2 rounded-md3-xs px-1.5 text-left text-[12px] transition-colors duration-100 ${
            vibe
              ? 'text-white/60 hover:bg-white/10'
              : 'text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainerHigh/40'
          }`}
        >
          <ChevronDown size={12} className={`shrink-0 transition-transform duration-200 ${stepsExpanded ? '' : '-rotate-90'}`} />
          <Wrench size={12} className="shrink-0 opacity-70" />
          <span className="shrink-0 tabular-nums">{t('chat.stepCount', { count: stepCount })}</span>
          {editCount > 0 && (
            <span className="shrink-0 tabular-nums opacity-70">· {t('chat.stepEdits', { count: editCount })}</span>
          )}
          {duration && <span className="shrink-0 font-mono text-[11px] tabular-nums opacity-60">· {duration}</span>}
        </button>
      )}
      {shouldFold && stepsExpanded && (
        <div className="space-y-1">
          {intermediateMsgs.map((msg) => (
            <MessageItem key={msg.id} message={msg} vibe={vibe} isIntermediate />
          ))}
        </div>
      )}

      {/* 流式中或无需折叠时，按自然顺序渲染中间消息 */}
      {(!shouldFold || isActiveTurn) && intermediateMsgs.map((msg) => (
        <MessageItem key={msg.id} message={msg} vibe={vibe} isIntermediate />
      ))}

      {/* 最终回复（含 thinking + content）；复制按钮在整轮多段时复制整轮 */}
      {finalMsg && (
        <MessageItem
          message={finalMsg}
          vibe={vibe}
          copyText={mergedIsMoreThanFinal ? turnText : undefined}
          copyTitle={mergedIsMoreThanFinal ? t('chat.copyTurn') : undefined}
        />
      )}
    </div>
  )
}, areTurnPanelPropsEqual)

/** 滚动停住多久之后补一次「行锚点」记忆（锚点要读全部行矩形，不能每个 scroll 事件都读） */
const SCROLL_MEMORY_SETTLE_MS = 200

/**
 * 首帧滚动落位：底部与行顶都只认真实 DOM。
 * 早先这里返回的是「估算总高」，而估算口径是 184+72/条（`TURN_BASE_PX`），
 * 带代码块或工具输出的真实 turn 远高于它——写进 scrollTop 后浏览器不会替你夹到底，
 * 于是打开会话停在中间，且非流式时「回到底部」按钮并不出现，用户没有逃生口。
 */
function applyInitialScroll(el: HTMLDivElement, decision: ScrollRestoreDecision, sizes: number[]): void {
  if (decision.kind === 'turn') {
    const row = el.querySelector<HTMLElement>(`[data-turn-index="${decision.index}"]`)
    // 行已在 DOM 里（未虚拟化分支必然如此）：按真实矩形对齐，避免估算坐标与真实坐标两套体系混用
    if (row) {
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top + decision.offsetWithinTurn
      return
    }
    el.scrollTop = estimateStartPx(sizes, decision.index) + decision.offsetWithinTurn
    return
  }
  if (decision.kind === 'offset') {
    el.scrollTop = decision.offset
    return
  }
  el.scrollTop = el.scrollHeight
}

/** 挂载时的滚动落点：有记忆按记忆恢复，无记忆（或上次贴底）则看最新消息——与虚拟化前一致 */
function planInitialScroll(turns: Turn[], memory: SessionScrollMemory | undefined): ScrollRestoreDecision {
  return resolveScrollRestore(turns, memory)
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

/** 虚拟列表首帧要渲染哪一段：那套坐标系由估算行高构成，与真实 DOM 几何无关 */
function estimateOffsetFor(decision: ScrollRestoreDecision, sizes: number[]): number {
  if (decision.kind === 'bottom') return estimateTotalSizePx(sizes)
  if (decision.kind === 'offset') return decision.offset
  return estimateStartPx(sizes, decision.index) + decision.offsetWithinTurn
}

export default function MessageList({ messages, isStreaming, sessionId, vibe, onResend }: MessageListProps) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRafRef = useRef<number | null>(null)
  const isNearBottomRef = useRef(true)

  const turns = useMemo(() => groupIntoTurns(messages), [messages])
  const turnSizes = useMemo(() => turnSizeEstimates(turns), [turns])

  const [scrollPlan] = useState(() => planInitialScroll(turns, peekSessionScroll(sessionId)))
  // 用户上翻后置 true：配合 isStreaming 控制悬浮「回到底部」按钮的显隐
  const [awayFromBottom, setAwayFromBottom] = useState(scrollPlan.kind !== 'bottom')
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
    initialOffset: () => estimateOffsetFor(scrollPlan, sizesRef.current),
  })

  // Only auto-scroll while the user is already near the latest message.
  const memoryRef = useRef<SessionScrollMemory | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const capture = () => captureScrollMemory(el, turnsRef.current, distanceToBottomPx(el.scrollTop, el.scrollHeight, el.clientHeight))
    const onScroll = () => {
      const distance = distanceToBottomPx(el.scrollTop, el.scrollHeight, el.clientHeight)
      isNearBottomRef.current = isNearBottomDistance(distance)
      setAwayFromBottom(!isNearBottomRef.current)
      // 锚点要读每一行的真实矩形（querySelectorAll + 每行一次 getBoundingClientRect），
      // 挂在每个 scroll 事件上等于每帧强制重排一次。改成滚动停住后补锚点，
      // 其间只刷新便宜的 scrollTop / 贴底标记，卸载时拿这份近似值记忆。
      if (!memoryRef.current) memoryRef.current = capture()
      else memoryRef.current = { ...memoryRef.current, offset: el.scrollTop, atBottom: isNearBottomDistance(distance) }
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        settleTimer = null
        memoryRef.current = capture()
      }, SCROLL_MEMORY_SETTLE_MS)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (settleTimer) clearTimeout(settleTimer)
      if (sessionId && memoryRef.current) rememberSessionScroll(sessionId, memoryRef.current)
    }
  }, [sessionId])

  // 滚动落位在布局阶段写入：浏览器绘制前就位，长会话首帧不会先画顶部再跳底。
  const restoredRef = useRef(false)
  useLayoutEffect(() => {
    if (restoredRef.current) return
    const el = scrollRef.current
    if (!el) return
    restoredRef.current = true
    applyInitialScroll(el, scrollPlan, sizesRef.current)
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

// 空对话**也必须渲染这个 flex-1 容器**，不能 return null。
// 它是消息区撑满剩余高度的唯一依据：少了它，整列就没有任何可伸展的元素，
// 输入框会紧跟在顶部那几行后面浮在半空，底下留一大片死区 ——
// 消息越多它越往下走，看起来像「输入框能被人拖着换位置」。
// 空态下面就是没有内容，容器本身不可见，所以视觉上与原来一致。
if (messages.length === 0) {
  return <div className="relative flex-1 min-h-0 flex flex-col" aria-hidden />
}

  const lastTurnIndex = turns.length - 1
  // 撤回/编辑的锚点判定用「最后一条可撤回的用户消息」而不是「最后一个 turn」：
  // 只撤销文件时会在尾部多出一条合成回执 turn，按后者算会让上一轮的两个按钮凭空消失。
  const rewindAnchorIndex = lastRewindableTurnIndex(messages)
  const rewindAnchorId = rewindAnchorIndex >= 0 ? (messages[rewindAnchorIndex]?.id ?? null) : null
  const rows = useVirtual ? selectTurnRows(turns, virtualizer.getVirtualItems()) : []

  // overflow-clip：根自身不可滚，且不再把内层 scroller 的内容高度传播给祖先
  // （传播会让外层 overflow-hidden 祖先也获得假 scrollHeight，bug 换层复发）
  return (
    <div className="relative flex-1 min-h-0 flex flex-col overflow-clip">
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
                    sessionId={sessionId}
                    canRewindAnchor={turn.userMsg.id === rewindAnchorId}
                    onResend={onResend}
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
                    sessionId={sessionId}
                    canRewindAnchor={turn.userMsg.id === rewindAnchorId}
                    onResend={onResend}
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
      {/*
        流式期间用户上翻时，顶部吸一条工作状态 —— 底部那条指示器已经被滚出视口，
        没有它就没有任何进度可读。用 absolute 浮层而不是 sticky：sticky 会进滚动流，
        虚拟列表的行高口径就多算一份。整条只在 isStreaming 期间挂载，
        于是它的耗时计时器和底部那条同起点（各自 mount 时刻起计），不会报两个数。
      */}
      {isStreaming && (
        <div
          aria-hidden={!awayFromBottom}
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2.5 px-4 pb-3 pt-1.5 transition-opacity duration-200 ${
            awayFromBottom ? 'opacity-100' : 'opacity-0'
          } ${vibe ? 'bg-gradient-to-b from-black/60 to-transparent' : 'bg-gradient-to-b from-dark-surface/95 to-transparent'}`}
        >
          <AgentStatusIndicator messages={messages} vibe={vibe} variant="dots" />
          <span className={`font-mono text-[11px] tabular-nums ${vibe ? 'text-white/45' : 'text-dark-onSurfaceVariant/55'}`}>
            {t('chat.stepCount', { count: tailTurnStepCount(messages) })}
          </span>
        </div>
      )}
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
