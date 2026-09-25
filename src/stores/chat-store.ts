import { create } from 'zustand'
import { ipc } from '../lib/ipc-client'
import type { HarnessMode, Message, MessageAttachment, MessageSkillSnapshot, Session, TaskMode, ToolCall, ToolResult } from '../types/agent'
import { normalizeHarnessMode } from '../lib/harness-modes'
import { deriveSessionTitle, mapMessageRows, messageToRow, messageUpdateArgs, NEW_SESSION_TITLE } from '../lib/chat-row'
import type { SessionRow } from '../types/ipc'
import { useInteractiveStore } from './interactive-store'

export type SessionStatus = 'working' | 'error' | 'confirm-danger'

/**
 * 模块级 per-session AbortController 注册表。
 * 不放入 Zustand state：controller 是命令式对象，进 state 会触发无谓渲染且无法被序列化。
 * 多会话并发时，每个会话的 ReAct 循环通过 sessionId 取回自己的 controller。
 */
const sessionAbortControllers = new Map<string, AbortController>()

function logPersistenceFailure(operation: string, promise: Promise<unknown>): void {
  void promise.catch((error) => console.error(`[chat-store] ${operation} failed:`, error))
}

const pendingMessageWrites = new Map<string, { sessionId: string; timer: ReturnType<typeof setTimeout> }>()

function persistMessageUpdate(message: Message): void {
  logPersistenceFailure('update message', ipc.dbUpdateMessage(...messageUpdateArgs(message)))
}

function scheduleMessagePersistence(sessionId: string, message: Message, immediately: boolean): void {
  const pending = pendingMessageWrites.get(message.id)
  if (pending) {
    clearTimeout(pending.timer)
    pendingMessageWrites.delete(message.id)
  }

  if (immediately) {
    persistMessageUpdate(message)
    return
  }

  const timer = setTimeout(() => {
    pendingMessageWrites.delete(message.id)
    persistMessageUpdate(message)
  }, 300)
  pendingMessageWrites.set(message.id, { sessionId, timer })
}

function cancelPendingMessageWrites(sessionId: string): void {
  for (const [messageId, pending] of pendingMessageWrites) {
    if (pending.sessionId !== sessionId) continue
    clearTimeout(pending.timer)
    pendingMessageWrites.delete(messageId)
  }
}

/** 获取指定会话的 AbortController（可能为 undefined） */
export function getSessionAbortController(sessionId: string): AbortController | undefined {
  return sessionAbortControllers.get(sessionId)
}

/** 上次同步时记录的 DB 全局修订号；revision 未变时 syncFromDb 直接跳过全量比对 */
let lastSyncedRevision = -1

/**
 * 判断是否为可清理的空会话。
 * 空会话不再持久化（createSession 只建内存会话，首条消息落库时由
 * dbAddMessage 自愈补建会话行），因此 DB 中出现的空会话均为遗留垃圾，
 * 任何时点都可安全删除；内存中非 active 的空会话同样是垃圾。
 */
const isEmptySession = (s: Session): boolean =>
  s.messages.length === 0 && s.title === NEW_SESSION_TITLE

/** 写入指定会话的 AbortController；若传入 null 则清除 */
export function setSessionAbortController(sessionId: string, controller: AbortController | null): void {
  if (controller) {
    sessionAbortControllers.set(sessionId, controller)
  } else {
    sessionAbortControllers.delete(sessionId)
  }
}

interface ChatState {
  sessions: Session[]
  activeSessionId: string | null
  // 当前所有正在 streaming 的会话 id 集合（支持多会话并发）
  streamingSessionIds: Set<string>
  // per-session 工作状态：用于侧边栏 loading 圈显示与系统通知触发
  sessionStatus: Record<string, SessionStatus>
  // per-session 排队消息：AI 运行中用户发送的消息，run 正常结束后 FIFO 逐条自动发出。
  // 内存态不持久化：重启后无 ReAct 循环在跑，排队语义已失效。
  queuedMessages: Record<string, QueuedMessageItem[]>
  // 用户曾选过的文件夹历史（全局、跨会话、唯一），按时间倒序，最多 8 个
  recentsFolders: string[]
  initialized: boolean
  createSession: (opts?: { activate?: boolean; title?: string; workingDir?: string }) => string
  setActiveSession: (id: string) => void
  addMessage: (sessionId: string, message: Message) => void
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void
  updateSessionWorkingDir: (sessionId: string, dir: string) => void
  /** 设定会话的 harness 模式：仅会话尚未开始（无消息）时允许，开始后锁定 */
  setSessionHarnessMode: (sessionId: string, mode: HarnessMode) => void
  /** 添加一个 recent folder，置顶，去重，最多保留 8 个。同步持久化到 DB。 */
  pushRecentFolder: (dir: string) => Promise<void>
  setStreaming: (streaming: boolean, sessionId?: string) => void
  setSessionStatus: (sessionId: string, status: SessionStatus | null) => void
  deleteSession: (id: string) => void
  compactSession: (sessionId: string, newMessages: Message[], deleteBeforeId: string) => void
  enqueueQueuedMessage: (sessionId: string, item: QueuedMessageItem) => void
  removeQueuedMessage: (sessionId: string, id: string) => void
  dequeueQueuedMessage: (sessionId: string) => QueuedMessageItem | undefined
  requeueQueuedMessage: (sessionId: string, item: QueuedMessageItem) => void
  loadFromDb: () => Promise<void>
  /** 增量同步：从 DB 拉取最新会话/消息，合并进内存状态（跳过正在流式的会话，避免覆盖本地流式内容） */
  syncFromDb: () => Promise<void>
  /**
   * 宿主模式专用：把单个会话整段按 DB 为准重拉（环溢出 / 压缩后的 resync 走这里）。
   * 不能用 syncFromDb——它对「流式中」的会话刻意保留本地内存，而宿主模式下运行中的会话
   * 恰恰是必须重拉的那个：宿主先落库再广播，本地从来不是权威源。
   */
  reloadSessionFromDb: (sessionId: string) => Promise<void>

  // ── 宿主模式回灌（批次 B · P4）：只改内存，一律不落库——运行期持久化由宿主独占 ──
  /** 幂等 upsert：整环回放必然与 DB 已加载的消息重叠，重复投递不能长出两条 */
  remoteUpsertMessage: (sessionId: string, message: Message) => void
  remoteUpdateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void
  remoteAppendContent: (sessionId: string, messageId: string, text: string) => void
  /** 宿主的 queue.snapshot 是全量视图，整段替换本地队列 */
  setQueuedMessages: (sessionId: string, items: QueuedMessageItem[]) => void
  /** 宿主广播的运行期失败：宿主模式下错误横幅的数据源（本地路径仍用 useAgent 的 error） */
  sessionErrors: Record<string, string | undefined>
  setSessionError: (sessionId: string, error?: string) => void
}

/** 排队消息条目：字段与 sendMessage 入参对齐，自动发出时原样透传 */
export interface QueuedMessageItem {
  id: string
  content: string
  attachments?: MessageAttachment[]
  taskMode?: TaskMode
  skills?: MessageSkillSnapshot[]
  queuedAt: number
}

/** Format timestamp as YYYYMMDD-HHmmss */
const formatTimestamp = (ts: number): string => {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Get platform-aware default working directory base */
const getDefaultWorkDirBase = (): { base: string; sep: string } => {
  try {
    // 使用 ipc 抽象层，兼容 Electron 与 WebUI 两种模式
    const platform = ipc.platform()
    const home = ipc.homeDir() || ''
    if (platform === 'darwin') return { base: home ? `${home}/clerkbox-work` : '/tmp/clerkbox-work', sep: '/' }
    if (platform === 'linux') return { base: home ? `${home}/clerkbox-work` : '/tmp/clerkbox-work', sep: '/' }
    return { base: home ? `${home}\\clerkbox-work` : 'C:\\clerkbox-work', sep: '\\' }
  } catch {
    return { base: 'C:\\clerkbox-work', sep: '\\' }
  }
}

function comparableFolderPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

/**
 * 从 DB 会话行恢复工作目录字段（loadFromDb / syncFromDb 共用）。
 * 老数据行没有这两个字段：defaultWorkDir 按 created_at 确定性回填——
 * createEmptySession 生成 defaultWorkDir 用的正是创建时间戳，同参重建结果一致。
 */
function restoreWorkDirs(row: SessionRow): { workingDir?: string; defaultWorkDir?: string } {
  const workingDir = row.working_dir || undefined
  let defaultWorkDir = row.default_work_dir || undefined
  if (!defaultWorkDir) {
    const { base, sep } = getDefaultWorkDirBase()
    defaultWorkDir = `${base}${sep}${formatTimestamp(row.created_at)}`
  }
  return { workingDir, defaultWorkDir }
}

const createEmptySession = (): Session => {
  const now = Date.now()
  const { base, sep } = getDefaultWorkDirBase()
  return {
    id: `sess-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: NEW_SESSION_TITLE,
    defaultWorkDir: `${base}${sep}${formatTimestamp(now)}`,
    messages: [],
    createdAt: now,
    updatedAt: now,
    harnessMode: 'default',
  }
}

/** 是否为「刚建的内存会话」（尚未写过消息）：可安全替换标题/目录，不污染历史 */
const isPristineSession = (s: Session): boolean =>
  s.messages.length === 0 && s.title === NEW_SESSION_TITLE

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  streamingSessionIds: new Set(),
  sessionStatus: {},
  queuedMessages: {},
  recentsFolders: [],
  initialized: false,
  sessionErrors: {},

  enqueueQueuedMessage: (sessionId, item) =>
    set((state) => ({
      queuedMessages: { ...state.queuedMessages, [sessionId]: [...(state.queuedMessages[sessionId] ?? []), item] },
    })),

  removeQueuedMessage: (sessionId, id) =>
    set((state) => {
      const queue = state.queuedMessages[sessionId]
      if (!queue?.some((q) => q.id === id)) return state
      return { queuedMessages: { ...state.queuedMessages, [sessionId]: queue.filter((q) => q.id !== id) } }
    }),

  dequeueQueuedMessage: (sessionId) => {
    const queue = get().queuedMessages[sessionId]
    if (!queue || queue.length === 0) return undefined
    const [head, ...rest] = queue
    set((state) => ({ queuedMessages: { ...state.queuedMessages, [sessionId]: rest } }))
    return head
  },

  requeueQueuedMessage: (sessionId, item) =>
    set((state) => ({
      queuedMessages: { ...state.queuedMessages, [sessionId]: [item, ...(state.queuedMessages[sessionId] ?? [])] },
    })),

  loadFromDb: async () => {
    try {
      const rows = await ipc.dbGetAllSessions()
      const sessions: Session[] = []
      for (const row of rows) {
        const msgRows = await ipc.dbGetMessages(row.id)
        // 空会话不再落库，DB 里的空壳全是遗留垃圾，启动时直接清掉
        if (msgRows.length === 0 && row.title === NEW_SESSION_TITLE) {
          logPersistenceFailure('delete empty session', ipc.dbDeleteSession(row.id))
          continue
        }
        sessions.push({
          id: row.id,
          title: row.title,
          messages: mapMessageRows(msgRows),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          harnessMode: normalizeHarnessMode(row.harness_mode),
          ...restoreWorkDirs(row),
        })
      }
      // 按 updatedAt 降序排序，使最近更新的会话排在最前，与新建会话时的 prepend 行为一致
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)

      // 启动时默认创建一个新会话（纯内存，发首条消息时才落库）
      const newSession = createEmptySession()

      // 加载用户曾选过的文件夹历史
      const recentsFolders = await ipc.dbGetRecents().catch(() => [])

      set({
        sessions: [newSession, ...sessions],
        activeSessionId: newSession.id,
        recentsFolders,
        initialized: true,
      })
    } catch {
      set({ initialized: true })
    }
  },

  syncFromDb: async () => {
    try {
      // 廉价短路：DB 全局修订号未变 → 无任何写入，跳过全量比对
      const revision = await ipc.dbGetRevision()
      if (revision === lastSyncedRevision) return

      const rows = await ipc.dbGetAllSessions()
      const state = get()
      // 正在流式的会话不能被 DB 覆盖（本地流式内容比 DB 更新）
      const streaming = state.streamingSessionIds
      const dbMap = new Map(rows.map((r) => [r.id, r]))
      const localMap = new Map(state.sessions.map((s) => [s.id, s]))

      const merged: Session[] = []
      const seen = new Set<string>()

      // 合并 DB 中的会话
      for (const row of rows) {
        seen.add(row.id)
        const local = localMap.get(row.id)
        if (streaming.has(row.id) && local) {
          // 流式中：保留本地内存状态
          merged.push(local)
          continue
        }
        // title 仍为'新会话'的 DB 会话：空会话不再落库，这些是遗留垃圾，
        // 拉消息确认后直接删除（有消息的'新会话'正常保留）
        if (row.title === NEW_SESSION_TITLE) {
          const msgRows = await ipc.dbGetMessages(row.id)
          if (msgRows.length === 0) {
            logPersistenceFailure('delete empty session', ipc.dbDeleteSession(row.id))
            continue
          }
          const restored = restoreWorkDirs(row)
          merged.push({
            id: row.id,
            title: row.title,
            messages: mapMessageRows(msgRows),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            harnessMode: normalizeHarnessMode(row.harness_mode),
            workingDir: restored.workingDir || local?.workingDir,
            defaultWorkDir: restored.defaultWorkDir || local?.defaultWorkDir,
          })
          continue
        }
        // DB 有更新（updatedAt 变化）或本地没有该会话 → 从 DB 拉取消息。
        // 注意：本地 updatedAt >= DB 行时不拉 —— 本地写入后 row.updated_at 用的是
        // message.timestamp，必然 ≤ 本地 Date.now()，直接拉会用 debounce 未落盘
        // 的旧数据覆盖本地新内容（思考内容闪回）。远端更新总会 bump 到更大的时间戳。
        if (!local || local.updatedAt < row.updated_at) {
          const msgRows = await ipc.dbGetMessages(row.id)
          const restored = restoreWorkDirs(row)
          merged.push({
            id: row.id,
            title: row.title,
            messages: mapMessageRows(msgRows),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            harnessMode: normalizeHarnessMode(row.harness_mode),
            workingDir: restored.workingDir || local?.workingDir,
            defaultWorkDir: restored.defaultWorkDir || local?.defaultWorkDir,
          })
        } else {
          merged.push(local)
        }
      }

      // 保留本地有但 DB 没有的会话（可能是刚创建还没持久化完成的）
      for (const s of state.sessions) {
        if (!seen.has(s.id)) merged.push(s)
      }

      // 按 updatedAt 降序排序
      merged.sort((a, b) => b.updatedAt - a.updatedAt)

      // 同步 recentsFolders
      const recentsFolders = await ipc.dbGetRecents().catch(() => state.recentsFolders)

      set({ sessions: merged, recentsFolders })
      lastSyncedRevision = revision
    } catch (e) {
      console.error('[chat-store] syncFromDb failed:', e)
    }
  },

  reloadSessionFromDb: async (sessionId) => {
    try {
      const [msgRows, sessionRows] = await Promise.all([
        ipc.dbGetMessages(sessionId),
        ipc.dbGetAllSessions().catch(() => []),
      ])
      const local = get().sessions.find((s) => s.id === sessionId)
      if (!local) return
      const row = sessionRows.find((r) => r.id === sessionId)
      const restored = row ? restoreWorkDirs(row) : {}
      const messages = mapMessageRows(msgRows)
      set((state) => ({
        sessions: state.sessions.map((item) =>
          item.id !== sessionId
            ? item
            : {
                ...item,
                messages,
                // 宿主改名的落库是异步的：DB 仍写着待命名哨兵时保留本地已改的标题，避免横幅闪回
                title: row && row.title !== NEW_SESSION_TITLE ? row.title : item.title,
                workingDir: restored.workingDir ?? item.workingDir,
                defaultWorkDir: restored.defaultWorkDir ?? item.defaultWorkDir,
              }
        ),
      }))
    } catch (e) {
      console.error('[chat-store] reloadSessionFromDb failed:', e)
    }
  },

  createSession: (opts) => {
    const activate = opts?.activate !== false
    const session = createEmptySession()
    set((state) => {
      // 空会话不落库：没发过消息的新会话刷新/关闭即消失，不再堆积在历史记录里。
      // 首条消息落库时由 dbAddMessage 的自愈逻辑补建会话行。
      // 顺带清掉内存里其他空会话（连点新建只保留最新一个），
      // 若历史版本把它们写进过 DB 也一并删除。
      const cleanedSessions = state.sessions.filter((s) => !isEmptySession(s))
      for (const s of state.sessions) {
        if (isEmptySession(s)) {
          logPersistenceFailure('delete empty session', ipc.dbDeleteSession(s.id))
        }
      }
      return {
        sessions: [session, ...cleanedSessions],
        // activate=false（定时任务后台会话）：不抢占用户当前视图
        ...(activate ? { activeSessionId: session.id } : {}),
      }
    })
    // 任务会话携带标题/工作目录：还没说过话的会话可直接塑形（不写入空标题行）
    if (opts?.title || opts?.workingDir) {
      set((state) => ({
        sessions: state.sessions.map((s) => {
          if (s.id !== session.id || !isPristineSession(s)) return s
          return {
            ...s,
            title: opts.title || s.title,
            ...(opts.workingDir ? { workingDir: opts.workingDir } : {}),
          }
        }),
      }))
    }
    return session.id
  },

  setActiveSession: (id) => {
    set((state) => {
      // 切走时清掉非 active 的空会话（没说过话的会话不配留在历史记录里）
      const cleanedSessions = state.sessions.map((s) => {
        if (s.id !== id && isEmptySession(s)) {
          logPersistenceFailure('delete empty session', ipc.dbDeleteSession(s.id))
          return null
        }
        return s
      }).filter(Boolean) as Session[]

      // If the target session was deleted, pick the first one
      const targetExists = cleanedSessions.some((s) => s.id === id)
      return {
        sessions: targetExists ? cleanedSessions : cleanedSessions,
        activeSessionId: targetExists ? id : (cleanedSessions.length > 0 ? cleanedSessions[0].id : null),
      }
    })
  },

  addMessage: (sessionId, message) => {
    const now = Date.now()
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, message], updatedAt: now }
          : s
      ),
    }))
    // 首条消息落库前先补建精确会话行（含 createdAt / 工作目录）。
    // 否则只能靠 dbAddMessage 自愈补建，created_at 会退化成首条消息时间戳，
    // defaultWorkDir 也无法恢复，重启后 AI 的默认工作目录会漂移。
    const sessionBefore = get().sessions.find((s) => s.id === sessionId)
    if (sessionBefore && sessionBefore.messages.length === 1) {
      logPersistenceFailure('create session row', ipc.dbCreateSession({
        id: sessionId,
        title: sessionBefore.title,
        created_at: sessionBefore.createdAt,
        updated_at: now,
        working_dir: sessionBefore.workingDir ?? null,
        default_work_dir: sessionBefore.defaultWorkDir ?? null,
        harness_mode: sessionBefore.harnessMode ?? 'default',
      }))
    }
    logPersistenceFailure('add message', ipc.dbAddMessage(messageToRow(message, sessionId)))
    // Auto-update session title from first user message
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session && session.title === NEW_SESSION_TITLE && message.role === 'user') {
      const newTitle = deriveSessionTitle(message.content)
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, title: newTitle } : s
        ),
      }))
      logPersistenceFailure('update session title', ipc.dbUpdateSessionTitle(sessionId, newTitle, Date.now()))
    }
  },

  updateMessage: (sessionId, messageId, updates) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              messages: s.messages.map((m) => (m.id === messageId ? { ...m, ...updates } : m)),
              updatedAt: Date.now(),
            }
          : s
      ),
    }))
    // Persist streaming updates in short batches to avoid rewriting the full DB for every chunk.
    const msg = get().sessions.find((s) => s.id === sessionId)?.messages.find((m) => m.id === messageId)
    if (msg) {
      scheduleMessagePersistence(sessionId, msg, msg._isStreaming !== true)
    }
  },

  /** 宿主事件回灌：幂等 upsert（同 id 合并而不是追加），并沿用同一套会话标题规则 */
  remoteUpsertMessage: (sessionId, message) => {
    const now = Date.now()
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const index = s.messages.findIndex((m) => m.id === message.id)
        const messages =
          index === -1 ? [...s.messages, message] : s.messages.map((m, i) => (i === index ? { ...m, ...message } : m))
        const renamed =
          index === -1 && message.role === 'user' && s.title === NEW_SESSION_TITLE ? deriveSessionTitle(message.content) : s.title
        return { ...s, messages, title: renamed, updatedAt: now }
      }),
    }))
  },

  remoteUpdateMessage: (sessionId, messageId, updates) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: s.messages.map((m) => (m.id === messageId ? { ...m, ...updates } : m)), updatedAt: Date.now() }
          : s
      ),
    }))
  },

  /** 流式增量：只长内容，落库由宿主负责 */
  remoteAppendContent: (sessionId, messageId, text) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: s.messages.map((m) => (m.id === messageId ? { ...m, content: m.content + text } : m)) }
          : s
      ),
    }))
  },

  setQueuedMessages: (sessionId, items) =>
    set((state) => ({
      queuedMessages: { ...state.queuedMessages, [sessionId]: items },
    })),

  setSessionError: (sessionId, error) =>
    set((state) => ({
      sessionErrors: { ...state.sessionErrors, [sessionId]: error },
    })),

  setStreaming: (streaming, sessionId) => {
    const sid = sessionId || get().activeSessionId
    if (!sid) return
    set((state) => {
      const next = new Set(state.streamingSessionIds)
      if (streaming) {
        next.add(sid)
      } else {
        next.delete(sid)
      }
      // 仅在集合实际变化时返回新引用，避免无谓渲染
      if (next.size === state.streamingSessionIds.size) {
        const had = state.streamingSessionIds.has(sid)
        if (had === streaming) return state
      }
      return { streamingSessionIds: next }
    })
  },

  setSessionStatus: (sessionId, status) => {
    set((state) => {
      if (status === null) {
        if (!(sessionId in state.sessionStatus)) return state
        const next = { ...state.sessionStatus }
        delete next[sessionId]
        return { sessionStatus: next }
      }
      if (state.sessionStatus[sessionId] === status) return state
      return { sessionStatus: { ...state.sessionStatus, [sessionId]: status } }
    })
  },

  updateSessionWorkingDir: (sessionId, dir) => {
    const now = Date.now()
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, workingDir: dir, updatedAt: now } : s
      ),
    }))
    // 空会话不落库：后台同步会清理没有消息的「新会话」行，提前写入会导致
    // 刚选中的目录先显示、随后又被同步清掉。首条消息落库时会带上 workingDir。
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session && session.messages.length > 0) {
      logPersistenceFailure('update session working dir', ipc.dbCreateSession({
        id: sessionId,
        title: session.title,
        created_at: session.createdAt,
        updated_at: now,
        working_dir: dir,
        default_work_dir: session.defaultWorkDir ?? null,
        harness_mode: session.harnessMode ?? 'default',
      }))
    }
  },

  setSessionHarnessMode: (sessionId, mode) => {
    // 模式锁定：会话已产出消息后不可变更（与 dsh 官方 preset 语义一致，
    // 也保证静态 system 段跨请求字节稳定）。空会话纯内存态，不落库——
    // 首条消息落库时 addMessage 会把 harnessMode 写入会话行。
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId && s.messages.length === 0 ? { ...s, harnessMode: mode } : s
      ),
    }))
  },

  pushRecentFolder: async (dir) => {
    // Keep POSIX paths case-sensitive while matching Windows paths case-insensitively.
    const comparableDir = comparableFolderPath(dir)
    const next = [dir, ...get().recentsFolders.filter((path) => comparableFolderPath(path) !== comparableDir)]
    if (next.length > 8) next.length = 8
    set({ recentsFolders: next })
    await ipc.dbSetRecents(next).catch(() => { /* 持久化失败不阻塞 UI */ })
  },

  deleteSession: (id) =>
    set((state) => {
      cancelPendingMessageWrites(id)
      const filtered = state.sessions.filter((s) => s.id !== id)
      logPersistenceFailure('delete session', ipc.dbDeleteSession(id))
      // 中止并清理该会话的 AbortController，防止泄漏与僵尸 ReAct 循环
      const ctrl = sessionAbortControllers.get(id)
      if (ctrl) {
        try { ctrl.abort() } catch { /* ignore */ }
        sessionAbortControllers.delete(id)
      }
      // 杀掉该会话在主进程里还在跑的 shell 子进程，避免点中断后命令继续执行
      logPersistenceFailure('cancel session commands', ipc.cancelSessionCommands(id))
      // 该会话若还挂着未回答的 question：resolve 掉（空答案）。否则工具侧
      // await requestQuestion 的 Promise 永不返回，ReAct 循环闭包与
      // interactive-store 的 resolver 条目永久悬挂。
      useInteractiveStore.getState().cancelQuestion(id)
      // Remove related subagent runs so persisted storage does not accumulate stale records.
      // clearSession 之前是 dead code，现在被接通了。
      import('./agent-runs-store').then(({ useAgentRunsStore }) => {
        useAgentRunsStore.getState().clearSession(id)
      }).catch((e) => console.error('Failed to clear agent runs for session:', e))
      // 同步清理 per-session 工作状态与 streaming 标记
      const nextStatus = { ...state.sessionStatus }
      delete nextStatus[id]
      // 清空该会话的排队消息（会话没了，排队语义随之失效）
      const nextQueued = { ...state.queuedMessages }
      delete nextQueued[id]
      const nextStreaming = new Set(state.streamingSessionIds)
      nextStreaming.delete(id)
      return {
        sessions: filtered,
        sessionStatus: nextStatus,
        queuedMessages: nextQueued,
        streamingSessionIds: nextStreaming,
        activeSessionId:
          state.activeSessionId === id
            ? filtered.length > 0
              ? filtered[0].id
              : null
            : state.activeSessionId,
      }
    }),

  compactSession: (sessionId, newMessages, deleteBeforeId) => {
    // 1. Update in-memory state
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: newMessages, updatedAt: Date.now() }
          : s
      ),
    }))

    // 2. 清空该 session 在 DB 中的全部消息，然后整体重写 newMessages。
    //    旧实现用 dbDeleteMessagesBefore(deleteBeforeId) + dbAddMessage(newMessages)，
    //    但 deleteBeforeId 是新创建的 boundaryMessage.id（不在 DB 中），导致 findIndex 返回 -1 直接 return 什么也不删；
    //    而 dbAddMessage 是纯 push 无 UPSERT，keptMessages 会被重复写入，重启后历史翻倍。
    //    改为「清空再重写」是最稳妥的方案。
    // 2. 原子压缩：主进程在单次写入内整体替换该 session 的消息列表
    //    （tmp+rename 原子落盘）。旧「清空再逐条重写」两步间崩溃会丢全会话历史，
    //    现在最坏情况只是压缩未生效，数据不会丢失。
    cancelPendingMessageWrites(sessionId)
    logPersistenceFailure('compact messages', ipc.dbCompactMessages(
      sessionId,
      newMessages.map((msg) => messageToRow(msg, sessionId))
    ))
  },
}))
