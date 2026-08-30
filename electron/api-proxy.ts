import { ipcMain, BrowserWindow } from 'electron'
import { deflateSync } from 'node:zlib'

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
/** 图片输入探测图：32×32 纯紫色（#800080）PNG。探测靠验证回复内容（见 classifyVisionReply），
 *  颜色不能从提示词猜出来，所以只有真看到图的模型才答得出「紫色」。 */
const VISION_PROBE_PNG = solidColorPng(32, 128, 0, 128).toString('base64')
const VISION_PROBE_PROMPT = 'What is the dominant color of this image? Answer with one word.'
const MODEL_LIST_LIMIT = 2 * 1024 * 1024
const STREAM_RESPONSE_LIMIT = 20 * 1024 * 1024
const REQUEST_BODY_LIMIT = 10 * 1024 * 1024
const MAX_API_KEY_BYTES = 16 * 1024
const MAX_BASE_URL_LENGTH = 4_096

/** 在途请求：requestId → AbortController */
const inflight = new Map<string, AbortController>()
const userAborted = new Set<string>()

// ── 视觉能力探测辅助 ──

/** PNG CRC32（标准多项式 0xEDB88320） */
function pngCrc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(pngCrc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** 生成纯色 PNG（truecolor RGB）。运行时生成而非硬编码 base64，颜色可调且无抄错风险。 */
function solidColorPng(size: number, r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const row = Buffer.alloc(1 + size * 3)
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 提取非流式回复文本（OpenAI choices / Anthropic content blocks 双协议） */
function extractReplyText(body: string, compat: ApiCompat): string {
  try {
    const json: unknown = JSON.parse(body)
    if (compat === 'anthropic') {
      const content = (json as { content?: unknown })?.content
      if (!Array.isArray(content)) return ''
      return content
        .filter(
          (b): b is { text: string } =>
            typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string'
        )
        .map((b) => b.text)
        .join(' ')
    }
    const content = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter(
          (p): p is { text: string } =>
            typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text' &&
            typeof (p as { text?: unknown }).text === 'string'
        )
        .map((p) => p.text)
        .join(' ')
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 探测回复分类：true=确认支持 / false=确认不支持 / null=无法判定。
 * 关键是防误报（把纯文本模型判成支持）：只有真说出图里的颜色才算支持。
 * 纯文本模型的两种典型反应——明确说看不到图片（判 false）、瞎猜一个常见
 * 颜色如红/蓝/绿（判 null 保持现值）——都不会被误标为支持。
 */
function classifyVisionReply(reply: string): boolean | null {
  const t = reply.trim().toLowerCase()
  if (t.length === 0) return null
  if (/purple|violet|紫/.test(t)) return true
  if (
    /cannot see|can't see|can not see|unable to (see|view|access|process|analyze)|not able to|don't see|do not see|did not receive|didn't receive|haven't received|no image|no picture|without (the|any) image|text-only|text only|does not support|not support|无法|看不到|没有图|未提供|不支持|不能查看|无法查看|无法识别|无法分析/.test(t)
  ) {
    return false
  }
  return null
}

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

/**
 * 从错误响应头提取服务端的限流重试指示，格式化为 " (retry after Ns)" 附加段。
 * 优先 retry-after-ms（毫秒），其次 retry-after（秒数或 HTTP 日期——日期形式忽略，交给指数退避）。
 * 渲染进程直连路径（api-transport.ts）使用同一格式，retry agent 按统一约定解析。
 */
export function formatRetryAfterHint(headers: Headers): string {
  try {
    const ms = headers.get('retry-after-ms')
    if (ms) {
      const v = Number(ms)
      if (Number.isFinite(v) && v > 0) return ` (retry after ${Math.round(v)}ms)`
    }
    const sec = headers.get('retry-after')
    if (sec && /^\d+(\.\d+)?$/.test(sec.trim())) {
      const v = Number(sec)
      if (v > 0) return ` (retry after ${Math.round(v * 1000)}ms)`
    }
  } catch { /* Headers 不可枚举等异常场景静默忽略 */ }
  return ''
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
   * 探测模型图片输入支持：向 chat 端点发一个 1×1 PNG 的最小非流式多模态请求，
   * 只看 HTTP 通不通（2xx 即视为支持），不解析响应内容。
   */
  ipcMain.handle('apiTestVision', async (_e, cfg: ApiConnConfig, modelId: string) => {
    try {
      assertApiConfig(cfg)
      if (typeof modelId !== 'string' || modelId.length === 0) throw new Error('Invalid model id')
      const messages = cfg.apiCompat === 'anthropic'
        ? [{
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROBE_PROMPT },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: VISION_PROBE_PNG } },
            ],
          }]
        : [{
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROBE_PROMPT },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${VISION_PROBE_PNG}` } },
            ],
          }]
      const res = await fetchWithTimeout(
        endpointFor(cfg.apiCompat, cfg.baseUrl, 'chat'),
        {
          method: 'POST',
          headers: headersFor(cfg),
          body: JSON.stringify({ model: modelId, messages, max_tokens: 64, stream: false }),
        },
        20_000
      )
      if (!res.ok) {
        const body = redactApiKey(await readResponseText(res, ERROR_BODY_LIMIT).catch(() => ''), apiKeyFromConfig(cfg))
        return { ok: false as const, status: res.status, error: `HTTP ${res.status}${body ? `: ${body}` : ''}` }
      }
      // HTTP 200 ≠ 支持图片：很多兼容服务对纯文本模型也照常 200（静默忽略图片）。
      // 必须看回复内容：说出图里的颜色才算支持。
      const raw = await readResponseText(res, ERROR_BODY_LIMIT)
      const reply = extractReplyText(raw, cfg.apiCompat)
      const supported = classifyVisionReply(reply)
      return { ok: true as const, supported, reply: reply.slice(0, 200) }
    } catch (e) {
      return { ok: false as const, error: redactApiKey(errMsg(e), apiKeyFromConfig(cfg)) }
    }
  })

  /**
   * 发起流式对话。立即返回 requestId，响应分片经 `apiChunk` 事件推回。
   * 事件负载：{requestId, chunk?} | {requestId, done: true} | {requestId, error}
   */
  ipcMain.handle('apiChatStream', async (event, cfg: ApiConnConfig, body: unknown) => {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const wc = event.sender
    const send = (payload: Record<string, unknown>) => {
      if (!wc.isDestroyed()) wc.send('apiChunk', { requestId, ...payload })
    }
    // 后台跑，不阻塞 invoke 返回
    startChatStream(cfg, body, requestId, send)
    return { requestId }
  })

  /** 中止在途请求 */
  ipcMain.handle('apiAbort', (_e, requestId: string) => {
    abortChatStream(requestId)
  })
}

/**
 * 发起流式对话的核心逻辑。IPC 与 WebUI 共用此函数。
 * 分片通过 send 回调推回（IPC 走 webContents.send，WebUI 走 SSE res.write）。
 * 负载：{chunk?} | {done: true} | {error}
 */
export function startChatStream(
  cfg: ApiConnConfig,
  body: unknown,
  requestId: string,
  send: (payload: Record<string, unknown>) => void
): void {
  const controller = new AbortController()
  inflight.set(requestId, controller)

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
        // 把服务端的 Retry-After 指示透传进错误文本（retry agent 解析后按服务端要求延迟重试）
        const retryHint = formatRetryAfterHint(res.headers)
        send({ error: `API Error ${res.status}${retryHint}: ${errText}` })
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
}

/** 中止指定在途请求。IPC 与 WebUI 共用。 */
export function abortChatStream(requestId: string): void {
  if (inflight.has(requestId)) userAborted.add(requestId)
  inflight.get(requestId)?.abort()
  inflight.delete(requestId)
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
