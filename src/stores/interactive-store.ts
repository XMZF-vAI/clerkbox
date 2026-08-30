import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TodoItem, UserQuestion } from '../types/agent'

export interface PendingQuestion {
  id: string
  sessionId: string
  questions: UserQuestion[]
}

type Answers = Record<string, string[]>

interface InteractiveState {
  pendingQuestions: Record<string, PendingQuestion | undefined>
  requestQuestion: (sessionId: string, questions: UserQuestion[]) => Promise<Answers>
  resolveQuestion: (sessionId: string, requestId: string, answers: Answers) => void
  cancelQuestion: (sessionId: string) => void
}

const resolvers = new Map<string, (answers: Answers) => void>()

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
  resolveQuestion: (sessionId, requestId, answers) => {
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
    if (pending) useInteractiveStore.getState().resolveQuestion(sessionId, pending.id, {})
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
