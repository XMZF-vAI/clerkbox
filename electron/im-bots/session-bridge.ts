/**
 * IM Bots 会话桥：把聊天对端的一条消息变成一次 ClerkBox 运行，再把结果送回聊天。
 *
 * 刻意不做 IM 专属会话存储——机器人用的就是桌面端那套 ChatStore + AgentSessionManager，
 * 于是手机上发的任务在桌面上看得见、能接着聊，反过来也一样。
 *
 * 全部外部能力经接口注入（BridgePorts）：本模块不 import electron，
 * 所以「draft→task 状态机」「忙时入队」「完成回推」都能在 vitest 里用假端口跑通。
 */
import type { AgentEvent } from '../../src/agent-core/protocol'
import type { SessionRow } from '../../src/types/ipc'
import type { UserQuestion } from '../../src/types/agent'
import { NEW_SESSION_TITLE } from '../../src/lib/chat-row'

/** 桥接层看得懂的会话行（其余字段原样透传，不做二次加工） */
export interface BridgeSessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  working_dir?: string | null
  default_work_dir?: string | null
  harness_mode?: string | null
}

export interface BridgeMessageRow {
  id: string
  role: string
  content: string
  timestamp: number
}

/** 桥会下发的两种宿主命令：联合类型而不是重载签名，方便 index.ts 用一个函数适配 */
export type BridgeCommand =
  | { type: 'run'; sessionId: string; content: string }
  | { type: 'queue.enqueue'; sessionId: string; item: { id: string; content: string; queuedAt: number } }

/** AgentSessionManager 的窄面：桥只用到这几项，不碰其余 20 个命令 */
export interface BridgeManagerPort {
  /**
   * run 不带 settings：由宿主回退到「本会话快照 → 本机最近一份本地快照」，
   * 见 agent-host.ts 的 lastLocalSettings。
   */
  handleCommand(cmd: BridgeCommand, meta: { remote: boolean }): Promise<{ ok: boolean; error?: string }>
  /** 运行态摘要：桥只用它判断「这个会话正在跑 / 排了几条」 */
  inspectSession(sessionId: string): { status: 'idle' | 'working' | 'awaiting'; queued: number; hasRun: boolean } | undefined
  /** 本机是否已有一份可用的模型配置（bot 冷启动提示的判据） */
  hasLocalSettingsSnapshot(): boolean
  /** 订阅宿主全量事件，返回取消函数 */
  subscribeEvents(handler: (payload: { seq: number; event: AgentEvent }) => void): () => void
}

export interface BridgeStorePort {
  createSession(row: BridgeSessionRow): Promise<void>
  getAllSessions(): Promise<SessionRow[]>
  getMessages(sessionId: string): Promise<BridgeMessageRow[]>
}

export interface BridgePorts {
  manager: BridgeManagerPort
  store: BridgeStorePort
  /** 生成 id：默认用时间戳+随机，测试里注入确定性实现 */
  makeId(): string
  /** 会话默认工作目录的生成规则（与渲染层同一口径：home/clerkbox-work/<时间戳>） */
  defaultWorkDir(now: number): string
  now(): number
  log(...args: unknown[]): void
}

/** 一条待批审批的可回答信息：id 用来回执，正文用来在手机上说清「要放行什么」 */
export interface ApprovalPrompt {
  requestId: string
  /** 已渲染好的命令 / 文件预览（宿主原文，不二次加工） */
  preview: string
  risk: 'dangerous' | 'normal'
  tool?: string
  workingDir?: string
}

/** 运行收尾的回推载荷：给谁、哪个会话、什么结局 */
/** 一条待答提问：与宿主 ports.ui.askQuestion 的 UserQuestion 同形 */
export interface QuestionPrompt {
  requestId: string
  items: UserQuestion[]
}

export interface RunOutcome {
  sessionId: string
  /**
   * completed / aborted = 本轮跑完（取答案回推）；
   * awaiting = 撞上了审批挂起。awaiting 一定带 approval：手机上要照着它问用户「确定 / 拒绝」，
   * 只有 sessionId 是没法让人做决定的。
   * question = 模型在等一道选择题的回答。它和审批同一条道理：老板要求「所有要批准的都这么干」，
   * 而宿主对提问有 10 分钟计时，人在手机上不答就会收到一个空答案继续往下跑。
   */
  kind: 'completed' | 'aborted' | 'awaiting' | 'question'
  approval?: ApprovalPrompt
  question?: QuestionPrompt
  /** 该会话当前绑定到的聊天身份（可能没有：桌面自己跑的会话） */
  actorKeys: string[]
}

/** 一次投递请求：core 负责拼文本，桥负责分段与脱敏后交给 outbound */
export interface DispatchResult {
  ok: boolean
  /** 'missing-settings' = 桌面还没初始化过模型配置 */
  error?: 'missing-settings' | 'run-rejected'
}

/** 长回复的分段上限：微信单条上限约 4000，留足余量；飞书文本消息也在这个量级以下更稳 */
export const OUTBOUND_CHUNK_CHARS = 3500

/**
 * 宿主缺失 settings 的错误码（agent-host.ts 的 MISSING_SETTINGS）。
 * 字符串对齐而不是 import：那个常量是私有的，而这里必须区分「配置缺失」与「其它失败」。
 */
const MISSING_SETTINGS = 'run-command-missing-settings'

export class SessionBridge {
  /** sessionId → 正在等结果的聊天身份集合（谁把这个会话当当前任务，结果就推给谁） */
  private readonly watchers = new Map<string, Set<string>>()
  /** 已通知过「等待审批」的 requestId：宿主重连会重复广播同一条未决审批 */
  private readonly notifiedApprovals = new Set<string>()
  /** 已通知过「等待回答」的 requestId，同上 */
  private readonly notifiedQuestions = new Set<string>()
  private unsubscribe: (() => void) | null = null
  private onOutcome: ((outcome: RunOutcome) => Promise<void> | void) | null = null
  /** 正在脱敏时要一并抹掉的明文（bot 凭据、当前 apiKey） */
  private secretProvider: () => string[] = () => []

  constructor(private readonly ports: BridgePorts) {}

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /**
   * 开始观察运行收尾。core 在 initImBots 时注册一次即可；
   * 重复调用只换回调，不会把订阅叠成两层（叠了就会一条结果发两遍）。
   */
  watchRuns(onOutcome: (outcome: RunOutcome) => Promise<void> | void): void {
    this.onOutcome = onOutcome
    if (this.unsubscribe) return
    this.unsubscribe = this.ports.manager.subscribeEvents((payload) => {
      void this.handleEvent(payload.event).catch((error) => {
        this.ports.log('[im-bots] outcome handler failed:', error)
      })
    })
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.watchers.clear()
  }

  /**
   * 事件 → 回推时机。
   *
   * 终态只认 run.completed / run.aborted 两条，**刻意不用 run.status(idle)**：
   * setStatus 端口把渲染层的 SessionStatus 三态映射过来时，'idle' 是兜底分支
   * （agent-host.ts 的 setStatus：非 working / 非 confirm-danger 一律写 idle），
   * 运行中途完全可能广播出一条 idle。把它当收尾就会在任务还在跑的时候
   * 先推一份残缺的「结果」到手机上——这类 bug 最难查，因为它看起来像成功。
   * 而 startRun 的 finally 里两条终态事件必然各发其一，够用且不重。
   *
   * 等审批用 permission.requested 而不是 run.status('awaiting')：前者带 requestId，
   * 能靠它去重。宿主在渲染层重连（snapshot 回放）时会把未决审批**重新广播一遍**，
   * 不去重就会每按一次 F5 给手机多发一条催促。
   */
  private async handleEvent(event: AgentEvent): Promise<void> {
    if (event.type === 'permission.requested') {
      if (this.notifiedApprovals.has(event.requestId)) return
      this.notifiedApprovals.add(event.requestId)
      if (!this.onOutcome) return
      const actorKeys = [...(this.watchers.get(event.sessionId) ?? [])]
      // 没人等这个会话（桌面自己点的运行）就不催，否则用户在电脑上批一个命令手机就响一次
      if (actorKeys.length === 0) return
      // 等审批不清 watcher：这轮还没结束，批完仍要回推结果
      await this.onOutcome({
        sessionId: event.sessionId,
        kind: 'awaiting',
        approval: {
          requestId: event.requestId,
          preview: event.preview,
          risk: event.risk,
          ...(event.tool ? { tool: event.tool } : {}),
          ...(event.workingDir ? { workingDir: event.workingDir } : {}),
        },
        actorKeys,
      })
      return
    }
    if (event.type === 'permission.settled') {
      // 收尾即放手：同一个 requestId 理论上不会再回来，但留着会永远占内存
      this.notifiedApprovals.delete(event.requestId)
      return
    }
    /**
     * 提问（ask_user 这类要用户点选的）与审批同一条路：宿主那边有 10 分钟计时，
     * 手机上不理它就会拿着「空答案」继续跑，产出一个没人认领的结果。
     * 载荷里的 question 是 unknown（协议为了不把渲染层类型拉进事件通道），
     * 这里按 UserQuestion[] 的形状筛一遍再用，形状不符就退回「请回电脑端」的旧行为。
     */
    if (event.type === 'question.requested') {
      const items = normalizeQuestions(event.question)
      if (items.length === 0) return
      if (this.notifiedQuestions.has(event.requestId)) return
      this.notifiedQuestions.add(event.requestId)
      if (!this.onOutcome) return
      const actorKeys = [...(this.watchers.get(event.sessionId) ?? [])]
      if (actorKeys.length === 0) return
      await this.onOutcome({
        sessionId: event.sessionId,
        kind: 'question',
        question: { requestId: event.requestId, items },
        actorKeys,
      })
      return
    }
    if (event.type !== 'run.completed' && event.type !== 'run.aborted') return
    const sessionId = event.sessionId
    const actorKeys = [...(this.watchers.get(sessionId) ?? [])]
    for (const item of [...this.notifiedApprovals]) this.notifiedApprovals.delete(item)
    if (!this.onOutcome || actorKeys.length === 0) return
    /**
     * 关注关系不在这里清除。
     *
     * 「一次终态就解除登记」看着能防刷屏，实际会把排队的那条坑死：
     * 用户发了 msg1（开始跑）又发 msg2（进队列）→ msg1 收尾时整表被清 →
     * 宿主 flushQueue 把 msg2 跑完，已经没人等着了，手机上看到的是
     * 「消息发出去了、第二件事永远没回音」。
     * 「还在等这个会话」的唯一事实来源是聊天上下文（mode=task 且 activeSessionId 指向它），
     * 所以解除登记交给上层按上下文判定：/new、/task 切走、解绑、会话删除时才真的不看。
     */
    await this.onOutcome({ sessionId, kind: event.type === 'run.aborted' ? 'aborted' : 'completed', actorKeys })
  }

  // ── 会话创建与运行 ────────────────────────────────────────────────────────

  /**
   * 为一次 bot 任务新建会话行。
   *
   * 为什么要桥自己建行而不是靠 db 的自愈补建：自愈出来的行没有 working_dir，
   * 而宿主 startRun 是先 refreshSession 再把 session.workingDir 塞进上下文——
   * 行不存在或字段为空，机器人跑的就不是用户绑定的那个目录。
   *
   * default_work_dir 与 working_dir 同值（规格 §4.1）：那一列的语义是「这个会话最初落在哪」，
   * 曾经这里填的是新生成的 clerkbox-work/<时间戳> 空目录，于是「机器人开的会话」在桌面上
   * 看起来像是还没选过目录的新会话，用户选过一次之后就没法再回到绑定的那个目录。
   */
  async createSessionForActor(workDir: string | undefined): Promise<{ sessionId: string; workDir: string }> {
    const now = this.ports.now()
    const id = this.ports.makeId()
    const resolved = workDir?.trim() || this.ports.defaultWorkDir(now)
    await this.ports.store.createSession({
      id,
      // 标题留「新会话」：首条用户消息由宿主的 persistMessage 派生真标题（两侧同一函数，不会长第二套规则）
      title: NEW_SESSION_TITLE,
      created_at: now,
      updated_at: now,
      working_dir: resolved,
      default_work_dir: resolved,
    })
    return { sessionId: id, workDir: resolved }
  }

  /** 该会话是否正在跑（桥的唯一忙闲判据来自宿主，避免自己数事件） */
  isBusy(sessionId: string): boolean {
    const snap = this.ports.manager.inspectSession(sessionId)
    return Boolean(snap?.hasRun)
  }

  /** 排队条数（/status 用） */
  queuedCount(sessionId: string): number {
    return this.ports.manager.inspectSession(sessionId)?.queued ?? 0
  }

  /**
   * 发消息 / 忙时入队。
   *
   * 两条路径都登记 watcher：入队的那条最终也会被 flushQueue 发出去，
   * 不登记就会出现「手机上排队了、跑完没人吭声」。
   * remote 恒为 false：bot 在主进程内，输入已经过绑定白名单，等同本地用户操作；
   * 但它不携带 settings，靠宿主的 lastLocalSettings 回退拿上游配置。
   */
  async dispatch(sessionId: string, actorKey: string, content: string): Promise<DispatchResult> {
    // 前置判空而不是等宿主回 MISSING_SETTINGS：后者也要能走通（宿主是唯一权威），
    // 但先挡一道能让「请先在桌面完成一次对话」这句话在第一轮就发出去，
    // 而不是让用户看到一条被拒的 run。
    if (!this.ports.manager.hasLocalSettingsSnapshot()) return { ok: false, error: 'missing-settings' }
    this.addWatcher(sessionId, actorKey)
    if (this.isBusy(sessionId)) {
      const result = await this.ports.manager.handleCommand(
        {
          type: 'queue.enqueue',
          sessionId,
          item: { id: this.ports.makeId(), content, queuedAt: this.ports.now() },
        },
        { remote: false }
      )
      return result.ok ? { ok: true } : { ok: false, error: 'run-rejected' }
    }
    const result = await this.ports.manager.handleCommand(
      { type: 'run', sessionId, content },
      { remote: false }
    )
    if (result.error === MISSING_SETTINGS) {
      this.removeWatcher(sessionId, actorKey)
      return { ok: false, error: 'missing-settings' }
    }
    if (!result.ok) {
      this.removeWatcher(sessionId, actorKey)
      return { ok: false, error: 'run-rejected' }
    }
    return { ok: true }
  }

  private addWatcher(sessionId: string, actorKey: string): void {
    const set = this.watchers.get(sessionId) ?? new Set<string>()
    set.add(actorKey)
    this.watchers.set(sessionId, set)
  }

  private removeWatcher(sessionId: string, actorKey: string): void {
    const set = this.watchers.get(sessionId)
    if (!set) return
    set.delete(actorKey)
    if (set.size === 0) this.watchers.delete(sessionId)
  }

  /**
   * 会话被桌面或 bot 切走 / 删掉时清掉关注关系。
   * 不清的话一次删除会让 watcher 表长期挂着死会话。
   */
  unwatchSession(sessionId: string): void {
    this.watchers.delete(sessionId)
  }

  /** bot 用 /task 把当前任务切到某个已有会话后，也要能被这个身份收到结果 */
  watch(sessionId: string, actorKey: string): void {
    this.addWatcher(sessionId, actorKey)
  }

  unwatch(sessionId: string, actorKey: string): void {
    this.removeWatcher(sessionId, actorKey)
  }

  // ── 会话选择 ──────────────────────────────────────────────────────────────

  /**
   * 某工作目录下最近的会话（/task 的候选列表）。
   * 按 updated_at 倒序取前 limit 条——与侧栏看到的顺序一致，用户在手机上认得出同一个标题。
   * 匹配是**前缀**语义而非全等：/workspace 折叠出的目录族根（如 clerkbox-work）
   * 必须能把根下的会话整批捞出来，否则折叠就失去了意义。
   */
  async recentSessionsIn(workDir: string, limit = 10): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    const rows = await this.ports.store.getAllSessions()
    const wanted = normalizeDir(workDir)
    // normalizeDir 只给根目录保留尾斜杠；根目录的前缀本身就是 '/'
    const prefix = wanted === '/' ? '/' : wanted + '/'
    return rows
      .filter((row) => {
        const dir = normalizeDir(effectiveWorkDir(row))
        if (!dir) return false
        return dir === wanted || dir.startsWith(prefix)
      })
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, limit)
      .map((row) => ({ id: row.id, title: row.title || NEW_SESSION_TITLE, updatedAt: row.updated_at }))
  }

  /**
   * 出现过的 distinct 工作目录（/workspace 的候选列表）。
   * 空目录跳过；保序 = 首次出现顺序，配合机器人侧「最近 10 个会话」的窗口，
   * 列表不会长成一屏历史垃圾。
   * 默认目录家族折叠成一个根（collapseDefaultDir）：一个用了几个月的账号里
   * clerkbox-work/<时间戳> 会有几十个，逐个列出来就是把真正要选的项目挤出前十。
   */
  async distinctWorkDirs(limit = 10): Promise<string[]> {
    const rows = await this.ports.store.getAllSessions()
    const seen: string[] = []
    const seenKeys = new Set<string>()
    for (const row of [...rows].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))) {
      const raw = collapseDefaultDir(effectiveWorkDir(row))
      if (!raw) continue
      const key = normalizeDir(raw)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      seen.push(raw)
      if (seen.length >= limit) break
    }
    return seen
  }

  /** 会话是否真的存在且可读（/task 选完之后的复核，以及 /status 的标题来源） */
  async findSession(sessionId: string): Promise<{ id: string; title: string; workingDir?: string } | null> {
    const rows = await this.ports.store.getAllSessions()
    const row = rows.find((item) => item.id === sessionId)
    if (!row) return null
    return { id: row.id, title: row.title || NEW_SESSION_TITLE, workingDir: row.working_dir || undefined }
  }

  // ── 结果取回与投递 ────────────────────────────────────────────────────────

  /** 注册需要参与脱敏的明文（凭据、apiKey）；由 index.ts 在配置变化时刷新 */
  setSecretsProvider(provider: () => string[]): void {
    this.secretProvider = provider
  }

  /**
   * 取本轮答案：尾部最近一条有正文的 assistant 消息。
   *
   * 为什么取「尾部」而不是拼全部：宿主模式下一条回复会在流式结束时整体落库，
   * 尾部那条就是用户看到的最终答案；拼全部会把多轮工具循环的中间旁白一起发出去。
   * 跳过空 content 的占位/纯工具消息，否则会回一条空白给对方。
   */
  async latestAnswer(sessionId: string): Promise<string> {
    const messages = await this.ports.store.getMessages(sessionId)
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i]
      if (!item || item.role !== 'assistant') continue
      const text = (item.content ?? '').trim()
      if (text) return text
    }
    return ''
  }

  /**
   * 回推前的清洗：脱敏 → 分段。
   * 分段独立成方法是为了能被单测直接喂超长文本，而不必先造一个跑完的会话。
   */
  prepareOutbound(text: string): string[] {
    return splitMessage(redactSecrets(text, this.secretProvider()), OUTBOUND_CHUNK_CHARS)
  }
}

/**
 * 把宿主事件里 unknown 形状的提问筛成可用的 UserQuestion[]。
 * 只认「有 id、有 question、options 里至少一项有 label」的条目：缺任何一样都没法在手机上
 * 画出一道能回答的选择题，与其猜一个答案格式，不如让上层退回「请回电脑端」的兜底文案。
 */
export function normalizeQuestions(raw: unknown): UserQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: UserQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : ''
    const question = typeof record.question === 'string' ? record.question : ''
    const options = Array.isArray(record.options)
      ? record.options
          .map((option) => {
            if (!option || typeof option !== 'object') return null
            const entry = option as Record<string, unknown>
            const label = typeof entry.label === 'string' ? entry.label : ''
            if (!label) return null
            return { label, description: typeof entry.description === 'string' ? entry.description : '' }
          })
          .filter((option): option is { label: string; description: string } => option !== null)
      : []
    if (!id || !question || options.length === 0) continue
    out.push({ id, question, options, header: typeof record.header === 'string' ? record.header : '' })
  }
  return out
}

/**
 * Windows 与 POSIX 的分隔符差异、盘符大小写都不能影响「同一个目录」的判定。
 *
 * 根目录必须保留成 '/'：曾经 '/' 被尾斜杠清理吞成 ''，而 '' 在本模块里代表
 * 「没有目录」——两者一混，一条 working_dir 为空的会话就能匹配上 '/' 的查询，
 * /task 的清单会捞出完全不相干的项目。
 */
export function normalizeDir(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const unified = trimmed.replace(/\\/g, '/')
  const stripped = unified.replace(/\/+$/, '')
  const normalized = stripped === '' ? '/' : stripped
  // 只对小写不敏感的文件系统形态（盘符、UNC 前缀）折叠大小写
  return /^[a-z]:(\/|$)/i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}

/**
 * 会话的「生效目录」：working_dir 优先，为空回退 default_work_dir。
 *
 * 为什么必须回退：目录功能上线之前建的老会话普遍只有 default_work_dir
 * （真实库里的分布是 3 : 42）——bot 清单若只认 working_dir，用户的几十上百个
 * 历史会话在 /workspace /task 里就是「什么都没有」，而他明明天天在用。
 */
export function effectiveWorkDir(row: { working_dir?: string | null; default_work_dir?: string | null }): string {
  return (row.working_dir ?? '').trim() || (row.default_work_dir ?? '').trim() || ''
}

/** CB 自动生成兜底目录的基名形如 20261003-200317（见 defaultWorkDirFor） */
const DEFAULT_STAMP_BASENAME = /^\d{8}-\d{6}$/

/**
 * 兜底目录家族折叠：自动生成的默认目录是 <home>/clerkbox-work/<时间戳>，
 * 一个用了几个月的账号会有几十个——逐个列进 /workspace 候选就是把真正要选的
 * 项目挤出前十。基名是时间戳的目录折叠成它的父目录（家族共同根），
 * /task 在根上用前缀匹配照样能捞到整批会话。
 */
export function collapseDefaultDir(dir: string): string {
  const trimmed = dir.trim()
  if (!trimmed) return dir
  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed
  if (!DEFAULT_STAMP_BASENAME.test(basename)) return dir
  // 折叠结果保留原分隔符：ctx.workDir 会原样出现在 /status 与界面上，
  // 用户自己的路径风格不该被悄悄改写
  return lastSlash > 0 ? trimmed.slice(0, lastSlash) : dir
}

/**
 * 长文本分段：优先在空行处断，其次换行，最后才硬切。
 * 手机上「半句被截断」比「多收到一条消息」难受得多。
 */
export function splitMessage(text: string, limit: number): string[] {
  const clean = text.replace(/\r\n/g, '\n')
  if (clean.length <= limit) return clean.length > 0 ? [clean] : []
  const out: string[] = []
  let rest = clean
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cutAt =
      lastBoundary(window, '\n\n') ??
      lastBoundary(window, '\n') ??
      lastBoundary(window, ' ') ??
      limit
    const piece = rest.slice(0, cutAt).trimEnd()
    if (piece) out.push(piece)
    rest = rest.slice(cutAt).replace(/^\s+/, '')
  }
  if (rest.trim()) out.push(rest)
  return out
}

function lastBoundary(window: string, marker: string): number | null {
  // 只用后半段的断点：为了省几个字符把切点放到开头，等于让每段都只写了一半
  const at = window.lastIndexOf(marker)
  if (at <= Math.floor(window.length / 2)) return null
  return at + marker.length
}

/**
 * 敏感值清洗：两道。
 * 1) 已知明文（bot 凭据、当前 apiKey）逐一替换——这是主力，因为泄漏路径基本都是
 *    agent 把配置读给用户看；
 * 2) 常见密钥形态兜底（sk-… / ghp_… / Bearer … / JWT 三段式），防的是用户自己的仓库里
 *    粘了 Key、agent 又原样复述出来的情形。
 * 抹成 *** 而不是删掉：删了会让「这里本来有个什么」在上下文里凭空消失，排查时更懵。
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    const value = (secret ?? '').trim()
    if (value.length < 8) continue // 短于 8 位的串当密钥替换只会误伤正文
    out = out.split(value).join('***')
  }
  return out
    .replace(/\b(sk|pk|api[_-]?key|token|secret)[_-][A-Za-z0-9_-]{12,}\b/gi, '$1_***')
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, 'sk-***')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer ***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***jwt***')
}
