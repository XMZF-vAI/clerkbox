/** Explicit, capability-scoped public transport. Never forwards arbitrary IPC. */
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { ChatStore } from './db'
import type { AgentSessionManager } from './agent-host'
import { handlerRegistry } from './webui-server'
import type { RemotePrincipal } from '../src/remote/protocol'
import type { AgentCommand, AgentEvent } from '../src/agent-core/protocol'
import type { MessageAttachment } from '../src/types/agent'
import { normalizeHarnessMode } from '../src/lib/harness-modes'

const FILE_LIMIT = 10 * 1024 * 1024
const CHUNK_LIMIT = 128 * 1024
const PREVIEW_LIMIT = 256 * 1024
const UPLOAD_QUOTA = 50 * 1024 * 1024
const UPLOAD_TTL = 15 * 60_000
const ID = /^[A-Za-z0-9_-]{1,160}$/
type Row = Record<string, unknown>
type Handler = (...args: unknown[]) => unknown

export function assertRemoteActive(principal: RemotePrincipal): void {
  if (!principal.isActive()) throw new Error('remote-disconnected')
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

/** Missing children are checked against their nearest real ancestor, including symlinks. */
export async function resolveRemoteWorkspacePath(principal: RemotePrincipal, input: string, allowMissing = false): Promise<string> {
  assertRemoteActive(principal)
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f]/.test(input)) throw new Error('remote-invalid-path')
  const root = await fs.realpath(principal.workspace)
  const requested = path.resolve(root, input || '.')
  if (!inside(root, requested)) throw new Error('remote-outside-workspace')
  let existing = requested
  const missing: string[] = []
  let notFound: unknown
  for (;;) {
    let real: string
    try {
      real = await fs.realpath(existing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      notFound ??= error
      const parent = path.dirname(existing)
      if (parent === existing) throw new Error('remote-invalid-path')
      missing.push(path.basename(existing))
      existing = parent
      continue
    }
    if (!inside(root, real)) throw new Error('remote-outside-workspace')
    if (missing.length && !allowMissing) throw notFound
    assertRemoteActive(principal)
    return path.join(real, ...missing.reverse())
  }
}

function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('remote-invalid-arguments')
  return value as Row
}
function string(value: unknown, max = 160, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)) throw new Error('remote-invalid-arguments')
  return value
}
function identifier(value: unknown): string {
  const result = string(value)
  if (!ID.test(result)) throw new Error('remote-invalid-arguments')
  return result
}
function exactKeys(value: Row, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('remote-invalid-arguments')
}
function requireControl(principal: RemotePrincipal): void {
  assertRemoteActive(principal)
  if (!principal.control) throw new Error('remote-control-disabled')
}
function requireFiles(principal: RemotePrincipal): void {
  assertRemoteActive(principal)
  if (!principal.files) throw new Error('remote-files-disabled')
}

export interface RemoteHostDispatcherOptions {
  store: ChatStore
  manager: AgentSessionManager
  handlers?: Map<string, Handler>
}

interface Upload {
  principal: RemotePrincipal
  path: string
  name: string
  size: number
  received: number
  nextIndex: number
  expiresAt: number
  writing: boolean
}

export function createRemoteHostDispatcher({ store, manager, handlers = handlerRegistry }: RemoteHostDispatcherOptions) {
  const uploads = new Map<string, Upload>()
  let uploadStartQueue = Promise.resolve()
  const remoteApprovers = new Map<string, RemotePrincipal>()
  manager.setRemoteApprovalProbe(() => [...remoteApprovers.values()].some((p) => p.approve && p.isActive()))

  const notePrincipal = (principal: RemotePrincipal) => {
    assertRemoteActive(principal)
    remoteApprovers.set(principal.deviceId, principal)
  }

  async function sessionRows(principal: RemotePrincipal): Promise<Row[]> {
    assertRemoteActive(principal)
    const rows = await store.getAllSessions()
    const allowed: Row[] = []
    for (const row of rows) {
      const dir = row.working_dir || row.default_work_dir
      if (typeof dir !== 'string') continue
      try {
        await resolveRemoteWorkspacePath(principal, dir, true)
        allowed.push({ id: row.id, title: row.title, created_at: row.created_at, updated_at: row.updated_at, working_dir: row.working_dir ?? null, default_work_dir: row.default_work_dir ?? null, harness_mode: row.harness_mode ?? 'default' })
      } catch { /* Another workspace or symlink escaping this device's grant. */ }
    }
    assertRemoteActive(principal)
    return allowed
  }

  async function requireSession(principal: RemotePrincipal, sessionId: unknown): Promise<Row> {
    const id = identifier(sessionId)
    const row = (await sessionRows(principal)).find((item) => item.id === id)
    if (!row) throw new Error('remote-session-unavailable')
    return row
  }

  async function settingsProjection(): Promise<Row> {
    const raw = await handlers.get('kvGet')?.(null, 'clerkbox-settings')
    let stored: Row = {}
    try { stored = object(object(JSON.parse(typeof raw === 'string' ? raw : '{}')).state ?? {}) } catch { /* Defaults below. */ }
    const snapshot = manager.getLocalSettingsSnapshot()
    const safe: Row = {
      theme: 'dark', appFont: 'default', uiScale: 1, colorScheme: 'classic', customSeedColor: '#F4A7B9',
      language: 'zh-CN', interfaceMode: 'coding', hasCompletedOnboarding: true,
      apiKey: '', baseUrl: '', providers: [], customModels: [], mcpServers: [], permissionRules: [],
      approvalMode: 'manual', browserUseEnabled: false, computerUseEnabled: false,
      agentsMdEnabled: false, claudeMdCompat: false,
    }
    for (const key of ['theme', 'appFont', 'colorScheme', 'customSeedColor', 'language', 'interfaceMode']) {
      if (typeof stored[key] === 'string' && (stored[key] as string).length <= 80) safe[key] = stored[key]
    }
    if (typeof stored.uiScale === 'number' && stored.uiScale >= 0.75 && stored.uiScale <= 2) safe.uiScale = stored.uiScale
    if (snapshot) {
      safe.model = snapshot.model
      safe.activeProviderId = snapshot.activeProviderId
      safe.activeModelId = snapshot.activeModelId
      safe.apiCompat = snapshot.apiCompat
      safe.providers = snapshot.providers.map((p) => ({
        id: p.id, name: p.name, apiKey: '', baseUrl: '', apiCompat: p.apiCompat,
        models: p.models.map((m) => ({ id: m.id, label: m.label, maxInputTokens: m.maxInputTokens, maxTokens: m.maxTokens, supportsThinking: m.supportsThinking, supportsImages: m.supportsImages })),
      }))
      for (const key of ['temperature', 'maxInputTokens', 'maxTokens', 'enableThinking', 'thinkingBudget', 'reasoningEffort'] as const) safe[key] = snapshot[key]
    }
    return safe
  }

  async function bootstrap(principal: RemotePrincipal) {
    notePrincipal(principal)
    const settings = await settingsProjection()
    const workspace = await fs.realpath(principal.workspace)
    assertRemoteActive(principal)
    return { protocolVersion: 1 as const, capabilities: { control: principal.control, approve: principal.approve, files: principal.files }, workspace, settings }
  }

  async function attachments(principal: RemotePrincipal, raw: unknown): Promise<MessageAttachment[] | undefined> {
    if (raw === undefined) return undefined
    if (!Array.isArray(raw) || raw.length > 12) throw new Error('remote-invalid-attachments')
    const result: MessageAttachment[] = []
    for (const value of raw) {
      const item = object(value)
      exactKeys(item, ['id', 'kind', 'name', 'mimeType', 'dataUrl', 'path', 'size'])
      const attachment: MessageAttachment = { id: identifier(item.id), kind: item.kind === 'image' ? 'image' : 'file', name: string(item.name, 240) }
      if (item.kind !== 'image' && item.kind !== 'file') throw new Error('remote-invalid-attachments')
      if (item.mimeType !== undefined) attachment.mimeType = string(item.mimeType, 120)
      if (item.path !== undefined) {
        requireFiles(principal)
        attachment.path = await resolveRemoteWorkspacePath(principal, string(item.path, 4096))
        const stat = await fs.stat(attachment.path)
        if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error('remote-file-too-large')
        attachment.size = stat.size
      }
      if (item.dataUrl !== undefined) {
        requireFiles(principal)
        const data = string(item.dataUrl, 512 * 1024)
        if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('remote-invalid-attachments')
        attachment.dataUrl = data
      }
      if (attachment.kind === 'file' && !attachment.path) throw new Error('remote-invalid-attachments')
      result.push(attachment)
    }
    return result
  }

  async function parseCommand(principal: RemotePrincipal, raw: unknown): Promise<AgentCommand> {
    const cmd = object(raw)
    const type = string(cmd.type, 40)
    const sessionId = identifier(cmd.sessionId)
    await requireSession(principal, sessionId)
    requireControl(principal)
    switch (type) {
      case 'run': {
        exactKeys(cmd, ['type', 'sessionId', 'content', 'attachments', 'taskMode', 'skills', 'modelId', 'providerId'])
        if (cmd.taskMode !== undefined && !['plan', 'spec', 'goal'].includes(String(cmd.taskMode))) throw new Error('remote-invalid-arguments')
        // Model selection is deliberately server-owned for this transport version.
        if (cmd.modelId !== undefined || cmd.providerId !== undefined) throw new Error('remote-model-selection-unavailable')
        if (cmd.skills !== undefined && (!Array.isArray(cmd.skills) || cmd.skills.length)) throw new Error('remote-skill-selection-unavailable')
        return { type, sessionId, content: string(cmd.content, 128 * 1024, true), attachments: await attachments(principal, cmd.attachments), taskMode: cmd.taskMode as 'plan' | 'spec' | 'goal' | undefined }
      }
      case 'queue.enqueue': {
        exactKeys(cmd, ['type', 'sessionId', 'item'])
        const item = object(cmd.item)
        exactKeys(item, ['id', 'content', 'attachments', 'taskMode', 'skills', 'queuedAt'])
        if (item.taskMode !== undefined && !['plan', 'spec', 'goal'].includes(String(item.taskMode))) throw new Error('remote-invalid-arguments')
        if (item.skills !== undefined && (!Array.isArray(item.skills) || item.skills.length)) throw new Error('remote-skill-selection-unavailable')
        return { type, sessionId, item: { id: identifier(item.id), content: string(item.content, 128 * 1024, true), attachments: await attachments(principal, item.attachments), taskMode: item.taskMode as 'plan' | 'spec' | 'goal' | undefined, queuedAt: Date.now() } }
      }
      case 'abort': case 'manual.compact':
        exactKeys(cmd, type === 'manual.compact' ? ['type', 'sessionId', 'instructions'] : ['type', 'sessionId'])
        return type === 'abort' ? { type, sessionId } : { type, sessionId, instructions: cmd.instructions === undefined ? undefined : string(cmd.instructions, 16_384, true) }
      case 'queue.remove': case 'queue.flush':
        exactKeys(cmd, ['type', 'sessionId', 'id'])
        if (type === 'queue.remove') return { type, sessionId, id: identifier(cmd.id) }
        return { type, sessionId, id: cmd.id === undefined ? undefined : identifier(cmd.id) }
      case 'question.resolve': {
        exactKeys(cmd, ['type', 'sessionId', 'requestId', 'payload'])
        const answers = object(cmd.payload)
        if (Object.keys(answers).length > 20) throw new Error('remote-invalid-arguments')
        const payload: Record<string, string[]> = {}
        for (const [key, value] of Object.entries(answers)) {
          if (!ID.test(key) || !Array.isArray(value) || value.length > 20) throw new Error('remote-invalid-arguments')
          payload[key] = value.map((answer) => string(answer, 16_384, true))
        }
        return { type, sessionId, requestId: identifier(cmd.requestId), payload }
      }
      case 'permission.resolve':
        exactKeys(cmd, ['type', 'sessionId', 'requestId', 'approved', 'scope'])
        if (!principal.approve) throw new Error('remote-approval-disabled')
        if (typeof cmd.approved !== 'boolean' || (cmd.scope !== undefined && cmd.scope !== 'once')) throw new Error('remote-invalid-arguments')
        return { type, sessionId, requestId: identifier(cmd.requestId), approved: cmd.approved, scope: 'once' }
      default: throw new Error('remote-forbidden-command')
    }
  }

  async function sweepUploads(): Promise<void> {
    const now = Date.now()
    for (const [id, upload] of uploads) {
      if (!upload.writing && (upload.expiresAt <= now || !upload.principal.isActive())) {
        uploads.delete(id)
        await fs.rm(upload.path, { force: true }).catch(() => {})
      }
    }
  }
  const sweepTimer = setInterval(() => { void sweepUploads().catch(() => {}) }, 60_000)
  sweepTimer.unref?.()

  async function invoke(principal: RemotePrincipal, method: string, args: unknown[] = []): Promise<unknown> {
    notePrincipal(principal)
    if (!Array.isArray(args) || args.length > 4) throw new Error('remote-invalid-arguments')
    switch (method) {
      case 'remote:bootstrap': return bootstrap(principal)
      case 'agent:host-mode': return 'main'
      case 'kvGet':
        return args[0] === 'clerkbox-settings' ? JSON.stringify({ state: await settingsProjection(), version: 0 }) : null
      case 'dbGetAllSessions': return sessionRows(principal)
      case 'dbGetMessages': {
        const session = await requireSession(principal, args[0])
        const messages = await store.getMessages(session.id as string)
        assertRemoteActive(principal)
        return messages.map(({ file_checkpoints: _c, mutation_gaps: _g, ...row }) => row)
      }
      case 'dbGetRevision': return store.getRevision()
      case 'dbGetRecents': {
        const ids = new Set((await sessionRows(principal)).map((row) => row.id))
        return (await store.getRecents()).filter((id) => ids.has(id))
      }
      case 'dbCreateSession': {
        requireControl(principal)
        const input = object(args[0])
        const id = identifier(input.id)
        const all = await store.getAllSessions()
        if (all.some((row) => row.id === id)) { await requireSession(principal, id); return }
        const dir = await resolveRemoteWorkspacePath(principal, typeof input.working_dir === 'string' ? input.working_dir : principal.workspace, true)
        const now = Date.now()
        assertRemoteActive(principal)
        await store.createSession({ id, title: typeof input.title === 'string' ? string(input.title, 240, true) : 'New chat', created_at: now, updated_at: now, working_dir: dir, default_work_dir: dir, harness_mode: normalizeHarnessMode(input.harness_mode) })
        return
      }
      case 'dbUpdateSessionTitle': {
        requireControl(principal)
        await requireSession(principal, args[0])
        assertRemoteActive(principal)
        return store.updateSessionTitle(identifier(args[0]), string(args[1], 240, true), Date.now())
      }
      case 'agent:command': {
        const command = await parseCommand(principal, args[0])
        assertRemoteActive(principal)
        return manager.handleCommand(command, { remote: true, pairedRemote: principal })
      }
      case 'agent:snapshot': {
        const rows = await sessionRows(principal)
        // JSON transports encode an omitted positional argument as null.
        const target = args[0] == null ? undefined : identifier(args[0])
        if (target) await requireSession(principal, target)
        const since = typeof args[1] === 'number' && Number.isSafeInteger(args[1]) && args[1] >= 0 ? args[1] : 0
        const snapshots = rows.filter((row) => !target || row.id === target).map((row) => manager.snapshot(row.id as string, since))
        return { activeRuns: snapshots.flatMap((s) => s.activeRuns), queue: Object.assign({}, ...snapshots.map((s) => s.queue)), pendingPermissions: snapshots.flatMap((s) => s.pendingPermissions), lastSeq: Math.max(since, ...snapshots.map((s) => s.lastSeq)) }
      }
      case 'readFile': case 'readFileBase64': case 'readImageFileBase64': case 'listDir': case 'fileExists': {
        requireFiles(principal)
        let file: string
        try { file = await resolveRemoteWorkspacePath(principal, string(args[0], 4096)) } catch (error) {
          if (method === 'fileExists' && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
        const stat = await fs.stat(file)
        assertRemoteActive(principal)
        if (method === 'fileExists') return true
        if (method === 'listDir') {
          if (!stat.isDirectory()) throw new Error('remote-not-directory')
          const entries = await fs.readdir(file, { withFileTypes: true })
          return entries.filter((entry) => !entry.isSymbolicLink()).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }))
        }
        if (!stat.isFile() || stat.size > PREVIEW_LIMIT) throw new Error('remote-preview-too-large')
        const data = await fs.readFile(file)
        if (data.length > PREVIEW_LIMIT) throw new Error('remote-preview-too-large')
        assertRemoteActive(principal)
        if (method === 'readFile') return data.toString('utf8')
        const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain' } as Record<string, string>)[path.extname(file).toLowerCase()] || 'application/octet-stream'
        if (method === 'readImageFileBase64') {
          if (!mimeType.startsWith('image/')) throw new Error('remote-not-image')
          return `data:${mimeType};base64,${data.toString('base64')}`
        }
        return { data: data.toString('base64'), mimeType, size: data.length }
      }
      case 'remote:upload.start': {
        requireFiles(principal)
        const previous = uploadStartQueue
        let unlock!: () => void
        uploadStartQueue = new Promise<void>((resolve) => { unlock = resolve })
        await previous
        try {
          await sweepUploads()
          const input = object(args[0])
          const name = path.basename(string(input.name, 240)).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_')
          if (!name || name === '.' || name === '..') throw new Error('remote-invalid-arguments')
          if (typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > FILE_LIMIT) throw new Error('remote-file-too-large')
          const dir = await resolveRemoteWorkspacePath(principal, '.clerkbox/remote-uploads', true)
          await fs.mkdir(dir, { recursive: true })
          const actualDir = await resolveRemoteWorkspacePath(principal, dir)
          let diskBytes = 0
          for (const entry of await fs.readdir(actualDir, { withFileTypes: true })) {
            if (!entry.isFile() || entry.isSymbolicLink()) continue
            const file = path.join(actualDir, entry.name)
            const info = await fs.stat(file)
            if (/^\.upload-[a-f0-9]{48}\.part$/.test(entry.name) && Date.now() - info.mtimeMs > UPLOAD_TTL && ![...uploads.values()].some((u) => u.path === file)) {
              await fs.rm(file, { force: true })
            } else diskBytes += info.size
          }
          const reserved = [...uploads.values()].filter((u) => path.dirname(u.path) === actualDir).reduce((total, u) => total + u.size - u.received, 0)
          if (diskBytes + reserved + input.size > UPLOAD_QUOTA || uploads.size >= 32) throw new Error('remote-upload-quota')
          const uploadId = crypto.randomBytes(24).toString('hex')
          const file = path.join(actualDir, `.upload-${uploadId}.part`)
          assertRemoteActive(principal)
          await fs.writeFile(file, new Uint8Array(), { flag: 'wx', mode: 0o600 })
          uploads.set(uploadId, { principal, path: file, name, size: input.size, received: 0, nextIndex: 0, expiresAt: Date.now() + UPLOAD_TTL, writing: false })
          return { uploadId, chunkBytes: CHUNK_LIMIT }
        } finally { unlock() }
      }
      case 'remote:upload.chunk': case 'remote:upload.finish': {
        requireFiles(principal)
        await sweepUploads()
        const id = identifier(args[0])
        const upload = uploads.get(id)
        if (!upload || upload.principal.deviceId !== principal.deviceId || upload.principal.workspace !== principal.workspace || upload.writing) throw new Error('remote-upload-unavailable')
        upload.writing = true
        try {
          await resolveRemoteWorkspacePath(principal, upload.path)
          if (method === 'remote:upload.finish') {
            if (upload.received !== upload.size) throw new Error('remote-upload-incomplete')
            const finalPath = await resolveRemoteWorkspacePath(principal, path.join(path.dirname(upload.path), `${id}-${upload.name}`), true)
            assertRemoteActive(principal)
            await fs.rename(upload.path, finalPath)
            uploads.delete(id)
            // A completed attachment belongs to the workspace; never expire it in the middle of a task.
            return { name: upload.name, path: finalPath, size: upload.size, maxUploadBytes: FILE_LIMIT }
          }
          if (args[1] !== upload.nextIndex) throw new Error('remote-upload-chunk-order')
          const encoded = string(args[2], Math.ceil(CHUNK_LIMIT / 3) * 4)
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error('remote-invalid-chunk')
          const data = Buffer.from(encoded, 'base64')
          if (data.length === 0 || data.length > CHUNK_LIMIT || upload.received + data.length > upload.size) throw new Error('remote-invalid-chunk')
          assertRemoteActive(principal)
          await fs.appendFile(upload.path, data)
          upload.received += data.length
          upload.nextIndex += 1
          upload.expiresAt = Date.now() + UPLOAD_TTL
          return { received: upload.received, nextIndex: upload.nextIndex }
        } finally { upload.writing = false }
      }
      default: throw new Error('remote-forbidden-method')
    }
  }

  async function filterEvent(principal: RemotePrincipal, payload: { seq: number; event: AgentEvent }) {
    if (!principal.isActive() || !Number.isSafeInteger(payload.seq) || payload.seq < 0) return null
    try { await requireSession(principal, payload.event.sessionId) } catch { return null }
    return principal.isActive() ? payload : null
  }

  function dispose(): void {
    clearInterval(sweepTimer)
    for (const upload of uploads.values()) void fs.rm(upload.path, { force: true }).catch(() => {})
    uploads.clear()
    remoteApprovers.clear()
  }
  return { invoke, filterEvent, bootstrap, dispose }
}
