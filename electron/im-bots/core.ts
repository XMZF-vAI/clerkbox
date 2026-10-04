/**
 * IM Bots 入站路由：绑定检查 → 命令 → 普通消息状态机。
 *
 * 语义对齐 ZCode，一处刻意不同：**忙时入队而不是拒收**（ClerkBox 宿主本来就有 FIFO 队列
 * 与渲染层排队 UI，手机上追加需求被一句「正在忙」打回是最没道理的失败）。
 *
 * 本模块不 import electron、不 import i18n：文案经 ports.text(key, vars) 取，
 * 于是状态机能被 vitest 用一份假文案表跑完（测试里断言 key 而不是断言中文字，
 * 改文案不会连带改测试）。
 */
import {
  makeActorKey,
  type BotChatType,
  type BotConfig,
  type BotProvider,
  type InboundMessage,
} from './types'
import type { UserQuestion } from '../../src/types/agent'
import { deriveSessionTitle } from '../../src/lib/chat-row'
import type { BotsStorage } from './storage'
import type { RunOutcome, SessionBridge } from './session-bridge'

/** 一次出站投递：core 只知道「发给谁」，用哪条通道由 index.ts 解析 */
export interface DeliverInput {
  botId: string
  provider: BotProvider
  providerUserId: string
  contextToken?: string
  text: string
}

/** 待序号选择的挂问（/workspace、/task 列完之后的那一条数字回复） */
interface PendingChoice {
  kind: 'workspace' | 'task'
  /** 序号 → 目标值（目录路径或会话 id） */
  options: string[]
  askedAt: number
}

/** 一条正在等 IM 答复的审批 */
interface PendingApproval {
  sessionId: string
  requestId: string
  askedAt: number
  /** 上次向宿主续时的时刻：避免每条闲聊都去戳一次宿主 */
  lastExtendedAt: number
}

/** 一条正在等 IM 答复的提问（ask_user 那道选择题） */
interface PendingQuestion {
  sessionId: string
  requestId: string
  items: UserQuestion[]
}

const APPROVE_WORDS = ['确定', '确认', '同意', '批准', '可以', 'yes', 'y', 'ok', 'approve'] as const
const DENY_WORDS = ['拒绝', '不同意', '不行', '不准', '取消', '否', 'no', 'n', 'deny'] as const

/** 审批续时的最小间隔：一分钟内不重复戳宿主 */
const APPROVAL_EXTEND_MIN_INTERVAL_MS = 60_000

/**
 * 把一条消息判成审批答复：命中 APPROVE / DENY 词表才算，其余一律不是答复。
 *
 * 只做「整句等于」而不做包含：「我不确定这样对不对」里同时有「确定」和「不对」，
 * 按包含匹配就会替用户点一次同意——审批这种决定不能靠猜。
 * 尾部标点与大小写归一是安全的（不改变词本身），所以先剥掉。
 */
export function parseApprovalAnswer(text: string): 'approve' | 'deny' | null {
  const normalized = (text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s。.!！?？～~、；;：:]+$/g, '')
    .replace(/^[\s。.!！?？～~、；;：:]+/g, '')
  if (!normalized) return null
  if ((APPROVE_WORDS as readonly string[]).includes(normalized)) return 'approve'
  if ((DENY_WORDS as readonly string[]).includes(normalized)) return 'deny'
  return null
}

/**
 * 把一条消息判成提问的答复：只有纯序号串才算（'2'、'1,3'、'1 3'、'1、2'）。
 * 返回按题序切好的序号数组，由调用方映射成选项 label；任何非序号内容都不是答复，
 * 免得用户在手机上正常聊两句就被吞成一次作答。
 */
export function parseQuestionAnswer(text: string, questionCount: number): number[] | null {
  const normalized = (text ?? '').trim()
  if (!normalized) return null
  if (!/^[\d\s,，、;；.。]+$/.test(normalized)) return null
  const picked = (normalized.match(/\d+/g) ?? []).map((value) => Number(value))
  if (picked.length === 0 || picked.some((value) => !Number.isFinite(value) || value < 1)) return null
  // 一题时允许多选；多题时按题序各取一个，多余的序号是噪声，直接忽略而不是判成无效
  if (questionCount === 1) return picked
  return picked.slice(0, questionCount)
}

/**
 * 路由用到的桥面。
 * 用 Pick 而不是重新声明一份接口：SessionBridge 是唯一实现，接口写两遍必然长出第二套真相；
 * Pick 过的类型不带私有成员，因此单测能用假桥跑完整状态机。
 */
export type BridgeSurface = Pick<
  SessionBridge,
  | 'createSessionForActor'
  | 'dispatch'
  | 'isBusy'
  | 'queuedCount'
  | 'findSession'
  | 'recentSessionsIn'
  | 'distinctWorkDirs'
  | 'latestAnswer'
  | 'prepareOutbound'
  | 'watch'
  | 'unwatch'
  | 'unwatchSession'
>

/**
 * 审批回执通道：把 IM 里的一句「确定 / 拒绝」变成宿主那条挂起审批的结果。
 * 由 index.ts 适配到 AgentSessionManager，core 不碰宿主类型。
 */
export interface ApprovalPort {
  /** 挂起时续一次等待：手机上看到消息再打字回话，往返几十秒是常态 */
  extendWait(sessionId: string, requestId: string): boolean
  resolve(sessionId: string, requestId: string, approved: boolean): Promise<{ ok: boolean; error?: string }>
}

/** 待答提问的回执通道：答案形状与宿主 ports.ui.askQuestion 的返回一致（问题 id → 选中的 label） */
export interface QuestionPort {
  resolve(
    sessionId: string,
    requestId: string,
    answers: Record<string, string[]>
  ): Promise<{ ok: boolean; error?: string }>
}

export interface CorePorts {
  storage: BotsStorage
  bridge: BridgeSurface
  deliver(input: DeliverInput): Promise<void>
  /** 审批答复的去向；没有它时 core 退回「请回电脑端处理」的旧行为 */
  approval?: ApprovalPort
  /** 提问答复的去向；同上，缺它时提问仍然只能回桌面答 */
  question?: QuestionPort
  /** 文案取用：主进程实现走 i18n，单测注入恒等表 */
  text(key: string, vars?: Record<string, string | number>): string
  /** 6 位绑定码生成（去掉了易混字符，实现方保证长度） */
  makeBindCode(): string
  now(): number
  log(...args: unknown[]): void
}

/** 绑定码挂问有效期：列完清单后人可能去倒杯水，5 分钟还认得回来，再久就当新话题 */
const PENDING_CHOICE_TTL_MS = 5 * 60_000
/** /task 与 /workspace 的候选条数（与规格一致：最近 10 个会话） */
const CHOICE_LIMIT = 10

/** 数字回复：允许前后空格，必须是纯正整数（'02' 也算，但 '2a' 不算） */
const NUMBER_ONLY = /^\s*(\d{1,3})\s*$/

/**
 * 命令解析结果。
 * 解析函数是纯函数并单独导出，因为「/Bind 2」这类大小写与参数边界的坑
 * 只能靠表驱动单测穷举，挂在 handleInbound 里测就要造一整套假端口。
 */
export type ParsedCommand =
  | { name: 'bind'; code: string }
  | { name: 'help' }
  | { name: 'status' }
  | { name: 'new' }
  | { name: 'workspace'; arg?: string }
  | { name: 'task'; arg?: string }
  | { name: 'unknown'; raw: string }
  | null

/**
 * 面向用户的命令清单（/help 文案与守卫测试都用它）。
 *
 * parseCommand 的 switch 是行为的唯一真相，这张表是「对外宣称有哪些命令」的唯一真相，
 * tests/im-bots-replies.test.ts 会把两者钉在一起：加了命令忘了写进 /help，
 * 或者 /help 里吹了一个不存在的命令，都会在测试里炸而不是等用户在手机上试出来。
 */
export const KNOWN_BOT_COMMANDS = ['/bind', '/help', '/status', '/new', '/workspace', '/task'] as const

/**
 * 命令解析（不区分大小写，见规格 §7.2）。
 *
 * 只接受「以 / 开头的第一个 token 命中已知命令」：`/workspace` 与 `/workspace D:/x` 都要认，
 * 而正文里出现 `/new`（例如「看看 /new 这个文件」）不能被当成命令——所以判定只看首 token，
 * 且 /bind 之后的码不再解析第二个 token。
 */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = (text ?? '').trim()
  if (!trimmed.startsWith('/')) return null
  const spaceAt = trimmed.search(/\s/)
  const head = (spaceAt < 0 ? trimmed : trimmed.slice(0, spaceAt)).toLowerCase()
  const rest = spaceAt < 0 ? '' : trimmed.slice(spaceAt + 1).trim()
  switch (head) {
    case '/bind':
      return rest ? { name: 'bind', code: rest.split(/\s+/)[0] ?? '' } : { name: 'unknown', raw: trimmed }
    case '/help':
      return { name: 'help' }
    case '/status':
      return { name: 'status' }
    case '/new':
      return { name: 'new' }
    case '/workspace':
      return { name: 'workspace', arg: rest || undefined }
    case '/task':
      return { name: 'task', arg: rest || undefined }
    default:
      return { name: 'unknown', raw: trimmed }
  }
}

/** 绑定码字符表：剔除 0/O/1/I/L 这类在手机上抄错的形近字 */
export const BIND_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * 从候选清单里取一条：`2` = 第二项；否则视为字面量（目录路径）。
 *
 * 字面量不在清单里也放行：绑定后的 IM 对端与桌面用户同级，桌面能选任意文件夹，
 * 手机上就该能 `/workspace D:\新仓库`——把没列出来的路径拒掉只会逼用户先在桌面操作一次。
 */
export function pickFromList(options: string[], arg: string): string | null {
  const numeric = NUMBER_ONLY.exec(arg)
  if (numeric) {
    const index = Number(numeric[1]) - 1
    return index >= 0 && index < options.length ? (options[index] as string) : null
  }
  const direct = arg.trim()
  if (direct.length < 2) return null
  return options.find((item) => item.toLowerCase() === direct.toLowerCase()) ?? direct
}

export function makeRandomBindCode(): string {
  const bytes = new Uint8Array(6)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += BIND_CODE_ALPHABET[byte % BIND_CODE_ALPHABET.length]
  return out
}

export class BotsCore {
  /** actorKey → 挂问中的序号选择（内存态：丢了最多让用户重发一次 /workspace） */
  private readonly pendingChoices = new Map<string, PendingChoice>()
  /** actorKey → 正在等这句答复的审批（一条审批只认发起它的那个身份的回答） */
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  /** actorKey → 正在等这句答复的提问 */
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  /** actorKey → 该身份最后一条入站的处理链（同一身份串行，不同身份并行） */
  private readonly inboundChain = new Map<string, Promise<unknown>>()

  constructor(private readonly ports: CorePorts) {}

  // ── 入站主流程 ────────────────────────────────────────────────────────────

  /**
   * 入站唯一入口，按聊天身份串行化后再路由。
   *
   * 顺序是安全设计而不是风格选择：**绑定检查必须在命令解析之前**。
   * 否则未绑定的对端能先用 /status / /workspace 探出本机目录结构与会话标题，
   * 那些信息在没绑定时属于「别人家的事」。
   *
   * 串行化解决的是另一件事：一个身份的两条消息几乎同时到达（飞书长连接会并发回调，
   * 微信一次 getupdates 里也可能带多条），两条都读到 draft 态，就会各自建一个会话、
   * 各起一个 run——用户看到的是「我发了一句，它开了两个任务」。
   * 排队按身份而不是全局：不同用户之间不必互相等。
   */
  async handleInbound(message: InboundMessage): Promise<void> {
    const actorKey = makeActorKey(
      message.actor.botId,
      message.actor.provider,
      message.actor.providerUserId,
      message.actor.chatType
    )
    const previous = this.inboundChain.get(actorKey) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => this.routeInbound(message, actorKey))
    this.inboundChain.set(actorKey, task.catch(() => {}))
    try {
      await task
    } finally {
      if (this.inboundChain.get(actorKey) === task) this.inboundChain.delete(actorKey)
    }
  }

  private async routeInbound(message: InboundMessage, actorKey: string): Promise<void> {
    const bound = await this.ports.storage.isBound(actorKey)
    const text = message.text ?? ''

    if (!bound) {
      const command = parseCommand(text)
      if (command?.name === 'bind') {
        await this.tryBind(message, actorKey, command.code)
        return
      }
      // 未绑定不响应任何内容，只给一句「去桌面生成绑定码」
      await this.reply(message, this.ports.text('bots.reply.notBound'))
      return
    }

    const command = parseCommand(text)
    if (command) {
      await this.runCommand(message, actorKey, command)
      return
    }

    // 有待批审批 / 待答提问时，「确定」「拒绝」或一串序号就是答复。
    // 顺序是刻意的：命令仍然优先（/status 这类任何时候都能查），答复优先于清单挂问——
    // 反过来的话，列完目录再回一句「确定」会被清单吞成第 N 项，而这一步可能正在等着放行。
    if (await this.tryAnswerApproval(message, actorKey, text)) return
    if (await this.tryAnswerQuestion(message, actorKey, text)) return

    // 刚列完目录 / 任务清单时，一条裸数字是选择而不是内容
    if (await this.tryResolvePending(message, actorKey, text)) return

    await this.handleOrdinaryMessage(message, actorKey, text)
  }

  /** 结果回推出口：SessionBridge 的 onOutcome 直接指到这里 */
  async handleOutcome(outcome: RunOutcome): Promise<void> {
    if (outcome.actorKeys.length === 0) return
    for (const actorKey of outcome.actorKeys) {
      const target = parseActorKey(actorKey)
      if (!target) continue
      const ctx = await this.ports.storage.getContext(actorKey)
      if (!ctx) continue
      /**
       * 「还在等这个会话」的唯一事实来源是上下文：mode=task 且当前任务就是它。
       * 桥那边不再自己按「推完一次就解绑」处理（那会把排队消息的结果吞掉），
       * 解绑就在这里判：/new 回草稿、/task 切走、解绑、会话被删，都让这条推不到手机上。
       */
      if (ctx.mode !== 'task' || ctx.activeSessionId !== outcome.sessionId) {
        this.ports.bridge.unwatch(outcome.sessionId, actorKey)
        this.pendingApprovals.delete(actorKey)
        this.pendingQuestions.delete(actorKey)
        continue
      }
      let text: string
      if (outcome.kind === 'awaiting') {
        text = await this.askApproval(actorKey, outcome)
      } else if (outcome.kind === 'question') {
        text = this.askQuestion(actorKey, outcome)
      } else if (outcome.kind === 'progress') {
        // 过程消息：一条写完的助手正文，马上推（不结束本轮，也不清挂起的审批/提问）
        text = outcome.text ?? ''
      } else if (outcome.kind === 'aborted') {
        text = this.ports.text('bots.reply.aborted')
      } else {
        // 一轮跑完，这个身份挂在这儿的审批与提问也就一并收尾了（超时或被桌面点掉都可能）
        this.pendingApprovals.delete(actorKey)
        this.pendingQuestions.delete(actorKey)
        // 最终答案已经以过程消息推过的话，不再重复发同一段文字；
        // 整轮没推过（纯工具调用/中途异常）才回落到「取尾部答案/本轮没有产出」
        if (outcome.answerPushed) continue
        const answer = await this.ports.bridge.latestAnswer(outcome.sessionId)
        text = answer.trim() ? answer : this.ports.text('bots.reply.emptyResult')
      }
      for (const chunk of this.ports.bridge.prepareOutbound(text)) {
        await this.deliverSafely({
          botId: target.botId,
          provider: target.provider,
          providerUserId: target.providerUserId,
          // 微信必须带回最近一次入站的 context_token，否则发不出去
          contextToken: target.provider === 'weixin' ? ctx.weixinContextToken : undefined,
          text: chunk,
        })
      }
    }
  }

  /**
   * 组装一条「要批什么」的问句发给聊天对端。
   *
   * 宿主给的 preview 已经是渲染好的正文（命令原文 / 目标路径），这里刻意不重新概括成长句
   * 自己的描述：多写一层就是多一处可能与实际执行内容不一致的地方，
   * 而审批文案对不上真正要跑的命令，是最坏的一种误导。
   * 没有审批通道（或宿主没带 details）时退回旧行为：一句「请回电脑端处理」。
   */
  private async askApproval(actorKey: string, outcome: RunOutcome): Promise<string> {
    const approval = outcome.approval
    if (!approval || !this.ports.approval) {
      return this.ports.text('bots.reply.approvalWaiting')
    }
    // 先登记再发送：发送万一失败，用户至少还能在电脑上处理；反过来登记晚了会答不上
    const now = this.ports.now()
    this.pendingApprovals.set(actorKey, {
      sessionId: outcome.sessionId,
      requestId: approval.requestId,
      askedAt: now,
      lastExtendedAt: now,
    })
    // 续一次等待：手机上看到消息再回话，120 秒的原表会把人已经同意的那步静默拒掉
    this.ports.approval.extendWait(outcome.sessionId, approval.requestId)
    const riskLine = this.ports.text(
      approval.risk === 'dangerous' ? 'bots.reply.riskDangerous' : 'bots.reply.riskNormal'
    )
    const toolLine = approval.tool ? this.ports.text('bots.reply.approvalTool', { tool: approval.tool }) : ''
    return [
      this.ports.text('bots.reply.approvalAskHead', { risk: riskLine }),
      toolLine,
      approval.preview,
      this.ports.text('bots.reply.approvalAskTail'),
    ]
      .filter((line) => line !== '')
      .join('\n')
  }

  /**
   * 一句「确定 / 拒绝」兑现成宿主的审批结果。
   * 命中即消费：同一条审批不能被答两次（答第二次会落到普通消息里变成新任务）。
   */
  private async tryAnswerApproval(message: InboundMessage, actorKey: string, text: string): Promise<boolean> {
    const pending = this.pendingApprovals.get(actorKey)
    if (!pending || !this.ports.approval) return false
    const answer = parseApprovalAnswer(text)
    if (!answer) return false
    this.pendingApprovals.delete(actorKey)
    const approved = answer === 'approve'
    const result = await this.ports.approval.resolve(pending.sessionId, pending.requestId, approved)
    if (result.ok) {
      await this.reply(message, this.ports.text(approved ? 'bots.reply.approvalApproved' : 'bots.reply.approvalDenied'))
      return true
    }
    // stale-request = 这条审批已经收尾（超时拒绝或已在电脑上点过）：如实说，不假装生效
    await this.reply(message, this.ports.text('bots.reply.approvalStale'))
    return true
  }

  /**
   * 给还挂着的审批续一次等待时间（由 index.ts 的定时心跳调用）。
   *
   * 为什么需要心跳而不是「发问时一次续够」：宿主的总上限是从它**首次挂起**算起的，
   * 一次续到底等于把 fail-closed 的兜底整个关掉。所以这里按最小间隔反复续，
   * 到总上限就停，宿主那条表一定会把没人答的审批收尾。
   * 也顺带兑现给用户的承诺——问句里写的是「超过 15 分钟」，不是「只给你 5 分钟」。
   */
  refreshApprovalWaits(): void {
    const now = this.ports.now()
    for (const pending of this.pendingApprovals.values()) {
      if (now - pending.lastExtendedAt < APPROVAL_EXTEND_MIN_INTERVAL_MS) continue
      pending.lastExtendedAt = now
      // 续不动了 = 已到总上限或宿主那边已经收尾；留着条目无妨，答复会拿到 stale 提示
      this.ports.approval?.extendWait(pending.sessionId, pending.requestId)
    }
  }

  /** 组装一道选择题：题干 + 带序号的选项，答复格式在文案里说死，免得用户猜 */
  private askQuestion(actorKey: string, outcome: RunOutcome): string {
    const prompt = outcome.question
    if (!prompt || !this.ports.question) {
      return this.ports.text('bots.reply.questionWaiting')
    }
    const now = this.ports.now()
    this.pendingQuestions.set(actorKey, {
      sessionId: outcome.sessionId,
      requestId: prompt.requestId,
      items: prompt.items,
    })
    const blocks = prompt.items.map((item, index) => {
      const options = item.options
        .map((option, optionIndex) => `  ${optionIndex + 1}) ${option.label}${option.description ? ` —— ${option.description}` : ''}`)
        .join('\n')
      const head = prompt.items.length > 1 ? `${this.ports.text('bots.reply.questionLabel', { index: index + 1 })} ` : ''
      return `${head}${item.question}\n${options}`
    })
    return [
      this.ports.text('bots.reply.questionAskHead'),
      ...blocks,
      this.ports.text(
        prompt.items.length === 1 ? 'bots.reply.questionAskTailSingle' : 'bots.reply.questionAskTail'
      ),
    ].join('\n')
  }

  /**
   * 一句序号答复兑现成宿主的提问结果。
   * 序号 → 选项 label 的映射完全按发问时列出的顺序，用户看到的和送回去的是同一份数据。
   */
  private async tryAnswerQuestion(message: InboundMessage, actorKey: string, text: string): Promise<boolean> {
    const pending = this.pendingQuestions.get(actorKey)
    if (!pending || !this.ports.question) return false
    const picked = parseQuestionAnswer(text, pending.items.length)
    if (!picked) return false
    const answers: Record<string, string[]> = {}
    const invalid: number[] = []
    // 一题时所有序号都属于它（允许多选）；多题时按题序一位对一题
    const pickForQuestion = (index: number): number | null =>
      pending.items.length === 1 ? null : (picked[index] ?? null)
    pending.items.forEach((item, index) => {
      const numbers = pending.items.length === 1 ? picked : [pickForQuestion(index)].filter((v): v is number => v !== null)
      for (const raw of numbers) {
        const option = item.options[raw - 1]
        if (!option) {
          invalid.push(raw)
          continue
        }
        const chosen = answers[item.id] ?? (answers[item.id] = [])
        if (!chosen.includes(option.label)) chosen.push(option.label)
      }
    })
    if (invalid.length > 0) {
      // 越界就原样把问题留着等下一次答复，不要静默吞掉：吞了用户会以为已经答过了
      await this.reply(message, this.ports.text('bots.reply.questionInvalid', { arg: text.trim() }))
      return true
    }
    if (Object.keys(answers).length !== pending.items.length) {
      await this.reply(message, this.ports.text('bots.reply.questionIncomplete'))
      return true
    }
    this.pendingQuestions.delete(actorKey)
    const result = await this.ports.question.resolve(pending.sessionId, pending.requestId, answers)
    if (!result.ok) {
      await this.reply(message, this.ports.text('bots.reply.questionStale'))
      return true
    }
    await this.reply(message, this.ports.text('bots.reply.questionAnswered'))
    return true
  }

  // ── 绑定 ──────────────────────────────────────────────────────────────────

  /**
   * 核销绑定码。
   * 桌面侧生成（generateBindCode）与这里核销共用 storage 的那一条记录，
   * 「30 秒 + 单次」因此只有一处实现，不会两边各数一遍时间。
   */
  private async tryBind(message: InboundMessage, actorKey: string, code: string): Promise<void> {
    const botId = message.actor.botId
    const normalized = code.toUpperCase()
    const result = await this.ports.storage.consumeBindCode(botId, normalized)
    if (!result.ok) {
      await this.reply(
        message,
        this.ports.text(result.reason === 'mismatch' ? 'bots.reply.bindCodeOtherBot' : 'bots.reply.bindCodeInvalid')
      )
      return
    }
    await this.ports.storage.addBinding({
      actorKey,
      botId,
      providerUserId: message.actor.providerUserId,
      displayName: message.actor.displayName,
      boundAt: this.ports.now(),
    })
    // 绑上就建一个 draft 上下文：首条普通消息据此开新会话
    await this.ports.storage.patchContext(actorKey, { mode: 'draft' }, () => ({ mode: 'draft' }))
    await this.reply(message, this.ports.text('bots.reply.welcome'))
  }

  /** 桌面端生成绑定码（IPC bots:generateBindCode 的实现） */
  async generateBindCode(botId: string): Promise<{ code: string; expiresAt: number } | null> {
    const bot = (await this.ports.storage.readConfig()).bots.find((item) => item.id === botId)
    if (!bot) return null
    const code = this.ports.makeBindCode()
    const entry = await this.ports.storage.issueBindCode(botId, code)
    return { code: entry.code, expiresAt: entry.expiresAt }
  }

  // ── 命令 ──────────────────────────────────────────────────────────────────

  private async runCommand(message: InboundMessage, actorKey: string, command: NonNullable<ParsedCommand>): Promise<void> {
    switch (command.name) {
      case 'bind':
        // 已绑定还发 /bind：直接拒绝，不能让第二次核销悄悄换掉绑定关系
        await this.reply(message, this.ports.text('bots.reply.alreadyBound'))
        return
      case 'help':
        await this.reply(message, this.ports.text('bots.reply.help'))
        return
      case 'status':
        await this.reply(message, await this.statusText(message, actorKey))
        return
      case 'new':
        await this.handleNew(message, actorKey)
        return
      case 'workspace':
        await this.handleWorkspace(message, actorKey, command.arg)
        return
      case 'task':
        await this.handleTask(message, actorKey, command.arg)
        return
      case 'unknown':
        await this.reply(message, this.ports.text('bots.reply.unknownCommand', { command: command.raw }))
        return
    }
  }

  /**
   * /status：工作目录 + 当前会话标题 + 忙闲 + 排队数。
   * 这四样是远程干活时最需要确认的「我在操作什么」，缺一样就容易在错的目录里跑命令。
   */
  private async statusText(message: InboundMessage, actorKey: string): Promise<string> {
    const ctx = await this.ports.storage.getContext(actorKey)
    const bot = await this.botOf(message.actor.botId)
    const workDir = ctx?.workDir || bot?.defaultWorkDir
    if (!workDir) return this.ports.text('bots.reply.statusNoWorkDir')
    const lines = [this.ports.text('bots.reply.statusWorkDir', { dir: workDir })]
    if (ctx?.mode === 'task' && ctx.activeSessionId) {
      const session = await this.ports.bridge.findSession(ctx.activeSessionId)
      if (session) {
        lines.push(this.ports.text('bots.reply.statusSession', { title: session.title }))
        lines.push(
          this.ports.bridge.isBusy(session.id)
            ? this.ports.text('bots.reply.statusBusy', { queued: this.ports.bridge.queuedCount(session.id) })
            : this.ports.text('bots.reply.statusIdle')
        )
      } else {
        lines.push(this.ports.text('bots.reply.statusDraft'))
      }
    } else {
      lines.push(this.ports.text('bots.reply.statusDraft'))
    }
    return lines.join('\n')
  }

  /** /new：task 且闲 → 回 draft；运行中拒绝（本期 IM 不提供停止命令） */
  private async handleNew(message: InboundMessage, actorKey: string): Promise<void> {
    const ctx = await this.ports.storage.getContext(actorKey)
    if (!ctx || ctx.mode === 'draft') {
      await this.reply(message, this.ports.text('bots.reply.newDraftHint'))
      return
    }
    if (ctx.activeSessionId && this.ports.bridge.isBusy(ctx.activeSessionId)) {
      await this.reply(message, this.ports.text('bots.reply.newBlockedRunning'))
      return
    }
    if (ctx.activeSessionId) this.ports.bridge.unwatchSession(ctx.activeSessionId)
    await this.ports.storage.patchContext(actorKey, { mode: 'draft', activeSessionId: undefined })
    await this.reply(message, this.ports.text('bots.reply.newDraftHint'))
  }

  /**
   * /workspace：无参列候选并挂问；带参（序号或路径）直接切。
   *
   * 带参时**重新算一遍候选**而不是复用上次清单：手机上「/workspace 2」和「列完之后回一个 2」
   * 必须是等价的，而挂问是内存态——应用重启、或者用户隔天接着聊，内存态就没了。
   * 让一条本来明确的指令退化成「请先重新列一遍」是最没道理的失败。
   *
   * 只有 draft 态能切目录：task 态切目录等于把正在进行的工作换到另一个仓库里继续，
   * 那种时候用户想表达的几乎总是「先看看有哪些目录」，所以给提示而不是照做。
   */
  private async handleWorkspace(message: InboundMessage, actorKey: string, arg?: string): Promise<void> {
    const bot = await this.botOf(message.actor.botId)
    const options = await this.workspaceOptions(bot)
    if (arg === undefined) {
      if (options.length === 0) {
        await this.reply(message, this.ports.text('bots.reply.workspaceEmpty'))
        return
      }
      this.setChoice(actorKey, { kind: 'workspace', options, askedAt: this.ports.now() })
      await this.reply(message, this.listText(this.ports.text('bots.reply.workspaceTitle'), options, bot?.defaultWorkDir))
      return
    }
    const picked = pickFromList(options, arg)
    if (picked === null) {
      await this.reply(message, this.ports.text('bots.reply.choiceInvalid', { arg }))
      return
    }
    await this.applyWorkspace(message, actorKey, picked)
  }

  private async applyWorkspace(message: InboundMessage, actorKey: string, dir: string): Promise<void> {
    const ctx = await this.ports.storage.getContext(actorKey)
    if (ctx?.mode === 'task') {
      await this.reply(message, this.ports.text('bots.reply.workspaceBusy'))
      return
    }
    this.clearChoice(actorKey)
    await this.ports.storage.patchContext(
      actorKey,
      { workDir: dir, activeSessionId: undefined },
      () => ({ mode: 'draft' })
    )
    await this.reply(message, this.ports.text('bots.reply.workspaceSet', { dir }))
  }

  /** /task：列绑定目录下最近 10 个会话，回序号切换当前任务 */
  private async handleTask(message: InboundMessage, actorKey: string, arg?: string): Promise<void> {
    const ctx = await this.ports.storage.getContext(actorKey)
    const bot = await this.botOf(message.actor.botId)
    const workDir = ctx?.workDir || bot?.defaultWorkDir
    if (!workDir) {
      await this.reply(message, this.ports.text('bots.reply.taskNoWorkDir'))
      return
    }
    const sessions = await this.ports.bridge.recentSessionsIn(workDir, CHOICE_LIMIT)
    if (arg === undefined) {
      if (sessions.length === 0) {
        await this.reply(message, this.ports.text('bots.reply.taskEmpty', { dir: workDir }))
        return
      }
      this.setChoice(actorKey, { kind: 'task', options: sessions.map((item) => item.id), askedAt: this.ports.now() })
      await this.reply(
        message,
        this.listText(this.ports.text('bots.reply.taskTitle', { dir: workDir }), sessions.map((item) => item.title))
      )
      return
    }
    // 会话没有「按 id 指定」这种写法：手机上没人能打出一串 nanoid，只认序号
    const numeric = NUMBER_ONLY.exec(arg)
    const target = numeric ? sessions[Number(numeric[1]) - 1] : undefined
    if (!target) {
      await this.reply(message, this.ports.text('bots.reply.choiceInvalid', { arg }))
      return
    }
    await this.applyTask(message, actorKey, target.id)
  }

  private async applyTask(message: InboundMessage, actorKey: string, sessionId: string): Promise<void> {
    const ctx = await this.ports.storage.getContext(actorKey)
    if (ctx?.activeSessionId && this.ports.bridge.isBusy(ctx.activeSessionId)) {
      await this.reply(message, this.ports.text('bots.reply.taskBusy'))
      return
    }
    // 复核会话还在：清单是刚刚算的，但用户回序号之间桌面可能已经把这条删了
    const session = await this.ports.bridge.findSession(sessionId)
    if (!session) {
      await this.reply(message, this.ports.text('bots.reply.taskGone'))
      return
    }
    if (ctx?.activeSessionId && ctx.activeSessionId !== session.id) {
      this.ports.bridge.unwatch(ctx.activeSessionId, actorKey)
    }
    this.clearChoice(actorKey)
    await this.ports.storage.patchContext(actorKey, { mode: 'task', activeSessionId: session.id })
    this.ports.bridge.watch(session.id, actorKey)
    await this.reply(message, this.ports.text('bots.reply.taskSet', { title: session.title }))
  }

  /**
   * 裸数字选择：列完清单后回一个「2」。
   *
   * 只在有挂问且未超时的时候才这么解释，其余一律当普通消息送进会话——
   * 否则「2 + 2 等于几」这种正文会被吃掉。非数字回复顺手作废挂问（用户已经改话题了）。
   */
  private async tryResolvePending(message: InboundMessage, actorKey: string, text: string): Promise<boolean> {
    const choice = this.pendingChoices.get(actorKey)
    if (!choice) return false
    const numeric = NUMBER_ONLY.exec(text)
    if (!numeric) {
      this.clearChoice(actorKey)
      return false
    }
    this.clearChoice(actorKey)
    if (this.ports.now() - choice.askedAt > PENDING_CHOICE_TTL_MS) return false
    const value = choice.options[Number(numeric[1]) - 1]
    if (!value) {
      await this.reply(message, this.ports.text('bots.reply.choiceInvalid', { arg: text.trim() }))
      return true
    }
    if (choice.kind === 'workspace') await this.applyWorkspace(message, actorKey, value)
    else await this.applyTask(message, actorKey, value)
    return true
  }

  // ── 普通消息状态机 ────────────────────────────────────────────────────────

  /**
   * draft → 建会话并开跑；task → 继续该会话；忙 → 入队。
   *
   * task 态但会话已经不存在（用户在桌面上删了）时**退回 draft 重新开会话**，
   * 而不是回一句「会话不存在」。理由：手机上用户看不出差别，一句错误只会让这条消息丢掉；
   * 而他的意图很明确——「继续干活」，换个新会话继续是更接近意图的处置，并把标题告诉他。
   */
  private async handleOrdinaryMessage(message: InboundMessage, actorKey: string, text: string): Promise<void> {
    const bot = await this.botOf(message.actor.botId)
    // 顺手把这一轮的 context_token 落盘：完成时它才是唯一能把答案送回去的凭证
    await this.ports.storage.patchContext(
      actorKey,
      message.contextToken ? { weixinContextToken: message.contextToken } : {},
      () => ({ mode: 'draft' })
    )
    const ctx = await this.ports.storage.getContext(actorKey)
    const target = ctx?.mode === 'task' && ctx.activeSessionId ? await this.ports.bridge.findSession(ctx.activeSessionId) : null

    if (!target) {
      const workDir = ctx?.workDir || bot?.defaultWorkDir
      const { sessionId, workDir: resolvedDir } = await this.ports.bridge.createSessionForActor(workDir)
      // **先落 task 态再发 run**：startRun 会 await 整轮模型循环，run.completed 在
      // dispatch 返回之前就会触发结果回推——那时上下文必须已经是 task 且指向本会话，
      // 否则回推被当成「没人等这个会话」吞掉（表现为「AI 跑完了、微信永远没收到」）。
      // dispatch 失败时回滚到 draft，让下一条消息重新开会话。
      await this.ports.storage.patchContext(actorKey, {
        mode: 'task',
        activeSessionId: sessionId,
        workDir: resolvedDir,
      })
      let outcome: Awaited<ReturnType<BridgeSurface['dispatch']>>
      try {
        outcome = await this.ports.bridge.dispatch(sessionId, actorKey, text)
      } catch {
        // dispatch 正常只回 {ok,error}；走到这说明宿主指令通道本身炸了，如实回滚并告知
        await this.ports.storage.patchContext(actorKey, { mode: 'draft', activeSessionId: undefined }, () => ({ mode: 'draft' }))
        await this.reply(message, this.ports.text('bots.reply.runRejected'))
        return
      }
      if (!outcome.ok) {
        await this.ports.storage.patchContext(actorKey, { mode: 'draft', activeSessionId: undefined }, () => ({ mode: 'draft' }))
        if (outcome.error === 'missing-settings') {
          await this.reply(message, this.ports.text('bots.reply.settingsMissing'))
          return
        }
        await this.reply(message, this.ports.text('bots.reply.runRejected'))
        return
      }
      // 标题用 deriveSessionTitle：宿主落库时用的是同一个函数（见 agent-host.persistMessage），
      // 于是这条 ack 里的标题、稍后 /task 列表里的标题、侧栏里的标题三者必然一致
      await this.reply(message, this.ports.text('bots.reply.started', { title: deriveSessionTitle(text) }))
      return
    }

    const wasBusy = this.ports.bridge.isBusy(target.id)
    const outcome = await this.ports.bridge.dispatch(target.id, actorKey, text)
    if (!outcome.ok) {
      await this.reply(
        message,
        this.ports.text(outcome.error === 'missing-settings' ? 'bots.reply.settingsMissing' : 'bots.reply.runRejected')
      )
      return
    }
    await this.reply(
      message,
      wasBusy
        ? this.ports.text('bots.reply.queued', { position: this.ports.bridge.queuedCount(target.id) })
        : this.ports.text('bots.reply.running', { title: target.title })
    )
  }

  // ── 工具 ──────────────────────────────────────────────────────────────────

  private async botOf(botId: string): Promise<BotConfig | null> {
    const config = await this.ports.storage.readConfig()
    return config.bots.find((item) => item.id === botId) ?? null
  }

  /** 候选目录：bot 默认目录在最前，其后是最近会话里出现过的 distinct 目录 */
  private async workspaceOptions(bot: BotConfig | null | undefined): Promise<string[]> {
    const seen: string[] = []
    if (bot?.defaultWorkDir) seen.push(bot.defaultWorkDir)
    for (const dir of await this.ports.bridge.distinctWorkDirs(CHOICE_LIMIT)) {
      if (seen.some((item) => item.toLowerCase() === dir.toLowerCase())) continue
      seen.push(dir)
    }
    return seen.slice(0, CHOICE_LIMIT)
  }

  /** 带序号的清单：序号从 1 开始，手机上「2」比「index 1」直观 */
  private listText(title: string, items: string[], hintCurrent?: string): string {
    const lines = items.map((item, index) => `${index + 1}. ${item}`)
    const head = hintCurrent
      ? `${title}\n${this.ports.text('bots.reply.listCurrent', { dir: hintCurrent })}`
      : title
    return `${head}\n${lines.join('\n')}\n${this.ports.text('bots.reply.pickNumberHint')}`
  }

  private setChoice(actorKey: string, choice: PendingChoice): void {
    this.pendingChoices.set(actorKey, choice)
  }

  /**
   * 取挂问即作废：一次选择只兑现一条，避免「2」被反复解释成同一个目录。
   * （裸数字走 tryResolvePending，带参命令走重新计算的清单）
   */
  private clearChoice(actorKey: string): void {
    this.pendingChoices.delete(actorKey)
  }

  /**
   * 回复一条。
   * 入参取整条 message 而不是 actor：context_token 挂在消息上而不是身份上，
   * 而微信只认「原样带回这次入站的 token」——取错了就是「机器人收到消息却永远不回」。
   * 错误绝不冒泡到通道：通道正在循环里等回调，抛出去会打断整条链路。
   */
  private async reply(message: InboundMessage, text: string): Promise<void> {
    await this.deliverSafely({
      botId: message.actor.botId,
      provider: message.actor.provider,
      providerUserId: message.actor.providerUserId,
      contextToken: message.contextToken,
      text,
    })
  }

  private async deliverSafely(input: DeliverInput): Promise<void> {
    try {
      await this.ports.deliver(input)
    } catch (error) {
      this.ports.log('[im-bots] deliver failed:', input.botId, error instanceof Error ? error.message : error)
    }
  }

  /** 配置变更时清掉某个聊天身份的挂问与待批答复（换 bot 后旧清单里的序号不能再兑现） */
  forgetChoices(actorKey: string): void {
    this.pendingChoices.delete(actorKey)
    this.pendingApprovals.delete(actorKey)
    this.pendingQuestions.delete(actorKey)
  }

  /** 删除机器人时按 bot 前缀清掉它所有身份的挂问：内存态不跟着配置一起清，就会留下能兑现旧清单的鬼路径 */
  forgetBot(botId: string): void {
    for (const map of [this.pendingChoices, this.pendingApprovals, this.pendingQuestions]) {
      for (const actorKey of [...map.keys()]) {
        if (actorKey.startsWith(`${botId}:`)) map.delete(actorKey)
      }
    }
  }
}

/**
 * actorKey 反解：`${botId}:${provider}:${providerUserId}:${chatType}`。
 * providerUserId 里理论上可能出现冒号（渠道侧是加密串），所以按
 * 「首段 botId、次段 provider、末段 chatType、中间全归 userId」拆，而不是 split(':')。
 */
export function parseActorKey(actorKey: string): {
  botId: string
  provider: BotProvider
  providerUserId: string
  chatType: BotChatType
} | null {
  const first = actorKey.indexOf(':')
  const last = actorKey.lastIndexOf(':')
  if (first <= 0 || last <= first) return null
  const afterProvider = actorKey.indexOf(':', first + 1)
  if (afterProvider < 0 || afterProvider >= last) return null
  const botId = actorKey.slice(0, first)
  const provider = actorKey.slice(first + 1, afterProvider)
  const providerUserId = actorKey.slice(afterProvider + 1, last)
  if (!botId || !providerUserId) return null
  if (provider !== 'weixin' && provider !== 'feishu') return null
  return { botId, provider, providerUserId, chatType: 'private' }
}
