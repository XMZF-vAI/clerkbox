import { ipc } from './ipc-client'
import { endpointFor, headersFor, formatRetryAfterHint } from './api-adapters'
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

const DIRECT_STREAM_IDLE_TIMEOUT_MS = 60_000
const DIRECT_RESPONSE_LIMIT = 20 * 1024 * 1024
const DIRECT_ERROR_LIMIT = 8 * 1024
const DIRECT_REQUEST_LIMIT = 10 * 1024 * 1024

function redactApiKey(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join('[REDACTED]') : message
}

function serializeRequestBody(body: unknown): string {
  const serialized = JSON.stringify(body)
  if (typeof serialized !== 'string') throw new Error('Request body must be serializable JSON')
  if (new TextEncoder().encode(serialized).byteLength > DIRECT_REQUEST_LIMIT) {
    throw new Error(`Request body exceeds the ${DIRECT_REQUEST_LIMIT} byte limit`)
  }
  return serialized
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done || !value) break
      if (value.byteLength > maxBytes - received) {
        await reader.cancel()
        throw new Error(`Response exceeds the ${maxBytes} byte limit`)
      }
      chunks.push(value)
      received += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

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
    body: serializeRequestBody(body),
    signal,
  })

  if (!response.ok) {
    // 截断错误响应体到前 500 字符，避免超长错误信息撑爆 UI / 日志
    const errText = redactApiKey(await readBoundedText(response, DIRECT_ERROR_LIMIT).catch(() => ''), cfg.apiKey)
    // 透传服务端 Retry-After 指示（retry agent 解析后按服务端要求延迟重试）
    const retryHint = formatRetryAfterHint(response.headers)
    throw new Error(`API Error ${response.status}${retryHint}: ${errText}`)
  }
  const stream = response.body
  if (!stream) throw new Error('No response body')

  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let receivedBytes = 0
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => { void reader.cancel() }
      signal.addEventListener('abort', onAbort, { once: true })
      const clearIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = undefined
      }
      try {
        while (true) {
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
              idleTimer = setTimeout(() => {
                void reader.cancel()
                reject(new Error(`Stream stalled for ${DIRECT_STREAM_IDLE_TIMEOUT_MS / 1000}s`))
              }, DIRECT_STREAM_IDLE_TIMEOUT_MS)
            }),
          ])
          clearIdleTimer()
          if (done) break
          if (signal.aborted) break
          receivedBytes += value.byteLength
          if (receivedBytes > DIRECT_RESPONSE_LIMIT) {
            await reader.cancel()
            throw new Error(`Stream exceeds the ${DIRECT_RESPONSE_LIMIT} byte limit`)
          }
          yield decoder.decode(value, { stream: true })
        }
        const tail = decoder.decode()
        if (tail) yield tail
      } finally {
        clearIdleTimer()
        signal.removeEventListener('abort', onAbort)
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
    body: serializeRequestBody(body),
  })
  if (!response.ok) {
    const errText = redactApiKey(await readBoundedText(response, DIRECT_ERROR_LIMIT).catch(() => ''), cfg.apiKey)
    const retryHint = formatRetryAfterHint(response.headers)
    throw new Error(`API Error ${response.status}${retryHint}: ${errText}`)
  }
  const text = await readBoundedText(response, DIRECT_RESPONSE_LIMIT)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Invalid JSON response')
  }
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
