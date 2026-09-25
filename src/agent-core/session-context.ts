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
import type { ReadFileSnapshot, TaskMode } from '../types/agent'

export class SessionContext {
  readonly sessionId: string

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
