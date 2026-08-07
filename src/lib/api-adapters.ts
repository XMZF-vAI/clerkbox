import type { ApiCompat, TokenUsage } from '../types/agent'

/**
 * OpenAI / Anthropic 双协议适配层。
 *
 * 上层（use-agent / compact）只认一套「中立」消息结构 —— 就是原来的 OpenAI 形状
 * （role + content + tool_calls + tool_call_id + reasoning_content）。本文件负责：
 *   1. 把中立结构翻译成目标协议的请求体
 *   2. 把目标协议的 SSE 事件归一化成同一组回调事件
 * 这样两条协议共用同一个 ReAct 循环、同一个 UI、同一套 token 统计。
 */

// ── 中立消息结构（= 上层一直在用的形状） ──

export interface NeutralMessage {
  role: string
  content: string
  tool_calls?: unknown
  tool_call_id?: string
  reasoning_content?: string
  /** 消息 id，用于在思考签名缓存里查回原始 thinking block（仅 anthropic 需要） */
  _msgId?: string
}

export interface NeutralTool {
  name: string
  description: string
  parameters: object
}

export interface BuildBodyOptions {
  model: string
  messages: NeutralMessage[]
  tools: NeutralTool[]
  temperature: number
  maxTokens: number
  /** 是否开启思考 */
  thinking: boolean
  thinkingBudget?: number
  reasoningEffort?: import('../types/agent').ReasoningEffort
  /** 是否流式 */
  stream: boolean
  /** anthropic 专用：messageId → 带 signature 的原始 thinking block */
  thinkingBlocks?: Map<string, AnthropicThinkingBlock[]>
}

/** Anthropic 原始 thinking block（含签名，回放时必须原样带上） */
export interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
  signature: string
}

// ── 端点与请求头 ──

const trimSlash = (s: string) => s.replace(/\/+$/, '')

/**
 * 端点归一化。与主进程 `electron/api-proxy.ts` 的同名函数保持一致 ——
 * 两处都需要（渲染进程直连走这里，主进程代理走那里）。
 *
 * OpenAI 侧 baseUrl 惯例已含 `/v1`，拼 `/chat/completions`。
 * Anthropic 侧要 `/v1/messages`，用户填 `https://api.anthropic.com` 或
 * `.../v1` 都能用 —— 已以 `/v1` 结尾就不再补。
 */
export function endpointFor(compat: ApiCompat, baseUrl: string, kind: 'chat' | 'models'): string {
  const base = trimSlash(baseUrl)
  if (compat === 'anthropic') {
    const withV1 = /\/v1$/.test(base) ? base : `${base}/v1`
    return kind === 'chat' ? `${withV1}/messages` : `${withV1}/models`
  }
  return kind === 'chat' ? `${base}/chat/completions` : `${base}/models`
}

const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 构造请求头。
 * `direct=true`（渲染进程直连）时给 Anthropic 加 dangerous-direct-browser-access ——
 * 否则浏览器发出的预检会被拒。走主进程代理时不需要这个头。
 */
export function headersFor(
  compat: ApiCompat,
  apiKey: string,
  opts: { direct?: boolean } = {}
): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (compat === 'anthropic') {
    if (apiKey) h['x-api-key'] = apiKey
    h['anthropic-version'] = ANTHROPIC_VERSION
    if (opts.direct) h['anthropic-dangerous-direct-browser-access'] = 'true'
  } else if (apiKey) {
    h.Authorization = `Bearer ${apiKey}`
  }
  return h
}

// ── 请求体构造 ──

export function buildRequestBody(compat: ApiCompat, o: BuildBodyOptions): Record<string, unknown> {
  return compat === 'anthropic' ? buildAnthropicBody(o) : buildOpenAIBody(o)
}

function buildOpenAIBody(o: BuildBodyOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: o.model,
    messages: o.messages.map(stripInternal),
    temperature: o.temperature,
    max_tokens: o.maxTokens,
  }
  if (o.stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  } else {
    body.stream = false
  }

  if (o.tools.length > 0) {
    body.tools = o.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  // 思考开关 —— 各家 OpenAI 兼容实现参数不统一，沿用原有的按模型名分支逻辑
  if (o.thinking) {
    const m = o.model.toLowerCase()
    if (o.reasoningEffort) body.reasoning_effort = o.reasoningEffort
    if (m.includes('reasoner') || m.includes('r1')) {
      // DeepSeek R1 / reasoner：自动思考，无需额外参数
    } else if (m.includes('glm')) {
      // 智谱 GLM：thinking 对象；clear_thinking=false 保留推理内容以延续上下文
      body.thinking = { type: 'enabled', clear_thinking: false }
    } else {
      body.enable_thinking = true
      if (o.thinkingBudget) body.thinking_budget = o.thinkingBudget
    }
  }

  return body
}

/** 去掉只在前端流转的内部字段，别发给服务端 */
function stripInternal(m: NeutralMessage) {
  const { _msgId: _, ...rest } = m
  return rest
}

/** Anthropic content block（请求侧） */
type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | AnthropicThinkingBlock

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

/** Anthropic 思考预算下限（API 硬性要求） */
const MIN_THINKING_BUDGET = 1024

function buildAnthropicBody(o: BuildBodyOptions): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(o.messages, o.thinkingBlocks)

  const body: Record<string, unknown> = {
    model: o.model,
    messages,
    // Anthropic 的 max_tokens 是必填项
    max_tokens: o.maxTokens,
    stream: o.stream,
  }
  if (system) body.system = system

  if (o.tools.length > 0) {
    // 扁平结构 + input_schema（不是 OpenAI 的 function 包装 + parameters）
    body.tools = o.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  // 思考：budget 必须 < max_tokens 且 >= 1024；开启思考时 temperature 只能是 1
  let thinkingOn = false
  if (o.thinking) {
    const headroom = o.maxTokens - 1
    const desired = o.thinkingBudget ?? Math.min(headroom, 4096)
    const budget = Math.min(Math.max(desired, MIN_THINKING_BUDGET), headroom)
    // max_tokens 太小时容不下最小预算，此时只能不开思考
    if (budget >= MIN_THINKING_BUDGET) {
      body.thinking = { type: 'enabled', budget_tokens: budget }
      thinkingOn = true
    }
  }
  // 未开思考才允许自定义 temperature
  if (!thinkingOn) body.temperature = o.temperature
  else body.temperature = 1

  return body
}

/**
 * 中立消息 → Anthropic messages。
 *
 * 处理四件 Anthropic 的硬性约束：
 *   1. system 必须提到顶层，不能作为 messages 成员
 *   2. 只能 user / assistant，且必须以 user 开头 —— 连续同角色要合并成一条多 block 消息
 *   3. tool 结果要变成 user 消息里的 tool_result block（同一轮的多个结果合进一条）
 *   4. 空 text block 会被拒 —— 直接过滤掉
 */
export function toAnthropicMessages(
  msgs: NeutralMessage[],
  thinkingBlocks?: Map<string, AnthropicThinkingBlock[]>
): { system: string; messages: AnthropicMessage[] } {
  let system = ''
  const out: AnthropicMessage[] = []

  /** 追加 block；与上一条同角色则合并，避免出现连续同角色消息 */
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const m of msgs) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (m.content || '')
      continue
    }

    if (m.role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id || '',
        // 空内容也要给个占位，否则部分实现会报错
        content: m.content || '(empty)',
      }])
      continue
    }

    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = []

      // 带 tool_use 的轮次必须原样回放 thinking block（含 signature），否则 400。
      // 我们库里只存纯文本思考、没有签名 —— 只有本轮 in-memory 缓存里的才带签名，
      // 历史消息（从 DB 读出来的）一律不回放。
      const cached = m._msgId ? thinkingBlocks?.get(m._msgId) : undefined
      if (cached && cached.length > 0) blocks.push(...cached)

      if (m.content) blocks.push({ type: 'text', text: m.content })

      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<{
          id: string
          function?: { name?: string; arguments?: string }
        }>) {
          let input: unknown = {}
          const raw = tc.function?.arguments
          if (raw) {
            try { input = JSON.parse(raw) } catch { input = {} }
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input })
        }
      }

      push('assistant', blocks)
      continue
    }

    // user
    if (m.content) push('user', [{ type: 'text', text: m.content }])
  }

  // 必须以 user 开头：开头若是 assistant 就丢掉（没有对应用户输入的助手消息无意义）
  while (out.length > 0 && out[0].role === 'assistant') out.shift()

  return { system, messages: out }
}

/**
 * 判断某条 assistant 消息能否安全回放思考块。
 * 带 tool_calls 但没有签名缓存 → 该次请求必须关掉 thinking，否则 Anthropic 报 400。
 */
export function canKeepThinking(
  msgs: NeutralMessage[],
  thinkingBlocks?: Map<string, AnthropicThinkingBlock[]>
): boolean {
  for (const m of msgs) {
    if (m.role !== 'assistant') continue
    const hasToolCalls = Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0
    if (!hasToolCalls) continue
    const cached = m._msgId ? thinkingBlocks?.get(m._msgId) : undefined
    if (!cached || cached.length === 0) return false
  }
  return true
}

// ── SSE 事件归一化 ──

/** 归一化后的流事件（上层回调只认这几种） */
export type NormalizedEvent =
  | { kind: 'content'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCallDelta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { kind: 'signature'; index: number; signature: string; thinking: string }
  | { kind: 'finish'; reason: string }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'error'; message: string }

/** 跨 chunk 累积的解析状态（Anthropic 需要按 block index 记类型与累积内容） */
export interface ParserState {
  /** anthropic: block index → 该 block 的类型 */
  blockTypes: Map<number, string>
  /** anthropic: block index → 累积的 thinking 文本（配签名一起回放） */
  thinkingText: Map<number, string>
  /** anthropic: message_start 里拿到的 input_tokens */
  inputTokens: number
  /** anthropic: 累计的 output_tokens */
  outputTokens: number
}

export const createParserState = (): ParserState => ({
  blockTypes: new Map(),
  thinkingText: new Map(),
  inputTokens: 0,
  outputTokens: 0,
})

/**
 * 解析一条 SSE data 行的 JSON 负载，产出 0..n 个归一化事件。
 *
 * @param compat 协议
 * @param json   已 JSON.parse 的负载
 * @param state  跨 chunk 状态
 */
export function parseEvent(compat: ApiCompat, json: unknown, state: ParserState): NormalizedEvent[] {
  return compat === 'anthropic' ? parseAnthropicEvent(json, state) : parseOpenAIEvent(json)
}

function parseOpenAIEvent(json: unknown): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  const data = json as {
    usage?: TokenUsage
    choices?: Array<{
      delta?: {
        content?: string
        reasoning_content?: string
        thinking_content?: string
        tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>
      }
      finish_reason?: string | null
    }>
  }

  // usage 通常在独立的最后一个 chunk 里
  if (data.usage) events.push({ kind: 'usage', usage: data.usage })

  const choice = data.choices?.[0]
  if (!choice) return events
  const delta = choice.delta

  // 思考字段各家命名不同：DeepSeek/GLM 用 reasoning_content，部分 GLM 版本用 thinking_content
  if (delta?.reasoning_content) events.push({ kind: 'thinking', text: delta.reasoning_content })
  else if (delta?.thinking_content) events.push({ kind: 'thinking', text: delta.thinking_content })

  if (delta?.content) events.push({ kind: 'content', text: delta.content })

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      events.push({
        kind: 'toolCallDelta',
        index: tc.index,
        id: tc.id,
        name: tc.function?.name,
        argsDelta: tc.function?.arguments,
      })
    }
  }

  if (choice.finish_reason) events.push({ kind: 'finish', reason: choice.finish_reason })

  return events
}

/** Anthropic stop_reason → OpenAI finish_reason（UI 里判 'length' 显示截断提示） */
export function mapStopReason(stop: string): string {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return stop
  }
}

function parseAnthropicEvent(json: unknown, state: ParserState): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  const ev = json as {
    type?: string
    index?: number
    message?: { usage?: { input_tokens?: number; output_tokens?: number } }
    content_block?: { type?: string; id?: string; name?: string }
    delta?: {
      type?: string
      text?: string
      thinking?: string
      signature?: string
      partial_json?: string
      stop_reason?: string
    }
    usage?: { input_tokens?: number; output_tokens?: number }
    error?: { message?: string; type?: string }
  }

  switch (ev.type) {
    case 'message_start': {
      const u = ev.message?.usage
      if (u) {
        state.inputTokens = u.input_tokens ?? 0
        state.outputTokens = u.output_tokens ?? 0
        events.push({ kind: 'usage', usage: usageFrom(state) })
      }
      break
    }

    case 'content_block_start': {
      const idx = ev.index ?? 0
      const type = ev.content_block?.type || ''
      state.blockTypes.set(idx, type)
      if (type === 'tool_use') {
        // 用 block index 当 key，复用上层已有的 toolCallBuffers 结构
        events.push({
          kind: 'toolCallDelta',
          index: idx,
          id: ev.content_block?.id,
          name: ev.content_block?.name,
        })
      }
      break
    }

    case 'content_block_delta': {
      const idx = ev.index ?? 0
      const d = ev.delta
      if (!d) break
      if (d.type === 'text_delta' && d.text) {
        events.push({ kind: 'content', text: d.text })
      } else if (d.type === 'thinking_delta' && d.thinking) {
        state.thinkingText.set(idx, (state.thinkingText.get(idx) || '') + d.thinking)
        events.push({ kind: 'thinking', text: d.thinking })
      } else if (d.type === 'signature_delta' && d.signature) {
        events.push({
          kind: 'signature',
          index: idx,
          signature: d.signature,
          thinking: state.thinkingText.get(idx) || '',
        })
      } else if (d.type === 'input_json_delta' && d.partial_json !== undefined) {
        events.push({ kind: 'toolCallDelta', index: idx, argsDelta: d.partial_json })
      }
      break
    }

    case 'message_delta': {
      if (ev.usage?.output_tokens !== undefined) {
        state.outputTokens = ev.usage.output_tokens
        events.push({ kind: 'usage', usage: usageFrom(state) })
      }
      if (ev.delta?.stop_reason) {
        events.push({ kind: 'finish', reason: mapStopReason(ev.delta.stop_reason) })
      }
      break
    }

    case 'error': {
      events.push({ kind: 'error', message: ev.error?.message || ev.error?.type || 'Unknown stream error' })
      break
    }

    // message_stop / content_block_stop / ping：无需处理
  }

  return events
}

const usageFrom = (s: ParserState): TokenUsage => ({
  prompt_tokens: s.inputTokens,
  completion_tokens: s.outputTokens,
  total_tokens: s.inputTokens + s.outputTokens,
})

// ── 非流式响应（compact 用） ──

/** 从非流式响应里取出正文文本 */
export function extractText(compat: ApiCompat, data: unknown): string {
  if (compat === 'anthropic') {
    const d = data as { content?: Array<{ type?: string; text?: string }> }
    if (!Array.isArray(d?.content)) return ''
    return d.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
  }
  const d = data as { choices?: Array<{ message?: { content?: string } }> }
  return d?.choices?.[0]?.message?.content || ''
}
