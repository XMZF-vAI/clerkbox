import { create } from 'zustand'
import { ipc } from '../lib/ipc-client'
import type { Message, Session, ToolCall, ToolResult } from '../types/agent'

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

function persistMessageUpdate(sessionId: string, message: Message): void {
  logPersistenceFailure('update message', ipc.dbUpdateMessage(
    message.id,
    message.content,
    message.toolCalls ? JSON.stringify(message.toolCalls) : undefined,
    message.toolResults ? JSON.stringify(message.toolResults) : undefined,
    message.thinkingContent || null,
    message.finishReason || null
  ))
}

function scheduleMessagePersistence(sessionId: string, message: Message, immediately: boolean): void {
  const pending = pendingMessageWrites.get(message.id)
  if (pending) {
    clearTimeout(pending.timer)
    pendingMessageWrites.delete(message.id)
  }

  if (immediately) {
    persistMessageUpdate(sessionId, message)
    return
  }

  const timer = setTimeout(() => {
    pendingMessageWrites.delete(message.id)
    persistMessageUpdate(sessionId, message)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseToolCalls(value: string | null | undefined): ToolCall[] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return undefined
    return parsed.flatMap((item) =>
      isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' && isRecord(item.arguments)
        ? [{ id: item.id, name: item.name, arguments: item.arguments }]
        : []
    )
  } catch {
    return undefined
  }
}

function parseToolResults(value: string | null | undefined): ToolResult[] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return undefined
    return parsed.flatMap((item) =>
      isRecord(item) && typeof item.toolCallId === 'string' && typeof item.content === 'string'
        ? [{
            toolCallId: item.toolCallId,
            content: item.content,
            ...(typeof item.isError === 'boolean' ? { isError: item.isError } : {}),
          }]
        : []
    )
  } catch {
    return undefined
  }
}

/** 把 DB 消息行映射为内存 Message 结构（loadFromDb / syncFromDb 共用） */
function mapMessageRows(msgRows: import('../types/ipc').MessageRow[]): Message[] {
  return msgRows.map((m) => ({
    id: m.id,
    role: ['user', 'assistant', 'system', 'tool'].includes(m.role) ? m.role as Message['role'] : 'assistant',
    content: m.content || '',
    thinkingContent: m.thinking_content || undefined,
    timestamp: m.timestamp,
    toolCalls: parseToolCalls(m.tool_calls),
    toolResults: parseToolResults(m.tool_results),
    finishReason: m.finish_reason || undefined,
    isCompactSummary: m.is_compact === 1 ? true : undefined,
    isSubAgentCard: m.is_sub_agent_card === 1 ? true : undefined,
    subAgentId: m.sub_agent_id || undefined,
  }))
}

/** 获取指定会话的 AbortController（可能为 undefined） */
export function getSessionAbortController(sessionId: string): AbortController | undefined {
  return sessionAbortControllers.get(sessionId)
}

/** 上次同步时记录的 DB 全局修订号；revision 未变时 syncFromDb 直接跳过全量比对 */
let lastSyncedRevision = -1

/**
 * 判断空"新会话"是否陈旧可删。
 * 双端（桌面/WebUI）各自启动时都会建一个空会话 —— 10 分钟内的空会话可能是
 * 另一端正活跃的，误删会让该端后续消息变孤儿；只有陈旧的空壳才值得清理。
 */
const STALE_EMPTY_MS = 10 * 60 * 1000
const isStaleEmptySession = (s: Session): boolean =>
  s.messages.length === 0 &&
  s.title === '新会话' &&
  Date.now() - Math.max(s.updatedAt, s.createdAt) > STALE_EMPTY_MS

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
  // 用户曾选过的文件夹历史（全局、跨会话、唯一），按时间倒序，最多 8 个
  recentsFolders: string[]
  initialized: boolean
  createSession: () => string
  setActiveSession: (id: string) => void
  addMessage: (sessionId: string, message: Message) => void
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void
  updateSessionWorkingDir: (sessionId: string, dir: string) => void
  /** 添加一个 recent folder，置顶，去重，最多保留 8 个。同步持久化到 DB。 */
  pushRecentFolder: (dir: string) => Promise<void>
  setStreaming: (streaming: boolean, sessionId?: string) => void
  setSessionStatus: (sessionId: string, status: SessionStatus | null) => void
  deleteSession: (id: string) => void
  compactSession: (sessionId: string, newMessages: Message[], deleteBeforeId: string) => void
  loadFromDb: () => Promise<void>
  /** 增量同步：从 DB 拉取最新会话/消息，合并进内存状态（跳过正在流式的会话，避免覆盖本地流式内容） */
  syncFromDb: () => Promise<void>
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

const createEmptySession = (): Session => {
  const now = Date.now()
  const { base, sep } = getDefaultWorkDirBase()
  return {
    id: `sess-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: '新会话',
    defaultWorkDir: `${base}${sep}${formatTimestamp(now)}`,
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  streamingSessionIds: new Set(),
  sessionStatus: {},
  recentsFolders: [],
  initialized: false,

  loadFromDb: async () => {
    try {
      const rows = await ipc.dbGetAllSessions()
      const sessions: Session[] = []
      for (const row of rows) {
        const msgRows = await ipc.dbGetMessages(row.id)
        sessions.push({
          id: row.id,
          title: row.title,
          messages: mapMessageRows(msgRows),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      }
      // 按 updatedAt 降序排序，使最近更新的会话排在最前，与新建会话时的 prepend 行为一致
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)

      // 启动时默认创建一个新会话，只清理陈旧空会话（新空会话可能是另一端活跃的）
      const newSession = createEmptySession()
      const cleanedSessions = sessions.filter((s) => !isStaleEmptySession(s))
      for (const s of sessions) {
        if (isStaleEmptySession(s)) {
          logPersistenceFailure('delete empty session', ipc.dbDeleteSession(s.id))
        }
      }

      // 加载用户曾选过的文件夹历史
      const recentsFolders = await ipc.dbGetRecents().catch(() => [])

      set({
        sessions: [newSession, ...cleanedSessions],
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
        // DB 有更新（updatedAt 变化）或本地没有该会话 → 从 DB 拉取消息。
        // 注意：本地 updatedAt >= DB 行时不拉 —— 本地写入后 row.updated_at 用的是
        // message.timestamp，必然 ≤ 本地 Date.now()，直接拉会用 debounce 未落盘
        // 的旧数据覆盖本地新内容（思考内容闪回）。远端更新总会 bump 到更大的时间戳。
        if (!local || local.updatedAt < row.updated_at) {
          const msgRows = await ipc.dbGetMessages(row.id)
          merged.push({
            id: row.id,
            title: row.title,
            messages: mapMessageRows(msgRows),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            workingDir: local?.workingDir,
            defaultWorkDir: local?.defaultWorkDir,
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

  createSession: () => {
    const session = createEmptySession()
    set((state) => {
      // Auto-delete stale empty sessions (fresh empties may belong to the other client)
      const cleanedSessions = state.sessions.filter((s) => !isStaleEmptySession(s))
      for (const s of state.sessions) {
        if (isStaleEmptySession(s)) {
          logPersistenceFailure('delete empty session', ipc.dbDeleteSession(s.id))
        }
      }
      return {
        sessions: [session, ...cleanedSessions],
        activeSessionId: session.id,
      }
    })
    logPersistenceFailure('create session', ipc.dbCreateSession({
      id: session.id,
      title: session.title,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    }))
    return session.id
  },

  setActiveSession: (id) => {
    set((state) => {
      // Auto-delete stale empty sessions when switching away (fresh ones may be another client's)
      const cleanedSessions = state.sessions.map((s) => {
        if (s.id !== id && isStaleEmptySession(s)) {
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
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: [...s.messages, message], updatedAt: Date.now() }
          : s
      ),
    }))
    logPersistenceFailure('add message', ipc.dbAddMessage({
      id: message.id,
      session_id: sessionId,
      role: message.role,
      content: message.content,
      thinking_content: message.thinkingContent || null,
      timestamp: message.timestamp,
      tool_calls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      tool_results: message.toolResults ? JSON.stringify(message.toolResults) : null,
      finish_reason: message.finishReason || null,
      is_compact: message.isCompactSummary ? 1 : 0,
      is_sub_agent_card: message.isSubAgentCard ? 1 : 0,
      sub_agent_id: message.subAgentId || null,
    }))
    // Auto-update session title from first user message
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session && session.title === '新会话' && message.role === 'user') {
      const newTitle = message.content.slice(0, 30) + (message.content.length > 30 ? '...' : '')
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
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, workingDir: dir, updatedAt: Date.now() } : s
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
      // Remove related subagent runs so persisted storage does not accumulate stale records.
      // clearSession 之前是 dead code，现在被接通了。
      import('./agent-runs-store').then(({ useAgentRunsStore }) => {
        useAgentRunsStore.getState().clearSession(id)
      }).catch((e) => console.error('Failed to clear agent runs for session:', e))
      // 同步清理 per-session 工作状态与 streaming 标记
      const nextStatus = { ...state.sessionStatus }
      delete nextStatus[id]
      const nextStreaming = new Set(state.streamingSessionIds)
      nextStreaming.delete(id)
      return {
        sessions: filtered,
        sessionStatus: nextStatus,
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
    cancelPendingMessageWrites(sessionId)
    logPersistenceFailure('clear compacted messages', ipc.dbClearMessages(sessionId))

    // 3. 写入压缩后的完整消息列表（boundary + summary + keptMessages + fileAttachments）
    for (const msg of newMessages) {
      logPersistenceFailure('write compacted message', ipc.dbAddMessage({
        id: msg.id,
        session_id: sessionId,
        role: msg.role,
        content: msg.content,
        thinking_content: msg.thinkingContent || null,
        timestamp: msg.timestamp,
        tool_calls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        tool_results: msg.toolResults ? JSON.stringify(msg.toolResults) : null,
        finish_reason: msg.finishReason || null,
        is_compact: msg.isCompactSummary ? 1 : 0,
        // Preserve subagent-card metadata when rewriting compacted history.
        is_sub_agent_card: msg.isSubAgentCard ? 1 : 0,
        sub_agent_id: msg.subAgentId || null,
      }))
    }
  },
}))
