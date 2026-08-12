import { ipcMain, BrowserWindow } from 'electron'

/**
 * 主进程 API 代理。
 *
 * 存在的理由：渲染进程直连模型 API 受浏览器同源策略约束 —— 能不能通完全取决于对方
 * 放不放 CORS（DeepSeek / 智谱放，Anthropic 官方端点、自建服务、企业代理大概率不放）。
 * 把 fetch 搬到主进程后彻底没有 CORS 概念，任何端点都能连。
 *
 * 流式响应经 `apiChunk` 事件分片推回渲染进程；渲染进程侧再做 SSE 拆行与协议解析
 * （与直连模式共用同一套解析代码）。
 */

export type ApiCompat = 'openai' | 'anthropic'

export interface ApiConnConfig {
  baseUrl: string
  apiKey: string
  apiCompat: ApiCompat
}

const ANTHROPIC_VERSION = '2023-06-01'
/** 单次请求上限，与渲染进程原有语义保持一致 */
const REQUEST_TIMEOUT_MS = 120_000
/** A stream must continue making progress after its response headers arrive. */
const STREAM_IDLE_TIMEOUT_MS = 60_000
/** 分片合批：攒够时长或字节数就推一次，避免 IPC 洪泛 */
const FLUSH_INTERVAL_MS = 16
const FLUSH_BYTES = 8192
const ERROR_BODY_LIMIT = 8 * 1024
const MODEL_LIST_LIMIT = 2 * 1024 * 1024
const STREAM_RESPONSE_LIMIT = 20 * 1024 * 1024
const REQUEST_BODY_LIMIT = 10 * 1024 * 1024
const MAX_API_KEY_BYTES = 16 * 1024
const MAX_BASE_URL_LENGTH = 4_096

/** 在途请求：requestId → AbortController */
const inflight = new Map<string, AbortController>()
const userAborted = new Set<string>()

function assertApiConfig(value: unknown): asserts value is ApiConnConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid API configuration')
  const cfg = value as Partial<ApiConnConfig>
  if (cfg.apiCompat !== 'openai' && cfg.apiCompat !== 'anthropic') throw new Error('Invalid API compatibility mode')
  if (typeof cfg.baseUrl !== 'string' || cfg.baseUrl.length === 0 || cfg.baseUrl.length > MAX_BASE_URL_LENGTH) {
    throw new Error('Invalid API base URL')
  }
  let parsed: URL
  try { parsed = new URL(cfg.baseUrl) } catch { throw new Error('Invalid API base URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('API base URL must use HTTP or HTTPS')
  if (parsed.username || parsed.password) throw new Error('API base URL must not contain credentials')
  if (typeof cfg.apiKey !== 'string' || Buffer.byteLength(cfg.apiKey, 'utf8') > MAX_API_KEY_BYTES) {
    throw new Error('Invalid or oversized API key')
  }
}

function apiKeyFromConfig(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const apiKey = (value as { apiKey?: unknown }).apiKey
  return typeof apiKey === 'string' ? apiKey : ''
}

/** 去掉尾部斜杠 */
const trimSlash = (s: string) => s.replace(/\/+$/, '')

/**
 * 端点归一化。
 *
 * OpenAI 侧的 baseUrl 惯例是已含 `/v1`（如 `https://api.deepseek.com/v1`），拼 `/chat/completions`。
 * Anthropic 侧要 `/v1/messages`，但用户可能填 `https://api.anthropic.com` 也可能填
 * `https://api.anthropic.com/v1` —— 已以 `/v1` 结尾就不再补，两种写法都能用。
 */
export function endpointFor(compat: ApiCompat, baseUrl: string, kind: 'chat' | 'models'): string {
  const base = trimSlash(baseUrl)
  if (compat === 'anthropic') {
    const withV1 = /\/v1$/.test(base) ? base : `${base}/v1`
    return kind === 'chat' ? `${withV1}/messages` : `${withV1}/models`
  }
  return kind === 'chat' ? `${base}/chat/completions` : `${base}/models`
}

/** 构造认证与协议头。direct=true 时给 Anthropic 加浏览器直连头（仅渲染进程直连路径需要） */
export function headersFor(cfg: ApiConnConfig, opts: { direct?: boolean } = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiCompat === 'anthropic') {
    if (cfg.apiKey) h['x-api-key'] = cfg.apiKey
    h['anthropic-version'] = ANTHROPIC_VERSION
    if (opts.direct) h['anthropic-dangerous-direct-browser-access'] = 'true'
  } else if (cfg.apiKey) {
    h.Authorization = `Bearer ${cfg.apiKey}`
  }
  return h
}

/** 归一化模型列表：OpenAI `{data:[{id}]}` / Anthropic `{data:[{id, display_name}]}` → `{id, label}` */
export function normalizeModelList(raw: unknown): Array<{ id: string; label?: string }> {
  if (!raw || typeof raw !== 'object') return []
  const obj = raw as Record<string, unknown>
  // 绝大多数实现是 { data: [...] }；少数直接返回数组；Ollama 原生接口是 { models: [...] }
  const list = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(raw)
      ? (raw as unknown[])
      : Array.isArray(obj.models)
        ? obj.models
        : []

  const out: Array<{ id: string; label?: string }> = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item === 'string') {
      if (!seen.has(item)) { seen.add(item); out.push({ id: item }) }
      continue
    }
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id
      : typeof rec.name === 'string' ? rec.name
        : typeof rec.model === 'string' ? rec.model
          : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const display = typeof rec.display_name === 'string' ? rec.display_name : undefined
    out.push({ id, label: display && display !== id ? display : undefined })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** 带超时的 fetch；错误信息里绝不包含 apiKey */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`Request timeout after ${timeoutMs / 1000}s`)), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal })
  } finally {
    clearTimeout(timer)
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Remove the active API key before returning provider diagnostics to the renderer. */
function redactApiKey(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join('[REDACTED]') : message
}

/** Read a response body without allowing an untrusted endpoint to allocate unbounded memory. */
async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done || !value) break
      const remaining = maxBytes - receivedBytes
      if (value.byteLength > remaining || remaining === 0) {
        await reader.cancel()
        throw new Error(`Response exceeds the ${maxBytes} byte limit`)
      }
      chunks.push(value)
      receivedBytes += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

export function registerApiProxyHandlers() {
  /** 拉取模型列表 */
  ipcMain.handle('apiFetchModels', async (_e, cfg: ApiConnConfig) => {
    try {
      assertApiConfig(cfg)
      const url = endpointFor(cfg.apiCompat, cfg.baseUrl, 'models')
      const res = await fetchWithTimeout(url, { method: 'GET', headers: headersFor(cfg) }, 30_000)
      if (!res.ok) {
        const body = redactApiKey(await readResponseText(res, ERROR_BODY_LIMIT).catch(() => ''), apiKeyFromConfig(cfg))
        return { error: `HTTP ${res.status}${body ? `: ${body}` : ''}` }
      }
      let text: string
      try {
        text = await readResponseText(res, MODEL_LIST_LIMIT)
      } catch (e) {
        return { error: redactApiKey(errMsg(e), apiKeyFromConfig(cfg)) }
      }
      let json: unknown = null
      try {
        json = JSON.parse(text)
      } catch {
        return { error: 'Invalid model-list response' }
      }
      const models = normalizeModelList(json)
      if (models.length === 0) return { error: 'EMPTY_LIST' }
      return { models }
    } catch (e) {
      return { error: redactApiKey(errMsg(e), apiKeyFromConfig(cfg)) }
    }
  })

  /** 测试连接：拉一次模型列表，只看通不通 */
  ipcMain.handle('apiTestConnection', async (_e, cfg: ApiConnConfig) => {
    const started = Date.now()
    try {
      assertApiConfig(cfg)
      const url = endpointFor(cfg.apiCompat, cfg.baseUrl, 'models')
      const res = await fetchWithTimeout(url, { method: 'GET', headers: headersFor(cfg) }, 20_000)
      if (!res.ok) {
        const body = redactApiKey(await readResponseText(res, ERROR_BODY_LIMIT).catch(() => ''), apiKeyFromConfig(cfg))
        return { error: `HTTP ${res.status}${body ? `: ${body}` : ''}` }
      }
      return { ok: true as const, latencyMs: Date.now() - started }
    } catch (e) {
      return { error: redactApiKey(errMsg(e), apiKeyFromConfig(cfg)) }
    }
  })

  /**
   * 发起流式对话。立即返回 requestId，响应分片经 `apiChunk` 事件推回。
   * 事件负载：{requestId, chunk?} | {requestId, done: true} | {requestId, error}
   */
  ipcMain.handle('apiChatStream', async (event, cfg: ApiConnConfig, body: unknown) => {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    inflight.set(requestId, controller)

    const wc = event.sender
    const send = (payload: Record<string, unknown>) => {
      if (!wc.isDestroyed()) wc.send('apiChunk', { requestId, ...payload })
    }

    // 后台跑，不阻塞 invoke 返回
    void (async () => {
      let timer: NodeJS.Timeout | undefined
      try {
        assertApiConfig(cfg)
        const url = endpointFor(cfg.apiCompat, cfg.baseUrl, 'chat')
        const serializedBody = JSON.stringify(body)
        if (typeof serializedBody !== 'string') {
          throw new Error('Request body must be serializable JSON')
        }
        if (Buffer.byteLength(serializedBody, 'utf-8') > REQUEST_BODY_LIMIT) {
          throw new Error(`Request body exceeds the ${REQUEST_BODY_LIMIT} byte limit`)
        }
        timer = setTimeout(
          () => controller.abort(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s`)),
          REQUEST_TIMEOUT_MS
        )

        const res = await fetch(url, {
          method: 'POST',
          headers: headersFor(cfg),
          body: serializedBody,
          signal: controller.signal,
        })

        if (!res.ok) {
          const errText = redactApiKey(await readResponseText(res, ERROR_BODY_LIMIT).catch(() => ''), apiKeyFromConfig(cfg))
          send({ error: `API Error ${res.status}: ${errText}` })
          return
        }
        if (!res.body) {
          send({ error: 'No response body' })
          return
        }

        // After headers, replace the connection timeout with a resettable idle timeout.
        const resetIdleTimeout = () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(
            () => controller.abort(new Error(`Stream stalled for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`)),
            STREAM_IDLE_TIMEOUT_MS
          )
        }
        resetIdleTimeout()

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let pending = ''
        let lastFlush = Date.now()
        let receivedBytes = 0

        const flush = () => {
          if (!pending) return
          send({ chunk: pending })
          pending = ''
          lastFlush = Date.now()
        }

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (controller.signal.aborted) {
              if (userAborted.has(requestId)) break
              throw controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new Error('API stream aborted')
            }
            receivedBytes += value.byteLength
            if (receivedBytes > STREAM_RESPONSE_LIMIT) {
              await reader.cancel()
              throw new Error(`Stream exceeds the ${STREAM_RESPONSE_LIMIT} byte limit`)
            }
            resetIdleTimeout()
            pending += decoder.decode(value, { stream: true })
            if (pending.length >= FLUSH_BYTES || Date.now() - lastFlush >= FLUSH_INTERVAL_MS) flush()
          }
          pending += decoder.decode()
          flush()
        } finally {
          reader.releaseLock()
        }

        send({ done: true })
      } catch (e) {
        // 主动 abort 不算错误，渲染进程侧已经知道自己取消了
        if (userAborted.has(requestId)) send({ done: true })
        else send({ error: redactApiKey(errMsg(e), apiKeyFromConfig(cfg)) })
      } finally {
        if (timer) clearTimeout(timer)
        inflight.delete(requestId)
        userAborted.delete(requestId)
      }
    })()

    return { requestId }
  })

  /** 中止在途请求 */
  ipcMain.handle('apiAbort', (_e, requestId: string) => {
    if (inflight.has(requestId)) userAborted.add(requestId)
    inflight.get(requestId)?.abort()
    inflight.delete(requestId)
  })
}

/** 窗口销毁 / reload 时清理所有在途请求，避免流写向已销毁的 webContents */
export function abortAllApiRequests() {
  for (const [requestId, ac] of inflight) {
    userAborted.add(requestId)
    ac.abort()
  }
  inflight.clear()
}

/** 绑定窗口生命周期清理 */
export function bindApiProxyCleanup(win: BrowserWindow) {
  win.webContents.on('destroyed', abortAllApiRequests)
  // reload 会让渲染进程丢掉订阅，旧流的分片没人收，直接掐掉
  win.webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) abortAllApiRequests()
  })
}
