import type { ApiCompat, ThinkingStyle, TokenUsage } from '../types/agent'
import { DEFAULT_THINKING_STYLE } from '../types/agent'

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
  _cacheControl?: boolean
  _systemSuffix?: string
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
  /** 思考在请求体里的表达方式（模型级声明）；未设则按 compat 推断 */
  thinkingStyle?: ThinkingStyle
  /** 是否流式 */
  stream: boolean
  /** anthropic 专用：messageId → 带 signature 的原始 thinking block */
  thinkingBlocks?: Map<string, AnthropicThinkingBlock[]>
  promptCaching?: boolean
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

  // 思考开关 —— 各家 OpenAI 兼容实现参数不统一，由模型级声明（thinkingStyle）决定，
  // 不再用模型名字符串猜测。未声明时按协议回退默认。
  if (o.thinking) {
    const style = o.thinkingStyle ?? DEFAULT_THINKING_STYLE.openai
    switch (style) {
      case 'effort':
        // OpenAI 推理模型：只发 reasoning_effort，绝不混发 enable_thinking
        if (o.reasoningEffort) body.reasoning_effort = o.reasoningEffort
        break
      case 'glm':
        // 智谱 GLM：thinking 对象；clear_thinking=false 保留推理内容以延续上下文
        body.thinking = { type: 'enabled', clear_thinking: false }
        break
      case 'auto':
        // 模型自行决定（如 DeepSeek Reasoner），无需额外参数
        break
      case 'enable':
      default:
        body.enable_thinking = true
        // 档位模式：enable 型端点用预算表达强度（Qwen 等支持 thinking_budget）
        {
          const budget = o.reasoningEffort ? EFFORT_BUDGET[o.reasoningEffort] : o.thinkingBudget
          if (budget) body.thinking_budget = budget
        }
    }
  }

  return body
}

/** 去掉只在前端流转的内部字段，别发给服务端 */
function stripInternal(m: NeutralMessage) {
  const { _msgId: _, _cacheControl: __, _systemSuffix, ...rest } = m
  if (m.role === 'system' && _systemSuffix) {
    return { ...rest, content: `${m.content}\n\n${_systemSuffix}` }
  }
  return rest
}

/** Anthropic content block（请求侧） */
type AnthropicCacheControl = { type: 'ephemeral' }
type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: AnthropicCacheControl }
type AnthropicBlock =
  | AnthropicTextBlock
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | AnthropicThinkingBlock

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

/** Anthropic 思考预算下限（API 硬性要求） */
const MIN_THINKING_BUDGET = 1024

/**
 * 思考档位 → Anthropic budget_tokens。
 * Anthropic 没有离散档位，用预算近似表达强度（参考 Claude Code 的 effort→budget 思路）。
 * minimal 贴近下限，xhigh 给足预算；最终还会被 max_tokens-1 钳制。
 */
const EFFORT_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  max: 16000,
  xhigh: 32000,
}

function buildAnthropicBody(o: BuildBodyOptions): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(o.messages, o.thinkingBlocks, o.promptCaching !== false)

  const body: Record<string, unknown> = {
    model: o.model,
    messages,
    // Anthropic 的 max_tokens 是必填项
    max_tokens: o.maxTokens,
    stream: o.stream,
  }
  if (system.length > 0) body.system = system

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
    // 档位优先 → 显式 budget → 默认 4096
    const fromEffort = o.reasoningEffort ? EFFORT_BUDGET[o.reasoningEffort] : undefined
    const desired = fromEffort ?? o.thinkingBudget ?? Math.min(headroom, 4096)
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
  thinkingBlocks?: Map<string, AnthropicThinkingBlock[]>,
  promptCaching = true
): { system: AnthropicTextBlock[]; messages: AnthropicMessage[] } {
  const system: AnthropicTextBlock[] = []
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
      if (m.content) {
        system.push({
          type: 'text',
          text: m.content,
          ...(promptCaching && m._cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
        })
      }
      if (m._systemSuffix) system.push({ type: 'text', text: m._systemSuffix })
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

  // 必须以 user 开头：开头若是 assistant 就处理掉。
  // 纯工具轮（无正文）的 orphan assistant 直接丢弃；带正文的（如压缩摘要）转为 user 保留，
  // 否则 Anthropic 会把它丢掉，导致压缩后的上下文信息丢失。
  while (out.length > 0 && out[0].role === 'assistant') {
    const head = out[0]
    const texts = head.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    if (texts.length > 0) {
      out[0] = { role: 'user', content: texts }
    } else {
      out.shift()
    }
  }

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
  /** anthropic: block index → 累积的 signature（允许服务端分片下发签名） */
  thinkingSignatures: Map<number, string>
  /** anthropic: message_start 里拿到的 input_tokens */
  inputTokens: number
  /** anthropic: 累计的 output_tokens */
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  /** openai 兼容：是否已经在 <think> 标签内（标签可能被切碎分片下发） */
  insideThinkTag: boolean
  /** openai 兼容：跨分片累积尚未匹配的 <think> 开标签（处理 "<thi" 跨片） */
  pendingText: string
}

export const createParserState = (): ParserState => ({
  blockTypes: new Map(),
  thinkingText: new Map(),
  thinkingSignatures: new Map(),
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  insideThinkTag: false,
  pendingText: '',
})

/**
 * 解析一条 SSE data 行的 JSON 负载，产出 0..n 个归一化事件。
 *
 * @param compat 协议
 * @param json   已 JSON.parse 的负载
 * @param state  跨 chunk 状态
 */
export function parseEvent(compat: ApiCompat, json: unknown, state: ParserState): NormalizedEvent[] {
  return compat === 'anthropic' ? parseAnthropicEvent(json, state) : parseOpenAIEvent(json, state)
}

/**
 * 把 content 文本切成 [thinking, content, thinking, content, ...] 片段。
 * 处理跨分片的 <think>/</think> 标签（标签可能被切碎分片下发）。
 * 借助 state.insideThinkTag / state.pendingText 在分片间保持状态。
 */
function splitThinkTags(text: string, state: ParserState): { thinking: string; content: string }[] {
  const out: { thinking: string; content: string }[] = []
  let working = state.pendingText + text
  state.pendingText = ''

  while (working.length > 0) {
    if (state.insideThinkTag) {
      // 在 <think> 标签内，查找 </think>
      const endIdx = working.indexOf('</think>')
      if (endIdx === -1) {
        // 没找到结束标签，全部当 thinking，保留最后 7 字符防止标签被切
        const safeLen = Math.max(0, working.length - 7)
        if (safeLen > 0) {
          out.push({ thinking: working.slice(0, safeLen), content: '' })
          working = working.slice(safeLen)
        } else {
          state.pendingText = working
          working = ''
        }
      } else {
        if (endIdx > 0) out.push({ thinking: working.slice(0, endIdx), content: '' })
        out.push({ content: '', thinking: '' })
        state.insideThinkTag = false
        working = working.slice(endIdx + '</think>'.length)
      }
    } else {
      // 在标签外，查找下一个 <think>
      const startIdx = working.indexOf('<think>')
      if (startIdx === -1) {
        // 没找到开标签，全部当 content，保留最后 7 字符防止标签被切
        const safeLen = Math.max(0, working.length - 7)
        if (safeLen > 0) {
          out.push({ thinking: '', content: working.slice(0, safeLen) })
          working = working.slice(safeLen)
        } else {
          state.pendingText = working
          working = ''
        }
      } else {
        if (startIdx > 0) out.push({ thinking: '', content: working.slice(0, startIdx) })
        state.insideThinkTag = true
        working = working.slice(startIdx + '<think>'.length)
      }
    }
  }

  return out.filter((p) => p.thinking || p.content)
}

function parseOpenAIEvent(json: unknown, state: ParserState): NormalizedEvent[] {
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
  if (delta?.reasoning_content) {
    events.push({ kind: 'thinking', text: delta.reasoning_content })
  } else if (delta?.thinking_content) {
    events.push({ kind: 'thinking', text: delta.thinking_content })
  } else if (delta?.content) {
    // 部分模型（如 MiniMax M2.7）把思考内联在 content 里，用 <think>...</think> 包裹
    // 跨分片解析标签，避免标签被切碎时漏判
    for (const part of splitThinkTags(delta.content, state)) {
      if (part.thinking) events.push({ kind: 'thinking', text: part.thinking })
      if (part.content) events.push({ kind: 'content', text: part.content })
    }
  }

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

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

function parseAnthropicEvent(json: unknown, state: ParserState): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  const ev = json as {
    type?: string
    index?: number
    message?: { usage?: AnthropicUsage }
    content_block?: { type?: string; id?: string; name?: string }
    delta?: {
      type?: string
      text?: string
      thinking?: string
      signature?: string
      partial_json?: string
      stop_reason?: string
    }
    usage?: AnthropicUsage
    error?: { message?: string; type?: string }
  }

  switch (ev.type) {
    case 'message_start': {
      const u = ev.message?.usage
      if (u) {
        state.inputTokens = u.input_tokens ?? 0
        state.outputTokens = u.output_tokens ?? 0
        state.cacheCreationInputTokens = u.cache_creation_input_tokens ?? 0
        state.cacheReadInputTokens = u.cache_read_input_tokens ?? 0
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
        // 签名可能跨多个 delta 分片下发 → 先累积，等 block 结束再一次性提交完整 block
        state.thinkingSignatures.set(idx, (state.thinkingSignatures.get(idx) || '') + d.signature)
      } else if (d.type === 'input_json_delta' && d.partial_json !== undefined) {
        events.push({ kind: 'toolCallDelta', index: idx, argsDelta: d.partial_json })
      }
      break
    }

    case 'content_block_stop': {
      const idx = ev.index ?? 0
      if (state.blockTypes.get(idx) === 'thinking') {
        const thinking = state.thinkingText.get(idx) || ''
        const signature = state.thinkingSignatures.get(idx)
        // 只有拿到完整签名才提交（回放时缺签名会导致下一轮 400）
        if (signature) {
          events.push({ kind: 'signature', index: idx, signature, thinking })
        }
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
  prompt_tokens: s.inputTokens + s.cacheCreationInputTokens + s.cacheReadInputTokens,
  completion_tokens: s.outputTokens,
  total_tokens: s.inputTokens + s.cacheCreationInputTokens + s.cacheReadInputTokens + s.outputTokens,
  cache_creation_input_tokens: s.cacheCreationInputTokens,
  cache_read_input_tokens: s.cacheReadInputTokens,
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
