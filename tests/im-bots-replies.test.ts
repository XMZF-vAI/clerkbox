import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

import zh from '../src/i18n/locales/zh-CN'
import en from '../src/i18n/locales/en'
import { KNOWN_BOT_COMMANDS, parseCommand } from '../electron/im-bots/core'

/**
 * IM 机器人发给聊天对端的文案守卫。
 *
 * 这一组键（bots.reply.*）与界面文案有个关键区别：**它不在 src/ 里**，而是主进程通过
 * i18n.t 取用，所以 tests/i18n-keys.test.ts 那条「扫 src 里的 t('...') 字面量」的守卫
 * 对它完全无效——键名写错或整块漏译，界面上什么都看不到，只有手机上会直接露出
 * 「bots.reply.workspaceSet」这种字符串给用户的微信。这里补上那道门。
 */

const CORE_SOURCE = fs.readFileSync(path.join(process.cwd(), 'electron/im-bots/core.ts'), 'utf-8')

function flatten(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      for (const [k, v] of flatten(child, prefix ? `${prefix}.${key}` : key)) out.set(k, v)
    }
    return out
  }
  if (prefix) out.set(prefix, String(value ?? ''))
  return out
}

const zhFlat = flatten(zh)
const enFlat = flatten(en)

/** core.ts 里出现过的全部 bots.reply.* 字面量 */
function usedReplyKeys(): string[] {
  const found = new Set<string>()
  for (const match of CORE_SOURCE.matchAll(/['"](bots\.reply\.[a-zA-Z0-9_]+)['"]/g)) {
    if (match[1]) found.add(match[1])
  }
  return [...found].sort()
}

/** locale 里挂在该命名空间下的键（多一条死文案也算问题：没人会再想起它） */
function localeReplyKeys(flat: Map<string, string>): string[] {
  return [...flat.keys()].filter((key) => key.startsWith('bots.reply.')).sort()
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] as string).sort()
}

describe('bots.reply 文案落位', () => {
  it('core.ts 用到的每条键在 zh 与 en 里都存在', () => {
    const used = usedReplyKeys()
    expect(used.length).toBeGreaterThan(20) // 扫描失效时先炸，避免假绿
    const missing = [
      ...used.filter((key) => !zhFlat.has(key)).map((key) => `${key} ← zh`),
      ...used.filter((key) => !enFlat.has(key)).map((key) => `${key} ← en`),
    ]
    expect(missing).toEqual([])
  })

  it('locale 里不多出没人用的 bots.reply 键', () => {
    const used = new Set(usedReplyKeys())
    expect(localeReplyKeys(zhFlat).filter((key) => !used.has(key))).toEqual([])
    expect(localeReplyKeys(enFlat).filter((key) => !used.has(key))).toEqual([])
  })

  it('两份语言的占位符集合一致（en 少一个 {{title}} 就会在手机上吐出一个空标题）', () => {
    const mismatched: string[] = []
    for (const key of usedReplyKeys()) {
      const inZh = JSON.stringify(placeholders(zhFlat.get(key) ?? ''))
      const inEn = JSON.stringify(placeholders(enFlat.get(key) ?? ''))
      if (inZh !== inEn) mismatched.push(`${key}: zh=${inZh} en=${inEn}`)
    }
    expect(mismatched).toEqual([])
  })

  it('文案非空，且长度不至于在手机上刷屏', () => {
    for (const key of usedReplyKeys()) {
      const text = (zhFlat.get(key) ?? '').trim()
      expect(text, `${key} 中文为空`).not.toBe('')
      // 上限取 500：/help 这类清单文案最长，再长就该拆成多条而不是发一屏
      expect(text.length, `${key} 中文过长`).toBeLessThan(500)
      expect((enFlat.get(key) ?? '').trim(), `${key} 英文为空`).not.toBe('')
    }
  })

  it('中文文案里没有漏翻译的 key 回声（曾经整块键写错命名空间，界面上直接露 key）', () => {
    for (const key of usedReplyKeys()) {
      expect(zhFlat.get(key) ?? '', key).not.toContain('bots.reply.')
      expect(enFlat.get(key) ?? '', key).not.toMatch(/^[a-z]+(\.[a-z]+)+$/i)
    }
  })
})

describe('命令清单与解析一致', () => {
  it('对外宣称的每条命令 parseCommand 都认（不在 switch 里就要报错）', () => {
    for (const command of KNOWN_BOT_COMMANDS) {
      const parsed = parseCommand(command === '/bind' ? '/bind ABC123' : command)
      expect(parsed, command).not.toBe(null)
      expect(parsed?.name, command).not.toBe('unknown')
    }
  })

  it('/help 文案把每条命令都写出来了（加了命令忘了进帮助，用户在手机上永远不知道）', () => {
    const help = zhFlat.get('bots.reply.help') ?? ''
    for (const command of KNOWN_BOT_COMMANDS) {
      expect(help, `${command} 未出现在 /help 文案里`).toContain(command)
    }
    const helpEn = enFlat.get('bots.reply.help') ?? ''
    for (const command of KNOWN_BOT_COMMANDS) {
      expect(helpEn, `${command} 未出现在 en 的 /help 文案里`).toContain(command)
    }
  })

  it('未知命令的回执带上原文，而不是含糊一句「不认识」', () => {
    expect(CORE_SOURCE).toContain("'bots.reply.unknownCommand'")
    expect(CORE_SOURCE).toMatch(/unknownCommand',\s*\{ command: /)
  })
})
