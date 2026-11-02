import { create } from 'zustand'
import type { WorkflowProgressSnapshot } from '../lib/workflow-runtime'

/**
 * 工作流运行看板的实时快照（按 toolCallId 索引）。
 *
 * 为什么不用 chat-store 的 message 字段：快照每步都变，写进消息会让整条消息（含全部
 * 工具调用与正文）走一次落库 + 整行重渲染；这里只换一个对象引用，卡片用
 * `useWorkflowRunsStore((s) => s.byToolCall[call.id])` 精确订阅。
 *
 * 键只取 toolCallId：工具调用 id 由模型侧/宿主生成，进程内唯一；会话前缀不参与查找，
 * 只会让每个读取点都多带一个参数。运行结束后卡片改用工具结果里的尾巴，本 store 的
 * 条目自然不再被读（保留到进程结束，体量是每次运行一个几十 KB 的对象）。
 */
interface WorkflowRunsState {
  byToolCall: Record<string, WorkflowProgressSnapshot>
  update: (toolCallId: string, snapshot: WorkflowProgressSnapshot) => void
  clear: (toolCallId: string) => void
}

export const useWorkflowRunsStore = create<WorkflowRunsState>((set) => ({
  byToolCall: {},

  update: (toolCallId, snapshot) =>
    set((state) => ({ byToolCall: { ...state.byToolCall, [toolCallId]: snapshot } })),

  clear: (toolCallId) =>
    set((state) => {
      if (!state.byToolCall[toolCallId]) return state
      const byToolCall = { ...state.byToolCall }
      delete byToolCall[toolCallId]
      return { byToolCall }
    }),
}))
