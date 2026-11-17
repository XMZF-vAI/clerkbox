/** Explicit, capability-scoped public transport. Never forwards arbitrary IPC. */
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import type { ChatStore } from './db'
import type { AgentSessionManager } from './agent-host'
import { handlerRegistry } from './webui-server'
import type { RemotePrincipal } from '../src/remote/protocol'
import type { AgentCommand, AgentEvent } from '../src/agent-core/protocol'
import type { MessageAttachment, MessageSkillSnapshot } from '../src/types/agent'
import type { AgentSettings } from '../src/agent-core/ports'
import { normalizeHarnessMode } from '../src/lib/harness-modes'
import { mergeRemoteState, projectRemoteState, REMOTE_SHARED_STATE_KEYS } from './remote-state'
import { BOTS_IPC_CHANNELS } from './im-bots/types'

const FILE_LIMIT = 10 * 1024 * 1024
const CHUNK_LIMIT = 128 * 1024
const PREVIEW_LIMIT = 256 * 1024
const UPLOAD_QUOTA = 50 * 1024 * 1024
const UPLOAD_TTL = 15 * 60_000
const ID = /^[A-Za-z0-9_-]{1,160}$/
const WORKBENCH_READ_METHODS = new Set([
  'apiFetchModels', 'apiTestConnection', 'apiTestVision', 'mcpStatus', 'mcpTools', 'mcpSearch',
  'scanMemory', 'scanAgents', 'readMemoryIndex', 'searchMemoryFiles', 'scanSkillDirs',
  'skillsSearch', 'fetchSkillMd', 'fetchSkillFromRepo', 'parseSkillFile', 'webSearch', 'webFetch',
  'gitGetStatus', 'gitGetDiff', 'gitGetBranches', 'gitGetCommitGraph', 'gitGetIdentity',
  'jouleGetState', 'jouleRefresh', 'accountGetStatus', 'accountSyncGetPassphraseStatus',
  'agentMemoryStatus', 'agentMemorySearch', 'agentMemoryContext', 'vibeGetWallpaper', 'vibeMediaGetState',
  'agentBrowser:ready',
  BOTS_IPC_CHANNELS.list, BOTS_IPC_CHANNELS.runtimeStatus, BOTS_IPC_CHANNELS.weixinQrPoll,
])
const WORKBENCH_CONTROL_METHODS = new Set([
  'mcpSync', 'mcpTest', 'mcpCallTool', 'writeMemoryFile', 'updateMemoryIndex',
  'initClerkbox', 'writeSkillMd', 'writeSkillDir', 'removeSkillDir',
  'gitSwitchBranch', 'gitCreateBranchAndSwitch', 'gitStagePaths', 'gitCommit', 'gitPush',
  'jouleStartLogin', 'jouleCancelLogin', 'jouleLogout', 'jouleOpenDashboard',
  'accountLogin', 'accountLogout', 'accountSyncUpload', 'accountSyncDownload', 'accountSyncSetPassphrase',
  'agentMemoryMigrate', 'agentMemorySave', 'agentMemoryCapture', 'executeCommand', 'executeCommandWithShell',
  'cancelSessionCommands', 'vibeMediaCommand', 'vibeMediaStop', 'setKeepAwake', 'remote:ui.command',
  ...Object.values(BOTS_IPC_CHANNELS).filter(method => !['bots:list', 'bots:runtimeStatus', 'bots:weixinQrPoll'].includes(method)),
])
const FILE_METHODS = new Set([
  'scanMemory', 'scanAgents', 'readMemoryIndex', 'searchMemoryFiles', 'scanSkillDirs', 'parseSkillFile',
  'writeMemoryFile', 'updateMemoryIndex', 'initClerkbox', 'writeSkillMd', 'writeSkillDir', 'removeSkillDir',
  'gitGetStatus', 'gitGetDiff', 'gitGetBranches', 'gitGetCommitGraph', 'gitGetIdentity',
  'gitSwitchBranch', 'gitCreateBranchAndSwitch', 'gitStagePaths', 'gitCommit', 'gitPush',
])
const RUN_OPTIONS = ['providerId', 'modelId', 'temperature', 'maxInputTokens', 'maxTokens', 'enableThinking', 'thinkingBudget', 'reasoningEffort'] as const
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
  if (principal.scope !== 'desktop' && !inside(root, requested)) throw new Error('remote-outside-workspace')
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
    if (principal.scope !== 'desktop' && !inside(root, real)) throw new Error('remote-outside-workspace')
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
  /** Flush a replay batch to every connected peer before broadcasting another ring. */
  drainEvents?(force?: boolean): Promise<void>
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

export function createRemoteHostDispatcher({ store, manager, handlers = handlerRegistry, drainEvents }: RemoteHostDispatcherOptions) {
  const uploads = new Map<string, Upload>()
  let uploadStartQueue = Promise.resolve()
  const remoteApprovers = new Map<string, RemotePrincipal>()
  manager.setRemoteApprovalProbe(() => [...remoteApprovers.values()].some((p) => p.approve && p.isActive()))

  const notePrincipal = (principal: RemotePrincipal) => {
    assertRemoteActive(principal)
    remoteApprovers.set(principal.deviceId, principal)
  }

  async function syncSettings(): Promise<void> {
    const raw = await handlers.get('kvGet')?.(null, 'clerkbox-settings')
    if (typeof raw !== 'string') return
    const stored = object(object(JSON.parse(raw)).state)
    const previous = manager.getLocalSettingsSnapshot()
    const keys = await handlers.get('loadApiKeys')?.(null) as Record<string, string> | undefined
    const providers: AgentSettings['providers'] = Array.isArray(stored.providers) ? stored.providers.map(value => {
      const p = object(value)
      return { ...p, apiKey: keys ? keys[String(p.id)] ?? '' : previous?.providers.find(item => item.id === p.id)?.apiKey ?? '' } as unknown as AgentSettings['providers'][number]
    }) : previous?.providers ?? []
    const provider = providers.find(p => p.id === stored.activeProviderId)
    const next = { ...previous, ...stored, providers,
      ...(provider ? { apiKey: provider.apiKey, baseUrl: provider.baseUrl, apiCompat: provider.apiCompat } : {}),
    } as AgentSettings
    if (next.model) manager.noteLocalSettings(next)
  }

  async function runSettings(input: Row): Promise<AgentSettings | undefined> {
    const base = manager.getLocalSettingsSnapshot()
    if (!base) return undefined
    // Renderer rehydration briefly contains blank projected keys. Resolve the
    // execution credential from its authoritative encrypted store, not that view.
    const keys = await handlers.get('loadApiKeys')?.(null) as Record<string, string> | undefined
    const providers = base.providers.map(provider => ({ ...provider, apiKey: keys ? keys[provider.id] ?? '' : provider.apiKey }))
    const activeProvider = providers.find(provider => provider.id === base.activeProviderId)
    let next = { ...base, providers, ...(activeProvider ? { apiKey: activeProvider.apiKey } : {}) }
    if (input.providerId !== undefined || input.modelId !== undefined) {
      const provider = providers.find(p => p.id === (input.providerId ?? base.activeProviderId))
      const modelId = string(input.modelId ?? base.activeModelId ?? base.model, 240)
      const model = provider?.models.find(m => m.id === modelId)
      if (!provider || !model) {
        if (modelId !== base.model || (input.providerId !== undefined && input.providerId !== base.activeProviderId)) throw new Error('remote-model-unavailable')
      } else next = { ...next, activeProviderId: provider.id, activeModelId: modelId, model: modelId, baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiCompat: provider.apiCompat, directFetch: provider.directFetch ?? false }
    }
    for (const key of ['temperature', 'maxInputTokens', 'maxTokens', 'thinkingBudget'] as const) if (input[key] !== undefined) {
      const value = input[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (key === 'temperature' ? 2 : 4_000_000)) throw new Error('remote-invalid-arguments')
      next[key] = value
    }
    if (input.enableThinking !== undefined) {
      if (typeof input.enableThinking !== 'boolean') throw new Error('remote-invalid-arguments')
      next.enableThinking = input.enableThinking
    }
    if (input.reasoningEffort !== undefined) {
      const value = string(input.reasoningEffort, 24)
      if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) throw new Error('remote-invalid-arguments')
      next.reasoningEffort = value as AgentSettings['reasoningEffort']
    }
    return next
  }

  async function sessionRows(principal: RemotePrincipal): Promise<Row[]> {
    assertRemoteActive(principal)
    const rows = await store.getAllSessions()
    const allowed: Row[] = []
    for (const row of rows) {
      const dir = row.working_dir || row.default_work_dir
      if (typeof dir !== 'string' && principal.scope !== 'desktop') continue
      try {
        if (principal.scope !== 'desktop') await resolveRemoteWorkspacePath(principal, dir as string, true)
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

  async function settingsProjection(principal?: RemotePrincipal): Promise<Row> {
    const raw = await handlers.get('kvGet')?.(null, 'clerkbox-settings')
    let stored: Row = {}
    try { stored = object(object(JSON.parse(typeof raw === 'string' ? raw : '{}')).state ?? {}) } catch { /* Defaults below. */ }
    const snapshot = manager.getLocalSettingsSnapshot()
    if (principal?.scope === 'desktop') {
      const state = { ...snapshot, ...stored, providers: stored.providers ?? snapshot?.providers ?? [], hasCompletedOnboarding: true }
      // Credentials remain on the host, including nested MCP environment/header values.
      const projected = JSON.parse(projectRemoteState('clerkbox-settings', JSON.stringify({ state, version: 0 }))!).state as Row
      const keys = await handlers.get('loadApiKeys')?.(null) as Record<string, string> | undefined
      if (Array.isArray(projected.providers)) for (const provider of projected.providers) {
        if (!provider || typeof provider !== 'object') continue
        const p = provider as Row
        p.apiKeyConfigured = keys ? !!keys[String(p.id)] : !!(snapshot?.providers.find(item => item.id === p.id)?.apiKey || p.apiKeyConfigured)
      }
      return projected
    }
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
    const settings = await settingsProjection(principal)
    const workspace = await fs.realpath(principal.workspace)
    assertRemoteActive(principal)
    return { protocolVersion: 1 as const, scope: principal.scope, homeDir: principal.scope === 'desktop' ? os.homedir() : workspace, platform: process.platform, capabilities: { control: principal.control, approve: principal.approve, files: principal.files, maxUploadBytes: FILE_LIMIT }, workspace, settings }
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

  function selectedSkills(principal: RemotePrincipal, raw: unknown): MessageSkillSnapshot[] | undefined {
    if (raw === undefined) return undefined
    if (!Array.isArray(raw) || raw.length > 100) throw new Error('remote-invalid-arguments')
    if (principal.scope !== 'desktop' && raw.length) throw new Error('remote-skill-selection-unavailable')
    return raw.map(value => {
      const item = object(value)
      exactKeys(item, ['id', 'name', 'icon', 'slug'])
      return { id: identifier(item.id), name: string(item.name, 240),
        ...(item.icon !== undefined ? { icon: string(item.icon, 80, true) } : {}),
        ...(item.slug !== undefined ? { slug: string(item.slug, 160) } : {}),
      }
    })
  }

  /** These are user-selected context, not executable transport or connection configuration. */
  function runContext(principal: RemotePrincipal, cmd: Row): Partial<Extract<AgentCommand, { type: 'run' }>> {
    if (principal.scope !== 'desktop') return {}
    const extra: Record<string, unknown> = {}
    for (const key of ['skillCatalog', 'goal', 'todos'] as const) if (cmd[key] !== undefined) {
      const serialized = JSON.stringify(cmd[key])
      if (!serialized || serialized.length > 256 * 1024 || /"(?:__proto__|constructor|prototype)"\s*:/.test(serialized)) throw new Error('remote-invalid-arguments')
      if ((key === 'skillCatalog' || key === 'todos') && !Array.isArray(cmd[key])) throw new Error('remote-invalid-arguments')
      if (key === 'goal') object(cmd[key])
      extra[key] = JSON.parse(serialized)
    }
    if (cmd.skillReminder !== undefined) extra.skillReminder = string(cmd.skillReminder, 64 * 1024, true)
    return extra
  }

  async function parseCommand(principal: RemotePrincipal, raw: unknown): Promise<AgentCommand> {
    const cmd = object(raw)
    const type = string(cmd.type, 40)
    const sessionId = identifier(cmd.sessionId)
    await requireSession(principal, sessionId)
    requireControl(principal)
    switch (type) {
      case 'run': {
        exactKeys(cmd, ['type', 'sessionId', 'content', 'attachments', 'taskMode', 'skills', ...RUN_OPTIONS, ...(principal.scope === 'desktop' ? ['skillCatalog', 'skillReminder', 'goal', 'todos'] : [])])
        if (cmd.taskMode !== undefined && !['plan', 'spec', 'goal'].includes(String(cmd.taskMode))) throw new Error('remote-invalid-arguments')
        // Model selection is deliberately server-owned for this transport version.
        if (principal.scope !== 'desktop' && RUN_OPTIONS.some(key => cmd[key] !== undefined)) throw new Error('remote-model-selection-unavailable')
        return { type, sessionId, content: string(cmd.content, 128 * 1024, true), attachments: await attachments(principal, cmd.attachments), taskMode: cmd.taskMode as 'plan' | 'spec' | 'goal' | undefined, ...(cmd.skills !== undefined ? { skills: selectedSkills(principal, cmd.skills) } : {}), ...runContext(principal, cmd) }
      }
      case 'queue.enqueue': {
        exactKeys(cmd, ['type', 'sessionId', 'item'])
        const item = object(cmd.item)
        exactKeys(item, ['id', 'content', 'attachments', 'taskMode', 'skills', 'queuedAt', ...(principal.scope === 'desktop' ? RUN_OPTIONS : [])])
        if (item.taskMode !== undefined && !['plan', 'spec', 'goal'].includes(String(item.taskMode))) throw new Error('remote-invalid-arguments')
        return { type, sessionId, item: { id: identifier(item.id), content: string(item.content, 128 * 1024, true), attachments: await attachments(principal, item.attachments), taskMode: item.taskMode as 'plan' | 'spec' | 'goal' | undefined, ...(item.skills !== undefined ? { skills: selectedSkills(principal, item.skills) } : {}), queuedAt: Date.now() } }
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
        if (typeof cmd.approved !== 'boolean' || (cmd.scope !== undefined && cmd.scope !== 'once' && !(principal.scope === 'desktop' && cmd.scope === 'session'))) throw new Error('remote-invalid-arguments')
        return { type, sessionId, requestId: identifier(cmd.requestId), approved: cmd.approved, scope: cmd.scope === 'session' ? 'session' : 'once' }
      case 'subagent.stop': case 'workflow.stop': case 'subagent.steer':
        if (principal.scope !== 'desktop') throw new Error('remote-forbidden-command')
        exactKeys(cmd, type === 'subagent.steer' ? ['type', 'sessionId', 'runId', 'text'] : ['type', 'sessionId', 'runId'])
        return type === 'subagent.steer' ? { type, sessionId, runId: identifier(cmd.runId), text: string(cmd.text, 64 * 1024) } : { type, sessionId, runId: identifier(cmd.runId) }
      case 'rewind.preview': case 'rewind.apply': {
        if (principal.scope !== 'desktop') throw new Error('remote-forbidden-command')
        exactKeys(cmd, ['type', 'sessionId', 'anchorMessageId', 'scope', 'expectedHistoryVersion'])
        if (!['conversation', 'workspace', 'both'].includes(String(cmd.scope))) throw new Error('remote-invalid-arguments')
        if (cmd.scope !== 'conversation') requireFiles(principal)
        const fields = { sessionId, anchorMessageId: identifier(cmd.anchorMessageId), scope: cmd.scope as 'conversation' | 'workspace' | 'both' }
        return type === 'rewind.preview' ? { type, ...fields } : { type, ...fields, expectedHistoryVersion: cmd.expectedHistoryVersion === undefined ? undefined : string(cmd.expectedHistoryVersion, 256) }
      }
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
    if (!Array.isArray(args) || args.length > 8) throw new Error('remote-invalid-arguments')
    switch (method) {
      case 'remote:bootstrap': return bootstrap(principal)
      case 'agent:host-mode': return 'main'
      case 'kvGet': {
        if (args[0] === 'clerkbox-settings') return JSON.stringify({ state: await settingsProjection(principal), version: 0 })
        if (principal.scope !== 'desktop' || !REMOTE_SHARED_STATE_KEYS.has(String(args[0]))) return null
        const raw = await handlers.get('kvGet')?.(null, args[0])
        return projectRemoteState(String(args[0]), typeof raw === 'string' ? raw : null)
      }
      case 'remote:state.patch': {
        requireControl(principal)
        if (principal.scope !== 'desktop') throw new Error('remote-forbidden-method')
        const input = object(args[0])
        exactKeys(input, ['name', 'base', 'value'])
        const name = string(input.name, 100)
        if (!REMOTE_SHARED_STATE_KEYS.has(name)) throw new Error('remote-forbidden-state')
        const base = input.base === null ? null : string(input.base, 8 * 1024 * 1024, true)
        let value = input.value === null ? null : string(input.value, 8 * 1024 * 1024, true)
        // API keys have a separate OS-encrypted write channel. A projected settings
        // form must never turn a newly entered key into plaintext KV storage.
        if (name === 'clerkbox-settings' && value !== null) {
          const envelope = object(JSON.parse(value))
          const state = object(envelope.state)
          state.apiKey = ''
          for (const list of [state.providers, state.customModels]) if (Array.isArray(list)) {
            for (const provider of list) if (provider && typeof provider === 'object') (provider as Row).apiKey = ''
          }
          value = JSON.stringify(envelope)
        }
        const handler = handlers.get('remote:state.patch')
        let next: string | null
        if (handler) {
          const result = await handler(null, { name, base, value }) as { value: string | null }
          next = result.value
        } else {
          const raw = await handlers.get('kvGet')?.(null, name)
          next = mergeRemoteState(name, typeof raw === 'string' ? raw : null, base, value)
          if (next === null) await handlers.get('kvRemove')?.(null, name)
          else await handlers.get('kvSet')?.(null, name, next)
        }
        if (name === 'clerkbox-settings') await syncSettings()
        return { value: name === 'clerkbox-settings' && next !== null
          ? JSON.stringify({ state: await settingsProjection(principal), version: 0 })
          : projectRemoteState(name, next) }
      }
      case 'loadApiKeys': {
        if (principal.scope !== 'desktop') throw new Error('remote-forbidden-method')
        // Presence is carried separately by the settings projection. Never reveal a stored credential.
        const keys = await handlers.get('loadApiKeys')?.(null) as Record<string, string> | undefined
        return Object.fromEntries(Object.keys(keys ?? {}).map(key => [key, '']))
      }
      case 'saveApiKey': case 'removeApiKey': {
        requireControl(principal)
        if (principal.scope !== 'desktop') throw new Error('remote-forbidden-method')
        const id = identifier(args[0])
        const handler = handlers.get(method)
        if (!handler) throw new Error('remote-method-unavailable')
        if (method === 'saveApiKey') await handler(null, id, string(args[1], 64 * 1024, true))
        else await handler(null, id)
        await syncSettings()
        return
      }
      case 'dbGetAllSessions': return sessionRows(principal)
      case 'dbGetMessages': {
        const session = await requireSession(principal, args[0])
        const messages = await store.getMessages(session.id as string)
        assertRemoteActive(principal)
        if (principal.scope === 'desktop' && principal.files) return messages
        return messages.map(({ file_checkpoints: _c, mutation_gaps: _g, ...row }) => row)
      }
      case 'dbGetRevision': return store.getRevision()
      case 'dbGetRecents': {
        if (principal.scope === 'desktop') return store.getRecents()
        const ids = new Set((await sessionRows(principal)).map((row) => row.id))
        return (await store.getRecents()).filter((id) => ids.has(id))
      }
      case 'dbCreateSession': {
        requireControl(principal)
        const input = object(args[0])
        const id = identifier(input.id)
        const all = await store.getAllSessions()
        if (all.some((row) => row.id === id)) {
          await requireSession(principal, id)
          if (principal.scope !== 'desktop') return
          if (manager.inspect().some(session => session.sessionId === id && (session.status !== 'idle' || session.queued > 0))) throw new Error('session-busy')
        }
        const dir = typeof input.working_dir === 'string' ? await resolveRemoteWorkspacePath(principal, input.working_dir, true) : principal.scope === 'desktop' ? null : principal.workspace
        const defaultDir = principal.scope !== 'desktop' ? dir : typeof input.default_work_dir === 'string' ? await resolveRemoteWorkspacePath(principal, input.default_work_dir, true) : null
        const now = Date.now()
        assertRemoteActive(principal)
        await store.createSession({ id, title: typeof input.title === 'string' ? string(input.title, 240, true) : 'New chat', created_at: all.find(row => row.id === id)?.created_at ?? now, updated_at: now, working_dir: dir, default_work_dir: defaultDir, harness_mode: normalizeHarnessMode(input.harness_mode) })
        return
      }
      case 'dbSetRecents': {
        requireControl(principal)
        if (principal.scope !== 'desktop' || !Array.isArray(args[0]) || args[0].length > 40) throw new Error('remote-forbidden-method')
        const dirs = []
        for (const dir of args[0]) dirs.push(await resolveRemoteWorkspacePath(principal, string(dir, 4096), true))
        return store.setRecents(dirs)
      }
      case 'dbDeleteSession': {
        requireControl(principal)
        if (principal.scope !== 'desktop') throw new Error('remote-forbidden-method')
        await requireSession(principal, args[0])
        const id = identifier(args[0])
        manager.dropSession(id)
        return store.deleteSession(id)
      }
      case 'dbUpdateSessionTitle': {
        requireControl(principal)
        await requireSession(principal, args[0])
        assertRemoteActive(principal)
        return store.updateSessionTitle(identifier(args[0]), string(args[1], 240, true), Date.now())
      }
      case 'agent:command': {
        const command = await parseCommand(principal, args[0])
        const input = object(args[0])
        const selection = command.type === 'queue.enqueue' ? object(input.item) : input
        const trustedRemoteSettings = principal.scope === 'desktop' && (command.type === 'run' || command.type === 'queue.enqueue') ? await runSettings(selection) : undefined
        assertRemoteActive(principal)
        return manager.handleCommand(command, { remote: true, pairedRemote: principal, ...(trustedRemoteSettings ? { trustedRemoteSettings } : {}) })
      }
      case 'agent:snapshot': {
        const rows = await sessionRows(principal)
        // JSON transports encode an omitted positional argument as null.
        const target = args[0] == null ? undefined : identifier(args[0])
        if (target) await requireSession(principal, target)
        const since = typeof args[1] === 'number' && Number.isSafeInteger(args[1]) && args[1] >= 0 ? args[1] : 0
        // DB owns idle conversation history. A global runtime sync must not create
        // host sessions (and new replay rings) for every historical conversation.
        const runtimeIds = new Set(manager.inspect().map(session => session.sessionId))
        const targets = rows.filter(row => target ? row.id === target : runtimeIds.has(row.id as string))
        const snapshots = []
        for (const row of targets) {
          assertRemoteActive(principal)
          snapshots.push(manager.snapshot(row.id as string, since))
          // snapshot broadcasts to all subscribers, so the barrier covers every
          // peer, rather than only the browser that requested this replay.
          await drainEvents?.(false)
        }
        await drainEvents?.(true)
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
        const limit = principal.scope === 'desktop' ? FILE_LIMIT : PREVIEW_LIMIT
        if (!stat.isFile() || stat.size > limit) throw new Error('remote-preview-too-large')
        const data = await fs.readFile(file)
        if (data.length > limit) throw new Error('remote-preview-too-large')
        assertRemoteActive(principal)
        if (method === 'readFile') return data.toString('utf8')
        const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain' } as Record<string, string>)[path.extname(file).toLowerCase()] || 'application/octet-stream'
        if (method === 'readImageFileBase64') {
          if (!mimeType.startsWith('image/')) throw new Error('remote-not-image')
          return `data:${mimeType};base64,${data.toString('base64')}`
        }
        return { data: data.toString('base64'), mimeType, size: data.length }
      }
      case 'writeFile': case 'deleteFile': {
        requireControl(principal); requireFiles(principal)
        if (principal.scope !== 'desktop') throw new Error('remote-forbidden-method')
        const file = await resolveRemoteWorkspacePath(principal, string(args[0], 4096), method === 'writeFile')
        if (method === 'deleteFile') return fs.unlink(file)
        const content = string(args[1], FILE_LIMIT, true)
        await fs.mkdir(path.dirname(file), { recursive: true })
        assertRemoteActive(principal)
        return fs.writeFile(file, content, 'utf8')
      }
      case 'ptyCreate': case 'ptyInput': case 'ptyResize': case 'ptyKill': {
        requireControl(principal)
        if (principal.scope !== 'desktop') throw new Error('remote-forbidden-method')
        const input = method === 'ptyCreate' ? object(args[0]) : undefined
        const id = string(input?.id ?? args[0], 240)
        if (!id.startsWith(`remote-${principal.deviceId}-`) || !/^[A-Za-z0-9_#.:~-]+$/.test(id)) throw new Error('remote-terminal-unavailable')
        const handler = handlers.get(method)
        if (!handler) throw new Error('remote-method-unavailable')
        if (input) {
          exactKeys(input, ['id', 'cwd', 'cols', 'rows'])
          const cwd = await resolveRemoteWorkspacePath(principal, typeof input.cwd === 'string' ? input.cwd : principal.workspace)
          return handler(null, { id, cwd, cols: Math.max(2, Math.min(500, Number(input.cols) || 80)), rows: Math.max(2, Math.min(200, Number(input.rows) || 24)) })
        }
        if (method === 'ptyInput') return handler(null, id, string(args[1], 64 * 1024, true))
        if (method === 'ptyResize') return handler(null, id, Math.max(2, Math.min(500, Number(args[1]) || 80)), Math.max(2, Math.min(200, Number(args[2]) || 24)))
        return handler(null, id)
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
      default: {
        if (principal.scope !== 'desktop' || (!WORKBENCH_READ_METHODS.has(method) && !WORKBENCH_CONTROL_METHODS.has(method))) throw new Error('remote-forbidden-method')
        if (WORKBENCH_CONTROL_METHODS.has(method)) requireControl(principal)
        if (FILE_METHODS.has(method)) {
          requireFiles(principal)
          args = [...args]
          args[0] = await resolveRemoteWorkspacePath(principal, string(args[0], 4096), WORKBENCH_CONTROL_METHODS.has(method))
        }
        if (['apiFetchModels', 'apiTestConnection', 'apiTestVision'].includes(method)) {
          const cfg = object(args[0])
          const snapshot = manager.getLocalSettingsSnapshot()
          const provider = cfg.providerId !== undefined
            ? snapshot?.providers.find(p => p.id === cfg.providerId)
            : snapshot?.providers.find(p => p.baseUrl === cfg.baseUrl)
          const keys = await handlers.get('loadApiKeys')?.(null) as Record<string, string> | undefined
          const apiKey = typeof cfg.apiKey === 'string' && cfg.apiKey ? cfg.apiKey : (provider ? (keys ? keys[provider.id] ?? '' : provider.apiKey) : snapshot?.baseUrl === cfg.baseUrl ? snapshot?.apiKey : '') || ''
          args = [{ ...cfg, apiKey }, ...args.slice(1)]
        }
        if (method === 'mcpTest' || method === 'mcpSync') {
          const raw = await handlers.get('kvGet')?.(null, 'clerkbox-settings')
          if (typeof raw === 'string') {
            const old = object(object(JSON.parse(raw)).state)
            const state = { ...old, mcpServers: method === 'mcpSync' ? args[0] : [args[0]] }
            const merged = mergeRemoteState('clerkbox-settings', raw, projectRemoteState('clerkbox-settings', raw), JSON.stringify({ state, version: 0 }))
            const servers = object(object(JSON.parse(merged!)).state).mcpServers as unknown[]
            args = [method === 'mcpSync' ? servers : servers[0]]
          }
        }
        const handler = handlers.get(method)
        if (!handler) throw new Error('remote-method-unavailable')
        assertRemoteActive(principal)
        const result = await handler(null, ...args)
        if (method === 'jouleStartLogin') {
          if (!result || typeof result !== 'object') return result
          const { key: _key, ...safe } = result as Row
          return safe
        }
        return result
      }
    }
  }

  function filterEvent(principal: RemotePrincipal, payload: { seq: number; event: AgentEvent }): { seq: number; event: AgentEvent } | null | Promise<{ seq: number; event: AgentEvent } | null> {
    if (!principal.isActive() || !Number.isSafeInteger(payload.seq) || payload.seq < 0) return null
    // These events originate from the host, and a desktop grant covers every session.
    // Avoid re-reading the whole session table for every streaming delta.
    if (principal.scope === 'desktop') return payload
    return (async () => {
      try { await requireSession(principal, payload.event.sessionId) } catch { return null }
      return principal.isActive() ? payload : null
    })()
  }

  function dispose(): void {
    clearInterval(sweepTimer)
    for (const upload of uploads.values()) void fs.rm(upload.path, { force: true }).catch(() => {})
    uploads.clear()
    remoteApprovers.clear()
  }
  return { invoke, filterEvent, bootstrap, dispose }
}
