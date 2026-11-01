/**
 * 对话时间线的底部锚定状态机（纯函数，无 DOM / React 依赖）。
 *
 * 语义（following = 跟随权）：
 * - 用户位于底部 → following=true，新内容（流式增量 / 测高修正）自动贴底；
 * - 用户上滚离底 → following=false，流式增量不得把用户拽回阅读位置；
 * - 用户手动滚回底部 → 恢复跟随。
 *
 * following 表达的是**用户滚动权**，不是瞬时几何快照：只有真实用户输入
 * （滚轮 / 触摸 / 键盘 / 拖滚动条）能改变它。程序化贴底、虚拟库测高补偿
 * 产生的 scroll 事件只更新几何账目，不得夺走用户已经交出的滚动权。
 *
 * 为什么需要它（而不是每帧问一次「离底多远」）：
 * scroll 事件在滚动发生后的**下一渲染帧**才派发。用户上滑之后、事件派发之前，
 * 若恰好落进一个内容变化的 commit（流式 delta、ResizeObserver 测高修正、
 * 输入框尺寸变化引起的重算），贴底逻辑会拿着**过期的 following=true** 把
 * scrollTop 拽回底部 —— 用户的上滑被整体吞掉（表现为「正在读历史，内容却自己跳回最新」）。
 * `reconcileFollowingForContentAnchor` 在贴底动作之前对账用户意图即可避免。
 *
 * 几何计算（离底多远）仍归 `message-list-virtual.ts`，本模块只做裁决：
 * 调用方先把 DOM 读成布尔「是否贴底」再传进来，避免两处阈值口径打架。
 */

/** 滚动来源：只有 user 能改变跟随权。 */
export type TimelineScrollSource = 'user' | 'programmatic' | 'layout'

/**
 * 用户滚动意图。
 * - awayFromBottom：明确在往上读，贴底必须让位；
 * - towardBottom：明确在往下走；
 * - unknown：方向未知（拖滚动条等），按落点判；
 * - none：本次没有任何用户输入。
 */
export type TimelineScrollIntent = 'none' | 'awayFromBottom' | 'towardBottom' | 'unknown'

/**
 * scroll 事件的来源判定。
 *
 * 判定顺序不能反：用户意图优先级最高 —— 用户刚滚过手，程序化滚动标记
 * 与布局保护窗都应让位，否则用户的上滑会被误判成「布局抖动」。
 */
export function classifyScrollSource(input: {
  /** 当前是否存在有效的用户滚动意图（none 视为没有）。 */
  hasUserIntent: boolean
  /** 是否处于程序化滚动（贴底 / 回到底部按钮）产生的 scroll 事件中。 */
  programmaticScrollActive: boolean
  /** 是否处于布局保护窗内（测高补偿 / 折叠 / 输入框尺寸变化引起的滚动）。 */
  withinLayoutGuardWindow: boolean
}): TimelineScrollSource {
  if (input.hasUserIntent) return 'user'
  if (input.programmaticScrollActive) return 'programmatic'
  if (input.withinLayoutGuardWindow) return 'layout'
  return 'user'
}

/**
 * scroll 事件后的跟随态裁决。
 *
 * 规则：只有用户滚动才按落点决定跟随与否；程序化 / 布局滚动保持原值。
 * 用户滚回底部 → atBottom 为 true → 恢复跟随（流式重新自动贴底）。
 */
export function resolveFollowingAfterScroll(input: {
  following: boolean
  /** 落点是否贴着底部（由调用方按既有阈值算出）。 */
  atBottom: boolean
  source: TimelineScrollSource
}): boolean {
  if (input.source !== 'user') return input.following
  return input.atBottom
}

/**
 * 内容变化（新行追加 / 流式 delta 撑高 / 动态测高修正）后的动作：
 * 跟随中 → 贴底；已解除 → 保持阅读位置（绝不拉回）。
 */
export function anchorActionAfterContentChange(
  following: boolean,
  contentWidthChanging: boolean = false,
): 'stickToBottom' | 'hold' {
  return following && !contentWidthChanging ? 'stickToBottom' : 'hold'
}

/**
 * virtualizer 动态测高后的滚动补偿裁决。
 *
 * 宽度 resize 会让多条消息在相邻帧分批测高；此时逐条补偿 scrollTop 会形成可见抖动。
 * 跟随中本来就会贴底，补偿只会和贴底打架，所以不补偿。
 */
export function shouldAdjustVirtualizerForItemSizeChange(input: {
  following: boolean
  /** 会话切换 / 滚动恢复期间禁止一切补偿。 */
  suppressAdjustment: boolean
  contentWidthChanging: boolean
  /** 被测量行的结束位置（相对内容顶部）。 */
  itemEnd: number
  scrollTop: number
}): boolean {
  if (input.suppressAdjustment || input.following || input.contentWidthChanging) {
    return false
  }
  return input.itemEnd <= input.scrollTop
}

/** 滚轮的 deltaY 与 scrollTop 同向：负值阅读更早内容，正值靠近底部。 */
export function timelineWheelScrollIntent(deltaY: number): TimelineScrollIntent {
  if (deltaY < 0) return 'awayFromBottom'
  if (deltaY > 0) return 'towardBottom'
  return 'none'
}

/** 触摸的手指位移与 scrollTop 反向：手指下移表示阅读更早内容。 */
export function timelineTouchScrollIntent(
  previousClientY: number,
  nextClientY: number,
): TimelineScrollIntent {
  if (nextClientY > previousClientY) return 'awayFromBottom'
  if (nextClientY < previousClientY) return 'towardBottom'
  return 'none'
}

/** 键盘滚动意图；输入控件内的光标按键不属于时间线滚动。 */
export function timelineKeyboardScrollIntent(input: {
  key: string
  shiftKey: boolean
  /** 事件目标是否为可编辑控件（输入框 / 富文本）。 */
  editableTarget: boolean
}): TimelineScrollIntent {
  if (input.editableTarget) return 'none'
  if (input.key === 'ArrowUp' || input.key === 'PageUp' || input.key === 'Home') {
    return 'awayFromBottom'
  }
  if (input.key === 'ArrowDown' || input.key === 'PageDown' || input.key === 'End') {
    return 'towardBottom'
  }
  if (input.key === ' ') {
    return input.shiftKey ? 'awayFromBottom' : 'towardBottom'
  }
  return 'none'
}

/**
 * 未观察滚动的判定容差：小于该值的 scrollTop 回退视为亚像素抖动，不算用户上滚。
 */
export const UNOBSERVED_SCROLL_EPSILON_PX = 2

/**
 * 内容变化 commit 贴底前，对账用户滚动意图。
 *
 * 对账规则（输入为 commit 时刻的实时几何）：
 * 1. 明确向上滚动 → 立即解除跟随，同帧的 layout commit 也必须让位；
 * 2. 没有用户输入 → 原样保持 following（虚拟库/折叠导致的 scrollTop 回退不算上滚）；
 * 3. 方向未知或向下的用户输入 → 落点在底则恢复跟随，明显回退则解除，其余保持。
 */
export function reconcileFollowingForContentAnchor(input: {
  /** 当前跟随态（scroll 事件驱动的既有值）。 */
  following: boolean
  /** commit 时刻（贴底动作之前）的实时落点是否贴底。 */
  atBottom: boolean
  /** commit 时刻的实时 scrollTop。 */
  scrollTop: number
  /** 最近一次「已账目」的 scrollTop（scroll 事件读值或程序化写入后的回读值）。 */
  lastObservedScrollTop: number
  /** commit 前捕获到的用户滚动意图；省略时按「方向未知」对账。 */
  userScrollIntent?: TimelineScrollIntent
}): boolean {
  const intent = input.userScrollIntent ?? 'unknown'
  if (intent === 'awayFromBottom') return false
  if (intent === 'none') return input.following
  if (input.atBottom) return true
  // 落点不在底，且 scrollTop 比上次记账值明显更小 —— 那是用户在上滑，只是事件还没派发
  const unobservedUpscroll =
    input.scrollTop < input.lastObservedScrollTop - UNOBSERVED_SCROLL_EPSILON_PX
  if (unobservedUpscroll) return false
  return input.following
}

/** 「回到底部」按钮可见性：仅在解除跟随且确实存在内容时展示。 */
export function shouldShowBackToBottom(following: boolean, turnCount: number): boolean {
  return !following && turnCount > 0
}

/** 会话切换 / 首次绑定：重置为跟随（打开会话定位到最新消息）。 */
export function initialFollowing(): boolean {
  return true
}
