import { useEffect, useRef } from 'react'
import { useAgent } from '../../hooks/use-agent'
import { useChatStore } from '../../stores/chat-store'
import { useScheduledTasksStore } from '../../stores/scheduled-tasks-store'
import { useSettingsStore } from '../../stores/settings-store'
import { ipc } from '../../lib/ipc-client'
import { summarizeAssistantReply } from '../../lib/scheduled-task'
import type { TaskModelOverride } from '../../types/scheduled-task'
import type { ReasoningEffort } from '../../types/agent'

/**
 * 定时任务执行宿主（不可见组件）。
 *
 * - 由 App 为「队首」任务挂载：内部跑一遍 useAgent 的完整 ReAct 循环，
 *   复用模型/工具/压缩/排队等全部既有行为，与手动发消息等价。
 * - 任务指定了模型 → 执行前临时切换生效模型，执行结束后若用户没改回来自动还原。
 * - sendMessage 内部已带「完成/失败」系统通知，这里只负责把结果写进执行记录。
 */

interface TaskRunHostProps {
  runId: string
  sessionId: string
  prompt: string
  workingDir?: string
  model?: TaskModelOverride | null
}

/** 生效（派生）字段快照：任务结束后按快照精确还原，避免覆盖用户运行中的手动切换 */
interface ActiveModelSnapshot {
  model: string
  baseUrl: string
  apiKey: string
  apiCompat: 'openai' | 'anthropic'
  directFetch: boolean
  activeProviderId?: string
  activeModelId?: string
  temperature: number
  maxInputTokens: number
  maxTokens: number
  reasoningEffort?: ReasoningEffort
  enableThinking: boolean
}

function takeActiveModelSnapshot(): ActiveModelSnapshot {
  const s = useSettingsStore.getState()
  return {
    model: s.model,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    apiCompat: s.apiCompat,
    directFetch: s.directFetch,
    activeProviderId: s.activeProviderId,
    activeModelId: s.activeModelId,
    temperature: s.temperature,
    maxInputTokens: s.maxInputTokens,
    maxTokens: s.maxTokens,
    reasoningEffort: s.reasoningEffort,
    enableThinking: s.enableThinking,
  }
}

/** 取该会话最后一条助手消息的摘要（执行记录列表预览用） */
function lastAssistantSummary(sessionId: string): string | undefined {
  const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
  if (!session) return undefined
  return summarizeAssistantReply(session.messages)
}

export default function TaskRunHost({ runId, sessionId, prompt, workingDir, model }: TaskRunHostProps) {
  const { sendMessage } = useAgent(sessionId)
  // 始终用最新渲染产出的 sendMessage（模型覆盖切换后 settings 变化 → 闭包随之更新）
  const sendMessageRef = useRef(sendMessage)
  sendMessageRef.current = sendMessage
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const run = async () => {
      // 工作目录初始化（.clerkbox / 记忆索引依赖它）；失败不阻断本次执行
      if (workingDir) {
        await ipc.initClerkbox(workingDir).catch(() => undefined)
      }
      // 模型覆盖：任务指定了模型则本次执行临时切换
      let snapshot: ActiveModelSnapshot | null = null
      if (model) {
        snapshot = takeActiveModelSnapshot()
        useSettingsStore.getState().activateModel(model.providerId, model.modelId)
      }

      let ok = false
      let failure: string | undefined
      try {
        // 等一帧让上面的 activateModel 先完成 store 更新，确保拿到的是新模型的 sendMessage
        await new Promise((resolve) => setTimeout(resolve, 50))
        ok = await sendMessageRef.current(prompt)
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
      } finally {
        // 还原模型：仅当当前生效模型仍是任务指定模型时才回滚，
        // 否则说明用户在执行期间手动切了模型，不能覆盖用户的选择
        if (model && snapshot) {
          const current = useSettingsStore.getState()
          if (current.activeProviderId === model.providerId && current.activeModelId === model.modelId) {
            current.updateSettings({ ...snapshot })
          }
        }
        // 收尾必须无条件上报：StrictMode 下 effect 会「挂载→清理→再挂载」执行两次，
        // 若在清理时把本次上报标记为取消，记录就会永远停在「运行中」。
        // sendMessage 返回 false 可能是「失败」也可能是「用户中断」：用会话终态区分
        const sessionStatus = useChatStore.getState().sessionStatus[sessionId]
        const status = ok ? 'success' : sessionStatus === 'error' ? 'failed' : 'aborted'
        useScheduledTasksStore
          .getState()
          .finishRun(runId, status, failure, undefined, ok ? lastAssistantSummary(sessionId) : undefined)
      }
    }

    void run()
  }, [runId, sessionId, prompt, workingDir, model])

  return null
}
