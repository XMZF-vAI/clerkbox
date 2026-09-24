import { describe, it, expect } from 'vitest'
import { COMMANDS, shortcutMatches, formatShortcut } from '../src/lib/commands'

function keyEvent(init: { key: string; ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    metaKey: init.meta ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
  } as unknown as KeyboardEvent
}

describe('commands 唯一事实源', () => {
  it('命令 id 与 i18n key 不重复', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const cmd of COMMANDS) {
      expect(cmd.titleKey.startsWith('commands.')).toBe(true)
    }
  })

  it('快捷键绑定不冲突（同一按键组合只绑一个命令）', () => {
    const combos = COMMANDS.filter((c) => c.shortcut).map(
      (c) => `${c.shortcut!.key}|${!!c.shortcut!.shift}|${!!c.shortcut!.alt}`,
    )
    expect(new Set(combos).size).toBe(combos.length)
  })
})

describe('shortcutMatches', () => {
  it('Ctrl+K 命中（Windows/Linux 语义）', () => {
    // 测试环境 navigator.platform 非 mac，mod 走 ctrlKey
    const palette = COMMANDS.find((c) => c.id === 'palette.open')!
    expect(shortcutMatches(keyEvent({ key: 'k', ctrl: true }), palette.shortcut!)).toBe(true)
  })

  it('缺少 mod 或 shift 状态不一致不命中', () => {
    const palette = COMMANDS.find((c) => c.id === 'palette.open')!
    expect(shortcutMatches(keyEvent({ key: 'k' }), palette.shortcut!)).toBe(false)
    expect(shortcutMatches(keyEvent({ key: 'k', ctrl: true, shift: true }), palette.shortcut!)).toBe(false)
  })

  it('大小写不敏感（CapsLock 场景）', () => {
    const palette = COMMANDS.find((c) => c.id === 'palette.open')!
    expect(shortcutMatches(keyEvent({ key: 'K', ctrl: true }), palette.shortcut!)).toBe(true)
  })
})

describe('formatShortcut', () => {
  it('非 mac 平台使用 Ctrl+ 前缀', () => {
    expect(formatShortcut({ key: 'k' })).toBe('Ctrl+K')
    expect(formatShortcut({ key: 'l', shift: true })).toBe('Ctrl+Shift+L')
    expect(formatShortcut({ key: ',' })).toBe('Ctrl+,')
  })
})
