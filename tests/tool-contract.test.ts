/**
 * 工具契约层（报告 03 P0-2 / 报告 05 P0-1 切片）：
 * 描述三要素 + 结构化错误类型锚点。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  applyToolDescriptionGuides,
  formatToolError,
  parseToolError,
  TOOL_GUIDE_NAMES,
  type ToolError,
} from '../src/lib/tool-contract'
import { toolRegistry } from '../src/lib/tool-registry'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

describe('结构化错误（单轨 string 内的类型锚点）', () => {
  it('可读文案在前，负载在后；解析还原 code/message/retryable', () => {
    const err: ToolError = { code: 'not_found', message: 'no such file', retryable: false }
    const text = formatToolError(err, 'Error: cannot read file D:/x.ts - ENOENT')
    expect(text.startsWith('Error:')).toBe(true)
    expect(parseToolError(text)).toEqual(err)
  })

  it('非错误文本 / 损坏负载返回 null', () => {
    expect(parseToolError('✅ File written')).toBeNull()
    expect(parseToolError('Error: x\n__TOOL_ERROR__{broken')).toBeNull()
  })
})

describe('描述三要素', () => {
  it('登记的 9 个核心工具都补 When to use / When NOT / 失败语义', () => {
    expect(TOOL_GUIDE_NAMES.length).toBe(9)
    const defs = toolRegistry.getDefinitionsForMode('default')
    for (const name of TOOL_GUIDE_NAMES) {
      const def = defs.find((d) => d.name === name)
      expect(def, name).toBeTruthy()
      expect(def!.description, name).toContain('When to use:')
      expect(def!.description, name).toContain('When NOT:')
      expect(def!.description, name).toContain('On failure:')
    }
  })

  it('追加而非覆盖：原文案开头保持不变', () => {
    const def = toolRegistry.getDefinitionsForMode('default').find((d) => d.name === 'read_file')!
    expect(def.description.startsWith('Read a text file from the local filesystem')).toBe(true)
  })

  it('不 mutate 注册表，重复调用不重复追加', () => {
    const a = toolRegistry.getDefinitionsForMode('default').find((d) => d.name === 'write_file')!
    const b = toolRegistry.getDefinitionsForMode('default').find((d) => d.name === 'write_file')!
    expect(a.description).toBe(b.description)
    expect(a.description.match(/When NOT:/g)).toHaveLength(1)
    const raw = read('lib/tool-registry.ts')
    const once = applyToolDescriptionGuides([{ name: 'write_file', description: 'base', parameters: {} }])
    const twice = applyToolDescriptionGuides(once)
    expect(twice[0]!.description).toBe(once[0]!.description)
    expect(raw).toContain('applyToolDescriptionGuides(visible)')
  })

  it('harness 兼容模式不灌模板话（dsh 的简短描述保持）', () => {
    const dsh = toolRegistry.getDefinitionsForMode('dsh').find((d) => d.name === 'read_file')!
    expect(dsh.description).not.toContain('When NOT:')
    expect(dsh.description).toContain('Read a text file.')
  })
})
