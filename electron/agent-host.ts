/**
 * AgentHost（批次 B · P3）：ReAct 编排移入 Electron 主进程。
 *
 * 解决的问题：渲染层崩溃 / F5 / 关窗到托盘不再终止任务；UI 退化为视图 + 指令下发器。
 * 宿主在运行期独占消息落库（双写必然造成状态错位），渲染层靠事件流归并视图。
 *
 * 三条红线：
 * 1. 权限 fail-closed——挂起等回执，超时或无可用窗口一律拒绝，UI 离线绝不能成为放行条件；
 * 2. 事件带单调 seq 入每会话环形缓冲（上限 500），缺口按 sinceSeq 补发，溢出改发 resync
 *    让渲染层整会话重拉，绝不"补不出来就当没发生"；
 * 3. 运行模式开关默认 renderer，P6 才切 main——一条环境变量即可回滚整条路径。
 *
 * electron 的 app 只在函数内取（require）：本模块要能被 vitest 在 node 环境下加载。
 */
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import os from 'os'
import fs from 'fs/promises'
import { abortChatStream, startChatStream, type ApiConnConfig } from './api-proxy'
import { handlerRegistry } from './webui-server'
import type { ChatStore } from './db'
import { ipc, setIpcHostBridge } from '../src/lib/ipc-client'
import { toolRegistry } from '../src/lib/tool-registry'
import { findAgent } from '../src/lib/agent-registry'
import { buildMemoryPrompt } from '../src/lib/memory'
import { compactConversation, findKeepBoundaryIndex } from '../src/lib/compact'
import { normalizeHarnessMode } from '../src/lib/harness-modes'
import { buildPermissionPreview, formatPermissionAuditContent, type PermissionDecision } from '../src/lib/permission-preview'
import i18n from '../src/i18n'
import { makeId, runReactLoop } from '../src/agent-core/loop'
import { SessionContextStore } from '../src/agent-core/session-context'
import { createSeqCounter } from '../src/agent-core/protocol'
import type { AgentCommand, AgentCommandResult, AgentEvent, AgentSnapshot } from '../src/agent-core/protocol'
import type { AgentPermissionRequest, AgentPorts, AgentSettings, PermissionApproval } from '../src/agent-core/ports'
import type { MessageRow, SessionRow } from '../src/types/ipc'
import { deriveSessionTitle, mapMessageRows, messageRewindPatch, messageToRow, messageUpdateArgs, NEW_SESSION_TITLE } from '../src/lib/chat-row'
import type { Message, RewindScope, Session, SubAgentRun, TodoItem, TokenUsage } from '../src/types/agent'
import { buildRewindPlan } from '../src/lib/rewind'
import { buildRewindIo, executeRewind } from '../src/lib/rewind-service'
import { saveFileMutation } from '../src/lib/checkpoint-recorder'
import type { QueuedMessageItem } from '../src/stores/chat-store'

/** 审批挂起上限（计划 §3.3）：超时即拒绝 */
const PERMISSION_TIMEOUT_MS = 120_000
/** 提问挂起上限：用户不答时让本轮收尾，而不是永久占着 run */
const QUESTION_TIMEOUT_MS = 600_000
const EVENT_RING_LIMIT = 500
/** 环溢出触发的 resync 合并窗口：溢出会连续发生（环就卡在上限上），
 *  每事件发一次等于让渲染层每帧整会话重拉一次 */
const RESYNC_COALESCE_MS = 1_000
/** 渲染层尚未升级为带快照的薄客户端时，main 模式受理 run 会明确拒绝而不是猜配置 */
const MISSING_SETTINGS = 'run-command-missing-settings'

export type AgentHostMode = 'main' | 'renderer'

/**
 * 运行模式：环境变量优先（回滚演练与调试用），其次用户 KV，默认 renderer。
 * P3~P5 期间恒为 renderer，P6 才把默认值切到 main。
 */
export function resolveAgentHostMode(): AgentHostMode {
  const fromEnv = String(process.env.CLERKBOX_AGENT_HOST || '').trim().toLowerCase()
  if (fromEnv === 'main' || fromEnv === 'renderer') return fromEnv
  try {
    const handler = handlerRegistry.get('kvGet')
    const raw = handler ? handler(null, 'agentHostMode') : null
    if (raw === 'main' || raw === '"main"') return 'main'
  } catch {
    /* KV 尚未就绪：按默认值走 */
  }
  return 'renderer'
}

/** 宿主模式安装：让渲染层那套 ipc 调用面在主进程原地生效（直调 handler，零 IPC 往返） */
export function installAgentHostBridge(): void {
  setIpcHostBridge({
    async invoke<T>(method: string, args: unknown[]): Promise<T> {
      const handler = handlerRegistry.get(method)
      if (!handler) throw new Error(`agent-host: unknown handler '${method}'`)
      return (await handler(null, ...args)) as T
    },
    startChatStream: (cfg, body, requestId, emit) => {
      startChatStream(cfg, body, requestId, (payload) => emit(payload as never))
    },
    abortChatStream: (requestId) => abortChatStream(requestId),
  })
}

type RunStatus = 'idle' | 'working' | 'awaiting'

/**
 * 主进程原生的模型流端口：直调 api-proxy 的 startChatStream，与 apiChatStream handler
 * 是同一条实现，零 IPC。
 *
 * 为什么不能用渲染层的 openChatStream：那条路靠 ipcRenderer 订阅 'apiChunk' 事件收分片——
 * 这段代码跑在主进程时订阅两侧都不成立（invoke 能通是因为宿主桥直调 handlerRegistry，
 * 但事件永远只推给窗口），于是流静默挂死：占位的 assistant 消息 0 字节、run 永不收尾。
 * bot 是第一个在 main 宿主里跑模型的角色（P6 前桌面端都是 renderer 宿主），所以只在
 * 微信遥控链路上暴露。internal 的请求超时与空闲超时都由 startChatStream 自带。
 */
function hostModelStream(
  cfg: { baseUrl: string; apiKey: string; apiCompat: ApiConnConfig['apiCompat'] },
  body: unknown,
  signal: AbortSignal
): Promise<AsyncIterable<string>> {
  type ChunkPayload = { chunk?: string; done?: boolean; error?: string }
  const queue: ChunkPayload[] = []
  let waiter: (() => void) | null = null
  const enqueue = (payload: ChunkPayload) => {
    queue.push(payload)
    const wake = waiter
    waiter = null
    wake?.()
  }
  const requestId = `host-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  startChatStream(cfg as ApiConnConfig, body, requestId, enqueue)

  const onAbort = () => {
    abortChatStream(requestId)
    enqueue({ done: true })
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  return Promise.resolve({
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (queue.length === 0) {
            if (signal.aborted) return
            await new Promise<void>((resolve) => { waiter = resolve })
            continue
          }
          const payload = queue.shift()!
          if (payload.error) throw new Error(payload.error)
          if (payload.done) return
          if (payload.chunk) yield payload.chunk
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },
  })
}

interface HostSession {
  sessionId: string
  seq: ReturnType<typeof createSeqCounter>
  ring: { seq: number; event: AgentEvent }[]
  /** 上一次因环溢出广播 resync 的时刻（合并窗口用） */
  lastResyncAt: number
  run?: { runId: string; controller: AbortController; startedAt: number }
  status: RunStatus
  error?: string
  queue: QueuedMessageItem[]
  pendingPermissions: Map<string, {
    /** 回给 loop 的审批结果：带范围，loop 才知道要不要记会话级放行 */
    resolve: (v: PermissionApproval) => void
    timer: NodeJS.Timeout
    event: AgentEvent
    /** 审批原文：留痕与「本会话允许」都要用它，光有渲染好的 preview 字符串不够 */
    request: AgentPermissionRequest
    grantKey: string
    /** 挂起起点：IM 侧续时会话用它算总上限，不能让一条没人答的审批无限期占着 run */
    requestedAt: number
  }>
  /** 会话级放行集合（grantKey）：批过一次就不再打扰，无人看管的后台 run 也不会卡到超时 */
  sessionGrants: Set<string>
  pendingQuestions: Map<string, { resolve: (v: Record<string, string[]>) => void; timer: NodeJS.Timeout; event: AgentEvent }>
  /** 运行期由宿主持有、靠事件回流渲染层的会话状态 */
  todos: TodoItem[]
  goal: Record<string, unknown> | null
  subRuns: Map<string, SubAgentRun>
  /** 运行期消息镜像：StorePort 的 updateMessage 只有 id，需要回查原消息 */
  messages: Map<string, Message>
  lastUsage?: TokenUsage
}

/** getSession 端口是同步签名，宿主侧用这份缓存承载异步读到的会话字段（工作目录 / harness 等） */
const sessionCache = new Map<string, Session | undefined>()

export class AgentSessionManager {
  private readonly sessions = new Map<string, HostSession>()
  private readonly contexts = new SessionContextStore()
  /** 宿主不读渲染层的 zustand persist（localStorage），故设置与技能目录靠首次 run 下发后复用 */
  private readonly snapshots = new Map<string, Extract<AgentCommand, { type: 'run' }>>()
  /**
   * 最近一次「本地窗口」run 实际生效的设置快照（跨会话）。
   *
   * 为什么需要它：IM bot 自己从不携带凭据（否则等于让聊天对端指定上游地址与 Key），
   * 而它新建的会话从来没有本会话快照，于是「桌面无数对话、手机上第一次发任务」必然撞空。
   * 取全局最近一份本地快照是这里唯一诚实的来源——它一定是用户自己在界面上配过并跑过的。
   * 只在 !meta.remote 时读写，远程路径一律不看这份，所以不存在「远程换来一个别的上游」。
   */
  private lastLocalSettings?: AgentSettings

  constructor(private readonly store: ChatStore) {}

  private session(sessionId: string): HostSession {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = {
        sessionId,
        seq: createSeqCounter(),
        ring: [],
        lastResyncAt: 0,
        status: 'idle',
        queue: [],
        pendingPermissions: new Map(),
        sessionGrants: new Set(),
        pendingQuestions: new Map(),
        todos: [],
        goal: null,
        subRuns: new Map(),
        messages: new Map(),
      }
      this.sessions.set(sessionId, s)
    }
    return s
  }

  /**
   * 入环 + 广播。
   * 溢出分支曾经把触发事件留在环里却只广播 resync，而环被裁后长度恰好等于上限，
   * 于是此后每一个事件都「溢出」——真事件再也不发，渲染层只收到一串 resync；
   * 一段 30s 的流式回答（约 20 事件/秒）就能长期卡进这个状态。
   * 现在：事件无条件广播，裁剪只在合并窗口外发一次 resync 让渲染层整会话重拉。
   */
  private emit(s: HostSession, event: AgentEvent): void {
    const seq = s.seq.next()
    s.ring.push({ seq, event })
    this.broadcast({ seq, event })
    const trimmed = s.ring.length - EVENT_RING_LIMIT
    if (trimmed <= 0) return
    s.ring.splice(0, trimmed)
    const now = Date.now()
    if (now - s.lastResyncAt < RESYNC_COALESCE_MS) return
    s.lastResyncAt = now
    this.pushAndBroadcast(s, { type: 'resync', sessionId: s.sessionId, reason: 'ring-overflow' })
  }

  private pushAndBroadcast(s: HostSession, event: AgentEvent): void {
    const seq = s.seq.next()
    s.ring.push({ seq, event })
    this.broadcast({ seq, event })
  }

  private broadcast(payload: { seq: number; event: AgentEvent }): void {
    for (const win of liveWindows()) {
      try {
        win.webContents.send('agent:event', payload)
      } catch {
        /* 窗口正在销毁：事件仍在环里，重连按 sinceSeq 补发 */
      }
    }
    // WebUI 远程订阅者（SSE）：与本地窗口同源同序，客户端侧靠 seq 去重与补发
    for (const sink of eventSinks) {
      try {
        sink(payload)
      } catch {
        /* 某个远程连接正在断开 */
      }
    }
  }

  private hasLiveWindow(): boolean {
    return liveWindows().length > 0
  }

  private async loadMessages(sessionId: string): Promise<Message[]> {
    return mapMessageRows((await this.store.getMessages(sessionId)) as unknown as MessageRow[])
  }

  /** 与渲染层 createEmptySession 同一口径：老行缺 default_work_dir 时按创建时间确定性回填 */
  private static backfillDefaultWorkDir(row: SessionRow): string {
    const home = os.homedir()
    const d = new Date(row.created_at)
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    return process.platform === 'win32' ? `${home}\\clerkbox-work\\${stamp}` : `${home}/clerkbox-work/${stamp}`
  }

  private async refreshSession(sessionId: string): Promise<Session | undefined> {
    const rows = (await this.store.getAllSessions()) as unknown as SessionRow[]
    const row = rows.find((r) => r.id === sessionId)
    if (!row) {
      sessionCache.set(sessionId, undefined)
      return undefined
    }
    const session: Session = {
      id: row.id,
      title: row.title,
      messages: [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      harnessMode: normalizeHarnessMode(row.harness_mode),
      workingDir: row.working_dir || undefined,
      defaultWorkDir: row.default_work_dir || AgentSessionManager.backfillDefaultWorkDir(row),
    }
    sessionCache.set(sessionId, session)
    return session
  }

  /** 宿主独占运行期写入：先落库再广播，渲染层看到的消息都已持久 */
  private persistMessage(s: HostSession, message: Message): void {
    s.messages.set(message.id, message)
    void this.store.addMessage(messageToRow(message, s.sessionId) as never).catch((err) => {
      console.error('[agent-host] addMessage failed:', err)
    })
    // 首条用户消息定标题：本地路径由渲染层做同一件事，宿主模式必须宿主自己来做，
    // 否则无人看管跑完的后台会话会全留成「新会话」。标题规则与渲染层共用一个函数。
    if (message.role === 'user') {
      const cached = sessionCache.get(s.sessionId)
      if (cached && cached.title === NEW_SESSION_TITLE) {
        cached.title = deriveSessionTitle(message.content)
        void this.store.updateSessionTitle(s.sessionId, cached.title, Date.now()).catch((err) => {
          console.error('[agent-host] updateSessionTitle failed:', err)
        })
      }
    }
    this.emit(s, { type: 'message.added', sessionId: s.sessionId, message })
  }

  private buildPorts(s: HostSession, cmd: Extract<AgentCommand, { type: 'run' }>, settings: AgentSettings): AgentPorts {
    const sessionId = s.sessionId
    const ctx = this.contexts.get(sessionId)

    return {
      sessionId,
      settings,
      model: {
        stream: (body, signal) => hostModelStream(
          {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            apiCompat: settings.apiCompat || 'openai',
          },
          body,
          signal
        ),
      },
      tools: {
        definitions: (harnessMode) => toolRegistry.getDefinitionsForMode(harnessMode),
        execute: (name, args, toolCtx) => toolRegistry.execute(name, args, toolCtx),
        findAgent: (agentType, workingDir) => findAgent(agentType, workingDir),
      },
      store: {
        getSession: () => sessionCache.get(sessionId),
        addMessage: (_sid, message) => this.persistMessage(s, message),
        updateMessage: (_sid, msgId, updates) => {
          const prev = s.messages.get(msgId)
          let deltaText: string | null = null
          if (prev) {
            const next = { ...prev, ...updates }
            s.messages.set(msgId, next)
            // 落库参数走 chat-row 的同一份编码：手抄一份列顺序正是这个模块要避免的漂移
            void this.store
              .updateMessage(...messageUpdateArgs(next))
              .catch((err) => console.error('[agent-host] updateMessage failed:', err))
            // 回滚快照三列不在这份编码里（dbUpdateMessage 是位置参数签名），走增量补丁通道
            const patch = messageRewindPatch(next)
            if (patch) {
              void this.store
                .patchMessage(msgId, patch as never)
                .catch((err) => console.error('[agent-host] patchMessage(rewind) failed:', err))
            }
            // 流式正文改走 stream.delta：updateMessage 携带的是「已累计的全文」，
            // 按 20fps 把全文跨进程推一遍是 O(n²) 的字节量（4000 字回答能推到兆级）。
            // 只有纯正文、且确为前缀延长时才发增量；其余（思考块、收尾覆盖、改写）仍走全量，
            // 漏帧由 resync 兜底。
            const content = updates.content
            if (
              Object.keys(updates).length === 1 &&
              typeof content === 'string' &&
              content.length > prev.content.length &&
              content.startsWith(prev.content)
            ) {
              deltaText = content.slice(prev.content.length)
            }
          }
          if (deltaText !== null) {
            this.emit(s, { type: 'stream.delta', sessionId, messageId: msgId, text: deltaText })
            return
          }
          this.emit(s, { type: 'message.updated', sessionId, messageId: msgId, updates })
        },
        setStatus: (_sid, status) => {
          // SessionStatus 是渲染层的三态；宿主只关心运行态与错误串
          if (status === 'working') s.status = 'working'
          else if (status === 'confirm-danger') s.status = 'awaiting'
          else s.status = 'idle'
          this.emit(s, { type: 'run.status', sessionId, status: s.status, error: s.error })
        },
        compact: (_sid, messages, boundaryMessageId) => {
          void this.store.compactMessages(sessionId, messages.map((m) => messageToRow(m, sessionId)) as never)
            .catch((err) => console.error('[agent-host] compact failed:', err))
          s.messages = new Map(messages.map((m) => [m.id, m]))
          ctx.readFiles = new Map()
          // 原子重写整段历史：逐条广播既贵又易错，让渲染层整会话重拉。
          this.emit(s, { type: 'resync', sessionId, reason: `compacted:${boundaryMessageId}` })
        },
      },
      permission: {
        confirm: (request) => this.requestPermission(s, request, settings.approvalMode),
      },
      ui: {
        askQuestion: (_sid, questions) => this.requestQuestion(s, questions),
        setTodos: (_sid, items) => {
          s.todos = items
          this.emit(s, { type: 'todos.updated', sessionId, items })
        },
        notify: (_sid, kind, message) => {
          console.log(`[agent-host][notify] ${kind}: ${message ?? ''}`)
          this.emit(s, { type: 'notify', sessionId, kind, message })
        },
        // 上下文用量指示器的 ContextUsageInfo 需要分类明细（渲染层由 tokenTracker + 消息算得）。
        // P3 先在宿主留档，P4 决定是随快照取回还是在事件里带上，避免此处造出对不上的数字。
        recordUsage: (entry) => {
          s.lastUsage = entry.usage
        },
        agentMemoryCapture: async (payload) => {
          await ipc.agentMemoryCapture(payload)
        },
        addSubAgentRun: (_sid, run) => {
          s.subRuns.set(run.id, run)
          this.emit(s, { type: 'subagent.updated', sessionId, run })
        },
        appendSubAgentMessage: (_sid, runId, msg) => {
          const run = s.subRuns.get(runId)
          if (!run) return
          const next = { ...run, messages: [...run.messages, msg] }
          s.subRuns.set(runId, next)
          this.emit(s, { type: 'subagent.updated', sessionId, run: next })
        },
        updateSubAgentMessage: (_sid, runId, msgId, updates) => {
          const run = s.subRuns.get(runId)
          if (!run) return
          const next = { ...run, messages: run.messages.map((m) => (m.id === msgId ? { ...m, ...updates } : m)) }
          s.subRuns.set(runId, next)
          this.emit(s, { type: 'subagent.updated', sessionId, run: next })
        },
        completeSubAgentRun: (_sid, runId, result) => this.patchSubRun(s, runId, { status: 'completed', result, finishedAt: Date.now() }),
        abortSubAgentRun: (_sid, runId) => this.patchSubRun(s, runId, { status: 'aborted', finishedAt: Date.now() }),
        failSubAgentRun: (_sid, runId, error) => this.patchSubRun(s, runId, { status: 'failed', error, finishedAt: Date.now() }),
      },
      goal: {
        get: () => s.goal as never,
        setGoal: (_sid, condition) => {
          s.goal = { condition, status: 'active', createdAt: Date.now() }
          this.emit(s, { type: 'goal.updated', sessionId, goal: s.goal as never })
        },
        updateGoal: (_sid, patch) => {
          s.goal = { ...(s.goal ?? {}), ...(patch as Record<string, unknown>) }
          this.emit(s, { type: 'goal.updated', sessionId, goal: s.goal as never })
        },
      },
      skills: {
        catalog: () => cmd.skillCatalog ?? [],
      },
      // 变更前快照：正文经 ipc 门面落进 userData/checkpoints（宿主桥接直调 handler，零往返），
      // 索引回到 loop 挂在本轮锚点用户消息上。分类规则与渲染层共用 checkpoint-recorder。
      checkpoint: {
        save: (sid, mutation) => saveFileMutation(sid, mutation),
      },
      // Agent 动作能力开关：主进程有一份独立的 toolRegistry 单例，必须在这里同样注入一次，
      // 否则宿主模式下这些工具对模型不可见，而渲染层那边却是开着的
      ...(cmd.settings
        ? (() => {
            toolRegistry.setAgentActionCapabilities({
              browser: cmd.settings.browserUseEnabled === true,
              computer: cmd.settings.computerUseEnabled === true,
            })
            return {}
          })()
        : {}),
      env: {
        platform: process.platform,
        osDescription: describeOs(),
        shellDescription: process.platform === 'win32' ? 'PowerShell, cmd' : 'zsh, bash',
        isDev: !isPackaged(),
        homeDir: () => os.homedir(),
        readFile: (path) => fs.readFile(path, 'utf-8'),
        readImageAsDataUrl: async (path, mimeType) => {
          try {
            return `data:${mimeType || 'image/png'};base64,${(await fs.readFile(path)).toString('base64')}`
          } catch {
            return null
          }
        },
        runShell: (command, cwd) => ipc.executeCommandWithShell(command, cwd, 'cmd'),
        buildMemoryPrompt: (workingDir, homeDir) => buildMemoryPrompt(workingDir, homeDir),
      },
      emit: (event) => this.emit(s, event),
    }
  }

  private patchSubRun(s: HostSession, runId: string, patch: Partial<SubAgentRun>): void {
    const run = s.subRuns.get(runId)
    if (!run) return
    const next = { ...run, ...patch }
    s.subRuns.set(runId, next)
    this.emit(s, { type: 'subagent.updated', sessionId: s.sessionId, run: next })
  }

  /**
   * fail-closed：无可用窗口立即拒绝；挂起超时同样拒绝。
   * 但"拒绝"不是唯一的静默路径——批过一次的目标进会话放行集合，后续直接批准，
   * 否则无人看管的后台 run 会一次次撞上 120s 超时被拒。
   */
  private requestPermission(s: HostSession, request: AgentPermissionRequest, mode: AgentSettings['approvalMode']): Promise<PermissionApproval> {
    const sessionId = s.sessionId
    const preview = buildPermissionPreview(request.tool, request.args, { workingDir: request.workingDir })
    if (s.sessionGrants.has(preview.grantKey)) {
      console.log(`[agent-host] 会话级放行命中：${request.tool} ${preview.target}`)
      return Promise.resolve({ approved: true, scope: 'session' })
    }
    if (!this.hasLiveWindow()) {
      console.warn('[agent-host] 无可用窗口，危险操作按拒绝处理（fail-closed）:', request.title)
      this.writeAudit(s, request, 'deny')
      return Promise.resolve({ approved: false, scope: 'once' })
    }
    const requestId = makeId()
    const event: AgentEvent = {
      type: 'permission.requested',
      sessionId,
      requestId,
      preview: request.body,
      risk: request.risk,
      mode: mode === 'manual' || mode === 'auto' || mode === 'full' ? mode : 'manual',
      tool: request.tool,
      args: request.args,
      reason: request.reason,
      workingDir: request.workingDir,
    }
    this.emit(s, event)
    return new Promise<PermissionApproval>((resolve) => {
      const timer = setTimeout(() => {
        if (!s.pendingPermissions.has(requestId)) return
        console.warn(`[agent-host] 审批超时 ${Math.round(PERMISSION_TIMEOUT_MS / 1000)}s，按拒绝处理: ${request.title}`)
        this.settlePermission(s, requestId, false, true, 'once')
      }, PERMISSION_TIMEOUT_MS)
      s.pendingPermissions.set(requestId, {
        resolve,
        timer,
        event,
        request,
        grantKey: preview.grantKey,
        requestedAt: Date.now(),
      })
    })
  }

  /**
   * 延长一条挂起审批的等待时间。
   *
   * 为什么需要：PERMISSION_TIMEOUT_MS 的 120 秒是按「人坐在电脑前、卡片就在眼前」定的。
   * 审批改到 IM 里回答之后，用户在手机上看到消息、打字回一句「确定」，往返几十秒是常态，
   * 按原来的表走就会出现「用户已经点了同意、回来发现早被超时拒绝了」——
   * 这比不给 IM 审批更糟，因为它静默改变了执行结果。
   *
   * 上限 maxWaitMs 是硬闸：延长只能到「首次挂起 + maxWaitMs」为止，
   * 于是没人回答的审批仍然一定会收尾，绝不会把一轮 run 永久挂住。
   * 返回 false 表示这条审批已经不在了（批过 / 超时过 / 会话被回收），调用方据此提示用户。
   */
  extendPermissionWait(sessionId: string, requestId: string, extendMs: number, maxWaitMs: number): boolean {
    const s = this.sessions.get(sessionId)
    const pending = s?.pendingPermissions.get(requestId)
    if (!s || !pending) return false
    const deadline = pending.requestedAt + maxWaitMs
    const remaining = Math.min(Date.now() + extendMs, deadline) - Date.now()
    if (remaining <= 0) return false
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      if (!s.pendingPermissions.has(requestId)) return
      console.warn(`[agent-host] 审批等待 ${Math.round(maxWaitMs / 1000)}s 上限到点，按拒绝处理`)
      this.settlePermission(s, requestId, false, true, 'once')
    }, remaining)
    pending.timer.unref?.()
    return true
  }

  /** 审批的唯一收尾点：解除挂起、留痕、广播 settled、回到 working，四者不允许分头漏 */
  private settlePermission(
    s: HostSession,
    requestId: string,
    approved: boolean,
    timedOut: boolean,
    scope: 'once' | 'session'
  ): void {
    const pending = s.pendingPermissions.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    s.pendingPermissions.delete(requestId)
    pending.resolve({ approved, scope })
    if (approved && scope === 'session') s.sessionGrants.add(pending.grantKey)
    const decision: PermissionDecision = approved ? (scope === 'session' ? 'allow_session' : 'allow_once') : 'deny'
    this.writeAudit(s, pending.request, decision)
    this.emit(s, { type: 'permission.settled', sessionId: s.sessionId, requestId, approved, timedOut })
    if (s.run) {
      s.status = 'working'
      this.emit(s, { type: 'run.status', sessionId: s.sessionId, status: s.status })
    }
  }

  /** 审批结果作为 system 留痕行进对话流（与渲染层本地路径同一个编码，宿主独占运行期写入） */
  private writeAudit(s: HostSession, request: AgentPermissionRequest, decision: PermissionDecision): void {
    const preview = buildPermissionPreview(request.tool, request.args, { workingDir: request.workingDir })
    const at = Date.now()
    this.persistMessage(s, {
      id: makeId(),
      role: 'system',
      content: formatPermissionAuditContent({
        decision,
        tool: request.tool,
        target: preview.target,
        risk: preview.risk,
        at,
      }),
      timestamp: at,
    })
  }

  private requestQuestion(s: HostSession, questions: unknown[]): Promise<Record<string, string[]>> {
    const sessionId = s.sessionId
    if (!this.hasLiveWindow()) return Promise.resolve({})
    const requestId = makeId()
    const event: AgentEvent = { type: 'question.requested', sessionId, requestId, question: questions }
    this.emit(s, event)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!s.pendingQuestions.delete(requestId)) return
        resolve({})
      }, QUESTION_TIMEOUT_MS)
      s.pendingQuestions.set(requestId, { resolve, timer, event })
    })
  }

  /** 渲染层 → 宿主的指令入口。返回值只表示是否受理，运行结果一律走事件（rewind 两条例外：同步回计划/结果）。 */
  async handleCommand(cmd: AgentCommand, meta: { remote?: boolean } = {}): Promise<AgentCommandResult> {
    // 远程通道（WebUI /api/invoke 传 event=null）可回执提问，必须留痕便于事后追责
    if (meta.remote && cmd.type === 'question.resolve') {
      console.log(`[agent-host][audit] remote question.resolve session=${cmd.sessionId} request=${cmd.requestId}`)
    }
    // 危险操作审批只认本地窗口：远程界面能看（SSE/snapshot 里有待批卡片的状态），
    // 但不能替本地用户点头——否则 token 泄漏就等同于「攻击者自批自跑」。
    if (meta.remote && cmd.type === 'permission.resolve') {
      return { ok: false, error: 'approval-local-only' }
    }
    // 撤回/回滚同样是本地专属：它会删消息、删文件，远程持 token 者不该有这个权力。
    // agent:command 目前在远程黑名单里，这道门是给「以后有人放开那扇门」准备的第二层。
    if (meta.remote && (cmd.type === 'rewind.apply' || cmd.type === 'rewind.preview')) {
      return { ok: false, error: 'rewind-local-only' }
    }
    const s = this.session(cmd.sessionId)
    switch (cmd.type) {
      case 'run':
        return this.startRun(s, cmd, meta)
      case 'abort': {
        if (!s.run) return { ok: false, error: 'no-run' }
        s.run.controller.abort()
        // 中断语义（计划 §5.4）：停模型流 + 杀本会话仍在跑的 shell + 清运行态，缺一不可
        void ipc.cancelSessionCommands(s.sessionId).catch(() => { /* 主进程未注册该 handler 时无害 */ })
        return { ok: true }
      }
      case 'queue.enqueue':
        this.setQueue(s, [...s.queue, cmd.item])
        return { ok: true }
      case 'queue.remove':
        this.setQueue(s, s.queue.filter((item) => item.id !== cmd.id))
        return { ok: true }
      case 'queue.flush': {
        // 「立即发送」指定某一条时先把它提到队首，否则只能按 FIFO 发第一条
        if (cmd.id) {
          const index = s.queue.findIndex((item) => item.id === cmd.id)
          if (index > 0) {
            const next = [...s.queue]
            const [picked] = next.splice(index, 1)
            if (picked) this.setQueue(s, [picked, ...next])
          }
        }
        // 立即发送队首：先中断当前 run 并等它释放，与渲染层 sendQueuedNow 语义一致
        if (s.run) {
          s.run.controller.abort()
          for (let i = 0; i < 100 && s.run; i++) await new Promise((r) => setTimeout(r, 50))
        }
        void this.flushQueue(s)
        return { ok: true }
      }
      case 'permission.resolve': {
        if (!s.pendingPermissions.has(cmd.requestId)) return { ok: false, error: 'stale-request' }
        this.settlePermission(s, cmd.requestId, cmd.approved === true, false, cmd.scope ?? 'once')
        return { ok: true }
      }
      case 'question.resolve': {
        const pending = s.pendingQuestions.get(cmd.requestId)
        if (!pending) return { ok: false, error: 'stale-request' }
        clearTimeout(pending.timer)
        s.pendingQuestions.delete(cmd.requestId)
        pending.resolve((cmd.payload ?? {}) as Record<string, string[]>)
        return { ok: true }
      }
      case 'manual.compact':
        void this.manualCompact(s, cmd.instructions)
        return { ok: true }
      case 'rewind.preview':
        return this.rewind(s, cmd.anchorMessageId, cmd.scope, false)
      case 'rewind.apply':
        return this.rewind(s, cmd.anchorMessageId, cmd.scope, true)
      default:
        return { ok: false, error: 'unknown-command' }
    }
  }

  /**
   * 消息撤回 / 改动回滚（宿主是唯一写者）。
   *
   * 为什么必须走宿主而不是渲染层本地删：宿主持有 messages 镜像与 500 条事件环，
   * 渲染层直接 dbDeleteMessagesFrom 之后，一次重连就会把已删的消息整批回放回来。
   * 成功后统一广播 resync，让渲染层整会话重拉 —— 与 compact 同一套收口。
   */
  private async rewind(
    s: HostSession,
    anchorMessageId: string,
    scope: RewindScope,
    apply: boolean
  ): Promise<AgentCommandResult> {
    const sessionId = s.sessionId
    const io = buildRewindIo(sessionId, {
      addNoticeRow: async (message) => {
        await this.store.addMessage(messageToRow(message, sessionId) as never)
        s.messages.set(message.id, message)
      },
    })

    if (apply) {
      const outcome = await executeRewind(io, {
        // 交给执行器在抢占之后重读：run 收尾时还会落几条消息，截断点必须看得见它们
        getMessages: () => this.loadMessages(sessionId),
        anchorMessageId,
        scope,
        // 运行中的会话必须先确实停下：截断一个还在被写历史的锚点是未定义行为
        abortActiveRun: async () => {
          if (!s.run) return true
          s.run.controller.abort()
          void ipc.cancelSessionCommands(sessionId).catch(() => { /* 主进程未注册该 handler 时无害 */ })
          for (let i = 0; i < 200 && s.run; i++) await new Promise((r) => setTimeout(r, 50))
          return !s.run
        },
      })
      if (outcome.ok) {
        if (scope !== 'workspace') s.messages.clear()
        // 刻意不清 ctx.readFiles：本项目的过期检测是**内容比对**（见 tool-registry 的 staleness 注释），
        // 回滚把文件还原成正好被读过的那份内容，保留缓存与保留事实是一致的；
        // 而本轮中途读到的那些版本已经对不上，会被同一条检测正确拒绝。
        // 渲染层宿主没有这条清理路径，两种模式必须同构，所以两边都不清。
        this.emit(s, { type: 'resync', sessionId, reason: `rewind:${scope}` })
      }
      return { ok: outcome.ok, error: outcome.error, outcome }
    }

    const messages = await this.loadMessages(sessionId)
    const fromIndex = messages.findIndex((m) => m.id === anchorMessageId)
    if (fromIndex < 0) return { ok: false, error: 'no-checkpoint' }
    const plan = await buildRewindPlan({
      messages,
      fromIndex,
      scope,
      readFile: io.readFile,
      readSnapshot: io.readSnapshot,
    })
    return { ok: true, plan }
  }

  private setQueue(s: HostSession, items: QueuedMessageItem[]): void {
    s.queue = items
    this.emit(s, { type: 'queue.snapshot', sessionId: s.sessionId, items })
  }

  private async startRun(
    s: HostSession,
    cmd: Extract<AgentCommand, { type: 'run' }>,
    meta: { remote?: boolean } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    // 设置快照：宿主不读渲染层 persist，凭据只存在于本地窗口下发的那份快照里。
    // 因此远程 run 一律**忽略**命令自带的 settings（否则等于让远程端指定上游地址与 Key），
    // 改用本会话最近一次本地快照；没有快照就明确拒绝，而不是拿远程自带的配置去跑。
    // 本地 run 自带 settings 时用自带的；不带（IM bot 就是这种）时先查本会话历史快照，
    // 再退到全局最近本地快照——bot 新建的会话没有前者，只有后者能让它开箱即用。
    const cached = this.snapshots.get(s.sessionId)
    const base = meta.remote
      ? cached?.settings
      : (cmd.settings ?? cached?.settings ?? this.lastLocalSettings)
    if (!base) return { ok: false, error: MISSING_SETTINGS }
    // 远程触发的运行永远按 manual 档门控：危险操作只能由本地窗口批准。
    // full / auto 档在本地是用户自己的选择，落到远程就变成「持 token 即可以用户身份跑 shell」。
    const settings: AgentSettings = meta.remote ? { ...base, approvalMode: 'manual' } : base
    const resolvedCmd: Extract<AgentCommand, { type: 'run' }> = { ...cmd, settings }
    // 本地 run 才是这份全局快照的唯一合法来源：渲染层每次发都带自己的配置，
    // 于是「桌面换模型」下一步就是 bot 用新模型，不需要重启任何东西。
    if (!meta.remote) this.lastLocalSettings = settings
    if (meta.remote && base.approvalMode !== 'manual') {
      console.log(`[agent-host][audit] remote run downgraded approval ${base.approvalMode} -> manual session=${s.sessionId}`)
    }
    if (s.run) {
      // 已在跑：按排队语义并入队列，而不是并发两个 run 抢同一会话状态
      this.setQueue(s, [...s.queue, {
        id: makeId(),
        content: cmd.content,
        attachments: cmd.attachments,
        taskMode: cmd.taskMode,
        skills: cmd.skills,
        queuedAt: Date.now(),
      }])
      return { ok: true }
    }

    const sessionId = s.sessionId
    this.snapshots.set(sessionId, resolvedCmd)
    const controller = new AbortController()
    const runId = makeId()
    s.run = { runId, controller, startedAt: Date.now() }
    s.status = 'working'
    s.error = undefined

    const ctx = this.contexts.get(sessionId)
    const session = await this.refreshSession(sessionId)
    ctx.requestWorkingDir = session?.workingDir
    ctx.activeTaskMode = cmd.taskMode ?? null
    if (cmd.goal) s.goal = cmd.goal as unknown as Record<string, unknown>
    if (cmd.todos) s.todos = cmd.todos

    this.emit(s, { type: 'run.started', sessionId, runId, ts: Date.now() })

    const userMsg: Message = {
      id: makeId(),
      role: 'user',
      content: cmd.content,
      timestamp: Date.now(),
      ...(cmd.attachments && cmd.attachments.length > 0 ? { attachments: cmd.attachments } : {}),
      ...(cmd.taskMode ? { taskMode: cmd.taskMode } : {}),
      ...(cmd.skills && cmd.skills.length > 0 ? { skills: cmd.skills } : {}),
    }
    this.persistMessage(s, userMsg)

    // addMessage 落库是异步的，刚写入的这条通常还查不到；按 id 判定而不是全表去重
    const history = await this.loadMessages(sessionId)
    const initialMessages = history.some((m) => m.id === userMsg.id) ? history : [...history, userMsg]
    const ports = this.buildPorts(s, resolvedCmd, settings)

    try {
      await runReactLoop(ports, ctx, initialMessages, controller, resolvedCmd.taskMode, resolvedCmd.skillReminder)
      return { ok: true }
    } catch (err) {
      if (controller.signal.aborted) return { ok: true }
      const msg = err instanceof Error ? err.message : String(err)
      s.error = msg
      console.error('[agent-host] run failed:', msg)
      this.persistMessage(s, {
        id: makeId(),
        role: 'assistant',
        content: i18n.t('agent.sendFailed', { message: msg }),
        timestamp: Date.now(),
      })
      this.emit(s, { type: 'notify', sessionId, kind: 'error', message: msg.slice(0, 200) })
      return { ok: false, error: msg }
    } finally {
      ctx.requestWorkingDir = undefined
      ctx.activeTaskMode = null
      s.run = undefined
      s.status = 'idle'
      // 本轮结束时还挂着的审批（多为 abort 打断等待）：按超时收尾，
      // 否则界面上的待批卡片会永远留在"等待宿主"
      for (const requestId of [...s.pendingPermissions.keys()]) this.settlePermission(s, requestId, false, true, 'once')
      // 终态单点决定：abort 落在等流窗口时循环是优雅收尾的（与渲染层现状一致），
      // 只凭 catch 会漏报中断——UI 会显示"完成"而用户明明按了停止。
      if (controller.signal.aborted) {
        this.emit(s, { type: 'run.aborted', sessionId, runId, byUser: true })
      } else {
        this.emit(s, { type: 'run.completed', sessionId, runId })
      }
      // 错误串随本轮收尾一并广播，下一轮 startRun 清空（渲染层错误横幅靠它显示与消失）
      this.emit(s, { type: 'run.status', sessionId, status: s.status, error: s.error })
      void this.flushQueue(s)
    }
  }

  /** FIFO 取队首发送；入口守卫拦下的（缺配置等）放回队首，不丢消息 */
  private async flushQueue(s: HostSession): Promise<void> {
    if (s.run || s.queue.length === 0) return
    const cmd = this.snapshots.get(s.sessionId)
    if (!cmd) return
    const next = s.queue[0]
    this.setQueue(s, s.queue.slice(1))
    const result = await this.startRun(s, {
      ...cmd,
      content: next.content,
      attachments: next.attachments,
      taskMode: next.taskMode ?? undefined,
      skills: next.skills,
    })
    if (!result.ok && result.error !== MISSING_SETTINGS) this.setQueue(s, [next, ...s.queue])
  }

  private async manualCompact(s: HostSession, instructions?: string): Promise<void> {
    const sessionId = s.sessionId
    if (s.run) return
    const cmd = this.snapshots.get(sessionId)
    if (!cmd?.settings) return
    const messages = await this.loadMessages(sessionId)
    if (messages.length === 0) return
    const ctx = this.contexts.get(sessionId)
    const placeholderId = makeId()
    this.emit(s, {
      type: 'message.added',
      sessionId,
      message: { id: placeholderId, role: 'assistant', content: '', timestamp: Date.now(), _isCompacting: true },
    })
    try {
      const result = await compactConversation(messages, cmd.settings, ctx.readFiles, instructions?.trim() || undefined, 'manual')
      const keepStart = findKeepBoundaryIndex(messages)
      const newMessages = [
        ...messages.slice(0, keepStart),
        result.boundaryMessage,
        result.summaryMessage,
        ...messages.slice(keepStart),
        ...result.fileAttachments,
      ]
      await this.store.compactMessages(sessionId, newMessages.map((m) => messageToRow(m, sessionId)) as never)
      s.messages = new Map(newMessages.map((m) => [m.id, m]))
      ctx.readFiles = new Map()
      ctx.tokenTracker.reset()
      this.emit(s, { type: 'resync', sessionId, reason: 'compacted' })
    } catch (err) {
      console.error('[agent-host] manual compact failed:', err)
      this.emit(s, {
        type: 'message.updated',
        sessionId,
        messageId: placeholderId,
        updates: { content: i18n.t('chat.compactFailed'), _isCompacting: false },
      })
    }
  }

  /**
   * 重连接口：把 sinceSeq 之后的事件补发出去，并回一份运行态概览。
   * 环已被裁剪（发生过 resync）时靠 resync 事件让渲染层整会话重拉。
   */
  snapshot(sessionId: string | undefined, sinceSeq = 0): AgentSnapshot {
    const targets = sessionId ? [this.session(sessionId)] : [...this.sessions.values()]
    const activeRuns: AgentSnapshot['activeRuns'] = []
    const queue: Record<string, QueuedMessageItem[]> = {}
    const pendingPermissions: AgentEvent[] = []
    let lastSeq = sinceSeq
    for (const s of targets) {
      if (s.run) activeRuns.push({ sessionId: s.sessionId, runId: s.run.runId, status: s.status === 'awaiting' ? 'awaiting' : 'working' })
      queue[s.sessionId] = s.queue
      for (const item of s.ring) {
        if (item.seq > sinceSeq) this.broadcast({ seq: item.seq, event: item.event })
        if (item.seq > lastSeq) lastSeq = item.seq
      }
      // 待批/待答要按新序号重发：它们原事件的 seq 早已被客户端见过，直接回放会被去重闸门丢掉，
      // 于是重连（F5 / 窗口销毁期间漏事件）之后卡片再也回不来。返回字段同时保留，供 P5 远程端用。
      for (const p of s.pendingPermissions.values()) {
        pendingPermissions.push(p.event)
        this.emit(s, p.event)
      }
      for (const q of s.pendingQuestions.values()) {
        pendingPermissions.push(q.event)
        this.emit(s, q.event)
      }
    }
    return { activeRuns, queue, pendingPermissions, lastSeq }
  }

  /** 会话删除时清运行态与上下文，避免宿主留下僵尸 run 与陈旧 token 锚点 */
  dropSession(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) {
      s.run?.controller.abort()
      for (const p of s.pendingPermissions.values()) clearTimeout(p.timer)
      for (const q of s.pendingQuestions.values()) clearTimeout(q.timer)
      this.sessions.delete(sessionId)
    }
    this.contexts.delete(sessionId)
    this.snapshots.delete(sessionId)
    sessionCache.delete(sessionId)
  }

  /** 诊断与单测用的运行态摘要 */
  inspect(): Array<{ sessionId: string; status: RunStatus; queued: number; pendingPermissions: number; lastSeq: number; hasRun: boolean }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      status: s.status,
      queued: s.queue.length,
      pendingPermissions: s.pendingPermissions.size,
      lastSeq: s.seq.get(),
      hasRun: !!s.run,
    }))
  }

  /** 单测注入：观察某会话的事件环 */
  peekRing(sessionId: string): AgentEvent[] {
    return (this.sessions.get(sessionId)?.ring ?? []).map((item) => item.event)
  }

  /** 单测与诊断用：本会话最近一次运行实际生效的设置快照 */
  peekRunSettings(sessionId: string): AgentSettings | undefined {
    return this.snapshots.get(sessionId)?.settings
  }

  /**
   * IM bot 的可用性判据：本机是否已经有一份能用的模型配置。
   * bot 自己不带凭据，冷启动时若这里还是 undefined，就应当回「请先在桌面端完成一次对话」，
   * 而不是发一条必然失败的 run 让用户在手机上看到一堆错误。
   */
  get hasLocalSettingsSnapshot(): boolean {
    return this.lastLocalSettings !== undefined
  }

  /**
   * 渲染层主动推送的本地设置快照（'agent:push-settings'，仅本地窗口可调）。
   *
   * 为什么需要这条独立通道：P6 之前宿主默认 mode=renderer，桌面上每一次对话都在渲染层
   * 自跑循环、根本不经过 handleCommand——startRun 里的快照挂载点永远收不到，
   * IM bot 就会永远卡在「请先在桌面端完成一次对话」。渲染层在设置加载/变更时推一份过来，
   * 是 renderer 模式下主进程唯一诚实的快照来源；main 模式下 startRun 的挂载点继续兜底，
   * 两条来源写同一个字段，不冲突。
   */
  noteLocalSettings(settings: AgentSettings): void {
    this.lastLocalSettings = settings
  }
}

/**
 * 宿主事件的额外出口：WebUI 的 SSE 通道由 main.ts 注册进来，
 * 让远程订阅者与本地窗口收到同一份有序事件流（同一 seq 序列，不去重就靠客户端 seq 闸门）。
 */
const eventSinks = new Set<(payload: { seq: number; event: AgentEvent }) => void>()

export function registerAgentEventSink(sink: (payload: { seq: number; event: AgentEvent }) => void): () => void {
  eventSinks.add(sink)
  return () => {
    eventSinks.delete(sink)
  }
}

function describeOs(): string {
  const release = os.release()
  if (process.platform === 'win32') return release.startsWith('10.') ? 'Windows 10/11' : `Windows ${release}`
  if (process.platform === 'darwin') return `macOS ${release}`
  return 'Linux'
}

/** 当前可接收事件的窗口；electron 不在位（如 vitest 跑在 node 下）时返回空 */
function liveWindows(): BrowserWindow[] {
  if (windowProbe) return windowProbe()
  try {
    const electron = require('electron') as { BrowserWindow?: { getAllWindows(): BrowserWindow[] } }
    return electron.BrowserWindow?.getAllWindows().filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed()) ?? []
  } catch {
    return []
  }
}

let windowProbe: (() => BrowserWindow[]) | null = null

/**
 * 测试注入点：真实环境取所有存活窗口。
 * 审批链路（无窗口即 fail-closed、有窗口才广播 requested 并挂起等待）在单测里必须可跑，
 * 否则这段最关键的 fail-closed 语义只能靠人肉在 GUI 里验。
 */
export function setAgentHostWindowProbeForTest(probe: (() => BrowserWindow[]) | null): void {
  windowProbe = probe
}

function isPackaged(): boolean {
  try {
    return Boolean((require('electron') as { app?: { isPackaged?: boolean } }).app?.isPackaged)
  } catch {
    return false
  }
}

let manager: AgentSessionManager | null = null

export function getAgentSessionManager(store: ChatStore): AgentSessionManager {
  if (!manager) manager = new AgentSessionManager(store)
  return manager
}

/** 主进程注册：'agent:command' 与 'agent:snapshot'；事件走 webContents.send('agent:event') */
export function registerAgentHostIpc(store: ChatStore): void {
  installAgentHostBridge()
  const m = getAgentSessionManager(store)
  // event 为 null 即来自 WebUI 的 /api/invoke（那边用 handler(null, ...) 直调），据此区分远程与本地
  ipcMain.handle('agent:command', (event, cmd: AgentCommand) => m.handleCommand(cmd, { remote: event === null }))
  ipcMain.handle('agent:snapshot', (_event, sessionId: string | undefined, sinceSeq?: number) => m.snapshot(sessionId, sinceSeq ?? 0))
  // 渲染层靠它决定"自己跑循环"还是"下发指令当薄客户端"；P6 默认切 main 后此通道随之退役
  ipcMain.handle('agent:host-mode', () => resolveAgentHostMode())
  ipcMain.on('agent:drop-session', (_event, sessionId: string) => m.dropSession(sessionId))
  console.log(`[agent-host] ready, mode=${resolveAgentHostMode()}`)
}
