/**
 * 对话时间线的底部锚定状态机测试。
 *
 * 守的是三条核心不变量（ZCode 同款问题，ClerkBox 此前靠纯几何判定会踩）：
 *  1. 程序化/布局滚动不得夺走用户的滚动权；
 *  2. 用户明确上滑时，内容变化不得把视口拽回底部；
 *  3. 贴底动作必须以「对账后的跟随态」为准，而不是过期的几何快照。
 */
import { describe, it, expect } from 'vitest'
import {
  anchorActionAfterContentChange,
  classifyScrollSource,
  initialFollowing,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldShowBackToBottom,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  UNOBSERVED_SCROLL_EPSILON_PX,
  type TimelineScrollIntent,
} from '../src/lib/timeline-scroll-anchor'

describe('classifyScrollSource 滚动来源分类', () => {
  it('用户意图优先于程序化与布局标记', () => {
    expect(classifyScrollSource({
      hasUserIntent: true,
      programmaticScrollActive: true,
      withinLayoutGuardWindow: true,
    })).toBe('user')
  })

  it('无用户意图时，程序化滚动优先于布局回退', () => {
    expect(classifyScrollSource({
      hasUserIntent: false,
      programmaticScrollActive: true,
      withinLayoutGuardWindow: true,
    })).toBe('programmatic')
    expect(classifyScrollSource({
      hasUserIntent: false,
      programmaticScrollActive: false,
      withinLayoutGuardWindow: true,
    })).toBe('layout')
  })

  it('三者都没有时按用户滚动兜底（落点决定跟随）', () => {
    expect(classifyScrollSource({
      hasUserIntent: false,
      programmaticScrollActive: false,
      withinLayoutGuardWindow: false,
    })).toBe('user')
  })
})

describe('resolveFollowingAfterScroll 跟随权裁决', () => {
  it('用户滚动到离底位置 → 解除跟随', () => {
    expect(resolveFollowingAfterScroll({ following: true, atBottom: false, source: 'user' })).toBe(false)
  })

  it('用户滚回底部 → 恢复跟随', () => {
    expect(resolveFollowingAfterScroll({ following: false, atBottom: true, source: 'user' })).toBe(true)
  })

  it('程序化滚动不得改变跟随态', () => {
    expect(resolveFollowingAfterScroll({ following: true, atBottom: false, source: 'programmatic' })).toBe(true)
    expect(resolveFollowingAfterScroll({ following: false, atBottom: true, source: 'programmatic' })).toBe(false)
  })

  it('布局回退不得改变跟随态（测高补偿 / 折叠不能夺走用户滚动权）', () => {
    expect(resolveFollowingAfterScroll({ following: true, atBottom: false, source: 'layout' })).toBe(true)
    expect(resolveFollowingAfterScroll({ following: false, atBottom: true, source: 'layout' })).toBe(false)
  })
})

describe('anchorActionAfterContentChange 内容变化后的动作', () => {
  it('跟随中 → 贴底', () => {
    expect(anchorActionAfterContentChange(true)).toBe('stickToBottom')
  })

  it('已解除跟随 → 保持阅读位置', () => {
    expect(anchorActionAfterContentChange(false)).toBe('hold')
  })

  it('宽度变化期间不贴底（避免分批测高形成抖动）', () => {
    expect(anchorActionAfterContentChange(true, true)).toBe('hold')
  })
})

describe('用户滚动意图识别', () => {
  it('滚轮：向上为离底，向下为靠近底部', () => {
    expect(timelineWheelScrollIntent(-1)).toBe('awayFromBottom')
    expect(timelineWheelScrollIntent(1)).toBe('towardBottom')
    expect(timelineWheelScrollIntent(0)).toBe('none')
  })

  it('触摸：手指下移为离底（与 scrollTop 反向）', () => {
    expect(timelineTouchScrollIntent(100, 150)).toBe('awayFromBottom')
    expect(timelineTouchScrollIntent(150, 100)).toBe('towardBottom')
    expect(timelineTouchScrollIntent(100, 100)).toBe('none')
  })

  it('键盘：上下翻页与 Home/End 有明确方向', () => {
    expect(timelineKeyboardScrollIntent({ key: 'ArrowUp', shiftKey: false, editableTarget: false })).toBe('awayFromBottom')
    expect(timelineKeyboardScrollIntent({ key: 'PageUp', shiftKey: false, editableTarget: false })).toBe('awayFromBottom')
    expect(timelineKeyboardScrollIntent({ key: 'Home', shiftKey: false, editableTarget: false })).toBe('awayFromBottom')
    expect(timelineKeyboardScrollIntent({ key: 'ArrowDown', shiftKey: false, editableTarget: false })).toBe('towardBottom')
    expect(timelineKeyboardScrollIntent({ key: 'End', shiftKey: false, editableTarget: false })).toBe('towardBottom')
    expect(timelineKeyboardScrollIntent({ key: ' ', shiftKey: true, editableTarget: false })).toBe('awayFromBottom')
    expect(timelineKeyboardScrollIntent({ key: ' ', shiftKey: false, editableTarget: false })).toBe('towardBottom')
  })

  it('输入控件内的按键不算时间线滚动', () => {
    expect(timelineKeyboardScrollIntent({ key: 'ArrowUp', shiftKey: false, editableTarget: true })).toBe('none')
    expect(timelineKeyboardScrollIntent({ key: 'PageUp', shiftKey: false, editableTarget: true })).toBe('none')
  })

  it('无关按键不产生意图', () => {
    expect(timelineKeyboardScrollIntent({ key: 'a', shiftKey: false, editableTarget: false })).toBe('none')
  })
})

describe('reconcileFollowingForContentAnchor 贴底前对账', () => {
  it('明确上滑 → 立即解除跟随，即使旧的 following 还是 true', () => {
    expect(reconcileFollowingForContentAnchor({
      following: true,
      atBottom: true,
      scrollTop: 100,
      lastObservedScrollTop: 500,
      userScrollIntent: 'awayFromBottom',
    })).toBe(false)
  })

  it('没有用户输入 → 原样保持（虚拟库/折叠导致的 scrollTop 回退不算上滚）', () => {
    expect(reconcileFollowingForContentAnchor({
      following: true,
      atBottom: false,
      scrollTop: 100,
      lastObservedScrollTop: 500,
      userScrollIntent: 'none',
    })).toBe(true)
  })

  it('方向向下且落点在底 → 恢复跟随', () => {
    expect(reconcileFollowingForContentAnchor({
      following: false,
      atBottom: true,
      scrollTop: 500,
      lastObservedScrollTop: 500,
      userScrollIntent: 'towardBottom',
    })).toBe(true)
  })

  it('方向未知但 scrollTop 明显回退（事件未派发）→ 视为上滑，解除跟随', () => {
    expect(reconcileFollowingForContentAnchor({
      following: true,
      atBottom: false,
      scrollTop: 100,
      lastObservedScrollTop: 500,
      userScrollIntent: 'unknown',
    })).toBe(false)
  })

  it('亚像素级回退不算上滚（容差内保持跟随）', () => {
    expect(reconcileFollowingForContentAnchor({
      following: true,
      atBottom: false,
      scrollTop: 500 - UNOBSERVED_SCROLL_EPSILON_PX / 2,
      lastObservedScrollTop: 500,
      userScrollIntent: 'unknown',
    })).toBe(true)
  })

  it('方向未知且无明显回退 → 保持原跟随态', () => {
    expect(reconcileFollowingForContentAnchor({
      following: false,
      atBottom: false,
      scrollTop: 500,
      lastObservedScrollTop: 500,
      userScrollIntent: 'unknown',
    })).toBe(false)
  })

  it('省略意图时按「方向未知」对账', () => {
    expect(reconcileFollowingForContentAnchor({
      following: true,
      atBottom: false,
      scrollTop: 100,
      lastObservedScrollTop: 500,
    })).toBe(false)
  })
})

describe('shouldAdjustVirtualizerForItemSizeChange 测高补偿裁决', () => {
  const base = {
    following: false,
    suppressAdjustment: false,
    contentWidthChanging: false,
    itemEnd: 100,
    scrollTop: 500,
  }

  it('被测量的行已滚出视口上方 → 补偿', () => {
    expect(shouldAdjustVirtualizerForItemSizeChange(base)).toBe(true)
  })

  it('行仍在视口内 → 不补偿', () => {
    expect(shouldAdjustVirtualizerForItemSizeChange({ ...base, itemEnd: 800 })).toBe(false)
  })

  it('跟随中不补偿（贴底会与补偿打架）', () => {
    expect(shouldAdjustVirtualizerForItemSizeChange({ ...base, following: true })).toBe(false)
  })

  it('恢复滚动期间不补偿', () => {
    expect(shouldAdjustVirtualizerForItemSizeChange({ ...base, suppressAdjustment: true })).toBe(false)
  })

  it('宽度变化期间不补偿（分批测高会形成可见抖动）', () => {
    expect(shouldAdjustVirtualizerForItemSizeChange({ ...base, contentWidthChanging: true })).toBe(false)
  })
})

describe('辅助判定', () => {
  it('回到底部按钮：解除跟随且有内容才显示', () => {
    expect(shouldShowBackToBottom(false, 3)).toBe(true)
    expect(shouldShowBackToBottom(true, 3)).toBe(false)
    expect(shouldShowBackToBottom(false, 0)).toBe(false)
  })

  it('初始状态为跟随（打开会话定位最新消息）', () => {
    expect(initialFollowing()).toBe(true)
  })

  it('意图类型覆盖四种取值', () => {
    const intents: TimelineScrollIntent[] = ['none', 'awayFromBottom', 'towardBottom', 'unknown']
    expect(intents).toHaveLength(4)
  })
})
