export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  thinkingContent?: string
  timestamp: number
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  finishReason?: string
  collapsed?: boolean  // When true, this message is collapsed (hidden by default, expandable)
  isCompactSummary?: boolean  // Marks compact boundary/summary messages
  compactMetadata?: CompactMetadata  // Metadata for compact boundary messages
  streamingToolCalls?: StreamingToolCall[]  // Tool calls currently being streamed (transient, not persisted)
  _isStreaming?: boolean  // Transient: true while this message is being streamed from API
  subAgentId?: string        // 标记此消息属于哪个子 agent（主对话消息不带此字段）
  isSubAgentCard?: boolean   // 标记此消息是子 agent 卡片占位（用于 UI 渲染）
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  toolCallId: string
  content: string
  isError?: boolean
}

export interface StreamingToolCall {
  id: string
  name: string
  argsSoFar: string  // Raw JSON string accumulated so far
}

export interface CompactMetadata {
  trigger: 'auto' | 'manual'
  preTokens: number
  messagesSummarized: number
  compactedAt: number
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: object
}

export interface CompactionResult {
  boundaryMessage: Message
  summaryMessage: Message
  fileAttachments: Message[]
  preCompactTokenCount: number
  postCompactTokenCount: number
}

export interface Session {
  id: string
  title: string
  workingDir?: string
  defaultWorkDir?: string  // Auto-generated if user doesn't pick a folder
  messages: Message[]
  createdAt: number
  updatedAt: number
}

/** 用户自定义模型（一个平台接入的完整档案） */
export interface CustomModel {
  id: string
  /** 显示名，如 "DeepSeek V3" */
  label: string
  /** 模型 id，如 "deepseek-chat" */
  model: string
  baseUrl: string
  apiKey: string
}

export interface AppSettings {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  theme: 'light' | 'dark' | 'system'
  /** 色系：马卡龙预设 id 或 'custom' */
  colorScheme: string
  /** 自定义种子色（colorScheme 为 'custom' 时生效） */
  customSeedColor: string
  language: string
  permissionMode: 'craft' | 'ask' | 'plan'
  enableThinking: boolean
  thinkingBudget?: number
  /** 用户自定义模型列表（多平台接入） */
  customModels: CustomModel[]
  /** 当前生效的自定义模型 id（空 = 手动直填） */
  activeCustomModelId?: string
  /** 首次启动欢迎流程是否已完成（true = 不再展示） */
  hasCompletedOnboarding: boolean
}

/** OpenAI-compatible stream chunk delta */
export interface StreamDelta {
  content?: string
  role?: string
  reasoning_content?: string
  thinking_content?: string  // Some GLM versions may use this field name
  tool_calls?: Array<{
    index: number
    id?: string
    type?: string
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

export interface StreamChunk {
  choices: Array<{
    delta: StreamDelta
    finish_reason?: string | null
  }>
  usage?: TokenUsage
}

export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

// ── 结构化记忆系统类型 ──

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryEntry {
  filename: string
  name: string
  description: string | null
  type: MemoryType | undefined
  content: string
  mtime: number
}

// ── 多 Agent 派生系统类型 ──

export interface AgentDefinition {
  agentType: string          // 唯一标识，如 'explore' / 'general' / 'code-reviewer'
  name: string               // 显示名，如 "侦察兵"
  whenToUse: string          // AI 判断何时使用的描述
  description: string        // 用户可见的一句话描述
  tools?: string[]           // 允许的工具列表，['*'] 或省略=通配
  disallowedTools?: string[] // 禁用工具
  systemPrompt: string       // 子 agent 的 system prompt
  model?: string             // 模型覆盖（不设=继承主 agent 的 settings.model）
  maxTurns?: number          // 最大迭代数（默认 50）
  source: 'built-in' | 'custom'  // 来源
  color?: string             // UI 颜色（如 'blue' / 'green' / 'orange'）
}

// 子 agent 运行时状态
export interface SubAgentRun {
  id: string                 // 唯一 ID（spawn_agent 工具调用 ID）
  agentType: string          // agent 类型
  agentName: string          // 显示名
  prompt: string             // 派生时给子 agent 的任务指令
  status: 'running' | 'completed' | 'failed' | 'aborted'
  messages: Message[]        // 子 agent 的完整对话轨迹（含工具调用、思考、结果）
  result?: string            // 最终返回给主 agent 的结果文本
  startedAt: number
  finishedAt?: number
  error?: string
}
