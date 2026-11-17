import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TodoItem, UserQuestion } from '../types/agent'

export interface PendingQuestion {
  id: string
  sessionId: string
  questions: UserQuestion[]
  /** 宿主问题必须等发送回执后才能清除；id 直接沿用宿主 requestId。 */
  host?: boolean
}

type Answers = Record<string, string[]>

interface InteractiveState {
  pendingQuestions: Record<string, PendingQuestion | undefined>
  requestQuestion: (sessionId: string, questions: UserQuestion[]) => Promise<Answers>
  openHostQuestion: (sessionId: string, requestId: string, questions: UserQuestion[], submit: (answers: Answers) => Promise<void>) => void
  settleHostQuestion: (sessionId: string, requestId: string) => void
  resolveQuestion: (sessionId: string, requestId: string, answers: Answers) => void | Promise<void>
  cancelQuestion: (sessionId: string) => void
}

const resolvers = new Map<string, (answers: Answers) => void>()
const hostResponders = new Map<string, { submit: (answers: Answers) => Promise<void>; pending?: Promise<void> }>()
const hostKey = (sessionId: string, requestId: string) => JSON.stringify([sessionId, requestId])

export const useInteractiveStore = create<InteractiveState>((set) => ({
  pendingQuestions: {},
  requestQuestion: (sessionId, questions) => {
    const id = `question-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set((state) => ({
      pendingQuestions: { ...state.pendingQuestions, [sessionId]: { id, sessionId, questions } },
    }))
    return new Promise<Answers>((resolve) => {
      resolvers.set(id, resolve)
    })
  },
  openHostQuestion: (sessionId, requestId, questions, submit) => {
    const current = useInteractiveStore.getState().pendingQuestions[sessionId]
    // 快照重发同一问题时保持对象和表单身份，不重置尚未提交或发送失败的答案。
    if (current?.host && current.id === requestId) return
    if (current) useInteractiveStore.getState().cancelQuestion(sessionId)
    hostResponders.set(hostKey(sessionId, requestId), { submit })
    set((state) => ({ pendingQuestions: { ...state.pendingQuestions, [sessionId]: { id: requestId, sessionId, questions, host: true } } }))
  },
  settleHostQuestion: (sessionId, requestId) => {
    const key = hostKey(sessionId, requestId)
    hostResponders.delete(key)
    set((state) => {
      if (state.pendingQuestions[sessionId]?.id !== requestId) return state
      const next = { ...state.pendingQuestions }
      delete next[sessionId]
      return { pendingQuestions: next }
    })
  },
  resolveQuestion: (sessionId, requestId, answers) => {
    const current = useInteractiveStore.getState().pendingQuestions[sessionId]
    if (current?.id !== requestId) return
    if (current.host) {
      const key = hostKey(sessionId, requestId)
      const responder = hostResponders.get(key)
      if (!responder) return Promise.reject(new Error('question-responder-unavailable'))
      if (responder.pending) return responder.pending
      const submission = Promise.resolve().then(() => responder.submit(answers)).then(() => {
        // 任务可能已结束或换成新问题，迟到的回执不能清掉新卡片。
        if (hostResponders.get(key) !== responder) return
        hostResponders.delete(key)
        set((state) => {
          if (state.pendingQuestions[sessionId]?.id !== requestId) return state
          const next = { ...state.pendingQuestions }
          delete next[sessionId]
          return { pendingQuestions: next }
        })
      })
      responder.pending = submission
      void submission.then(() => { responder.pending = undefined }, () => { responder.pending = undefined })
      return submission
    }
    const resolve = resolvers.get(requestId)
    if (resolve) {
      resolvers.delete(requestId)
      resolve(answers)
    }
    set((state) => {
      if (state.pendingQuestions[sessionId]?.id !== requestId) return state
      const next = { ...state.pendingQuestions }
      delete next[sessionId]
      return { pendingQuestions: next }
    })
  },
  cancelQuestion: (sessionId) => {
    const pending = useInteractiveStore.getState().pendingQuestions[sessionId]
    if (!pending) return
    if (!pending.host) {
      useInteractiveStore.getState().resolveQuestion(sessionId, pending.id, {})
      return
    }
    // 宿主已收尾时只清本地视图，不再向结束的任务发送一个空答案。
    hostResponders.delete(hostKey(sessionId, pending.id))
    set((state) => {
      const next = { ...state.pendingQuestions }
      delete next[sessionId]
      return { pendingQuestions: next }
    })
  },
}))

interface TodoState {
  bySession: Record<string, TodoItem[]>
  setTodos: (sessionId: string, items: TodoItem[]) => void
  clearTodos: (sessionId: string) => void
}

// Todo 清单按会话持久化（localStorage）：/goal 等长跑任务的进度重启后可恢复。
// 仅低频更新（todowrite 工具调用时），不影响流式性能。
export const useTodoStore = create<TodoState>()(
  persist(
    (set) => ({
      bySession: {},
      setTodos: (sessionId, items) => set((state) => ({
        bySession: { ...state.bySession, [sessionId]: items },
      })),
      clearTodos: (sessionId) => set((state) => {
        const next = { ...state.bySession }
        delete next[sessionId]
        return { bySession: next }
      }),
    }),
    { name: 'clerkbox-todo-store' }
  )
)
