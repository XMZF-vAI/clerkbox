import { ipc } from './ipc-client'
import { endpointFor, headersFor } from './api-adapters'
import type { ApiCompat } from '../types/agent'

/**
 * 统一传输层。
 *
 * 把「主进程代理」和「渲染进程直连」两条路收敛成同一个返回值：
 * 一个 `AsyncIterable<string>` 文本流。上层的 SSE 拆行 + 协议解析对两条路完全一致。
 *
 * 默认走主进程 —— 渲染进程直连受浏览器同源策略约束，能不能通取决于对方放不放 CORS，
 * 不可控。直连只作为排障退路（provider.directFetch）。
 */

export interface TransportConfig {
  baseUrl: string
  apiKey: string
  apiCompat: ApiCompat
  /** true = 渲染进程直连；默认 false（走主进程代理） */
  directFetch?: boolean
}

/** 单次 IPC 分片订阅的收尾器，避免泄漏 */
type Unsubscribe = () => void

/**
 * 发起流式对话，返回文本分片的异步迭代器。
 * `signal` 触发时会中止底层请求（主进程路径经 apiAbort，直连路径经 fetch signal）。
 */
export async function openChatStream(
  cfg: TransportConfig,
  body: unknown,
  signal: AbortSignal
): Promise<AsyncIterable<string>> {
  return cfg.directFetch
    ? openDirectStream(cfg, body, signal)
    : openProxyStream(cfg, body, signal)
}

/** 主进程代理：invoke 拿 requestId，分片经 apiChunk 事件推回 */
async function openProxyStream(
  cfg: TransportConfig,
  body: unknown,
  signal: AbortSignal
): Promise<AsyncIterable<string>> {
  const conn = { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, apiCompat: cfg.apiCompat }

  // 分片可能在 invoke 返回前就到达（主进程是先注册后台任务再 return），
  // 所以必须**先订阅再 invoke**，并把早到的分片按 requestId 暂存。
  const pendingByRequest = new Map<string, Array<{ chunk?: string; done?: boolean; error?: string }>>()
  let myRequestId: string | null = null
  let waiter: (() => void) | null = null

  const queue: Array<{ chunk?: string; done?: boolean; error?: string }> = []
  const enqueue = (p: { chunk?: string; done?: boolean; error?: string }) => {
    queue.push(p)
    waiter?.()
    waiter = null
  }

  const unsubscribe: Unsubscribe = ipc.onApiChunk((payload) => {
    if (myRequestId === null) {
      // 还不知道自己的 requestId，先按 id 暂存
      const list = pendingByRequest.get(payload.requestId)
      if (list) list.push(payload)
      else pendingByRequest.set(payload.requestId, [payload])
      return
    }
    if (payload.requestId !== myRequestId) return
    enqueue(payload)
  })

  let requestId: string
  try {
    const res = await ipc.apiChatStream(conn, body)
    requestId = res.requestId
  } catch (e) {
    unsubscribe()
    throw e
  }

  myRequestId = requestId
  // 冲刷 invoke 期间早到的分片
  const early = pendingByRequest.get(requestId)
  if (early) for (const p of early) queue.push(p)
  pendingByRequest.clear()

  const onAbort = () => {
    void ipc.apiAbort(requestId)
    enqueue({ done: true })
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  const cleanup = () => {
    unsubscribe()
    signal.removeEventListener('abort', onAbort)
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (queue.length === 0) {
            if (signal.aborted) return
            await new Promise<void>((resolve) => { waiter = resolve })
            continue
          }
          const p = queue.shift()!
          if (p.error) throw new Error(p.error)
          if (p.done) return
          if (p.chunk) yield p.chunk
        }
      } finally {
        cleanup()
      }
    },
  }
}

/** 渲染进程直连：普通 fetch + ReadableStream */
async function openDirectStream(
  cfg: TransportConfig,
  body: unknown,
  signal: AbortSignal
): Promise<AsyncIterable<string>> {
  const url = endpointFor(cfg.apiCompat, cfg.baseUrl, 'chat')
  const response = await fetch(url, {
    method: 'POST',
    headers: headersFor(cfg.apiCompat, cfg.apiKey, { direct: true }),
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    // 截断错误响应体到前 500 字符，避免超长错误信息撑爆 UI / 日志
    const errText = (await response.text().catch(() => '')).slice(0, 500)
    throw new Error(`API Error ${response.status}: ${errText}`)
  }
  const stream = response.body
  if (!stream) throw new Error('No response body')

  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (signal.aborted) break
          yield decoder.decode(value, { stream: true })
        }
        const tail = decoder.decode()
        if (tail) yield tail
      } finally {
        reader.releaseLock()
      }
    },
  }
}

/**
 * 非流式请求（compact 用）。同样两条路，返回已解析的 JSON。
 */
export async function postJson(cfg: TransportConfig, body: unknown): Promise<unknown> {
  if (!cfg.directFetch) {
    // 主进程代理没有独立的非流式通道 —— 复用流式通道把分片拼回完整响应体。
    // 非流式响应体本身很小（一段摘要），拼接开销可忽略。
    const ac = new AbortController()
    const stream = await openChatStream(cfg, body, ac.signal)
    let text = ''
    for await (const chunk of stream) text += chunk
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 500)}`)
    }
  }

  const url = endpointFor(cfg.apiCompat, cfg.baseUrl, 'chat')
  const response = await fetch(url, {
    method: 'POST',
    headers: headersFor(cfg.apiCompat, cfg.apiKey, { direct: true }),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const errText = (await response.text().catch(() => '')).slice(0, 500)
    throw new Error(`API Error ${response.status}: ${errText}`)
  }
  return response.json()
}

/**
 * SSE 拆行：把文本分片流转成一条条 `data:` 负载的 JSON 字符串。
 * OpenAI 与 Anthropic 的 SSE 都是 `data: {...}` 行格式，差异只在负载结构。
 */
export async function* sseLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === 'data: [DONE]') continue
      if (!trimmed.startsWith('data: ')) continue // 跳过 event: / id: / 注释行
      yield trimmed.slice(6)
    }
  }
  // 收尾：最后一行可能没有换行符
  const trimmed = buffer.trim()
  if (trimmed && trimmed !== 'data: [DONE]' && trimmed.startsWith('data: ')) {
    yield trimmed.slice(6)
  }
}
