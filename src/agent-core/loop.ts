/**
 * Agent 编排核心（批次 B · P1 抽核）
 *
 * 从 use-agent.ts 抽出的、与 React/进程无关的 ReAct 编排逻辑：
 * 模型调用与流解析、提示词构造、重试、自动/手动压缩衔接、doom-loop 防护、
 * 工具执行与权限检查、goal 评估闭环、子 agent 循环。
 *
 * 全部环境依赖经 AgentPorts 注入；会话级状态挂在 SessionContext。
 * 行为与抽核前的 use-agent.ts 严格等价（P1 验收红线）。
 */
import i18n from '../i18n'
import {
  buildRequestBody,
  canKeepThinking,
  createParserState,
  parseEvent,
  flushParserState,
  type AnthropicThinkingBlock,
  type NeutralMessage,
} from '../lib/api-adapters'
import { sseLines } from '../lib/api-transport'
import { compactConversation, findKeepBoundaryIndex } from '../lib/compact'
import { getApiVisibleMessages } from '../lib/context-usage'
import { HARNESS_MODE_CONTENT, normalizeHarnessMode } from '../lib/harness-modes'
import { isDangerousCommand } from '../lib/permission-engine'
import { matchPermissionRule } from '../lib/permission-rules'
import { isPathInside, isSystemPath, resolveToolPath, normalizePathForComparison } from '../lib/path-safety'
import { SYSTEM_PROMPT, CLERKBOX_PROMPT, PLAN_MODE_PROMPT, SPEC_MODE_PROMPT, GOAL_MODE_PROMPT, GOAL_EVALUATOR_PROMPT } from '../lib/prompts'
import { renderSkillCatalog, type SkillCatalogEntry } from '../lib/skill-catalog'
import { TokenTracker } from '../lib/token-tracker'
import { estimateTokensForText } from '../lib/token-estimate'
import type {
  AgentDefinition,
  ApiCompat,
  FileMutation,
  GoalVerdict,
  HarnessMode,
  Message,
  ReadFileSnapshot,
  TaskMode,
  ToolCall,
  ToolResult,
  ToolResultImage,
  StreamingToolCall,
  TokenUsage,
} from '../types/agent'
import type { AgentPorts, AgentSettings, PermissionApproval } from './ports'
import {
  registerSubagentControl,
  unregisterSubagentControl,
  type SessionContext,
  type SubagentRunRecord,
} from './session-context'
import type { ToolContext } from '../lib/tool-registry'
import { gapFromToolCall, isRewindableUserMessage } from '../lib/rewind'
import { agentActionFamily, agentActionGrantKey, isAgentActionToolReadOnly } from '../lib/agent-actions'
import type { WorkflowRun } from '../lib/workflow-runtime'
import { abortWorkflowRunsForSession } from '../lib/workflow-runtime'
import { WORKFLOW_GATED_TOOLS } from '../lib/workflow-tools'
import { escapeEnvelopeSpoofing, escapeExternalText, SYSTEM_INJECTION_DISCLAIMER } from '../lib/injection-hygiene'

export const makeId = (): string => `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** 每张多模态图片的固定 token 粗估成本（视觉输入按图片 token 计价，粗估 1000/张，用于截断/预算估算） */
const IMAGE_TOKEN_ESTIMATE = 1000

/** 从 data URL 前缀解析 MIME 类型（如 image/png）；非 data URL 形式返回 undefined */
function mimeFromDataUrl(dataUrl: string): string | undefined {
  return /^data:([^;,]+)/.exec(dataUrl)?.[1]
}

/**
 * 历史里最多回传几张工具结果截图。
 * 只取最近几张不是省 token 的权宜之计：一轮浏览器任务动辄产出几十张截图，
 * 全塞回上下文既贵又会把「当前这一帧」淹掉。更早的截图文本里已经写明了落盘路径，
 * 模型真要回看可以自己 read_file。
 */
const TOOL_RESULT_IMAGES_MAX = 2
/** 截图 data URL 的进程内缓存：同一张图在后续每一轮都会被重新求值，不能每轮读一次盘 */
const TOOL_IMAGE_CACHE_MAX = 6
const toolImageDataUrlCache = new Map<string, string | null>()

async function resolveToolResultImages(
  ports: AgentPorts,
  results: ToolResult[] | undefined,
): Promise<Array<{ dataUrl: string; mimeType: string }> | undefined> {
  if (!results || results.length === 0) return undefined
  const out: Array<{ dataUrl: string; mimeType: string }> = []
  for (const result of results) {
    if (!result.images || result.images.length === 0) continue
    for (const img of result.images) {
      const cacheKey = `${img.path}\u0000${img.mimeType}`
      let dataUrl = toolImageDataUrlCache.get(cacheKey)
      if (dataUrl === undefined) {
        dataUrl = await ports.env.readImageAsDataUrl(img.path, img.mimeType)
        // Map 按插入序迭代，超量时淘汰最旧的一条
        if (toolImageDataUrlCache.size >= TOOL_IMAGE_CACHE_MAX) {
          const oldest = toolImageDataUrlCache.keys().next().value
          if (oldest !== undefined) toolImageDataUrlCache.delete(oldest)
        }
        toolImageDataUrlCache.set(cacheKey, dataUrl)
      }
      if (dataUrl) out.push({ dataUrl, mimeType: img.mimeType })
    }
  }
  return out.length > 0 ? out : undefined
}

/** 轻量字符串哈希（djb2）—— dev 下校验静态 system 段是否跨请求字节一致 */
function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** Combine cancellation sources on platforms that do not implement AbortSignal.any. */
function combineAbortSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const abortSignalWithAny = AbortSignal as typeof AbortSignal & {
    any?: (sources: AbortSignal[]) => AbortSignal
  }
  if (typeof abortSignalWithAny.any === 'function') {
    return { signal: abortSignalWithAny.any(signals), dispose: () => {} }
  }

  const combined = new AbortController()
  const listeners = signals.map((source) => {
    const abort = () => combined.abort(source.reason)
    if (source.aborted) abort()
    else source.addEventListener('abort', abort, { once: true })
    return { source, abort }
  })
  return {
    signal: combined.signal,
    dispose: () => listeners.forEach(({ source, abort }) => source.removeEventListener('abort', abort)),
  }
}

/**
 * 单次 run 允许的工具执行轮数上限。
 *
 * **别再往回调。** 旧值 100 在「模型能力较弱 + 任务粒度粗」的年代是合理护栏，
 * 现在两个前提都反了：
 *   1. 模型变强 → 能自己拆出更细的步骤、一步一个工具调用，而不是一口气干完；
 *   2. **有些任务天生一轮一步** —— computer use 的「截图 → 点击 → 截图 → 点击」，
 *      每次就是一个批次 = 一轮。100 轮只够点一百次，对付一个来回几十次的界面根本不够。
 *
 * 一轮 = 一次 LLM 请求，成本早已被 abort 按钮和自动压缩兜住，
 * 卡在一个明显不够的数上换来的不是安全，是「AI 干到一半被系统按停」。
 */
const MAX_REACT_ITERATIONS = 500 // Loop exits when model stops calling tools or hits this cap

/** 最后一轮注入的收尾指令（参考 opencode MAX_STEPS_PROMPT）：工具停用，强制文字总结 */
const MAX_STEPS_MESSAGE = `⚠️ Maximum tool-call turns reached for this run. Tool calls are no longer executed. Reply NOW with a final text summary: what was accomplished, key results and file paths, and what remains unfinished. Do not attempt any more tool calls.`

/** Goal 自动续跑护栏（防空转与失控）：单次运行评估上限 / 连续无工具调用的评估上限 */
const GOAL_MAX_EVALUATIONS_PER_RUN = 20
const GOAL_IDLE_EVALUATION_LIMIT = 2
const GOAL_TRANSCRIPT_MESSAGE_LIMIT = 24
const GOAL_TRANSCRIPT_CHARS_LIMIT = 40000

/** 从对话消息构建评估器用的转录文本（user/assistant/tool 正文，长内容截断，越新越靠后） */
function buildGoalTranscript(messages: Message[]): string {
  const recent = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && !m.isSubAgentCard)
    .slice(-GOAL_TRANSCRIPT_MESSAGE_LIMIT)
  let text = recent.map((m) => {
    const body = (m.content || '').trim().slice(0, 2000) || '(no text)'
    const calls = m.toolCalls?.length ? `\n[tool calls: ${m.toolCalls.map((tc) => tc.name).join(', ')}]` : ''
    return `## ${m.role}\n${body}${calls}`
  }).join('\n\n')
  if (text.length > GOAL_TRANSCRIPT_CHARS_LIMIT) {
    text = text.slice(text.length - GOAL_TRANSCRIPT_CHARS_LIMIT)
  }
  return text
}

/** 工具调用被拒绝时的统一文案 */
const toolCallRefusal = (name: string, reason: string): string =>
  `Tool call "${name}" was not executed: ${reason}`

/** 截断响应（finishReason=length）时工具调用一律不执行：流式参数经 JSON 抢救解析后
 *  可能"恰好合法但不完整"，执行有副作用的工具会损坏文件。要求模型带完整参数重发。 */
const TRUNCATED_TOOL_CALL_REASON =
  'the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.'

/** 连续 3 次完全相同的工具调用 → 拒绝执行（doom-loop 检测） */
const DOOM_LOOP_THRESHOLD = 3

/** 自动压缩连续失败熔断阈值（参考 Claude Code：3 次失败后停止自动重试，防死亡螺旋） */
const MAX_AUTO_COMPACT_FAILURES = 3

// ── microcompact（工具结果级清理，参考 Claude Code Function Result Clearing）──
/** 清空老工具结果时保留的最近条数 */
const MICROCOMPACT_KEEP_RECENT = 6
/** 可被清空的工具：输出大且可重跑。编辑/子代理/交互结果小而关键，不清。
 *  app_* 自我管控工具同属「只读 + 可随时重问」，与 read_file 同类。 */
const MICROCOMPACT_CLEARABLE_TOOLS = new Set([
  'read_file', 'read_image', 'execute_command', 'search_files', 'search_content', 'list_dir', 'web_search', 'web_fetch',
  'app_status', 'app_list_sessions', 'app_read_session', 'app_list_skills', 'app_list_agents', 'app_search_memory', 'app_list_mcp_servers',
])
const CLEARED_TOOL_RESULT_PLACEHOLDER =
  '[Old tool result cleared to free context. The key info should already be captured in earlier replies; re-run the tool if you need it again.]'
const DOOM_LOOP_REFUSAL =
  'this exact call has already been made repeatedly with identical arguments and the results did not change. Stop repeating it: change the approach, inspect the previous results, or explain the blocker to the user.'

/** git 仓库状态探测（每个 workingDir 只探测一次，供系统提示环境段使用） */
const gitRepoCache = new Map<string, boolean>()
async function detectGitRepo(
  runShell: AgentPorts['env']['runShell'],
  workingDir: string
): Promise<boolean> {
  const cached = gitRepoCache.get(workingDir)
  if (cached !== undefined) return cached
  try {
    const r = await runShell('git rev-parse --is-inside-work-tree', workingDir)
    const inside = r.exitCode === 0 && r.stdout.trim() === 'true'
    gitRepoCache.set(workingDir, inside)
    return inside
  } catch {
    return false
  }
}

/** doom-loop 判定：签名序列末尾已有 THRESHOLD-1 次连续相同调用，则本次拒绝 */
function isDoomLoopSig(signatures: string[], sig: string): boolean {
  const n = signatures.length
  const need = DOOM_LOOP_THRESHOLD - 1
  if (n < need) return false
  for (let i = n - need; i < n; i++) {
    if (signatures[i] !== sig) return false
  }
  return true
}

/** 可重试的 HTTP 状态码（瞬时故障，退避重试） */
const RETRYABLE_CODES = [408, 429, 500, 502, 503, 504]

/** 上下文溢出类错误（重试无用，必须压缩后重放） */
const CONTEXT_OVERFLOW_PATTERN =
  /context length|prompt is too long|too many tokens|maximum context|context_length_exceeded|request too large|exceed[s]? the (maximum )?context|context window/i

/** 配额/计费类错误（重试无用，直接失败提示用户） */
const NON_RETRYABLE_QUOTA_PATTERN =
  /insufficient_quota|quota exceeded|out of budget|billing|insufficient balance|payment required|credit.*(exhaust|expired)/i

/** 判断错误是否属于「上下文溢出」——触发强制压缩恢复链而非重试。 */
export function isContextOverflowError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false
  const msg = err instanceof Error ? err.message : String(err)
  return CONTEXT_OVERFLOW_PATTERN.test(msg)
}

/** 判断错误是否属于「瞬时、值得重试」的类型（429/502/超时/网络中断等）。
 *  溢出与配额/计费类错误明确不可重试——前者要压缩，后者要用户处理。 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false
  const msg = err instanceof Error ? err.message : String(err)
  if (CONTEXT_OVERFLOW_PATTERN.test(msg)) return false
  if (NON_RETRYABLE_QUOTA_PATTERN.test(msg)) return false
  // 网络 / 超时 / 连接类
  if (/timeout|abort|network|fetch failed|ECONNRESET|socket hang up|ENOTFOUND/i.test(msg)) return true
  // HTTP 状态码（API Error 429 / HTTP 502 等）
  const m = msg.match(/API Error\s+(\d+)/i) || msg.match(/HTTP\s+(\d+)/i)
  if (m && RETRYABLE_CODES.includes(Number(m[1]))) return true
  return false
}

/** 从错误消息提取服务端指定的重试延迟（毫秒）。
 *  错误文本格式由传输层统一生成："API Error 429 (retry after 8000ms): ..." */
export function extractRetryAfterMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/retry after (\d+)ms/i)
  if (!m) return null
  const v = Number(m[1])
  // 上限 60s：服务端要求等更久说明不是瞬时抖动，交给用户决定
  return Number.isFinite(v) && v > 0 ? Math.min(v, 60_000) : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带指数退避的重试：最多 retries 次，间隔按 baseDelayMs 倍增（低增）。
 * 默认间隔 1s → 2s → 4s → 8s → 16s，乘 (1 - random*0.25) 随机抖动防惊群。
 * 服务端通过 Retry-After 头明确指定延迟时（getRetryAfterMs）优先遵循，不加抖动。
 * shouldRetry 返回 false 时立即抛出不再重试。
 * onRetry 在每次「将要重试」时调用（已确定可重试、等待退避前），可用来更新 UI 提示。
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries?: number
    baseDelayMs?: number
    shouldRetry?: (err: unknown) => boolean
    getRetryAfterMs?: (err: unknown) => number | null
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void
  } = {}
): Promise<T> {
  const { retries = 5, baseDelayMs = 1000, shouldRetry = () => true, getRetryAfterMs, onRetry } = opts
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      attempt++
      if (attempt > retries || !shouldRetry(err)) throw err
      const serverDelay = getRetryAfterMs?.(err) ?? null
      const delay = serverDelay ?? baseDelayMs * 2 ** (attempt - 1) * (1 - Math.random() * 0.25)
      onRetry?.(attempt, delay, err)
      await sleep(delay)
    }
  }
}

/** Get working directory for current session, with default fallback.
 *  优先读本会话本次运行时登记的工作目录（sendMessage 设置，finally 清除）。 */
export function getWorkingDir(ports: AgentPorts, ctx: SessionContext): string {
  if (ctx.requestWorkingDir !== undefined) return ctx.requestWorkingDir
  const session = ports.store.getSession(ports.sessionId)
  if (session?.workingDir) return session.workingDir
  return session?.defaultWorkDir || ''
}

/**
 * 解析流式响应。
 *
 * 吃的是传输层给出的**文本分片流**（`AsyncIterable<string>`），而不是 `Response` ——
 * 这样主进程代理与渲染进程直连两条路共用同一份解析代码。
 * 协议差异（OpenAI / Anthropic）由 api-adapters 的 parseEvent 归一化掉。
 */
const parseStream = async (
  stream: { chunks: AsyncIterable<string>; compat: ApiCompat },
  controller: AbortController,
  callbacks: {
    onContent: (text: string) => void
    onThinking: (text: string) => void
    onToolCallUpdate: (calls: Map<number, { id: string; name: string; args: string }>) => void
    onFinish: (reason: string | null) => void
    onUsage: (usage: TokenUsage) => void
    /** anthropic: 收到带签名的 thinking block（用于下一轮回放） */
    onThinkingBlock?: (block: AnthropicThinkingBlock) => void
  }
) => {
  const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>()
  const state = createParserState()

  for await (const payload of sseLines(stream.chunks)) {
    if (controller.signal.aborted) break

    let json: unknown
    try {
      json = JSON.parse(payload)
    } catch {
      continue // 跳过残缺 JSON 分片
    }

    for (const ev of parseEvent(stream.compat, json, state)) {
      switch (ev.kind) {
        case 'content':
          callbacks.onContent(ev.text)
          break
        case 'thinking':
          callbacks.onThinking(ev.text)
          break
        case 'toolCallDelta': {
          const existing = toolCallBuffers.get(ev.index)
          if (existing) {
            if (ev.id) existing.id = ev.id
            if (ev.name) existing.name = ev.name
            if (ev.argsDelta) existing.args += ev.argsDelta
          } else {
            toolCallBuffers.set(ev.index, {
              id: ev.id || `tc-${ev.index}`,
              name: ev.name || '',
              args: ev.argsDelta || '',
            })
          }
          callbacks.onToolCallUpdate(toolCallBuffers)
          break
        }
        case 'signature':
          callbacks.onThinkingBlock?.({ type: 'thinking', thinking: ev.thinking, signature: ev.signature })
          break
        case 'usage':
          callbacks.onUsage(ev.usage)
          break
        case 'finish':
          callbacks.onFinish(ev.reason)
          break
        case 'error':
          throw new Error(ev.message)
      }
    }
  }

  // 流结束：冲刷 <think> 跨分片解析扣住的尾部（最多 7 字符），
  // 否则每条回复的结尾都会被吞掉
  for (const ev of flushParserState(stream.compat, state)) {
    if (ev.kind === 'content') callbacks.onContent(ev.text)
    else if (ev.kind === 'thinking') callbacks.onThinking(ev.text)
  }

  return toolCallBuffers
}

/** Send messages to API and get streaming response.
 *  opts.modelOverride: 子 agent 模式下覆盖 settings.model。
 *  opts.thinkingBlocks: anthropic 协议下带签名的 thinking block 缓存（本轮内有效）。
 *  opts.settingsOverride: 子 agent 按 profile 覆盖模型级参数（推理档位/思考开关与预算）。
 *  opts.toolFilter: 子 agent 的 schema 级工具裁剪（白/黑名单 + 隐藏集合）。
 *  返回文本分片流 + 协议标记，交给 parseStream 解析。 */
async function callAPI(
  ports: AgentPorts,
  messages: NeutralMessage[],
  controller: AbortController,
  opts: {
    modelOverride?: string
    thinkingBlocks?: Map<string, AnthropicThinkingBlock[]>
    /** 本会话锁定的 harness 模式：决定传给模型的内置工具集/描述（子 agent 与评估器不传，走 default） */
    harnessMode?: HarnessMode
    /** 子 agent 变体：模型级参数覆盖（与 ports.settings 合并后生效） */
    settingsOverride?: Partial<AgentSettings>
    /** 子 agent 变体：schema 级工具裁剪 */
    toolFilter?: { allowedTools?: string[]; disallowedTools?: string[]; hidden?: ReadonlySet<string> }
  } = {}
): Promise<{ chunks: AsyncIterable<string>; compat: ApiCompat }> {
  const settings = opts.settingsOverride ? { ...ports.settings, ...opts.settingsOverride } : ports.settings
  // Get all tool definitions (skills are prompt-only, no dynamic tools)
  // 兼容模式下按模式取内置工具定义（dsh-minimal 裁剪 + 描述覆盖），MCP 工具不受影响
  let tools = ports.tools.definitions(opts.harnessMode ?? 'default').map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
  // 子 agent 的 schema 级裁剪：模型看不到的工具不会浪费 token，也不会试探性调用
  // （与 Agent 动作能力开关同一哲学）。Agent 动作工具（browser_/computer_）在子代理
  // 里既无审批恢复面也无执行面，一并隐藏。
  if (opts.toolFilter) {
    const { allowedTools, disallowedTools, hidden } = opts.toolFilter
    tools = tools.filter((t) => {
      if (hidden?.has(t.name)) return false
      if (agentActionFamily(t.name)) return false
      if (disallowedTools?.includes(t.name)) return false
      if (allowedTools !== undefined && !allowedTools.includes('*') && !allowedTools.includes(t.name)) return false
      return true
    })
  }

  const effectiveModel = opts.modelOverride || settings.model
  const compat: ApiCompat = settings.apiCompat || 'openai'

  // Anthropic 要求带 tool_use 的轮次原样回放 thinking block（含 signature）。
  // 历史消息（从 DB 读出来的）没有签名 —— 这种情况下必须对本次请求关掉思考，否则 400。
  const thinkingOk = compat !== 'anthropic' || canKeepThinking(messages, opts.thinkingBlocks)

  // 优先按当前 provider + 真实生效模型解析高级参数。
  // 子 agent 用 modelOverride 覆盖了模型时，activeModelId 可能不属于子 agent 的模型，
  // 因此要跨所有 provider 按 effectiveModel 兜底查找，避免子 agent 误用主模型参数。
  const activeModel = (() => {
    const pid = settings.activeProviderId
    const p = settings.providers.find((x) => x.id === pid)
    const inProvider = p?.models.find((m) => m.id === effectiveModel)
    if (inProvider) return inProvider
    for (const pp of settings.providers) {
      const m = pp.models.find((x) => x.id === effectiveModel)
      if (m) return m
    }
    return undefined
  })()
  const temperature = activeModel?.temperature ?? settings.temperature ?? 0.7
  const maxTokens = activeModel?.maxTokens ?? settings.maxTokens ?? 16000
  // maxInputTokens 仅用于截断预算，不写入 API body
  const effort = activeModel?.reasoningEfforts?.length
    ? activeModel.reasoningEffort ?? settings.reasoningEffort
    : undefined

  const body = buildRequestBody(compat, {
    model: effectiveModel,
    messages,
    tools,
    temperature,
    maxTokens,
    // 始终开启思考的模型（Kimi K3 / GLM-5.3 / M3.1 Flash）不受全局开关影响，
    // 否则用户选了档位却因为开关关闭而发不出 reasoning_effort
    thinking: (settings.enableThinking || activeModel?.thinkingAlwaysOn === true) && thinkingOk,
    thinkingBudget: settings.thinkingBudget,
    reasoningEffort: effort,
    thinkingStyle: compat === 'anthropic' ? 'budget' : (activeModel?.thinkingStyle ?? undefined),
    stream: true,
    thinkingBlocks: opts.thinkingBlocks,
  })

  // A connection timeout must not abort the controller that owns the full agent run.
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(new Error('Request timeout after 120s')), 120_000)
  const { signal: combinedSignal, dispose } = combineAbortSignals([controller.signal, timeoutController.signal])

  let opened = false
  try {
    const chunks = await ports.model.stream(body, combinedSignal)
    opened = true
    return { chunks, compat }
  } finally {
    dispose()
    clearTimeout(timeoutId)
    // The stream may still consume the successful connection, so only abort on failure.
    if (!opened) timeoutController.abort()
  }
}

/** Estimate token count from character count using the unified heuristic */
const estimateTokens = (text: string): number => estimateTokensForText(text)

/** Truncate messages to fit within context window.
 *  Strategy: keep system prompt + most recent messages.
 *  If total estimated tokens exceed the budget, trim oldest messages.
 *  IMPORTANT: Must preserve message sequence integrity — tool messages must always
 *  follow their corresponding assistant+tool_calls message.
 */
function truncateMessages(settings: AgentSettings, msgs: NeutralMessage[]): NeutralMessage[] {
  // 优先读当前激活模型的输入预算；没有则回退全局 / 默认 184K
  const activeForBudget = settings.providers
    .find((p) => p.id === settings.activeProviderId)
    ?.models.find((m) => m.id === settings.activeModelId)
  const MAX_INPUT_TOKENS = activeForBudget?.maxInputTokens ?? settings.maxInputTokens ?? 184000

  let totalTokens = 0
  for (const m of msgs) {
    totalTokens += estimateTokens(m.content || '')
    // 多模态图片按固定粗估计入
    totalTokens += (m.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE
    if (m.tool_calls) {
      totalTokens += estimateTokens(JSON.stringify(m.tool_calls))
    }
    // Also count reasoning_content tokens
    if (m.reasoning_content) {
      totalTokens += estimateTokens(m.reasoning_content)
    }
  }

  if (totalTokens <= MAX_INPUT_TOKENS) return msgs

  // Need to truncate - find a safe cut point
  // We must NOT cut in the middle of a tool_calls → tool response sequence
  // 前置的全部 system 消息（静态段+动态段）始终保留，只截对话历史
  const systemCount = msgs.findIndex((m) => m.role !== 'system')
  const system = msgs.slice(0, systemCount === -1 ? msgs.length : systemCount)
  const rest = msgs.slice(system.length)

  let runningTokens = system.reduce((acc, m) => acc + estimateTokens(m.content || ''), 0)

  // Walk from most recent backwards, accumulating tokens
  // Find the earliest message we can keep without breaking sequence integrity
  let cutIndex = rest.length // Start by trying to keep everything after system

  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i]
    const mTokens = estimateTokens(m.content || '') + estimateTokens(m.tool_calls ? JSON.stringify(m.tool_calls) : '') + estimateTokens(m.reasoning_content || '') + (m.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE

    if (runningTokens + mTokens > MAX_INPUT_TOKENS && (rest.length - i) >= 4) {
      // We've hit the budget, cut here — but check if this is a safe cut point
      cutIndex = i + 1
      break
    }
    runningTokens += mTokens
  }

  // Now ensure we don't start with a "tool" message (must have preceding assistant+tool_calls)
  // Walk forward from cutIndex to find the first valid starting message
  while (cutIndex < rest.length) {
    const m = rest[cutIndex]
    if (m.role === 'tool') {
      // This tool message needs its assistant+tool_calls predecessor
      // Check if the message before it (cutIndex-1) is an assistant with tool_calls
      if (cutIndex > 0 && rest[cutIndex - 1].role === 'assistant' && rest[cutIndex - 1].tool_calls) {
        // Include the assistant message too
        cutIndex--
        // But now this assistant might also be a tool response chain start — keep going back
        continue
      }
      // Can't find the predecessor — skip this tool message
      cutIndex++
      continue
    }
    break
  }

  // Also check: if first kept message is an assistant with tool calls but we don't have the tool responses
  // that's also invalid. We'd need to include at least the tool responses.
  // For simplicity: if first kept non-system message is assistant+tool_calls, check that tool responses follow
  // If not, skip the assistant+tool_calls message too (it's useless without results)
  while (cutIndex < rest.length) {
    const m = rest[cutIndex]
    if (m.role === 'assistant' && m.tool_calls) {
      // Check if next message(s) are the corresponding tool responses
      const toolCallIds = (m.tool_calls as Array<{ id: string }>).map(tc => tc.id)
      const nextMsg = rest[cutIndex + 1]
      if (nextMsg && nextMsg.role === 'tool' && toolCallIds.includes(nextMsg.tool_call_id || '')) {
        break // Good, tool response follows
      }
      // No tool response follows — skip this orphaned assistant+tool_calls
      cutIndex++
      continue
    }
    break
  }

  const kept = [...system, ...rest.slice(cutIndex)]
  return kept
}

/** Build API-compatible message array from our Message[].
 *  opts.extraSystemPrompt: 子 agent 模式下覆盖系统提示；不传则走主 agent 逻辑。 */
async function buildAPIMessages(
  ports: AgentPorts,
  ctx: SessionContext,
  msgs: Message[],
  opts: {
    memoryPrompt?: string
    workingDir?: string
    /** 任务工作流模式（/spec /plan /goal 菜单选择；goal 亦随会话级目标持续生效） */
    taskMode?: TaskMode
    /** goal 模式下注入的目标条件原文（会话级目标跨消息持续） */
    goalCondition?: string
    /** 全量技能目录（含未激活技能）：AI 自主加载依赖目录发现技能，而非仅用户激活项 */
    skillCatalog?: SkillCatalogEntry[]
    /** 当轮相关技能提醒（<system-reminder> 文本，buildRelevantSkillReminder 产出）；
     *  追加到最后一条 user 消息，不进 system 前缀（保前缀缓存） */
    skillReminder?: string
    extraSystemPrompt?: string
    /** 本会话锁定的 harness 兼容模式（reactLoop 从会话读出后传入） */
    harnessMode?: HarnessMode
    agentsMdContent?: string
    /** 环境段用：当前工作目录是否为 git 仓库（reactLoop 探测后传入） */
    isGitRepo?: boolean
    /** microcompact：true 时把较老的大型工具输出就地替换为占位符（保留最近 N 条），
     *  只减 token 不动 UI/DB 历史。启用后清理集合只增不减，前缀保持稳定。 */
    clearOldToolResults?: boolean
  } = {}
): Promise<NeutralMessage[]> {
  const settings = ports.settings
  const {
    memoryPrompt = '',
    workingDir = getWorkingDir(ports, ctx),
    taskMode,
    goalCondition,
    skillCatalog = ports.skills.catalog(),
    skillReminder,
    extraSystemPrompt,
    harnessMode: harnessModeOpt,
    agentsMdContent = '',
    isGitRepo,
    clearOldToolResults,
  } = opts
  const harnessMode = harnessModeOpt ?? 'default'
  // 兼容模式的静态段与动态段策略（default 模式为 undefined，走原有分支）
  const modeContent = harnessMode !== 'default' ? HARNESS_MODE_CONTENT[harnessMode] : undefined

  // 当前生效模型是否支持图片输入；不支持时图片不进入 API 消息
  // （ChatInput 已在 UI 层拦截无路径图片，这里对漏网的无路径图片兜底丢弃）
  const supportsImages = settings.providers
    .find((p) => p.id === settings.activeProviderId)
    ?.models.find((m) => m.id === settings.activeModelId)
    ?.supportsImages ?? false

  let staticSystemContent: string
  let dynamicSystemContent = `## Current Working Directory\n${workingDir || '(not set — treat all paths as relative)'}`
  if (extraSystemPrompt) {
    staticSystemContent = extraSystemPrompt
  } else if (modeContent) {
    // ── harness 兼容模式：静态段整体替换为对齐官方 harness 的 prompt；
    // 动态段按模式策略注入（full 与默认一致，minimal 仅保留工作目录+环境）──
    staticSystemContent = modeContent.staticPrompt
    if (workingDir) {
      dynamicSystemContent += `\n\nFile operations default to this directory. Do NOT write outside it unless the user explicitly provides an absolute path elsewhere.`
      dynamicSystemContent += `\n\nThis section is authoritative: when asked about the current working directory, report the path above — NOT any directory path seen in earlier messages or tool outputs (those reflect a previous setting).`
      const envLines = [
        `- Platform: ${ports.env.platform}`,
        `- OS: ${ports.env.osDescription} (shells available: ${ports.env.shellDescription})`,
        `- Today's date: ${new Date().toDateString()}`,
        `- Is a git repository: ${isGitRepo ? 'yes' : 'no'}`,
      ]
      dynamicSystemContent += `\n\n## Environment\n${envLines.join('\n')}`
      if (modeContent.dynamicContext === 'full') {
        dynamicSystemContent += CLERKBOX_PROMPT
        if (agentsMdContent) dynamicSystemContent += agentsMdContent
        if (memoryPrompt) dynamicSystemContent += '\n\n' + memoryPrompt
        if (skillCatalog.length > 0) {
          dynamicSystemContent += `\n\n### 🧩 Skill Catalog (every installed skill)\n${renderSkillCatalog(skillCatalog)}\n\n**Follow the Skill Router rules above — load matching skills autonomously via read_file. Do NOT read all skills, only those matching the current task.**`
        }
      }
    }
    // 任务工作流提示词：用户显式发起的工作流属会话层，兼容模式下照常注入
    if (taskMode === 'plan') dynamicSystemContent += PLAN_MODE_PROMPT
    else if (taskMode === 'spec') dynamicSystemContent += SPEC_MODE_PROMPT
    else if (taskMode === 'goal') {
      dynamicSystemContent += GOAL_MODE_PROMPT
      if (goalCondition) dynamicSystemContent += `\n\n### 🎯 Active Goal Condition\n${goalCondition}`
    }
  } else {
    staticSystemContent = SYSTEM_PROMPT
    if (workingDir) {
      dynamicSystemContent += `\n\nFile operations default to this directory. Do NOT write outside it unless the user explicitly provides an absolute path elsewhere.`
      // 权威声明：会话中途切换目录后，历史消息/工具输出里仍是旧目录路径，
      // 模型容易从上下文抄旧值回答"当前工作目录"。此声明强制以系统提示为准。
      dynamicSystemContent += `\n\nThis section is authoritative: when asked about the current working directory, report the path above — NOT any directory path seen in earlier messages or tool outputs (those reflect a previous setting).`
      // 环境信息段（参考 Claude Code/opencode 的 env 注入）：会话内稳定的运行环境事实
      const envLines = [
        `- Platform: ${ports.env.platform}`,
        `- OS: ${ports.env.osDescription} (shells available: ${ports.env.shellDescription})`,
        `- Today's date: ${new Date().toDateString()}`,
        `- Is a git repository: ${isGitRepo ? 'yes' : 'no'}`,
      ]
      dynamicSystemContent += `\n\n## Environment\n${envLines.join('\n')}`
      dynamicSystemContent += CLERKBOX_PROMPT
      if (agentsMdContent) dynamicSystemContent += agentsMdContent
      if (memoryPrompt) dynamicSystemContent += '\n\n' + memoryPrompt
      if (skillCatalog.length > 0) {
        dynamicSystemContent += `\n\n### 🧩 Skill Catalog (every installed skill)\n${renderSkillCatalog(skillCatalog)}\n\n**Follow the Skill Router rules above — load matching skills autonomously via read_file. Do NOT read all skills, only those matching the current task.**`
      }
    }
    // 任务工作流提示词：spec/plan/goal 各自注入对应段（plan 复用 PLAN_MODE_PROMPT）
    if (taskMode === 'plan') dynamicSystemContent += PLAN_MODE_PROMPT
    else if (taskMode === 'spec') dynamicSystemContent += SPEC_MODE_PROMPT
    else if (taskMode === 'goal') {
      dynamicSystemContent += GOAL_MODE_PROMPT
      // 会话级目标条件：goal 跨消息持续生效时，让模型每一轮都能看到目标原文
      if (goalCondition) dynamicSystemContent += `\n\n### 🎯 Active Goal Condition\n${goalCondition}`
    }
  }

  // 静/动拆分成两条 system 消息：供应商前缀缓存按"首个不一致 token"作废其后全部。
  // 静态段（SYSTEM_PROMPT / 子 agent prompt）单独在前，跨会话字节一致仍可命中缓存；
  // 动态段（工作目录/记忆/技能索引/AGENTS.md）变化只作废动态段之后的部分。

  // dev 校验：静态段在同来源下跨请求必须字节一致——若未来有人把易变内容
  // （时间戳/记忆/技能索引等）塞回静态段，这里立刻暴露，避免缓存命中率悄悄归零。
  // 来源含 harness 模式：切换会话/模式导致的静态段变化属正常现象，不算泄漏。
  if (ports.env.isDev) {
    const origin = extraSystemPrompt ? 'sub' : `main:${harnessMode}`
    const hash = hashString(staticSystemContent)
    const prev = ctx.staticSystemHash
    if (prev && prev.origin === origin && prev.hash !== hash) {
      console.warn(
        `[cache] static system prompt ("${origin}") changed between requests — prefix cache will miss. ` +
          `Ensure no volatile content (memory/skills/timestamps) leaks into the static segment.`,
      )
    }
    ctx.staticSystemHash = { origin, hash }
  }

  const result: NeutralMessage[] = [
    {
      role: 'system',
      content: staticSystemContent,
      _cacheControl: true,
    },
    {
      role: 'system',
      content: dynamicSystemContent,
    },
  ]

  // 压缩边界过滤：API 只发送「最后一个压缩摘要之后」的消息子集。
  // UI/DB 保留全量历史供用户查看，但旧历史不再发给模型（真正释放 token，
  // 也与自动压缩判定 / 上下文用量指示器保持同一口径）。
  // 工具配对完整性由下方后处理兜底（补齐丢失的 tool 响应/丢弃孤立 tool 消息）。
  const visibleMsgs = getApiVisibleMessages(msgs)

  // ── microcompact：决定哪些老工具输出要被就地清空 ──
  // 只在 clearOldToolResults 启用时生效；通过 toolCallId → 工具名回查判定可清理性，
  // 最近 MICROCOMPACT_KEEP_RECENT 条工具结果与 isError 结果一律保留。
  const clearedToolIds = new Set<string>()
  if (clearOldToolResults) {
    const callNames = new Map<string, string>()
    const toolMsgIndices: number[] = []
    for (const [i, m] of visibleMsgs.entries()) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) callNames.set(tc.id, tc.name)
      } else if (m.role === 'tool') {
        toolMsgIndices.push(i)
      }
    }
    const keepFrom = Math.max(0, toolMsgIndices.length - MICROCOMPACT_KEEP_RECENT)
    for (let k = 0; k < keepFrom; k++) {
      const m = visibleMsgs[toolMsgIndices[k]!]
      const toolCallId = m?.toolResults?.[0]?.toolCallId || ''
      const name = callNames.get(toolCallId)
      if (!name || !MICROCOMPACT_CLEARABLE_TOOLS.has(name)) continue
      if (m.toolResults?.[0]?.isError) continue
      clearedToolIds.add(toolCallId)
    }
  }

  // ── 工具结果截图：只回传最近几张，且模型必须支持视觉输入 ──
  // 非视觉模型带图会让整轮请求直接 400，所以这道判断与用户附件那条走同一个 supportsImages 口径。
  const toolResultImageIds = new Set<string>()
  if (supportsImages) {
    const imageCallIds: string[] = []
    for (const m of visibleMsgs) {
      if (m.role !== 'tool') continue
      const results = m.toolResults
      if (results?.some((r) => r.images && r.images.length > 0)) {
        const callId = results?.[0]?.toolCallId || ''
        if (callId) imageCallIds.push(callId)
      }
    }
    for (const callId of imageCallIds.slice(-TOOL_RESULT_IMAGES_MAX)) toolResultImageIds.add(callId)
  }

  for (const m of visibleMsgs) {
    if (m.role === 'system') continue // We already added system prompt
    // 跳过 UI 占位消息（子 agent 卡片），它们不是真实对话内容，会破坏 tool_calls ↔ tool 配对
    if (m.isSubAgentCard) continue
    // 跳过空的 assistant 占位消息（无内容、无工具调用、无思考内容）
    // 这些可能是旧会话中未标记 isSubAgentCard 的遗留占位消息
    if (m.role === 'assistant' && !m.toolCalls?.length && !m.content && !m.thinkingContent) continue

    if (m.role === 'tool') {
      // Tool result message（剥离 UI 专用 __EDIT_DIFF__ 元数据，不发给模型）
      const toolCallId = m.toolResults?.[0]?.toolCallId || ''
      // microcompact：被清理的老工具输出替换为占位符（UI/DB 历史不受影响）
      const cleared = clearedToolIds.has(toolCallId)
      const toolContent = cleared
        ? CLEARED_TOOL_RESULT_PLACEHOLDER
        : m.content.replace(/\n__EDIT_DIFF__:.*$/s, '')
      // 被清理的老输出连同它的截图一起失效：图本来就是那次观察的产物，留着只会自相矛盾
      const images = !cleared && supportsImages && toolResultImageIds.has(toolCallId)
        ? await resolveToolResultImages(ports, m.toolResults)
        : undefined
      result.push({
        role: 'tool',
        content: toolContent,
        tool_call_id: toolCallId,
        ...(images ? { images } : {}),
      })
    } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Assistant message with tool calls
      const msg: NeutralMessage = {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
        // anthropic 协议需要用它回查本轮缓存的带签名 thinking block
        _msgId: m.id,
      }
      // GLM requires reasoning_content in history messages for better context continuity
      if (m.thinkingContent) {
        msg.reasoning_content = m.thinkingContent
      }
      result.push(msg)
    } else {
      // Regular user/assistant message
      const msg: NeutralMessage = { role: m.role, content: m.content }
      // Include reasoning_content for assistant messages (required by GLM)
      if (m.role === 'assistant' && m.thinkingContent) {
        msg.reasoning_content = m.thinkingContent
      }
      if (m.role === 'assistant') msg._msgId = m.id
      // 用户消息附件：所有带磁盘路径的附件（文件 + 带路径图片）追加路径清单，
      // 模型用 read_file 等工具按路径自行读取；文件内容本身不发给模型
      if (m.role === 'user' && m.attachments?.length) {
        const pathLines = m.attachments.filter((a) => a.path).map((a) => `- ${a.path}`)
        if (pathLines.length > 0) {
          msg.content = `${msg.content}\n\n[附件文件]\n${pathLines.join('\n')}`
        }
        // 支持图片的模型：携带 dataUrl 的图片附件转多模态 images（mimeType 取附件声明，缺失时从 dataUrl 前缀解析）
        if (supportsImages) {
          const images: Array<{ dataUrl: string; mimeType: string }> = []
          for (const a of m.attachments) {
            if (a.kind === 'image' && a.dataUrl) {
              images.push({ dataUrl: a.dataUrl, mimeType: a.mimeType || mimeFromDataUrl(a.dataUrl) || 'image/png' })
            }
          }
          if (images.length > 0) msg.images = images
        }
      }
      result.push(msg)
    }
  }

  // ── 后处理：确保 tool_calls ↔ tool 配对完整性 ──
  // 防止因遗留数据、压缩边界、中断等导致 API 400 错误：
  // "An assistant message with 'tool_calls' must be followed by tool messages"
  const cleaned: typeof result = []
  const pendingToolCallIds: string[] = []

  for (const msg of result) {
    const role = msg.role as string
    if (role === 'assistant' && msg.tool_calls) {
      // 先补齐上一条 assistant(tool_calls) 未收到的 tool 响应
      for (const pendingId of pendingToolCallIds) {
        cleaned.push({
          role: 'tool',
          content: i18n.t('agent.toolResultLost'),
          tool_call_id: pendingId,
        } as typeof result[number])
      }
      pendingToolCallIds.length = 0

      // 加入 assistant 消息，并记录本次需要等待的 tool_call_id
      cleaned.push(msg)
      const calls = msg.tool_calls as Array<{ id: string }>
      for (const tc of calls) {
        pendingToolCallIds.push(tc.id)
      }
    } else if (role === 'tool') {
      const tcId = msg.tool_call_id as string
      const idx = pendingToolCallIds.indexOf(tcId)
      if (idx >= 0) {
        // 匹配成功
        pendingToolCallIds.splice(idx, 1)
        cleaned.push(msg)
      } else {
        // 孤立的 tool 消息（没有对应的 pending tool_call）— 丢弃
        // 这防止了 tool 消息出现在 assistant(tool_calls) 之前
      }
    } else {
      // 非工具消息（user / 纯文本 assistant）— 先补齐 pending tool 响应
      for (const pendingId of pendingToolCallIds) {
        cleaned.push({
          role: 'tool',
          content: i18n.t('agent.toolResultLost'),
          tool_call_id: pendingId,
        } as typeof result[number])
      }
      pendingToolCallIds.length = 0
      cleaned.push(msg)
    }
  }
  // 收尾：补齐最后未响应的 tool_call
  for (const pendingId of pendingToolCallIds) {
    cleaned.push({
      role: 'tool',
      content: '[此工具调用的结果因上下文压缩或中断丢失]',
      tool_call_id: pendingId,
    } as typeof result[number])
  }

  // 相关技能提醒（B4）：追加到最后一条 user 消息的消息层（<system-reminder> 包裹），
  // 不进 system 段 → 不破坏 system 前缀缓存；同一次发送内各轮文本一致 → 轮间前缀稳定。
  // 仅影响 API 消息，UI/DB 中的用户消息原文保持不变。
  if (skillReminder) {
    for (let i = cleaned.length - 1; i >= 0; i--) {
      if (cleaned[i].role === 'user') {
        // reminder 内容来自 SKILL.md（外部文件数据面）：尖括号全量转义，
        // 防止摘要里藏一段伪造的系统信封（报告 03 P1 注入卫生）
        const safeReminder = escapeExternalText(skillReminder)
        cleaned[i] = { ...cleaned[i], content: `${cleaned[i].content}\n\n${safeReminder}` }
        break
      }
    }
  }

  return cleaned
}

/**
 * 统一审批入口：优先走对话内确认卡，宿主不接管（返回 null）或没装配时回落到原生确认框。
 *
 * 权限三期之前只有工作流/写文件确认走卡，命令/系统目录/浏览器动作仍是系统弹窗，
 * 观感割裂。现在所有权限门共用这一条路径：渲染层宿主的 confirmInChat 已对所有
 * reason 开放，主进程宿主没有这个端口则自动回落事件流驱动的对话内卡（agent-host）。
 */
async function askPermission(
  ports: AgentPorts,
  request: Parameters<AgentPorts['permission']['confirm']>[0]
): Promise<PermissionApproval> {
  const inChat = ports.permission.confirmInChat ? await ports.permission.confirmInChat(request) : null
  return inChat ?? (await ports.permission.confirm(request))
}

/** Check permission for a tool call.
 *  Agent allowlists and denylists can further restrict access, never elevate it.
 *  审批档位（settings.approvalMode）控制确认策略：
 *  - manual：危险命令 / 工作目录外操作 / 系统目录写入 全部弹窗确认
 *  - auto：目录外操作免确认（AI 自审）；危险命令与系统目录写入仍弹窗兜底，
 *    避免 rm -rf 类命令在默认档位下零拦截静默执行
 *  - full：完全访问，无需询问直接执行
 *  任务工作流（taskMode）：plan 规划期只读；spec 规划期仅允许读取与写入对应文档目录 */
export async function checkToolPermission(
  ports: AgentPorts,
  ctx: SessionContext,
  toolName: string,
  args: Record<string, unknown>,
  opts: {
    /** 覆盖任务工作流模式；不传读 ctx.activeTaskMode，子 agent 显式传 null 走普通模式 */
    taskMode?: TaskMode | null
    allowedTools?: string[]
    disallowedTools?: string[]
  } = {}
): Promise<{ allowed: boolean; reason?: string }> {
  const sessionId = ports.sessionId
  const {
    taskMode = ctx.activeTaskMode ?? undefined,
    allowedTools,
    disallowedTools,
  } = opts

  // An explicitly empty allowlist means no tools. Omitted tools retain the default policy.
  if (allowedTools !== undefined && !allowedTools.includes('*') && !allowedTools.includes(toolName)) {
    return { allowed: false, reason: i18n.t('agent.subAgentAllowlist', { tool: toolName }) }
  }
  // 子 agent 工具黑名单检查
  if (disallowedTools?.includes(toolName)) {
    return { allowed: false, reason: i18n.t('agent.subAgentDenylist', { tool: toolName }) }
  }

  const approvalMode = ports.settings.approvalMode
  // 只读工具白名单：plan / spec 两种规划期模式的唯一放行面。
  // app_* 自我管控工具全为只读，语义上与 read_file 同级，故一并列入——
  // 规划期禁止模型读取会话历史 / 技能清单是自缚手脚，规划本来就需要这些上下文。
  const READ_TOOLS = [
    'read_file', 'read_image', 'list_dir', 'search_files', 'search_content', 'web_search', 'web_fetch', 'search_memory',
    'app_status', 'app_list_sessions', 'app_read_session', 'app_list_skills', 'app_list_agents', 'app_search_memory', 'app_list_mcp_servers',
  ]

  // ── Plan 规划期：严格只读，用户确认后的下一条消息以普通模式运行 ──
  if (taskMode === 'plan') {
    if (READ_TOOLS.includes(toolName) || toolName === 'question') {
      return { allowed: true }
    }
    return { allowed: false, reason: i18n.t('agent.planReadOnly') }
  }

  // ── Spec 规划期：只许读 + 写对应文档目录，禁命令 ──
  // 用户确认文档后的下一条消息以普通模式运行，届时不再受限
  if (taskMode === 'spec') {
    const docDirName = 'specs'
    const label = 'Spec'
    if (READ_TOOLS.includes(toolName) || toolName === 'save_memory') {
      return { allowed: true }
    }
    if (toolName === 'write_file' || toolName === 'search_replace') {
      const isInsideDocDir = (() => {
        const wd = getWorkingDir(ports, ctx)
        if (!wd) return false
        const filePath = resolveToolPath(wd, args.path)
        const separator = wd.includes('\\') ? '\\' : '/'
        const docDir = `${wd}${separator}.clerkbox${separator}${docDirName}`
        return isPathInside(filePath, docDir) &&
          !isPathInside(docDir, filePath)
      })()
      if (isInsideDocDir) {
        return { allowed: true }
      }
      return { allowed: false, reason: i18n.t('agent.specWriteRestricted', { label, dir: docDirName }) }
    }
    if (toolName === 'execute_command') {
      return { allowed: false, reason: i18n.t('agent.specNoCommands', { label }) }
    }
    return { allowed: false, reason: i18n.t('agent.specReadOnly', { label }) }
  }

  // ── 项目级持久规则（权限三期）──
  // 位置刻意在所有审批门之前、plan/spec 只读约束之后：
  //  - deny 必须能覆盖 full 档直通（修 ZCode 瀑布里 disallowedTools 排在 yolo 之后的历史顺序问题）；
  //  - 但绝不能提升 plan/spec 的只读边界（任务期的限制由用户显式发起，规则不该推翻）。
  // allow 命中只免「同类确认」，不越过能力开关与子 agent 拦截——那两道仍在各自分支里。
  const ruleTarget = {
    tool: toolName,
    args,
    workingDir: getWorkingDir(ports, ctx),
  }
  const ruleHit = matchPermissionRule(ports.settings.permissionRules ?? [], ruleTarget, ruleTarget.workingDir)
  if (ruleHit?.verdict === 'deny') {
    return { allowed: false, reason: i18n.t('agent.deniedByProjectRule') }
  }
  const ruleAllows = ruleHit?.verdict === 'allow'

  // ── Agent 动作（Browser Use / Computer Use）门禁 ──
  // 三道，顺序即 fail-closed 的强度：
  //   1. 能力开关关 → 直接拒（设置里没开，模型看到什么、点了什么都不算数）
  //   2. 子 agent → 一律拒（子 agent 没有用户在场，也没有审批弹窗能被应答；
  //      让它去动浏览器/桌面，等于把最高风险的动作交给最不可见的执行者）
  //   3. 写操作 → **每个能力每会话问一次**（读页面/截屏不动任何状态，永远放行）
  //
  // 第 3 条的粒度是这个设计里最容易做错的地方。按「每个动作」问，一次浏览任务
  // 要打断用户十几次，功能等于不存在；按「每个动作但记住」也不够，记忆键是动作级的话
  // 下一个不同动作照样再问。正确形态是**能力级 + 会话级**：用户在第一次弹窗时选
  // 「本会话始终允许」，整个任务后续静默通过，需要收回时关掉设置里的开关即可。
  const agentAction = agentActionFamily(toolName)
  if (agentAction) {
    if (agentAction === 'browser' && ports.settings.browserUseEnabled !== true) {
      return { allowed: false, reason: i18n.t('agent.browserUseDisabled') }
    }
    if (agentAction === 'computer' && ports.settings.computerUseEnabled !== true) {
      return { allowed: false, reason: i18n.t('agent.computerUseDisabled') }
    }
    if (allowedTools === undefined && disallowedTools === undefined) {
      // 两个都不传 = 来自主循环；子 agent 一定会传其中之一，据此判定是否在子 agent 里
    } else {
      return { allowed: false, reason: i18n.t('agent.agentActionSubagentBlocked') }
    }
    // full 档：用户已声明「完全信任」，与写文件/执行命令的既有语义一致
    if (approvalMode === 'full') return { allowed: true }
    // 只读动作不改任何状态，不该为了看一眼页面就打断用户
    if (isAgentActionToolReadOnly(toolName, args)) return { allowed: true }
    const grantKey = agentActionGrantKey(agentAction)
    if (ctx.grantedAgentActions.has(grantKey)) return { allowed: true }

    const approval = await askPermission(ports, {
      tool: toolName,
      args,
      reason: agentAction === 'computer' ? 'computer-control' : 'browser-control',
      workingDir: getWorkingDir(ports, ctx) || '',
      risk: 'dangerous',
      title: i18n.t(agentAction === 'computer' ? 'agent.confirmComputerUseTitle' : 'agent.confirmBrowserUseTitle'),
      body: i18n.t(agentAction === 'computer' ? 'agent.confirmComputerUseBody' : 'agent.confirmBrowserUseBody', {
        tool: i18n.t(`tools.${toolName}`),
      }),
    })
    if (!approval.approved) {
      return { allowed: false, reason: i18n.t('agent.deniedCancelAgentAction') }
    }
    if (approval.scope === 'session') ctx.grantedAgentActions.add(grantKey)
    return { allowed: true }
  }

  // ── 工作流脚本门（对标 ZCode CreateWorkflow 的 alwaysAsk 语义）──
  // 脚本要先给用户过目再执行：它一口气编排多个子代理，确认发生在源头。
  // 放行按**会话**记（ctx.workflowApproved）：脚本每轮都会被模型重写，按内容
  // 指纹记放行等于让「本会话始终允许」永远命中不了。full 档与写文件/命令同语义免问。
  // create_workflow 与 resume_workflow 都在执行脚本（后者按 journal 原样重放），同等过目
  if (WORKFLOW_GATED_TOOLS.includes(toolName) && approvalMode !== 'full') {
    // 本会话已经放行过：不再打扰。用户点的「本会话始终允许」必须真的兑现——
    // 脚本每轮都会被重写，按脚本指纹记放行等于每次都要重问。
    if (ctx.workflowApproved) return { allowed: true }
    const request = {
      tool: toolName,
      args,
      reason: 'workflow-script' as const,
      workingDir: getWorkingDir(ports, ctx) || '',
      risk: 'normal' as const,
      title: i18n.t('agent.confirmWorkflowTitle'),
      body: i18n.t('agent.confirmWorkflowBody', { name: String(args.name || args.runId || '未命名工作流') }),
    }
    // 统一入口：对话内卡优先，宿主不接管时回落原生框
    const approval = await askPermission(ports, request)
    if (!approval.approved) {
      return { allowed: false, reason: i18n.t('agent.deniedCancelWorkflow') }
    }
    if (approval.scope === 'session') ctx.workflowApproved = true
    return { allowed: true }
  }

  // ── 审批档位：命令执行确认（full 档全部免询问） ──
  if (toolName === 'execute_command' && approvalMode !== 'full') {
    const cmd = String(args.command || '')
    const workingDir = getWorkingDir(ports, ctx)
    const commandCwd = workingDir ? resolveToolPath(workingDir, args.cwd || workingDir) : String(args.cwd || '')
    // 危险命令确认：manual/auto 都弹窗（最后一道防线，仅 full 档放行）
    if (isDangerousCommand(cmd)) {
      // 危险命令确认前：标记 confirm-danger + 通知（仅当用户不在此会话时）
      ports.store.setStatus(sessionId, 'confirm-danger')
      ports.ui.notify(sessionId, 'confirm-danger', i18n.t('agent.notifyDangerCommand', { command: cmd.slice(0, 100) }))
      const { approved: confirmed } = await askPermission(ports, {
        tool: toolName,
        args,
        reason: 'dangerous-command',
        workingDir: workingDir || commandCwd || '',
        risk: 'dangerous',
        title: i18n.t('agent.confirmDangerTitle'),
        body: i18n.t('agent.confirmDangerBody', { command: cmd.slice(0, 200) }),
      })
      // 确认或取消后：恢复 working 状态（sendMessage 仍在执行中）
      ports.store.setStatus(sessionId, 'working')
      if (!confirmed) {
        return { allowed: false, reason: i18n.t('agent.deniedCancelDanger') }
      }
    }
    // auto 档：AI 已自审该操作，目录外执行免确认；manual 档仍确认（项目规则 allow 免打扰）
    if (approvalMode === 'manual' && !ruleAllows && workingDir && commandCwd && !isPathInside(commandCwd, workingDir)) {
      const { approved: confirmed } = await askPermission(ports, {
        tool: toolName,
        args,
        reason: 'outside-cwd',
        workingDir: workingDir || '',
        risk: 'normal',
        title: i18n.t('agent.confirmOutsideCwdTitle'),
        body: i18n.t('agent.confirmOutsideCwdBody', { cwd: commandCwd, workingDir }),
      })
      if (!confirmed) return { allowed: false, reason: i18n.t('agent.deniedCancelOutsideCwd') }
    }
  }

  // ── 审批档位：文件写入确认（full 档全部免询问） ──
  if ((toolName === 'write_file' || toolName === 'search_replace') && approvalMode !== 'full') {
    const workingDir = getWorkingDir(ports, ctx)
    const path = resolveToolPath(workingDir, args.path)
    // 系统目录写入：manual/auto 都弹窗（最后一道防线，仅 full 档放行）
    if (isSystemPath(path)) {
      const { approved: confirmed } = await askPermission(ports, {
        tool: toolName,
        args,
        reason: 'system-dir',
        workingDir: workingDir || path,
        risk: 'dangerous',
        title: i18n.t('agent.confirmSystemDirTitle'),
        body: i18n.t('agent.confirmSystemDirBody', { path }),
      })
      if (!confirmed) {
        return { allowed: false, reason: i18n.t('agent.deniedCancelSystemDir') }
      }
    }

    // auto 档：AI 已自审，写入免确认（危险命令与系统目录仍有兜底）。
    // manual 档 = 变更前确认：**每一次写文件都先问**（ZCode build 档同款语义），
    // 走对话内确认卡——卡里用执行期同一套 diff 渲染将要落盘的变更，
    // 用户批准的是看得见的内容。原生弹窗画不出 diff，只作 fallback。
    if (approvalMode === 'manual' && !ruleAllows && workingDir) {
      const isOutside = !isPathInside(path, workingDir)
      const request = {
        tool: toolName,
        args,
        reason: 'file-write' as const,
        workingDir: workingDir || '',
        risk: 'normal' as const,
        title: i18n.t('agent.confirmWriteTitle'),
        body: isOutside
          ? i18n.t('agent.confirmOutsideWriteBody', { path, workingDir })
          : i18n.t('agent.confirmWriteBody', { path }),
      }
      const approval = await askPermission(ports, {
        ...request,
        reason: isOutside ? 'outside-write' : 'file-write',
        title: isOutside ? i18n.t('agent.confirmOutsideWriteTitle') : request.title,
      })
      if (!approval.approved) {
        return { allowed: false, reason: i18n.t(isOutside ? 'agent.deniedCancelOutsideWrite' : 'agent.deniedCancelWrite') }
      }
    }
  }

  return { allowed: true }
}

/** Collapse all intermediate messages (assistant messages with tool calls, tool result messages)
 *  Keep only the final assistant summary expanded */
function collapseIntermediateMessages(ports: AgentPorts, sid: string, finalMsgId: string) {
  const session = ports.store.getSession(sid)
  if (!session) return

  for (const msg of session.messages) {
    // Collapse: tool result messages, and assistant messages that had tool calls (intermediate steps)
    // Do NOT collapse: user messages, the final assistant message, or assistant messages without tool calls
    if (msg.id === finalMsgId) continue  // Skip the final message
    if (msg.role === 'user') continue    // Keep user messages visible
    if (msg.goalEvent) continue          // Goal 判定卡片不折叠（终态/续跑提示需始终可见）
    if (msg.role === 'assistant' && (!msg.toolCalls || msg.toolCalls.length === 0) && msg.content && !msg.content.includes('正在使用工具')) continue  // Keep assistant summaries visible
    // 完全空的消息（无正文、无工具调用）不折叠也不展示 —— 折叠会渲染成「中间步骤 (0)」空行
    if (msg.role === 'assistant' && (!msg.toolCalls || msg.toolCalls.length === 0) && !msg.content.trim()) continue

    // Collapse this message
    if (!msg.collapsed) {
      ports.store.updateMessage(sid, msg.id, { collapsed: true })
    }
  }
}

/** ReAct loop: think → act → observe → repeat */
// ── 消息撤回 / 改动回滚：采集侧 ──

/**
 * 把本轮采集到的快照与缺口写回锚点用户消息。
 *
 * 每个工具批次后增量刷一次，而不是等整轮跑完再落：中途用户按停止、或模型报错退出时，
 * 已经写到磁盘的文件必须已经有对应的快照。攒到最后一步等于「崩一次就永久无法回滚」。
 */
function flushRewindAnchor(ports: AgentPorts, ctx: SessionContext): void {
  const anchor = ctx.rewindAnchorMessageId
  if (!anchor) return
  ports.store.updateMessage(ports.sessionId, anchor, {
    fileCheckpoints: [...ctx.turnCheckpoints],
    mutationGaps: [...ctx.turnGaps],
  })
}

function pushTurnGap(ctx: SessionContext, gap: { toolName: string; path?: string; reason: 'shell' | 'untracked-tool' | 'oversized' | 'binary' | 'unreadable' }): void {
  const key = `${gap.reason}:${gap.toolName}:${gap.path ?? ''}`
  if (ctx.turnGaps.some((g) => `${g.reason}:${g.toolName}:${g.path ?? ''}` === key)) return
  ctx.turnGaps.push(gap)
}

/**
 * 采集一次成功的文件写入：把变更前正文交给宿主落盘，换回索引挂到本轮锚点消息上。
 *
 * 宿主没装配 checkpoint 端口时记一条缺口而不是静默跳过 —— 静默跳过会让界面以为
 * 「本轮没有文件改动」，用户点撤回时文件被留在改动后的状态却毫无提示。
 */
async function recordFileMutation(ports: AgentPorts, ctx: SessionContext, mutation: FileMutation): Promise<void> {
  if (!ctx.rewindAnchorMessageId) return
  if (!ports.checkpoint) {
    pushTurnGap(ctx, { toolName: mutation.toolName, path: mutation.path, reason: 'untracked-tool' })
    flushRewindAnchor(ports, ctx)
    return
  }
  try {
    const saved = await ports.checkpoint.save(ports.sessionId, mutation)
    if (saved.checkpoint) ctx.turnCheckpoints.push(saved.checkpoint)
    if (saved.gap) pushTurnGap(ctx, saved.gap)
  } catch (err) {
    pushTurnGap(ctx, { toolName: mutation.toolName, path: mutation.path, reason: 'unreadable' })
    console.error('[loop] checkpoint save failed:', err)
  }
  flushRewindAnchor(ports, ctx)
}

/**
 * 整体替换 assistant 消息里某个工具结果的内容（后台工作流 settle 时换终态尾巴）。
 * 只动 UI 尾巴与展示正文——模型的对话历史里该工具结果保持启动确认文本，
 * 结果细节由 <workflow-notification> 注回，不在这里双份。
 */
function replaceToolResultContent(
  ports: AgentPorts,
  sessionId: string,
  assistantMessageId: string | undefined,
  toolCallId: string,
  content: string,
): void {
  if (!assistantMessageId || !toolCallId) return
  const message = ports.store.getSession(sessionId)?.messages.find((m) => m.id === assistantMessageId)
  if (!message?.toolResults?.some((r) => r.toolCallId === toolCallId)) return
  ports.store.updateMessage(sessionId, assistantMessageId, {
    toolResults: message.toolResults.map((r) => (r.toolCallId === toolCallId ? { ...r, content } : r)),
  })
}

/** 由工具名推断无法回滚的改动（shell / MCP / 未知工具）；快照覆盖不到的都在这里挡掉 */
function recordToolGap(ports: AgentPorts, ctx: SessionContext, toolName: string, path?: string): void {
  const gap = gapFromToolCall(toolName)
  if (!gap) return
  pushTurnGap(ctx, { ...gap, ...(path ? { path } : {}) })
  flushRewindAnchor(ports, ctx)
}

// ═══════════════ 统一 ReAct 循环（主对话与子代理共用）═══════════════
//
// 主对话与子代理曾是两套平行复刻的循环（runReactLoop / runSubAgentLoop，约 390 行重复），
// compact / doom-loop / 重试 / 收尾注入等机制改一处极易漏另一处。现在差异点全部收进
// AgentLoopVariant：消息面（store vs run 轨迹）、提示词来源、模型与推理参数覆盖、
// 工具 schema 裁剪、maxTurns、完成后的收口方式。机制层面只此一份。

/** 子代理 schema 级隐藏工具。这些工具在子代理语境没有执行面（ctx 不注入 handler，
 *  调用只会得到运行时错误）或没有审批恢复面（question 需要用户在场）——
 *  与其让模型看到再失败，不如 schema 层直接隐藏（对齐 ZCode「派发工具不进子代理」）。 */
const SUBAGENT_HIDDEN_TOOLS = new Set(['spawn_agent', 'send_message_to_agent', 'question', 'todowrite', 'scheduled_task', 'create_workflow', 'save_workflow', 'resume_workflow'])

/** 子代理默认轮次上限。maxTurns 是防失控护栏而不是目标值；agent 预设显式写了
 *  maxTurns 的仍以预设为准，显式值封顶主循环上限（MAX_REACT_ITERATIONS）。 */
export const DEFAULT_SUBAGENT_MAX_TURNS = 200

/** 后台子代理完成通知里结果正文的截断上限 */
const SUBAGENT_NOTIFICATION_RESULT_CAP = 4000

/** 循环运行变体：主对话与子代理共用的差异点集合 */
export interface AgentLoopVariant {
  role: 'main' | 'subagent'
  /** 主对话：本次运行的任务工作流模式与技能提醒（子代理不继承） */
  taskMode?: TaskMode
  skillReminder?: string
  /** 子代理变体专属 */
  subagent?: {
    agent: AgentDefinition
    subAgentId: string
  }
}

/** runAgentLoop 的返回值：子代理 wrapper 据此收口运行记录与用量；主对话调用方忽略 */
export interface AgentLoopResult {
  /** 终止时最后一条 assistant 消息正文（无工具调用的那轮；收尾兜底语义与旧实现一致） */
  text: string
  aborted: boolean
  /** 累计 API 用量 token（输入+输出）；全程无 usage 回报时为 null */
  totalTokens: number | null
  /** 执行到的工具调用总数（含被拒的调用） */
  toolCallCount: number
  /** 循环结束时的完整对话（子代理续跑依赖它） */
  messages: Message[]
}

async function runAgentLoop(
  ports: AgentPorts,
  ctx: SessionContext,
  initialMessages: Message[],
  controller: AbortController,
  variant: AgentLoopVariant
): Promise<AgentLoopResult> {
  const isMain = variant.role === 'main'
  const isSub = !isMain
  const subAgent = variant.subagent?.agent
  const subAgentId = variant.subagent?.subAgentId ?? ''
  const sessionId = ports.sessionId
  const settings = ports.settings
  let conversationMessages = [...initialMessages]

  // ── 消息面：主对话走 store（持久化 + DB），子代理走 ui 的 run 轨迹（内存）。
  // 子代理消息统一盖 subAgentId 章（轨迹归属依赖它）。 ──
  const stampMessage = (m: Message): Message => (isSub ? { ...m, subAgentId } : m)
  const sink = isSub
    ? {
        add: (m: Message) => ports.ui.appendSubAgentMessage(sessionId, subAgentId, m),
        update: (id: string, patch: Partial<Message>) => ports.ui.updateSubAgentMessage(sessionId, subAgentId, id, patch),
      }
    : {
        add: (m: Message) => ports.store.addMessage(sessionId, m),
        update: (id: string, patch: Partial<Message>) => ports.store.updateMessage(sessionId, id, patch),
      }

  // 撤回锚点 = 本次运行的最后一条真实用户消息；本轮所有文件快照都挂在它身上。
  // 每次运行都重新开账：上一轮的快照不能算进这一轮的回滚范围。（子代理没有自己的
  // 锚点——它的写操作经 recordFileMutation 记到父轮的账上。）
  if (isMain) {
    const anchorIndex = initialMessages.reduce(
      (last, message, index) => (isRewindableUserMessage(message) ? index : last),
      -1
    )
    ctx.beginRewindTurn(anchorIndex >= 0 ? (initialMessages[anchorIndex]?.id ?? null) : null)
  }

  // 本会话锁定的 harness 兼容模式（首条消息后不可变更，循环开始时读一次即可）。
  // 子 agent 与 goal 评估器不继承：它们有独立的提示词与工具语境。
  const harnessMode = isMain
    ? normalizeHarnessMode(ports.store.getSession(sessionId)?.harnessMode)
    : 'default'

  // ── Goal 工作流：会话级目标跨消息持续生效（仅主对话） ──
  const sessionGoalAtStart = isMain ? ports.goal.get(sessionId) : undefined
  const effectiveTaskMode: TaskMode | undefined =
    variant.taskMode ?? (sessionGoalAtStart?.status === 'active' ? 'goal' : undefined)
  const goalCondition = sessionGoalAtStart?.status === 'active' ? sessionGoalAtStart.condition : undefined
  // Goal 评估器运行时状态：本次运行的续跑评估计数 / 连续无工具调用的评估计数（防空转）
  let goalEvaluationsThisRun = 0
  let goalIdleEvaluations = 0
  let iterationHadToolCalls = false

  /** Goal 评估器：独立模型调用，依据转录中的可见证据判定三态；不执行任何工具。
   *  用量计入全局统计但不进 tokenTracker（避免干扰自动压缩判定）。仅主对话调用。 */
  const evaluateGoal = async (
    condition: string,
    runController: AbortController
  ): Promise<{ verdict: GoalVerdict; reason: string }> => {
    const evalMessages: NeutralMessage[] = [
      { role: 'system', content: GOAL_EVALUATOR_PROMPT },
      {
        role: 'user',
        content: `# Goal condition\n${condition}\n\n# Recent transcript (oldest first, most recent last)\n${buildGoalTranscript(conversationMessages)}\n\nEvaluate now: has the goal been achieved?`,
      },
    ]
    const response = await callAPI(ports, evalMessages, runController)
    let text = ''
    await parseStream(response, runController, {
      onContent: (t) => { text += t },
      onThinking: () => {},
      onToolCallUpdate: () => {},
      onFinish: () => {},
      onUsage: (usage) => {
        try {
          ports.ui.recordUsage({
            usage,
            sessionId,
            model: settings.model,
            providerId: settings.activeProviderId,
          })
        } catch { /* 用量统计失败不影响评估流程 */ }
      },
    })
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { verdict?: string; reason?: string }
        if (parsed.verdict === 'achieved' || parsed.verdict === 'impossible' || parsed.verdict === 'in_progress') {
          return { verdict: parsed.verdict, reason: (parsed.reason || '').trim() || text.trim().slice(0, 200) }
        }
      } catch { /* JSON 解析失败落入兜底判定 */ }
    }
    return { verdict: 'in_progress', reason: (text || 'evaluator returned no verdict').trim().slice(0, 200) }
  }

  // Pre-fetch memory prompt —— 会话级冻结快照（见 SessionContext.memorySnapshot 注释）：
  // 每轮 reactLoop 重新构建的话，本轮 save_memory 写入的记忆会让下一轮
  // memoryPrompt 变化，动态 system 段之后的前缀缓存全部作废。（仅主对话注入）
  const workingDir = getWorkingDir(ports, ctx)
  const homeDir = ports.env.homeDir()

  // AI 自主加载技能的感知映射：SKILL.md 规范化绝对路径 → 技能快照。（仅主对话）
  const skillPathMap = new Map<string, { id: string; name: string; icon: string; slug: string }>()
  if (isMain) {
    for (const entry of ports.skills.catalog()) {
      skillPathMap.set(normalizePathForComparison(entry.skillMdPath), {
        id: entry.id,
        name: entry.name,
        icon: entry.icon,
        slug: entry.slug,
      })
    }
  }
  let memoryPrompt = ''
  if (isMain && homeDir) {
    const snapKey = `${sessionId}|${homeDir}|${workingDir}`
    const snap = ctx.memorySnapshot
    if (snap && snap.key === snapKey) {
      memoryPrompt = snap.prompt
    } else {
      try {
        memoryPrompt = await ports.env.buildMemoryPrompt(workingDir, homeDir)
      } catch {
        memoryPrompt = ''
      }
      ctx.memorySnapshot = { key: snapKey, prompt: memoryPrompt }
    }
  }

  // Pre-fetch AGENTS.md (项目根指令) — 跨工具标准，Codex/OpenCode/Qwen 原生支持（仅主对话）
  let agentsMdContent = ''
  if (isMain && settings.agentsMdEnabled && workingDir) {
    try {
      const candidates = settings.claudeMdCompat
        ? ['AGENTS.md', 'CLAUDE.md']
        : ['AGENTS.md']
      const sep = workingDir.includes('\\') ? '\\' : '/'
      for (const name of candidates) {
        const fullPath = `${workingDir}${sep}${name}`
        const text = await ports.env.readFile(fullPath)
        if (text && text.trim()) {
          agentsMdContent = `\n\n### 📋 Project Instructions (${name})\n${text.trim()}`
          break
        }
      }
    } catch {
      agentsMdContent = ''
    }
  }

  // anthropic 协议下，带工具调用的 assistant 轮必须原样回放带签名的 thinking block。
  // 签名只在本轮 ReAct 循环内有效，所以放内存不入库；键为 assistant 消息 id。
  const thinkingBlocks = new Map<string, AnthropicThinkingBlock[]>()

  // 环境信息：git 仓库探测（每目录缓存），传给 buildAPIMessages 的环境段
  const isGitRepo = workingDir ? await detectGitRepo(ports.env.runShell, workingDir) : false
  // 运行时防护状态：doom-loop 签名序列 / 工具执行轮计数 / 收尾指令注入标记
  const recentToolSignatures: string[] = []
  let toolExecutionTurns = 0
  let wrapUpInjected = false
  // 溢出恢复链：请求真实超上下文时强制压缩一次并重放（参考 Claude Code prompt-too-long recovery）
  let overflowRecovered = false
  // 自动压缩连续失败计数（达到熔断阈值后停止自动触发，防止每次发消息都白跑一次压缩请求）
  let failedAutoCompacts = 0
  // microcompact 开关：token 超过压缩阈值 85% 时启用并在本轮内保持启用。
  // 清理集合只增不减 → 请求前缀在后续轮次保持稳定，不会反复破坏缓存。
  let microCompactEnabled = false
  // 用量累计（子代理 run 的 usage 统计口径；主对话另有全局 recordUsage）
  let accumulatedTokens = 0
  let toolCallCount = 0

  // ── 变体生效设置：子代理按 profile 覆盖模型与推理参数（模型请求/压缩阈值共用同一份）──
  const effectiveSettings: AgentSettings = isSub && subAgent
    ? {
        ...settings,
        ...(subAgent.model ? { model: subAgent.model } : {}),
        ...(subAgent.reasoningEffort !== undefined ? { reasoningEffort: subAgent.reasoningEffort } : {}),
        ...(subAgent.thinking !== undefined ? { enableThinking: subAgent.thinking } : {}),
        ...(subAgent.thinkingBudget !== undefined ? { thinkingBudget: subAgent.thinkingBudget } : {}),
      }
    : settings
  // token 锚点：主对话用会话级 tracker（与上下文用量指示器同源）；子代理独立持有，
  // 保持父会话的估算不被子代理流量污染
  const tokenTracker = isSub ? new TokenTracker() : ctx.tokenTracker
  // read_file 快照：主对话沿用 ctx.readFiles（压缩后整体替换，外部视图保持一致）；
  // 子代理持有独立快照（auto-compact 文件恢复用）
  let readFileState = isSub ? new Map<string, ReadFileSnapshot>() : ctx.readFiles

  // maxTurns：主循环护栏；子代理 profile 显式值封顶主循环上限
  const maxTurns = isMain
    ? MAX_REACT_ITERATIONS
    : Math.min(
        subAgent?.maxTurns && subAgent.maxTurns > 0 ? subAgent.maxTurns : DEFAULT_SUBAGENT_MAX_TURNS,
        MAX_REACT_ITERATIONS
      )

  /** 执行一次自动压缩：成功后 conversationMessages 换为 API 子集并返回 true；
   *  失败（含「消息不足」）返回 false，由调用方决定回退策略（回落 truncateMessages）。 */
  const performAutoCompact = async (): Promise<boolean> => {
    // ── 压缩过程展示（仅主对话）：插入"正在压缩上下文"占位消息 ──
    const compactingId = makeId()
    if (isMain) {
      sink.add({ id: compactingId, role: 'assistant', content: '', timestamp: Date.now(), _isCompacting: true })
    }
    try {
      const compactionResult = await compactConversation(
        conversationMessages,
        effectiveSettings,
        readFileState,
        isSub ? i18n.t('agent.subAgentCompactInstruction', { name: subAgent?.name ?? '' }) : undefined,
        'auto'
      )
      // Recompute the keep boundary (same logic as inside compactConversation)
      const keepStartIndex = findKeepBoundaryIndex(conversationMessages)
      const keptMessages = conversationMessages.slice(keepStartIndex)
      // 被压缩的历史消息（压缩点之前）——用户仍要在界面上看到它们，故保留但不发给 API
      const summarizedMessages = conversationMessages.slice(0, keepStartIndex)

      // 发给 API 的消息：只含 边界 + 摘要 + 保留的新消息 + 文件附件（真正释放 token）
      const apiMessagesAfterCompact = [
        compactionResult.boundaryMessage,
        compactionResult.summaryMessage,
        ...keptMessages,
        ...compactionResult.fileAttachments,
      ]

      if (isMain) {
        // 界面/DB 消息：完整保留全部历史（含压缩点之前的 summarizedMessages），
        // 压缩组件（边界 + 摘要）插在压缩点位置，用户依旧能看到全部对话记录。
        // 宿主据此整段原子重写；渲染层 store.compact 同步内存。
        ports.store.compact(
          sessionId,
          [...summarizedMessages, ...apiMessagesAfterCompact],
          compactionResult.boundaryMessage.id
        )
      }

      // 后续迭代的 conversationMessages 用 API 子集（释放 token）
      conversationMessages = apiMessagesAfterCompact

      // Clear the read file state (it's now in file attachments)
      readFileState = new Map()
      if (isMain) ctx.readFiles = readFileState
      // Reset the token tracker after compaction so stale usage cannot retrigger it.
      // 下一轮 getTokenCount 会取 max(lastUsage, estimated)，导致继续误判超过阈值，
      // 反复进入 compactConversation 并抛 "Not enough messages to compact"。
      tokenTracker.reset()

      console.log(`[compact] Auto-compacted${isSub ? ` [subagent:${subAgentId}]` : ''}: ${compactionResult.preCompactTokenCount} → ${compactionResult.postCompactTokenCount} tokens, ${compactionResult.boundaryMessage.compactMetadata?.messagesSummarized} messages summarized`)
      return true
    } catch (err) {
      console.error('[compact] Auto-compaction failed, falling back to truncateMessages:', err)
      // 压缩失败：把"正在压缩"占位消息改为可见提示，避免残留空白占位（仅主对话有占位）
      if (isMain) {
        sink.update(compactingId, { content: i18n.t('chat.compactFailed'), _isCompacting: false })
      }
      return false
    }
  }

  // ── 多子代理编排：通知与 steering 的消费点 ──

  /** 主对话：把已完成后台子代理的待投通知合并为一条 isSubAgentNotice 消息注入。
   *  多条合并 = 同批完成只花一轮模型调用（对齐 ZCode 的通知批处理）。
   *  在循环启动与每轮迭代顶部调用：主循环空闲时通知留存，随下一条用户消息注入。 */
  const drainSubagentNotifications = (): void => {
    if (!isMain || ctx.pendingSubagentNotifications.length === 0) return
    const joined = ctx.pendingSubagentNotifications.splice(0).join('\n\n')
    const notice: Message = {
      id: makeId(),
      role: 'user',
      content: `<background-agent-notifications>\n${joined}\n</background-agent-notifications>`,
      timestamp: Date.now(),
      isSubAgentNotice: true,
    }
    ports.store.addMessage(sessionId, notice)
    conversationMessages.push(notice)
  }

  /** 子代理：消费 steering 队列（send_message_to_agent / 详情面板注入），逐条入对话。
   *  运行中的子代理在下一轮迭代顶部看到注入的指令。 */
  const drainSubagentSteering = (): void => {
    if (!isSub) return
    const record = ctx.subagentRuns.get(subAgentId)
    if (!record) return
    for (const text of record.pendingMessages.splice(0)) {
      const steerMsg = stampMessage({ id: makeId(), role: 'user', content: text, timestamp: Date.now() })
      sink.add(steerMsg)
      conversationMessages.push(steerMsg)
    }
  }

  // ── 主对话专属：spawn_agent / send_message_to_agent 的工具侧入口。
  // 子代理的工具 ctx 不注入这两个闭包 → 派发/续聊工具在子代理内不可用（无嵌套派生）。──
  const mainSpawnSubAgent = async (agentType: string, subPrompt: string, spawnOpts?: { runInBackground?: boolean; signal?: AbortSignal }): Promise<string> => {
    // 先验证 agent 再落卡片：若 findAgent 失败则卡片已持久化但 runs store 无记录，成为永久孤儿
    const agent = await ports.tools.findAgent(agentType, getWorkingDir(ports, ctx))
    if (!agent) {
      return i18n.t('agent.unknownAgentType', { type: agentType })
    }
    const newSubAgentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    ports.store.addMessage(sessionId, {
      id: makeId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isSubAgentCard: true,
      subAgentId: newSubAgentId,
    })
    // run_in_background 显式指定优先；未指定时采纳 profile 的默认后台标记
    if (spawnOpts?.runInBackground || agent.background === true) {
      return launchBackgroundSubagent(ports, ctx, agent, newSubAgentId, subPrompt)
    }
    // 外部中止信号（后台工作流）：链接出一个派生控制器——工作流被停时在飞的
    // 子代理立即收到 abort，而不是等它自然跑完。父控制器语义原样保留。
    let effectiveController = controller
    if (spawnOpts?.signal) {
      const linked = new AbortController()
      if (spawnOpts.signal.aborted) linked.abort()
      else spawnOpts.signal.addEventListener('abort', () => linked.abort(new Error('[aborted] 工作流已停止')), { once: true })
      effectiveController = linked
    }
    try {
      const subResult = await runSubAgentLoop(ports, ctx, agentType, subPrompt, effectiveController, newSubAgentId)
      if (subResult === '[aborted]') return subResult
      // 前台结果 = 正文 + agentId 续聊引导 + 用量块。agentId 是续聊的唯一钥匙：
      // 没有它模型只能靠复述上下文重新 spawn，上下文与 token 双输。
      const record = ctx.subagentRuns.get(newSubAgentId)
      const usage = record?.usage
      const usageLine = usage
        ? `
<usage>subagent_tokens: ${usage.totalTokens}, tool_uses: ${usage.toolCalls}, duration_ms: ${usage.durationMs}</usage>`
        : ''
      return `${subResult}

agentId: ${newSubAgentId} (use send_message_to_agent with agent_id: '${newSubAgentId}' to continue this agent)${usageLine}`
    } catch (e) {
      return i18n.t('agent.subAgentFailed', { message: e instanceof Error ? e.message : String(e) })
    }
  }

  const mainSendMessageToAgent = async (agentId: string, message: string): Promise<string> =>
    deliverToSubagent(ports, ctx, agentId, message)

  // 主对话专属工具 ctx 附加件（预构建为 Partial<ToolContext>，保持箭头函数参数的上下文类型；
  // 子代理展开空对象——派发/续聊/交互/待办在子代理语境没有执行面，schema 层也已隐藏）。
  // recordImage 例外：它是逐调用的截图旁路，留在 execOne 内部（子代理没有图像工具，恒空）。
  const mainToolCtxExtras: Partial<ToolContext> = isMain ? {
    requestUserInput: (questions) => ports.ui.askQuestion(sessionId, questions),
    updateTodoList: (items) => ports.ui.setTodos(sessionId, items),
    spawnSubAgent: mainSpawnSubAgent,
    sendMessageToAgent: mainSendMessageToAgent,
  } : {}

  for (let iteration = 0; ; iteration++) {
    if (controller.signal.aborted) {
      return { text: '', aborted: true, totalTokens: accumulatedTokens || null, toolCallCount, messages: conversationMessages }
    }

    // ── 编排消费点：后台子代理完成通知（主对话）与 steering 注入（子代理）──
    drainSubagentNotifications()
    drainSubagentSteering()

    // Auto-compact check: if token count exceeds threshold, summarize older messages
    // 阈值 = 输入预算 − 20K 缓冲（与模型高级设置联动）
    const compactInputBudget = (() => {
      const m = effectiveSettings.providers
        .find((p) => p.id === effectiveSettings.activeProviderId)
        ?.models.find((x) => x.id === effectiveSettings.activeModelId)
      return m?.maxInputTokens ?? effectiveSettings.maxInputTokens ?? 184000
    })()
    const autoCompactThreshold = Math.max(compactInputBudget - 20000, Math.floor(compactInputBudget * 0.8))
    // 判定口径与 buildAPIMessages 一致：只统计 API 实际发送的消息子集。
    // 旧实现对全量历史（含已被压缩的旧消息）估算，导致压缩后依然超阈值、
    // 每次发消息都误触发压缩（而用量指示器按子集统计显示 30%+，两边对不上）。
    const apiVisibleMessages = getApiVisibleMessages(conversationMessages)
    const currentTokenCount = tokenTracker.getTokenCount(apiVisibleMessages)
    if (currentTokenCount > autoCompactThreshold && apiVisibleMessages.length > 12 && failedAutoCompacts < MAX_AUTO_COMPACT_FAILURES) {
      // 连续失败计数：成功归零，达到阈值后本轮运行内不再自动触发（防死亡螺旋）
      if (await performAutoCompact()) failedAutoCompacts = 0
      else failedAutoCompacts++
    }
    // microcompact 触发：接近压缩阈值但还没到 → 先清老工具输出顶一顶（比全量压缩便宜得多）
    if (currentTokenCount > Math.floor(autoCompactThreshold * 0.85)) microCompactEnabled = true

    // Build API messages from conversation history (with auto-truncation for long conversations)
    // 子代理：system prompt 整体换成 profile 的 systemPrompt，不带记忆/技能目录/任务工作流/AGENTS.md
    const apiMessages = truncateMessages(effectiveSettings, await buildAPIMessages(ports, ctx, conversationMessages, {
      workingDir,
      memoryPrompt,
      agentsMdContent,
      taskMode: isMain ? effectiveTaskMode : undefined,
      goalCondition: isMain ? goalCondition : undefined,
      skillCatalog: isMain ? undefined : [],
      skillReminder: isMain ? variant.skillReminder : undefined,
      extraSystemPrompt: isSub ? subAgent?.systemPrompt : undefined,
      harnessMode: isMain ? harnessMode : undefined,
      isGitRepo,
      clearOldToolResults: microCompactEnabled,
    }))

    // Parse streaming response
    let content = ''
    let thinkingContent = ''
    let finishReason: string | null = null
    let turnUsage: TokenUsage | undefined
    const assistantId = makeId()
    let lastStreamUpdate = 0  // Throttle for streaming tool call updates
    let placeholderAdded = false

    // 单轮模型调用（可重试）：callAPI 建流 + 占位消息 + parseStream 解析。
    // 429/502/超时/网络中断等瞬时错误用指数退避自动重试（最多 5 次）。
    // 占位消息只 add 一次，重试时复用同一 assistantId，避免残留多条空消息。
    const runModelTurn = async (): Promise<Awaited<ReturnType<typeof parseStream>>> => {
      const response = await callAPI(ports, apiMessages, controller, {
        thinkingBlocks,
        harnessMode: isMain ? harnessMode : undefined,
        modelOverride: isSub ? subAgent?.model : undefined,
        settingsOverride: isSub && subAgent ? {
          ...(subAgent.model ? { model: subAgent.model } : {}),
          ...(subAgent.reasoningEffort !== undefined ? { reasoningEffort: subAgent.reasoningEffort } : {}),
          ...(subAgent.thinking !== undefined ? { enableThinking: subAgent.thinking } : {}),
          ...(subAgent.thinkingBudget !== undefined ? { thinkingBudget: subAgent.thinkingBudget } : {}),
        } : undefined,
        // 子代理：schema 级工具裁剪 —— 白/黑名单 + 派发/交互工具 + Agent 动作工具全部
        // 从发给模型的工具列表里摘掉，而不是等执行期拒绝
        toolFilter: isSub
          ? { allowedTools: subAgent?.tools, disallowedTools: subAgent?.disallowedTools, hidden: SUBAGENT_HIDDEN_TOOLS }
          : undefined,
      })
      if (!placeholderAdded) {
        // Create assistant message placeholder
        sink.add(stampMessage({
          id: assistantId,
          role: 'assistant',
          content: '',
          thinkingContent: '',
          timestamp: Date.now(),
          _isStreaming: true,  // Mark as currently streaming
        }))
        placeholderAdded = true
      }
      // 每轮重试前重置累计，避免上一轮残留内容污染本轮
      content = ''
      thinkingContent = ''
      finishReason = null
      turnUsage = undefined
      return parseStream(response, controller, {
        onContent: (text) => {
          content += text
          // Throttle stream updates to limit whole-database writes and React renders.
          // 旧实现每个 SSE chunk 都触发 updateMessage → 同步写整个 DB 文件 + React 重渲染，
          // 10K 字回答会触发上千次 DB 写入。节流后只在 ~20fps 更新 UI，DB 写入也相应减少。
          const now = Date.now()
          if (now - lastStreamUpdate < 50) return
          lastStreamUpdate = now
          sink.update(assistantId, { content })
        },
        onThinking: (text) => {
          thinkingContent += text
          const now = Date.now()
          if (now - lastStreamUpdate < 50) return
          lastStreamUpdate = now
          sink.update(assistantId, { thinkingContent })
        },
        onToolCallUpdate: (calls) => {
          // Throttle streaming tool call updates to ~20fps for performance
          const now = Date.now()
          if (now - lastStreamUpdate < 50) return
          lastStreamUpdate = now
          const streamingCalls: StreamingToolCall[] = []
          for (const [, tc] of calls) {
            streamingCalls.push({ id: tc.id, name: tc.name, argsSoFar: tc.args })
          }
          sink.update(assistantId, { streamingToolCalls: streamingCalls })
        },
        onFinish: (reason) => {
          // Flush the final buffered content so the persisted response is complete.
          sink.update(assistantId, { content, thinkingContent })
          finishReason = reason
        },
        onUsage: (usage: TokenUsage) => {
          turnUsage = usage
          tokenTracker.recordUsage(usage)
          accumulatedTokens += usage.total_tokens
          if (isMain) {
            // 累计到全局 token 用量统计（供设置页通用栏展示）
            try {
              ports.ui.recordUsage({
                usage,
                sessionId,
                model: settings.model,
                providerId: settings.activeProviderId,
              })
            } catch (error) {
              console.error('[use-agent] record token usage failed:', error)
            }
          }
        },
        onThinkingBlock: (block) => {
          const list = thinkingBlocks.get(assistantId)
          if (list) list.push(block)
          else thinkingBlocks.set(assistantId, [block])
        },
      })
    }

    let toolCallBuffers: Awaited<ReturnType<typeof parseStream>>
    try {
      toolCallBuffers = await runWithRetry(runModelTurn, {
        retries: 5,
        shouldRetry: (err) => !controller.signal.aborted && isRetryableError(err),
        getRetryAfterMs: extractRetryAfterMs,
        onRetry: (attempt) => {
          // 重试过程中在占位消息上展示「正在重试」提示
          if (placeholderAdded) {
            sink.update(assistantId, {
              _isStreaming: true,
              _retrying: { attempt },
              content,
              thinkingContent,
            })
          }
        },
      })
      // 重试成功：清除重试标记
      sink.update(assistantId, { _retrying: undefined })
    } catch (err) {
      // 重试全部失败：把已添加的占位消息标记为非流式，避免残留一条永远 loading 的空消息
      if (placeholderAdded) sink.update(assistantId, { _isStreaming: false, _retrying: undefined })
      // 溢出恢复链：请求真的超上下文时重试无意义——强制压缩一次并重放本轮。
      // 仅恢复一次（overflowRecovered 单次标记），仍溢出则把错误抛给用户。
      if (!overflowRecovered && !controller.signal.aborted && isContextOverflowError(err)) {
        overflowRecovered = true
        if (await performAutoCompact()) continue
      }
      throw err
    }

    // A canceled stream must not continue into side-effecting tool calls.
    // 若已中断则跳过工具调用执行（包括 execute_command/write_file 等有副作用的工具），
    // 直接退出循环。仍会写入最终内容（已在上面的 updateMessage 完成）。
    if (controller.signal.aborted) {
      // 更新消息标记为非流式，但不执行工具
      sink.update(assistantId, { _isStreaming: false })
      return { text: '', aborted: true, totalTokens: accumulatedTokens || null, toolCallCount, messages: conversationMessages }
    }

    // Parse final tool calls
    const toolCalls: ToolCall[] = []
    for (const [, tc] of toolCallBuffers) {
      if (tc.name) {
        try {
          const args = tc.args ? JSON.parse(tc.args) : {}
          toolCalls.push({ id: tc.id, name: tc.name, arguments: args })
        } catch {
          toolCalls.push({ id: tc.id, name: tc.name, arguments: { _raw: tc.args } })
        }
      }
    }

    // Check for truncation
    if (finishReason === 'length') {
      content += `\n\n${i18n.t(isSub ? 'agent.subAgentTruncated' : 'agent.outputTruncated')}`
    }

    // Update the assistant message with final content
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: content || '',
      thinkingContent: thinkingContent || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: finishReason || undefined,
      usage: turnUsage,
      timestamp: Date.now(),
      streamingToolCalls: undefined,  // Clear streaming data after completion
      _isStreaming: false,  // Stream completed
    }
    sink.update(assistantId, assistantMessage)
    conversationMessages.push(stampMessage(assistantMessage))

    /** 本轮终点的统一返回结构（text = 本轮正文；aborted 取当前取消态） */
    const finishResult = (): AgentLoopResult => ({
      text: content,
      aborted: controller.signal.aborted,
      totalTokens: accumulatedTokens || null,
      toolCallCount,
      messages: conversationMessages,
    })

    // No tool calls → we're done
    if (toolCalls.length === 0) {
      if (isSub) {
        // 子代理：无工具调用的那轮正文即为结果
        return finishResult()
      }

      // TencentDB Agent Memory：保留本地会话为事实来源，同时异步捕获 L0。
      // Gateway 不可用时静默回退，不阻塞当前回复。
      void ports.ui.agentMemoryCapture({
        sessionId,
        workingDir,
        messages: conversationMessages
          .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
          .map((message) => ({
            id: message.id,
            role: message.role as 'user' | 'assistant' | 'system',
            content: message.content,
            timestamp: new Date(message.timestamp).toISOString(),
          })),
      }).catch(() => {})

      // 工作流标记处理（/spec /goal）：
      // - spec：检测到完成标记 → 仅从显示中剥离并结束本轮（停下等用户确认，
      //   用户确认后的下一条消息以普通模式运行，模型会重读文档开始执行）
      // - goal：[GOAL_COMPLETE] 剥离显示，保留完成报告
      const completionMarkers: Array<{ marker: string; enabled: boolean }> = [
        { marker: '[SPEC_COMPLETE]', enabled: effectiveTaskMode === 'spec' },
        { marker: '[GOAL_COMPLETE]', enabled: effectiveTaskMode === 'goal' },
      ]
      const hitMarker = completionMarkers.find((m) => m.enabled && content.includes(m.marker))
      let cleanedContent: string | null = null
      if (hitMarker) {
        cleanedContent = content.split(hitMarker.marker).join('').trim()
        ports.store.updateMessage(sessionId, assistantId, { content: cleanedContent })
      }

      // ── Goal 独立评估器三态闭环（对齐 Claude Code /goal）：
      // 目标 active 时，在每轮收尾用独立评估判定：in_progress → 注入评估理由自动续跑；
      // achieved/impossible → 终态卡片并结束。[GOAL_COMPLETE] 为快速通道，短路评估省一次调用。 ──
      const goalNow = ports.goal.get(sessionId)
      if (goalNow?.status === 'active' && effectiveTaskMode === 'goal' && !controller.signal.aborted) {
        goalIdleEvaluations = iterationHadToolCalls ? 0 : goalIdleEvaluations + 1
        const addGoalCard = (verdict: GoalVerdict, reason: string) => {
          ports.store.addMessage(sessionId, {
            id: makeId(),
            role: 'system',
            content: '',
            timestamp: Date.now(),
            goalEvent: { verdict, reason, evaluations: goalEvaluationsThisRun },
          })
        }

        // 快速通道：模型已自报完成标记并给出完成报告 → 直接置 achieved
        if (hitMarker?.marker === '[GOAL_COMPLETE]') {
          goalEvaluationsThisRun++
          const conclusion = (cleanedContent || '').slice(0, 300)
          ports.goal.updateGoal(sessionId, {
            status: 'achieved',
            evaluations: goalNow.evaluations + 1,
            conclusion,
          })
          addGoalCard('achieved', conclusion || i18n.t('goal.noReport'))
          collapseIntermediateMessages(ports, sessionId, assistantId)
          return finishResult()
        }

        // 护栏：收尾轮（工具已禁用强制总结）/ 连续空转 / 评估上限 → 暂停续跑但保留目标
        if (wrapUpInjected || goalIdleEvaluations > GOAL_IDLE_EVALUATION_LIMIT || goalEvaluationsThisRun >= GOAL_MAX_EVALUATIONS_PER_RUN) {
          const pauseReason = wrapUpInjected
            ? i18n.t('goal.turnLimitPaused')
            : goalIdleEvaluations > GOAL_IDLE_EVALUATION_LIMIT
              ? i18n.t('goal.idlePaused', { count: GOAL_IDLE_EVALUATION_LIMIT + 1 })
              : i18n.t('goal.evalLimitPaused', { count: GOAL_MAX_EVALUATIONS_PER_RUN })
          addGoalCard('in_progress', pauseReason)
          collapseIntermediateMessages(ports, sessionId, assistantId)
          return finishResult()
        }

        // 评估器判定（调用失败不阻断：保留目标，结束本次运行，用户下一条消息自然恢复）
        try {
          goalEvaluationsThisRun++
          const evaluation = await evaluateGoal(goalNow.condition, controller)
          ports.goal.updateGoal(sessionId, {
            evaluations: goalNow.evaluations + 1,
            lastReason: evaluation.reason,
          })
          if (evaluation.verdict === 'achieved') {
            ports.goal.updateGoal(sessionId, { status: 'achieved', conclusion: evaluation.reason })
            addGoalCard('achieved', evaluation.reason)
            collapseIntermediateMessages(ports, sessionId, assistantId)
            return finishResult()
          }
          if (evaluation.verdict === 'impossible') {
            ports.goal.updateGoal(sessionId, { status: 'failed', conclusion: evaluation.reason })
            addGoalCard('impossible', evaluation.reason)
            collapseIntermediateMessages(ports, sessionId, assistantId)
            return finishResult()
          }
          // in_progress：评估理由作为下一轮引导注入对话，自动续跑
          addGoalCard('in_progress', evaluation.reason)
          const guidanceMsg: Message = {
            id: makeId(),
            role: 'user',
            content: i18n.t('goal.continuePrompt', { n: goalEvaluationsThisRun, reason: evaluation.reason }),
            timestamp: Date.now(),
          }
          ports.store.addMessage(sessionId, guidanceMsg)
          conversationMessages.push(guidanceMsg)
          continue
        } catch (err) {
          if (controller.signal.aborted) return finishResult()
          console.error('[goal] evaluator failed:', err)
          addGoalCard('in_progress', i18n.t('goal.evaluatorFailed'))
          collapseIntermediateMessages(ports, sessionId, assistantId)
          return finishResult()
        }
      }

      // Collapse all intermediate assistant messages (those that had tool calls)
      // Only keep the final assistant message expanded
      collapseIntermediateMessages(ports, sessionId, assistantId)
      return finishResult()
    }

    // Execute tool calls (并行执行：同一批 toolCalls 互相独立)
    // 中断后立即跳过工具执行，避免点停止后还在跑命令
    if (controller.signal.aborted) {
      sink.update(assistantId, { _isStreaming: false })
      return finishResult()
    }

    // ── 截断响应保护：finishReason=length 时本轮所有工具调用一律不执行。
    // 流式参数经 JSON 抢救解析后可能"恰好合法但不完整"，执行有副作用的工具会损坏文件。
    if (finishReason === 'length') {
      const refused: ToolResult[] = toolCalls.map((tc) => ({
        toolCallId: tc.id,
        content: toolCallRefusal(tc.name, TRUNCATED_TOOL_CALL_REASON),
        isError: true,
      }))
      sink.update(assistantId, { toolResults: refused })
      for (const r of refused) {
        const toolMsg = stampMessage({ id: makeId(), role: 'tool', content: r.content, timestamp: Date.now(), toolResults: [r] })
        sink.add(toolMsg)
        conversationMessages.push(toolMsg)
      }
      continue
    }

    // ── 残缺参数保护：流静默中断（网络断/服务端提前关闭，无 finish_reason）时
    // length 保护不生效，JSON 解析失败的调用会以 { _raw } 兜底混进列表，
    // 执行可能写坏文件（如 write_file 缺 content → 写入 "undefined"）。
    // 拒绝本轮全部工具调用，模型下一轮会带完整参数重发。 ──
    if (toolCalls.some((tc) => tc.arguments && '_raw' in tc.arguments)) {
      const refused: ToolResult[] = toolCalls.map((tc) => ({
        toolCallId: tc.id,
        content: toolCallRefusal(tc.name, TRUNCATED_TOOL_CALL_REASON),
        isError: true,
      }))
      sink.update(assistantId, { toolResults: refused })
      for (const r of refused) {
        const toolMsg = stampMessage({ id: makeId(), role: 'tool', content: r.content, timestamp: Date.now(), toolResults: [r] })
        sink.add(toolMsg)
        conversationMessages.push(toolMsg)
      }
      continue
    }

// ── 轮次上限收尾：工具执行轮数用尽后不再执行工具，给模型一次文字总结的机会
//（参考 opencode MAX_STEPS：硬停会丢掉整个 run 的总结）。
// 收尾轮若仍坚持调用工具 → 全部拒绝并退出循环，走兜底提示。 ──
    if (toolExecutionTurns >= maxTurns || wrapUpInjected) {
      const refused: ToolResult[] = toolCalls.map((tc) => ({
        toolCallId: tc.id,
        content: toolCallRefusal(tc.name, wrapUpInjected
          ? 'tool calls are disabled for this run — reply with your final text summary now'
          : 'maximum tool-call turns reached for this run'),
        isError: true,
      }))
      sink.update(assistantId, { toolResults: refused })
      for (const r of refused) {
        const toolMsg = stampMessage({ id: makeId(), role: 'tool', content: r.content, timestamp: Date.now(), toolResults: [r] })
        sink.add(toolMsg)
        conversationMessages.push(toolMsg)
      }
      if (wrapUpInjected) break
      wrapUpInjected = true
      // 收尾指令**只进本轮内存，不落库**。
      // 落库会让它变成一条真实的用户消息持久化：用户会看到一条自己没发过的
      // 「⚠️ 已达上限，立刻交总结」，且下一次运行会把它当成人话读回去持续压着模型。
      // 参照 goal 模式的做法：终止状态该走 UI 状态，不该伪装成用户输入。
      conversationMessages.push({
        id: makeId(),
        role: 'user',
        content: MAX_STEPS_MESSAGE,
        timestamp: Date.now(),
      })
      continue
    }

    const results: ToolResult[] = []
    // 本轮 read_file 命中的技能 SKILL.md（AI 自主加载感知，随本轮助手消息展示；仅主对话）
    const turnLoadedSkills = new Map<string, { id: string; name: string; icon: string; slug: string }>()

    const execOne = async (tc: ToolCall, runController: AbortController): Promise<ToolResult> => {
      // 中断后立即返回，不再派发新工具
      if (runController.signal.aborted) {
        return {
          toolCallId: tc.id,
          content: i18n.t('agent.interrupted'),
          isError: true,
        }
      }
      // doom-loop 检测：连续多次完全相同的调用直接拒绝（放在权限检查前，避免重复弹确认框）
      // Agent 动作工具豁免：连续点同一个坐标、连续按同一个键，本来就是「确认这一步生效了吗」
      // 的正常交互节奏，被当成死循环拦下会让这类任务根本做不下去。
      const callSig = `${tc.name}\u0000${JSON.stringify(tc.arguments ?? {})}`
      if (!agentActionFamily(tc.name) && isDoomLoopSig(recentToolSignatures, callSig)) {
        return {
          toolCallId: tc.id,
          content: toolCallRefusal(tc.name, DOOM_LOOP_REFUSAL),
          isError: true,
        }
      }
      // Permission check（子代理按 profile 白/黑名单进一步收窄，绝不放宽；
      // 任务工作流的 plan/spec 限制不传入子代理——它只作用于发起规划的那条消息）
      const permResult = await checkToolPermission(ports, ctx, tc.name, tc.arguments, isSub
        ? { taskMode: null, allowedTools: subAgent?.tools, disallowedTools: subAgent?.disallowedTools }
        : {})
      if (!permResult.allowed) {
        return {
          toolCallId: tc.id,
          content: i18n.t('agent.permissionDenied', { reason: permResult.reason }),
          isError: true,
        }
      }

      // Inject working dir for tools that support cwd
      const argsWithCwd = { ...tc.arguments }
      if (workingDir) {
        if (tc.name === 'execute_command') {
          argsWithCwd.cwd = resolveToolPath(workingDir, argsWithCwd.cwd || workingDir)
        }
        if (tc.name === 'read_file' || tc.name === 'write_file' || tc.name === 'search_replace' || tc.name === 'read_image') {
          argsWithCwd.path = resolveToolPath(workingDir, argsWithCwd.path)
        }
        if (tc.name === 'list_dir' || tc.name === 'search_files' || tc.name === 'search_content') {
          argsWithCwd.path = resolveToolPath(workingDir, argsWithCwd.path)
        }
      }

      try {
        // 视觉观测走旁路：工具仍只回字符串，这里收集它顺手上报的截图
        const capturedImages: ToolResultImage[] = []
        const result = await ports.tools.execute(tc.name, argsWithCwd, {
          workingDir,
          homeDir,
          sessionId,
          // 浮层副标题要显示「哪个对话在动手」：AI 操控用户桌面时用户需要能追责（仅主对话）
          sessionLabel: isMain ? (ctx.sessionTitle ?? undefined) : undefined,
          readFileState,
          toolCallId: tc.id,
          // 后台工作流 settle 后要更新这条 assistant 消息里的工具尾巴
          assistantMessageId: isMain ? assistantId : undefined,
          recordFileMutation: (mutation) => recordFileMutation(ports, ctx, mutation),
          // 截图旁路（Browser/Computer Use）：仅主对话的图像工具会上报，子代理恒为空数组
          recordImage: (image) => { capturedImages.push(image) },
          // 工作流实时看板：渲染层宿主直写 store，主进程宿主走事件回流（两者只命中一个）
          onWorkflowProgress: (snapshot) => {
            ports.workflowProgress?.(sessionId, tc.id, snapshot)
            ports.emit({ type: 'workflow.updated', sessionId, toolCallId: tc.id, snapshot })
          },
          // 后台工作流宿主桥（仅主对话）：settle 时注回通知 / 尾巴 / journal / 唤醒
          workflowHost: isMain
            ? {
                updateToolResultTail: (tailCallId, content) =>
                  replaceToolResultContent(ports, sessionId, assistantId, tailCallId, content),
                pushNotification: (text) => { ctx.pendingSubagentNotifications.push(text) },
                requestWake: () => ctx.requestWake?.(),
                journalPut: (run) => ports.workflowJournal?.put(run as WorkflowRun),
              }
            : undefined,
          // spawn / 续聊 / 交互 / 待办仅主对话注入：子代理没有这些执行面，
          // 对应工具也在 schema 层被裁掉（SUBAGENT_HIDDEN_TOOLS）
          ...mainToolCtxExtras,
        })
        // 记录已执行调用的签名（含失败结果），供 doom-loop 连续性判定
        recentToolSignatures.push(callSig)
        const isError = result.startsWith('Error') || result.startsWith('❌')
        // 快照覆盖不到的工具（shell / MCP / 未知副作用）只要成功就可能动过文件，
        // 标成缺口：带文件的撤回必须 fail-closed，不能假装本轮没改过东西。
        if (!isError) recordToolGap(ports, ctx, tc.name)
        // AI 自主加载感知：read_file 命中技能 SKILL.md → 记录快照（本轮展示芯片）
        if (isMain && tc.name === 'read_file' && !isError) {
          const hit = skillPathMap.get(normalizePathForComparison(String(argsWithCwd.path || '')))
          if (hit) turnLoadedSkills.set(hit.id, hit)
        }
        return {
          toolCallId: tc.id,
          content: result,
          isError,
          // 失败的截图不外发：失败原因的文字说明已经足够，一张半渲染的图只会误导模型
          ...(!isError && capturedImages.length > 0 ? { images: capturedImages } : {}),
        }
      } catch (err) {
        return {
          toolCallId: tc.id,
          content: i18n.t('agent.toolExecFailed', { message: err instanceof Error ? err.message : String(err) }),
          isError: true,
        }
      }
    }

    // Preserve model order for side-effecting tools; read-only calls can still run concurrently.
    // MCP 工具（mcp__ 前缀）可能带副作用，统一按顺序执行
    // scheduled_task 也在此列：它写提案 KV，并发调用会互相盖同一份数组。
    // spawn_agent / send_message_to_agent 是编排动作而非直接副作用：多个子代理互相独立，
    // 同消息派发走并行批（真并行——旧实现把它误列在串行集合里，描述与行为矛盾）。
      const sideEffectingTools = new Set(['write_file', 'search_replace', 'execute_command', 'save_memory', 'question', 'todowrite', 'scheduled_task', 'create_workflow', 'save_workflow'])
    const isSideEffecting = (toolName: string) =>
      sideEffectingTools.has(toolName) || toolName.startsWith('mcp__')
    const orderedResults: Array<ToolResult | undefined> = Array.from({ length: toolCalls.length })
    const readOnlyJobs: Array<Promise<void>> = []
    for (const [index, toolCall] of toolCalls.entries()) {
      // 中断后立即停止派发后续工具
      if (controller.signal.aborted) {
        orderedResults[index] = {
          toolCallId: toolCall.id,
          content: i18n.t('agent.interrupted'),
          isError: true,
        }
        continue
      }
      if (isSideEffecting(toolCall.name)) {
        orderedResults[index] = await execOne(toolCall, controller)
      } else {
        readOnlyJobs.push(execOne(toolCall, controller).then((result) => { orderedResults[index] = result }))
      }
    }
    await Promise.all(readOnlyJobs)
    results.push(...orderedResults.filter((result): result is ToolResult => result !== undefined))
    toolCallCount += toolCalls.length
    toolExecutionTurns++
    // 本轮有工具调用 → 重置 goal 空转计数（评估器护栏依据）
    iterationHadToolCalls = true

    // Update assistant message with tool results
    sink.update(assistantId, {
      toolResults: results,
      // 本轮 AI 自主读取的技能 → "已加载技能"芯片（随消息持久化，仅展示用）
      ...(isMain && turnLoadedSkills.size > 0 ? { loadedSkills: [...turnLoadedSkills.values()] } : {}),
    })

    // Add tool result messages to conversation
    for (const r of results) {
      const toolMsg = stampMessage({
        id: makeId(),
        role: 'tool',
        content: r.content,
        timestamp: Date.now(),
        toolResults: [r],
      })
      sink.add(toolMsg)
      conversationMessages.push(toolMsg)
    }

    // 中断后不再发起新一轮 LLM 请求，直接退出循环
    if (controller.signal.aborted) return finishResult()

    // Continue the ReAct loop → model will process tool results and decide next action
  }

  // Safety net - should almost never hit this（收尾轮模型仍坚持调用工具才会走到这里）
  if (isMain) {
    ports.store.addMessage(sessionId, {
      id: makeId(),
      role: 'assistant',
      content: i18n.t('agent.maxTurnsTerminated', { limit: MAX_REACT_ITERATIONS }),
      timestamp: Date.now(),
    })
    return { text: '', aborted: controller.signal.aborted, totalTokens: accumulatedTokens || null, toolCallCount, messages: conversationMessages }
  }
  // 子代理达到 maxTurns：取最后一条消息内容兜底（与旧实现一致）
  const partialResult = conversationMessages[conversationMessages.length - 1]?.content || i18n.t('agent.subAgentMaxTurns')
  return { text: partialResult, aborted: controller.signal.aborted, totalTokens: accumulatedTokens || null, toolCallCount, messages: conversationMessages }
}

/** 渲染层宿主与主进程宿主的既有入口：主对话变体。 */
export async function runReactLoop(
  ports: AgentPorts,
  ctx: SessionContext,
  initialMessages: Message[],
  controller: AbortController,
  taskMode?: TaskMode,
  /** 当轮相关技能提醒（sendMessage 计算；跨轮复用同一文本保证 API 前缀稳定） */
  skillReminder?: string
): Promise<void> {
  await runAgentLoop(ports, ctx, initialMessages, controller, { role: 'main', taskMode, skillReminder })
}

// ═══════════════ 子代理编排层（派生 / 后台 / 续聊 / 通知）═══════════════

/** 为主对话准备子代理任务提示词：goal 目标 active 时附带目标语境 ——
 *  子任务服务于同一目标，结果报告需与目标相关。 */
function buildSubagentTaskPrompt(ports: AgentPorts, ctx: SessionContext, prompt: string): string {
  const activeGoal = ports.goal.get(ports.sessionId)
  if (activeGoal?.status === 'active') {
    return `${prompt}\n\n[Session goal context] The main agent is pursuing this goal: ${activeGoal.condition}. Your subtask contributes to it — report results relevant to the goal.`
  }
  return prompt
}

/**
 * 后台子代理终态：入通知队列 + 请求空闲唤醒。
 *
 * 工作流 settle 早就有 requestWake（v2），后台子代理此前只入队列、必须等用户
 * 发下一条消息才被 drain 消费——体感是「跑完了没反应」。这里复用同一个
 * ctx.requestWake：渲染层宿主持有 wakeSession（守卫齐全：非 streaming / 无
 * controller / 队列非空 / 模式与凭据），主进程宿主没装配则自然降级为下条消息注入。
 */
function pushSubagentNotification(ctx: SessionContext, text: string): void {
  ctx.pendingSubagentNotifications.push(text)
  ctx.requestWake?.()
}

/** 统一的后台子代理完成/失败/停止通知格式（与前台结果回传同一套字段语义） */
function formatSubagentNotification(input: {
  runId: string
  agentName: string
  agentType: string
  status: 'completed' | 'failed' | 'aborted'
  body: string
}): string {
  // body 是子代理的原文（不可信数据面）：先转义会伪造/提前闭合信封的序列，
  // 再由系统拼信封——防伪声明写进信封第一行（报告 03 P0-4，ZCode 同款）。
  const safeBody = escapeEnvelopeSpoofing(input.body)
  return `<subagent-notification agentId="${input.runId}" agent="${input.agentName}" type="${input.agentType}" status="${input.status}">\n${SYSTEM_INJECTION_DISCLAIMER}\n${safeBody}\n</subagent-notification>`
}

/** 后台派生：立即返回确认文本（含 agentId），run 脱离主循环独立执行；
 *  完成后经 ctx.pendingSubagentNotifications 注回主循环。 */
function launchBackgroundSubagent(
  ports: AgentPorts,
  ctx: SessionContext,
  agent: AgentDefinition,
  subAgentId: string,
  prompt: string
): string {
  void runSubAgentLoop(ports, ctx, agent.agentType, prompt, new AbortController(), subAgentId, { background: true })
    .catch(() => { /* 失败收口（failSubAgentRun + 通知）在 wrapper 内完成 */ })
  return i18n.t('agent.subAgentBackgroundLaunched', { id: subAgentId, name: agent.name })
}

/** send_message_to_agent 的三态投递（对齐 ZCode SendMessage）：
 *  1) 运行中 → 压入 steering 队列，循环下一轮迭代顶部消费；
 *  2) 已终态（同进程内存里持有完整对话）→ 携历史后台续跑；
 *  3) 未知 id → 报错并列出本会话已知 agentId。 */
async function deliverToSubagent(
  ports: AgentPorts,
  ctx: SessionContext,
  agentId: string,
  message: string
): Promise<string> {
  const record = ctx.subagentRuns.get(agentId)
  if (!record) {
    const known = [...ctx.subagentRuns.keys()].slice(-20).join(', ')
    return i18n.t('agent.subAgentUnknownId', { id: agentId, known: known || '—' })
  }
  if (record.running) {
    record.pendingMessages.push(message)
    return i18n.t('agent.subAgentSteered', { id: agentId })
  }
  void runSubAgentLoop(ports, ctx, record.agent.agentType, message, new AbortController(), record.id, {
    background: true,
    resumeMessages: [...record.messages],
    resumeCount: record.continuations ?? 0,
  }).catch(() => { /* 失败收口在 wrapper 内完成 */ })
  return i18n.t('agent.subAgentResumed', { id: agentId, name: record.agent.name })
}

/** 派生子 agent 执行独立子任务。
 *  子 agent 拥有独立的对话上下文、工具白/黑名单、system prompt（覆盖主 agent）。
 *  支持自动上下文压缩（auto-compact），结果回流到主对话。
 *  presetSubAgentId: 由调用方预先生成的 ID（用于关联主对话中的卡片消息），不传则内部生成。
 *  opts.background: 后台运行——不与父 controller 级联取消，完成后经通知队列注回主循环。
 *  opts.resumeMessages: 续跑（send_message_to_agent 唤醒）——以既有对话为基础继续。 */
export async function runSubAgentLoop(
  ports: AgentPorts,
  ctx: SessionContext,
  agentType: string,
  prompt: string,
  parentController: AbortController,
  presetSubAgentId?: string,
  opts?: { background?: boolean; resumeMessages?: Message[]; resumeCount?: number }
): Promise<string> {
  const sessionId = ports.sessionId
  const workingDir = getWorkingDir(ports, ctx)
  const agent = await ports.tools.findAgent(agentType, workingDir)
  if (!agent) throw new Error(i18n.t('agent.unknownAgentType', { type: agentType }))
  const background = opts?.background === true
  const resumeMessages = opts?.resumeMessages
  const isResume = (resumeMessages?.length ?? 0) > 0
  const subAgentId = presetSubAgentId || `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = Date.now()

  // controller：后台 run 脱离父级联（父轮取消不再传播，完成后异步收口）；
  // 前台 run 保持既有级联行为。
  const controller = new AbortController()
  let removeParentListener: (() => void) | undefined
  if (!background) {
    if (parentController.signal.aborted) controller.abort()
    const onParentAbort = () => controller.abort()
    parentController.signal.addEventListener('abort', onParentAbort)
    removeParentListener = () => parentController.signal.removeEventListener('abort', onParentAbort)
  }

  // 初始消息：续跑 = 既有对话 + 新指令；新任务 = prompt 作为首条 user 消息
  const initialMessages: Message[] = isResume
    ? [...resumeMessages!, { id: makeId(), role: 'user', content: prompt, timestamp: Date.now() }]
    : [{ id: makeId(), role: 'user', content: buildSubagentTaskPrompt(ports, ctx, prompt), timestamp: Date.now() }]

  if (isResume) {
    // 续跑：卡片已存在，回到 running 并记录续聊代数
    ports.ui.patchSubAgentRun?.(sessionId, subAgentId, {
      status: 'running',
      continuations: (opts?.resumeCount ?? 0) + 1,
      startedAt,
      finishedAt: undefined,
      error: undefined,
      result: undefined,
    })
  } else {
    ports.ui.addSubAgentRun(sessionId, {
      id: subAgentId,
      agentType: agent.agentType,
      agentName: agent.name,
      prompt,
      status: 'running',
      messages: [...initialMessages],
      startedAt,
      ...(background ? { background: true } : {}),
    })
  }

  // 运行记录：复用既有记录（续跑，保留未消费的 steering 队列）；否则新建
  const existing = ctx.subagentRuns.get(subAgentId)
  const record: SubagentRunRecord = existing ?? {
    id: subAgentId,
    agent,
    controller,
    pendingMessages: [],
    messages: initialMessages,
    running: false,
    continuations: 0,
  }
  record.agent = agent
  record.controller = controller
  record.messages = initialMessages
  record.running = true
  if (opts?.resumeCount !== undefined) record.continuations = opts.resumeCount
  ctx.subagentRuns.set(subAgentId, record)
  registerSubagentControl(sessionId, subAgentId, {
    controller,
    steer: (text) => {
      if (!record.running) return false
      record.pendingMessages.push(text)
      return true
    },
  })

  // 记录容量收敛：只保留最近约 50 条（运行中的永不淘汰）
  if (ctx.subagentRuns.size > 60) {
    for (const key of ctx.subagentRuns.keys()) {
      if (ctx.subagentRuns.size <= 50) break
      const rec = ctx.subagentRuns.get(key)
      if (rec && !rec.running) ctx.subagentRuns.delete(key)
    }
  }

  try {
    const result = await runAgentLoop(ports, ctx, initialMessages, controller, {
      role: 'subagent',
      subagent: { agent, subAgentId },
    })
    record.messages = result.messages
    record.running = false
    // Preserve an aborted terminal state instead of reporting a completed run.
    if (result.aborted || controller.signal.aborted) {
      ports.ui.abortSubAgentRun(sessionId, subAgentId)
      if (background) {
        pushSubagentNotification(ctx, formatSubagentNotification({
          runId: subAgentId, agentName: agent.name, agentType: agent.agentType,
          status: 'aborted', body: i18n.t('agent.subAgentStoppedBody'),
        }))
      }
      return '[aborted]'
    }
    const usage = result.totalTokens != null || result.toolCallCount > 0
      ? { totalTokens: result.totalTokens ?? 0, toolCalls: result.toolCallCount, durationMs: Date.now() - startedAt }
      : undefined
    if (usage) record.usage = usage
    ports.ui.completeSubAgentRun(sessionId, subAgentId, result.text)
    if (usage) ports.ui.patchSubAgentRun?.(sessionId, subAgentId, { usage })
    if (background) {
      const usageLine = usage
        ? `\n\n<usage>subagent_tokens: ${usage.totalTokens}, tool_uses: ${usage.toolCalls}, duration_ms: ${usage.durationMs}</usage>`
        : ''
      pushSubagentNotification(ctx, formatSubagentNotification({
        runId: subAgentId, agentName: agent.name, agentType: agent.agentType,
        status: 'completed',
        body: `${(result.text || '(no text output)').slice(0, SUBAGENT_NOTIFICATION_RESULT_CAP)}${usageLine}`,
      }))
    }
    return result.text
  } catch (err) {
    record.running = false
    // Abort signals represent cancellation, not a failed subagent run.
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      ports.ui.abortSubAgentRun(sessionId, subAgentId)
      if (background) {
        pushSubagentNotification(ctx, formatSubagentNotification({
          runId: subAgentId, agentName: agent.name, agentType: agent.agentType,
          status: 'aborted', body: i18n.t('agent.subAgentStoppedBody'),
        }))
      }
      throw new Error('[aborted]')
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    ports.ui.failSubAgentRun(sessionId, subAgentId, errMsg)
    if (background) {
      pushSubagentNotification(ctx, formatSubagentNotification({
        runId: subAgentId, agentName: agent.name, agentType: agent.agentType,
        status: 'failed', body: errMsg,
      }))
    }
    throw err
  } finally {
    removeParentListener?.()
    unregisterSubagentControl(sessionId, subAgentId)
  }
}
