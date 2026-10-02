import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  AGENT_ACTION_LIMITS,
  BROWSER_ACTION_SUMMARY_IDS,
  BROWSER_TOOL_PREFIX,
  COMPUTER_ACTION_SUMMARY_IDS,
  COMPUTER_TOOL_PREFIX,
  agentActionFamily,
  clampInt,
  exceedsInlineImageBudget,
  isAgentActionTool,
  isBrowserCommandReadOnly,
  isComputerActionReadOnly,
  isPointInsideRaster,
  type AgentActionImage,
  type BrowserCommand,
  type ComputerAction,
} from '../src/lib/agent-actions'
import { buildRequestBody } from '../src/lib/api-adapters'
import type { NeutralMessage } from '../src/lib/api-adapters'

// ── 契约层 ──

describe('agent action family', () => {
  it('按前缀识别动作族，不逐个硬编码工具名', () => {
    expect(agentActionFamily('browser_click')).toBe('browser')
    expect(agentActionFamily('computer_screenshot')).toBe('computer')
    expect(agentActionFamily('read_file')).toBeNull()
    expect(agentActionFamily('mcp__x__y')).toBeNull()
    // 前缀必须带下划线，否则 read_file 这类名字会误伤
    expect(agentActionFamily('browserextra')).toBeNull()
  })

  it('isAgentActionTool 与族判定一致', () => {
    expect(isAgentActionTool(`browser_${'navigate'}`)).toBe(true)
    expect(isAgentActionTool(`computer_${'type'}`)).toBe(true)
    expect(isAgentActionTool('execute_command')).toBe(false)
  })

  it('导出的前缀常量与判定口径一致', () => {
    expect(`x${BROWSER_TOOL_PREFIX}click`.slice(1)).toBe('browser_click')
    expect(`x${COMPUTER_TOOL_PREFIX}type`.slice(1)).toBe('computer_type')
  })
})

describe('read-only action classification', () => {
  it('只读动作不改页面也不碰桌面', () => {
    const readOnlyBrowser: BrowserCommand[] = [
      { method: 'snapshot' },
      { method: 'screenshot' },
      { method: 'evaluate', expression: '1' },
      { method: 'back' },
      { method: 'forward' },
      { method: 'reload' },
      { method: 'wait', selector: '#a' },
    ]
    for (const cmd of readOnlyBrowser) expect(isBrowserCommandReadOnly(cmd)).toBe(true)
  })

  it('写动作一律不在只读面内（审批门与 plan 模式据此拦截）', () => {
    const writing: BrowserCommand[] = [
      { method: 'navigate', url: 'https://example.com' },
      { method: 'click', target: { type: 'coordinate', x: 1, y: 1 } },
      { method: 'type', text: 'hi' },
      { method: 'press', key: 'Enter' },
      { method: 'scroll', deltaY: 100 },
    ]
    for (const cmd of writing) expect(isBrowserCommandReadOnly(cmd)).toBe(false)
  })

  it('computer 只读面仅限观察类动作', () => {
    const readOnly: ComputerAction[] = [
      { action: 'screenshot' },
      { action: 'list_apps' },
      { action: 'read_clipboard' },
      { action: 'wait' },
    ]
    for (const a of readOnly) expect(isComputerActionReadOnly(a)).toBe(true)
    const writing: ComputerAction[] = [
      { action: 'left_click', x: 1, y: 1 },
      { action: 'type', text: 'hi' },
      { action: 'key', key: 'Enter' },
      { action: 'hold_key', key: 'Shift' },
      { action: 'scroll', deltaY: 1 },
      { action: 'write_clipboard', text: 'x' },
      { action: 'open_application', name: 'notepad' },
      { action: 'left_click_drag', fromX: 0, fromY: 0, toX: 1, toY: 1 },
      { action: 'mouse_move', x: 1, y: 1 },
      { action: 'double_click', x: 1, y: 1 },
      { action: 'right_click', x: 1, y: 1 },
    ]
    for (const a of writing) expect(isComputerActionReadOnly(a)).toBe(false)
  })
})

describe('action summary id tables', () => {
  it('browser 词表覆盖全部命令方法（漏一条 UI 就得回落成默认文案）', () => {
    const methods: BrowserCommand['method'][] = [
      'navigate', 'back', 'forward', 'reload', 'snapshot', 'click', 'type', 'press',
      'scroll', 'screenshot', 'evaluate', 'wait',
    ]
    for (const m of methods) {
      expect(BROWSER_ACTION_SUMMARY_IDS[m], `缺少 ${m} 的 i18n key`).toBeTruthy()
      // 前缀必须与 locales 里的落点一致。这两张开表被 UI 动态查表消费，
      // tests/i18n-keys 的字面量扫描扫不到它们，写错前缀只会显示成裸 key
      expect(BROWSER_ACTION_SUMMARY_IDS[m]).toMatch(/^toolRenderer\.agentAction\./)
    }
  })

  it('computer 词表覆盖全部动作名，且前缀一致', () => {
    const actions: ComputerAction['action'][] = [
      'screenshot', 'left_click', 'right_click', 'double_click', 'mouse_move', 'left_click_drag',
      'scroll', 'type', 'key', 'hold_key', 'wait', 'read_clipboard', 'write_clipboard',
      'list_apps', 'open_application',
    ]
    for (const a of actions) {
      expect(COMPUTER_ACTION_SUMMARY_IDS[a], `缺少 ${a} 的 i18n key`).toBeTruthy()
      expect(COMPUTER_ACTION_SUMMARY_IDS[a]).toMatch(/^toolRenderer\.agentAction\./)
    }
  })

  it('词表里的每个 key 在 zh / en 两份 locale 里都真实存在（动态查表扫不到，只能在这里锁）', () => {
    // i18n-keys.test.ts 只校验 src/** 里字面量 t("a.b.c") 的引用；
    // 这两张表是运行时查表引用，locale 缺 key 只会显示裸 key，必须单独兜住
    const zh = fs.readFileSync(path.join(process.cwd(), 'src/i18n/locales/zh-CN.ts'), 'utf-8')
    const en = fs.readFileSync(path.join(process.cwd(), 'src/i18n/locales/en.ts'), 'utf-8')
    const keys = [...Object.values(BROWSER_ACTION_SUMMARY_IDS), ...Object.values(COMPUTER_ACTION_SUMMARY_IDS)]
    expect(keys.length).toBe(27)
    for (const key of keys) {
      const leaf = key.split('.').at(-1)!
      expect(zh, `zh-CN 缺 ${key}`).toMatch(new RegExp(`^\\s+${leaf}:`, 'm'))
      expect(en, `en 缺 ${key}`).toMatch(new RegExp(`^\\s+${leaf}:`, 'm'))
    }
  })
})

describe('coordinate + budget guards', () => {
  const image: AgentActionImage = {
    dataUrl: 'data:image/png;base64,AAAA',
    mimeType: 'image/png',
    width: 1280,
    height: 720,
  }

  it('坐标必须落在本帧 raster 内，边界取半开区间', () => {
    expect(isPointInsideRaster({ x: 0, y: 0 }, image)).toBe(true)
    expect(isPointInsideRaster({ x: 1279, y: 719 }, image)).toBe(true)
    expect(isPointInsideRaster({ x: 1280, y: 719 }, image)).toBe(false)
    expect(isPointInsideRaster({ x: 100, y: -1 }, image)).toBe(false)
  })

  it('超出内联预算的图必须先降采样，不允许原样塞进请求', () => {
    expect(exceedsInlineImageBudget(image)).toBe(false)
    expect(exceedsInlineImageBudget({ ...image, dataUrl: 'x'.repeat(AGENT_ACTION_LIMITS.screenshotInlineBase64Bytes + 1) })).toBe(true)
  })

  it('clampInt 收口模型的越界/字符串入参', () => {
    expect(clampInt(-5, 1, 100, 10)).toBe(1)
    expect(clampInt(9999, 1, 100, 10)).toBe(100)
    expect(clampInt(undefined, 1, 100, 10)).toBe(10)
    expect(clampInt('abc', 1, 100, 10)).toBe(10)
    expect(clampInt('42', 1, 100, 10)).toBe(42)
    expect(clampInt(7.6, 1, 100, 10)).toBe(8)
  })
})

// ── 图像通道：ToolResult.images → 协议 image block ──

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgo='

function openaiBody(messages: NeutralMessage[]) {
  return buildRequestBody('openai', {
    model: 'gpt-x',
    messages,
    tools: [],
    temperature: 0,
    maxTokens: 1024,
    thinking: false,
    stream: false,
  }) as { messages: Array<Record<string, unknown>> }
}

function anthropicBody(messages: NeutralMessage[]) {
  return buildRequestBody('anthropic', {
    model: 'claude-x',
    messages,
    tools: [],
    temperature: 0,
    maxTokens: 1024,
    thinking: false,
    stream: false,
  }) as { messages: Array<{ role: string; content: Array<{ type: string; [k: string]: unknown }> }> }
}

const toolTurnWithImage: NeutralMessage[] = [
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'computer_screenshot', arguments: '{}' } }],
  },
  {
    role: 'tool',
    content: 'Screenshot 1560x880 captured.',
    tool_call_id: 'call_1',
    images: [{ dataUrl: PNG_1PX, mimeType: 'image/png' }],
  },
]

describe('OpenAI tool-result image channel', () => {
  it('带图工具结果拆成「工具结果 + user 图像消息」，content 保持字符串', () => {
    const messages = openaiBody(toolTurnWithImage).messages
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'user'])
    expect(messages[1]).toEqual({ role: 'tool', content: 'Screenshot 1560x880 captured.', tool_call_id: 'call_1' })
    const imageMessage = messages[2]!
    expect(imageMessage.role).toBe('user')
    expect(imageMessage.content).toEqual([{ type: 'image_url', image_url: { url: PNG_1PX } }])
  })

  it('连续多个带图工具结果合并成一条 user 图像消息，保证 tool 序列不被 user 打断', () => {
    const messages = openaiBody([
      ...toolTurnWithImage,
      { role: 'tool', content: 'Clicked.', tool_call_id: 'call_2', images: [{ dataUrl: PNG_1PX, mimeType: 'image/png' }] },
    ]).messages
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
    const content = messages[3]!.content as Array<{ type: string }>
    expect(content).toHaveLength(2)
  })

  it('无图工具结果不产生额外 user 消息', () => {
    const messages = openaiBody([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
    ]).messages
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('用户消息的图仍走原来的多模态 content 数组（行为不回归）', () => {
    const messages = openaiBody([
      { role: 'user', content: '看图', images: [{ dataUrl: PNG_1PX, mimeType: 'image/png' }] },
    ]).messages
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: PNG_1PX } },
    ])
  })
})

describe('Anthropic tool-result image channel', () => {
  // Anthropic 要求消息以 user 开头，开头的 assistant 会被 toAnthropicMessages 剥掉，
  // 所以每组夹具都带一条真实的 user 起手消息（与实际请求同形）。
  const opening: NeutralMessage[] = [{ role: 'user', content: 'do it' }]

  type AnthropicBodyMessage = { role: string; content: Array<{ type: string; [k: string]: unknown }> }

  /** tool_result 落在哪条消息取决于相邻消息的角色，测试不应把索引写死 */
  function toolResultBlock(messages: AnthropicBodyMessage[]) {
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'tool_result') return block
      }
    }
    throw new Error('tool_result block not found')
  }

  const toolTurn = (content: string, images?: NeutralMessage['images']): NeutralMessage[] => [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', content, tool_call_id: 'c1', ...(images ? { images } : {}) },
  ]

  it('tool_result 支持 block 数组，且 image 排在 text 之前', () => {
    const messages = anthropicBody([
      ...opening,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'computer_screenshot', arguments: '{}' } }],
      },
      {
        role: 'tool',
        content: 'Screenshot 1560x880 captured.',
        tool_call_id: 'call_1',
        images: [{ dataUrl: PNG_1PX, mimeType: 'image/png' }],
      },
    ]).messages
    const blocks = toolResultBlock(messages).content as Array<{ type: string; text?: string }>
    // image-first：Anthropic 兼容网关只解析开头连续的 image block
    expect(blocks.map((b) => b.type)).toEqual(['image', 'text'])
    expect(blocks[1]!.text).toBe('Screenshot 1560x880 captured.')
  })

  it('无图工具结果仍是字符串 content（保持原 wire 形态）', () => {
    const messages = anthropicBody([...opening, ...toolTurn('done')]).messages
    expect(toolResultBlock(messages).content).toBe('done')
  })

  it('空内容的工具结果仍有占位，不会产生空 content', () => {
    const messages = anthropicBody([
      ...opening,
      ...toolTurn('', [{ dataUrl: PNG_1PX, mimeType: 'image/png' }]),
    ]).messages
    const blocks = toolResultBlock(messages).content as Array<{ type: string; text?: string }>
    expect(blocks.map((b) => b.type)).toEqual(['image', 'text'])
    expect(blocks[1]!.text).toBe('(empty)')
  })

  it('dataUrl 解析失败的图被丢弃，退化为纯文本而不是发空 content', () => {
    const messages = anthropicBody([
      ...opening,
      ...toolTurn('done', [{ dataUrl: '/tmp/a.png', mimeType: 'image/png' }]),
    ]).messages
    expect(toolResultBlock(messages).content).toBe('done')
  })
})
