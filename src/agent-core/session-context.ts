/**
 * 会话级运行状态（批次 B · P1）
 *
 * 把 use-agent.ts 里按 sessionId 隔离的 ref Map（tokenTracker / readFiles /
 * memory 快照 / taskMode / 运行期工作目录）收拢为普通类字段：
 * - 渲染层宿主（P1）：hook 用 SessionContextStore 按 sessionId 惰性创建，
 *   同一 hook 实例切会话时旧会话上下文保留（后台 run 仍持有引用，行为与旧 Map 一致）；
 * - 主进程宿主（P3）：AgentSessionManager 直接持有同样的对象。
 */
import { TokenTracker } from '../lib/token-tracker'
import type { AgentDefinition, FileCheckpoint, FileMutationGap, Message, ReadFileSnapshot, SubAgentUsage, TaskMode } from '../types/agent'

/**
 * 子代理运行期记录（挂在 SessionContext 上）。
 *
 * 供三件事查址：send_message_to_agent 的三态投递、详情面板的 steering 注入、
 * 单子代理取消。record.messages 是最近一次循环结束时的完整对话 —— 续跑
 * （SendMessage 唤醒已完成 run）靠它重建上下文，进程内有效（与后台任务同边界）。
 */
export interface SubagentRunRecord {
  id: string
  agent: AgentDefinition
  controller: AbortController
  /** 运行中注入的指令（send_message_to_agent / 用户 steering），循环下一轮迭代顶部消费 */
  pendingMessages: string[]
  /** 最近一次循环的完整对话（续跑用；运行中由 wrapper 在收尾时回写） */
  messages: Message[]
  running: boolean
  /** 续聊代数：send_message_to_agent 唤醒已完成 run 时 +1（0=首轮） */
  continuations: number
  /** 最近一次运行的用量统计（前台结果回传的 <usage> 块与后台通知共用） */
  usage?: SubAgentUsage
}

export class SessionContext {
  readonly sessionId: string

  /**
   * 会话标题，供电脑操控浮层的副标题显示。
   *
   * 「AI 在动我的电脑」时，用户最需要知道的是**哪个对话**在动手，否则浮块就是个
   * 无从追责的全局提示。标题只在渲染层宿主里可得（主进程宿主留空），
   * 所以它是可选的 —— 拿不到就只显示动作，不显示副标题。
   */
  sessionTitle: string | undefined

  /** 每会话各自的用量锚点：切会话不清空（后台 run 不丢锚点） */
  readonly tokenTracker = new TokenTracker()

  /** read_file 读取快照（staleness 检测 + 去重 + 压缩后文件恢复）；压缩后被整体替换 */
  readFiles = new Map<string, ReadFileSnapshot>()

  /** 会话级冻结的记忆快照：前缀缓存要求 system 段字节一致，
   *  而 save_memory 会在会话中途改写记忆文件 → memoryPrompt 变化 → 动态段之后全部缓存作废。
   *  故同一会话（含 workingDir/homeDir）内只构建一次，新记忆下个会话生效（快照语义）。 */
  memorySnapshot: { key: string; prompt: string } | null = null

  /** dev 校验用：静态 system 段最近一次的 (来源, 哈希) */
  staticSystemHash: { origin: string; hash: string } | null = null

  /** 当前运行中的任务工作流模式（/spec /plan /goal，随 sendMessage 传入，run 结束清空）。
   *  挂在 context 而非参数透传：checkToolPermission 在工具执行深处读取，避免层层传参 */
  activeTaskMode: TaskMode | null = null

  /** 本次运行登记的工作目录（sendMessage 设置，finally 清除）；优先于会话持久值 */
  requestWorkingDir: string | undefined

  /**
   * 会话级能力放行：用户在审批弹窗里勾了「本会话始终允许」之后记在这里。
   *
   * 键是**能力级**（`agent-use:browser` / `agent-use:computer`），不是「工具 + 动作」级。
   * 差别的代价很具体：一次浏览任务是 navigate → snapshot → click → type → click 的循环，
   * 按动作级授权的话用户要点十几次「始终允许」，功能等于不存在。
   * 按能力级授权则整个任务只打扰一次。
   *
   * 生命周期与会话一致（切会话各管各的），不随单次 run 结束清空 —— 用户的语义是
   * 「这个会话里别再问我」，不是「这一轮别再问我」。
   */
  readonly grantedAgentActions = new Set<string>()

  /**
   * 会话级工作流放行：用户在工作流确认卡里选「本会话始终允许」后置位。
   *
   * 语义按**会话**而不是按脚本指纹：工作流脚本每轮都会被模型重写一遍，
   * 指纹级放行意味着用户点了「始终允许」还是每次都弹（踩过这个坑）。
   * 与 ZCode 的「本会话内运行工作流不再询问」同义。
   */
  workflowApproved = false

  // ── 多子代理编排状态 ──
  /**
   * 本会话的子代理运行记录（含运行中与已完成）。
   * send_message_to_agent / steering / 单取消都按 runId 在这里查址。
   * 容量上限：达到后淘汰最早的已完成记录（运行中的永不淘汰）。
   */
  readonly subagentRuns = new Map<string, SubagentRunRecord>()
  /**
   * 已完成后台子代理的待注入通知。主循环在每轮迭代顶部 drain（多条合并为一条
   * isSubAgentNotice 消息）；主循环空闲时留存，随下一条用户消息的新 run 注入。
   */
  readonly pendingSubagentNotifications: string[] = []

  // ── 消息撤回 / 改动回滚 ──
  /**
   * 本轮的撤回锚点：触发本次运行的用户消息 id。
   * 快照一律挂在它上面（含子 agent 的写操作），因为截断点永远是用户消息边界，
   * 「回滚这一轮的文件」与「撤回这一轮对话」才是同一个范围。
   */
  rewindAnchorMessageId: string | null = null
  /** 本次运行采集到的变更前快照，按发起顺序累积；每个工具批次结束后增量落到锚点消息上 */
  turnCheckpoints: FileCheckpoint[] = []
  /** 本次运行里无法回滚的改动（shell / 未跟踪工具 / 超限文件）；非空即禁止带文件的回滚 */
  turnGaps: FileMutationGap[] = []

  /** 开新一轮的采集账本：上一次运行的快照不能漏进这一轮的范围 */
  beginRewindTurn(anchorMessageId: string | null): void {
    this.rewindAnchorMessageId = anchorMessageId
    this.turnCheckpoints = []
    this.turnGaps = []
  }

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }
}

/** sessionId → SessionContext 的惰性注册表（清理由宿主负责：会话删除时 delete）。 */
export class SessionContextStore {
  private readonly contexts = new Map<string, SessionContext>()

  get(sessionId: string): SessionContext {
    let ctx = this.contexts.get(sessionId)
    if (!ctx) {
      ctx = new SessionContext(sessionId)
      this.contexts.set(sessionId, ctx)
    }
    return ctx
  }

  peek(sessionId: string): SessionContext | undefined {
    return this.contexts.get(sessionId)
  }

  delete(sessionId: string): void {
    this.contexts.delete(sessionId)
  }

  sessionIds(): string[] {
    return [...this.contexts.keys()]
  }
}

// ── 子代理控制注册表（进程内单例）──
//
// UI / 工具处理器要按 (sessionId, runId) 精确取消或注入某个子代理，而 AbortController
// 与 pendingMessages 都活在 loop 的闭包深处。注册表由 loop 在每次子代理 run 前后登记 /
// 注销；渲染层宿主与主进程宿主各持一份实例（各自进程内的 run 各自登记）。

const subagentControllers = new Map<string, AbortController>()
const subagentSteerSinks = new Map<string, (text: string) => boolean>()

const subagentControlKey = (sessionId: string, runId: string): string => `${sessionId}\u0000${runId}`

export function registerSubagentControl(
  sessionId: string,
  runId: string,
  control: { controller: AbortController; steer: (text: string) => boolean }
): void {
  const key = subagentControlKey(sessionId, runId)
  subagentControllers.set(key, control.controller)
  subagentSteerSinks.set(key, control.steer)
}

export function unregisterSubagentControl(sessionId: string, runId: string): void {
  const key = subagentControlKey(sessionId, runId)
  subagentControllers.delete(key)
  subagentSteerSinks.delete(key)
}

/** 单子代理取消（进程内路径）：返回 false 表示该 run 不在本进程运行 */
export function abortSubagentLocal(sessionId: string, runId: string): boolean {
  const controller = subagentControllers.get(subagentControlKey(sessionId, runId))
  if (!controller) return false
  controller.abort(new Error('stopped by user'))
  return true
}

/**
 * 向运行中的子代理注入指令（进程内路径）。返回 false = run 不在运行
 * （不存在或已终态），调用方走续跑分支。
 */
export function steerSubagentLocal(sessionId: string, runId: string, text: string): boolean {
  const steer = subagentSteerSinks.get(subagentControlKey(sessionId, runId))
  return steer ? steer(text) : false
}
