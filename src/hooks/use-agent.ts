import { useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../stores/settings-store'
import { useChatStore, getSessionAbortController, setSessionAbortController } from '../stores/chat-store'
import { useTokenUsageStore } from '../stores/token-usage-store'
import { useSkillsStore } from '../stores/skills-store'
import { toolRegistry } from '../lib/tool-registry'
import { isDangerousCommand } from '../lib/permission-engine'
import { ipc } from '../lib/ipc-client'
import { buildMemoryPrompt } from '../lib/memory'
import { TokenTracker } from '../lib/token-tracker'
import { estimateTokensForText } from '../lib/token-estimate'
import { compactConversation, findKeepBoundaryIndex } from '../lib/compact'
import { computeContextUsage, getApiVisibleMessages, type ContextUsageInfo } from '../lib/context-usage'
import { isPathInside, isSystemPath, resolveToolPath, normalizePathForComparison } from '../lib/path-safety'
import { SYSTEM_PROMPT, CLERKBOX_PROMPT, PLAN_MODE_PROMPT, SPEC_MODE_PROMPT, GOAL_MODE_PROMPT, GOAL_EVALUATOR_PROMPT } from '../lib/prompts'
import { renderSkillCatalog, type SkillCatalogEntry } from '../lib/skill-catalog'
import { buildRelevantSkillReminder } from '../lib/skill-matcher'
import i18n from '../i18n'
import { findAgent } from '../lib/agent-registry'
import { useAgentRunsStore } from '../stores/agent-runs-store'
import { useShallow } from 'zustand/react/shallow'
import { notifyIfNotViewing } from '../lib/notify'
import { openChatStream, sseLines } from '../lib/api-transport'
import { requiresApiKey } from '../lib/provider-catalog'
import {
  buildRequestBody,
  canKeepThinking,
  createParserState,
  parseEvent,
  flushParserState,
  type AnthropicThinkingBlock,
  type NeutralMessage,
} from '../lib/api-adapters'
import type { ApiCompat, GoalVerdict, Message, MessageAttachment, MessageSkillSnapshot, TaskMode, ToolCall, ToolResult, StreamingToolCall, TokenUsage, ReadFileSnapshot } from '../types/agent'
import { useInteractiveStore, useTodoStore } from '../stores/interactive-store'
import { useGoalStore } from '../stores/goal-store'

/** Vite 注入的 env（tsconfig 未含 vite/client 类型，安全取值） */
const IS_DEV = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false

/** 会话级 Agent 能力注册表：供 TitleBar 等 hook 外部组件调用当前会话的手动压缩 / 用量统计 */
export interface SessionAgentEntry {
  manualCompact: (instructions?: string) => Promise<void>
  getUsage: (messages: Message[]) => ContextUsageInfo
}
const sessionAgentRegistry = new Map<string, SessionAgentEntry>()
export function getSessionAgent(sessionId: string | null | undefined): SessionAgentEntry | undefined {
  return sessionId ? sessionAgentRegistry.get(sessionId) : undefined
}

/** 每张多模态图片的固定 token 粗估成本（视觉输入按图片 token 计价，粗估 1000/张，用于截断/预算估算） */
const IMAGE_TOKEN_ESTIMATE = 1000

/** 从 data URL 前缀解析 MIME 类型（如 image/png）；非 data URL 形式返回 undefined */
function mimeFromDataUrl(dataUrl: string): string | undefined {
  return /^data:([^;,]+)/.exec(dataUrl)?.[1]
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

const MAX_REACT_ITERATIONS = 100 // Loop exits when model stops calling tools or hits this cap

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
/** 可被清空的工具：输出大且可重跑。编辑/子代理/交互结果小而关键，不清。 */
const MICROCOMPACT_CLEARABLE_TOOLS = new Set([
  'read_file', 'read_image', 'execute_command', 'search_files', 'search_content', 'list_dir', 'web_search', 'web_fetch',
])
const CLEARED_TOOL_RESULT_PLACEHOLDER =
  '[Old tool result cleared to free context. The key info should already be captured in earlier replies; re-run the tool if you need it again.]'
const DOOM_LOOP_REFUSAL =
  'this exact call has already been made repeatedly with identical arguments and the results did not change. Stop repeating it: change the approach, inspect the previous results, or explain the blocker to the user.'

/** git 仓库状态探测（每个 workingDir 只探测一次，供系统提示环境段使用） */
const gitRepoCache = new Map<string, boolean>()
async function detectGitRepo(workingDir: string): Promise<boolean> {
  const cached = gitRepoCache.get(workingDir)
  if (cached !== undefined) return cached
  try {
    const r = await ipc.executeCommandWithShell('git rev-parse --is-inside-work-tree', workingDir, 'cmd')
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

/** 渲染进程可得的系统环境信息（OS 版本从 userAgent 提取，避免新增 IPC） */
function getOsDescription(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const win = /Windows NT ([\d.]+)/.exec(ua)
  if (win) {
    const nt = win[1]
    const version = nt === '10.0' ? '10/11' : nt
    return `Windows ${version}`
  }
  const mac = /Mac OS X ([\d_.]+)/.exec(ua)
  if (mac) return `macOS ${mac[1].replace(/_/g, '.')}`
  if (/Linux/.test(ua)) return 'Linux'
  return navigator.platform || 'unknown'
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

export function useAgent(sessionId: string) {
  // Agent 只订阅请求构造和上下文预算所需的设置，减少设置页/主题等变化带来的重建。
  const settings = useSettingsStore(useShallow((s) => ({
    model: s.model,
    apiCompat: s.apiCompat,
    activeProviderId: s.activeProviderId,
    activeModelId: s.activeModelId,
    providers: s.providers,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    reasoningEffort: s.reasoningEffort,
    enableThinking: s.enableThinking,
    thinkingBudget: s.thinkingBudget,
    approvalMode: s.approvalMode,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    directFetch: s.directFetch,
    maxInputTokens: s.maxInputTokens,
    agentsMdEnabled: s.agentsMdEnabled,
    claudeMdCompat: s.claudeMdCompat,
  })))
  // store 动作是稳定引用，逐个 selector 订阅：避免整店订阅导致聊天流式期间
  // （chat-store 每 ~50ms 变更一次）本 hook 及挂载它的 ChatPage 整树重渲染。
  const addMessage = useChatStore((s) => s.addMessage)
  const updateMessage = useChatStore((s) => s.updateMessage)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const compactSession = useChatStore((s) => s.compactSession)
  const setSessionStatus = useChatStore((s) => s.setSessionStatus)
  const requestWorkingDirRef = useRef<string | null>(null)
  const tokenTrackerRef = useRef<TokenTracker>(new TokenTracker())
  const sessionReadFilesRef = useRef<Map<string, ReadFileSnapshot>>(new Map())
  /** 会话级冻结的记忆快照：前缀缓存要求 system 段字节一致，
   *  而 save_memory 会在会话中途改写记忆文件 → memoryPrompt 变化 → 动态段之后全部缓存作废。
   *  故同一会话（含 workingDir/homeDir）内只构建一次，新记忆下个会话生效（快照语义）。 */
  const sessionMemoryRef = useRef<{ key: string; prompt: string } | null>(null)
  /** dev 校验用：静�?system 段最近一次的 (来源, 哈希) */
  const staticSystemHashRef = useRef<{ origin: string; hash: string } | null>(null)
  /** 当前运行中的任务工作流模式（/spec /plan /goal，随 sendMessage 传入，run 结束清空）。
   *  用 ref 而非参数透传：checkToolPermission 在工具执行深处读取，避免层层传参 */
  const activeTaskModeRef = useRef<TaskMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 手动压缩进行中（/压缩 命令）：输入栏即时反馈 + 锁定，防止压缩期间并发发送 */
  const [isCompacting, setIsCompacting] = useState(false)
  const isCompactingRef = useRef(false)

  /** Get working directory for current session, with default fallback */
  const getWorkingDir = () => {
    if (requestWorkingDirRef.current !== null) return requestWorkingDirRef.current
    const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    if (session?.workingDir) return session.workingDir
    return session?.defaultWorkDir || ''
  }

  const makeId = () => `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

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
   *  返回文本分片流 + 协议标记，交给 parseStream 解析。 */
  const callAPI = useCallback(
    async (
      messages: NeutralMessage[],
      controller: AbortController,
      opts: {
        modelOverride?: string
        thinkingBlocks?: Map<string, AnthropicThinkingBlock[]>
      } = {}
    ): Promise<{ chunks: AsyncIterable<string>; compat: ApiCompat }> => {
      // Get all tool definitions (skills are prompt-only, no dynamic tools)
      const tools = toolRegistry.definitions.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))

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
        thinking: settings.enableThinking && thinkingOk,
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
        const chunks = await openChatStream(
          {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            apiCompat: compat,
            directFetch: settings.directFetch,
          },
          body,
          combinedSignal
        )
        opened = true
        return { chunks, compat }
      } finally {
        dispose()
        clearTimeout(timeoutId)
        // The stream may still consume the successful connection, so only abort on failure.
        if (!opened) timeoutController.abort()
      }
    },
    [settings]
  )

  /** Estimate token count from character count using the unified heuristic */
  const estimateTokens = (text: string): number => estimateTokensForText(text)

  /** Truncate messages to fit within context window.
   *  Strategy: keep system prompt + most recent messages.
   *  If total estimated tokens exceed the budget, trim oldest messages.
   *  IMPORTANT: Must preserve message sequence integrity — tool messages must always
   *  follow their corresponding assistant+tool_calls message.
   */
  const truncateMessages = (msgs: NeutralMessage[]): NeutralMessage[] => {
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

    // Also check: if first kept message is an assistant with tool_calls but we don't have the tool responses
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
  const buildAPIMessages = (
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
      agentsMdContent?: string
      /** 环境段用：当前工作目录是否为 git 仓库（reactLoop 探测后传入） */
      isGitRepo?: boolean
      /** microcompact：true 时把较老的大型工具输出就地替换为占位符（保留最近 N 条），
       *  只减 token 不动 UI/DB 历史。启用后清理集合只增不减，前缀保持稳定。 */
      clearOldToolResults?: boolean
    } = {}
  ): NeutralMessage[] => {
    const {
      memoryPrompt = '',
      workingDir = getWorkingDir(),
      taskMode,
      goalCondition,
      skillCatalog = useSkillsStore.getState().getSkillCatalog(),
      skillReminder,
      extraSystemPrompt,
      agentsMdContent = '',
      isGitRepo,
      clearOldToolResults,
    } = opts

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
    } else {
      staticSystemContent = SYSTEM_PROMPT
      if (workingDir) {
        dynamicSystemContent += `\n\nFile operations default to this directory. Do NOT write outside it unless the user explicitly provides an absolute path elsewhere.`
        // 权威声明：会话中途切换目录后，历史消息/工具输出里仍是旧目录路径，
        // 模型容易从上下文抄旧值回答"当前工作目录"。此声明强制以系统提示为准。
        dynamicSystemContent += `\n\nThis section is authoritative: when asked about the current working directory, report the path above — NOT any directory path seen in earlier messages or tool outputs (those reflect a previous setting).`
        // 环境信息段（参考 Claude Code/opencode 的 env 注入）：会话内稳定的运行环境事实
        const envLines = [
          `- Platform: ${navigator.platform || 'unknown'}`,
          `- OS: ${getOsDescription()} (shells available: cmd.exe, PowerShell)`,
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
    if (IS_DEV) {
      const origin = extraSystemPrompt ? 'sub' : 'main'
      const hash = hashString(staticSystemContent)
      const prev = staticSystemHashRef.current
      if (prev && prev.origin === origin && prev.hash !== hash) {
        console.warn(
          `[cache] static system prompt ("${origin}") changed between requests — prefix cache will miss. ` +
            `Ensure no volatile content (memory/skills/timestamps) leaks into the static segment.`,
        )
      }
      staticSystemHashRef.current = { origin, hash }
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
        const toolContent = clearedToolIds.has(toolCallId)
          ? CLEARED_TOOL_RESULT_PLACEHOLDER
          : m.content.replace(/\n__EDIT_DIFF__:.*$/s, '')
        result.push({
          role: 'tool',
          content: toolContent,
          tool_call_id: toolCallId,
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
          cleaned[i] = { ...cleaned[i], content: `${cleaned[i].content}\n\n${skillReminder}` }
          break
        }
      }
    }

    return cleaned
  }

  /** Main send message function with full ReAct loop */
  const sendMessage = useCallback(
    async (content: string, attachments?: MessageAttachment[], taskMode?: TaskMode, skills?: MessageSkillSnapshot[]) => {
      // Prevent concurrent sends on the same session（per-session 粒度，不阻塞其他会话并发）
      if (getSessionAbortController(sessionId)) {
        setError(i18n.t('agent.busy'))
        return
      }

      if (!settings.baseUrl) {
        setError(i18n.t('agent.needBaseUrl'))
        return
      }
      // 本地部署（Ollama / LM Studio 等）无需 Key，不能在这里一刀切拦掉
      const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
      if (!settings.apiKey && requiresApiKey(settings.baseUrl, activeProvider?.presetId)) {
        setError(i18n.t('agent.needApiKey'))
        return
      }

      setError(null)
      setStreaming(true, sessionId)
      // 标记 per-session 工作状态（侧边栏 loading 圈依据此显示）
      setSessionStatus(sessionId, 'working')

      const controller = new AbortController()
      setSessionAbortController(sessionId, controller)
      const currentSession = useChatStore.getState().sessions.find((s) => s.id === sessionId)
      requestWorkingDirRef.current = currentSession?.workingDir || currentSession?.defaultWorkDir || ''
      // 记录本次运行的任务工作流模式（/spec /plan /goal；工具权限检查与提示词注入都会读取）。
      // /goal 是会话级目标：设定后跨消息持续生效，后续普通消息也按 goal 模式注入语境。
      if (taskMode === 'goal' && content.trim()) {
        useGoalStore.getState().setGoal(sessionId, content.trim())
      }
      const goalActive = useGoalStore.getState().bySession[sessionId]?.status === 'active'
      activeTaskModeRef.current = taskMode ?? (goalActive ? 'goal' : null)
      // 记录是否是用户主动 abort，用于决定是否发"异常停下"通知
      let abortedByUser = false

      // Add user message
      const userMsg: Message = {
        id: makeId(),
        role: 'user',
        content,
        timestamp: Date.now(),
        // 附件随消息入内存 + 持久化（仅在非空时携带）
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        // 任务工作流随消息记录（气泡内展示 + 重启后可见）
        ...(taskMode ? { taskMode } : {}),
        ...(skills && skills.length > 0 ? { skills } : {}),
      }
      addMessage(sessionId, userMsg)

      // Get all messages for context
      const chatStore = useChatStore.getState()
      const session = chatStore.sessions.find((s) => s.id === sessionId)
      const contextMessages = session ? [...session.messages, userMsg] : [userMsg]

      // 相关技能提醒：按本条消息内容对全部已安装技能做词面匹配（命中才注入，
      // 未命中不注入任何内容）。与用户手动激活（skills 快照）互补。
      const skillReminder = buildRelevantSkillReminder(content, useSkillsStore.getState().getSkillCatalog()) ?? undefined

      try {
        await reactLoop(contextMessages, controller, taskMode, skillReminder)
      } catch (err) {
        if (controller.signal.aborted) {
          abortedByUser = true
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        addMessage(sessionId, {
          id: makeId(),
          role: 'assistant',
          content: i18n.t('agent.sendFailed', { message: msg }),
          timestamp: Date.now(),
        })
        // 标记 error 状态 + 系统通知（仅当用户不在此会话时）
        setSessionStatus(sessionId, 'error')
        notifyIfNotViewing(sessionId, 'error', msg.slice(0, 200))
      } finally {
        requestWorkingDirRef.current = null
        activeTaskModeRef.current = null
        // Do not clear a controller installed by a newer request for this session.
        if (getSessionAbortController(sessionId) === controller) {
          setSessionAbortController(sessionId, null)
        }
        // 仅清当前会话的 streaming 状态，不影响其他并发会话
        useChatStore.getState().setStreaming(false, sessionId)
        // 用户主动 abort：直接清状态，不发通知
        if (abortedByUser) {
          setSessionStatus(sessionId, null)
        } else {
          // 正常完成或异常：若状态仍是 working（说明没被 catch 标成 error），发"完成"通知
          const cur = useChatStore.getState().sessionStatus[sessionId]
          if (cur === 'working') {
            setSessionStatus(sessionId, null)
            notifyIfNotViewing(sessionId, 'done')
          }
          // 若是 error，catch 块已发通知，这里不再重复
        }
      }
    },
    [sessionId, settings, addMessage, updateMessage, setStreaming, setSessionStatus]
  )

  /** 手动压缩上下文（/压缩 命令触发）：
   *  编排与 reactLoop 内的自动压缩完全一致（占位提示 → compactConversation → 双消息数组 → 原子持久化 → 重置计数），
   *  仅两处差异：trigger 标记为 'manual'、支持可选自定义指令（留空则行为等同自动压缩）。 */
  const manualCompact = useCallback(
    async (customInstructions?: string) => {
      // 重入防护 + Agent 运行中忽略（避免与 ReAct 循环中途的消息状态冲突）
      if (isCompactingRef.current || getSessionAbortController(sessionId)) return
      if (!settings.baseUrl) {
        setError(i18n.t('agent.needBaseUrl'))
        return
      }
      const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
      if (!settings.apiKey && requiresApiKey(settings.baseUrl, activeProvider?.presetId)) {
        setError(i18n.t('agent.needApiKey'))
        return
      }

      const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
      const conversationMessages = session?.messages ?? []
      if (conversationMessages.length === 0) return

      setError(null)
      isCompactingRef.current = true
      setIsCompacting(true)

      // ── 压缩过程展示：插入"正在压缩上下文"占位消息（同自动压缩路径） ──
      const compactingId = makeId()
      addMessage(sessionId, {
        id: compactingId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        _isCompacting: true,
      })
      try {
        const compactionResult = await compactConversation(
          conversationMessages,
          settings,
          sessionReadFilesRef.current,
          customInstructions?.trim() || undefined,
          'manual'
        )
        // Recompute the keep boundary (same logic as inside compactConversation)
        const keepStartIndex = findKeepBoundaryIndex(conversationMessages)
        const keptMessages = conversationMessages.slice(keepStartIndex)
        // 被压缩的历史消息（压缩点之前）——用户仍要在界面上看到它们，故保留但不发给 API
        const summarizedMessages = conversationMessages.slice(0, keepStartIndex)

        // 界面/DB 消息：完整保留全部历史，压缩组件（边界 + 摘要）插在压缩点位置。
        // 手动压缩不接续对话循环，无需构建 API 子集。
        const newMessages = [
          ...summarizedMessages,
          compactionResult.boundaryMessage,
          compactionResult.summaryMessage,
          ...keptMessages,
          ...compactionResult.fileAttachments,
        ]

        // Sync to store and DB（保留全部历史）
        compactSession(sessionId, newMessages, compactionResult.boundaryMessage.id)

        // Clear the read file state (it's now in file attachments)
        sessionReadFilesRef.current = new Map()
        // Reset the token tracker after compaction so stale usage cannot retrigger auto-compact.
        tokenTrackerRef.current.reset()

        console.log(`[compact] Manually compacted: ${compactionResult.preCompactTokenCount} → ${compactionResult.postCompactTokenCount} tokens, ${compactionResult.boundaryMessage.compactMetadata?.messagesSummarized} messages summarized`)
      } catch (err) {
        console.error('[compact] Manual compaction failed:', err)
        // 失败：把"正在压缩"占位消息改为可见提示，避免残留空白占位
        updateMessage(sessionId, compactingId, {
          content: i18n.t('chat.compactFailed'),
          _isCompacting: false,
        })
      } finally {
        isCompactingRef.current = false
        setIsCompacting(false)
      }
    },
    [sessionId, settings, addMessage, updateMessage, compactSession]
  )

  /** 上下文用量统计（TitleBar 环形指示器面板）：
   *  总量与自动压缩判定同源（tokenTracker.getTokenCount），预算与阈值口径同 reactLoop 的 autoCompactThreshold。
   *  注意：先过滤为 API 实际发送的消息子集，压缩后旧历史不计入总量/细分。 */
  const getContextUsage = useCallback(
    (messages: Message[]): ContextUsageInfo => {
      const budget = settings.providers
        .find((p) => p.id === settings.activeProviderId)
        ?.models.find((x) => x.id === settings.activeModelId)?.maxInputTokens
        ?? settings.maxInputTokens ?? 184000
      // API 实际发送的消息子集（摘要 + 边界之后的消息）
      const apiMessages = getApiVisibleMessages(messages)
      const total = tokenTrackerRef.current.getTokenCount(apiMessages)
      return computeContextUsage(apiMessages, total, budget, estimateTokensForText(SYSTEM_PROMPT))
    },
    [settings]
  )

  // 注册到模块级注册表（切换会话/卸载时清理），供 TitleBar 的上下文用量面板调用
  useEffect(() => {
    sessionAgentRegistry.set(sessionId, { manualCompact, getUsage: getContextUsage })
    return () => { sessionAgentRegistry.delete(sessionId) }
  }, [sessionId, manualCompact, getContextUsage])

  /** ReAct loop: think → act → observe → repeat */
  const reactLoop = async (
    initialMessages: Message[],
    controller: AbortController,
    taskMode?: TaskMode,
    /** 当轮相关技能提醒（sendMessage 计算；跨轮复用同一文本保证 API 前缀稳定） */
    skillReminder?: string
  ) => {
    let conversationMessages = [...initialMessages]

    // ── Goal 工作流：会话级目标跨消息持续生效 ──
    // 本次运行未显式选择工作流时，若目标处于 active，则继续按 goal 模式注入提示词
    //（goal 不改变工具权限档位，只影响提示词语境与运行收尾的评估闭环）。
    const sessionGoalAtStart = useGoalStore.getState().bySession[sessionId]
    const effectiveTaskMode: TaskMode | undefined =
      taskMode ?? (sessionGoalAtStart?.status === 'active' ? 'goal' : undefined)
    const goalCondition = sessionGoalAtStart?.status === 'active' ? sessionGoalAtStart.condition : undefined
    // Goal 评估器运行时状态：本次运行的续跑评估计数 / 连续无工具调用的评估计数（防空转）
    let goalEvaluationsThisRun = 0
    let goalIdleEvaluations = 0
    let iterationHadToolCalls = false

    /** Goal 评估器：独立模型调用，依据转录中的可见证据判定三态；不执行任何工具。
     *  用量计入全局统计但不进 tokenTracker（避免干扰自动压缩判定）。 */
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
      const response = await callAPI(evalMessages, runController)
      let text = ''
      await parseStream(response, runController, {
        onContent: (t) => { text += t },
        onThinking: () => {},
        onToolCallUpdate: () => {},
        onFinish: () => {},
        onUsage: (usage) => {
          try {
            useTokenUsageStore.getState().recordUsage({
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

    // Pre-fetch memory prompt —— 会话级冻结快照（见 sessionMemoryRef 注释）：
    // 每轮 reactLoop 重新构建的话，本轮 save_memory 写入的记忆会让下一轮
    // memoryPrompt 变化，动态 system 段之后的前缀缓存全部作废。
    const workingDir = getWorkingDir()
    const homeDir = ipc.homeDir()

    // AI 自主加载技能的感知映射：SKILL.md 规范化绝对路径 → 技能快照。
    // read_file 命中时在助手消息上展示"已加载技能"芯片（仅 UI，不影响提示词）。
    const skillPathMap = new Map<string, MessageSkillSnapshot>()
    for (const entry of useSkillsStore.getState().getSkillCatalog()) {
      skillPathMap.set(normalizePathForComparison(entry.skillMdPath), {
        id: entry.id,
        name: entry.name,
        icon: entry.icon,
        slug: entry.slug,
      })
    }
    let memoryPrompt = ''
    if (homeDir) {
      const snapKey = `${sessionId}|${homeDir}|${workingDir}`
      const snap = sessionMemoryRef.current
      if (snap && snap.key === snapKey) {
        memoryPrompt = snap.prompt
      } else {
        try {
          memoryPrompt = await buildMemoryPrompt(workingDir, homeDir)
        } catch {
          memoryPrompt = ''
        }
        sessionMemoryRef.current = { key: snapKey, prompt: memoryPrompt }
      }
    }

    // Pre-fetch AGENTS.md (项目根指令) — 跨工具标准，Codex/OpenCode/Qwen 原生支持
    // 开启 claudeMdCompat 时，AGENTS.md 不存在则回退读取 CLAUDE.md
    let agentsMdContent = ''
    if (settings.agentsMdEnabled && workingDir) {
      try {
        const candidates = settings.claudeMdCompat
          ? ['AGENTS.md', 'CLAUDE.md']
          : ['AGENTS.md']
        const sep = workingDir.includes('\\') ? '\\' : '/'
        for (const name of candidates) {
          const fullPath = `${workingDir}${sep}${name}`
          const text = await ipc.readFile(fullPath)
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
    const isGitRepo = workingDir ? await detectGitRepo(workingDir) : false
    // 运行时防护状态：doom-loop 签名序列 / 工具执行轮计数 / 收尾指令注入标记 / 连续截断轮数
    const recentToolSignatures: string[] = []
    let toolExecutionTurns = 0
    let wrapUpInjected = false
    let truncatedRefusalStreak = 0
    // 溢出恢复链：请求真实超上下文时强制压缩一次并重放（参考 Claude Code prompt-too-long recovery）
    let overflowRecovered = false
    // 自动压缩连续失败计数（达到熔断阈值后停止自动触发，防止每次发消息都白跑一次压缩请求）
    let failedAutoCompacts = 0
    // microcompact 开关：token 超过压缩阈值 85% 时启用并在本轮内保持启用。
    // 清理集合只增不减 → 请求前缀在后续轮次保持稳定，不会反复破坏缓存。
    let microCompactEnabled = false

    /** 执行一次自动压缩：成功后 conversationMessages 换为 API 子集并返回 true；
     *  失败（含「消息不足」）返回 false，由调用方决定回退策略（回落 truncateMessages）。 */
    const performAutoCompact = async (): Promise<boolean> => {
      // ── 压缩过程展示：插入一条"正在压缩上下文"占位消息，让用户看到压缩在进行中 ──
      const compactingId = makeId()
      addMessage(sessionId, {
        id: compactingId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        _isCompacting: true,
      })
      try {
        const compactionResult = await compactConversation(
          conversationMessages,
          settings,
          sessionReadFilesRef.current,
          undefined,
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

        // 界面/DB 消息：完整保留全部历史（含压缩点之前的 summarizedMessages），
        // 压缩组件（边界 + 摘要）插在压缩点位置，用户依旧能看到全部对话记录。
        const newMessages = [
          ...summarizedMessages,
          compactionResult.boundaryMessage,
          compactionResult.summaryMessage,
          ...keptMessages,
          ...compactionResult.fileAttachments,
        ]

        // Sync to store and DB（保留全部历史）
        compactSession(sessionId, newMessages, compactionResult.boundaryMessage.id)

        // 后续迭代的 conversationMessages 用 API 子集（释放 token），
        // 界面上则通过 compactSession 保留全量历史（见 newMessages）。
        conversationMessages = apiMessagesAfterCompact

        // Clear the read file state (it's now in file attachments)
        sessionReadFilesRef.current = new Map()
        // Reset the token tracker after compaction so stale usage cannot retrigger it.
        // 下一轮 getTokenCount 会取 max(lastUsage, estimated)，导致继续误判超过阈值，
        // 反复进入 compactConversation 并抛 "Not enough messages to compact"。
        tokenTrackerRef.current.reset()

        console.log(`[compact] Auto-compacted: ${compactionResult.preCompactTokenCount} → ${compactionResult.postCompactTokenCount} tokens, ${compactionResult.boundaryMessage.compactMetadata?.messagesSummarized} messages summarized`)
        return true
      } catch (err) {
        console.error('[compact] Auto-compaction failed, falling back to truncateMessages:', err)
        // 压缩失败：把"正在压缩"占位消息改为可见提示，避免残留空白占位
        updateMessage(sessionId, compactingId, {
          content: i18n.t('chat.compactFailed'),
          _isCompacting: false,
        })
        return false
      }
    }

    for (let iteration = 0; ; iteration++) {
      if (controller.signal.aborted) return

      // Auto-compact check: if token count exceeds threshold, summarize older messages
      // 阈值 = 输入预算 − 20K 缓冲（与模型高级设置联动）
      const compactInputBudget = (() => {
        const m = settings.providers
          .find((p) => p.id === settings.activeProviderId)
          ?.models.find((x) => x.id === settings.activeModelId)
        return m?.maxInputTokens ?? settings.maxInputTokens ?? 184000
      })()
      const autoCompactThreshold = Math.max(compactInputBudget - 20000, Math.floor(compactInputBudget * 0.8))
      // 判定口径与 buildAPIMessages 一致：只统计 API 实际发送的消息子集。
      // 旧实现对全量历史（含已被压缩的旧消息）估算，导致压缩后依然超阈值、
      // 每次发消息都误触发压缩（而用量指示器按子集统计显示 30%+，两边对不上）。
      const apiVisibleMessages = getApiVisibleMessages(conversationMessages)
      const currentTokenCount = tokenTrackerRef.current.getTokenCount(apiVisibleMessages)
      if (currentTokenCount > autoCompactThreshold && apiVisibleMessages.length > 12 && failedAutoCompacts < MAX_AUTO_COMPACT_FAILURES) {
        // 连续失败计数：成功归零，达到阈值后本轮运行内不再自动触发（防死亡螺旋）
        if (await performAutoCompact()) failedAutoCompacts = 0
        else failedAutoCompacts++
      }
      // microcompact 触发：接近压缩阈值但还没到 → 先清老工具输出顶一顶（比全量压缩便宜得多）
      if (currentTokenCount > Math.floor(autoCompactThreshold * 0.85)) microCompactEnabled = true

      // Build API messages from conversation history (with auto-truncation for long conversations)
      const apiMessages = truncateMessages(buildAPIMessages(conversationMessages, { memoryPrompt, agentsMdContent, taskMode: effectiveTaskMode, goalCondition, isGitRepo, skillReminder, clearOldToolResults: microCompactEnabled }))

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
        const response = await callAPI(apiMessages, controller, { thinkingBlocks })
        if (!placeholderAdded) {
          // Create assistant message placeholder
          addMessage(sessionId, {
            id: assistantId,
            role: 'assistant',
            content: '',
            thinkingContent: '',
            timestamp: Date.now(),
            _isStreaming: true,  // Mark as currently streaming
          })
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
            updateMessage(sessionId, assistantId, { content })
          },
          onThinking: (text) => {
            thinkingContent += text
            const now = Date.now()
            if (now - lastStreamUpdate < 50) return
            lastStreamUpdate = now
            updateMessage(sessionId, assistantId, { thinkingContent })
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
            updateMessage(sessionId, assistantId, { streamingToolCalls: streamingCalls })
          },
          onFinish: (reason) => {
            // Flush the final buffered content so the persisted response is complete.
            updateMessage(sessionId, assistantId, { content, thinkingContent })
            finishReason = reason
          },
          onUsage: (usage: TokenUsage) => {
            turnUsage = usage
            tokenTrackerRef.current.recordUsage(usage)
            // 累计到全局 token 用量统计（供设置页通用栏展示）
            try {
              useTokenUsageStore.getState().recordUsage({
                usage,
                sessionId,
                model: settings.model,
                providerId: settings.activeProviderId,
              })
            } catch (error) {
              console.error('[use-agent] record token usage failed:', error)
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
              updateMessage(sessionId, assistantId, {
                _isStreaming: true,
                _retrying: { attempt },
                content,
                thinkingContent,
              })
            }
          },
        })
        // 重试成功：清除重试标记
        updateMessage(sessionId, assistantId, { _retrying: undefined })
      } catch (err) {
        // 重试全部失败：把已添加的占位消息标记为非流式，避免残留一条永远 loading 的空消息
        if (placeholderAdded) updateMessage(sessionId, assistantId, { _isStreaming: false, _retrying: undefined })
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
        updateMessage(sessionId, assistantId, { _isStreaming: false })
        return
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
        content += `\n\n${i18n.t('agent.outputTruncated')}`
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
      updateMessage(sessionId, assistantId, assistantMessage)
      conversationMessages.push(assistantMessage)

      // No tool calls → we're done
      if (toolCalls.length === 0) {
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
          updateMessage(sessionId, assistantId, { content: cleanedContent })
        }

        // ── Goal 独立评估器三态闭环（对齐 Claude Code /goal）：
        // 目标 active 时，在每轮收尾用独立评估判定：in_progress → 注入评估理由自动续跑；
        // achieved/impossible → 终态卡片并结束。[GOAL_COMPLETE] 为快速通道，短路评估省一次调用。 ──
        const goalNow = useGoalStore.getState().bySession[sessionId]
        if (goalNow?.status === 'active' && effectiveTaskMode === 'goal' && !controller.signal.aborted) {
          goalIdleEvaluations = iterationHadToolCalls ? 0 : goalIdleEvaluations + 1
          const addGoalCard = (verdict: GoalVerdict, reason: string) => {
            addMessage(sessionId, {
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
            useGoalStore.getState().updateGoal(sessionId, {
              status: 'achieved',
              evaluations: goalNow.evaluations + 1,
              conclusion,
            })
            addGoalCard('achieved', conclusion || i18n.t('goal.noReport'))
            collapseIntermediateMessages(sessionId, assistantId)
            return
          }

          // 护栏：收尾轮（工具已禁用强制总结）/ 连续空转 / 评估上限 → 暂停续跑但保留目标
          if (wrapUpInjected || goalIdleEvaluations > GOAL_IDLE_EVALUATION_LIMIT || goalEvaluationsThisRun >= GOAL_MAX_EVALUATIONS_PER_RUN) {
            const pauseReason = wrapUpInjected
              ? i18n.t('goal.turnLimitPaused')
              : goalIdleEvaluations > GOAL_IDLE_EVALUATION_LIMIT
                ? i18n.t('goal.idlePaused', { count: GOAL_IDLE_EVALUATION_LIMIT + 1 })
                : i18n.t('goal.evalLimitPaused', { count: GOAL_MAX_EVALUATIONS_PER_RUN })
            addGoalCard('in_progress', pauseReason)
            collapseIntermediateMessages(sessionId, assistantId)
            return
          }

          // 评估器判定（调用失败不阻断：保留目标，结束本次运行，用户下一条消息自然恢复）
          try {
            goalEvaluationsThisRun++
            const evaluation = await evaluateGoal(goalNow.condition, controller)
            useGoalStore.getState().updateGoal(sessionId, {
              evaluations: goalNow.evaluations + 1,
              lastReason: evaluation.reason,
            })
            if (evaluation.verdict === 'achieved') {
              useGoalStore.getState().updateGoal(sessionId, { status: 'achieved', conclusion: evaluation.reason })
              addGoalCard('achieved', evaluation.reason)
              collapseIntermediateMessages(sessionId, assistantId)
              return
            }
            if (evaluation.verdict === 'impossible') {
              useGoalStore.getState().updateGoal(sessionId, { status: 'failed', conclusion: evaluation.reason })
              addGoalCard('impossible', evaluation.reason)
              collapseIntermediateMessages(sessionId, assistantId)
              return
            }
            // in_progress：评估理由作为下一轮引导注入对话，自动续跑
            addGoalCard('in_progress', evaluation.reason)
            const guidanceMsg: Message = {
              id: makeId(),
              role: 'user',
              content: i18n.t('goal.continuePrompt', { n: goalEvaluationsThisRun, reason: evaluation.reason }),
              timestamp: Date.now(),
            }
            addMessage(sessionId, guidanceMsg)
            conversationMessages.push(guidanceMsg)
            continue
          } catch (err) {
            if (controller.signal.aborted) return
            console.error('[goal] evaluator failed:', err)
            addGoalCard('in_progress', i18n.t('goal.evaluatorFailed'))
            collapseIntermediateMessages(sessionId, assistantId)
            return
          }
        }

        // Collapse all intermediate assistant messages (those that had tool calls)
        // Only keep the final assistant message expanded
        collapseIntermediateMessages(sessionId, assistantId)
        return
      }

      // Execute tool calls (并行执行：同一批 toolCalls 互相独立，尤其 spawn_agent 需要并行)
      // 中断后立即跳过工具执行，避免点停止后还在跑命令
      if (controller.signal.aborted) {
        updateMessage(sessionId, assistantId, { _isStreaming: false })
        return
      }

      // ── 截断响应保护：finishReason=length 时本轮所有工具调用一律不执行。
      // 流式参数经 JSON 抢救解析后可能"恰好合法但不完整"，执行有副作用的工具会损坏文件。
      if (finishReason === 'length') {
        const refused: ToolResult[] = toolCalls.map((tc) => ({
          toolCallId: tc.id,
          content: toolCallRefusal(tc.name, TRUNCATED_TOOL_CALL_REASON),
          isError: true,
        }))
        updateMessage(sessionId, assistantId, { toolResults: refused })
        for (const r of refused) {
          const toolMsg: Message = { id: makeId(), role: 'tool', content: r.content, timestamp: Date.now(), toolResults: [r] }
          addMessage(sessionId, toolMsg)
          conversationMessages.push(toolMsg)
        }
        continue
      }

      // ── 轮次上限收尾：工具执行轮数用尽后不再执行工具，注入收尾指令让模型文字总结
      //（参考 opencode MAX_STEPS：硬停会丢掉整个 run 的总结）。
      // 收尾轮若仍坚持调用工具 → 全部拒绝并退出循环，走兜底提示。 ──
      if (toolExecutionTurns >= MAX_REACT_ITERATIONS || wrapUpInjected) {
        const refused: ToolResult[] = toolCalls.map((tc) => ({
          toolCallId: tc.id,
          content: toolCallRefusal(tc.name, wrapUpInjected
            ? 'tool calls are disabled for this run — reply with your final text summary now'
            : 'maximum tool-call turns reached for this run'),
          isError: true,
        }))
        updateMessage(sessionId, assistantId, { toolResults: refused })
        for (const r of refused) {
          const toolMsg: Message = { id: makeId(), role: 'tool', content: r.content, timestamp: Date.now(), toolResults: [r] }
          addMessage(sessionId, toolMsg)
          conversationMessages.push(toolMsg)
        }
        if (wrapUpInjected) break
        wrapUpInjected = true
        const wrapMsg: Message = { id: makeId(), role: 'user', content: MAX_STEPS_MESSAGE, timestamp: Date.now() }
        addMessage(sessionId, wrapMsg)
        conversationMessages.push(wrapMsg)
        continue
      }

      const results: ToolResult[] = []
      // 本轮 read_file 命中的技能 SKILL.md（AI 自主加载感知，随本轮助手消息展示）
      const turnLoadedSkills = new Map<string, MessageSkillSnapshot>()
      // L1: 复用循环顶部已声明的 workingDir，避免变量 shadow

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
        const callSig = `${tc.name}\u0000${JSON.stringify(tc.arguments ?? {})}`
        if (isDoomLoopSig(recentToolSignatures, callSig)) {
          return {
            toolCallId: tc.id,
            content: toolCallRefusal(tc.name, DOOM_LOOP_REFUSAL),
            isError: true,
          }
        }
        // Permission check
        const permResult = await checkToolPermission(tc.name, tc.arguments)
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
          const result = await toolRegistry.execute(tc.name, argsWithCwd, {
            workingDir,
            homeDir: ipc.homeDir(),
            sessionId,
            readFileState: sessionReadFilesRef.current,
            requestUserInput: (questions) => useInteractiveStore.getState().requestQuestion(sessionId, questions),
            updateTodoList: (items) => useTodoStore.getState().setTodos(sessionId, items),
            spawnSubAgent: async (agentType: string, subPrompt: string) => {
              // Validate the agent before persisting a card that must reference its run.
              // 若 findAgent 失败则卡片已持久化但 runs store 无记录，成为永久孤儿。
              const agent = await findAgent(agentType, getWorkingDir())
              if (!agent) {
                return i18n.t('agent.unknownAgentType', { type: agentType })
              }
              const subAgentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              addMessage(sessionId, {
                id: makeId(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                isSubAgentCard: true,
                subAgentId,
              })
              try {
                const subResult = await runSubAgent(agentType, subPrompt, controller, subAgentId)
                return subResult
              } catch (e) {
                return i18n.t('agent.subAgentFailed', { message: e instanceof Error ? e.message : String(e) })
              }
            },
          })
          // 记录已执行调用的签名（含失败结果），供 doom-loop 连续性判定
          recentToolSignatures.push(callSig)
          const isError = result.startsWith('Error') || result.startsWith('❌')
          // AI 自主加载感知：read_file 命中技能 SKILL.md → 记录快照（本轮展示芯片）
          if (tc.name === 'read_file' && !isError) {
            const hit = skillPathMap.get(normalizePathForComparison(String(argsWithCwd.path || '')))
            if (hit) turnLoadedSkills.set(hit.id, hit)
          }
          return {
            toolCallId: tc.id,
            content: result,
            isError,
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
      const sideEffectingTools = new Set(['write_file', 'search_replace', 'execute_command', 'save_memory', 'spawn_agent', 'question', 'todowrite'])
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
      toolExecutionTurns++
      // 本轮有工具调用 → 重置 goal 空转计数（评估器护栏依据）
      iterationHadToolCalls = true

      // Update assistant message with tool results
      updateMessage(sessionId, assistantId, {
        toolResults: results,
        // 本轮 AI 自主读取的技能 → "已加载技能"芯片（随消息持久化，仅展示用）
        ...(turnLoadedSkills.size > 0 ? { loadedSkills: [...turnLoadedSkills.values()] } : {}),
      })

      // Add tool result messages to conversation
      for (const r of results) {
        const toolMsg: Message = {
          id: makeId(),
          role: 'tool',
          content: r.content,
          timestamp: Date.now(),
          toolResults: [r],
        }
        addMessage(sessionId, toolMsg)
        conversationMessages.push(toolMsg)
      }

      // 中断后不再发起新一轮 LLM 请求，直接退出循环
      if (controller.signal.aborted) return

      // Continue the ReAct loop → model will process tool results and decide next action
    }

    // Safety net - should almost never hit this（收尾轮模型仍坚持调用工具才会走到这里）
    addMessage(sessionId, {
      id: makeId(),
      role: 'assistant',
      content: i18n.t('agent.maxTurnsTerminated', { limit: MAX_REACT_ITERATIONS }),
      timestamp: Date.now(),
    })
  }

  /** Check permission for a tool call.
   *  Agent allowlists and denylists can further restrict access, never elevate it.
   *  审批档位（settings.approvalMode）控制确认策略：
   *  - manual：危险命令 / 工作目录外操作 / 系统目录写入 全部弹窗确认
   *  - auto：AI 审核并自动批准（危险命令与目录外操作免确认；系统目录写入仍弹窗兜底）
   *  - full：完全访问，无需询问直接执行
   *  任务工作流（taskMode）：plan 规划期只读；spec 规划期仅允许读取与写入对应文档目录 */
  const checkToolPermission = async (
    toolName: string,
    args: Record<string, unknown>,
    opts: {
      /** 覆盖任务工作流模式；不传读 activeTaskModeRef，子 agent 显式传 null 走普通模式 */
      taskMode?: TaskMode | null
      allowedTools?: string[]
      disallowedTools?: string[]
    } = {}
  ): Promise<{ allowed: boolean; reason?: string }> => {
    const {
      taskMode = activeTaskModeRef.current,
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

    const approvalMode = settings.approvalMode
    const READ_TOOLS = ['read_file', 'read_image', 'list_dir', 'search_files', 'search_content', 'web_search', 'web_fetch', 'search_memory']

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
          const wd = getWorkingDir()
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

    // ── 审批档位：命令执行确认（full 档全部免询问） ──
    if (toolName === 'execute_command' && approvalMode !== 'full') {
      const cmd = String(args.command || '')
      const workingDir = getWorkingDir()
      const commandCwd = workingDir ? resolveToolPath(workingDir, args.cwd || workingDir) : String(args.cwd || '')
      if (approvalMode === 'manual' && isDangerousCommand(cmd)) {
        // 危险命令确认前：标记 confirm-danger + 通知（仅当用户不在此会话时）
        setSessionStatus(sessionId, 'confirm-danger')
        notifyIfNotViewing(sessionId, 'confirm-danger', i18n.t('agent.notifyDangerCommand', { command: cmd.slice(0, 100) }))
        const confirmed = await ipc.confirmDialog(
          i18n.t('agent.confirmDangerTitle'),
          i18n.t('agent.confirmDangerBody', { command: cmd.slice(0, 200) })
        )
        // 确认或取消后：恢复 working 状态（sendMessage 仍在执行中）
        setSessionStatus(sessionId, 'working')
        if (!confirmed) {
          return { allowed: false, reason: i18n.t('agent.deniedCancelDanger') }
        }
      }
      // auto 档：AI 已自审该操作，目录外执行免确认；manual 档仍弹窗
      if (approvalMode === 'manual' && workingDir && commandCwd && !isPathInside(commandCwd, workingDir)) {
        const confirmed = await ipc.confirmDialog(
          i18n.t('agent.confirmOutsideCwdTitle'),
          i18n.t('agent.confirmOutsideCwdBody', { cwd: commandCwd, workingDir })
        )
        if (!confirmed) return { allowed: false, reason: i18n.t('agent.deniedCancelOutsideCwd') }
      }
    }

    // ── 审批档位：文件写入确认（full 档全部免询问） ──
    if ((toolName === 'write_file' || toolName === 'search_replace') && approvalMode !== 'full') {
      const workingDir = getWorkingDir()
      const path = resolveToolPath(workingDir, args.path)
      // 系统目录写入：manual/auto 都弹窗（最后一道防线，仅 full 档放行）
      if (isSystemPath(path)) {
        const confirmed = await ipc.confirmDialog(
          i18n.t('agent.confirmSystemDirTitle'),
          i18n.t('agent.confirmSystemDirBody', { path })
        )
        if (!confirmed) {
          return { allowed: false, reason: i18n.t('agent.deniedCancelSystemDir') }
        }
      }

      // auto 档：AI 已自审，目录外写入免确认；manual 档弹窗
      if (approvalMode === 'manual' && workingDir) {
        const isOutside = !isPathInside(path, workingDir)
        if (isOutside) {
          const confirmed = await ipc.confirmDialog(
            i18n.t('agent.confirmOutsideWriteTitle'),
            i18n.t('agent.confirmOutsideWriteBody', { path, workingDir })
          )
          if (!confirmed) {
            return { allowed: false, reason: i18n.t('agent.deniedCancelOutsideWrite') }
          }
        }
      }
    }

    return { allowed: true }
  }

  const abort = useCallback(() => {
    // per-session abort：只中止当前会话的 controller，不影响其他并发会话
    const ctrl = getSessionAbortController(sessionId)
    if (ctrl) {
      ctrl.abort()
    }
    // 杀掉该会话在主进程里还在跑的 shell 子进程，让阻塞中的 execute_command 立即返回
    if (sessionId) {
      void ipc.cancelSessionCommands(sessionId).catch(() => { /* ignore */ })
    }
    // 仅清当前会话的 streaming 状态
    useChatStore.getState().setStreaming(false, sessionId)
    // 用户主动 abort：清当前会话工作状态，不发通知
    if (sessionId) {
      useChatStore.getState().setSessionStatus(sessionId, null)
      useInteractiveStore.getState().cancelQuestion(sessionId)
    }
  }, [sessionId])

  /** Collapse all intermediate messages (assistant messages with tool calls, tool result messages)
   *  Keep only the final assistant summary expanded */
  const collapseIntermediateMessages = (sid: string, finalMsgId: string) => {
    const chatStore = useChatStore.getState()
    const session = chatStore.sessions.find((s) => s.id === sid)
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
        updateMessage(sid, msg.id, { collapsed: true })
      }
    }
  }

  /** 派生子 agent 执行独立子任务。
   *  子 agent 拥有独立的对话上下文、工具白/黑名单、system prompt（覆盖主 agent）。
   *  支持自动上下文压缩（auto-compact），结果回流到主对话。
   *  presetSubAgentId: 由调用方预先生成的 ID（用于关联主对话中的卡片消息），不传则内部生成。 */
  const runSubAgent = async (
    agentType: string,
    prompt: string,
    parentController: AbortController,
    presetSubAgentId?: string
  ): Promise<string> => {
    const workingDir = getWorkingDir()
    const homeDir = ipc.homeDir()
    const agent = await findAgent(agentType, workingDir)
    if (!agent) throw new Error(i18n.t('agent.unknownAgentType', { type: agentType }))

    const subAgentId = presetSubAgentId || `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const subController = new AbortController()
    // 父 controller abort 联动
    if (parentController.signal.aborted) subController.abort()
    const onParentAbort = () => subController.abort()
    parentController.signal.addEventListener('abort', onParentAbort)

    // 子 agent 自己的 readFileState（用于 auto-compact 时的文件附件恢复）
    let subReadFileState = new Map<string, ReadFileSnapshot>()
    // Each subagent tracks its own usage to keep the parent estimate independent.
    const subTokenTracker = new TokenTracker()
    // 子 agent 自己的 settings 副本（覆盖 model）
    const subSettings = agent.model ? { ...settings, model: agent.model } : settings

    // 初始消息：prompt 作为 user 消息。
    // goal 目标 active 时附带目标语境：子任务服务于同一目标，结果报告需与目标相关。
    const activeGoal = useGoalStore.getState().bySession[sessionId]
    const subPromptWithContext = activeGoal?.status === 'active'
      ? `${prompt}\n\n[Session goal context] The main agent is pursuing this goal: ${activeGoal.condition}. Your subtask contributes to it — report results relevant to the goal.`
      : prompt
    let conversationMessages: Message[] = [{
      id: makeId(),
      role: 'user',
      content: subPromptWithContext,
      timestamp: Date.now(),
    }]

    // 注册到 store
    useAgentRunsStore.getState().addSubAgentRun(sessionId, {
      id: subAgentId,
      agentType: agent.agentType,
      agentName: agent.name,
      prompt,
      status: 'running',
      messages: [...conversationMessages],
      startedAt: Date.now(),
    })

    try {
      const maxTurns = agent.maxTurns || 50
      // 子 agent 独立的 thinking 签名缓存，与主 agent 互不干扰
      const thinkingBlocks = new Map<string, AnthropicThinkingBlock[]>()
      // 运行时防护状态（与主 agent 一致）：doom-loop 签名 / 工具执行轮计数 / 收尾注入标记
      const recentToolSignatures: string[] = []
      let toolExecutionTurns = 0
      let wrapUpInjected = false
      // microcompact（与主 agent 一致）：接近压缩阈值时清老工具输出，本轮内保持启用
      let subMicroCompactEnabled = false
      const subIsGitRepo = workingDir ? await detectGitRepo(workingDir) : false
      for (let iteration = 0; ; iteration++) {
        if (subController.signal.aborted) break

        // ── auto-compact 检查（子 agent 也要应用） ──
        const subInputBudget = (() => {
          const m = subSettings.providers
            ?.find((p) => p.id === subSettings.activeProviderId)
            ?.models.find((x) => x.id === subSettings.activeModelId)
          return m?.maxInputTokens ?? subSettings.maxInputTokens ?? 184000
        })()
        const subAutoCompactThreshold = Math.max(subInputBudget - 20000, Math.floor(subInputBudget * 0.8))
        // 与主循环同口径：只统计 API 实际发送的消息子集（压缩边界之后）
        const subApiVisible = getApiVisibleMessages(conversationMessages)
        const tokenCount = subTokenTracker.getTokenCount(subApiVisible)
        if (tokenCount > subAutoCompactThreshold && subApiVisible.length > 12) {
          try {
            const compactionResult = await compactConversation(
              conversationMessages,
              subSettings,
              subReadFileState,
              i18n.t('agent.subAgentCompactInstruction', { name: agent.name }),
              'auto'
            )
            const keepStartIndex = findKeepBoundaryIndex(conversationMessages)
            const keptMessages = conversationMessages.slice(keepStartIndex)
            conversationMessages = [
              compactionResult.boundaryMessage,
              compactionResult.summaryMessage,
              ...keptMessages,
              ...compactionResult.fileAttachments,
            ]
            subReadFileState = new Map()
            console.log(`[subagent:${subAgentId}] auto-compacted: ${compactionResult.preCompactTokenCount} → ${compactionResult.postCompactTokenCount}`)
          } catch (err) {
            console.error(`[subagent:${subAgentId}] compaction failed:`, err)
          }
        }

        // microcompact 触发（与主 agent 同规则）
        if (tokenCount > Math.floor(subAutoCompactThreshold * 0.85)) subMicroCompactEnabled = true

        // 构建 API 消息（用子 agent 的 systemPrompt 覆盖；子 agent 不带任务工作流提示词与技能目录）
        const apiMessages = truncateMessages(buildAPIMessages(conversationMessages, {
          workingDir,
          memoryPrompt: '',
          taskMode: undefined,
          skillCatalog: [],
          extraSystemPrompt: agent.systemPrompt,
          isGitRepo: subIsGitRepo,
          clearOldToolResults: subMicroCompactEnabled,
        }))

        // 单轮子 Agent 模型调用（可重试）：与主 agent 一致，429/502 等瞬时错误指数退避重试。
        let content = ''
        let thinkingContent = ''
        let finishReason: string | null = null
        const assistantId = makeId()
        let lastStreamUpdate = 0
        let placeholderAdded = false

        const runSubModelTurn = async (): Promise<Awaited<ReturnType<typeof parseStream>>> => {
          const response = await callAPI(apiMessages, subController, { modelOverride: agent.model, thinkingBlocks })
          if (!placeholderAdded) {
            // 添加占位消息到 store
            const placeholderMsg: Message = {
              id: assistantId,
              role: 'assistant',
              content: '',
              thinkingContent: '',
              timestamp: Date.now(),
              _isStreaming: true,
              subAgentId,
            }
            useAgentRunsStore.getState().appendSubAgentMessage(sessionId, subAgentId, placeholderMsg)
            placeholderAdded = true
          }
          // 每轮重试前重置累计，避免上一轮残留内容污染本轮
          content = ''
          thinkingContent = ''
          finishReason = null
          return parseStream(response, subController, {
            onContent: (text) => {
              content += text
              const now = Date.now()
              if (now - lastStreamUpdate < 50) return
              lastStreamUpdate = now
              useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { content })
            },
            onThinking: (text) => {
              thinkingContent += text
              const now = Date.now()
              if (now - lastStreamUpdate < 50) return
              lastStreamUpdate = now
              useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { thinkingContent })
            },
            onToolCallUpdate: (calls) => {
              const now = Date.now()
              if (now - lastStreamUpdate < 50) return
              lastStreamUpdate = now
              const streamingCalls: StreamingToolCall[] = []
              for (const [, tc] of calls) {
                streamingCalls.push({ id: tc.id, name: tc.name, argsSoFar: tc.args })
              }
              useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { streamingToolCalls: streamingCalls })
            },
            onFinish: (reason) => {
              // 最终结果完整更新一次（throttle 期间累积的 content 需要刷到 UI）
              useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { content, thinkingContent })
              finishReason = reason
            },
            onUsage: (usage: TokenUsage) => { subTokenTracker.recordUsage(usage) },
            onThinkingBlock: (block) => {
              const list = thinkingBlocks.get(assistantId)
              if (list) list.push(block)
              else thinkingBlocks.set(assistantId, [block])
            },
          })
        }

        let toolCallBuffers: Awaited<ReturnType<typeof parseStream>>
        try {
          toolCallBuffers = await runWithRetry(runSubModelTurn, {
            retries: 5,
            shouldRetry: (err) => !subController.signal.aborted && isRetryableError(err),
            getRetryAfterMs: extractRetryAfterMs,
            onRetry: (attempt) => {
              if (placeholderAdded) {
                useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, {
                  _isStreaming: true,
                  _retrying: { attempt },
                  content,
                  thinkingContent,
                })
              }
            },
          })
          useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { _retrying: undefined })
        } catch (err) {
          if (placeholderAdded) {
            useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { _isStreaming: false, _retrying: undefined })
          }
          throw err
        }

        // Match the parent behavior: cancellation stops tool execution.
        if (subController.signal.aborted) {
          useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { _isStreaming: false })
          break
        }

        // 解析工具调用
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

        if (finishReason === 'length') {
          content += `\n\n${i18n.t('agent.subAgentTruncated')}`
        }

        const assistantMessage: Message = {
          id: assistantId,
          role: 'assistant',
          content: content || '',
          thinkingContent: thinkingContent || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: finishReason || undefined,
          timestamp: Date.now(),
          streamingToolCalls: undefined,
          _isStreaming: false,
          subAgentId,
        }
        useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, assistantMessage)
        conversationMessages.push(assistantMessage)

        // 无工具调用 → 完成
        if (toolCalls.length === 0) {
          useAgentRunsStore.getState().completeSubAgentRun(sessionId, subAgentId, content)
          return content
        }

        // ── 截断响应保护（与主 agent 一致）：被截断的工具调用参数可能残缺，一律不执行 ──
        if (finishReason === 'length') {
          const refused: ToolResult[] = toolCalls.map((tc) => ({
            toolCallId: tc.id,
            content: toolCallRefusal(tc.name, TRUNCATED_TOOL_CALL_REASON),
            isError: true,
          }))
          useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { toolResults: refused })
          for (const r of refused) {
            const toolMsg: Message = { id: makeId(), role: 'tool', content: r.content, timestamp: Date.now(), toolResults: [r], subAgentId }
            useAgentRunsStore.getState().appendSubAgentMessage(sessionId, subAgentId, toolMsg)
            conversationMessages.push(toolMsg)
          }
          continue
        }

        // ── 轮次上限收尾（与主 agent 一致）：不再执行工具，注入收尾指令强制文字总结 ──
        if (toolExecutionTurns >= maxTurns || wrapUpInjected) {
          const refused: ToolResult[] = toolCalls.map((tc) => ({
            toolCallId: tc.id,
            content: toolCallRefusal(tc.name, wrapUpInjected
              ? 'tool calls are disabled for this run — reply with your final text summary now'
              : 'maximum tool-call turns reached for this run'),
            isError: true,
          }))
          useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { toolResults: refused })
          for (const r of refused) {
            const toolMsg: Message = { id: makeId(), role: 'tool', content: r.content, timestamp: Date.now(), toolResults: [r], subAgentId }
            useAgentRunsStore.getState().appendSubAgentMessage(sessionId, subAgentId, toolMsg)
            conversationMessages.push(toolMsg)
          }
          if (wrapUpInjected) break
          wrapUpInjected = true
          const wrapMsg: Message = { id: makeId(), role: 'user', content: MAX_STEPS_MESSAGE, timestamp: Date.now() }
          useAgentRunsStore.getState().appendSubAgentMessage(sessionId, subAgentId, wrapMsg)
          conversationMessages.push(wrapMsg)
          continue
        }

        // 执行工具调用
        const results: ToolResult[] = []
        for (const tc of toolCalls) {
          const permResult = await checkToolPermission(tc.name, tc.arguments, {
            // 子 agent 不继承主对话的任务工作流（plan/spec 限制只作用于发起规划的那条消息）
            taskMode: null,
            allowedTools: agent.tools,
            disallowedTools: agent.disallowedTools,
          })
          if (!permResult.allowed) {
            results.push({ toolCallId: tc.id, content: i18n.t('agent.permissionDenied', { reason: permResult.reason }), isError: true })
            continue
          }

          // doom-loop 检测（与主 agent 一致）
          const callSig = `${tc.name}\u0000${JSON.stringify(tc.arguments ?? {})}`
          if (isDoomLoopSig(recentToolSignatures, callSig)) {
            results.push({ toolCallId: tc.id, content: toolCallRefusal(tc.name, DOOM_LOOP_REFUSAL), isError: true })
            continue
          }

          const argsWithCwd = { ...tc.arguments }
          if (workingDir) {
            if (tc.name === 'execute_command') argsWithCwd.cwd = resolveToolPath(workingDir, argsWithCwd.cwd || workingDir)
            if (tc.name === 'read_file' || tc.name === 'write_file' || tc.name === 'search_replace' || tc.name === 'read_image') {
              argsWithCwd.path = resolveToolPath(workingDir, argsWithCwd.path)
            }
            if (tc.name === 'list_dir' || tc.name === 'search_files' || tc.name === 'search_content') {
              argsWithCwd.path = resolveToolPath(workingDir, argsWithCwd.path)
            }
          }

          try {
            const result = await toolRegistry.execute(tc.name, argsWithCwd, {
              workingDir,
              homeDir,
              sessionId,
              readFileState: subReadFileState,
            })
            // 记录已执行调用的签名（含失败结果），供 doom-loop 连续性判定
            recentToolSignatures.push(callSig)
            results.push({ toolCallId: tc.id, content: result, isError: result.startsWith('Error') || result.startsWith('❌') })
          } catch (err) {
            results.push({ toolCallId: tc.id, content: i18n.t('agent.toolExecFailed', { message: err instanceof Error ? err.message : String(err) }), isError: true })
          }
        }

        useAgentRunsStore.getState().updateSubAgentMessage(sessionId, subAgentId, assistantId, { toolResults: results })

        for (const r of results) {
          const toolMsg: Message = {
            id: makeId(),
            role: 'tool',
            content: r.content,
            timestamp: Date.now(),
            toolResults: [r],
            subAgentId,
          }
          useAgentRunsStore.getState().appendSubAgentMessage(sessionId, subAgentId, toolMsg)
          conversationMessages.push(toolMsg)
        }
        toolExecutionTurns++
      }

      // 达到 maxTurns
      const partialResult = conversationMessages[conversationMessages.length - 1]?.content || i18n.t('agent.subAgentMaxTurns')
      // Preserve an aborted terminal state instead of reporting a completed run.
      if (subController.signal.aborted) {
        useAgentRunsStore.getState().abortSubAgentRun(sessionId, subAgentId)
        return '[aborted]'
      }
      useAgentRunsStore.getState().completeSubAgentRun(sessionId, subAgentId, partialResult)
      return partialResult
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      // Abort signals represent cancellation, not a failed subagent run.
      if (subController.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        useAgentRunsStore.getState().abortSubAgentRun(sessionId, subAgentId)
        throw new Error('[aborted]')
      }
      useAgentRunsStore.getState().failSubAgentRun(sessionId, subAgentId, errMsg)
      throw err
    } finally {
      parentController.signal.removeEventListener('abort', onParentAbort)
    }
  }

  return { sendMessage, abort, manualCompact, isCompacting, error }
}
