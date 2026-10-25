import { hostname } from 'node:os'
import { createHash, randomBytes, webcrypto } from 'node:crypto'
import type {
  JouleDesktop,
  JouleExpired,
  JouleLoginResult,
  JouleModel,
  JoulePlan,
  JoulePromo,
  JouleQuotas,
  JouleStateSnapshot,
  JouleSubscription,
  JouleUser,
} from '../src/types/joule'

/**
 * Joule 账号：设备码登录 + 账号快照刷新。
 *
 * 边界（与仪表盘同一套契约）：
 * - API Key 只写 safeStorage（credential id `joule`），只通过 jouleStartLogin 的返回值
 *   一次性交给渲染层创建 Provider；不写设置快照、不进 localStorage、不打印。
 * - device_code 只留在主进程内存；浏览器只拿到 user_code（非密钥）。
 * - 401/403 只标记 needs_reauth，不自动删 Key；退出登录只清本机，服务器 Key 保留复用。
 */

const JOULE_ORIGIN = 'https://joule.xmzf.space'
const DASHBOARD_ORIGIN = 'https://clerkbox.xmzf.space/dashboard'
const DESKTOP_CLIENT_ID = 'clerkbox-desktop'
const QUOTA_REFRESH_MS = 5 * 60_000
const MODEL_REFRESH_MS = 60 * 60_000
const MANUAL_THROTTLE_MS = 30_000
const REQUEST_TIMEOUT_MS = 10_000
const DASHBOARD_SECTIONS = new Set(['subscription', 'usage', 'records', 'limits', 'auth'])

interface JouleDeps {
  readKey: () => string | null
  writeKey: (key: string) => void
  clearKey: () => void
  readInstall: () => string | null
  writeInstall: (value: string) => void
  clearInstall: () => void
  notify: (snapshot: JouleStateSnapshot) => void
  openExternal: (url: string) => Promise<void>
}

/**
 * 安装凭据：Joule 折扣只认这把 ECDSA 私钥的签名，API Key 单独被复制拿不到折扣。
 * 私钥与 Key 一样只进 safeStorage，不进渲染层。
 */
interface InstallCredential {
  id: string
  privateKey: string
}

interface LoginSession {
  deviceCode: string
  intervalMs: number
  expiresAt: number
  install: InstallCredential | null
  cancelled: boolean
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
  resolve: (result: JouleLoginResult) => void
}

let deps: JouleDeps | null = null
let state: JouleStateSnapshot = emptyState()
let login: LoginSession | null = null
let quotaTimer: ReturnType<typeof setInterval> | null = null
let modelTimer: ReturnType<typeof setInterval> | null = null
let lastManualRefreshAt = 0
let initialized = false

function emptyState(): JouleStateSnapshot {
  return {
    status: 'unlinked',
    user: null,
    subscription: null,
    expired: null,
    plan: null,
    quotas: null,
    desktop: null,
    login: null,
    lastSyncAt: null,
    stale: false,
    error: null,
    serverNow: null,
  }
}

function snapshot(): JouleStateSnapshot {
  return { ...state, models: state.models ? state.models.slice() : undefined }
}

function emit(patch: Partial<JouleStateSnapshot>): void {
  state = { ...state, ...patch }
  try {
    deps?.notify(snapshot())
  } catch {
    // 窗口销毁/渲染层重载期间推送失败不影响账号状态机
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function apiMessage(data: unknown, fallback: string): string {
  const parsed = data as { error?: { message?: unknown } } | null
  const message = parsed?.error?.message
  return typeof message === 'string' && message ? message : fallback
}

/* ---------------- 安装凭据与请求签名 ---------------- */

const JOULE_HOSTS = new Set(['joule.xmzf.space', 'xmzfserver.xmzf.space'])
let cachedInstall: InstallCredential | null | undefined
let installKey: Awaited<ReturnType<typeof webcrypto.subtle.importKey>> | null = null

function parseInstall(raw: string | null): InstallCredential | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; privateKey?: unknown }
    if (typeof parsed.id === 'string' && /^[a-f0-9]{32}$/.test(parsed.id) &&
      typeof parsed.privateKey === 'string' && parsed.privateKey.length > 40) {
      return { id: parsed.id, privateKey: parsed.privateKey }
    }
  } catch {
    // 凭据损坏按未登记处理：下次登录会重新生成，不影响 Key 本身
  }
  return null
}

function currentInstall(): InstallCredential | null {
  if (cachedInstall === undefined) cachedInstall = parseInstall(deps?.readInstall() ?? null)
  return cachedInstall
}

function resetInstallCache(): void {
  cachedInstall = undefined
  installKey = null
}

async function createInstall(): Promise<{ credential: InstallCredential; pubkey: string }> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  )
  const spki = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey))
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey))
  return {
    credential: {
      id: randomBytes(16).toString('hex'),
      privateKey: Buffer.from(pkcs8).toString('base64'),
    },
    pubkey: Buffer.from(spki).toString('base64'),
  }
}

/**
 * 给发往 Joule 的模型请求签名。服务端验签通过才按 9 折计费；
 * 任何失败都返回空头，请求照常发出（只是原价），绝不阻断调用。
 * 私钥不出主进程，渲染层与 WebUI 都拿不到。
 */
export async function jouleSignatureHeaders(
  method: string,
  url: string,
  body: string,
): Promise<Record<string, string>> {
  const install = currentInstall()
  if (!install) return {}
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {}
  }
  if (!JOULE_HOSTS.has(parsed.host)) return {}
  try {
    if (!installKey) {
      installKey = await webcrypto.subtle.importKey(
        'pkcs8',
        Buffer.from(install.privateKey, 'base64'),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
      )
    }
    const ts = Date.now()
    const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex')
    const message = `${ts}\n${method.toUpperCase()}\n${parsed.pathname}\n${bodyHash}`
    const sig = await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      installKey,
      new TextEncoder().encode(message),
    )
    return {
      'x-cb-install': install.id,
      'x-cb-ts': String(ts),
      'x-cb-sig': Buffer.from(new Uint8Array(sig)).toString('base64'),
    }
  } catch {
    return {}
  }
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; ok: boolean; data: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    return { status: res.status, ok: res.ok, data }
  } finally {
    clearTimeout(timer)
  }
}

function mapAccount(data: Record<string, unknown>): Partial<JouleStateSnapshot> {
  const plan = (data.plan as JoulePlan | null | undefined) ?? null
  const expired = (data.expired as JouleExpired | null | undefined) ?? null
  return {
    status: expired && !plan ? 'expired' : 'connected',
    user: (data.user as JouleUser | null | undefined) ?? null,
    subscription: (data.subscription as JouleSubscription | null | undefined) ?? null,
    expired,
    plan,
    quotas: (data.quotas as JouleQuotas | null | undefined) ?? null,
    desktop: (data.desktop as JouleDesktop | null | undefined) ?? null,
    promo: (data.promo as JoulePromo | null | undefined) ?? null,
    serverNow: Number(data.serverNow) || Date.now(),
  }
}

function startTimers(): void {
  if (!quotaTimer) {
    quotaTimer = setInterval(() => {
      void refresh({ models: false }).catch(() => {})
    }, QUOTA_REFRESH_MS)
    quotaTimer.unref?.()
  }
  if (!modelTimer) {
    modelTimer = setInterval(() => {
      void refresh({ models: true }).catch(() => {})
    }, MODEL_REFRESH_MS)
    modelTimer.unref?.()
  }
}

function stopTimers(): void {
  if (quotaTimer) {
    clearInterval(quotaTimer)
    quotaTimer = null
  }
  if (modelTimer) {
    clearInterval(modelTimer)
    modelTimer = null
  }
}

/** 拉取账号快照；models=true 时同时刷新模型目录。网络错误保留旧快照并标 stale。 */
export async function refresh(options: { models?: boolean; manual?: boolean } = {}): Promise<JouleStateSnapshot> {
  if (!deps) return snapshot()
  const withModels = options.models !== false
  if (options.manual) {
    const now = Date.now()
    if (now - lastManualRefreshAt < MANUAL_THROTTLE_MS) return snapshot()
    lastManualRefreshAt = now
  }
  const key = deps.readKey()
  if (!key) {
    // 登录进行中（Key 尚未交付）时不要清空快照，否则账号卡上的设备码会被抹掉
    if (login) return snapshot()
    stopTimers()
    emit(emptyState())
    return snapshot()
  }

  try {
    const res = await fetchJson(`${JOULE_ORIGIN}/v1/account?models=${withModels ? 1 : 0}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    })
    if (res.status === 401 || res.status === 403) {
      // 授权失效：停止轮询定时器，等用户重新登录后再启动（手动刷新仍可用）
      stopTimers()
      emit({ status: 'needs_reauth', stale: false, error: null, login: state.login })
      return snapshot()
    }
    if (!res.ok || !res.data || typeof res.data !== 'object') {
      emit({ stale: true, error: apiMessage(res.data, `Joule 账号接口返回 ${res.status}`) })
      return snapshot()
    }
    const data = res.data as Record<string, unknown>
    const remoteModels = withModels && Array.isArray(data.models) ? (data.models as JouleModel[]) : undefined
    emit({
      ...mapAccount(data),
      ...(remoteModels ? { models: remoteModels } : {}),
      stale: false,
      error: null,
      login: state.login,
      lastSyncAt: Date.now(),
    })
    startTimers()
  } catch (error) {
    emit({ stale: true, error: errorMessage(error) })
  }
  return snapshot()
}

function settle(session: LoginSession, result: JouleLoginResult): void {
  if (session.settled) return
  session.settled = true
  if (session.timer) {
    clearTimeout(session.timer)
    session.timer = null
  }
  if (login === session) login = null
  emit({ login: null })
  session.resolve(result)
}

function schedulePoll(session: LoginSession, delayMs: number): void {
  if (session.cancelled || session.settled) return
  session.timer = setTimeout(() => {
    session.timer = null
    void pollOnce(session).catch(() => schedulePoll(session, session.intervalMs))
  }, delayMs)
  session.timer.unref?.()
}

async function pollOnce(session: LoginSession): Promise<void> {
  if (session.cancelled || session.settled) return
  if (Date.now() > session.expiresAt) {
    settle(session, { error: '授权已超时，请重新发起登录' })
    return
  }

  let res: { status: number; ok: boolean; data: unknown }
  try {
    res = await fetchJson(`${JOULE_ORIGIN}/api/integration/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: session.deviceCode }),
    })
  } catch {
    schedulePoll(session, session.intervalMs)
    return
  }

  if (res.status === 202) {
    schedulePoll(session, session.intervalMs)
    return
  }
  if (res.status === 429) {
    session.intervalMs += 5000
    schedulePoll(session, session.intervalMs)
    return
  }

  const data = res.data as { api_key?: unknown; error?: { code?: string; message?: string } } | null
  if (res.status === 200 && typeof data?.api_key === 'string' && data.api_key) {
    const key = data.api_key
    try {
      deps?.writeKey(key)
    } catch (error) {
      settle(session, { error: `无法保存登录凭据：${errorMessage(error)}` })
      return
    }
    // 安装私钥与 Key 分开放：折扣凭据写失败不影响正常使用，只是按原价计费
    if (session.install) {
      try {
        deps?.writeInstall(JSON.stringify(session.install))
        resetInstallCache()
      } catch {
        // 忽略：下次登录会重新生成
      }
    }
    // Key 已落 safeStorage：即使账号快照失败也要让渲染层拿到 Key 完成 Provider 创建。
    const account = await refresh({ models: true })
    startTimers()
    settle(session, { ok: true, key, account, models: account.models ?? [] })
    return
  }

  if (res.status === 410) {
    settle(session, { error: '授权码已过期，请重新发起登录' })
    return
  }
  settle(session, { error: apiMessage(res.data, data?.error?.message || '授权失败，请稍后重试') })
}

/** 发起设备码登录：返回 Promise 在浏览器确认/取消/超时后结算。 */
export async function startLogin(): Promise<JouleLoginResult> {
  if (!deps) return { error: '主进程尚未就绪' }
  if (login) return { error: '登录已在进行中' }

  // 每次登录生成新的安装密钥对：公钥随设备码登记，私钥在授权成功后落 safeStorage。
  // 生成失败不阻断登录，只是拿不到客户端折扣。
  let install: { credential: InstallCredential; pubkey: string } | null = null
  try {
    install = await createInstall()
  } catch {
    install = null
  }

  let res: { status: number; ok: boolean; data: unknown }
  try {
    res = await fetchJson(`${JOULE_ORIGIN}/api/integration/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: DESKTOP_CLIENT_ID,
        device_name: hostname().slice(0, 64) || 'ClerkBox',
        ...(install ? { install_id: install.credential.id, install_pubkey: install.pubkey } : {}),
      }),
    })
  } catch (error) {
    return { error: `无法连接 Joule：${errorMessage(error)}` }
  }

  const data = res.data as {
    device_code?: unknown
    user_code?: unknown
    verification_uri_complete?: unknown
    expires_in?: unknown
    interval?: unknown
    error?: { message?: string }
  } | null
  if (!res.ok || typeof data?.device_code !== 'string' || typeof data?.user_code !== 'string' ||
    typeof data?.verification_uri_complete !== 'string') {
    return { error: apiMessage(res.data, '无法发起 Joule 登录') }
  }
  const verificationUrl = data.verification_uri_complete
  // 只允许仪表盘的设备授权页，避免被伪造响应带去打开任意外部地址
  if (!verificationUrl.startsWith('https://clerkbox.xmzf.space/dashboard/device')) {
    return { error: 'Joule 返回的授权地址无效' }
  }

  const session: LoginSession = {
    deviceCode: data.device_code,
    intervalMs: Math.max(5, Number(data.interval) || 5) * 1000,
    expiresAt: Date.now() + (Number(data.expires_in) || 600) * 1000,
    install: install?.credential ?? null,
    cancelled: false,
    settled: false,
    timer: null,
    resolve: () => {},
  }
  const result = new Promise<JouleLoginResult>((resolve) => {
    session.resolve = resolve
  })
  login = session
  emit({
    login: {
      userCode: data.user_code,
      expiresAt: session.expiresAt,
      verificationUri: verificationUrl,
    },
    error: null,
  })
  void deps.openExternal(verificationUrl).catch(() => {
    // 打不开浏览器时用户仍可从账号卡复制授权链接
  })
  schedulePoll(session, 0)
  return result
}

export function cancelLogin(): void {
  const session = login
  if (!session) return
  session.cancelled = true
  settle(session, { cancelled: true })
}

export async function logout(): Promise<void> {
  cancelLogin()
  try {
    deps?.clearKey()
  } catch {
    // 凭据已不可读时也继续清本地快照
  }
  try {
    deps?.clearInstall()
    resetInstallCache()
  } catch {
    // 安装私钥清除失败不影响退出；下次登录会覆盖
  }
  stopTimers()
  lastManualRefreshAt = 0
  emit(emptyState())
}

export async function openDashboard(section?: unknown): Promise<void> {
  const target = typeof section === 'string' && DASHBOARD_SECTIONS.has(section)
    ? `?section=${encodeURIComponent(section)}`
    : ''
  await deps?.openExternal(`${DASHBOARD_ORIGIN}/${target}`)
}

export function getState(): JouleStateSnapshot {
  return snapshot()
}

export function initJouleAccount(next: JouleDeps): void {
  deps = next
  if (initialized) return
  initialized = true

  if (next.readKey()) {
    // 有 Key 先按已连接展示（旧快照在渲染层），首次刷新失败会标 stale 而不是误显示未登录
    emit({ status: 'connected', stale: true })
    startTimers()
    void refresh({ models: true }).catch(() => {})
  }
}
