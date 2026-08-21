/**
 * 热土引擎（REngine）账号系统 —— 主进程模块
 *
 * 职责：
 * 1. 热土账号登录（loginkey 流程 + 本地 127.0.0.1 随机端口 HTTP 回调服务器）
 * 2. 用户 Token / 用户信息持久化（safeStorage 加密；系统加密不可用时降级明文并在文件中标记）
 * 3. 数据段云同步：
 *    - clerkbox-memory：全局记忆（~/.clerkbox/memory/ 全量快照）
 *    - clerkbox-models：模型配置（providers + apiKey + 激活项）
 * 4. 全局记忆写入后的自动上传钩子（debounce 5s；需用户开启 autoSync + syncMemory 才触发）
 *
 * 约束：
 * - 软件 Token 只存在于本模块（主进程常量），绝不暴露给渲染进程
 * - 所有对外函数不向渲染层抛异常，错误一律转为 { error } 或逐项结果返回
 * - app.getPath 需在 app ready 后才可用，因此所有路径均惰性获取
 */

import { app, safeStorage, shell } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as os from 'os'
import * as path from 'path'
import type { ModelProvider } from '../src/types/agent'
import type {
  AccountStatus,
  AccountSyncDownloadResult,
  AccountSyncKind,
  AccountSyncResultItem,
  DownloadedModelConfig,
  RtUser,
} from '../src/types/ipc'

// ── 常量（热土引擎接入参数）──

/** 热土 API 代理主机 */
const RT_API_HOST = 'appapi.rtstudio.top'
/** 热土授权页地址 */
const RT_LOGIN_PAGE = 'https://apilogin.rtstudio.top/'
/** 软件 Token：主进程常量，绝不出现在渲染进程代码中 */
const RT_SOFTWARE_TOKEN = 'ca7768aa8ee47b8f5d28f1083b5f444b2b53168c1de292fc4839887d5ed19247'
/** 数据段名：全局记忆 */
const SEGMENT_MEMORY = 'clerkbox-memory'
/** 数据段名：模型配置 */
const SEGMENT_MODELS = 'clerkbox-models'
/** 单段容量上限：1MB（热土限制） */
const MAX_SEGMENT_BYTES = 1024 * 1024
/** 登录回调等待超时：5 分钟 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** API 请求超时 */
const RT_REQUEST_TIMEOUT_MS = 15_000
/** API 响应体大小上限（读段最大约 1MB，留出余量） */
const RT_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024
/** 记忆写入后自动上传的 debounce 时长 */
const AUTO_UPLOAD_DEBOUNCE_MS = 5_000
/** 共享 KV 中设置 store（zustand persist）的键名 */
const SETTINGS_KV_KEY = 'clerkbox-settings'
/** 共享 KV 中账号设置 store（zustand persist）的键名 */
const ACCOUNT_KV_KEY = 'clerkbox-account'

// ── 状态持久化 ──

/** 账号状态文件结构（userData/rt-account.json） */
interface RtAccountState {
  /** 用户 Token：safeStorage 加密后 base64；tokenPlain 为 true 时是明文（降级） */
  tokenEnc: string
  /** true = tokenEnc 为明文（safeStorage 不可用时的降级标记） */
  tokenPlain?: boolean
  user: RtUser
  lastSyncAt: { memory?: number; models?: number }
  memoryDirty?: boolean
  modelsDirty?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 状态文件路径（惰性获取：app ready 后才可调用 getPath） */
function stateFilePath(): string {
  return path.join(app.getPath('userData'), 'rt-account.json')
}

/** 共享 KV 文件路径（与 main.ts 的 kvGet/kvSet 读写同一份文件） */
function kvFilePath(): string {
  return path.join(app.getPath('userData'), 'clerkbox-kv.json')
}

/** 凭据存储文件路径（与 main.ts 的 saveApiKey 读写同一份文件） */
function credentialFilePath(): string {
  return path.join(app.getPath('userData'), 'clerkbox-credentials.json')
}

/** 全局记忆目录 */
function memoryDir(): string {
  return path.join(os.homedir(), '.clerkbox', 'memory')
}

/** 原子写文件：tmp + rename（与 main.ts writeCredentialStore 同模式） */
function writeJsonAtomic(filePath: string, text: string): void {
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(temporary, text, 'utf-8')
  try {
    fs.renameSync(temporary, filePath)
  } catch (error) {
    try {
      fs.copyFileSync(temporary, filePath)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
    if (!fs.existsSync(filePath)) throw error
  }
}

/** 把 API 返回的原始用户对象规范化为 RtUser */
function normalizeUser(raw: Record<string, unknown>): RtUser {
  return {
    id: typeof raw.id === 'number' ? raw.id : Number(raw.id) || 0,
    uuid: typeof raw.uuid === 'string' ? raw.uuid : undefined,
    username: typeof raw.username === 'string' ? raw.username : '',
    email: typeof raw.email === 'string' ? raw.email : undefined,
    emailVerified: raw.email_verified === true,
    isBetaUser: raw.is_beta_user === true,
  }
}

/** 读取状态文件；不存在或损坏时返回 null（视为未登录） */
function readState(): RtAccountState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFilePath(), 'utf-8'))
    if (!isRecord(parsed)) return null
    if (typeof parsed.tokenEnc !== 'string' || !parsed.tokenEnc) return null
    if (!isRecord(parsed.user)) return null
    const lastSyncRaw = isRecord(parsed.lastSyncAt) ? parsed.lastSyncAt : {}
    const lastSyncAt: { memory?: number; models?: number } = {}
    if (typeof lastSyncRaw.memory === 'number') lastSyncAt.memory = lastSyncRaw.memory
    if (typeof lastSyncRaw.models === 'number') lastSyncAt.models = lastSyncRaw.models
    return {
      tokenEnc: parsed.tokenEnc,
      tokenPlain: parsed.tokenPlain === true,
      user: normalizeUser(parsed.user),
      lastSyncAt,
      memoryDirty: parsed.memoryDirty === true,
      modelsDirty: parsed.modelsDirty === true,
    }
  } catch {
    return null
  }
}

/** 写入状态文件（原子写） */
function writeState(state: RtAccountState): void {
  writeJsonAtomic(stateFilePath(), JSON.stringify(state))
}

/** 清空状态文件（登出 / Token 失效清理） */
function clearState(): void {
  try {
    fs.rmSync(stateFilePath(), { force: true })
  } catch {
    // 删除失败不阻塞登出流程
  }
}

/** 加密用户 Token；safeStorage 不可用时降级为明文并打标记 */
function encryptToken(token: string): { tokenEnc: string; tokenPlain?: boolean } {
  if (safeStorage.isEncryptionAvailable()) {
    return { tokenEnc: safeStorage.encryptString(token).toString('base64') }
  }
  return { tokenEnc: token, tokenPlain: true }
}

/** 解密用户 Token；失败返回空字符串（视为凭据损坏） */
function decryptToken(state: RtAccountState): string {
  if (state.tokenPlain) return state.tokenEnc
  try {
    return safeStorage.decryptString(Buffer.from(state.tokenEnc, 'base64'))
  } catch {
    return ''
  }
}

// ── 热土 API 请求封装 ──

interface RtApiResponse {
  success?: boolean
  data?: unknown
  error?: string
  message?: string
}

/** HTTP 层错误（携带状态码，便于区分"段不存在"与网络故障） */
class RtHttpError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'RtHttpError'
    this.statusCode = statusCode
  }
}

/**
 * 发起热土 API 请求；非 2xx 抛 RtHttpError，网络/解析错误抛普通 Error。
 * 正常时返回解析后的 JSON 响应体（不校验 success 字段，由调用方决定语义）。
 */
function rtRequest(method: 'GET' | 'POST' | 'PUT', apiPath: string, body?: unknown): Promise<RtApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const request = https.request(
      {
        hostname: RT_API_HOST,
        path: apiPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload, 'utf-8'),
            }
          : undefined,
        timeout: RT_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0
        const chunks: Buffer[] = []
        let receivedBytes = 0
        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length
          if (receivedBytes > RT_RESPONSE_LIMIT_BYTES) {
            response.destroy(new Error(`热土 API 响应超过 ${RT_RESPONSE_LIMIT_BYTES} 字节上限`))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          let parsed: RtApiResponse
          try {
            parsed = text ? (JSON.parse(text) as RtApiResponse) : {}
          } catch {
            parsed = {}
          }
          if (statusCode < 200 || statusCode >= 300) {
            reject(new RtHttpError(parsed.error || parsed.message || `热土 API 请求失败（HTTP ${statusCode}）`, statusCode))
            return
          }
          resolve(parsed)
        })
        response.on('error', reject)
      }
    )
    request.on('timeout', () => request.destroy(new Error('热土 API 请求超时')))
    request.on('error', reject)
    if (payload) request.write(payload, 'utf-8')
    request.end()
  })
}

/** 从响应体中提取可读错误信息 */
function apiErrorMessage(res: RtApiResponse, fallback: string): string {
  return res.error || res.message || fallback
}

/** GET /login-token：用软件 Token 换取一次性 login_key */
async function getLoginKey(): Promise<string> {
  const res = await rtRequest('GET', `/login-token?token=${encodeURIComponent(RT_SOFTWARE_TOKEN)}`)
  const data = res.data as Record<string, unknown> | undefined
  if (!res.success || !isRecord(data) || typeof data.login_key !== 'string' || !data.login_key) {
    throw new Error(apiErrorMessage(res, '获取登录 Key 失败'))
  }
  return data.login_key
}

/** POST /get-user-by-token：用用户 Token 换取用户信息 */
async function fetchUserByToken(token: string): Promise<RtUser> {
  const res = await rtRequest('POST', '/get-user-by-token', { token })
  if (!res.success || !isRecord(res.data)) {
    throw new Error(apiErrorMessage(res, '获取用户信息失败'))
  }
  return normalizeUser(res.data)
}

// ── 数据段 API 封装 ──

/** 读取数据段；段不存在（404 或 success:false）返回 null，其他错误向上抛 */
async function readSegment(token: string, email: string, name: string): Promise<{ content: string; updatedAt?: number } | null> {
  let res: RtApiResponse
  try {
    res = await rtRequest('POST', '/data-segments/read', { email, token, name })
  } catch (error) {
    // 404 视为段不存在；其余（网络故障等）向上抛出真实错误
    if (error instanceof RtHttpError && error.statusCode === 404) return null
    throw error
  }
  if (!res.success || !isRecord(res.data) || typeof res.data.content !== 'string') return null
  const updatedAt = typeof res.data.updated_at === 'number' ? res.data.updated_at : undefined
  return { content: res.data.content, updatedAt }
}

/** 创建数据段（段不存在时） */
async function createSegment(token: string, email: string, name: string, content: string): Promise<void> {
  const res = await rtRequest('POST', '/data-segments', { email, token, name, content })
  if (!res.success) throw new Error(apiErrorMessage(res, '创建数据段失败'))
}

/** 更新数据段（段已存在时，全量覆盖） */
async function updateSegment(token: string, email: string, name: string, content: string): Promise<void> {
  const res = await rtRequest('PUT', '/data-segments', { email, token, name, content })
  if (!res.success) throw new Error(apiErrorMessage(res, '更新数据段失败'))
}

/** 上传数据段：先读，段不存在则创建，存在则更新 */
async function uploadSegment(token: string, email: string, name: string, content: string): Promise<void> {
  let exists = false
  try {
    exists = (await readSegment(token, email, name)) !== null
  } catch {
    // 读取失败按"不存在"处理，后续创建/更新会暴露真实错误
    exists = false
  }
  if (exists) {
    await updateSegment(token, email, name, content)
    return
  }
  try {
    await createSegment(token, email, name, content)
  } catch {
    // 创建失败可能因为段实际已存在（读取误判），兜底再试一次更新
    await updateSegment(token, email, name, content)
  }
}

// ── 凭据存储（与 main.ts 的 saveApiKey/loadApiKeys 等价实现，避免循环依赖）──

function readCredentialStore(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(credentialFilePath(), 'utf-8'))
    if (!isRecord(parsed)) return {}
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => /^[A-Za-z0-9._-]{1,128}$/.test(entry[0]) && typeof entry[1] === 'string'
    )
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

function writeCredentialStore(store: Record<string, string>): void {
  writeJsonAtomic(credentialFilePath(), JSON.stringify(store))
}

/** 解密全部凭据；safeStorage 不可用或单条解密失败时跳过对应条目 */
function decryptCredentialStore(store: Record<string, string>): Record<string, string> {
  const decrypted: Record<string, string> = {}
  if (!safeStorage.isEncryptionAvailable()) return decrypted
  for (const [id, encrypted] of Object.entries(store)) {
    try {
      decrypted[id] = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      // 其他系统账户加密的数据不可恢复，跳过
    }
  }
  return decrypted
}

/** 读取共享 KV 中指定键的字符串值（zustand persist 的原始 JSON） */
function readKvValue(key: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(kvFilePath(), 'utf-8'))
    if (isRecord(parsed) && typeof parsed[key] === 'string') return parsed[key]
  } catch {
    // KV 文件不存在或损坏时视为无数据
  }
  return null
}

/**
 * 读取渲染进程账号设置中的"自动同步记忆"开关：
 * KV 值为 zustand persist JSON 字符串，结构 { state: { autoSync, syncMemory, ... }, version }。
 * 任何读取/解析失败一律返回 false（保守策略：不自动上传）。
 */
function isMemoryAutoSyncEnabled(): boolean {
  const raw = readKvValue(ACCOUNT_KV_KEY)
  if (raw == null) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    const state = isRecord(parsed) && isRecord(parsed.state) ? parsed.state : null
    return state !== null && state.autoSync === true && state.syncMemory === true
  } catch {
    return false
  }
}

// ── 同步 payload 组装 / 应用 ──

/** 全局记忆快照 payload */
interface MemoryPayload {
  version: 1
  updatedAt: number
  files: Array<{ filename: string; content: string }>
}

/** 模型配置快照 payload */
interface ModelsPayload {
  version: 1
  updatedAt: number
  providers: ModelProvider[]
  activeProviderId?: string
  activeModelId?: string
}

/** 扫描全局记忆目录全部可同步文件（含 MEMORY.md 索引），打包为快照 JSON */
function packMemoryPayload(): MemoryPayload {
  const files: MemoryPayload['files'] = []
  const dir = memoryDir()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    // 只打包符合统一口径的文件（安全文件名 + .md）；其余文件同步完全不碰
    if (!entry.isFile() || !isSyncableMemoryFile(entry.name)) continue
    try {
      const fullPath = path.join(dir, entry.name)
      // 单文件超过段上限时跳过（读取前先 stat 判断），避免整包必然超限
      if (fs.statSync(fullPath).size > MAX_SEGMENT_BYTES) continue
      files.push({ filename: entry.name, content: fs.readFileSync(fullPath, 'utf-8') })
    } catch {
      // 单个文件读取失败跳过，不影响其余文件
    }
  }
  return { version: 1, updatedAt: Date.now(), files }
}

/**
 * 组装模型配置快照：
 * 从共享 KV clerkbox-settings 读 providers 骨架（partialize 已剥空 apiKey），
 * 再从凭据存储解密取回各 provider 的 apiKey 合并；同时携带激活项。
 */
function buildModelsPayload(): ModelsPayload {
  const raw = readKvValue(SETTINGS_KV_KEY)
  if (raw == null) return { version: 1, updatedAt: Date.now(), providers: [] }
  let persisted: unknown
  try {
    persisted = JSON.parse(raw)
  } catch {
    throw new Error('本地模型配置数据解析失败')
  }
  const stateObj = isRecord(persisted) && isRecord(persisted.state) ? persisted.state : null
  const providersRaw = stateObj?.providers
  if (!Array.isArray(providersRaw)) throw new Error('本地模型配置数据无效')
  const credentials = decryptCredentialStore(readCredentialStore())
  const providers = providersRaw.filter(isRecord).map((provider) => {
    const id = typeof provider.id === 'string' ? provider.id : ''
    // 优先取 safeStorage 解密结果；兜底 KV 内残留明文（浏览器直连模式的存量数据）
    const apiKey = credentials[id] || (typeof provider.apiKey === 'string' ? provider.apiKey : '')
    return { ...provider, apiKey } as unknown as ModelProvider
  })
  return {
    version: 1,
    updatedAt: Date.now(),
    providers,
    activeProviderId: typeof stateObj?.activeProviderId === 'string' ? stateObj.activeProviderId : undefined,
    activeModelId: typeof stateObj?.activeModelId === 'string' ? stateObj.activeModelId : undefined,
  }
}

/** 校验云端文件名，防路径穿越（只允许安全文件名字符集） */
function isSafeSegmentFilename(filename: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) && !filename.includes('..')
}

/**
 * 可同步记忆文件的统一口径：安全文件名 且 以 .md 结尾。
 * 上传打包与下载镜像删除共用此判定，保证两侧对称：
 * 会被打包上传的文件才会被镜像管理，其余本地文件同步完全不碰。
 */
function isSyncableMemoryFile(name: string): boolean {
  return isSafeSegmentFilename(name) && name.endsWith('.md')
}

/** 全量镜像写回全局记忆目录：删除云端没有的本地可同步文件，再写入云端全部文件 */
function applyMemoryPayload(files: Array<{ filename: string; content: string }>): void {
  const dir = memoryDir()
  fs.mkdirSync(dir, { recursive: true })
  // 云端文件名集合：仅接受类型与格式都合法的条目（防路径穿越 / 防脏数据）
  const validFiles = files.filter(
    (file) => typeof file?.filename === 'string' && typeof file?.content === 'string' && isSafeSegmentFilename(file.filename)
  )
  const cloudNames = new Set(validFiles.map((file) => file.filename))
  // 删除云端没有的本地可同步文件：仅删 安全文件名 + .md 且 ≤1MB 的文件
  // （与上传打包口径对称；非安全名 / 非 .md / 超大文件一律不删、不动）
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isFile() || !isSyncableMemoryFile(entry.name)) continue
    if (cloudNames.has(entry.name)) continue
    try {
      // 超大文件上传时也不会打包，不纳入镜像管理，避免误删
      if (fs.statSync(path.join(dir, entry.name)).size > MAX_SEGMENT_BYTES) continue
      fs.rmSync(path.join(dir, entry.name), { force: true })
    } catch {
      // 删除失败不阻塞后续写入
    }
  }
  // 写入云端全部文件（含 MEMORY.md 索引）
  for (const file of validFiles) {
    fs.writeFileSync(path.join(dir, file.filename), file.content, 'utf-8')
  }
}

/** 解析云端模型配置 payload 为 DownloadedModelConfig（providers 含 apiKey） */
function parseModelsPayload(payload: Record<string, unknown>): DownloadedModelConfig {
  const providersRaw = payload.providers
  if (!Array.isArray(providersRaw)) throw new Error('云端模型配置格式无效')
  const providers = providersRaw.filter(isRecord).map((provider) => ({ ...provider }) as unknown as ModelProvider)
  return {
    providers,
    activeProviderId: typeof payload.activeProviderId === 'string' ? payload.activeProviderId : undefined,
    activeModelId: typeof payload.activeModelId === 'string' ? payload.activeModelId : undefined,
  }
}

/** 把下载到的各 provider apiKey 写入加密凭据存储（等价于逐个 saveApiKey） */
function applyModelCredentials(config: DownloadedModelConfig): void {
  if (!safeStorage.isEncryptionAvailable()) return // 降级：系统加密不可用时跳过凭据写入
  const store = readCredentialStore()
  let changed = false
  for (const provider of config.providers) {
    const id = typeof provider?.id === 'string' ? provider.id : ''
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) continue
    const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey : ''
    if (apiKey) {
      store[id] = safeStorage.encryptString(apiKey).toString('base64')
      changed = true
    } else if (id in store) {
      // 空 key 等价于删除该凭据（与 saveApiKey(id, '') 语义一致）
      delete store[id]
      changed = true
    }
  }
  if (changed) writeCredentialStore(store)
}

/** 云端时间戳归一化为毫秒（兼容秒级时间戳），无效返回 0 */
function normalizeCloudTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value < 1e12 ? value * 1000 : value
}

// ── 同步操作串行化（避免并发上传/下载互相覆盖状态文件）──

let syncChain: Promise<unknown> = Promise.resolve()

function enqueueSync<T>(op: () => Promise<T>): Promise<T> {
  const next = syncChain.then(op, op)
  syncChain = next.catch(() => {})
  return next
}

// ── 对外 API ──

/** 是否已有登录中的回调流程（防并发登录） */
let loginInFlight = false

/**
 * 热土账号登录（loginkey 流程）：
 * 换 login_key → 起本地回调服务器 → 打开授权页 → 等待回调（5 分钟超时）
 * → 拿用户 Token → 换用户信息 → 持久化。
 */
export async function rtLogin(): Promise<{ ok: true; status: AccountStatus } | { error: string }> {
  if (readState()) return { error: '已登录，请先退出当前账号' }
  if (loginInFlight) return { error: '登录进行中，请稍候' }
  loginInFlight = true

  const server = http.createServer()
  let timer: NodeJS.Timeout | null = null

  try {
    // 1. 用软件 Token 换取一次性 login_key
    const loginKey = await getLoginKey()
    // 2. 生成随机 state，防回调伪造
    const state = crypto.randomBytes(16).toString('hex')

    // 等待授权回调的 Promise
    const callbackPromise = new Promise<{ token?: string; error?: string }>((resolve, reject) => {
      server.on('error', reject)
      server.on('request', (req, res) => {
        let query: URLSearchParams
        try {
          query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        } catch {
          res.destroy()
          return
        }
        const type = query.get('type')
        const value = query.get('v') ?? ''
        const callbackState = query.get('state') ?? ''
        if (!type || !value) {
          // 非授权回调请求（如 favicon 预取）：直接关闭连接
          res.statusCode = 404
          res.end()
          return
        }
        // 收到回调：先应答浏览器、立即关服务器，再交付结果
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          type === 'success'
            ? '<html><body><p>授权成功，请返回 ClerkBox 应用。</p></body></html>'
            : '<html><body><p>授权失败，请返回 ClerkBox 应用重试。</p></body></html>'
        )
        try {
          server.close()
          server.closeAllConnections()
        } catch {
          // 服务器可能已关闭
        }
        if (type === 'success' && callbackState === state && value) {
          resolve({ token: value })
        } else if (type === 'error') {
          resolve({ error: value || '授权失败' })
        } else {
          resolve({ error: '回调参数校验失败' })
        }
      })
    })
    // 超时后回调 Promise 可能再 reject（服务器错误等），提前挂 catch 防 unhandledRejection
    callbackPromise.catch(() => {})

    // 3. 启动回调服务器：仅绑定 127.0.0.1 随机端口
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('本地回调服务器启动失败'))
      })
    })

    // 4. 打开系统默认浏览器授权页
    const authUrl = `${RT_LOGIN_PAGE}?port=${port}&type=loginkey&v=${encodeURIComponent(loginKey)}&state=${state}&env=app`
    await shell.openExternal(authUrl)

    // 5. 等待回调或 5 分钟超时
    const timeoutPromise = new Promise<{ token?: string; error?: string }>((resolve) => {
      timer = setTimeout(() => resolve({ error: '登录超时（5 分钟未完成授权），请重试' }), LOGIN_TIMEOUT_MS)
    })
    const result = await Promise.race([callbackPromise, timeoutPromise])

    if (result.error || !result.token) return { error: result.error || '授权失败' }

    // 6. 用用户 Token 换取用户信息（隐含校验 Token 有效性）
    const user = await fetchUserByToken(result.token)

    // 7. 持久化登录态
    const encrypted = encryptToken(result.token)
    const newState: RtAccountState = {
      tokenEnc: encrypted.tokenEnc,
      ...(encrypted.tokenPlain ? { tokenPlain: true } : {}),
      user,
      lastSyncAt: {},
    }
    writeState(newState)
    return { ok: true, status: statusFromState(newState) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer) clearTimeout(timer)
    try {
      server.close()
      server.closeAllConnections()
    } catch {
      // 服务器可能已关闭
    }
    loginInFlight = false
  }
}

/** 退出登录：清空本地状态文件（云端数据保留） */
export function rtLogout(): void {
  clearState()
  // 取消挂起的自动上传（登出后无同步目标）
  if (autoUploadTimer) {
    clearTimeout(autoUploadTimer)
    autoUploadTimer = null
  }
}

/** 当前账号状态（同步返回，读状态文件） */
export function rtGetStatus(): AccountStatus {
  const state = readState()
  if (!state) return { loggedIn: false, lastSyncAt: {} }
  return statusFromState(state)
}

function statusFromState(state: RtAccountState): AccountStatus {
  return { loggedIn: true, user: state.user, lastSyncAt: state.lastSyncAt }
}

/**
 * 启动时校验已保存的用户 Token（verify-access-token）：
 * 失效则清空登录态；网络异常时保留登录态（避免误登出）。
 */
export async function rtVerifyStartupToken(): Promise<void> {
  const state = readState()
  if (!state) return
  const token = decryptToken(state)
  if (!token) {
    clearState()
    return
  }
  try {
    const res = await rtRequest('POST', '/verify-access-token', { token })
    if (res.success === false) clearState()
  } catch {
    // 网络异常时无法判断有效性，保留登录态
  }
}

/**
 * 上传同步：逐 kind 打包本地数据 → 写入热土数据段（先读后建/改）。
 * 成功后更新 lastSyncAt 并清除对应 dirty 标记。
 */
export async function rtSyncUpload(kinds: AccountSyncKind[]): Promise<{ results: AccountSyncResultItem[] }> {
  return enqueueSync(async () => {
    const uniqueKinds = [...new Set(kinds)]
    const state = readState()
    if (!state) {
      return { results: uniqueKinds.map((kind) => ({ kind, ok: false, error: '未登录' })) }
    }
    const token = decryptToken(state)
    if (!token) {
      return { results: uniqueKinds.map((kind) => ({ kind, ok: false, error: '本地登录凭据已损坏，请重新登录' })) }
    }
    const email = state.user.email ?? ''

    const results: AccountSyncResultItem[] = []
    const now = Date.now()
    let changed = false
    for (const kind of uniqueKinds) {
      try {
        let payloadJson: string
        if (kind === 'memory') {
          payloadJson = JSON.stringify(packMemoryPayload())
          if (Buffer.byteLength(payloadJson, 'utf-8') > MAX_SEGMENT_BYTES) {
            throw new Error('内容过大：全局记忆超过 1MB 上限')
          }
          await uploadSegment(token, email, SEGMENT_MEMORY, payloadJson)
        } else {
          payloadJson = JSON.stringify(buildModelsPayload())
          if (Buffer.byteLength(payloadJson, 'utf-8') > MAX_SEGMENT_BYTES) {
            throw new Error('内容过大：模型配置超过 1MB 上限')
          }
          await uploadSegment(token, email, SEGMENT_MODELS, payloadJson)
        }
        state.lastSyncAt[kind] = now
        if (kind === 'memory') state.memoryDirty = false
        else state.modelsDirty = false
        changed = true
        results.push({ kind, ok: true })
      } catch (error) {
        results.push({ kind, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (changed) {
      try {
        writeState(state)
      } catch (error) {
        console.error('[rt-account] 持久化同步状态失败:', error)
      }
    }
    return { results }
  })
}

/**
 * 下载同步：逐 kind 读热土数据段并应用。
 * - memory：全量镜像写回全局记忆目录
 * - models：配置放进返回值 models 字段交渲染进程应用；主进程同时把 apiKey 写入凭据存储
 * - force=false（自动场景）仅当云端较新且本地无 dirty 时下载，否则标 skipped
 * 成功后更新 lastSyncAt 并清除对应 dirty 标记。
 */
export async function rtSyncDownload(
  kinds: AccountSyncKind[],
  force: boolean
): Promise<AccountSyncDownloadResult> {
  return enqueueSync(async () => {
    const uniqueKinds = [...new Set(kinds)]
    const state = readState()
    if (!state) {
      return { results: uniqueKinds.map((kind) => ({ kind, ok: false, error: '未登录' })) }
    }
    const token = decryptToken(state)
    if (!token) {
      return { results: uniqueKinds.map((kind) => ({ kind, ok: false, error: '本地登录凭据已损坏，请重新登录' })) }
    }
    const email = state.user.email ?? ''

    const results: AccountSyncResultItem[] = []
    let models: DownloadedModelConfig | undefined
    const now = Date.now()
    let changed = false
    for (const kind of uniqueKinds) {
      try {
        const segment = await readSegment(token, email, kind === 'memory' ? SEGMENT_MEMORY : SEGMENT_MODELS)
        if (!segment) throw new Error('云端暂无数据')
        let payload: unknown
        try {
          payload = JSON.parse(segment.content)
        } catch {
          throw new Error('云端数据解析失败')
        }
        if (!isRecord(payload)) throw new Error('云端数据格式无效')

        // 云端更新时间：优先用快照内 updatedAt（本应用写入，毫秒），兜底段 updated_at
        const cloudUpdatedAt =
          typeof payload.updatedAt === 'number' && payload.updatedAt > 0
            ? payload.updatedAt
            : normalizeCloudTimestamp(segment.updatedAt)

        // 自动场景（force=false）：云端不比本地新、或本地有未上传改动时跳过
        if (!force) {
          const last = state.lastSyncAt[kind] ?? 0
          const dirty = kind === 'memory' ? !!state.memoryDirty : !!state.modelsDirty
          if (dirty || cloudUpdatedAt <= last) {
            results.push({ kind, ok: true, skipped: true })
            continue
          }
        }

        if (kind === 'memory') {
          if (!Array.isArray(payload.files)) throw new Error('云端数据格式无效')
          applyMemoryPayload(payload.files as Array<{ filename: string; content: string }>)
        } else {
          if (!Array.isArray(payload.providers)) throw new Error('云端数据格式无效')
          const config = parseModelsPayload(payload)
          // 主进程侧恢复各 provider 的加密凭据
          applyModelCredentials(config)
          models = config
        }

        state.lastSyncAt[kind] = now
        if (kind === 'memory') state.memoryDirty = false
        else state.modelsDirty = false
        changed = true
        results.push({ kind, ok: true })
      } catch (error) {
        results.push({ kind, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (changed) {
      try {
        writeState(state)
      } catch (error) {
        console.error('[rt-account] 持久化同步状态失败:', error)
      }
    }
    return models ? { results, models } : { results }
  })
}

// ── 全局记忆写入钩子 ──

/** 挂起的自动上传定时器 */
let autoUploadTimer: NodeJS.Timeout | null = null

/**
 * 全局记忆落盘后的通知钩子（由 main.ts 的 writeMemoryFile / updateMemoryIndex 调用）：
 * - 置 memoryDirty 并持久化（不受开关影响；未登录时无状态文件，跳过）
 * - 仅当 已登录 && autoSync && syncMemory 时才 debounce 5s 自动上传记忆段
 *   （自动同步默认关闭，符合 spec；失败静默，不打断记忆写入）
 */
export function rtNotifyMemoryWritten(): void {
  const state = readState()
  if (!state) return // 未登录：无同步目标，无需落脏标记
  state.memoryDirty = true
  try {
    writeState(state)
  } catch (error) {
    console.error('[rt-account] 持久化记忆脏标记失败:', error)
  }
  // 自动上传门控：从共享 KV 读渲染进程账号设置（读失败按关闭处理，脏标记已保留供手动同步）
  if (!isMemoryAutoSyncEnabled()) return
  if (autoUploadTimer) clearTimeout(autoUploadTimer)
  autoUploadTimer = setTimeout(() => {
    autoUploadTimer = null
    rtSyncUpload(['memory'])
      .then((result) => {
        for (const item of result.results) {
          if (!item.ok && item.error) console.error('[rt-account] 自动上传记忆失败:', item.error)
        }
      })
      .catch((error) => console.error('[rt-account] 自动上传记忆失败:', error))
  }, AUTO_UPLOAD_DEBOUNCE_MS)
}
