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
import { buildRewindPlan, isRewindableUserMessage } from './rewind'
import { buildRewindIo, executeRewind } from './rewind-service'
import { flushSessionMessageWrites, getSessionAbortController, hasChatDraft, useChatStore } from '../stores/chat-store'
import { hasRunningSubagents } from '../agent-core/session-context'
import { listRunningWorkflowRuns } from './workflow-runtime'
import { useComposerQueueStore } from './composer-queue'
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

function sessionBusy(sessionId: string): boolean {
  const state = useChatStore.getState()
  return !!getSessionAbortController(sessionId) || state.streamingSessionIds.has(sessionId) ||
    state.compactingSessionIds.has(sessionId) || state.stoppingSessionIds.has(sessionId) ||
    !!state.draftSubmitting[sessionId] || !!state.queuedMessages[sessionId]?.length ||
    hasRunningSubagents(sessionId) || listRunningWorkflowRuns(sessionId).length > 0 ||
    Object.values(useComposerQueueStore.getState().operations[sessionId] ?? {}).some((op) => op.status !== 'rejected')
}

function failedOutcome(error: string | undefined): RewindOutcome {
  // 只透传界面有文案的码：宿主还会返回 'rewind-local-only' 这类内部码，
  // 直接拼进 t() 会让用户看到一条键名而不是话
  const known: RewindOutcome['error'][] = ['cancelled', 'plan-blocked', 'write-failed', 'truncate-failed', 'no-checkpoint', 'session-busy', 'history-changed', 'draft-conflict']
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
  if (fromIndex < 0 || !isRewindableUserMessage(messages[fromIndex]!)) return null
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
  scope: RewindScope,
  options: { expectedHistoryVersion?: string; restoreDraft?: boolean } = {},
): Promise<RewindOutcome> {
  const state = useChatStore.getState()
  if (state.rewindingSessionIds.has(sessionId) || sessionBusy(sessionId)) return failedOutcome('session-busy')
  const anchor = localMessages(sessionId).find((m) => m.id === anchorMessageId)
  if (!anchor || !isRewindableUserMessage(anchor)) return failedOutcome('no-checkpoint')
  const restoreDraft = options.restoreDraft === true && scope !== 'workspace'
  if (restoreDraft && hasChatDraft(state.drafts[sessionId])) return failedOutcome('draft-conflict')
  const draft = {
    content: anchor.content,
    attachments: anchor.attachments?.map((attachment) => ({ ...attachment })) ?? [],
    taskMode: anchor.taskMode ?? null,
    compactMode: false,
  }

  // 同步占锁，再做模式查询/IPC。双击、发送、压缩和迟到附件都不能改写这份草稿。
  state.setRewinding(sessionId, true)
  try {
    const mode = await agentClient.ensureMode()
    if (sessionBusy(sessionId)) return failedOutcome('session-busy')
    let outcome: RewindOutcome
    if (mode === 'main') {
      const res = await agentClient.send({
        type: 'rewind.apply', sessionId, anchorMessageId, scope,
        expectedHistoryVersion: options.expectedHistoryVersion,
      })
      outcome = (res.outcome as RewindOutcome | undefined) ?? failedOutcome(res.error)
    } else {
      await flushSessionMessageWrites(sessionId)
      if (sessionBusy(sessionId)) return failedOutcome('session-busy')
      outcome = await executeRewind(localIo(sessionId), {
        getMessages: async () => localMessages(sessionId),
        anchorMessageId,
        scope,
        expectedHistoryVersion: options.expectedHistoryVersion,
        abortActiveRun: async () => !sessionBusy(sessionId),
      })
    }
    if (!outcome.ok) return outcome

    if (scope !== 'workspace') {
      useChatStore.setState((current) => ({
        rewindRevisions: { ...current.rewindRevisions, [sessionId]: (current.rewindRevisions[sessionId] ?? 0) + 1 },
        sessions: current.sessions.map((session) => {
          if (session.id !== sessionId) return session
          const index = session.messages.findIndex((m) => m.id === anchorMessageId)
          return index < 0 ? session : { ...session, messages: session.messages.slice(0, index) }
        }),
        ...(restoreDraft && current.sessions.some((s) => s.id === sessionId)
          ? { drafts: { ...current.drafts, [sessionId]: draft } } : {}),
      }))
    }
    // 等权威历史读回再解锁；原会话的草稿恢复不改变当前选中的会话。
    await useChatStore.getState().reloadSessionFromDb(sessionId)
    return outcome
  } finally {
    useChatStore.getState().setRewinding(sessionId, false)
  }
}
