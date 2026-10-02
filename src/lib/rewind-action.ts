/**
 * 撤回 / 编辑 / 回滚的界面入口（两种宿主模式各走各的执行路径，但对上暴露同一个门面）。
 *
 * 为什么必须分两条路：
 * - main 模式（编排在主进程）：只有宿主能提交截断。渲染层自己删消息，宿主的
 *   messages 镜像与事件环还留着那些条目，一次重连就把它们整批回放回来。
 * - renderer 模式：渲染层就是宿主，直接按 executeRewind 走，然后整会话重拉 DB。
 *
 * 两条路共用 src/lib/rewind.ts 的同一份纯逻辑与 src/lib/rewind-service.ts 的同一个执行器，
 * 所以「计划说什么」与「执行做什么」不会出现两种说法。
 */
import { agentClient } from './agent-client'
import { ipc } from './ipc-client'
import { messageToRow } from './chat-row'
import { buildRewindPlan } from './rewind'
import { buildRewindIo, executeRewind } from './rewind-service'
import { getSessionAbortController, useChatStore } from '../stores/chat-store'
import type { RewindOutcome, RewindPlan, RewindScope, Message } from '../types/agent'

function localMessages(sessionId: string): Message[] {
  return useChatStore.getState().sessions.find((s) => s.id === sessionId)?.messages ?? []
}

/** 渲染层模式的 IO 装配：回执直接落库，内存由调用方的 reloadSessionFromDb 跟上 */
function localIo(sessionId: string) {
  return buildRewindIo(sessionId, {
    addNoticeRow: async (message) => {
      await ipc.dbAddMessage(messageToRow(message, sessionId))
    },
  })
}

/**
 * 等本地那圈 run 真正停下来。
 *
 * abort 只是发信号，循环要把手上的模型流与工具批次收完才清 controller；
 * 不等就截断，等于在一个还在被写历史的锚点下面抽掉消息。
 * 上限 10s，超时就报忙而不是无限等下去。
 */
async function waitLocalRunEnded(sessionId: string): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if (!getSessionAbortController(sessionId)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !getSessionAbortController(sessionId)
}

function failedOutcome(error: string | undefined): RewindOutcome {
  // 只透传界面有文案的码：宿主还会返回 'rewind-local-only' 这类内部码，
  // 直接拼进 t() 会让用户看到一条键名而不是话
  const known: RewindOutcome['error'][] = ['cancelled', 'plan-blocked', 'write-failed', 'truncate-failed', 'no-checkpoint', 'session-busy']
  const mapped = known.includes(error as RewindOutcome['error']) ? (error as RewindOutcome['error']) : 'session-busy'
  return { ok: false, error: mapped, restored: [], compensated: false, removedMessages: 0 }
}

/** dry-run：要恢复/删除哪些文件、有没有对不上的、本轮有没有无法回滚的改动 */
export async function previewRewind(
  sessionId: string,
  anchorMessageId: string,
  scope: RewindScope
): Promise<RewindPlan | null> {
  if ((await agentClient.ensureMode()) === 'main') {
    const res = await agentClient.send({ type: 'rewind.preview', sessionId, anchorMessageId, scope })
    return (res.plan as RewindPlan | undefined) ?? null
  }
  const messages = localMessages(sessionId)
  const fromIndex = messages.findIndex((m) => m.id === anchorMessageId)
  if (fromIndex < 0) return null
  const io = localIo(sessionId)
  return buildRewindPlan({
    messages,
    fromIndex,
    scope,
    readFile: io.readFile,
    readSnapshot: io.readSnapshot,
  })
}

/**
 * 执行撤回/回滚。
 *
 * 注意这里**不**帮用户重发新消息：编辑重发由界面在 apply 成功后调用既有 sendMessage 完成。
 * 分成两步是有意的——截断与发送之间用户随时可以反悔，把「改文本」和「重跑」绑成一个
 * 原子动作会让中途失败变成「消息没了也没跑起来」，比现在更难解释。
 */
export async function applyRewind(
  sessionId: string,
  anchorMessageId: string,
  scope: RewindScope
): Promise<RewindOutcome> {
  if ((await agentClient.ensureMode()) === 'main') {
    const res = await agentClient.send({ type: 'rewind.apply', sessionId, anchorMessageId, scope })
    const outcome = res.outcome as RewindOutcome | undefined
    // 宿主没给结果就是没受理：把错误码原样带上，界面按码出文案
    if (!outcome) return failedOutcome(res.error)
    // 成功时宿主已广播 resync，reducer 会把整会话重拉，这里不必再拉一次
    return outcome
  }

  const io = localIo(sessionId)
  const outcome = await executeRewind(io, {
    getMessages: async () => localMessages(sessionId),
    anchorMessageId,
    scope,
    abortActiveRun: async () => {
      const controller = getSessionAbortController(sessionId)
      if (!controller) return true
      controller.abort()
      return waitLocalRunEnded(sessionId)
    },
  })
  if (outcome.ok) await useChatStore.getState().reloadSessionFromDb(sessionId)
  return outcome
}
