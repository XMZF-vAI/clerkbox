/**
 * 消息撤回 / 改动回滚的执行器（渲染层宿主与主进程宿主共用）。
 *
 * 进程相关的部分（读写文件、截断对话、中止运行中的会话）全部由调用方注入，
 * 因此这里的顺序不变式可以在 node 环境下直接单测：
 *
 * 1. **先读全所有快照正文，再动一次文件系统。** 任何一份快照读不到都在写盘之前失败，
 *    workspace 不会被撤成半新半旧。（ZCode 的 cascade 同序。）
 * 2. **写之前给每个文件记一条 journal；任何一次写失败就按 journal 逆序补偿。**
 * 3. **文件事务成功之后才提交对话截断。** 反过来会留下「消息没了、文件回了一半」的最坏状态。
 * 4. **截断前必须先确认该会话没有正在进行的 run。** 抢占失败就整体不动（fail-closed），
 *    否则循环还在往一个已经被删掉的锚点上追加快照。
 */
import type { Message, RewindOutcome, RewindPlan, RewindScope } from '../types/agent'
import { buildRewindNotice, buildRewindPlan, isRewindableUserMessage, isTruncatedRead, rangeAlreadyReverted } from './rewind'
import { dropSnapshotFiles, readSnapshotFile } from './checkpoint-recorder'
import { makeId } from '../agent-core/loop'
import { ipc } from './ipc-client'

/** 由宿主提供的进程能力束 */
export interface RewindIo {
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
  deleteFile(path: string): Promise<void>
  /** 读快照正文；不存在/读不出统一返回 null */
  readSnapshot(ref: string): Promise<string | null>
  /** 回收快照正文（对话截断后这些索引已无人引用） */
  dropSnapshots(refs: string[]): Promise<void>
  /** 截断：删除 fromMessageId 及其之后的全部消息（落库；内存由调用方事后整会话重拉） */
  truncate(fromMessageId: string): Promise<void>
  /**
   * 把锚点消息标成「文件已撤销」。
   * 刻意**保留** fileCheckpoints 索引：之后撤回这条消息时还要靠它回收快照正文，
   * 清了就会在磁盘上留下永远没人引用的孤儿文件。重复撤销由 filesReverted 挡住。
   */
  markReverted(messageId: string): Promise<void>
  /** 追加一条合成的回执消息（仅 workspace 范围）；必须等落库完成，调用方紧接着就整会话重拉 */
  addNotice(content: string): Promise<void>
}

export interface RewindRequest {
  /**
   * 取当下最新的会话消息。
   * 是个 thunk 而不是数组：抢占正在跑的会话之后必须重读一次，
   * 否则循环收尾时写下的最后几条消息会漏在截断点之外（宿主的事件环里也还留着它们）。
   */
  getMessages: () => Promise<Message[]>
  anchorMessageId: string
  scope: RewindScope
  /**
   * 中止该会话正在进行的运行，返回 true 表示已确认停下。
   * 拿不到这个保证时（宿主没提供）绝不截断 —— ZCode 对后台任务就是 fail-closed。
   */
  abortActiveRun?: () => Promise<boolean>
  /** 协作式取消：用户在预览确认后关窗/再次点撤回时，不要把剩下的文件继续写完 */
  isCancelled?: () => boolean
}

interface AppliedResult {
  ok: boolean
  restored: RewindOutcome['restored']
  compensated: boolean
  /** 失败时的简述，供界面与日志 */
  detail?: string
}

/** 空结果的样板：拒绝执行时也要把「本来会删掉多少条消息」如实报给界面 */
function blocked(
  plan: { removedMessages: number },
  error: RewindOutcome['error'],
  restored: RewindOutcome['restored'] = [],
  compensated = false
): RewindOutcome {
  return { ok: false, error, restored, compensated, removedMessages: plan.removedMessages }
}

/**
 * 把计划里所有恢复动作需要的正文凑齐。
 *
 * 计划阶段已经逐份确认过快照可读，这里直接从记忆化结果取，不再动第二次盘 ——
 * 既省掉一次全量重读，也关掉了「预览时读得到、执行时读不到」这个窗口。
 * 万一某份真的不在记忆里（计划与执行之间被改过），applyFileRewind 会以写失败收场并回补。
 */
function collectPayloads(plan: RewindPlan, memo: Map<string, string | null>): Map<string, string> {
  const payloads = new Map<string, string>()
  for (const file of plan.safeFiles) {
    if (file.action !== 'restore') continue
    const content = memo.get(file.beforeRef ?? '')
    if (typeof content === 'string') payloads.set(file.path, content)
  }
  return payloads
}

/**
 * 应用文件回滚：journal + 逆序补偿。
 *
 * 补偿失败升级为 AggregateError 语义上的「不可恢复」，这里把它如实回传（compensated:false），
 * 界面必须告诉用户「workspace 处于半撤销状态，请自行核对」，不能报一个轻飘飘的失败。
 */
async function applyFileRewind(
  io: RewindIo,
  plan: RewindPlan,
  payloads: Map<string, string>,
  isCancelled?: () => boolean
): Promise<AppliedResult> {
  type JournalEntry = { path: string; content: string | null }
  const journal: JournalEntry[] = []
  const restored: RewindOutcome['restored'] = []

  try {
    for (const file of plan.safeFiles) {
      if (isCancelled?.()) throw new Error('cancelled')
      journal.push({ path: file.path, content: await io.readFile(file.path) })
      if (file.action === 'delete') {
        await io.deleteFile(file.path)
      } else {
        const content = payloads.get(file.path)
        if (content === undefined) throw new Error(`snapshot payload missing for ${file.path}`)
        await io.writeFile(file.path, content)
      }
      restored.push({ path: file.path, action: file.action })
    }
    return { ok: true, restored, compensated: false }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    let compensated = true
    try {
      for (const entry of [...journal].reverse()) {
        if (entry.content === null) await io.deleteFile(entry.path)
        else await io.writeFile(entry.path, entry.content)
      }
    } catch (compensationError) {
      compensated = false
      console.error('[rewind] compensation failed（workspace 可能处于半撤销状态）:', compensationError)
    }
    return { ok: false, restored: [], compensated, detail }
  }
}

/** 范围内全部快照引用：截断后这些正文就是孤儿 */
function collectRefsInRange(messages: Message[], fromIndex: number): string[] {
  const refs: string[] = []
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    for (const cp of messages[i]?.fileCheckpoints ?? []) {
      if (cp.beforeRef) refs.push(cp.beforeRef)
    }
  }
  return refs
}

/**
 * 执行一次撤回/回滚。
 *
 * `scope` 的三种取值对应界面上的三个动作：撤回对话、只撤销文件、编辑重发时带文件回滚。
 * 返回值一律带上「本来会删掉多少条消息」，界面据此写拒绝文案，不用自己再算一遍。
 */
export async function executeRewind(io: RewindIo, request: RewindRequest): Promise<RewindOutcome> {
  const { anchorMessageId, scope } = request
  const initial = await request.getMessages()
  const anchorIndex = initial.findIndex((m) => m.id === anchorMessageId)
  const anchor = anchorIndex >= 0 ? initial[anchorIndex] : undefined

  if (!anchor || !isRewindableUserMessage(anchor)) {
    return { ok: false, error: 'no-checkpoint', restored: [], compensated: false, removedMessages: 0 }
  }

  // 先抢占再动手：截断一个还在被写历史的锚点是未定义行为。
  // 停不下来就整体不动（连文件都不碰），并把这条放在读消息之前——
  // 停的过程本身可能落库新消息，之后必须重读一遍。
  if (request.abortActiveRun) {
    const stopped = await request.abortActiveRun()
    if (!stopped) {
      return { ok: false, error: 'session-busy', restored: [], compensated: false, removedMessages: 0 }
    }
  }
  const messages = request.abortActiveRun ? await request.getMessages() : initial
  const fromIndex = messages.findIndex((m) => m.id === anchorMessageId)
  if (fromIndex < 0) {
    return { ok: false, error: 'no-checkpoint', restored: [], compensated: false, removedMessages: 0 }
  }

  const touchesFiles = scope !== 'conversation'
  // 事务内的快照记忆化读取：计划阶段与恢复阶段读同一份正文，只读一次盘
  const snapshotMemo = new Map<string, string | null>()
  const readSnapshotOnce = async (ref: string): Promise<string | null> => {
    if (snapshotMemo.has(ref)) return snapshotMemo.get(ref) ?? null
    const content = await io.readSnapshot(ref)
    snapshotMemo.set(ref, content)
    return content
  }
  const plan = await buildRewindPlan({
    messages,
    fromIndex,
    scope,
    readFile: io.readFile,
    readSnapshot: readSnapshotOnce,
  })

  // 已经撤销过的轮次不允许再来一次：第二次会把已经恢复好的文件按错的哈希再写一遍
  if (touchesFiles && rangeAlreadyReverted(messages, fromIndex)) {
    return blocked(plan, 'no-checkpoint')
  }

  // 只撤文件时，本轮压根没有可恢复的东西就没有意义；只撤对话时不需要文件依据
  if (scope === 'workspace' && plan.safeFiles.length === 0 && plan.unsafeFiles.length === 0) {
    return blocked(plan, 'no-checkpoint')
  }

  if (touchesFiles && !plan.canApply) {
    // 有冲突或有无法证明的改动：拒绝整体执行，交给界面引导用户改用「只撤对话」
    return blocked(plan, 'plan-blocked')
  }

  let restored: RewindOutcome['restored'] = []
  if (touchesFiles && plan.safeFiles.length > 0) {
    const payloads = collectPayloads(plan, snapshotMemo)
    const applied = await applyFileRewind(io, plan, payloads, request.isCancelled)
    if (!applied.ok) {
      return {
        ok: false,
        error: applied.detail === 'cancelled' ? 'cancelled' : 'write-failed',
        restored: [],
        compensated: applied.compensated,
        removedMessages: 0,
      }
    }
    restored = applied.restored
  }

  if (scope === 'workspace') {
    // 只动文件：对话一行不删，标记已撤销并给模型补一条回执，免得它以为那些活没干过
    await io.markReverted(anchorMessageId)
    await io.addNotice(buildRewindNotice(restored, plan.gaps.length))
    return { ok: true, restored, compensated: false, removedMessages: 0 }
  }

  // 提交对话截断：文件事务已经成功。截断本身失败是「文件回了、消息还在」的半程状态，
  // 必须如实报出去（而不是抛异常让调用方卡在转圈里），用户能立刻核对并重试。
  const refs = collectRefsInRange(messages, fromIndex)
  try {
    await io.truncate(anchorMessageId)
  } catch (err) {
    console.error('[rewind] 对话截断失败（文件已回滚，消息仍在）:', err)
    return { ok: false, error: 'truncate-failed', restored, compensated: false, removedMessages: 0 }
  }
  await io.dropSnapshots(refs)
  return { ok: true, restored, compensated: false, removedMessages: plan.removedMessages }
}

/** 供宿主复用的 notice 消息构造（isRewindNotice 让 UI 画成回执条而不是用户气泡） */
export function makeRewindNoticeMessage(content: string): Message {
  return { id: makeId(), role: 'user', content, timestamp: Date.now(), isRewindNotice: true }
}

/**
 * 用 ipc 调用面装配一份 RewindIo，两种宿主模式共用同一份实现。
 *
 * 主进程侧 installAgentHostBridge 已把 ipc 门面桥到 handlerRegistry 直调（零往返），
 * 所以这里不需要为宿主模式写第二套：两套各一份正是本项目反复踩过的「字段漂移」源头。
 *
 * `addNoticeRow` 由调用方给出：宿主要走 persistMessage + 事件广播，渲染层要写进
 * zustand store + 落库，两者的内存回流方式不同；但都必须**等落库 resolve**，
 * 因为调用方紧接着就整会话重拉 DB，晚一帧这条回执就不见了。
 */
export function buildRewindIo(
  sessionId: string,
  hooks: { addNoticeRow(message: Message): Promise<void> },
): RewindIo {
  return {
    // 读不出的一律当「拿不到当前内容」，由计划侧标成 external_modified/unreadable 拒绝自动回滚
    readFile: async (path) => {
      try {
        const content = await ipc.readFile(path)
        return isTruncatedRead(content) ? null : content
      } catch {
        return null
      }
    },
    writeFile: (path, content) => ipc.writeFile(path, content),
    deleteFile: (path) => ipc.deleteFile(path),
    readSnapshot: (ref) => readSnapshotFile(sessionId, ref),
    dropSnapshots: (refs) => dropSnapshotFiles(sessionId, refs),
    truncate: (fromId) => ipc.dbDeleteMessagesFrom(sessionId, fromId),
    markReverted: (messageId) => ipc.dbPatchMessage(messageId, { files_reverted: 1 }),
    addNotice: async (content) => {
      await hooks.addNoticeRow(makeRewindNoticeMessage(content))
    },
  }
}
