/**
 * harness 兼容模式注册表的三条不变量。
 *
 * 模式是一份「菜单表 + 内容表」的双人舞：注册漏一项就是静默缺陷
 * ——会话能选到但静态 prompt 取不到（宿主直接崩），或内容齐了但菜单看不见
 * （死代码）。i18n 键是动态字符串，常驻的 i18n-keys 校验只看字面量 t('x.y')，
 * 覆盖不到这里，故单独钉住。
 */
import { describe, expect, it } from 'vitest'
import { HARNESS_MODE_CONTENT, HARNESS_MODE_METAS, normalizeHarnessMode } from '../src/lib/harness-modes'
import { toolRegistry } from '../src/lib/tool-registry'
import { ZCODE_SYSTEM_PROMPT, zcodeTransformTools } from '../src/lib/harness-prompts/zcode'
import en from '../src/i18n/locales/en'
import zh from '../src/i18n/locales/zh-CN'

const MODE_IDS = HARNESS_MODE_METAS.map((m) => m.id)

function flatten(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flatten(child, prefix ? `${prefix}.${key}` : key)
    )
  }
  return prefix ? [prefix] : []
}

const keySet = (locale: unknown) => new Set(flatten(locale))

describe('模式注册表', () => {
  it('菜单 id 唯一，且除 default 外每项都有内容', () => {
    expect(new Set(MODE_IDS).size).toBe(MODE_IDS.length)
    for (const meta of HARNESS_MODE_METAS) {
      if (meta.id === 'default') continue
      expect(HARNESS_MODE_CONTENT[meta.id as Exclude<typeof meta.id, 'default'>]).toBeTruthy()
    }
  })

  it('内容表里的模式都能在菜单里选到（不留选不到的死模式）', () => {
    expect(Object.keys(HARNESS_MODE_CONTENT).sort()).toEqual(
      MODE_IDS.filter((id) => id !== 'default').sort()
    )
  })

  it('compat 分组的每项都带三个 i18n key，且两份语言都有落位', () => {
    const zhKeys = keySet(zh)
    const enKeys = keySet(en)
    const missing: string[] = []
    for (const meta of HARNESS_MODE_METAS) {
      for (const key of [meta.nameKey, meta.descKey, meta.hintKey]) {
        if (!zhKeys.has(key)) missing.push(`${key} (zh)`)
        if (!enKeys.has(key)) missing.push(`${key} (en)`)
      }
    }
    expect(missing).toEqual([])
  })

  it('未知存储值回退 default，已知值原样保留', () => {
    expect(normalizeHarnessMode('zcode')).toBe('zcode')
    expect(normalizeHarnessMode('dsh-minimal')).toBe('dsh-minimal')
    expect(normalizeHarnessMode('code')).toBe('default')
    expect(normalizeHarnessMode(undefined)).toBe('default')
    expect(normalizeHarnessMode({})).toBe('default')
  })
})

describe('ZCode 兼容模式', () => {
  it('静态段带齐底本的四块：前导身份 / Harness / 沟通 / 上下文管理', () => {
    expect(ZCODE_SYSTEM_PROMPT.startsWith('You are ClerkBox, an interactive coding agent.')).toBe(true)
    for (const marker of ['# Harness', '# Communicating with the user', '# Context management', '<tool_surface>']) {
      expect(ZCODE_SYSTEM_PROMPT).toContain(marker)
    }
  })

  it('静态段不含易变内容（前缀缓存前提）', () => {
    // 日期/时间/工作目录这类必须由动态段注入，出现在静态段里会让每次请求都 miss 缓存
    expect(ZCODE_SYSTEM_PROMPT).not.toMatch(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)day\b/)
    expect(ZCODE_SYSTEM_PROMPT).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/)
    expect(ZCODE_SYSTEM_PROMPT).not.toMatch(/[A-Z]:\\Users/)
  })

  it('工具变换只改描述：不增删、不改名、不留空描述', () => {
    const defs = toolRegistry.definitions.filter((d) => !d.name.startsWith('mcp__'))
    const out = zcodeTransformTools(defs)
    expect(out.map((d) => d.name)).toEqual(defs.map((d) => d.name))
    for (const d of out) expect(d.description.trim().length).toBeGreaterThan(0)
  })

  it('改写后的描述不把模型指向 ZCode 独有的可调用工具', () => {
    const defs = toolRegistry.definitions.filter((d) => !d.name.startsWith('mcp__'))
    for (const d of zcodeTransformTools(defs)) {
      for (const upstream of ['TodoRead', 'CreateWorkflow', 'EnterPlanMode', 'CronCreate', 'run_in_background']) {
        expect(`${d.name}: ${d.description}`).not.toContain(upstream)
      }
    }
  })

  it('宿主侧按模式取定义：zcode 与 default 工具集同名', () => {
    expect(toolRegistry.getDefinitionsForMode('zcode').map((d) => d.name)).toEqual(
      toolRegistry.getDefinitionsForMode('default').map((d) => d.name)
    )
  })
})
