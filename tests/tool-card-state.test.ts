/**
 * 工具卡展开状态仓库 + 完成边沿自动动作决策的测试（对标 ZCode ToolLayout 折叠状态机）。
 *
 * 守四件事：
 *  1. 决策矩阵：只有完成边沿才动作；用户手动操作过 / 已自动动作过 → 一律 none；
 *  2. 写类完成后 open、非写类已展开 collapse——自动动作永远不与用户抢方向盘；
 *  3. 仓库语义：展开态跨「重挂」持久（get 返回上次写入值）、userTouched 记账、LRU 上限；
 *  4. 组键：toolGroupStateKey 锚定首行，同键读写恢复。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_TOOL_CARD_STATE_ENTRIES,
  getToolCardOpen,
  hasAutoActed,
  hasUserTouched,
  markAutoActed,
  resetToolCardStateForTests,
  resolveToolCardAutoAction,
  setToolCardOpen,
  toolGroupStateKey,
} from '../src/lib/tool-card-state'

describe('resolveToolCardAutoAction 决策矩阵', () => {
  const base = {
    wasRunning: true,
    isRunning: false,
    isOpen: false,
    userTouched: false,
    toolName: 'execute_command',
    hasAutoActed: false,
  }

  it('只在完成边沿动作：运行中 / 非边沿一律 none', () => {
    expect(resolveToolCardAutoAction({ ...base, isRunning: true })).toBe('none')
    expect(resolveToolCardAutoAction({ ...base, wasRunning: false, isRunning: false })).toBe('none')
    expect(resolveToolCardAutoAction({ ...base, wasRunning: false, isRunning: true })).toBe('none')
  })

  it('用户手动操作过的行永不自动动作（最高否决）', () => {
    expect(resolveToolCardAutoAction({ ...base, toolName: 'write_file', userTouched: true })).toBe('none')
    expect(resolveToolCardAutoAction({ ...base, isOpen: true, userTouched: true })).toBe('none')
  })

  it('每行自动动作一次封顶', () => {
    expect(resolveToolCardAutoAction({ ...base, toolName: 'write_file', hasAutoActed: true })).toBe('none')
  })

  it('写类工具完成后未展开 → open（立刻看到 diff）', () => {
    expect(resolveToolCardAutoAction({ ...base, toolName: 'write_file' })).toBe('open')
    expect(resolveToolCardAutoAction({ ...base, toolName: 'search_replace' })).toBe('open')
    expect(resolveToolCardAutoAction({ ...base, toolName: 'edit_file' })).toBe('open')
  })

  it('写类工具完成后已展开 → none（不画蛇添足）', () => {
    expect(resolveToolCardAutoAction({ ...base, toolName: 'write_file', isOpen: true })).toBe('none')
  })

  it('非写类长输出完成后已展开 → collapse（防完成后摊开视口）', () => {
    expect(resolveToolCardAutoAction({ ...base, toolName: 'execute_command', isOpen: true })).toBe('collapse')
    expect(resolveToolCardAutoAction({ ...base, toolName: 'read_file', isOpen: true })).toBe('collapse')
    expect(resolveToolCardAutoAction({ ...base, toolName: 'mcp__x__y', isOpen: true })).toBe('collapse')
  })

  it('非写类未展开 → none', () => {
    expect(resolveToolCardAutoAction({ ...base, toolName: 'execute_command', isOpen: false })).toBe('none')
    expect(resolveToolCardAutoAction({ ...base, toolName: 'web_search', isOpen: false })).toBe('none')
  })
})

describe('展开态仓库语义', () => {
  beforeEach(() => {
    resetToolCardStateForTests()
  })

  it('未记录返回 undefined；写入后跨「重挂」可恢复', () => {
    expect(getToolCardOpen('call-1')).toBeUndefined()
    setToolCardOpen('call-1', true)
    expect(getToolCardOpen('call-1')).toBe(true)
    setToolCardOpen('call-1', false)
    expect(getToolCardOpen('call-1')).toBe(false)
  })

  it('userAction 记账：hasUserTouched 可查', () => {
    setToolCardOpen('call-a', true, { userAction: true })
    setToolCardOpen('call-b', true)
    expect(hasUserTouched('call-a')).toBe(true)
    expect(hasUserTouched('call-b')).toBe(false)
  })

  it('autoActed 记账', () => {
    expect(hasAutoActed('call-x')).toBe(false)
    markAutoActed('call-x')
    expect(hasAutoActed('call-x')).toBe(true)
  })

  it('LRU 上限：超出上限淘汰最久未写的行', () => {
    for (let i = 0; i < MAX_TOOL_CARD_STATE_ENTRIES; i++) {
      setToolCardOpen(`call-${i}`, true)
    }
    // 刷新首行，让它变成「最新」
    setToolCardOpen('call-0', true)
    // 再写一行把最旧的（call-1）挤出去
    setToolCardOpen('call-new', true)
    expect(getToolCardOpen('call-0')).toBe(true)
    expect(getToolCardOpen('call-1')).toBeUndefined()
    expect(getToolCardOpen('call-new')).toBe(true)
  })

  it('组键锚定首行：同键读写可恢复组展开态', () => {
    const key = toolGroupStateKey('first-call-id')
    expect(key).toBe('group:first-call-id')
    setToolCardOpen(key, true, { userAction: true })
    expect(getToolCardOpen(key)).toBe(true)
    expect(hasUserTouched(key)).toBe(true)
  })

  it('reset 清空全部模块状态', () => {
    setToolCardOpen('call-r', true, { userAction: true })
    markAutoActed('call-r')
    resetToolCardStateForTests()
    expect(getToolCardOpen('call-r')).toBeUndefined()
    expect(hasUserTouched('call-r')).toBe(false)
    expect(hasAutoActed('call-r')).toBe(false)
  })
})
