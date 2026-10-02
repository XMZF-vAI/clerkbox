import type { McpServerConfig } from './ipc'

/** 单条消息的任务工作流模式（由 "/" 命令菜单选择，随消息一次性生效）：
 *  spec=生成规范/任务/验收三件套文档，确认后严格执行；plan=先生成计划文档，确认后执行；goal=目标导向持续运行直到完成 */
export type TaskMode = 'spec' | 'plan' | 'goal'

export interface QuestionOption {
  label: string
  description: string
}

export interface UserQuestion {
  id: string
  header: string
  question: string
  options: QuestionOption[]
}

export interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** /goal 评估器的三态判定 */
export type GoalVerdict = 'in_progress' | 'achieved' | 'impossible'

/** 会话级目标（/goal 设定）：跨消息持续生效，直到评估达成/判定无法完成/用户清除 */
export interface SessionGoal {
  /** 目标条件（用户输入原文，含可验证的成功标准） */
  condition: string
  /** active=进行中；achieved=已达成；failed=判定无法完成 */
  status: 'active' | 'achieved' | 'failed'
  /** 设定时间（用于展示已用时；断点恢复后不重置） */
  createdAt: number
  updatedAt: number
  /** 累计评估次数（跨运行累计） */
  evaluations: number
  /** 最近一次评估的理由（进行中时展示） */
  lastReason?: string
  /** 终态结论（achieved/failed 时的说明） */
  conclusion?: string
}

/** 消息上的 Goal 判定卡片元数据（system 消息，UI 专用，不发给模型） */
export interface MessageGoalEvent {
  verdict: GoalVerdict
  /** 评估/暂停原因 */
  reason: string
  /** 本次运行内第几次评估 */
  evaluations: number
}

/** 消息附件：图片携带压缩后的 base64 data URL 真正发给模型；文件只携带绝对路径（内容由模型用工具自行读取） */
export interface MessageAttachment {
  id: string
  /** 附件类型：image=图片（多模态发送），file=普通文件（仅路径引用） */
  kind: 'image' | 'file'
  /** 显示名（文件名） */
  name: string
  /** MIME 类型，如 image/png、application/pdf */
  mimeType?: string
  /** 图片内容：客户端压缩后的 base64 data URL（仅 image 附件携带） */
  dataUrl?: string
  /** 磁盘绝对路径（剪贴板截图等无路径附件省略） */
  path?: string
  /** 文件体积（字节） */
  size?: number
}

/** 发送消息时选中的 Skill 快照；只保存展示与追溯所需字段，不携带 SKILL.md 正文 */
export interface MessageSkillSnapshot {
  id: string
  name: string
  icon?: string
  slug?: string
}

/**
 * 一次写文件成功后的「变更前快照」索引（对标 ZCode workspace checkpoint）。
 *
 * 正文不落消息，只落盘（userData/checkpoints/<sessionId>/<beforeRef>），
 * 消息里带这份索引就足够算出回滚计划：sql.js 是内存库 + 每次变更全量落盘，
 * 把几 MB 的文件正文塞进 data 列会让之后每一次写库都重写整个库文件。
 */
export interface FileCheckpoint {
  /** ck_<随机>，同时是磁盘 artifact 的文件名主干 */
  id: string
  toolCallId: string
  /** write_file | search_replace */
  toolName: string
  /** 绝对路径（已经过 loop 的 resolveToolPath 归一） */
  path: string
  /** 变更前该文件是否存在：false ⇒ 回滚动作是删除该文件 */
  existedBefore: boolean
  /** 变更前正文的落盘文件名；existedBefore 为 false 时是 null */
  beforeRef: string | null
  /**
   * 变更后正文的 sha256。回滚前拿当前文件哈希和它比：不等就是「用户手改过」，
   * 必须拒绝自动回滚（乐观并发检测）。读不到当前内容时是 'missing'。
   */
  afterHash: string
  /** 变更前正文字节数（GC 与统计用） */
  beforeBytes: number
  createdAt: number
}

/**
 * 本轮无法用快照回滚的文件改动数（execute_command / MCP / 未知副作用工具）。
 * 与 ZCode 的 ignoredFiles 同语义：非零就必须对「回滚文件」fail-closed。
 */
export interface FileMutationGap {
  toolName: string
  path?: string
  reason: 'shell' | 'untracked-tool' | 'oversized' | 'binary' | 'unreadable'
}

/**
 * 一次写文件工具调用成功后的变更事实。
 * `before` 必须是**写盘前的原始字节**（含 BOM 与原行尾），不是模型看到的归一化文本——
 * 回滚要还原的正是这个。
 */
export interface FileMutation {
  toolCallId: string
  toolName: string
  /** 绝对路径（loop 已按工作目录归一） */
  path: string
  existedBefore: boolean
  /** 变更前正文；existedBefore=false 时为 null */
  before: string | null
  /** 变更后正文 */
  after: string
}

/**
 * 回滚范围（对标 ZCode RewindScope）：
 * - conversation：只截断对话，文件保持现状（不可逆，撤回即真删）
 * - workspace：只把文件恢复原状，不动对话，并给模型补一条 notice
 * - both：先恢复文件再截断对话（编辑重发的「回滚文件」档走这条）
 */
export type RewindScope = 'conversation' | 'workspace' | 'both'

/** 回滚计划里的单个文件条目 */
export interface RewindPlanFile {
  path: string
  /** existedBefore=false ⇒ delete（本轮新建的文件直接删掉），否则写回变更前正文 */
  action: 'restore' | 'delete'
  checkpointId: string
  toolName: string
  /** 变更前正文的落盘引用；action=delete 时为 null（删除不需要读快照） */
  beforeRef: string | null
  /** 将被写回的字节数（delete 为 0） */
  bytes: number
  /** 不可自动应用的原因；只在 unsafe 条目上出现 */
  reason?: 'external_modified' | 'missing-snapshot' | 'unreadable'
  /** 快照记录的变更后哈希 vs 当前实际哈希，供界面说明「你手改过这个文件」 */
  expectedHash?: string
  currentHash?: string
}

/** dry-run 出来的回滚计划：canApply 是 all-or-nothing 的（照抄 ZCode） */
export interface RewindPlan {
  canApply: boolean
  safeFiles: RewindPlanFile[]
  unsafeFiles: RewindPlanFile[]
  gaps: FileMutationGap[]
  /** conversation/both 范围下会被删除的消息条数 */
  removedMessages: number
}

/** 回滚执行结果 */
export interface RewindOutcome {
  ok: boolean
  /**
   * 失败原因；ok=true 时省略。
   * truncate-failed 是半程状态：文件已经回滚、消息还在，必须让用户看见并自己核对。
   */
  error?: 'cancelled' | 'plan-blocked' | 'write-failed' | 'truncate-failed' | 'no-checkpoint' | 'session-busy'
  restored: Array<{ path: string; action: 'restore' | 'delete' }>
  /** 写入中途失败时按 journal 逆序补偿的结果 */
  compensated: boolean
  removedMessages: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  thinkingContent?: string
  timestamp: number
  /** 消息附件（图片/文件）；随消息持久化 */
  attachments?: MessageAttachment[]
  /** 发送该消息时选中的任务工作流（/spec /plan /goal）；随消息持久化，用于气泡内展示 */
  taskMode?: TaskMode
  /** 发送该消息时激活的 Skill 快照；随消息持久化，用于对应气泡内展示 */
  skills?: MessageSkillSnapshot[]
  /** AI 自主加载的技能快照（read_file 命中技能 SKILL.md 时由 agent 循环记录）；
   *  随助手消息持久化，用于气泡内"已加载技能"芯片展示 */
  loadedSkills?: MessageSkillSnapshot[]
  /** /goal 目标评估判定卡（system 消息专用；UI 渲染判定结果，不进入模型上下文） */
  goalEvent?: MessageGoalEvent
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  finishReason?: string
  usage?: TokenUsage
  collapsed?: boolean  // When true, this message is collapsed (hidden by default, expandable)
  isCompactSummary?: boolean  // Marks compact boundary/summary messages
  isCompactAttachment?: boolean  // Marks post-compaction file-restore messages (UI 折叠卡片渲染，非用户消息)
  compactMetadata?: CompactMetadata  // Metadata for compact boundary messages
  streamingToolCalls?: StreamingToolCall[]  // Tool calls currently being streamed (transient, not persisted)
  _isCompacting?: boolean  // Transient: true 表示该消息是"正在压缩上下文"的过程占位（不入库，压缩完成后被替换）
  _isStreaming?: boolean  // Transient: true while this message is being streamed from API
  _retrying?: { attempt: number }  // Transient: 请求失败后正在重试（第 attempt 次），用于 UI 展示
  subAgentId?: string        // 标记此消息属于哪个子 agent（主对话消息不带此字段）
  isSubAgentCard?: boolean   // 标记此消息是子 agent 卡片占位（用于 UI 渲染）
  /**
   * 本轮（该用户消息触发的整段运行，含子 agent）写文件前的快照索引；挂在用户消息上，
   * 因为撤回/编辑的截断点永远是用户消息边界，回滚单位也就是「这一轮」。
   */
  fileCheckpoints?: FileCheckpoint[]
  /** 本轮里无法回滚的改动（shell / 未跟踪工具 / 超限文件）；非空即禁止带文件回滚 */
  mutationGaps?: FileMutationGap[]
  /** 本轮的文件改动已被撤销：Undo 按钮与编辑的「回滚文件」档都要置灰（对标 fileChanges.state=reverted） */
  filesReverted?: boolean
  /**
   * 合成的「文件已撤销」回执。刻意用 user 角色承载：loop 会把历史里的 system 消息
   * 整条跳过（只保留最前面那条 system prompt），用 system 就传不到模型；
   * 而 UI 按这个标记把它渲染成居中的灰色回执条，不是用户气泡。
   */
  isRewindNotice?: boolean
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * 工具结果附带的图像观测（Browser Use / Computer Use 的截图）。
 *
 * 刻意只存**磁盘引用**而不是 base64：ToolResult 随消息一起落库（sqlite / JSON），
 * 一张 200KB 的截图存成 data URL 就足以让单个会话膨胀到不可接受。
 * 发请求前由 buildAPIMessages 按 path 读回并转成 data URL（带进程内 LRU，避免每轮重复读盘）。
 * 顺带的好处：用户点开路径就能看到模型当时看到的那一帧。
 */
export interface ToolResultImage {
  /** 绝对路径（~/.clerkbox/tmp/ 下的一次性产物） */
  path: string
  mimeType: string
  /** raster 像素宽高——坐标只对本帧有效，这是模型判断坐标是否越界的唯一依据 */
  width: number
  height: number
  /** true=全屏，false=区域截图 */
  fullScreen?: boolean
}

export interface ToolResult {
  toolCallId: string
  content: string
  isError?: boolean
  /** 视觉观测；协议层按 compat 翻译成 image block（OpenAI 侧展开为紧随其后的 user 图像消息） */
  images?: ToolResultImage[]
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

/** read_file 读取快照（工具层维护：staleness 检测 + 同区间重复读去重 + 压缩后文件恢复） */
export interface ReadFileSnapshot {
  content: string
  timestamp: number
  /** 上次 read_file 的分页参数（去重判定用：同路径同区间且内容未变 → 返回 stub） */
  lastOffset?: number
  lastLimit?: number
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

/**
 * Harness 模式：会话级一次选定、开始后锁定。
 * default = ClerkBox 内置 harness；其余为第三方官方 harness 兼容模式
 * （定义与内容见 src/lib/harness-modes.ts）。
 */
export type HarnessMode = 'default' | 'codex' | 'grok-build' | 'dsh' | 'dsh-minimal' | 'zcode'

export interface Session {
  id: string
  title: string
  workingDir?: string
  defaultWorkDir?: string  // Auto-generated if user doesn't pick a folder
  messages: Message[]
  createdAt: number
  updatedAt: number
  /** 本会话的 harness 模式；首条消息后锁定，旧数据缺省视为 default */
  harnessMode?: HarnessMode
}

/** 用户自定义模型（旧结构，仅用于迁移到 ModelProvider；UI 不再读取） */
export interface CustomModel {
  id: string
  /** 显示名，如 "DeepSeek V3" */
  label: string
  /** 模型 id，如 "deepseek-chat" */
  model: string
  baseUrl: string
  apiKey: string
}

/** API 协议兼容模式 */
export type ApiCompat = 'openai' | 'anthropic'

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max' | 'xhigh'

/** 思考档位规范顺序（从弱到强），UI 滑块与保存排序都以此为基准 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal', 'low', 'medium', 'high', 'max', 'xhigh',
]

/** 思考档位在请求体中的表达方式（协议相关，模型级声明） */
export type ThinkingStyle =
  | 'auto'     // 模型自行决定，无需额外参数（如 DeepSeek Reasoner）
  | 'effort'   // OpenAI reasoning_effort（如 OpenAI o 系）
  | 'enable'   // enable_thinking[+thinking_budget]（如 DashScope/Qwen）
  | 'glm'      // thinking:{type:enabled,clear_thinking:false}（智谱 GLM）
  | 'budget'   // Anthropic thinking:{type:enabled,budget_tokens}

/** 按 apiCompat / 预设推断默认思考风格 */
export const DEFAULT_THINKING_STYLE: Record<ApiCompat, ThinkingStyle> = {
  anthropic: 'budget',
  openai: 'enable',
}

/** 防止非法档位损坏状态：取最近的一个合法档位 */
export function normalizeEffort(v: unknown, fallback: ReasoningEffort = 'medium'): ReasoningEffort {
  return REASONING_EFFORTS.includes(v as ReasoningEffort) ? (v as ReasoningEffort) : fallback
}

/** 提供商下已启用的一个模型 */
export interface ProviderModel {
  /** 真实模型 id，如 "deepseek-chat" */
  id: string
  /** 用户自定义别名；空则展示 id */
  label?: string
  /** 是否支持思考；未设按全局开关兼容 */
  supportsThinking?: boolean
  /** 是否支持图片输入 */
  supportsImages?: boolean
  /** 思考在请求体里的表达方式（协议相关）；未设则按 apiCompat/预设推断 */
  thinkingStyle?: ThinkingStyle
  /** 该模型支持的思考档位，按顺序从弱到强 */
  reasoningEfforts?: ReasoningEffort[]
  /** 当前模型思考档位 */
  reasoningEffort?: ReasoningEffort
  /** 模型级 Temperature；未设则回退到全局默认 0.7 */
  temperature?: number
  /** 模型级输入上下文预算（token）；未设则回退到全局默认 184000 */
  maxInputTokens?: number
  /** 模型级输出 Max Tokens；未设则回退到全局默认 16000 */
  maxTokens?: number
}

/** 一个提供商 = 一套连接凭据 + 该平台下已启用的模型 */
export interface ModelProvider {
  id: string
  /** 显示名，如 "DeepSeek" */
  name: string
  /** 来自内置目录的哪一项；手填的为 undefined */
  presetId?: string
  /** 该提供商使用哪种 API 协议 */
  apiCompat: ApiCompat
  baseUrl: string
  apiKey: string
  /** 已启用（勾选进来）的模型 */
  models: ProviderModel[]
  /** true = 绕过主进程代理，渲染进程直连（排障退路） */
  directFetch?: boolean
  /** UI 折叠状态 */
  collapsed?: boolean
}

/**
 * 界面模式：coding=编程（展示命令、代码、diff 等技术细节）；
 * general=通用（呈现进度与结果摘要）。
 * 纯展示层偏好，不改变 Agent 权限与执行能力。
 */
export type InterfaceMode = 'coding' | 'general'

export interface AppSettings {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  /** 输入上下文预算（token），用于截断 / 压缩阈值 */
  maxInputTokens: number
  /** 输出 max_tokens */
  maxTokens: number
  theme: 'light' | 'dark' | 'system'
  /** 全局字体档位：default=出厂黑体系；serif=衬线（西文 Georgia、中文宋体系） */
  appFont: 'default' | 'serif'
  /** UI 字号缩放档位，1 = 基准 16px；由 applyUiScale 写入 --ui-font-size */
  uiScale?: number
  /** 色系：马卡龙预设 id 或 'custom' */
  colorScheme: string
  /** 自定义种子色（colorScheme 为 'custom' 时生效） */
  customSeedColor: string
  language: string
  /** 界面模式：编程/通用，决定问候语、占位符等技术细节的呈现粒度 */
  interfaceMode: InterfaceMode
  /** Agent 操作审批档位：manual=每个重要操作弹窗确认；auto=AI 审核并自动批准（系统目录写入仍确认）；full=无需询问直接执行 */
  approvalMode: 'manual' | 'auto' | 'full'
  enableThinking: boolean
  thinkingBudget?: number
  reasoningEffort?: ReasoningEffort
  /** 提供商列表（每个提供商持有连接凭据 + 已启用模型） */
  providers: ModelProvider[]
  /** 当前生效的提供商 id */
  activeProviderId?: string
  /** 当前生效的模型 id（在 activeProviderId 之下） */
  activeModelId?: string
  /** 派生字段：随激活的 provider 同步写入，供 use-agent / compact 直接读 */
  apiCompat: ApiCompat
  /** 派生字段：当前 provider 是否绕过主进程代理直连 */
  directFetch: boolean
  /** 旧结构，保留仅用于迁移；UI 不再读取 */
  customModels: CustomModel[]
  /** 旧结构，保留仅用于迁移 */
  activeCustomModelId?: string
  /** 迁移完成时间戳（存在即表示已迁移过，不再重复执行） */
  providersMigratedAt?: number
  /** 首次启动欢迎流程是否已完成（true = 不再展示） */
  hasCompletedOnboarding: boolean
  /** 是否注入工作目录下的 AGENTS.md 到系统提示词 */
  agentsMdEnabled: boolean
  /** 是否兼容读取 CLAUDE.md（AGENTS.md 不存在时回退） */
  claudeMdCompat: boolean
  /** WebUI 是否绑定 0.0.0.0 允许局域网访问（默认 false 仅本机 127.0.0.1） */
  webuiLanAccess: boolean
  /**
   * 是否允许 AI 驱动内置浏览器（Browser Use）。
   * 默认 false：它能让模型访问并操作网页，是外部输入面，必须由用户显式打开。
   */
  browserUseEnabled: boolean
  /**
   * 是否允许 AI 操控本机桌面（Computer Use）。
   * 默认 false：它合成的是用户真实桌面上的鼠标键盘事件，误操作代价最高的一档。
   */
  computerUseEnabled: boolean
  /** 窗口关闭按钮行为：tray=收进系统托盘继续后台运行（默认，AI/定时任务不中断）；quit=直接退出 */
  closeBehavior: 'tray' | 'quit'
  /** 托盘菜单"对话记录"最多展示几条（3~8） */
  recentSessionsLimit: number
  /** MCP 服务器列表（配置随设置持久化，连接由主进程 McpManager 管理） */
  mcpServers: McpServerConfig[]
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
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
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
