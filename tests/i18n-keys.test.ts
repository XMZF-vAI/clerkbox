/**
 * i18n 的两条底线（本次审查里 `agent.*` 整块缺失，30+ 处在界面上直接露出 key，
 * 而 `notify` 块下却有同名键——命名空间写错时，人眼扫一遍文件是看不出来的）：
 *  1. 两份语言的键集合必须对称；
 *  2. 代码里引用的每个字面量 key 都要真的存在（复数键按 `_one/_other` 等后缀判定）。
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import en from '../src/i18n/locales/en'
import zh from '../src/i18n/locales/zh-CN'

const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other']

function flatten(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flatten(child, prefix ? `${prefix}.${key}` : key)
    )
  }
  return prefix ? [prefix] : []
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'locales' ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

const zhKeys = new Set(flatten(zh))
const enKeys = new Set(flatten(en))
const hasKey = (keys: Set<string>, key: string): boolean =>
  keys.has(key) || PLURAL_SUFFIXES.some((suffix) => keys.has(`${key}_${suffix}`))

describe('locale 键集合', () => {
  it('zh 有而 en 没有的键为空', () => {
    expect([...zhKeys].filter((k) => !enKeys.has(k))).toEqual([])
  })
  it('en 有而 zh 没有的键为空', () => {
    expect([...enKeys].filter((k) => !zhKeys.has(k))).toEqual([])
  })
})

describe('代码里引用的 i18n key', () => {
  it('每个字面量 key 在两份语言里都有落位', () => {
    const missing: string[] = []
    for (const file of sourceFiles('src')) {
      const source = fs.readFileSync(file, 'utf-8')
      for (const match of source.matchAll(/(?<![\w$.])t\(\s*'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'/g)) {
        const key = match[1]!
        if (!hasKey(zhKeys, key)) missing.push(`${key} ← ${file} (zh)`)
        if (!hasKey(enKeys, key)) missing.push(`${key} ← ${file} (en)`)
      }
    }
    expect(missing).toEqual([])
  })
})
