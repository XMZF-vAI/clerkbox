/**
 * IM Bots 主进程装配：生命周期、通道池、状态上报、IPC 注册。
 *
 * 只有这一层碰 electron；storage / core / session-bridge / 两条通道全部经接口注入依赖，
 * 于是它们都能在 node 环境的 vitest 里直接实例化跑协议与状态机。
 *
 * 四条不能省的编排规则：
 * 1. **凭据指纹驱动重建**。界面上换了 App Secret 或重新扫码，若还挂着旧连接，
 *    表现是「改了没生效」——比报错更难查。所以每次同步都比一次指纹。
 * 2. **状态只在真的变化时广播**。飞书通道在重连期间会每秒上报同样的 starting，
 *    不去抖就是让渲染层每秒整表重渲染。
 * 3. **通道 start() 返回不等于失败**：它表示这一轮生命周期结束（被停用 / 协议挂了 /
 *    会话过期）。外面这条监督循环要区分「配置不对（等人）」与「跑完一轮（重开）」，
 *    并对「一 start 就 return」做指数退避——否则一个立即返回的错误会烧出重启死循环。
 * 4. **通道的增删改只有一把锁**：所有路径最后都汇到 syncChannels()，避免「这里停了那里又起」。
 *    地图里的条目只按对象身份退役（retire），否则旧循环会把新循环的条目删掉，
 *    表现为「改了凭据之后机器人再也起不来」。
 */
import { BrowserWindow, ipcMain, net } from 'electron'
import os from 'os'
import i18n from '../../src/i18n'
import type { ChatStore } from '../db'
import type { AgentSessionManager } from '../agent-host'
import { registerAgentEventSink } from '../agent-host'
// 读 KV 里的语言设置：与 agent-host 读 agentHostMode 同一个通道（handlerRegistry 直调，零 IPC 往返）
import { handlerRegistry } from '../webui-server'
import {
  BOTS_EVENT_CHANNELS,
  BOTS_IPC_CHANNELS,
  BotCredentialInputSchema,
  NewBotSchema,
  credentialFingerprint,
  credentialRefFor,
  emptyBotsConfig,
  parseFeishuSecret,
  parseTelegramSecret,
  parseWeixinSecret,
  parseWecomSecret,
  providerAcceptsManualCredential,
  serializeBotCredential,
  type BindCodeResult,
  type BotChannelFactory,
  type BotChannelHandle,
  type BotConfig,
  type BotListItem,
  type BotProvider,
  type BotsIpcResult,
  type ChannelDeps,
  type InboundMessage,
  type RuntimeStatus,
  type WeixinQrEvent,
  type WeixinQrLogin,
  type WeixinQrSession,
} from './types'
import { BotsStorage } from './storage'
import { SessionBridge, type BridgeCommand, type BridgePorts, type BridgeSessionRow } from './session-bridge'
import { BotsCore, type CorePorts, type DeliverInput, makeRandomBindCode } from './core'
import { weixinChannel, createWeixinQrLogin } from './weixin'
import { feishuChannel } from './feishu'
import { telegramChannel } from './telegram'
import { wecomChannel } from './wecom'

/** 宿主注入的能力：main.ts 在 app ready 之后调 initImBots 时给 */
export interface ImBotsHost {
  /** userData 根目录；本模块的文件都写在 userData/im-bots 下 */
  userDataPath: string
  store: ChatStore
  manager: AgentSessionManager
  /** safeStorage 加密存储的读 / 写 / 删；明文只在本模块内短暂存在，绝不出主进程 */
  readCredential(id: string): Promise<string | null>
  writeCredential(id: string, value: string): Promise<void>
  deleteCredential(id: string): Promise<void>
}

/** provider → 通道工厂。新增渠道只改这张表（tests/im-bots-index.test.ts 锁住它与类型的枚举一致） */
export const CHANNELS: Record<BotProvider, BotChannelFactory> = {
  weixin: weixinChannel,
  feishu: feishuChannel,
  telegram: telegramChannel,
  wecom: wecomChannel,
}

/** 一个正在跑的通道实例 */
interface Running {
  botId: string
  provider: BotProvider
  fingerprint: string
  handle: BotChannelHandle
  /** 置了就不再重开（停用 / 删除 / 退出） */
  stopping: boolean
  startedAt: number
  /** 连续「极短生命周期」重开的次数（退避用；跑过一轮健康时长就归零） */
  fastRestarts: number
}

/** 极短生命周期判定（ms）：低于这个就当成「一 start 就 return」，不是真的跑过一轮 */
const FAST_EXIT_MS = 5_000
/** 跑过这个时长就认为通道健康过，重置退避 */
const HEALTHY_RUN_MS = 30_000
const MAX_BACKOFF_MS = 30_000
/** 入站去重表上限：这是「长轮询重启后重复投递」的主力窗口 */
const INBOUND_DEDUPE_LIMIT = 512
/**
 * IM 审批的等待策略：每次发问续 5 分钟，自首次挂起起总上限 15 分钟。
 * 到点仍由宿主按拒绝收尾（fail-closed），聊天侧不会把一轮 run 永久挂住。
 */
const APPROVAL_EXTEND_MS = 5 * 60_000
const APPROVAL_MAX_WAIT_MS = 15 * 60_000

let storage: BotsStorage | null = null
let bridge: SessionBridge | null = null
let core: BotsCore | null = null
let host: ImBotsHost | null = null
let disposed = false
let initialized = false

const running = new Map<string, Running>()
/** botId → 已处理过的入站 message_id（Set 的插入序即新鲜度序） */
const seenInbound = new Map<string, Set<string>>()
const statuses = new Map<string, RuntimeStatus>()
/** botId → 该 bot 的扫码登录编排器（凭据写入必须绑定到具体 bot，不能共用一个实例） */
const qrLogins = new Map<string, WeixinQrLogin>()
/** 扫码会话 id → botId：bots:weixinQrPoll 只有 sessionId，需要据此找回归属 */
const qrOwners = new Map<string, string>()
/** 本系统实际用过的凭据明文：出站脱敏的名单来源 */
const usedSecrets = new Set<string>()

const log = (...args: unknown[]): void => {
  console.log('[im-bots]', ...args)
}

/**
 * 发给 IM 的文案该用哪种语言。
 *
 * 用户切换语言只发生在渲染层（i18n.changeLanguage），主进程这份 i18n 实例是独立的、
 * 永远停在初始的 zh-CN —— 英文界面的人在手机上会收到全中文回复。
 * 语言值由渲染层同步进 KV（与 agent-host 读 agentHostMode 同一个通道），这里读一次缓存，
 * 读不到就退回 zh-CN（项目的源语言）。不每句都去戳 KV：那是每条消息一次同步文件读。
 */
let cachedLanguage: string | null = null
function statusText(key: string, vars?: Record<string, string>): string {
  return i18n.t(key, { ...(vars ?? {}), lng: appLanguage() })
}

function appLanguage(): string | undefined {
  if (cachedLanguage !== null) return cachedLanguage || undefined
  try {
    const handler = handlerRegistry.get('kvGet')
    const raw = handler ? handler(null, 'appLanguage') : null
    cachedLanguage = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : ''
  } catch {
    cachedLanguage = ''
  }
  return cachedLanguage || undefined
}

/** 审批与提问的续时心跳：只在真的有待答项时戳宿主 */
let approvalHeartbeat: NodeJS.Timeout | null = null
function startApprovalHeartbeat(): void {
  if (approvalHeartbeat) return
  approvalHeartbeat = setInterval(() => {
    try {
      core?.refreshApprovalWaits()
    } catch (error) {
      log('审批续时失败:', error instanceof Error ? error.message : error)
    }
  }, APPROVAL_EXTEND_MS > 60_000 ? 60_000 : APPROVAL_EXTEND_MS)
  approvalHeartbeat.unref?.()
}

function stopApprovalHeartbeat(): void {
  if (!approvalHeartbeat) return
  clearInterval(approvalHeartbeat)
  approvalHeartbeat = null
}

// ─────────────────────────────────────────────────────────────────────────────
// 广播与状态
// ─────────────────────────────────────────────────────────────────────────────

/** 发给所有存活窗口；单个窗口正在销毁不影响其余窗口 */
function sendToWindows(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* 窗口正在关闭 */
    }
  }
}

function allStatuses(): RuntimeStatus[] {
  return [...statuses.values()]
}

/**
 * 状态更新：只在 (state, message) 真的变了以后才广播全量快照。
 * 飞书断线重连期间会反复上报同一个 starting，不合并就是每秒一次整表重渲染。
 */
function setStatus(botId: string, state: RuntimeStatus['state'], message?: string): void {
  const prev = statuses.get(botId)
  if (prev && prev.state === state && (prev.message ?? '') === (message ?? '')) return
  statuses.set(botId, { botId, state, ...(message ? { message } : {}) })
  sendToWindows(BOTS_EVENT_CHANNELS.status, allStatuses())
}

/** 投递：core 与结果回推都走这里，按 botId 找到正在跑的通道实例 */
async function deliver(input: DeliverInput): Promise<void> {
  const item = running.get(input.botId)
  if (!item) throw new Error(`bot ${input.botId} 当前未运行`)
  await item.handle.send({ providerUserId: input.providerUserId, contextToken: input.contextToken }, input.text)
}

// ─────────────────────────────────────────────────────────────────────────────
// 凭据
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本层仍在服务中。
 *
 * 每个异步编排函数都在入口捕获局部引用、并在每个 await 之后重判：
 * storage / host 是模块级可空变量，disposeImBots 会把它们置 null，
 * 而「退出时正好有一次 ensureReady / readConfig 在飞」是常态而不是例外——
 * 继续读全局就是 unhandled rejection（生产环境里表现为退出时弹一次错误窗）。
 */
function live(): boolean {
  return !disposed && storage !== null && host !== null
}

/** 该 bot 当前凭据明文；没有凭据或结构不认识时回 null */
async function readBotCredential(bot: BotConfig): Promise<string | null> {
  const h = host
  if (!h) return null
  let raw: string | null = null
  try {
    raw = await h.readCredential(bot.credentialRef)
  } catch (error) {
    log(`读取凭据失败 ${bot.id}:`, error instanceof Error ? error.message : error)
    return null
  }
  // 进脱敏名单而不是每次出站现读一遍：这条路径正是「本系统实际用过这份凭据」的唯一事实来源
  if (raw) {
    usedSecrets.add(raw)
    const parsed = parseSecretByProvider(bot.provider, raw)
    if (parsed && 'token' in parsed) usedSecrets.add(parsed.token)
    if (parsed && 'appSecret' in parsed) usedSecrets.add(parsed.appSecret)
    if (parsed && 'botToken' in parsed) usedSecrets.add(parsed.botToken)
    if (parsed && 'secret' in parsed) usedSecrets.add(parsed.secret)
  }
  return raw
}

/** 按渠道解析凭据结构：四个渠道各一个 schema，无法识别返回 null */
function parseSecretByProvider(provider: BotProvider, raw: string) {
  switch (provider) {
    case 'weixin':
      return parseWeixinSecret(raw)
    case 'feishu':
      return parseFeishuSecret(raw)
    case 'telegram':
      return parseTelegramSecret(raw)
    case 'wecom':
      return parseWecomSecret(raw)
  }
}

/**
 * 凭据是否算「已配好」：微信＝已扫码（有 token + baseUrl），飞书＝App ID/Secret 结构完整，
 * Telegram＝botToken，企微＝BotID/Secret。用它同时决定 hasCredential 与要不要起通道——
 * 拿结构不对的 JSON 去连网络，只会得到一个把用户带偏的协议错误。
 */
export function credentialIsUsable(provider: BotProvider, raw: string | null): boolean {
  if (!raw) return false
  return parseSecretByProvider(provider, raw) !== null
}

async function writeBotCredential(botId: string, provider: BotProvider, value: string): Promise<void> {
  const h = host
  const store = storage
  if (!h || !store) throw new Error('im-bots 未初始化')
  const bot = (await store.readConfig()).bots.find((item) => item.id === botId)
  if (!bot) throw new Error(`no such bot: ${botId}`)
  if (bot.provider !== provider) throw new Error(`provider mismatch for ${botId}`)
  await h.writeCredential(bot.credentialRef, value)
  usedSecrets.add(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// 通道依赖与监督循环
// ─────────────────────────────────────────────────────────────────────────────

/**
 * bot 级状态（微信长轮询游标、激活时刻）借用的存储槽位。
 * 它不是聊天身份：游标是「整个 bot 一份」，挂到具体用户上会在换人之后
 * 从头再收一遍历史消息，前一个人说的话被当成新任务重跑。
 */
function botScopeKey(bot: BotConfig): string {
  return `${bot.id}:_bot:${bot.provider}:private`
}

function makeChannelDeps(bot: BotConfig, self: () => Running | undefined): ChannelDeps {
  return {
    readCredential: () => readBotCredential(bot),
    writeCredential: (value) => writeBotCredential(bot.id, bot.provider, value),
    onInbound: (message) => handleInboundDeduped(message),
    setStatus: (state, message) => setStatus(bot.id, state, message),
    readCursor: async () => (await storage?.getContext(botScopeKey(bot)))?.weixinGetUpdatesBuf,
    writeCursor: async (value) => {
      await storage?.patchContext(botScopeKey(bot), { weixinGetUpdatesBuf: value }, () => ({ mode: 'draft' }))
    },
    markActivated: async () => {
      await storage?.patchContext(botScopeKey(bot), { weixinActivatedAt: Date.now() }, () => ({ mode: 'draft' }))
    },
    isStopped: () => {
      const current = self()
      // 只有「被显式停用 / 应用退出」才算停；条目还在但没置 stopping 表示还要重开，
      // 通道据此可以继续跑下一轮
      return disposed || !current || current.stopping
    },
    // Telegram 注入 Electron 的 net.fetch：走 Chromium 网络栈，用户开了系统代理即自动
    // 生效（TUN 模式用 global fetch 也一样通）；其余渠道不注入，回退 globalThis.fetch。
    // net.fetch 的参数类型比标准 fetch 窄（不含 URL 对象），这里按 ChannelDeps 契约放宽
    ...(bot.provider === 'telegram' && typeof net?.fetch === 'function'
      ? { fetchImpl: net.fetch.bind(net) as unknown as typeof fetch }
      : {}),
    log: (...args) => log(`[${bot.provider}:${bot.id}]`, ...args),
  }
}

/**
 * 入站去重。
 * 微信是 at-least-once（游标在本批全部投递成功之后才写），飞书长连接重连会重投同一事件，
 * 所以两条通道都可能把同一条消息送进来两次。不去重的后果很具体：同一个任务跑两遍。
 * 只在有 message_id 时判重——宁重不漏。
 */
async function handleInboundDeduped(message: InboundMessage): Promise<void> {
  if (!core) return
  const botId = message.actor.botId
  const messageId = message.messageId
  if (messageId) {
    let seen = seenInbound.get(botId)
    if (!seen) {
      seen = new Set<string>()
      seenInbound.set(botId, seen)
    }
    if (seen.has(messageId)) return
    seen.add(messageId)
    if (seen.size > INBOUND_DEDUPE_LIMIT) {
      const oldest = seen.values().next()
      if (!oldest.done) seen.delete(oldest.value)
    }
  }
  await core.handleInbound(message)
}

/** 按对象身份退役：只有「还是我这条」时才从表里删，避免旧循环抹掉新循环的条目 */
function retire(item: Running): void {
  if (running.get(item.botId) !== item) return
  running.delete(item.botId)
  // 释放文件锁：releaseLock 只删「记在自己 PID 上」的锁，所以即便从没抢到也不会误删别人的
  void storage?.releaseLock(item.botId).catch(() => {})
}

/**
 * 启动一个 bot 的通道并盯住它。
 * 退出不重开的两种情况：被停用/删除（stopping）、缺可用凭据（等用户在界面上处理）。
 */
async function supervise(bot: BotConfig): Promise<void> {
  const store = storage
  if (running.has(bot.id) || disposed || !store) return
  const item: Running = {
    botId: bot.id,
    provider: bot.provider,
    fingerprint: '',
    handle: CHANNELS[bot.provider].create(),
    stopping: false,
    startedAt: Date.now(),
    fastRestarts: 0,
  }
  running.set(bot.id, item)
  const self = () => (running.get(bot.id) === item ? item : undefined)

  /**
   * 进程锁（规格 §5 末条）。
   * 主进程理论上只有一个，但「开发时留着上一个实例、又 npm run dev 起一个」是真的会发生：
   * 两个客户端同时 getupdates 会互相吃掉对方的消息，表现是「消息时有时无」这种最难查的故障。
   * 锁文件写 PID 且校验进程存活，所以崩溃留下的死锁会被下一次启动抢回来，不会永久停用通道。
   */
  const lock = await store.acquireLock(bot.id)
  if (!lock.acquired) {
    setStatus(bot.id, 'error', statusText('bots.statusNote.lockHeld', { pid: String(lock.holderPid ?? '?') }))
    retire(item)
    return
  }

  while (!disposed && !item.stopping) {
    const raw = await readBotCredential(bot)
    if (!live() || self() === undefined) {
      retire(item)
      return
    }
    if (!credentialIsUsable(bot.provider, raw)) {
      setStatus(
        bot.id,
        'error',
        statusText(bot.provider === 'weixin' ? 'bots.statusNote.needQrcode' : 'bots.statusNote.needAppCredential')
      )
      retire(item)
      return
    }
    item.fingerprint = credentialFingerprint(bot.provider, raw as string)
    setStatus(bot.id, 'starting')
    item.startedAt = Date.now()
    // 每轮换新实例：连接状态（socket、游标内存态、退避计数）存在实例里，复用会带着上一轮的残留
    const handle = CHANNELS[bot.provider].create()
    item.handle = handle
    try {
      await handle.start(bot, makeChannelDeps(bot, self))
    } catch (error) {
      // 两个通道都约定 start 恒 resolve；走到这里说明实现破了，兜住并标错误，不让它掀掉主进程
      const message = error instanceof Error ? error.message : String(error)
      log(`通道异常 ${bot.id}:`, message)
      setStatus(bot.id, 'error', message)
    }
    if (!live() || item.stopping || self() === undefined) {
      retire(item)
      return
    }
    const alive = Date.now() - item.startedAt
    if (alive >= HEALTHY_RUN_MS) item.fastRestarts = 0
    if (alive < FAST_EXIT_MS) {
      item.fastRestarts += 1
      const backoff = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(item.fastRestarts, 5))
      log(`通道 ${bot.id} ${alive}ms 即退出，${backoff}ms 后重开`)
      await sleep(backoff)
      if (!live() || item.stopping || self() === undefined) {
        retire(item)
        return
      }
    }
    // 重读配置：bot 可能已被改名 / 停用 / 删除，不能拿启动时那份旧快照继续跑
    const latest = (await store.readConfig()).bots.find((candidate) => candidate.id === bot.id)
    if (!live() || !latest || !latest.enabled) {
      retire(item)
      if (latest) setStatus(bot.id, 'disabled')
      return
    }
    bot = latest
  }
  retire(item)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * fire-and-forget 的唯一出口：任何脱离 await 的 promise 都必须带一个 catch。
 * 这些位置（起通道、停通道、扫码后重建）一旦漏出一个 rejection，Windows 上就是
 * 退出时弹一次 Electron 错误框，而且现场已经没有了。
 */
function fire(promise: Promise<unknown>, label: string): void {
  promise.catch((error) => log(`${label} 失败:`, error instanceof Error ? error.message : error))
}

/** 停掉一个 bot 的通道并等它确实退出；等不到也不许卡住应用退出（5s 兜底） */
async function stopChannel(botId: string): Promise<void> {
  const item = running.get(botId)
  if (!item) return
  item.stopping = true
  running.delete(botId)
  try {
    await Promise.race([item.handle.stop(), sleep(5_000)])
  } catch (error) {
    log(`停止通道失败 ${botId}:`, error instanceof Error ? error.message : error)
  }
  seenInbound.delete(botId)
  // 这里也放一次锁：stopChannel 自己把条目从表里摘了， supervise 那边的 retire 守卫就再也
  // 命中不上，不补这一刀锁文件会一直挂着，下一次启动被自己的旧锁挡在门外。
  void storage?.releaseLock(botId).catch(() => {})
}

/**
 * 按最新配置对齐在跑的通道集合：新增 / 变更 / 删除 / 启停全在这里收敛。
 * 指纹变了就重建——「界面上换了凭据却还连着旧应用」是最难自查的一类问题。
 */
export async function syncChannels(): Promise<void> {
  const store = storage
  if (!store || disposed) return
  const config = await store.readConfig()
  for (const bot of config.bots) {
    if (!live()) return
    const item = running.get(bot.id)
    if (!bot.enabled) {
      if (item) fire(stopChannel(bot.id), `停用通道 ${bot.id}`)
      setStatus(bot.id, 'disabled')
      continue
    }
    const raw = await readBotCredential(bot)
    if (!live()) return
    if (!credentialIsUsable(bot.provider, raw)) {
      // 没凭据的启用 bot：交给 supervise 去置那条具体的错误并退出，这里不抢状态
      if (!item) fire(supervise(bot), `启动通道 ${bot.id}`)
      continue
    }
    const fingerprint = credentialFingerprint(bot.provider, raw as string)
    if (item && item.fingerprint === fingerprint) continue
    if (item) {
      log(`凭据或配置变更，重建通道 ${bot.id}`)
      await stopChannel(bot.id)
    }
    fire(supervise(bot), `重建通道 ${bot.id}`)
  }
  // 配置里已经没有的 bot：一并停掉，否则删了机器人后台还在轮询
  for (const botId of [...running.keys()]) {
    if (!live()) return
    if (config.bots.some((bot) => bot.id === botId)) continue
    await stopChannel(botId)
    statuses.delete(botId)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 列表装配
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 渲染层看到的行：配置 + 实时状态 + 是否已配凭据 + 已绑定账号。
 * 纯函数并导出，是为了让「状态缺失时按 enabled 回落」这条规则可被单测钉住。
 */
export function buildBotListItems(input: {
  bots: BotConfig[]
  statusOf: (botId: string) => RuntimeStatus | undefined
  boundOf: (botId: string) => BotListItem['boundActors']
  hasCredentialOf: (bot: BotConfig) => boolean
}): BotListItem[] {
  return input.bots.map((bot) => {
    const status = input.statusOf(bot.id)
    return {
      ...bot,
      // 没有实时状态（主进程刚起来 / 该 bot 从没跑过）时按 enabled 回落，
      // 界面上不会给一个已停用的 bot 画「空闲」
      status: status?.state ?? (bot.enabled ? 'idle' : 'disabled'),
      ...(status?.message ? { statusMessage: status.message } : {}),
      hasCredential: input.hasCredentialOf(bot),
      boundActors: input.boundOf(bot.id),
    }
  })
}

async function listItems(): Promise<BotListItem[]> {
  const store = storage
  if (!store) return []
  const config = await store.readConfig()
  const bindings = await store.listBindings()
  const credentials = new Map<string, boolean>()
  for (const bot of config.bots) credentials.set(bot.id, credentialIsUsable(bot.provider, await readBotCredential(bot)))
  return buildBotListItems({
    bots: config.bots,
    statusOf: (botId) => statuses.get(botId),
    boundOf: (botId) => bindings.filter((item) => item.botId === botId),
    hasCredentialOf: (bot) => credentials.get(bot.id) === true,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────────────────────

function fail(error: unknown): BotsIpcResult {
  const message = error instanceof Error ? error.message : String(error)
  log('handler failed:', message)
  return { ok: false, error: message }
}

/**
 * 新增 / 更新机器人。
 *
 * 两条不放行的口子：
 * - credentialRef 由主进程按 bot-<provider>-<id> 生成。它是凭据存储的命名空间，
 *   让渲染层指定就等于允许覆盖别人的 API Key 条目；
 * - id 要么不带（新建，主进程发号），要么必须已存在。带着一个不存在的 id 来「创建」
 *   会让调用方自选主键，第二次同名 upsert 直接盖掉第一条。
 */
async function upsertBot(input: unknown): Promise<BotsIpcResult<BotConfig>> {
  const store = storage
  if (!store) return { ok: false, error: 'not-initialized' }
  const parsed = NewBotSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'invalid-bot-config' }
  const { id: rawId, ...rest } = parsed.data
  // 空串 id 与不带 id 同义：都是「新建，由主进程发号」
  const incomingId = rawId && rawId.trim() ? rawId.trim() : undefined
  const config = await store.readConfig()
  if (incomingId) {
    const index = config.bots.findIndex((item) => item.id === incomingId)
    if (index < 0) return { ok: false, error: 'no-such-bot' }
    const previous = config.bots[index] as BotConfig
    // provider 不可改：换渠道等于换一套凭据体系，旧凭据会沦为没人读的孤儿数据
    if (previous.provider !== rest.provider) return { ok: false, error: 'provider-immutable' }
    const next: BotConfig = { ...previous, ...rest, credentialRef: previous.credentialRef }
    config.bots[index] = next
    await store.writeConfig(config)
    sendToWindows(BOTS_EVENT_CHANNELS.changed)
    await syncChannels()
    return { ok: true, data: next }
  }
  const id = makeId()
  const created: BotConfig = { ...rest, id, credentialRef: credentialRefFor(rest.provider, id) }
  config.bots.push(created)
  await store.writeConfig(config)
  sendToWindows(BOTS_EVENT_CHANNELS.changed)
  await syncChannels()
  return { ok: true, data: created }
}

async function removeBot(id: string): Promise<BotsIpcResult> {
  const store = storage
  const h = host
  if (!store || !h) return { ok: false, error: 'not-initialized' }
  const config = await store.readConfig()
  const bot = config.bots.find((item) => item.id === id)
  if (!bot) return { ok: false, error: 'no-such-bot' }
  await stopChannel(id)
  // 内存里那条挂问（/workspace 列完的序号）也要按 bot 前缀清掉，否则换个同名 bot 还能兑现旧清单
  core?.forgetBot(bot.id)
  await store.writeConfig({ version: 1, bots: config.bots.filter((item) => item.id !== id) })
  await store.dropContextsOf(id)
  statuses.delete(id)
  // 凭据必须一起删：留在 safeStorage 里既没人读，用户也无法真正清除
  try {
    await h.deleteCredential(bot.credentialRef)
  } catch (error) {
    log('删除凭据失败（机器人已删）:', error instanceof Error ? error.message : error)
  }
  sendToWindows(BOTS_EVENT_CHANNELS.changed)
  return { ok: true }
}

async function setEnabled(id: string, enabled: boolean): Promise<BotsIpcResult> {
  const store = storage
  if (!store) return { ok: false, error: 'not-initialized' }
  const config = await store.readConfig()
  const index = config.bots.findIndex((item) => item.id === id)
  if (index < 0) return { ok: false, error: 'no-such-bot' }
  config.bots[index] = { ...(config.bots[index] as BotConfig), enabled }
  await store.writeConfig(config)
  if (!enabled) setStatus(id, 'disabled')
  sendToWindows(BOTS_EVENT_CHANNELS.changed)
  await syncChannels()
  return { ok: true }
}

function registerIpc(): void {
  ipcMain.handle(BOTS_IPC_CHANNELS.list, async () => listItems())
  ipcMain.handle(BOTS_IPC_CHANNELS.upsert, async (_event, bot: unknown) => {
    try {
      return await upsertBot(bot)
    } catch (error) {
      return fail(error)
    }
  })
  ipcMain.handle(BOTS_IPC_CHANNELS.remove, async (_event, id: string) => {
    try {
      return await removeBot(String(id))
    } catch (error) {
      return fail(error)
    }
  })
  ipcMain.handle(BOTS_IPC_CHANNELS.setEnabled, async (_event, id: string, enabled: boolean) => {
    try {
      return await setEnabled(String(id), enabled === true)
    } catch (error) {
      return fail(error)
    }
  })
  ipcMain.handle(BOTS_IPC_CHANNELS.runtimeStatus, async () => allStatuses())
  /**
   * 写入飞书应用凭据。
   * 两个字段必须一起给：分开写会出现「App ID 已换、App Secret 还是上一家的」这种
   * 必然认证失败、且现场看不出来的中间态。
   */
  ipcMain.handle(BOTS_IPC_CHANNELS.setCredential, async (_event, botId: string, input: unknown) => {
    try {
      const store = storage
      if (!store) return { ok: false, error: 'not-initialized' }
      const parsed = BotCredentialInputSchema.safeParse(input)
      if (!parsed.success) return { ok: false, error: 'invalid-credential' }
      const bot = (await store.readConfig()).bots.find((item) => item.id === String(botId))
      if (!bot) return { ok: false, error: 'no-such-bot' }
      if (!providerAcceptsManualCredential(bot.provider)) {
        // 微信只认扫码那一步下发的 token：放开手填等于开一条绕过登录流程的路
        return { ok: false, error: 'weixin-credential-via-qrcode-only' }
      }
      await writeBotCredential(bot.id, bot.provider, serializeBotCredential(bot.provider, parsed.data))
      sendToWindows(BOTS_EVENT_CHANNELS.changed)
      await syncChannels()
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  })
  /**
   * 重置该 bot 的全部聊天状态：上下文、绑定关系、待用绑定码与长轮询游标一次清干净，
   * 配置与凭据保留（界面「重置状态」按钮；换了微信账号 / 游标卡死时用得上）。
   */
  ipcMain.handle(BOTS_IPC_CHANNELS.resetBot, async (_event, botId: string) => {
    try {
      const store = storage
      if (!store) return { ok: false, error: 'not-initialized' }
      const id = String(botId)
      const config = await store.readConfig()
      if (!config.bots.some((item) => item.id === id)) return { ok: false, error: 'no-such-bot' }
      await store.dropContextsOf(id)
      core?.forgetBot(id)
      sendToWindows(BOTS_EVENT_CHANNELS.changed)
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  })
  ipcMain.handle(BOTS_IPC_CHANNELS.generateBindCode, async (_event, id: string): Promise<BindCodeResult> => {
    if (!core) return { ok: false }
    const issued = await core.generateBindCode(String(id))
    return issued ? { ok: true, ...issued } : { ok: false, error: 'no-such-bot' }
  })
  ipcMain.handle(BOTS_IPC_CHANNELS.unbindActor, async (_event, actorKey: string) => {
    try {
      if (!storage || !core) return { ok: false, error: 'not-initialized' }
      await storage.removeBinding(String(actorKey))
      core.forgetChoices(String(actorKey))
      sendToWindows(BOTS_EVENT_CHANNELS.changed)
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  })
  ipcMain.handle(BOTS_IPC_CHANNELS.resetActor, async (_event, actorKey: string) => {
    try {
      if (!storage || !core) return { ok: false, error: 'not-initialized' }
      await storage.resetContext(String(actorKey))
      core.forgetChoices(String(actorKey))
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  })
  ipcMain.handle(BOTS_IPC_CHANNELS.weixinQrStart, async (_event, botId: string) => {
    const login = qrLoginFor(String(botId))
    if (!login) return { ok: false as const, error: 'not-initialized' }
    // 同一 bot 反复点「重新扫码」：先停掉旧会话，否则两个长轮询同时改一份状态
    for (const [sessionId, owner] of qrOwners) {
      if (owner === botId) login.stop(sessionId)
    }
    return login.start(String(botId))
  })
  ipcMain.handle(BOTS_IPC_CHANNELS.weixinQrPoll, async (_event, sessionId: string) => {
    const owner = qrOwners.get(String(sessionId))
    return owner ? (qrLogins.get(owner)?.peek(String(sessionId)) ?? null) : null
  })
  ipcMain.handle(BOTS_IPC_CHANNELS.weixinQrStop, async (_event, sessionId: string) => {
    const owner = qrOwners.get(String(sessionId))
    qrLogins.get(owner ?? '')?.stop(String(sessionId))
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 装配入口
// ─────────────────────────────────────────────────────────────────────────────

/** 与既有会话 id 同口径的 21 位 nanoid（不引依赖，字符集与长度够用即可） */
export function makeId(): string {
  const alphabet = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict'
  const bytes = new Uint8Array(21)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

/**
 * 每个 bot 一个扫码编排器。
 * 不能共用一个实例：登录成功要把 token 写进「这个 bot」的凭据槽，
 * 共用就得靠「当前正在扫的是谁」这种全局可变态来传参，两个 bot 并发扫码必然串。
 */
function qrLoginFor(botId: string): WeixinQrLogin | null {
  const store = storage
  if (!store) return null
  const existing = qrLogins.get(botId)
  if (existing) return existing
  const login = createWeixinQrLogin({
    readCredential: async () => {
      // 捕获局部 store：模块级 storage 在 dispose 时会被置空，
      // 闭包里读全局的话退出过程中的一次轮询就能 NPE
      const bot = (await store.readConfig()).bots.find((item) => item.id === botId)
      return bot ? await readBotCredential(bot) : null
    },
    writeCredential: (value) => writeBotCredential(botId, 'weixin', value),
    onEvent: (event) => {
      qrOwners.set(event.session, event.botId ?? botId)
      sendToWindows(BOTS_EVENT_CHANNELS.weixinQr, event)
      // confirmed 表示 token 已落进凭据存储：这是唯一能让这条通道跑起来的时刻
      if (event.state === 'confirmed') void restartAfterCredential(botId)
      if (event.state === 'expired' || event.state === 'error') {
        log(`扫码未成功 ${botId}: ${event.message ?? event.state}`)
      }
    },
    log,
  })
  qrLogins.set(botId, login)
  return login
}

/** 扫码拿到凭据之后重建通道（新凭据 → 新指纹 → supervise 重开） */
async function restartAfterCredential(botId: string): Promise<void> {
  await stopChannel(botId)
  sendToWindows(BOTS_EVENT_CHANNELS.changed)
  await syncChannels()
}

/**
 * 会话默认工作目录：与渲染层 createEmptySession、agent-host.backfillDefaultWorkDir 同一口径
 * （home/clerkbox-work/YYYYMMDD-HHmmss）。三处各写一份是历史包袱，这里至少保证主进程内只有一份。
 */
export function defaultWorkDirFor(now: number): string {
  const home = os.homedir()
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return process.platform === 'win32' ? `${home}\\clerkbox-work\\${stamp}` : `${home}/clerkbox-work/${stamp}`
}

export function initImBots(injected: ImBotsHost): void {
  if (initialized) return
  initialized = true
  disposed = false
  host = injected
  storage = new BotsStorage(injected.userDataPath)
  const manager = injected.manager

  const bridgePorts: BridgePorts = {
    manager: {
      handleCommand: (cmd: BridgeCommand, meta) => manager.handleCommand(cmd as never, meta),
      inspectSession: (sessionId) => {
        const found = manager.inspect().find((item) => item.sessionId === sessionId)
        return found ? { status: found.status, queued: found.queued, hasRun: found.hasRun } : undefined
      },
      hasLocalSettingsSnapshot: () => manager.hasLocalSettingsSnapshot,
      subscribeEvents: (handler) => registerAgentEventSink(handler),
    },
    store: {
      createSession: async (row: BridgeSessionRow) => injected.store.createSession(row as never),
      getAllSessions: async () => (await injected.store.getAllSessions()) as never,
      getMessages: async (sessionId) => (await injected.store.getMessages(sessionId)) as never,
    },
    makeId,
    defaultWorkDir: defaultWorkDirFor,
    now: () => Date.now(),
    log,
  }
  bridge = new SessionBridge(bridgePorts)
  // 回推内容里可能出现 apiKey / bot token：清洗名单来自「本系统实际用过的凭据」+ 运行配置里的 Key
  // 回推内容里可能出现 apiKey / bot token：清洗名单 = 本系统实际用过的凭据 + 运行快照里的 Key。
  // settings.providers[] 也要一起收：run 命令带的是整份设置快照，除活动 Key 之外每个 provider 的
  // Key 同样在宿主手里，agent 把它们复述出来是完全存在的路径（规格 §11 最后一条）。
  bridge.setSecretsProvider(() => {
    const out = [...usedSecrets]
    for (const item of manager.inspect()) {
      const settings = manager.peekRunSettings(item.sessionId) as
        | { apiKey?: string; providers?: Array<{ apiKey?: string }> }
        | undefined
      if (!settings) continue
      if (settings.apiKey) out.push(settings.apiKey)
      for (const provider of settings.providers ?? []) {
        if (provider?.apiKey) out.push(provider.apiKey)
      }
    }
    return out
  })

  core = new BotsCore({
    storage,
    bridge,
    deliver,
    /**
     * IM 内审批：手机上回一句「确定 / 拒绝」就是这条挂起审批的结果。
     *
     * 三条刻意的边界：
     * - scope 恒为 'once'。「本会话放行」会写进宿主的会话放行集合，此后同类目标不再问——
     *   那是给「人就坐在电脑前、看清了才点」准备的信任升级，从一个聊天窗口里给出去不合适。
     *   要连续放行请回电脑端点那一下。
     * - 走 remote:false。绑定过的对端与本地用户同级（规格里就是这么定的），且 core 侧只认
     *   「发起这条审批的那个聊天身份」的答复，未绑定的人连问题都收不到。
     * - 等待时间由 approveWaits 心跳按 APPROVAL_EXTEND_MS 续，总上限 APPROVAL_MAX_WAIT_MS。
     *   120s 原表是按桌面眼前点击定的，手机往返必然超时；到总上限仍按拒绝收尾，
     *   fail-closed 不会因为「改成手机上批」而被削弱。
     */
    approval: {
      extendWait: (sessionId, requestId) =>
        manager.extendPermissionWait(sessionId, requestId, APPROVAL_EXTEND_MS, APPROVAL_MAX_WAIT_MS),
      async resolve(sessionId, requestId, approved) {
        console.log(`[im-bots][audit] IM 审批答复 session=${sessionId} request=${requestId} -> ${approved ? 'approve' : 'deny'}`)
        return manager.handleCommand(
          { type: 'permission.resolve', sessionId, requestId, approved, scope: 'once' },
          { remote: false }
        )
      },
    },
    /** 提问（ask_user 那道选择题）与审批同一条路：手机上一串序号就能答 */
    question: {
      async resolve(sessionId, requestId, answers) {
        console.log(`[im-bots][audit] IM 提问答复 session=${sessionId} request=${requestId}`)
        return manager.handleCommand({ type: 'question.resolve', sessionId, requestId, payload: answers }, { remote: false })
      },
    },
    // 界面之外，发给 IM 的文案也要跟随用户选的语言：主进程的 i18n 实例不会被渲染层
    // changeLanguage 影响（那是另一个进程的另一份实例），所以按调用逐条传 lng。
    text: (key, vars) => i18n.t(key, { ...(vars ?? {}), lng: appLanguage() }),
    makeBindCode: makeRandomBindCode,
    now: () => Date.now(),
    log,
  })
  bridge.watchRuns((outcome) => core?.handleOutcome(outcome) ?? Promise.resolve())

  registerIpc()
  startApprovalHeartbeat()
  // fire-and-forget：机器人不该拖慢应用启动。但这条 promise 必须自己收尾（见 fire）。
  fire(startUp(), '启动同步')
  log('ready')
}

async function startUp(): Promise<void> {
  const store = storage
  if (!store) return
  try {
    await store.ensureReady()
  } catch (error) {
    // 落盘目录起不来（权限 / 磁盘占用）：机器人整体不可用，但不能拖累应用启动
    log('初始化失败，IM 机器人本轮不可用:', error instanceof Error ? error.message : error)
    return
  }
  if (!live()) return
  const config = await store.readConfig().catch(() => emptyBotsConfig())
  if (!live()) return
  for (const bot of config.bots) {
    if (!bot.enabled) setStatus(bot.id, 'disabled')
  }
  await syncChannels()
}

export async function disposeImBots(): Promise<void> {
  disposed = true
  stopApprovalHeartbeat()
  for (const login of qrLogins.values()) login.dispose()
  qrLogins.clear()
  bridge?.dispose()
  const targets = [...running.keys()]
  running.forEach((item) => {
    item.stopping = true
  })
  await Promise.race([Promise.all(targets.map((botId) => stopChannel(botId))), sleep(3_000)])
  running.clear()
  seenInbound.clear()
  statuses.clear()
  qrOwners.clear()
  usedSecrets.clear()
  // 语言缓存一并失效：应用内切语言后重启机器人要重新读一次 KV
  cachedLanguage = null
  core = null
  bridge = null
  storage = null
  host = null
  initialized = false
  log('disposed')
}

/** 测试与诊断用：当前在跑的通道与状态快照 */
export function imBotsDiagnostics(): { running: string[]; statuses: RuntimeStatus[] } {
  return { running: [...running.keys()], statuses: allStatuses() }
}
