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
import { abortChatStream, startChatStream } from './api-proxy'
import { handlerRegistry } from './webui-server'
import type { ChatStore } from './db'
import { ipc, setIpcHostBridge } from '../src/lib/ipc-client'
import { openChatStream } from '../src/lib/api-transport'
import { toolRegistry } from '../src/lib/tool-registry'
import { findAgent } from '../src/lib/agent-registry'
import { buildMemoryPrompt } from '../src/lib/memory'
import { compactConversation, findKeepBoundaryIndex } from '../src/lib/compact'
import { normalizeHarnessMode } from '../src/lib/harness-modes'
import i18n from '../src/i18n'
import { makeId, runReactLoop } from '../src/agent-core/loop'
import { SessionContextStore } from '../src/agent-core/session-context'
import { createSeqCounter } from '../src/agent-core/protocol'
import type { AgentCommand, AgentEvent, AgentSnapshot } from '../src/agent-core/protocol'
import type { AgentPorts, AgentSettings } from '../src/agent-core/ports'
import type { MessageRow, SessionRow } from '../src/types/ipc'
import { mapMessageRows, messageToRow } from '../src/lib/chat-row'
import type { Message, Session, SubAgentRun, TodoItem, TokenUsage } from '../src/types/agent'
import type { QueuedMessageItem } from '../src/stores/chat-store'

/** 审批挂起上限（计划 §3.3）：超时即拒绝 */
const PERMISSION_TIMEOUT_MS = 120_000
/** 提问挂起上限：用户不答时让本轮收尾，而不是永久占着 run */
const QUESTION_TIMEOUT_MS = 600_000
const EVENT_RING_LIMIT = 500
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

interface HostSession {
  sessionId: string
  seq: ReturnType<typeof createSeqCounter>
  ring: { seq: number; event: AgentEvent }[]
  run?: { runId: string; controller: AbortController; startedAt: number }
  status: RunStatus
  error?: string
  queue: QueuedMessageItem[]
  pendingPermissions: Map<string, { resolve: (v: boolean) => void; timer: NodeJS.Timeout; event: AgentEvent }>
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

  constructor(private readonly store: ChatStore) {}

  private session(sessionId: string): HostSession {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = {
        sessionId,
        seq: createSeqCounter(),
        ring: [],
        status: 'idle',
        queue: [],
        pendingPermissions: new Map(),
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

  /** 入环 + 广播。超出上限时发 resync：宁可让渲染层整会话重拉，也不悄悄丢事件 */
  private emit(s: HostSession, event: AgentEvent): void {
    const seq = s.seq.next()
    s.ring.push({ seq, event })
    if (s.ring.length > EVENT_RING_LIMIT) {
      s.ring.splice(0, s.ring.length - EVENT_RING_LIMIT)
      this.pushAndBroadcast(s, { type: 'resync', sessionId: s.sessionId, reason: 'ring-overflow' })
    } else {
      this.broadcast({ seq, event })
    }
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
    this.emit(s, { type: 'message.added', sessionId: s.sessionId, message })
  }

  private buildPorts(s: HostSession, cmd: Extract<AgentCommand, { type: 'run' }>, settings: AgentSettings): AgentPorts {
    const sessionId = s.sessionId
    const ctx = this.contexts.get(sessionId)

    return {
      sessionId,
      settings,
      model: {
        stream: (body, signal) => openChatStream(
          {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            apiCompat: settings.apiCompat || 'openai',
            directFetch: settings.directFetch,
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
          const base = s.messages.get(msgId)
          if (base) {
            const next = { ...base, ...updates }
            s.messages.set(msgId, next)
            void this.store.updateMessage(
              next.id,
              next.content,
              next.toolCalls ? JSON.stringify(next.toolCalls) : undefined,
              next.toolResults ? JSON.stringify(next.toolResults) : undefined,
              next.thinkingContent || null,
              next.finishReason || null
            ).catch((err) => console.error('[agent-host] updateMessage failed:', err))
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
        confirm: (title, body) => this.requestPermission(s, title, body, settings.approvalMode),
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
      env: {
        platform: process.platform,
        osDescription: describeOs(),
        shellDescription: process.platform === 'win32' ? 'PowerShell, cmd' : 'zsh, bash',
        isDev: !isPackaged(),
        homeDir: () => os.homedir(),
        readFile: (path) => fs.readFile(path, 'utf-8'),
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

  /** fail-closed：无可用窗口立即拒绝；挂起超时同样拒绝 */
  private requestPermission(s: HostSession, title: string, body: string, mode: AgentSettings['approvalMode']): Promise<boolean> {
    const sessionId = s.sessionId
    if (!this.hasLiveWindow()) {
      console.warn('[agent-host] 无可用窗口，危险操作按拒绝处理（fail-closed）:', title)
      return Promise.resolve(false)
    }
    const requestId = makeId()
    const event: AgentEvent = {
      type: 'permission.requested',
      sessionId,
      requestId,
      preview: body,
      risk: 'dangerous',
      mode: mode === 'manual' || mode === 'auto' || mode === 'full' ? mode : 'manual',
    }
    this.emit(s, event)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!s.pendingPermissions.delete(requestId)) return
        console.warn(`[agent-host] 审批超时 ${Math.round(PERMISSION_TIMEOUT_MS / 1000)}s，按拒绝处理: ${title}`)
        resolve(false)
      }, PERMISSION_TIMEOUT_MS)
      s.pendingPermissions.set(requestId, { resolve, timer, event })
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

  /** 渲染层 → 宿主的指令入口。返回值只表示是否受理，运行结果一律走事件。 */
  async handleCommand(cmd: AgentCommand, meta: { remote?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    // 远程通道（WebUI /api/invoke 传 event=null）可回执审批，必须留痕便于事后追责
    if (meta.remote && (cmd.type === 'permission.resolve' || cmd.type === 'question.resolve')) {
      console.log(`[agent-host][audit] remote ${cmd.type} session=${cmd.sessionId} request=${cmd.requestId}`)
    }
    const s = this.session(cmd.sessionId)
    switch (cmd.type) {
      case 'run':
        return this.startRun(s, cmd)
      case 'abort': {
        if (!s.run) return { ok: false, error: 'no-run' }
        s.run.controller.abort()
        return { ok: true }
      }
      case 'queue.enqueue':
        this.setQueue(s, [...s.queue, cmd.item])
        return { ok: true }
      case 'queue.remove':
        this.setQueue(s, s.queue.filter((item) => item.id !== cmd.id))
        return { ok: true }
      case 'queue.flush': {
        // 立即发送队首：先中断当前 run 并等它释放，与渲染层 sendQueuedNow 语义一致
        if (s.run) {
          s.run.controller.abort()
          for (let i = 0; i < 100 && s.run; i++) await new Promise((r) => setTimeout(r, 50))
        }
        void this.flushQueue(s)
        return { ok: true }
      }
      case 'permission.resolve': {
        const pending = s.pendingPermissions.get(cmd.requestId)
        if (!pending) return { ok: false, error: 'stale-request' }
        clearTimeout(pending.timer)
        s.pendingPermissions.delete(cmd.requestId)
        pending.resolve(cmd.approved === true)
        s.status = 'working'
        this.emit(s, { type: 'run.status', sessionId: s.sessionId, status: s.status })
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
      default:
        return { ok: false, error: 'unknown-command' }
    }
  }

  private setQueue(s: HostSession, items: QueuedMessageItem[]): void {
    s.queue = items
    this.emit(s, { type: 'queue.snapshot', sessionId: s.sessionId, items })
  }

  private async startRun(s: HostSession, cmd: Extract<AgentCommand, { type: 'run' }>): Promise<{ ok: boolean; error?: string }> {
    if (!cmd.settings) return { ok: false, error: MISSING_SETTINGS }
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
    const settings = cmd.settings
    this.snapshots.set(sessionId, cmd)
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
    const ports = this.buildPorts(s, cmd, settings)

    try {
      await runReactLoop(ports, ctx, initialMessages, controller, cmd.taskMode, cmd.skillReminder)
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
      for (const p of s.pendingPermissions.values()) pendingPermissions.push(p.event)
      for (const q of s.pendingQuestions.values()) pendingPermissions.push(q.event)
      for (const item of s.ring) {
        if (item.seq > sinceSeq) this.broadcast({ seq: item.seq, event: item.event })
        if (item.seq > lastSeq) lastSeq = item.seq
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
}

function describeOs(): string {
  const release = os.release()
  if (process.platform === 'win32') return release.startsWith('10.') ? 'Windows 10/11' : `Windows ${release}`
  if (process.platform === 'darwin') return `macOS ${release}`
  return 'Linux'
}

/** 当前可接收事件的窗口；electron 不在位（如 vitest 跑在 node 下）时返回空 */
function liveWindows(): BrowserWindow[] {
  try {
    const electron = require('electron') as { BrowserWindow?: { getAllWindows(): BrowserWindow[] } }
    return electron.BrowserWindow?.getAllWindows().filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed()) ?? []
  } catch {
    return []
  }
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
