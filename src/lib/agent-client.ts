/**
 * 宿主事件流的渲染层薄客户端（批次 B · P4）。
 *
 * 只做一件事：把宿主事件按序、不重、不丢地送到订阅方。业务语义解释在 chat-store 的
 * reducer 里，两者刻意分开——事件可以来自实时推送、缺口补发或 F5 后的整环回放，
 * 订阅方不该关心是哪一种。
 *
 * 丢事件比重复事件危险得多，所以：seq 小于等于已见值直接丢（幂等压力留给 reducer），
 * 出现缺口就去要补发，补发失败则按退避重试并挂 reconnecting 状态给 UI 显示。
 */
import { ipc } from './ipc-client'
import type { AgentCommand, AgentEvent, AgentSnapshot } from '../agent-core/protocol'

export type AgentConnection = 'offline' | 'connected' | 'reconnecting'

/** 缺口期间最多扣住事件多久（毫秒）：补发没填上洞就兜底放行 */
const PENDING_HOLD_MS = 3_000
/** 扣住事件的上限，防止宿主长时间不可达时无界增长 */
const PENDING_MAX = 2_000

export interface AgentTransport {
  command(cmd: AgentCommand): Promise<{ ok: boolean; error?: string }>
  snapshot(sessionId: string | undefined, sinceSeq: number): Promise<AgentSnapshot>
  onEvent(callback: (payload: { seq: number; event: AgentEvent }) => void): () => void
  mode(): Promise<'main' | 'renderer'>
}

const browserTransport: AgentTransport = {
  command: (cmd) => ipc.agentCommand(cmd),
  snapshot: (sessionId, sinceSeq) => ipc.agentSnapshot(sessionId, sinceSeq),
  onEvent: (callback) => ipc.onAgentEvent(callback),
  mode: () => ipc.agentHostMode(),
}

export interface AgentClientOptions {
  /** 退避基数与上限（毫秒）；测试里压小避免真实等待 */
  retryBaseMs?: number
  retryMaxMs?: number
}

export interface AgentClient {
  /** 订阅并判定模式。返回 true 表示宿主模式已接管编排，调用方才该把运行交给宿主 */
  start(): Promise<boolean>
  /**
   * 拿到确定的模式答案：尚未 start 过就就地启动。
   * 发消息前必须走这里——否则应用刚启动、模式还没问出来那一刻会被误判成本地路径，
   * 结果本地循环与宿主循环同时跑一遍（同一会话两份请求、两份落库）。
   */
  ensureMode(): Promise<'main' | 'renderer'>
  stop(): void
  send(cmd: AgentCommand): Promise<{ ok: boolean; error?: string }>
  subscribe(listener: (event: AgentEvent, seq: number) => void): () => void
  onConnectionChange(listener: (state: AgentConnection) => void): () => void
  /** 主动请求 sinceSeq 之后的事件补发（宿主直接广播回来） */
  resync(sessionId?: string): Promise<void>
  getState(): { mode: 'main' | 'renderer' | null; connection: AgentConnection; lastSeq: number }
}

export function createAgentClient(
  transport: AgentTransport = browserTransport,
  options: AgentClientOptions = {}
): AgentClient {
  const retryBaseMs = options.retryBaseMs ?? 1000
  const retryMaxMs = options.retryMaxMs ?? 10_000

  const listeners = new Set<(event: AgentEvent, seq: number) => void>()
  const connListeners = new Set<(state: AgentConnection) => void>()
  /** 缺口期间扣住的乱序事件：seq → event，补发回来后按序放行 */
  const pending = new Map<number, AgentEvent>()

  let mode: 'main' | 'renderer' | null = null
  let connection: AgentConnection = 'offline'
  let lastSeq = 0
  let attempt = 0
  let unsubEvents: (() => void) | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let resyncing: Promise<void> | null = null

  function setConnection(next: AgentConnection): void {
    if (connection === next) return
    connection = next
    for (const listener of connListeners) listener(next)
  }

  function clearRetry(): void {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }

  function clearPendingTimer(): void {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = null
  }

  /** 向宿主取回 sinceSeq 之后的事件。并发调用共用同一次补发 */
  function resync(sessionId?: string): Promise<void> {
    if (resyncing) return resyncing
    const call = (async () => {
      try {
        await transport.snapshot(sessionId, lastSeq)
        attempt = 0
        if (mode === 'main') setConnection('connected')
      } catch (err) {
        console.warn('[agent-client] 补发失败，退避重试：', err instanceof Error ? err.message : err)
        setConnection('reconnecting')
        scheduleRetry()
      }
    })()
    resyncing = call
    void call.finally(() => {
      if (resyncing === call) resyncing = null
    })
    return call
  }

  function scheduleRetry(): void {
    if (retryTimer) return
    const delay = Math.min(retryBaseMs * 2 ** attempt, retryMaxMs)
    attempt += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      void resync()
    }, delay)
  }

  function deliver(event: AgentEvent, seq: number): void {
    for (const listener of listeners) {
      try {
        listener(event, seq)
      } catch (err) {
        // 一个订阅方抛错不能吞掉后续订阅方（reducer 的 bug 不该演变成事件丢失）
        console.error('[agent-client] listener failed:', err)
      }
    }
  }

  /** 连续段放行；留下洞就等补发 */
  function flushPending(): void {
    for (;;) {
      const next = pending.get(lastSeq + 1)
      if (next === undefined) break
      pending.delete(lastSeq + 1)
      lastSeq += 1
      deliver(next, lastSeq)
    }
    if (pending.size === 0) {
      clearPendingTimer()
      return
    }
    // 补发迟迟不回来（环已被裁掉那段）：兜底放行，宁可乱序也不把事件永久扣在手里
    if (!pendingTimer) pendingTimer = setTimeout(() => {
      pendingTimer = null
      forceFlush()
    }, PENDING_HOLD_MS)
  }

  function forceFlush(): void {
    clearPendingTimer()
    for (const seq of [...pending.keys()].sort((a, b) => a - b)) {
      const event = pending.get(seq)
      pending.delete(seq)
      lastSeq = seq
      if (event) deliver(event, seq)
    }
  }

  function handlePayload(payload: { seq: number; event: AgentEvent }): void {
    const { seq, event } = payload
    if (!Number.isFinite(seq) || seq <= lastSeq || pending.has(seq)) return
    if (pending.size >= PENDING_MAX) forceFlush()
    // 缺口期间不能直接把游标推到新事件上：那样补发回来的旧事件会被下面那条
    // seq <= lastSeq 判成重复而全数丢弃——补发等于没补（原实现正是如此）。
    pending.set(seq, event)
    if (seq > lastSeq + 1) void resync()
    flushPending()
  }

  async function startInner(): Promise<boolean> {
    if (started) return mode === 'main'
    started = true
    const resolved = await transport.mode().catch(() => 'renderer' as const)
    mode = resolved
    if (resolved !== 'main') {
      // renderer 模式下不建订阅：省一份常驻开销，也避免把 no-op 通道当"已连接"
      setConnection('offline')
      return false
    }
    unsubEvents = transport.onEvent(handlePayload)
    setConnection('connected')
    // 冷启动与 F5 都靠这一次把窗口期内产生的事件补回来（lastSeq 从 0 起，即整环回放）
    await resync()
    return true
  }

  return {
    start: startInner,
    async ensureMode() {
      if (!started) await startInner()
      return mode ?? 'renderer'
    },
    stop() {
      started = false
      clearRetry()
      clearPendingTimer()
      pending.clear()
      unsubEvents?.()
      unsubEvents = null
      resyncing = null
      mode = null
      setConnection('offline')
    },
    send(cmd) {
      return transport.command(cmd)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onConnectionChange(listener) {
      connListeners.add(listener)
      return () => {
        connListeners.delete(listener)
      }
    },
    resync,
    getState() {
      return { mode, connection, lastSeq }
    },
  }
}

/** 渲染层单例：宿主事件是全局流，不该按组件各建一份订阅 */
export const agentClient = createAgentClient()

export type { AgentEvent, AgentCommand, AgentSnapshot }
