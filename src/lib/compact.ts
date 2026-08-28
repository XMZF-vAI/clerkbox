import type { ApiCompat, Message, AppSettings, CompactMetadata, CompactionResult } from '../types/agent'
import { estimateTokensForText, truncateTextToTokens } from './token-estimate'
import { buildRequestBody, extractText } from './api-adapters'
import { postJson } from './api-transport'

// ── 上下文压缩常量 ──

// 有效上下文窗口（默认输入 184K）
export const EFFECTIVE_CONTEXT_WINDOW = 184_000

// 自动压缩阈值（effective window − 20K buffer）
export const AUTO_COMPACT_THRESHOLD = 164_000

// 警告阈值（threshold − 10K）
export const WARNING_THRESHOLD = 154_000

// 压缩时保留的最近消息数（约 2-3 个完整对话轮次）
export const KEEP_RECENT_COUNT = 6

// 压缩摘要 API 调用的最大输出 token 数
export const COMPACT_MAX_OUTPUT_TOKENS = 8_000

// 压缩后恢复的最近文件数
export const POST_COMPACT_MAX_FILES = 5

// 单文件恢复的 token 上限
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000

// 文件恢复总 token 预算
export const POST_COMPACT_TOKEN_BUDGET = 50_000

// 压缩请求 prompt-too-long 时的最大重试次数
export const MAX_COMPACT_RETRIES = 2

// 每张多模态图片附件的固定 token 粗估成本（与 use-agent 截断估算保持一致量级）
const IMAGE_TOKEN_ESTIMATE = 1000

/**
 * Build the system prompt for the compaction LLM call.
 * Instructs the model to produce a structured summary.
 */
export function getCompactPrompt(customInstructions?: string): string {
  const base = `You are a helpful AI assistant tasked with summarizing conversations.

CRITICAL: Do not use any tools. Do not call any functions. Only produce a text summary.

Analyze the conversation and provide a structured summary. First, write your analysis inside <analysis> tags (this will be stripped), then write the final summary inside <summary> tags.

The summary must include these sections:

1. **Primary Request and Intent**: The user's main request/goal. What are they trying to accomplish?

2. **Key Technical Concepts**: Established conventions, design patterns, architectural decisions, and constraints discovered.

3. **Files and Code Sections**: Important files read or modified, with key code snippets and their locations (file paths + line numbers if available).

4. **Errors and Fixes**: Any errors encountered, their causes, and how they were resolved.

5. **Current Work**: What was being actively worked on at the point of summarization. Include the current state/progress.

6. **Pending Tasks**: What remains to be done. Next steps and TODOs.

<example>
<analysis>
Let me review the conversation. The user asked to implement a login system...
</analysis>
<summary>
1. **Primary Request and Intent**: Implement a JWT-based login system for the Express API.

2. **Key Technical Concepts**: JWT tokens, bcrypt password hashing, middleware-based auth.

3. **Files and Code Sections**:
   - \`src/auth/middleware.ts\`: JWT verification middleware
   - \`src/auth/controller.ts\`: Login handler with bcrypt comparison

4. **Errors and Fixes**: "jwt malformed" error — fixed by ensuring Bearer prefix is stripped before verification.

5. **Current Work**: Adding refresh token endpoint. Controller scaffold exists at \`src/auth/controller.ts:45\` but token rotation logic is incomplete.

6. **Pending Tasks**: Complete refresh token endpoint, add rate limiting to login route, write integration tests.
</summary>`

  if (customInstructions) {
    return `${base}\n\n## Additional Instructions\n${customInstructions}`
  }
  return base
}

/**
 * Strip <analysis> block and convert <summary> tags to a "Summary:" header.
 * The LLM is instructed to write analysis first (which we discard) and then
 * the actual summary in <summary> tags.
 */
export function formatCompactSummary(rawSummary: string): string {
  let result = rawSummary

  // Remove <analysis>...</analysis> block entirely
  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')

  // Convert <summary>...</summary> to "Summary:" header
  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch) {
    result = summaryMatch[1]!.trim()
  } else {
    // If no <summary> tags, just use the remaining text (after analysis removal)
    result = result.trim()
  }

  return result
}

/**
 * Build the user message text that carries the compact summary into the
 * post-compaction context. This message replaces all summarized messages.
 */
export function getCompactUserSummaryMessage(summary: string): string {
  return `This session is being continued from a previous conversation. Here is a summary of the conversation so far:\n\n${summary}\n\nContinue the conversation from where it left off.`
}

/**
 * Call the LLM API to generate a conversation summary.
 * Uses non-streaming mode with the compact system prompt.
 * Returns the raw summary text (may contain <analysis> and <summary> tags).
 */
export async function callCompactAPI(
  messages: Message[],
  settings: Pick<AppSettings, 'apiCompat' | 'model' | 'baseUrl' | 'apiKey' | 'directFetch'>,
  customInstructions?: string
): Promise<string> {
  const systemPrompt = getCompactPrompt(customInstructions)

  // Convert messages to API format
  const apiMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ]

  for (const msg of messages) {
    if (msg.role === 'system') continue // Skip system messages (we have our own)
    if (msg.role === 'tool') {
      // Include tool results as user messages for the summarizer（剥离 UI 专用 __EDIT_DIFF__ 元数据）
      const toolContent = (msg.toolResults?.map(r => r.content).join('\n') || msg.content).replace(/\n__EDIT_DIFF__:.*$/s, '')
      apiMessages.push({ role: 'user', content: `[Tool Result] ${toolContent}` })
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const toolCallDesc = msg.toolCalls.map(tc => `[Tool Call: ${tc.name}(${JSON.stringify(tc.arguments)})]`).join('\n')
      apiMessages.push({ role: 'assistant', content: `${msg.content || ''}\n${toolCallDesc}`.trim() })
    } else {
      apiMessages.push({ role: msg.role, content: msg.content })
    }
  }

  // Add the summarization request
  apiMessages.push({ role: 'user', content: 'Please summarize the conversation above according to the format specified.' })

  const compat: ApiCompat = settings.apiCompat || 'openai'

  // 摘要是非流式一次性请求：不开思考、无工具，temperature 0 求稳定
  const body = buildRequestBody(compat, {
    model: settings.model,
    messages: apiMessages,
    tools: [],
    temperature: 0,
    maxTokens: COMPACT_MAX_OUTPUT_TOKENS,
    thinking: false,
    stream: false,
  })

  const data = await postJson(
    {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      apiCompat: compat,
      directFetch: settings.directFetch,
    },
    body
  )

  const content = extractText(compat, data)

  if (!content) {
    throw new Error('Compact API returned empty response')
  }

  return content
}

/**
 * Truncate content to approximately maxTokens, keeping the head.
 * Delegates to the unified token estimation helper.
 */
export function truncateToTokens(content: string, maxTokens: number): string {
  return truncateTextToTokens(content, maxTokens)
}

/**
 * Create file attachment messages for recently accessed files to restore
 * after compaction. This prevents the model from having to re-read files
 * that were recently accessed.
 *
 * Files already present in preservedMessages are skipped (their read_file
 * results are already in the context).
 *
 * @param readFileState Map of filePath → {content, timestamp}
 * @param preservedMessages Messages kept post-compaction; Read results here are skipped
 * @returns Array of Message objects with role='user' containing file content
 */
export function createPostCompactFileAttachments(
  readFileState: Map<string, { content: string; timestamp: number }>,
  preservedMessages: Message[] = []
): Message[] {
  // Collect file paths already present in preserved messages (from read_file tool calls
  // and from previous compaction file attachments) to avoid duplicate restoration
  const preservedPaths = new Set<string>()
  for (const msg of preservedMessages) {
    // 1. Extract paths from read_file tool calls in assistant messages
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.name === 'read_file' && tc.arguments && typeof tc.arguments.path === 'string') {
          preservedPaths.add(tc.arguments.path)
        }
      }
    }
    // 2. Extract paths from previous compaction file attachment messages
    //    Format: "[Previously read file: <path>]\n```..."
    if (msg.role === 'user' && msg.content) {
      const match = msg.content.match(/^\[Previously read file: (.+?)\]$/m)
      if (match) {
        preservedPaths.add(match[1])
      }
    }
  }

  // Get recent files sorted by timestamp (newest first)
  const recentFiles = Array.from(readFileState.entries())
    .map(([filePath, state]) => ({ filePath, ...state }))
    .filter((f) => !preservedPaths.has(f.filePath))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, POST_COMPACT_MAX_FILES)

  const attachments: Message[] = []
  let usedTokens = 0

  for (const file of recentFiles) {
    const truncatedContent = truncateToTokens(file.content, POST_COMPACT_MAX_TOKENS_PER_FILE)

    // Estimate tokens for this file
    const cjkChars = (truncatedContent.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
    const otherChars = truncatedContent.length - cjkChars
    const fileTokens = Math.ceil(cjkChars / 1.5 + otherChars / 4)

    if (usedTokens + fileTokens > POST_COMPACT_TOKEN_BUDGET) {
      break // Exceeded total budget
    }

    usedTokens += fileTokens
    attachments.push({
      id: `compact-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: `[Previously read file: ${file.filePath}]\n\`\`\`\n${truncatedContent}\n\`\`\``,
      timestamp: file.timestamp,
      // 标记为压缩文件恢复消息：UI 渲染为折叠卡片而非用户气泡（role 为 user
      // 仅为满足 API 消息结构，模型需要以 user 身份接收文件内容）
      isCompactAttachment: true,
    })
  }

  return attachments
}

/**
 * Strip image/document references from messages before sending for compaction.
 * ClerkBox is primarily text-based, but this ensures any image placeholders
 * are replaced with text markers.
 */
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (!message.content) return message
    // Replace common image/content markers that might bloat the summary
    const stripped = message.content
      .replace(/!\[.*?\]\(.*?\)/g, '[image]')
      .replace(/\[image:.*?\]/gi, '[image]')
    if (stripped === message.content) return message
    return { ...message, content: stripped }
  })
}

/**
 * Group messages by API round for PTL retry truncation.
 * Each assistant message starts a new group; subsequent tool messages
 * belong to the same group as their preceding assistant message.
 */
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant' && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(msg)
  }
  if (current.length > 0) {
    groups.push(current)
  }

  return groups
}

/**
 * Drop the oldest API-round groups from messages for PTL retry.
 * Returns null if nothing can be dropped (fewer than 2 groups).
 * Drops 20% of groups as a fallback.
 */
export function truncateHeadForPTLRetry(messages: Message[]): Message[] | null {
  const groups = groupMessagesByApiRound(messages)
  if (groups.length < 2) return null

  // Drop 20% of groups (at least 1)
  const dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  // Keep at least 1 group so there's something to summarize
  const safeDropCount = Math.min(dropCount, groups.length - 1)

  const remaining = groups.slice(safeDropCount).flat()

  // If the first message is now a 'tool' message, it needs a preceding assistant.
  // In that case, prepend a synthetic user marker.
  if (remaining.length > 0 && remaining[0].role === 'tool') {
    return [
      {
        id: `ptl-marker-${Date.now()}`,
        role: 'user',
        content: '[earlier conversation truncated for compaction retry]',
        timestamp: Date.now(),
      },
      ...remaining,
    ]
  }

  return remaining
}

/**
 * Find the index at which to split messages into summarize vs keep.
 * Keeps the last `keepRecentCount` messages, adjusting to preserve
 * tool_use/tool_result pairing (never cuts between an assistant+tool_calls
 * and its tool response).
 *
 * @returns The index of the first message to KEEP (messages before this are summarized)
 */
export function findKeepBoundaryIndex(
  messages: Message[],
  keepRecentCount: number = KEEP_RECENT_COUNT
): number {
  if (messages.length <= keepRecentCount) {
    return 0 // Keep everything, nothing to summarize
  }

  let keepStart = messages.length - keepRecentCount

  // Walk backward to ensure we don't start with a 'tool' message
  // (it would be orphaned without its preceding assistant+tool_calls)
  while (keepStart < messages.length) {
    const msg = messages[keepStart]
    if (msg.role === 'tool') {
      // This tool message needs its assistant predecessor
      // Move back to include the assistant message
      if (keepStart > 0 && messages[keepStart - 1].role === 'assistant' && messages[keepStart - 1].toolCalls) {
        keepStart--
        // Now check if this assistant message itself starts a tool chain
        continue
      }
      // Can't find predecessor — skip this tool message
      keepStart++
      continue
    }
    break
  }

  // Also check: if first kept message is assistant+tool_calls but tool responses
  // are not in the kept set, skip the assistant message too
  while (keepStart < messages.length) {
    const msg = messages[keepStart]
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Check if the next message is the corresponding tool response
      const toolCallIds = msg.toolCalls.map(tc => tc.id)
      const nextMsg = messages[keepStart + 1]
      if (nextMsg && nextMsg.role === 'tool' && nextMsg.toolResults) {
        const responseIds = nextMsg.toolResults.map(r => r.toolCallId)
        if (toolCallIds.some(id => responseIds.includes(id))) {
          break // Good, tool response follows
        }
      }
      // No tool response follows — skip this orphaned assistant+tool_calls
      keepStart++
      continue
    }
    break
  }

  return keepStart
}

/**
 * Create a compact version of a conversation by summarizing older messages
 * and preserving recent conversation history.
 *
 * @param messages All conversation messages to compact
 * @param settings App settings (for API call)
 * @param readFileState Map of recently read files (for post-compaction restoration)
 * @param customInstructions Optional user-provided instructions for summarization
 * @param trigger Whether this is an auto or manual compaction
 * @returns CompactionResult with boundary, summary, and file attachment messages
 */
export async function compactConversation(
  messages: Message[],
  settings: Pick<AppSettings, 'apiCompat' | 'model' | 'baseUrl' | 'apiKey' | 'directFetch'>,
  readFileState: Map<string, { content: string; timestamp: number }>,
  customInstructions?: string,
  trigger: 'auto' | 'manual' = 'auto'
): Promise<CompactionResult> {
  if (messages.length === 0) {
    throw new Error('Not enough messages to compact.')
  }

  // 1. Calculate pre-compaction token count (rough estimate)
  const preCompactTokenCount = estimateTokensForMessages(messages)

  // 2. Split messages into summarize vs keep
  const keepStartIndex = findKeepBoundaryIndex(messages, KEEP_RECENT_COUNT)
  const messagesToSummarize = messages.slice(0, keepStartIndex)
  const messagesToKeep = messages.slice(keepStartIndex)

  if (messagesToSummarize.length === 0) {
    throw new Error('Not enough messages to compact — nothing to summarize.')
  }

  // 3. Strip images from messages to summarize
  const strippedMessages = stripImagesFromMessages(messagesToSummarize)

  // 4. Call LLM to generate summary (with PTL retry)
  let messagesForSummary = strippedMessages
  let rawSummary: string = ''
  let attempt = 0

  while (attempt <= MAX_COMPACT_RETRIES) {
    try {
      rawSummary = await callCompactAPI(messagesForSummary, settings, customInstructions)
      break
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      // Check if it's a prompt-too-long error
      if (errMsg.includes('too long') || errMsg.includes('too_many') || errMsg.includes('context_length') || errMsg.includes('maximum context')) {
        attempt++
        if (attempt <= MAX_COMPACT_RETRIES) {
          const truncated = truncateHeadForPTLRetry(messagesForSummary)
          if (!truncated) {
            throw new Error('Compaction failed: cannot truncate further after prompt-too-long')
          }
          messagesForSummary = truncated
          continue
        }
      }
      throw err
    }
  }

  // 5. Format the summary (strip <analysis>, extract <summary>)
  const formattedSummary = formatCompactSummary(rawSummary)
  const summaryText = getCompactUserSummaryMessage(formattedSummary)

  // 6. Clear the read file state (it will be rebuilt from file attachments)
  // Note: caller is responsible for clearing readFileState if needed

  // 7. Create file attachments for recently read files
  const fileAttachments = createPostCompactFileAttachments(readFileState, messagesToKeep)

  // 8. Construct boundary message
  const now = Date.now()
  const boundaryMessage: Message = {
    id: `compact-boundary-${now}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'system',
    content: 'Conversation compacted',
    timestamp: now,
    isCompactSummary: true,
    compactMetadata: {
      trigger,
      preTokens: preCompactTokenCount,
      messagesSummarized: messagesToSummarize.length,
      compactedAt: now,
    } as CompactMetadata,
  }

  // 9. Construct summary message
  // role 设为 'assistant' 而非 'user'：避免 isCompactSummary 标志丢失时
  // 被误渲染为用户消息（绿色气泡）。buildAPIMessages 会将其作为 assistant
  // 消息发给 API，AI 仍能正确理解为对话摘要。
  const summaryMessage: Message = {
    id: `compact-summary-${now}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content: summaryText,
    timestamp: now,
    isCompactSummary: true,
  }

  // 10. Estimate post-compaction token count
  const postCompactMessages = [boundaryMessage, summaryMessage, ...messagesToKeep, ...fileAttachments]
  const postCompactTokenCount = estimateTokensForMessages(postCompactMessages)

  return {
    boundaryMessage,
    summaryMessage,
    fileAttachments,
    preCompactTokenCount,
    postCompactTokenCount,
  }
}

/**
 * Rough token estimation for a message array.
 * Wraps the unified helper and adds compactMetadata weight.
 */
function estimateTokensForMessages(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokensForText(msg.content || '')
    if (msg.toolCalls) {
      total += estimateTokensForText(JSON.stringify(msg.toolCalls))
    }
    if (msg.thinkingContent) {
      total += estimateTokensForText(msg.thinkingContent)
    }
    if (msg.toolResults) {
      for (const tr of msg.toolResults) {
        total += estimateTokensForText(tr.content || '')
      }
    }
    // 图片附件按固定粗估计入（仅统计携带 dataUrl、会真正多模态发送的图片）
    if (msg.attachments) {
      total += msg.attachments.filter((a) => a.kind === 'image' && a.dataUrl).length * IMAGE_TOKEN_ESTIMATE
    }
    if (msg.compactMetadata) {
      total += estimateTokensForText(JSON.stringify(msg.compactMetadata))
    }
  }
  return total
}

