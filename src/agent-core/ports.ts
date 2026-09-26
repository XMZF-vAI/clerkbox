/**
 * Agent 端口定义（批次 B · P1）
 *
 * agent-core 的全部环境依赖都从这里注入：渲染层宿主（use-agent.ts）与未来的
 * 主进程宿主（electron/agent-host.ts，P3）装配同一套接口驱动同一个 loop。
 *
 * 语义约定：
 * - settings 是「运行开始时」的快照（与旧实现 sendMessage 闭包捕获一致）；
 * - store/goal/skills 等端口方法在每次调用时读取最新状态（不得缓存）；
 * - core 不得 import react / zustand stores / ipc-client / api-transport。
 */
import type { AnthropicThinkingBlock, NeutralMessage } from '../lib/api-adapters'
import type { SkillCatalogEntry } from '../lib/skill-catalog'
import type { ToolContext } from '../lib/tool-registry'
import type { SessionStatus } from '../stores/chat-store'
import type {
  AgentDefinition,
  AppSettings,
  HarnessMode,
  Message,
  ReadFileSnapshot,
  Session,
  SessionGoal,
  SubAgentRun,
  TodoItem,
  TokenUsage,
  ToolDefinition,
  UserQuestion,
} from '../types/agent'
import type { AgentEvent } from './protocol'

/** loop 运行所需的设置快照（= useAgent 订阅的字段子集） */
export type AgentSettings = Pick<
  AppSettings,
  | 'model' | 'apiCompat' | 'activeProviderId' | 'activeModelId' | 'providers'
  | 'temperature' | 'maxTokens' | 'reasoningEffort' | 'enableThinking' | 'thinkingBudget'
  | 'approvalMode' | 'baseUrl' | 'apiKey' | 'directFetch' | 'maxInputTokens'
  | 'agentsMdEnabled' | 'claudeMdCompat'
>

/** 模型流式调用：装配层负责 openChatStream（或 P3 主进程内直调 api-proxy）与传输配置。 */
export interface AgentModelPort {
  stream(body: unknown, signal: AbortSignal): Promise<AsyncIterable<string>>
}

/** 工具注册表（P1 桥接渲染层 tool-registry 单例；P3 评估整体迁入主进程）。 */
export interface AgentToolPort {
  definitions(harnessMode: HarnessMode): ToolDefinition[]
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string>
  findAgent(agentType: string, workingDir: string): Promise<AgentDefinition | null>
}

/** 消息与运行状态的存取（装配 chat-store；P3 改为宿主直调 ChatStore SQLite）。 */
export interface AgentStorePort {
  getSession(sessionId: string): Session | undefined
  addMessage(sessionId: string, msg: Message): void
  updateMessage(sessionId: string, msgId: string, updates: Partial<Message>): void
  setStatus(sessionId: string, status: SessionStatus | null): void
  /** 压缩后原子替换会话消息（UI/DB 保留全量历史，压缩组件插在压缩点） */
  compact(sessionId: string, messages: Message[], boundaryMessageId: string): void
}

/**
 * 需要人工确认的四种场景。UI 侧据此选文案与风险档，宿主据此决定是否进会话级放行集合。
 * 语义与 loop 里的分支一一对应，不额外放宽任何拦截。
 */
export type PermissionReason = 'dangerous-command' | 'outside-cwd' | 'system-dir' | 'outside-write'

/**
 * 审批请求的结构化入参。
 *
 * 原先这里只有一对已渲染好的 title/body 字符串：主进程宿主拿不到 tool/args，
 * 界面就只能显示一段纯文本、也无法给出「本会话允许」的匹配键，
 * 于是 main 模式的危险操作实际无人能批（120s 后 fail-closed 拒绝）。
 */
export interface AgentPermissionRequest {
  tool: string
  args: Record<string, unknown>
  reason: PermissionReason
  /** loop 侧已解析好的工作目录：预览的目标路径必须与它判定过的同一个值 */
  workingDir: string
  /** 危险命令 / 系统目录 = dangerous，越界写入 / 越界执行 = normal */
  risk: 'dangerous' | 'normal'
  /** 渲染层与原生对话框共用的文案（同一套 i18n，两种模式观感一致） */
  title: string
  body: string
}

/** 权限审批（P1 = Electron 原生确认框；P3 起宿主侧 fail-closed：超时/UI 离线默认拒绝）。 */
export interface AgentPermissionPort {
  confirm(request: AgentPermissionRequest): Promise<boolean>
}

/** UI 耦合回执：提问/待办/通知/用量统计/子 agent 运行态/记忆捕获。 */
export interface AgentUiPort {
  askQuestion(sessionId: string, questions: UserQuestion[]): Promise<Record<string, string[]>>
  setTodos(sessionId: string, items: TodoItem[]): void
  notify(sessionId: string, kind: 'error' | 'done' | 'confirm-danger', message?: string): void
  recordUsage(entry: { usage: TokenUsage; sessionId: string; model: string; providerId?: string }): void
  agentMemoryCapture(payload: {
    sessionId: string
    workingDir: string
    messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string }>
  }): Promise<void>
  addSubAgentRun(sessionId: string, run: SubAgentRun): void
  appendSubAgentMessage(sessionId: string, runId: string, msg: Message): void
  updateSubAgentMessage(sessionId: string, runId: string, msgId: string, updates: Partial<Message>): void
  completeSubAgentRun(sessionId: string, runId: string, result: string): void
  abortSubAgentRun(sessionId: string, runId: string): void
  failSubAgentRun(sessionId: string, runId: string, error: string): void
}

/** Goal 工作流（会话级目标，跨消息持续生效）。 */
export interface AgentGoalPort {
  get(sessionId: string): SessionGoal | undefined
  setGoal(sessionId: string, condition: string): void
  updateGoal(sessionId: string, patch: Partial<SessionGoal>): void
}

/** 技能目录（全量已安装技能，含未激活项）。 */
export interface AgentSkillsPort {
  catalog(): SkillCatalogEntry[]
}

/** 进程环境（渲染层由 navigator/window 提供；主进程由 os 模块提供）。 */
export interface AgentEnvPort {
  platform: string
  osDescription: string
  shellDescription: string
  /**
   * 开发态标记。由宿主注入而非 import.meta.env.DEV：agent-core 同时要能被
   * CommonJS 目标（electron 主进程）编译，import.meta 在该目标下是语法错误。
   */
  isDev: boolean
  homeDir(): string
  readFile(path: string): Promise<string>
  /** git 仓库探测专用（execute_commandWithShell 语义：exitCode + stdout） */
  runShell(command: string, cwd: string): Promise<{ exitCode: number; stdout: string }>
  buildMemoryPrompt(workingDir: string, homeDir: string): Promise<string>
}

/** agent-core 的完整依赖束。 */
export interface AgentPorts {
  sessionId: string
  settings: AgentSettings
  model: AgentModelPort
  tools: AgentToolPort
  store: AgentStorePort
  permission: AgentPermissionPort
  ui: AgentUiPort
  goal: AgentGoalPort
  skills: AgentSkillsPort
  env: AgentEnvPort
  /** 事件出口：P1 渲染层宿主为 no-op；P3 起接 'agent:event' 通道（带 seq）。 */
  emit(event: AgentEvent): void
}

/** loop 内部模型调用参数（与旧 callAPI opts 对齐）。 */
export interface ModelCallOptions {
  modelOverride?: string
  thinkingBlocks?: Map<string, AnthropicThinkingBlock[]>
  /** 本会话锁定的 harness 模式：决定传给模型的内置工具集/描述（子 agent 与评估器不传，走 default） */
  harnessMode?: HarnessMode
}

export type { NeutralMessage }
