import { create } from 'zustand'
import { ipc } from '../lib/ipc-client'
import type { Message, MessageAttachment, Session, ToolCall, ToolResult } from '../types/agent'
import type { SessionRow } from '../types/ipc'

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

/** 解析 DB 行的 attachments JSON 列（MessageAttachment[] 序列化）；可选字段缺失时容忍 */
function parseAttachments(value: string | null | undefined): MessageAttachment[] | undefined {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return undefined
    const attachments = parsed.flatMap((item) =>
      isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string'
        && typeof item.kind === 'string' && (item.kind === 'image' || item.kind === 'file')
        ? [{
            id: item.id,
            kind: item.kind as MessageAttachment['kind'],
            name: item.name,
            ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
            ...(typeof item.dataUrl === 'string' ? { dataUrl: item.dataUrl } : {}),
            ...(typeof item.path === 'string' ? { path: item.path } : {}),
            ...(typeof item.size === 'number' ? { size: item.size } : {}),
          }]
        : []
    )
    return attachments.length > 0 ? attachments : undefined
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
    attachments: parseAttachments(m.attachments),
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
 * 判断是否为可清理的空会话。
 * 空会话不再持久化（createSession 只建内存会话，首条消息落库时由
 * dbAddMessage 自愈补建会话行），因此 DB 中出现的空会话均为遗留垃圾，
 * 任何时点都可安全删除；内存中非 active 的空会话同样是垃圾。
 */
const isEmptySession = (s: Session): boolean =>
  s.messages.length === 0 && s.title === '新会话'

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
        // 空会话不再落库，DB 里的空壳全是遗留垃圾，启动时直接清掉
        if (msgRows.length === 0 && row.title === '新会话') {
          logPersistenceFailure('delete empty session', ipc.dbDeleteSession(row.id))
          continue
        }
        sessions.push({
          id: row.id,
          title: row.title,
          messages: mapMessageRows(msgRows),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
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
        if (row.title === '新会话') {
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

  createSession: () => {
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
        activeSessionId: session.id,
      }
    })
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
      }))
    }
    logPersistenceFailure('add message', ipc.dbAddMessage({
      id: message.id,
      session_id: sessionId,
      role: message.role,
      content: message.content,
      thinking_content: message.thinkingContent || null,
      timestamp: message.timestamp,
      tool_calls: message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      tool_results: message.toolResults ? JSON.stringify(message.toolResults) : null,
      attachments: message.attachments ? JSON.stringify(message.attachments) : null,
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
    const now = Date.now()
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, workingDir: dir, updatedAt: now } : s
      ),
    }))
    // 持久化：workingDir 必须落库，否则重启后 AI 的系统提示里工作目录丢失
    // （dbCreateSession 为 upsert 语义，行不存在时会补建）
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session) {
      logPersistenceFailure('update session working dir', ipc.dbCreateSession({
        id: sessionId,
        title: session.title,
        created_at: session.createdAt,
        updated_at: now,
        working_dir: dir,
        default_work_dir: session.defaultWorkDir ?? null,
      }))
    }
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
    // 2. 原子压缩：主进程在单次写入内整体替换该 session 的消息列表
    //    （tmp+rename 原子落盘）。旧「清空再逐条重写」两步间崩溃会丢全会话历史，
    //    现在最坏情况只是压缩未生效，数据不会丢失。
    cancelPendingMessageWrites(sessionId)
    logPersistenceFailure('compact messages', ipc.dbCompactMessages(
      sessionId,
      newMessages.map((msg) => ({
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
        // Preserve attachments when rewriting compacted history.
        attachments: msg.attachments ? JSON.stringify(msg.attachments) : null,
      }))
    ))
  },
}))
