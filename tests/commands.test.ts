import { describe, it, expect } from 'vitest'
import { COMMANDS, shortcutMatches, formatShortcut, isMacPlatform } from '../src/lib/commands'

// 分支条件直接取被测实现自己的判定（isMacPlatform 是导出函数），避免测试里
// 再抄一份平台判断——两份判断漂移过一次：原用例硬编码「非 mac」，而
// release.yml 的 macos runner 上必然失败，Windows 本地却一直绿。
const IS_MAC = isMacPlatform()

/** 当前平台上代表 mod 键的修饰键组合（mac=⌘，其他=Ctrl） */
function modEvent(key: string, extra: { shift?: boolean; alt?: boolean } = {}): KeyboardEvent {
  return IS_MAC
    ? keyEvent({ key, meta: true, ...extra })
    : keyEvent({ key, ctrl: true, ...extra })
}

/** 只带 mod，不带 shift —— 用于构造「多按了一个键」的负例 */
function modPlusWrongShift(key: string): KeyboardEvent {
  return IS_MAC ? keyEvent({ key, meta: true, shift: true }) : keyEvent({ key, ctrl: true, shift: true })
}

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
  it('mod 命中（mac=⌘，Windows/Linux=Ctrl）', () => {
    const palette = COMMANDS.find((c) => c.id === 'palette.open')!
    expect(shortcutMatches(modEvent('k'), palette.shortcut!)).toBe(true)
  })

  it('缺少 mod 不命中', () => {
    const palette = COMMANDS.find((c) => c.id === 'palette.open')!
    expect(shortcutMatches(keyEvent({ key: 'k' }), palette.shortcut!)).toBe(false)
  })

  it('shift 状态不一致不命中', () => {
    const palette = COMMANDS.find((c) => c.id === 'palette.open')!
    expect(shortcutMatches(modPlusWrongShift('k'), palette.shortcut!)).toBe(false)
  })

  it('大小写不敏感（CapsLock 场景）', () => {
    const palette = COMMANDS.find((c) => c.id === 'palette.open')!
    const event = IS_MAC ? keyEvent({ key: 'K', meta: true }) : keyEvent({ key: 'K', ctrl: true })
    expect(shortcutMatches(event, palette.shortcut!)).toBe(true)
  })

  it.runIf(IS_MAC)('mac 上不收 Ctrl：mod 判定确实按平台分流', () => {
    const palette = COMMANDS.find((c) => c.id === 'palette.open')!
    expect(shortcutMatches(keyEvent({ key: 'k', ctrl: true }), palette.shortcut!)).toBe(false)
    expect(shortcutMatches(keyEvent({ key: 'k', meta: true }), palette.shortcut!)).toBe(true)
  })
})

describe('formatShortcut', () => {
  it.runIf(!IS_MAC)('非 mac 平台使用 Ctrl+ 前缀', () => {
    expect(formatShortcut({ key: 'k' })).toBe('Ctrl+K')
    expect(formatShortcut({ key: 'l', shift: true })).toBe('Ctrl+Shift+L')
    expect(formatShortcut({ key: ',' })).toBe('Ctrl+,')
  })

  it.runIf(IS_MAC)('mac 平台使用 ⌘ 前缀，且不出现 Ctrl 字样', () => {
    const plain = formatShortcut({ key: 'k' })
    expect(plain).toContain('⌘')
    expect(plain).not.toContain('Ctrl')
    expect(plain.endsWith('K')).toBe(true)
    // shift / 逗号的形态只断言「键名到位 + 确有区分」，避免把平台符号表钉死
    const shifted = formatShortcut({ key: 'l', shift: true })
    expect(shifted.endsWith('L')).toBe(true)
    expect(shifted).not.toBe(plain)
    expect(formatShortcut({ key: ',' })).toContain(',')
  })
})
