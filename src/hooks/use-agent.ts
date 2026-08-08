import { useCallback, useRef, useState } from 'react'
import { useSettingsStore } from '../stores/settings-store'
import { useChatStore, getSessionAbortController, setSessionAbortController } from '../stores/chat-store'
import { useSkillsStore } from '../stores/skills-store'
import { toolRegistry } from '../lib/tool-registry'
import { isDangerousCommand } from '../lib/permission-engine'
import { ipc } from '../lib/ipc-client'
import { buildMemoryPrompt } from '../lib/memory'
import { TokenTracker } from '../lib/token-tracker'
import { estimateTokensForText } from '../lib/token-estimate'
import { compactConversation, findKeepBoundaryIndex } from '../lib/compact'
import i18n from '../i18n'
import { findAgent } from '../lib/agent-registry'
import { useAgentRunsStore } from '../stores/agent-runs-store'
import { notifyIfNotViewing } from '../lib/notify'
import { openChatStream, sseLines } from '../lib/api-transport'
import { requiresApiKey } from '../lib/provider-catalog'
import {
  buildRequestBody,
  canKeepThinking,
  createParserState,
  parseEvent,
  type AnthropicThinkingBlock,
  type NeutralMessage,
} from '../lib/api-adapters'
import type { ApiCompat, Message, ToolCall, ToolResult, StreamingToolCall, TokenUsage } from '../types/agent'

const SYSTEM_PROMPT = `You are ClerkBox, a powerful AI assistant running on the user's desktop. You interact with the user's file system and terminal through tools.

## Your Capabilities
- Read, write, and list files and directories
- Execute terminal commands (cmd / PowerShell)
- Search files and file contents
- Search the web for real-time information (web_search tool)
- Fetch and extract content from web pages (web_fetch tool)

## Working Principles
1. Understand the user's intent first, then decide which tools to use
2. Verify correct paths before operating on files
3. Warn the user before executing dangerous commands
4. When encountering errors, analyze the cause and attempt to fix
5. Reply to the user in Chinese
6. When the user asks about real-time info, news, or latest information, use the web_search tool
7. When you need detailed content from a specific webpage, first use web_search then use web_fetch on individual pages

## ⚠️ File Editing Rules (Extremely Important)
You MUST use the write_file or search_replace tools to edit files. **DO NOT** use execute_command with echo/Out-File/Set-Content or similar commands to write files.

### write_file — Create new files or full rewrites
- Use for: creating new files, making major rewrites to existing files (changes affecting >30% of the file)

### search_replace — Precise modification of existing files (preferred)
- **Step 1**: First use read_file to read the file and find the exact code block to modify
- **Step 2**: Call search_replace with old_str set to the exact content copied from the file
  - old_str must match the file content **character-for-character** (including spaces, indentation, line breaks)
  - old_str must include enough surrounding context to uniquely locate the target (recommend including 2–3 extra lines before and after)
  - new_str is the modified replacement content
- **Modify one location at a time**. For multiple changes, call search_replace consecutively
- If old_str is not unique in the file, the tool will return an error listing all match locations — extend the context and retry

## ⚠️ Shell Selection Strategy
The execute_command tool accepts a shell parameter: "cmd" (default) or "powershell":

### Use cmd by default (recommended):
- Simple file operations: dir, type, copy, move, del, mkdir, rmdir
- Running programs: node, python, npm, npx, git
- Network requests: curl, ping (& is not a special character in cmd, URLs are not truncated)
- Simple path operations

### Use powershell when:
- PowerShell cmdlets are needed: Get-Content, Set-Content, Get-ChildItem, Select-String
- Complex object pipelines: | Where-Object, | ForEach-Object, | Select-Object
- JSON processing: ConvertFrom-Json, ConvertTo-Json
- Regex matching: -match, -replace
- Environment variables: $env:VAR

### cmd Notes:
- Wrap paths containing spaces in double quotes
- Chinese paths have no encoding issues
- & is not a special character in cmd, URLs with & work normally
- % is a variable reference in cmd; use %% for a literal %
- Chain multiple commands with & (e.g., cd /d "path" & npm run dev)

### powershell Notes:
- & is the call operator; URLs containing & must be wrapped in quotes
- $ is a variable prefix; use single-quoted strings to avoid expansion
- % is shorthand for ForEach-Object

## Output Format
- Use markdown code blocks for code
- Use inline code for file paths
- Use bold for key information`

/** Build .clerkbox-aware system prompt section */
const CLERKBOX_PROMPT = `

## 📂 .clerkbox Working Directory
Your working directory contains a \`.clerkbox/\` folder with the following structure:
\`\`\`
.clerkbox/
├── skills/    ← activated skills
├── plan/      ← plan mode work plans
└── memory/    ← structured memory (MEMORY.md + topic files)
\`\`\`

### Skills (Progressive Loading)
The user has activated several skills. Below is a lightweight **skill index** (name + description + trigger keywords + path). The full SKILL.md content is NOT included here to save context.

**Skill Router Rules:**
1. **Match by relevance**: Compare the user's current task against each skill's description and trigger_keywords. Only read the SKILL.md of skills that are clearly relevant to the current task.
2. **No match → skip reading**: If no skill matches the current task, do NOT read any SKILL.md file. Respond directly.
3. **Read on-demand**: When a skill matches, use the read_file tool to read its SKILL.md (path shown in the index), then follow its instructions.
4. **Task evolution**: If the conversation shifts and a previously-irrelevant skill becomes relevant, read its SKILL.md at that point.
5. **Slash command**: If the user's message starts with \`/<skill-slug>\`, treat it as an explicit activation — immediately read that skill's SKILL.md and prioritize its instructions for the subsequent input.
6. **Skill chaining**: When a skill's main action completes and it declares \`chains_to\` (a list of successor skill slugs), evaluate whether any successor skill's description matches the current state. If it matches, read that successor's SKILL.md and continue per its instructions. Chaining is advisory (use your judgment), not mandatory.

**Skill Index:**
(see the "Currently Active Skills" list injected below)

### Plan Mode
When you are in Plan Mode:
1. Analyze the user's requirements and formulate a detailed work plan
2. Write the plan to \`.clerkbox/plan/plan.md\` (use the write_file tool)
3. Inform the user that the plan has been written and wait for confirmation before executing
4. After the user confirms, execute step by step according to the plan`

/** Build plan mode specific prompt */
const PLAN_MODE_PROMPT = `

## ⚠️ Current Mode: Plan Mode
You are now in Plan Mode. In this mode:
1. **Do not execute operations directly.** First analyze the user's requirements and formulate a detailed plan.
2. Use the write_file tool to write the plan to \`.clerkbox/plan/plan.md\`
3. The plan should include: objectives, steps, specific operations for each step, and expected results
4. After writing, include the marker \`[PLAN_COMPLETE]\` at the end of your reply message. The system will automatically switch to Craft (execution) mode, and you can then begin executing step by step according to the plan.
5. If the user asks to modify the plan, rewrite plan.md and include \`[PLAN_COMPLETE]\` again.`

const MAX_REACT_ITERATIONS = 100 // Loop exits when model stops calling tools or hits this cap

export function useAgent(sessionId: string) {
  const settings = useSettingsStore()
  const { addMessage, updateMessage, setStreaming, sessions, compactSession, setSessionStatus } = useChatStore()
  const tokenTrackerRef = useRef<TokenTracker>(new TokenTracker())
  const sessionReadFilesRef = useRef<Map<string, { content: string; timestamp: number }>>(new Map())
  const [error, setError] = useState<string | null>(null)

  /** Get working directory for current session, with default fallback */
  const getWorkingDir = () => {
    const session = sessions.find((s) => s.id === sessionId)
    if (session?.workingDir) return session.workingDir
    // Default: use the session's auto-generated working dir
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

      // M6: 120s timeout 使用独立的 AbortController，避免 abort 整个 ReAct 循环的 controller。
      // 旧实现直接用 controller.abort()，一次慢响应会让整个会话后续都无法继续。
      // 注意：主进程代理路径的超时由主进程自己管，这里的超时只覆盖「建立连接」阶段。
      const timeoutController = new AbortController()
      const timeoutId = setTimeout(() => timeoutController.abort(new Error('Request timeout after 120s')), 120_000)
      // 组合信号：外层 controller 或 timeout 任一触发都中止当前请求
      const combinedSignal: AbortSignal = (AbortSignal as any).any
        ? (AbortSignal as any).any([controller.signal, timeoutController.signal])
        : controller.signal
      const forwardAbort = () => timeoutController.abort()
      controller.signal.addEventListener('abort', forwardAbort)

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
        controller.signal.removeEventListener('abort', forwardAbort)
        clearTimeout(timeoutId)
        // 仅在建连失败时 abort timeoutController（避免泄漏）。
        // 成功时不 abort —— 流尚未读取，abort 会中断流。
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
    const system = msgs[0]
    const rest = msgs.slice(1)

    let runningTokens = estimateTokens(system.content || '')

    // Walk from most recent backwards, accumulating tokens
    // Find the earliest message we can keep without breaking sequence integrity
    let cutIndex = rest.length // Start by trying to keep everything after system

    for (let i = rest.length - 1; i >= 0; i--) {
      const m = rest[i]
      const mTokens = estimateTokens(m.content || '') + estimateTokens(m.tool_calls ? JSON.stringify(m.tool_calls) : '') + estimateTokens(m.reasoning_content || '')

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

    const kept = [system, ...rest.slice(cutIndex)]
    return kept
  }

  /** Build API-compatible message array from our Message[].
   *  opts.extraSystemPrompt: 子 agent 模式下覆盖系统提示；不传则走主 agent 逻辑。 */
  const buildAPIMessages = (
    msgs: Message[],
    opts: {
      memoryPrompt?: string
      workingDir?: string
      permissionMode?: string
      activeSkillIndex?: Array<{
        slug: string
        name: string
        description: string
        triggerKeywords: string[]
        version: string
        skillMdPath: string
        chainsTo: string[]
      }>
      extraSystemPrompt?: string
    } = {}
  ): NeutralMessage[] => {
    const {
      memoryPrompt = '',
      workingDir = getWorkingDir(),
      permissionMode = settings.permissionMode,
      activeSkillIndex = useSkillsStore.getState().getActiveSkillIndex(),
      extraSystemPrompt,
    } = opts

    let systemContent: string
    if (extraSystemPrompt) {
      // 子 agent 模式：用 agent 自己的 system prompt 覆盖
      systemContent = extraSystemPrompt
      if (workingDir) {
        systemContent += `\n\n## 当前工作目录\n${workingDir}`
      }
    } else {
      // 主 agent 模式：保留原有逻辑
      systemContent = SYSTEM_PROMPT
      if (workingDir) {
        systemContent += `\n\n## 当前工作目录\n${workingDir}\n\n用户的文件操作默认在此目录下执行。`
        systemContent += CLERKBOX_PROMPT
        if (memoryPrompt) systemContent += '\n\n' + memoryPrompt
        if (activeSkillIndex.length > 0) {
          const indexLines = activeSkillIndex.map((s) => {
            const kw = s.triggerKeywords.length > 0 ? ` | keywords: ${s.triggerKeywords.join(', ')}` : ''
            const ver = s.version ? `@${s.version}` : ''
            const chain = s.chainsTo.length > 0 ? ` | chains_to: ${s.chainsTo.join(', ')}` : ''
            return `- \`${s.slug}\`${ver} → ${s.skillMdPath} | ${s.name}: ${s.description}${kw}${chain}`
          })
          systemContent += `\n\n### ⚡ Currently Active Skills (Index)\n${indexLines.join('\n')}\n\n**Follow the Skill Router rules above. Do NOT read all skills — only read those matching the current task.**`
        }
      }
      if (permissionMode === 'plan') systemContent += PLAN_MODE_PROMPT
    }

    const result: NeutralMessage[] = [
      { role: 'system', content: systemContent },
    ]

    for (const m of msgs) {
      if (m.role === 'system') continue // We already added system prompt
      // 跳过 UI 占位消息（子 agent 卡片），它们不是真实对话内容，会破坏 tool_calls ↔ tool 配对
      if (m.isSubAgentCard) continue
      // 跳过空的 assistant 占位消息（无内容、无工具调用、无思考内容）
      // 这些可能是旧会话中未标记 isSubAgentCard 的遗留占位消息
      if (m.role === 'assistant' && !m.toolCalls?.length && !m.content && !m.thinkingContent) continue

      if (m.role === 'tool') {
        // Tool result message
        const toolCallId = m.toolResults?.[0]?.toolCallId || ''
        result.push({
          role: 'tool',
          content: m.content,
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
            content: '[此工具调用的结果因上下文压缩或中断丢失]',
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
            content: '[此工具调用的结果因上下文压缩或中断丢失]',
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

    return cleaned
  }

  /** Main send message function with full ReAct loop */
  const sendMessage = useCallback(
    async (content: string) => {
      // Prevent concurrent sends on the same session（per-session 粒度，不阻塞其他会话并发）
      if (getSessionAbortController(sessionId)) {
        setError('当前正在处理中，请等待完成后再发送')
        return
      }

      if (!settings.baseUrl) {
        setError('请先在设置中配置 API Base URL')
        return
      }
      // 本地部署（Ollama / LM Studio 等）无需 Key，不能在这里一刀切拦掉
      const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
      if (!settings.apiKey && requiresApiKey(settings.baseUrl, activeProvider?.presetId)) {
        setError('请先在设置中配置 API Key')
        return
      }

      setError(null)
      setStreaming(true, sessionId)
      // 标记 per-session 工作状态（侧边栏 loading 圈依据此显示）
      setSessionStatus(sessionId, 'working')

      const controller = new AbortController()
      setSessionAbortController(sessionId, controller)
      // 记录是否是用户主动 abort，用于决定是否发"异常停下"通知
      let abortedByUser = false

      // Add user message
      const userMsg: Message = {
        id: makeId(),
        role: 'user',
        content,
        timestamp: Date.now(),
      }
      addMessage(sessionId, userMsg)

      // Get all messages for context
      const chatStore = useChatStore.getState()
      const session = chatStore.sessions.find((s) => s.id === sessionId)
      const contextMessages = session ? [...session.messages, userMsg] : [userMsg]

      try {
        await reactLoop(contextMessages, controller)
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
          content: `❌ 出错了：${msg}`,
          timestamp: Date.now(),
        })
        // 标记 error 状态 + 系统通知（仅当用户不在此会话时）
        setSessionStatus(sessionId, 'error')
        notifyIfNotViewing(sessionId, 'error', msg.slice(0, 200))
      } finally {
        // B3: 只清当前 controller 的引用，避免误清新会话的 controller。
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

  /** ReAct loop: think → act → observe → repeat */
  const reactLoop = async (
    initialMessages: Message[],
    controller: AbortController
  ) => {
    let conversationMessages = [...initialMessages]

    // Pre-fetch memory prompt once per react loop
    const workingDir = getWorkingDir()
    const homeDir = ipc.homeDir()
    let memoryPrompt = ''
    if (homeDir) {
      try {
        memoryPrompt = await buildMemoryPrompt(workingDir, homeDir)
      } catch {
        memoryPrompt = ''
      }
    }

    // anthropic 协议下，带工具调用的 assistant 轮必须原样回放带签名的 thinking block。
    // 签名只在本轮 ReAct 循环内有效，所以放内存不入库；键为 assistant 消息 id。
    const thinkingBlocks = new Map<string, AnthropicThinkingBlock[]>()

    for (let iteration = 0; iteration < MAX_REACT_ITERATIONS; iteration++) {
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
      const currentTokenCount = tokenTrackerRef.current.getTokenCount(conversationMessages)
      if (currentTokenCount > autoCompactThreshold && conversationMessages.length > 12) {
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
          // M2: 压缩成功后重置主 agent 的 token tracker。若保留压缩前的大 usage.lastUsage，
          // 下一轮 getTokenCount 会取 max(lastUsage, estimated)，导致继续误判超过阈值，
          // 反复进入 compactConversation 并抛 "Not enough messages to compact"。
          tokenTrackerRef.current.reset()

          console.log(`[compact] Auto-compacted: ${compactionResult.preCompactTokenCount} → ${compactionResult.postCompactTokenCount} tokens, ${compactionResult.boundaryMessage.compactMetadata?.messagesSummarized} messages summarized`)
        } catch (err) {
          console.error('[compact] Auto-compaction failed, falling back to truncateMessages:', err)
          // 压缩失败：把"正在压缩"占位消息改为可见提示，避免残留空白占位
          updateMessage(sessionId, compactingId, {
            content: i18n.t('chat.compactFailed'),
            _isCompacting: false,
          })
          // Fallback: let truncateMessages handle it below
        }
      }

      // Build API messages from conversation history (with auto-truncation for long conversations)
      const apiMessages = truncateMessages(buildAPIMessages(conversationMessages, { memoryPrompt }))

      // Call API
      const response = await callAPI(apiMessages, controller, { thinkingBlocks })

      // Parse streaming response
      let content = ''
      let thinkingContent = ''
      let finishReason: string | null = null
      const assistantId = makeId()
      let lastStreamUpdate = 0  // Throttle for streaming tool call updates

      // Create assistant message placeholder
      addMessage(sessionId, {
        id: assistantId,
        role: 'assistant',
        content: '',
        thinkingContent: '',
        timestamp: Date.now(),
        _isStreaming: true,  // Mark as currently streaming
      })

      const toolCallBuffers = await parseStream(response, controller, {
        onContent: (text) => {
          content += text
          // B2: 主 agent 流式回调加 50ms 节流，对齐子 agent 实现。
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
          // B2: 节流期间累积的 content/thinkingContent 需要强制 flush 一次，确保最终内容完整写入 UI 和 DB
          updateMessage(sessionId, assistantId, { content, thinkingContent })
          finishReason = reason
        },
        onUsage: (usage: TokenUsage) => {
          tokenTrackerRef.current.recordUsage(usage)
        },
        onThinkingBlock: (block) => {
          const list = thinkingBlocks.get(assistantId)
          if (list) list.push(block)
          else thinkingBlocks.set(assistantId, [block])
        },
      })

      // B4: abort 后不执行 toolCalls。parseStream 返回后立即检查 abort 状态，
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
        content += '\n\n⚠️ **输出被截断（达到最大 token 限制），回答可能不完整。**'
      }

      // Update the assistant message with final content
      const assistantMessage: Message = {
        id: assistantId,
        role: 'assistant',
        content: content || (toolCalls.length > 0 ? '正在使用工具...' : ''),
        thinkingContent: thinkingContent || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: finishReason || undefined,
        timestamp: Date.now(),
        streamingToolCalls: undefined,  // Clear streaming data after completion
        _isStreaming: false,  // Stream completed
      }
      updateMessage(sessionId, assistantId, assistantMessage)
      conversationMessages.push(assistantMessage)

      // No tool calls → we're done
      if (toolCalls.length === 0) {
        // Plan mode: detect [PLAN_COMPLETE] marker → auto-switch to craft
        if (settings.permissionMode === 'plan' && content.includes('[PLAN_COMPLETE]')) {
          // Remove marker from display
          const cleanedContent = content.replace(/\[PLAN_COMPLETE\]/g, '').trim()
          updateMessage(sessionId, assistantId, { content: cleanedContent })
          // Auto-switch to craft mode
          useSettingsStore.getState().updateSettings({ permissionMode: 'craft' })
          // Read plan.md and inject as system message for AI to reference
          const wd = getWorkingDir()
          const planPath = wd ? wd + '\\.clerkbox\\plan\\plan.md' : '.clerkbox\\plan\\plan.md'
          try {
            const planContent = await ipc.readFile(planPath)
            addMessage(sessionId, {
              id: makeId(),
              role: 'user',
              content: `[System] \n\n## 📋 Execution Plan\n${planContent}\n\nPlease follow the above plan strictly and execute step by step.`,
              timestamp: Date.now(),
            })
          } catch {
            addMessage(sessionId, {
              id: makeId(),
              role: 'user',
              content: '[System] \n\n✅ Plan mode is complete. Automatically switched to Craft execution mode. Please read `.clerkbox/plan/plan.md` to understand the plan and execute.',
              timestamp: Date.now(),
            })
          }
        }
        // Collapse all intermediate assistant messages (those that had tool calls)
        // Only keep the final assistant message expanded
        collapseIntermediateMessages(sessionId, assistantId)
        return
      }

      // Execute tool calls (并行执行：同一批 toolCalls 互相独立，尤其 spawn_agent 需要并行)
      const results: ToolResult[] = []
      // L1: 复用循环顶部已声明的 workingDir，避免变量 shadow

      const execOne = async (tc: ToolCall): Promise<ToolResult> => {
        // Permission check
        const permResult = await checkToolPermission(tc.name, tc.arguments)
        if (!permResult.allowed) {
          return {
            toolCallId: tc.id,
            content: `权限被拒绝：${permResult.reason}`,
            isError: true,
          }
        }

        // Inject working dir for tools that support cwd
        const argsWithCwd = { ...tc.arguments }
        if (workingDir) {
          if (tc.name === 'execute_command' && !argsWithCwd.cwd) {
            argsWithCwd.cwd = workingDir
          }
          if ((tc.name === 'read_file' || tc.name === 'write_file' || tc.name === 'search_replace') && !String(argsWithCwd.path).includes(':')) {
            // Relative path → make absolute
            argsWithCwd.path = workingDir + '\\' + argsWithCwd.path
          }
          if ((tc.name === 'list_dir' || tc.name === 'search_files' || tc.name === 'search_content') && !String(argsWithCwd.path).includes(':')) {
            argsWithCwd.path = workingDir + '\\' + argsWithCwd.path
          }
        }

        try {
          const result = await toolRegistry.execute(tc.name, argsWithCwd, {
            workingDir,
            homeDir: ipc.homeDir(),
            sessionId,
            readFileState: sessionReadFilesRef.current,
            spawnSubAgent: async (agentType: string, subPrompt: string) => {
              // B6: 先验证 agent 类型存在，再插入卡片消息。旧实现先插卡片再 runSubAgent，
              // 若 findAgent 失败则卡片已持久化但 runs store 无记录，成为永久孤儿。
              const agent = await findAgent(agentType, getWorkingDir())
              if (!agent) {
                return `Error: 未知 agent 类型: ${agentType}`
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
                return `Error: 子 agent 执行失败 - ${e instanceof Error ? e.message : String(e)}`
              }
            },
          })
          const isError = result.startsWith('Error') || result.startsWith('❌')
          return {
            toolCallId: tc.id,
            content: result,
            isError,
          }
        } catch (err) {
          return {
            toolCallId: tc.id,
            content: `工具执行失败：${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          }
        }
      }

      // 并行执行所有 tool calls，保持原始顺序
      const parallelResults = await Promise.all(toolCalls.map((tc) => execOne(tc)))
      results.push(...parallelResults)

      // Update assistant message with tool results
      updateMessage(sessionId, assistantId, { toolResults: results })

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

      // Continue the ReAct loop → model will process tool results and decide next action
    }

    // Safety net - should almost never hit this
    addMessage(sessionId, {
      id: makeId(),
      role: 'assistant',
      content: '⚠️ 已达到安全轮次上限（999轮），对话可能异常。请重新开始会话。',
      timestamp: Date.now(),
    })
  }

  /** Check permission for a tool call.
   *  opts.allowedTools / opts.disallowedTools: 子 agent 工具白/黑名单（存在时跳过主 agent 的精细检查）。
   *  opts.permissionMode: 覆盖权限模式（默认 settings.permissionMode）。 */
  const checkToolPermission = async (
    toolName: string,
    args: Record<string, unknown>,
    opts: {
      permissionMode?: string
      allowedTools?: string[]
      disallowedTools?: string[]
    } = {}
  ): Promise<{ allowed: boolean; reason?: string }> => {
    const {
      permissionMode = settings.permissionMode,
      allowedTools,
      disallowedTools,
    } = opts

    // 子 agent 工具白名单检查（优先）
    if (allowedTools && !allowedTools.includes('*') && !allowedTools.includes(toolName)) {
      return { allowed: false, reason: `子 agent 工具白名单不允许: ${toolName}` }
    }
    // 子 agent 工具黑名单检查
    if (disallowedTools && disallowedTools.includes(toolName)) {
      return { allowed: false, reason: `子 agent 工具黑名单禁止: ${toolName}` }
    }

    // 子 agent 模式（传入了 allowedTools/disallowedTools）：默认不弹权限确认，
    // 但仍保留危险命令检查，避免子 agent 无确认执行 rm -rf 等高危命令。
    if (allowedTools || disallowedTools) {
      if (toolName === 'execute_command') {
        const cmd = String(args.command || '')
        if (isDangerousCommand(cmd)) {
          return {
            allowed: false,
            reason: `子 agent 不允许执行高风险命令：${cmd.slice(0, 100)}`,
          }
        }
      }
      // 危险路径写入同样禁止
      if (toolName === 'write_file' || toolName === 'search_replace') {
        const filePath = String(args.path || '')
        const dangerousPaths = ['/etc/', 'C:\\Windows\\', 'C:\\Program Files']
        if (dangerousPaths.some((p) => filePath.startsWith(p))) {
          return { allowed: false, reason: `子 agent 不允许写入系统目录：${filePath}` }
        }
      }
      return { allowed: true }
    }

    const mode = permissionMode

    // Ask mode: only allow safe read operations + web tools + memory search
    if (mode === 'ask') {
      if (['read_file', 'list_dir', 'search_files', 'search_content', 'web_search', 'web_fetch', 'search_memory'].includes(toolName)) {
        return { allowed: true }
      }
      return { allowed: false, reason: '当前处于 Ask 模式，仅允许读取和网络操作。如需执行写操作或命令，请切换到 Craft 模式。' }
    }

    // Plan mode: allow read + write_file (for plan.md only) + list_dir + memory tools, but no execute_command
    if (mode === 'plan') {
      if (['read_file', 'list_dir', 'search_files', 'search_content', 'web_search', 'web_fetch', 'search_memory'].includes(toolName)) {
        return { allowed: true }
      }
      if (toolName === 'save_memory') {
        return { allowed: true }
      }
      if (toolName === 'write_file' || toolName === 'search_replace') {
        const filePath = String(args.path || '')
        // S5: 旧实现用 path.includes('.clerkbox') && path.includes('plan') 子串匹配，
        // 可被 D:\project\.clerkbox\plan-evil\malicious.md 或 ..\other\exploit.md 绕过。
        // 改用规范化后的路径前缀严格判断：必须落在 <workingDir>/.clerkbox/plan/ 之下。
        const isInsidePlanDir = (() => {
          const wd = getWorkingDir()
          if (!wd) return false
          // 统一分隔符为 /，规范化（合并连续分隔符、去除尾部分隔符）
          const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
          const normalizedPath = normalize(filePath)
          const planBase = normalize(wd) + '/.clerkbox/plan/'
          if (!normalizedPath.toLowerCase().startsWith(planBase.toLowerCase())) return false
          // 剩余部分不得以 .. 开头或含 /../ 段（防止 plan/../other 绕过）
          const rel = normalizedPath.slice(planBase.length)
          return !rel.startsWith('..') && !rel.includes('/../') && !rel.startsWith('/')
        })()
        if (isInsidePlanDir) {
          return { allowed: true }
        }
        return { allowed: false, reason: '计划模式下仅允许写入 .clerkbox/plan/ 目录。如需执行操作，请切换到 Craft 模式。' }
      }
      if (toolName === 'execute_command') {
        return { allowed: false, reason: '计划模式下不允许执行命令。请先确认计划，再切换到 Craft 模式执行。' }
      }
      return { allowed: false, reason: '计划模式下仅允许读取和写入计划文件。' }
    }

    // Craft mode: allow everything, but dangerous commands need user confirmation
    if (toolName === 'execute_command') {
      const cmd = String(args.command || '')
      if (isDangerousCommand(cmd)) {
        // 危险命令确认前：标记 confirm-danger + 通知（仅当用户不在此会话时）
        setSessionStatus(sessionId, 'confirm-danger')
        notifyIfNotViewing(sessionId, 'confirm-danger', `命令：${cmd.slice(0, 100)}`)
        const confirmed = await ipc.confirmDialog(
          '高风险命令确认',
          `ClerkBox 即将执行以下高风险命令，是否确认？\n\n${cmd.slice(0, 200)}`
        )
        // 确认或取消后：恢复 working 状态（sendMessage 仍在执行中）
        setSessionStatus(sessionId, 'working')
        if (!confirmed) {
          return { allowed: false, reason: '用户取消了高风险命令的执行' }
        }
      }
    }

    // Check dangerous file writes in craft mode too
    if (toolName === 'write_file' || toolName === 'search_replace') {
      const path = String(args.path || '')
      const dangerousPaths = ['/etc/', 'C:\\Windows\\', 'C:\\Program Files']
      if (dangerousPaths.some((p) => path.startsWith(p))) {
        const confirmed = await ipc.confirmDialog(
          '系统目录写入确认',
          `ClerkBox 即将写入系统目录：\n${path}\n\n此操作可能影响系统稳定性，是否确认？`
        )
        if (!confirmed) {
          return { allowed: false, reason: '用户取消了系统目录写入' }
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
    // 仅清当前会话的 streaming 状态
    useChatStore.getState().setStreaming(false, sessionId)
    // 用户主动 abort：清当前会话工作状态，不发通知
    if (sessionId) {
      useChatStore.getState().setSessionStatus(sessionId, null)
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
      if (msg.role === 'assistant' && (!msg.toolCalls || msg.toolCalls.length === 0) && msg.content && !msg.content.includes('正在使用工具')) continue  // Keep assistant summaries visible

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
    if (!agent) throw new Error(`未知 agent 类型: ${agentType}`)

    const subAgentId = presetSubAgentId || `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const subController = new AbortController()
    // 父 controller abort 联动
    if (parentController.signal.aborted) subController.abort()
    const onParentAbort = () => subController.abort()
    parentController.signal.addEventListener('abort', onParentAbort)

    // 子 agent 自己的 readFileState（用于 auto-compact 时的文件附件恢复）
    let subReadFileState = new Map<string, { content: string; timestamp: number }>()
    // M1: 子 agent 独立的 token tracker，避免 usage 污染主 agent 的 token 估算
    const subTokenTracker = new TokenTracker()
    // 子 agent 自己的 settings 副本（覆盖 model）
    const subSettings = agent.model ? { ...settings, model: agent.model } : settings

    // 初始消息：prompt 作为 user 消息
    let conversationMessages: Message[] = [{
      id: makeId(),
      role: 'user',
      content: prompt,
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
      for (let iteration = 0; iteration < maxTurns; iteration++) {
        if (subController.signal.aborted) break

        // ── auto-compact 检查（子 agent 也要应用） ──
        const subInputBudget = (() => {
          const m = subSettings.providers
            ?.find((p) => p.id === subSettings.activeProviderId)
            ?.models.find((x) => x.id === subSettings.activeModelId)
          return m?.maxInputTokens ?? subSettings.maxInputTokens ?? 184000
        })()
        const subAutoCompactThreshold = Math.max(subInputBudget - 20000, Math.floor(subInputBudget * 0.8))
        const tokenCount = subTokenTracker.getTokenCount(conversationMessages)
        if (tokenCount > subAutoCompactThreshold && conversationMessages.length > 12) {
          try {
            const compactionResult = await compactConversation(
              conversationMessages,
              subSettings,
              subReadFileState,
              `这是子 agent ${agent.name} 的对话，请压缩以继续工作。`,
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

        // 构建 API 消息（用子 agent 的 systemPrompt 覆盖）
        const apiMessages = truncateMessages(buildAPIMessages(conversationMessages, {
          workingDir,
          memoryPrompt: '',
          permissionMode: 'craft',
          activeSkillIndex: [],
          extraSystemPrompt: agent.systemPrompt,
        }))

        const response = await callAPI(apiMessages, subController, { modelOverride: agent.model, thinkingBlocks })

        // 解析流（复用 parseStream）
        let content = ''
        let thinkingContent = ''
        let finishReason: string | null = null
        const assistantId = makeId()
        let lastStreamUpdate = 0

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

        const toolCallBuffers = await parseStream(response, subController, {
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

        // B4: abort 后不执行 toolCalls（与主 agent 一致）
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
          content += '\n\n⚠️ 输出被截断。'
        }

        const assistantMessage: Message = {
          id: assistantId,
          role: 'assistant',
          content: content || (toolCalls.length > 0 ? '正在使用工具...' : ''),
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

        // 执行工具调用
        const results: ToolResult[] = []
        for (const tc of toolCalls) {
          const permResult = await checkToolPermission(tc.name, tc.arguments, {
            permissionMode: 'craft',
            allowedTools: agent.tools,
            disallowedTools: agent.disallowedTools,
          })
          if (!permResult.allowed) {
            results.push({ toolCallId: tc.id, content: `权限被拒绝：${permResult.reason}`, isError: true })
            continue
          }

          const argsWithCwd = { ...tc.arguments }
          if (workingDir) {
            if (tc.name === 'execute_command' && !argsWithCwd.cwd) argsWithCwd.cwd = workingDir
            if ((tc.name === 'read_file' || tc.name === 'write_file' || tc.name === 'search_replace') && !String(argsWithCwd.path || '').includes(':')) {
              argsWithCwd.path = workingDir + '\\' + argsWithCwd.path
            }
            if ((tc.name === 'list_dir' || tc.name === 'search_files' || tc.name === 'search_content') && !String(argsWithCwd.path || '').includes(':')) {
              argsWithCwd.path = workingDir + '\\' + argsWithCwd.path
            }
          }

          try {
            const result = await toolRegistry.execute(tc.name, argsWithCwd, {
              workingDir,
              homeDir,
              sessionId,
              readFileState: subReadFileState,
            })
            results.push({ toolCallId: tc.id, content: result, isError: result.startsWith('Error') || result.startsWith('❌') })
          } catch (err) {
            results.push({ toolCallId: tc.id, content: `工具执行失败：${err instanceof Error ? err.message : String(err)}`, isError: true })
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
      }

      // 达到 maxTurns
      const partialResult = conversationMessages[conversationMessages.length - 1]?.content || '子 agent 达到最大迭代数，未产生最终结果'
      // B5: 若已中断，标记为 aborted 而非 completed；原来 break 后直接落到这里会误标 completed。
      if (subController.signal.aborted) {
        useAgentRunsStore.getState().abortSubAgentRun(sessionId, subAgentId)
        return '[aborted]'
      }
      useAgentRunsStore.getState().completeSubAgentRun(sessionId, subAgentId, partialResult)
      return partialResult
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      // B5: 区分 AbortError 与真实失败
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

  return { sendMessage, abort, error }
}
