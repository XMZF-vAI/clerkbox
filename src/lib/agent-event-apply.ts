/**
 * 宿主事件 → 渲染层 store 的应用侧（批次 B · P4c）。
 *
 * "事件意味着什么"在 agent-reducer 里（纯函数、可单测）；这里只执行副作用，并承担
 * 纯函数做不了的幂等判断——同一条事件可能来自实时推送、缺口补发或 F5 后的整环回放，
 * 三者不能长出三份界面状态。
 */
import { planAgentEvent, type StorePatch } from './agent-reducer'
import { agentClient } from './agent-client'
import { notifyIfNotViewing } from './notify'
import { useChatStore } from '../stores/chat-store'
import { useInteractiveStore, useTodoStore } from '../stores/interactive-store'
import { useGoalStore } from '../stores/goal-store'
import { useAgentRunsStore } from '../stores/agent-runs-store'
import type { AgentEvent } from '../agent-core/protocol'
import type { SessionGoal } from '../types/agent'

/** 已经向用户弹过一次的提问 id：回放不该重复打扰 */
const openedQuestions = new Set<string>()

function applyPatch(patch: StorePatch): void {
  const chat = useChatStore.getState()
  switch (patch.kind) {
    case 'set-streaming':
      chat.setStreaming(patch.on, patch.sessionId)
      return
    case 'set-status':
      chat.setSessionStatus(patch.sessionId, patch.status)
      if (patch.error !== undefined) chat.setSessionError(patch.sessionId, patch.error ?? undefined)
      return
    case 'upsert-message':
      chat.remoteUpsertMessage(patch.sessionId, patch.message)
      return
    case 'update-message':
      chat.remoteUpdateMessage(patch.sessionId, patch.messageId, patch.updates)
      return
    case 'stream-delta':
      chat.remoteAppendContent(patch.sessionId, patch.messageId, patch.text)
      return
    case 'set-queue':
      chat.setQueuedMessages(patch.sessionId, patch.items)
      return
    case 'set-todos':
      useTodoStore.getState().setTodos(patch.sessionId, patch.items)
      return
    case 'set-goal':
      if (patch.goal) useGoalStore.getState().upsertGoal(patch.sessionId, patch.goal as SessionGoal)
      else useGoalStore.getState().clearGoal(patch.sessionId)
      return
    case 'upsert-subagent-run':
      useAgentRunsStore.getState().upsertSubAgentRun(patch.sessionId, patch.run)
      return
    case 'open-question': {
      const key = `${patch.sessionId}:${patch.requestId}`
      if (openedQuestions.has(key)) return
      openedQuestions.add(key)
      // 答案回给宿主由它继续循环；宿主侧另有 10 分钟兜底，不会因窗口关闭而永久挂起
      void useInteractiveStore
        .getState()
        .requestQuestion(patch.sessionId, patch.questions)
        .then((answers) =>
          agentClient.send({ type: 'question.resolve', sessionId: patch.sessionId, requestId: patch.requestId, payload: answers })
        )
      return
    }
    case 'notify':
      notifyIfNotViewing(patch.sessionId, patch.channel, patch.message)
      return
    case 'reload-session':
      // 环形溢出与压缩后的原子重写，本地推断都不可靠：整会话按 DB 为准重拉。
      // 走专用方法而不是 syncFromDb——后者对流式会话保留本地，而宿主模式恰恰要重拉流式会话。
      void useChatStore.getState().reloadSessionFromDb(patch.sessionId)
      return
    default:
      return
  }
}

/** 一条宿主事件 → 应用全部补丁。单条补丁出错不影响后续事件投递 */
export function applyAgentEvent(event: AgentEvent): void {
  for (const patch of planAgentEvent(event)) {
    try {
      applyPatch(patch)
    } catch (err) {
      console.error(`[agent-apply] ${event.type} → ${patch.kind} 应用失败:`, err)
    }
  }
  // 危险确认与提问由宿主挂起等待回执；本轮收尾时本地对话框不该留着
  if (event.type === 'run.completed' || event.type === 'run.aborted' || event.type === 'resync') {
    useInteractiveStore.getState().cancelQuestion(event.sessionId)
    for (const key of [...openedQuestions]) if (key.startsWith(`${event.sessionId}:`)) openedQuestions.delete(key)
  }
}

let subscribed: (() => void) | null = null

/**
 * 挂接宿主事件流（App 启动时调用一次）。非宿主模式下不订阅，重复调用幂等。
 */
export async function attachAgentEvents(): Promise<boolean> {
  const on = await agentClient.start()
  if (!on) {
    subscribed?.()
    subscribed = null
    return false
  }
  if (subscribed) return true
  subscribed = agentClient.subscribe(applyAgentEvent)
  return true
}

export function detachAgentEvents(): void {
  subscribed?.()
  subscribed = null
  openedQuestions.clear()
}
