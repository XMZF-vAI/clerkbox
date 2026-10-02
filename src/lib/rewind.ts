/**
 * 消息撤回 / 改动回滚的纯逻辑（对标 ZCode 的 contracts/rewind + runtime/methods/rewind-*）。
 *
 * 只放**不碰进程边界**的部分：算截断点、折叠快照、比对指纹出计划、生成 notice 文案。
 * 文件读写与落库由调用方注入（宿主模式在 electron/agent-host.ts，渲染层模式在
 * src/lib/rewind-service.ts），因此本模块在 node 环境下可直接 vitest 单测。
 *
 * 与 ZCode 的两处刻意不同，都写在这里以免读者去别处找：
 * 1. ZCode 的消息是 append-only，撤回写的是 branch cut 游标；本项目按 db.deleteMessagesFrom
 *    物理截断，行为对用户等价，但**撤回即真删、不可回溯**（也因此没有 fork）。
 * 2. ZCode 的级联回滚按创建序倒序重放每份快照；本项目按路径折叠取**最早那一份**再写，
 *    终态与倒序重放相同（同一文件的最终回滚点就是它在本轮第一次变更前的内容），
 *    但少一半写盘、且中途失败时受影响的路径数更少。
 */
import i18n from '../i18n'
import type { FileCheckpoint, FileMutationGap, Message, RewindOutcome, RewindPlan, RewindPlanFile, RewindScope } from '../types/agent'

/** 超过这个体积的文件不拍快照：整份正文进磁盘的收益抵不上回滚时的读写放大 */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

/** 回滚时允许直接读写的最大文件体积（超过就只能拒绝，不能盲写） */
export const MAX_REWIND_FILE_BYTES = 8 * 1024 * 1024

/**
 * 内容指纹（cyrb128 十六进制 + 长度前缀）。
 *
 * 为什么不用 sha256：本模块同时要跑在 Electron 渲染层、主进程和 node 测试里，
 * 而 WebUI 走局域网 http:// 时不是安全上下文，crypto.subtle 直接不存在。
 * 这里的用途只是「自快照以来文件变过没有」的变更检测，不是安全校验，
 * 一个非密码学 128 位哈希加长度足矣，还能让整条计划保持同步纯函数。
 */
export function contentFingerprint(text: string): string {
  let h1 = 0x9e3779b9, h2 = 0x243f6a88, h3 = 0xb7e15162, h4 = 0x8fc2bc2
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x85ebca6b) >>> 0
    h2 = Math.imul(h2 ^ (c ^ (i + 1)), 0xc2b2ae35) >>> 0
    h3 = (h3 + Math.imul(c + i, 0x9e3779b1)) >>> 0
    h4 = (h4 ^ Math.imul(c + 0x5bf03635, 0x27d4eb2f)) >>> 0
  }
  h1 = (h1 ^ (h1 >>> 15)) >>> 0
  h2 = (h2 ^ (h2 >>> 13)) >>> 0
  h3 = (h3 ^ (h3 >>> 16)) >>> 0
  h4 = (h4 ^ (h4 >>> 11)) >>> 0
  return `${text.length}:${h1.toString(16)}${h2.toString(16)}${h3.toString(16)}${h4.toString(16)}`
}

/** 快照里读不到当前文件内容时的哨兵值：让「文件已被外部删除」也变成一次可识别的指纹不符 */
export const MISSING_FINGERPRINT = 'missing'

/**
 * 哪些工具算「已知只读」——本轮只要出现过别的技术，就无法证明文件改动被快照覆盖全了。
 * 判定取白名单而不是黑名单：新加工具时默认落到「不可回滚」一侧，不会因为漏登记而骗人。
 */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'read_image', 'list_dir', 'search_files', 'search_content',
  'web_search', 'web_fetch', 'search_memory', 'question', 'todowrite',
  'scheduled_task', 'spawn_agent', 'goal_set', 'goal_update', 'memory_read', 'memory_search',
])

/** write_file / search_replace 由快照覆盖，不进缺口 */
const SNAPSHOTTED_TOOLS = new Set(['write_file', 'search_replace'])

/**
 * 从一次工具调用推断无法回滚的改动。
 * spawn_agent 不在这里：子 agent 的 write_file 走同一套采集，快照照样挂在本轮用户消息上。
 */
export function gapFromToolCall(name: string): FileMutationGap | null {
  if (SNAPSHOTTED_TOOLS.has(name)) return null
  const lower = name.toLowerCase()
  if (lower === 'execute_command' || lower === 'bash' || lower === 'shell' || lower.includes('terminal')) {
    return { toolName: name, reason: 'shell' }
  }
  if (READ_ONLY_TOOLS.has(name)) return null
  // MCP 工具与任何未知工具：副作用不可知，fail-closed
  return { toolName: name, reason: 'untracked-tool' }
}

/** 可撤回的锚点判定：必须是真实用户消息（压缩边界/附件恢复/子 agent 卡片/目标判定卡/合成回执都不行） */
export function isRewindableUserMessage(message: Message): boolean {
  return (
    message.role === 'user' &&
    !message.isCompactSummary &&
    !message.isCompactAttachment &&
    !message.isRewindNotice &&
    !message.subAgentId &&
    !message.isSubAgentCard &&
    !message.goalEvent
  )
}

/** 唯一允许撤回/编辑的锚点：最后一条真实用户消息（照抄 ZCode「只能编辑最后一轮」的收窄） */
export function lastRewindableTurnIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRewindableUserMessage(messages[i]!)) return i
  }
  return -1
}

/**
 * 截断范围里的 checkpoint 全集。
 * 快照按设计挂在锚点用户消息上，但这里对整个尾段取并集：
 * 历史数据、以及将来把快照改挂到助手消息时，都不必同步改这里。
 */
export function collectRangeCheckpoints(messages: Message[], fromIndex: number): FileCheckpoint[] {
  const collected: FileCheckpoint[] = []
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    for (const cp of messages[i]?.fileCheckpoints ?? []) collected.push(cp)
  }
  return collected
}

/** 截断范围里出现过的工具调用名（用于推出 shell/未跟踪缺口，不依赖是否存了 mutationGaps） */
export function collectRangeToolNames(messages: Message[], fromIndex: number): string[] {
  const names = new Set<string>()
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    for (const call of messages[i]?.toolCalls ?? []) names.add(call.name)
  }
  return [...names]
}

/**
 * 按路径折叠：同一文件在本轮被改了三次，回滚目标就是**第一次改动前**的内容，后两份作废。
 * 保留数组里第一次出现的那份 —— 采集顺序就是模型发起顺序（写工具在 loop 里串行派发）。
 */
export function foldEarliestPerPath(checkpoints: FileCheckpoint[]): FileCheckpoint[] {
  const byPath = new Map<string, FileCheckpoint>()
  for (const cp of checkpoints) {
    // 路径比对前统一分隔符：Windows 下同一文件可能一次是 \ 一次是 /
    const key = normalizePathKey(cp.path)
    if (!byPath.has(key)) byPath.set(key, cp)
  }
  return [...byPath.values()]
}

export function normalizePathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 生成回滚计划（dry-run）。
 *
 * `canApply` 是 all-or-nothing 的：只要有一个文件对不上指纹、有一个快照读不出来、
 * 或本轮出现过 shell/未知工具，就整体拒绝自动回滚。
 * 宁可让用户选「只撤对话」，也不能把工程撤成半新半旧的中间态。
 */
export async function buildRewindPlan(options: {
  messages: Message[]
  fromIndex: number
  scope: RewindScope
  readFile: (path: string) => Promise<string | null>
  readSnapshot: (ref: string) => Promise<string | null>
}): Promise<RewindPlan> {
  const { messages, fromIndex, scope, readFile, readSnapshot } = options
  const removedMessages = scope === 'workspace' ? 0 : Math.max(0, messages.length - Math.max(0, fromIndex))

  const gaps: FileMutationGap[] = []
  const seenGaps = new Set<string>()
  // 两处来源（工具名推断 + 采集侧记下的）必须用同一个 key，否则同一条缺口会各记一遍，
  // 界面上就会出现「shell 改动 2 项」这种凭空翻倍的数字
  const gapKey = (g: { reason: string; toolName: string; path?: string }) => `${g.reason}:${g.toolName}:${g.path ?? ''}`
  for (const name of collectRangeToolNames(messages, fromIndex)) {
    const gap = gapFromToolCall(name)
    if (!gap || seenGaps.has(gapKey(gap))) continue
    seenGaps.add(gapKey(gap))
    gaps.push(gap)
  }
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    for (const gap of messages[i]?.mutationGaps ?? []) {
      if (seenGaps.has(gapKey(gap))) continue
      seenGaps.add(gapKey(gap))
      gaps.push(gap)
    }
  }

  const safeFiles: RewindPlanFile[] = []
  const unsafeFiles: RewindPlanFile[] = []
  const checkpoints = foldEarliestPerPath(collectRangeCheckpoints(messages, fromIndex))

  for (const cp of checkpoints) {
    const push = (entry: RewindPlanFile, unsafe: boolean) => {
      ;(unsafe ? unsafeFiles : safeFiles).push(entry)
    }
    const action: RewindPlanFile['action'] = cp.existedBefore ? 'restore' : 'delete'
    const base = {
      path: cp.path,
      action,
      checkpointId: cp.id,
      toolName: cp.toolName,
      beforeRef: cp.beforeRef,
      bytes: cp.beforeBytes,
    }
    // 删除动作不需要读快照；恢复动作必须确认正文还在，否则会把「读不到」写成空文件
    const snapshot = cp.existedBefore ? await readSnapshot(cp.beforeRef ?? '') : null
    if (cp.existedBefore && snapshot === null) {
      push({ ...base, bytes: 0, reason: 'missing-snapshot' }, true)
      continue
    }
    // 变更后内容应当是什么：优先用采集时记下的正文哈希；本轮之后又有别的工具写过同一文件，
    // 这里就会对不上，正是我们想要的效果（拒绝在来路不明的文件上动手）。
    const current = await readFile(cp.path)
    const currentFp = current === null ? MISSING_FINGERPRINT : contentFingerprint(current)
    if (currentFp !== cp.afterHash) {
      push({ ...base, reason: 'external_modified', expectedHash: cp.afterHash, currentHash: currentFp }, true)
      continue
    }
    if (current !== null && current.length > MAX_REWIND_FILE_BYTES) {
      push({ ...base, reason: 'unreadable' }, true)
      continue
    }
    push(base, false)
  }

  return {
    canApply: unsafeFiles.length === 0 && gaps.length === 0,
    safeFiles,
    unsafeFiles,
    gaps,
    removedMessages,
  }
}

/**
 * 只撤文件时的上下文回执（对标 ZCode 的 rewind_notice）。
 *
 * 必须明写「对话历史没有被这次操作改写」：否则模型会把文件回滚理解成
 * 「那些活我没干过」，接着从头再做一遍，把刚恢复的文件又改回去。
 * conversation / both 两个范围不需要它：前者没动文件，后者紧跟一条新的用户消息。
 *
 * 这条回执既进模型上下文也显示给用户，所以走 i18n（与 loop 里的 permissionDenied
 * 等模型可见文案同一口径）；落库时按当时的语言定稿，之后切语言不改写历史。
 */
export function buildRewindNotice(restored: RewindOutcome['restored'], gapCount: number): string {
  const lines = restored.map((r) => `${r.action === 'delete' ? 'DELETED' : 'RESTORED'} ${r.path}`)
  const parts = [i18n.t('chat.rewind.notice', {
    count: restored.length,
    files: lines.join('\n'),
    interpolation: { escapeValue: false },
  })]
  if (gapCount > 0) parts.push(i18n.t('chat.rewind.noticeGaps', { gaps: gapCount }))
  parts.push(i18n.t('chat.rewind.noticeHistory'))
  return parts.join('\n')
}

/** 快照正文的落盘引用名：只允许这个形状，checkpoint-store 会拒绝任何别的形式 */
export function checkpointRef(id: string): string {
  return `${id}.txt`
}

/** 新快照 id：不用 crypto.randomUUID，渲染层/主进程/node 三处都得能用 */
export function makeCheckpointId(): string {
  return `ck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** UTF-8 字节数（快照体积上限按字节判，不按字符数——中文文件字符数会骗人） */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * 识别 readFile 的截断返回（main.ts 对超过 10MB 的文件只读前一段并追加中文提示）。
 *
 * 必须挡住：截断后的正文当成「变更前内容」存下来，回滚就等于把用户的大文件截断写回去。
 */
export function isTruncatedRead(content: string): boolean {
  return /\[\.\.\. 文件过大，已截断，共 \d+ 字节 \.\.\.\]\s*$/.test(content)
}

/**
 * 采集前的分类：能拍快照，还是只能记一条缺口。
 * 判定顺序不可换 —— 截断优先于体积（截断串本身可能刚好小于上限）。
 */
export function classifyMutation(before: string | null): FileMutationGap['reason'] | null {
  if (before === null) return null
  if (isTruncatedRead(before)) return 'oversized'
  if (before.includes('\u0000')) return 'binary'
  if (byteLength(before) > MAX_SNAPSHOT_BYTES) return 'oversized'
  return null
}

/** 该范围是否已经被撤销过（重复撤销会把文件再写一遍，且第二次必然对不上指纹） */
export function rangeAlreadyReverted(messages: Message[], fromIndex: number): boolean {
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    if (messages[i]?.filesReverted) return true
  }
  return false
}
