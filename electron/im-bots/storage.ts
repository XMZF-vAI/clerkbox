/**
 * IM Bots 落盘层：配置、状态、绑定码、进程内文件锁。
 *
 * 三条不可省的实现约束：
 * 1. **原子写**（tmp + rename）。崩溃在写一半时留下的是旧文件，而不是半个 JSON；
 * 2. **损坏即备份重建**，不静默丢用户的绑定关系——留 .bak 才有救回来的可能；
 * 3. **同文件写序列化**。聊天上下文与绑定码会在消息风暴里被并发 patch，
 *    两个 load-modify-save 交错进行等于后写的那份覆盖掉前一份的绑定。
 *
 * 目录由构造参数注入，因此本模块能在 vitest 里对着真实临时目录跑，不需要打桩 fs。
 */
import fs from 'fs/promises'
import path from 'path'
import { ZodError } from 'zod'
import {
  BotsConfigFileSchema,
  BotsStateFileSchema,
  BIND_CODE_TTL_MS,
  emptyBotsConfig,
  emptyBotsState,
  type BindCode,
  type Binding,
  type BotsConfigFile,
  type BotsStateFile,
  type ChatContext,
} from './types'

export const IM_BOTS_DIRNAME = 'im-bots'
export const CONFIG_FILENAME = 'bots-config.json'
export const STATE_FILENAME = 'bots-state.json'
export const LOCK_DIRNAME = 'locks'

/** 备份文件名：同一秒反复损坏时不覆盖上一份备份 */
function backupPath(target: string, now: number): string {
  return `${target}.corrupt-${Math.floor(now / 1000)}.bak`
}

/**
 * 读一份 JSON 并用 zod strict 校验。
 *
 * 三种失败必须分开：
 * - missing：文件不存在，静默建空档；
 * - corrupt：内容确实是坏的（空文件 / JSON 语法错 / schema 不过），备份成 .bak 再重建；
 * - 其它 I/O 异常（权限、占用、目标其实是目录）**向上抛**：这类情况下文件可能完好，
 *   当损坏处理就等于把用户的绑定关系与工作目录赔给一次读失败。
 *   曾经这里是个 catch-all，连 schema 写错（version 漏了 z.literal）都被吞成「文件损坏」，
 *   表现为「所有状态永远读回空」却毫无声息——所以只吞明确属于「内容坏掉」的两类异常。
 */
async function readValidated<T>(
  file: string,
  schema: { parse: (v: unknown) => T }
): Promise<{ ok: true; value: T } | { ok: false; reason: 'missing' | 'corrupt' }> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: false, reason: 'missing' }
    throw error
  }
  if (raw.trim() === '') return { ok: false, reason: 'corrupt' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
  try {
    return { ok: true, value: schema.parse(parsed) }
  } catch (error) {
    if (error instanceof ZodError) return { ok: false, reason: 'corrupt' }
    throw error
  }
}

/** 原子写：同目录临时文件 + rename（跨目录 rename 在 Windows 上会失败，所以 tmp 必须同目录） */
async function atomicWrite(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  try {
    await fs.rename(tmp, file)
  } catch {
    // rename 失败（目标被别的进程占着 / 跨设备）时退化为覆盖拷贝：copy 成功即视为写入完成，
    // 不再向上抛 rename 的错；copy 也失败时由它抛出真实原因。临时文件无论如何都要清掉。
    try {
      await fs.copyFile(tmp, file)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }
}

export class BotsStorage {
  readonly dir: string
  readonly configFile: string
  readonly stateFile: string
  readonly lockDir: string

  /**
   * 每个文件一条串行链。绑定码核销与上下文 patch 都来自消息回调，
   * 并发是常态而不是异常。
   */
  private writeChain: Map<string, Promise<unknown>> = new Map()
  /** 已就绪标记：首次访问时做一次迁移 / 损坏处理，之后不再重复扫盘 */
  private readyPromise: Promise<void> | null = null

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, IM_BOTS_DIRNAME)
    this.configFile = path.join(this.dir, CONFIG_FILENAME)
    this.stateFile = path.join(this.dir, STATE_FILENAME)
    this.lockDir = path.join(this.dir, LOCK_DIRNAME)
  }

  /**
   * 启动时静默迁移：建目录、把损坏文件挪成 .bak 并重建空档。
   * 迁移失败不阻塞启动（机器人不工作总比应用起不来好），错误回传给调用方记日志。
   */
  ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        await fs.mkdir(this.dir, { recursive: true })
        await this.ensureFile(this.configFile, BotsConfigFileSchema, emptyBotsConfig())
        await this.ensureFile(this.stateFile, BotsStateFileSchema, emptyBotsState())
      })().catch((error) => {
        // 失败后允许下次重试，否则一个瞬时的 EBUSY 会永久锁死整个模块
        this.readyPromise = null
        throw error
      })
    }
    return this.readyPromise
  }

  private async ensureFile<T>(file: string, schema: { parse: (v: unknown) => T }, fallback: T): Promise<void> {
    const read = await readValidated(file, schema)
    if (read.ok) return
    if (read.reason === 'missing') {
      await atomicWrite(file, fallback)
      return
    }
    // 损坏：备份原文件再重建。备份名带秒级时间戳，反复损坏不会互相覆盖。
    const stamp = Date.now()
    try {
      await fs.copyFile(file, backupPath(file, stamp))
    } catch {
      /* 读不到就别再搬了，重建仍然继续 */
    }
    await atomicWrite(file, fallback)
  }
  /** 串行化一次「读 → 改 → 写」，返回改写后的快照 */
  private async transcribe<T>(
    file: string,
    schema: { parse: (v: unknown) => T },
    fallback: () => T,
    mutate: (current: T) => T
  ): Promise<T> {
    await this.ensureReady()
    const previous = this.writeChain.get(file) ?? Promise.resolve()
    // 前一个任务失败不能卡住后续写入，所以链上挂的是 catch 过的版本
    const task = previous.catch(() => {}).then(async () => {
      const read = await readValidated(file, schema)
      const current = read.ok ? read.value : fallback()
      const updated = mutate(current)
      await atomicWrite(file, updated)
      return updated
    })
    this.writeChain.set(file, task.catch(() => {}))
    return task
  }

  // ── 配置 ──────────────────────────────────────────────────────────────────

  async readConfig(): Promise<BotsConfigFile> {
    await this.ensureReady()
    const read = await readValidated(this.configFile, BotsConfigFileSchema)
    return read.ok ? read.value : emptyBotsConfig()
  }

  async writeConfig(next: BotsConfigFile): Promise<BotsConfigFile> {
    return this.transcribe(this.configFile, BotsConfigFileSchema, emptyBotsConfig, () => next)
  }

  // ── 状态 ──────────────────────────────────────────────────────────────────

  async readState(): Promise<BotsStateFile> {
    await this.ensureReady()
    const read = await readValidated(this.stateFile, BotsStateFileSchema)
    return read.ok ? read.value : emptyBotsState()
  }

  async writeState(next: BotsStateFile): Promise<BotsStateFile> {
    return this.transcribe(this.stateFile, BotsStateFileSchema, emptyBotsState, () => next)
  }

  // ── 聊天上下文 ────────────────────────────────────────────────────────────

  async getContext(actorKey: string): Promise<ChatContext | undefined> {
    const state = await this.readState()
    return state.contexts.find((item) => item.actorKey === actorKey)
  }

  /** 就地 patch 一个上下文；create 提供首次进入 draft 态的初值 */
  async patchContext(
    actorKey: string,
    patch: Partial<Omit<ChatContext, 'actorKey'>> | ((current: ChatContext) => Partial<Omit<ChatContext, 'actorKey'>>),
    create?: () => Omit<ChatContext, 'actorKey' | 'updatedAt'>
  ): Promise<ChatContext> {
    const now = Date.now()
    let result!: ChatContext
    await this.transcribe(this.stateFile, BotsStateFileSchema, emptyBotsState, (state) => {
      let index = state.contexts.findIndex((item) => item.actorKey === actorKey)
      let current: ChatContext
      if (index < 0) {
        const seed = create?.() ?? { mode: 'draft' as const }
        current = { ...seed, actorKey, updatedAt: now }
        state.contexts.push(current)
        // 回填真实下标：新建分支若继续用 -1，下面那句赋值就落不到数组上，
        // 于是本次 patch 的 delta 只活在返回值里、永远进不了文件
        // （表现为「第一条消息设的工作目录丢了」，而函数回执看起来一切正常）。
        index = state.contexts.length - 1
      } else {
        current = state.contexts[index] as ChatContext
      }
      const delta = typeof patch === 'function' ? patch(current) : patch
      const next: ChatContext = { ...current, ...delta, actorKey, updatedAt: now }
      state.contexts[index] = next
      result = next
      return state
    })
    return result
  }

  async dropContextsOf(botId: string): Promise<void> {
    await this.transcribe(this.stateFile, BotsStateFileSchema, emptyBotsState, (state) => {
      state.contexts = state.contexts.filter((item) => !item.actorKey.startsWith(`${botId}:`))
      state.bindings = state.bindings.filter((item) => item.botId !== botId)
      state.pendingBinds = state.pendingBinds.filter((item) => item.botId !== botId)
      return state
    })
  }

  // ── 绑定码 ────────────────────────────────────────────────────────────────

  /**
   * 签发绑定码。同一 bot 只保留一条有效码：旧码作废，
   * 否则用户连点两次「生成」就会出现两个都能绑的入口，界面上的倒计时也就失去意义。
   */
  async issueBindCode(botId: string, code: string, ttlMs = BIND_CODE_TTL_MS): Promise<BindCode> {
    const now = Date.now()
    const entry: BindCode = { code, botId, expiresAt: now + ttlMs }
    await this.transcribe(this.stateFile, BotsStateFileSchema, emptyBotsState, (state) => {
      state.pendingBinds = state.pendingBinds.filter(
        (item) => item.botId !== botId && item.expiresAt > now
      )
      state.pendingBinds.push(entry)
      return state
    })
    return entry
  }

  /**
   * 核销绑定码：命中即作废（单次有效），顺手清掉所有过期码。
   * 刻意区分 botId：A 机器人生成的码不能在 B 机器人上绑成功，也不能把它消费掉。
   * 'none' 同时覆盖「不存在」与「已过期」——对用户的回复是同一句，分开只会诱导出泄漏
   * 「这个码存在但属于别人」的探测面。
   */
  async consumeBindCode(botId: string, code: string): Promise<{ ok: boolean; reason?: 'none' | 'mismatch' }> {
    const now = Date.now()
    let outcome: { ok: boolean; reason?: 'none' | 'mismatch' } = { ok: false, reason: 'none' }
    await this.transcribe(this.stateFile, BotsStateFileSchema, emptyBotsState, (state) => {
      state.pendingBinds = state.pendingBinds.filter((item) => item.expiresAt > now)
      const exact = state.pendingBinds.find((item) => item.code === code)
      if (!exact) {
        outcome = { ok: false, reason: 'none' }
        return state
      }
      if (exact.botId !== botId) {
        outcome = { ok: false, reason: 'mismatch' }
        return state
      }
      state.pendingBinds = state.pendingBinds.filter((item) => item !== exact)
      outcome = { ok: true }
      return state
    })
    return outcome
  }

  /** 待展示的绑定码（未过期且未核销） */
  async liveBindCodes(): Promise<BindCode[]> {
    const now = Date.now()
    const state = await this.readState()
    return state.pendingBinds.filter((item) => item.expiresAt > now)
  }

  // ── 绑定关系 ──────────────────────────────────────────────────────────────

  async listBindings(botId?: string): Promise<Binding[]> {
    const state = await this.readState()
    return botId ? state.bindings.filter((item) => item.botId === botId) : state.bindings
  }

  async isBound(actorKey: string): Promise<boolean> {
    const state = await this.readState()
    return state.bindings.some((item) => item.actorKey === actorKey)
  }

  async addBinding(binding: Binding): Promise<void> {
    await this.transcribe(this.stateFile, BotsStateFileSchema, emptyBotsState, (state) => {
      state.bindings = state.bindings.filter((item) => item.actorKey !== binding.actorKey)
      state.bindings.push(binding)
      return state
    })
  }

  /** 解绑：绑定关系、聊天上下文一起清，避免「解了绑还留着工作目录」 */
  async removeBinding(actorKey: string): Promise<void> {
    await this.transcribe(this.stateFile, BotsStateFileSchema, emptyBotsState, (state) => {
      state.bindings = state.bindings.filter((item) => item.actorKey !== actorKey)
      state.contexts = state.contexts.filter((item) => item.actorKey !== actorKey)
      return state
    })
  }

  /** 重置某个聊天身份的会话/目录绑定，但保留绑定关系（界面上的「重置状态」） */
  async resetContext(actorKey: string): Promise<void> {
    await this.transcribe(this.stateFile, BotsStateFileSchema, emptyBotsState, (state) => {
      state.contexts = state.contexts.filter((item) => item.actorKey !== actorKey)
      return state
    })
  }

  // ── 进程文件锁 ────────────────────────────────────────────────────────────

  /**
   * 防双跑：同一 bot 的长轮询只允许一个持有者。
   *
   * ClerkBox 主进程本身只有一个，但「开发时开着旧实例、又 npm run dev 起一个新实例」
   * 是真的会发生的双跑来源——两个客户端同时 getUpdates 会互相吃掉对方的消息。
   * 因此锁文件写 PID，且用 signal 0 校验进程是否还活着：崩溃留下的死锁必须能被抢回来，
   * 否则一次蓝屏就永久停用这条通道。
   */
  async acquireLock(botId: string): Promise<{ acquired: boolean; holderPid?: number }> {
    await this.ensureReady()
    const file = path.join(this.lockDir, `${safeLockName(botId)}.lock`)
    const holder = await this.readLockPid(file)
    if (holder !== null && isPidAlive(holder) && holder !== process.pid) {
      return { acquired: false, holderPid: holder }
    }
    await atomicWrite(file, { pid: process.pid, at: Date.now() })
    return { acquired: true }
  }

  async releaseLock(botId: string): Promise<void> {
    const file = path.join(this.lockDir, `${safeLockName(botId)}.lock`)
    const holder = await this.readLockPid(file)
    // 只删自己持有的锁：误删他人锁文件会让两个轮询并存
    if (holder === null || holder === process.pid) {
      await fs.rm(file, { force: true }).catch(() => {})
    }
  }

  private async readLockPid(file: string): Promise<number | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'))
      if (parsed && typeof parsed === 'object' && typeof (parsed as { pid?: unknown }).pid === 'number') {
        return (parsed as { pid: number }).pid
      }
      return null
    } catch {
      return null
    }
  }
}

/**
 * 锁文件名要消毒：nanoid 只会用到 [A-Za-z0-9_-]，所以点号一并换掉——
 * 保留点号时 '../../etc/passwd' 会洗成 '.._.._etc_passwd'，那两段 '..' 仍然能穿目录。
 */
export function safeLockName(botId: string): string {
  return botId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'bot'
}

/** signal 0 只做存在性探测，不发信号；EPERM 说明进程存在但不属于当前用户，按「活着」处理 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}
