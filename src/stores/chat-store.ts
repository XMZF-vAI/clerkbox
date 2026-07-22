import { create } from 'zustand'
import { ipc } from '../lib/ipc-client'
import type { Message, Session } from '../types/agent'

export type SessionStatus = 'working' | 'error' | 'confirm-danger'

interface ChatState {
  sessions: Session[]
  activeSessionId: string | null
  streamingSessionId: string | null  // Which session is currently streaming
  // per-session 工作状态：用于侧边栏 loading 圈显示与系统通知触发
  sessionStatus: Record<string, SessionStatus>
  initialized: boolean
  createSession: () => string
  setActiveSession: (id: string) => void
  addMessage: (sessionId: string, message: Message) => void
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void
  updateSessionWorkingDir: (sessionId: string, dir: string) => void
  setStreaming: (streaming: boolean, sessionId?: string) => void
  setSessionStatus: (sessionId: string, status: SessionStatus | null) => void
  deleteSession: (id: string) => void
  compactSession: (sessionId: string, newMessages: Message[], deleteBeforeId: string) => void
  loadFromDb: () => Promise<void>
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
    const platform = window?.clerkbox?.platform
    const home = window?.clerkbox?.homeDir || ''
    if (platform === 'darwin') return { base: home ? `${home}/clerkbox-work` : '/tmp/clerkbox-work', sep: '/' }
    if (platform === 'linux') return { base: home ? `${home}/clerkbox-work` : '/tmp/clerkbox-work', sep: '/' }
    return { base: home ? `${home}\\clerkbox-work` : 'C:\\clerkbox-work', sep: '\\' }
  } catch {
    return { base: 'C:\\clerkbox-work', sep: '\\' }
  }
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
  streamingSessionId: null,
  sessionStatus: {},
  initialized: false,

  loadFromDb: async () => {
    try {
      const rows = await ipc.dbGetAllSessions()
      const sessions: Session[] = []
      for (const row of rows) {
        const msgRows = await ipc.dbGetMessages(row.id)
        const messages: Message[] = msgRows.map((m) => ({
          id: m.id,
          role: m.role as Message['role'],
          content: m.content || '',
          thinkingContent: m.thinking_content || undefined,
          timestamp: m.timestamp,
          toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
          toolResults: m.tool_results ? JSON.parse(m.tool_results) : undefined,
          finishReason: m.finish_reason || undefined,
          isCompactSummary: m.is_compact === 1 ? true : undefined,
          isSubAgentCard: m.is_sub_agent_card === 1 ? true : undefined,
          subAgentId: m.sub_agent_id || undefined,
        }))
        sessions.push({
          id: row.id,
          title: row.title,
          messages,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      }
      // 按 updatedAt 降序排序，使最近更新的会话排在最前，与新建会话时的 prepend 行为一致
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)

      // 启动时默认创建一个新会话，并清理旧的空"新会话"
      const newSession = createEmptySession()
      const cleanedSessions = sessions.filter(
        (s) => s.messages.length > 0 || s.title !== '新会话'
      )
      for (const s of sessions) {
        if (s.messages.length === 0 && s.title === '新会话') {
          ipc.dbDeleteSession(s.id)
        }
      }

      set({
        sessions: [newSession, ...cleanedSessions],
        activeSessionId: newSession.id,
        initialized: true,
      })
    } catch {
      set({ initialized: true })
    }
  },

  createSession: () => {
    const session = createEmptySession()
    set((state) => {
      // Auto-delete empty sessions (no messages and title is still default)
      const cleanedSessions = state.sessions.filter(
        (s) => s.messages.length > 0 || s.title !== '新会话'
      )
      // Also delete the session from DB
      for (const s of state.sessions) {
        if (s.messages.length === 0 && s.title === '新会话') {
          ipc.dbDeleteSession(s.id)
        }
      }
      return {
        sessions: [session, ...cleanedSessions],
        activeSessionId: session.id,
      }
    })
    ipc.dbCreateSession({
      id: session.id,
      title: session.title,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    })
    return session.id
  },

  setActiveSession: (id) => {
    set((state) => {
      // Auto-delete empty sessions when switching away
      const cleanedSessions = state.sessions.map((s) => {
        if (s.id !== id && s.messages.length === 0 && s.title === '新会话') {
          ipc.dbDeleteSession(s.id)
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
    ipc.dbAddMessage({
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
    })
    // Auto-update session title from first user message
    const session = get().sessions.find((s) => s.id === sessionId)
    if (session && session.title === '新会话' && message.role === 'user') {
      const newTitle = message.content.slice(0, 30) + (message.content.length > 30 ? '...' : '')
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, title: newTitle } : s
        ),
      }))
      ipc.dbUpdateSessionTitle(sessionId, newTitle, Date.now())
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
    // Persist to DB (debounced by caller)
    const msg = get().sessions.find((s) => s.id === sessionId)?.messages.find((m) => m.id === messageId)
    if (msg) {
      ipc.dbUpdateMessage(
        messageId,
        msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : undefined,
        msg.toolResults ? JSON.stringify(msg.toolResults) : undefined,
        msg.thinkingContent || null,
        msg.finishReason || null
      )
    }
  },

  setStreaming: (streaming, sessionId) => {
    const sid = sessionId || get().activeSessionId
    set({ streamingSessionId: streaming ? sid : null })
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

  deleteSession: (id) =>
    set((state) => {
      const filtered = state.sessions.filter((s) => s.id !== id)
      ipc.dbDeleteSession(id)
      // M3: 删除会话时同步清理子 agent runs，避免 localStorage 持续膨胀至配额溢出。
      // clearSession 之前是 dead code，现在被接通了。
      import('./agent-runs-store').then(({ useAgentRunsStore }) => {
        useAgentRunsStore.getState().clearSession(id)
      }).catch((e) => console.error('Failed to clear agent runs for session:', e))
      // 同步清理 per-session 工作状态
      const nextStatus = { ...state.sessionStatus }
      delete nextStatus[id]
      return {
        sessions: filtered,
        sessionStatus: nextStatus,
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
    ipc.dbClearMessages(sessionId)

    // 3. 写入压缩后的完整消息列表（boundary + summary + keptMessages + fileAttachments）
    for (const msg of newMessages) {
      ipc.dbAddMessage({
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
        // 修复 M7：补齐子 agent 卡片字段，否则压缩后卡片变成普通空消息
        is_sub_agent_card: msg.isSubAgentCard ? 1 : 0,
        sub_agent_id: msg.subAgentId || null,
      })
    }
  },
}))
