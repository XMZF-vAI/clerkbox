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
  /** 订阅并判定模式。返回 true 表示宿主模式已接管编排，调用方才该把运行交给它 */
  start(): Promise<boolean>
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

  let mode: 'main' | 'renderer' | null = null
  let connection: AgentConnection = 'offline'
  let lastSeq = 0
  let attempt = 0
  let unsubEvents: (() => void) | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
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

  function handlePayload(payload: { seq: number; event: AgentEvent }): void {
    const { seq, event } = payload
    if (!Number.isFinite(seq) || seq <= lastSeq) return
    if (seq > lastSeq + 1) void resync()
    lastSeq = seq
    for (const listener of listeners) {
      try {
        listener(event, seq)
      } catch (err) {
        // 一个订阅方抛错不能吞掉后续订阅方（reducer  bug 不该演变成事件丢失）
        console.error('[agent-client] listener failed:', err)
      }
    }
  }

  return {
    async start() {
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
    },
    stop() {
      started = false
      clearRetry()
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
