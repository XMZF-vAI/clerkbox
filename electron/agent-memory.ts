import { app } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as rtAccount from './rt-account'

export interface AgentMemoryStatus {
  configured: boolean
  reachable: boolean
  endpoint?: string
  error?: string
}

export interface AgentMemoryCaptureMessage {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
}

export interface AgentMemoryMigrationResult {
  ok: boolean
  imported: number
  skipped: number
  failed: number
  source: 'local' | 'local+legacy-cloud' | 'none'
  error?: string
}

interface SdkMemoryClient {
  addConversation(params: { messages: AgentMemoryCaptureMessage[] }): Promise<unknown>
  searchAtomic(params: { query: string; limit?: number }): Promise<{ items: Array<{ content: string; type?: string; score?: number }> }>
  readCore(): Promise<{ content?: string | null }>
  listScenarios(params?: { path_prefix?: string }): Promise<{ entries: Array<{ path: string; summary?: string }> }>
  readScenario(params: { path: string }): Promise<{ content?: string | null }>
  writeScenario(params: { path: string; content: string; summary?: string }): Promise<unknown>
}
interface SdkModule { MemoryClient: new (config: Record<string, unknown>) => SdkMemoryClient }

const sdkLoader = new Function('return import("@tencentdb-agent-memory/memory-sdk-ts-v2/v3")') as () => Promise<SdkModule>
let sdkPromise: Promise<SdkModule> | null = null
let clientCache: { key: string; client: SdkMemoryClient } | null = null

function getEnv(name: string): string {
  return (process.env[name] || '').trim()
}

function endpoint(): string {
  return getEnv('TDAI_MEMORY_ENDPOINT') || getEnv('TDAI_GATEWAY_ENDPOINT')
}

function stableIdFile(): string {
  return path.join(app.getPath('userData'), 'agent-memory-client-id')
}

function stableLocalId(): string {
  try {
    const existing = fs.readFileSync(stableIdFile(), 'utf8').trim()
    if (existing) return existing
  } catch { /* create below */ }
  const id = `usr-local-${crypto.randomUUID()}`
  try {
    fs.mkdirSync(path.dirname(stableIdFile()), { recursive: true })
    fs.writeFileSync(stableIdFile(), id, 'utf8')
  } catch { /* a process-local id is still safe as a fallback */ }
  return id
}

function hashId(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function identity(workingDir?: string): { teamId: string; agentId: string; userId: string } {
  const status = rtAccount.rtGetStatus()
  const userId = status.user?.uuid || (status.user?.id ? `rt-${status.user.id}` : stableLocalId())
  const teamId = getEnv('TDAI_MEMORY_TEAM_ID') || 'clerkbox'
  const projectKey = workingDir ? path.resolve(workingDir).toLowerCase() : 'global'
  const agentSeed = getEnv('TDAI_MEMORY_AGENT_ID') || `clerkbox-${hashId(projectKey)}`
  return { teamId, agentId: agentSeed, userId }
}

async function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) sdkPromise = sdkLoader()
  return sdkPromise
}

async function getClient(workingDir?: string, sessionId?: string): Promise<SdkMemoryClient | null> {
  const base = endpoint()
  if (!base) return null
  const apiKey = getEnv('TDAI_MEMORY_API_KEY') || getEnv('TDAI_GATEWAY_API_KEY')
  const serviceId = getEnv('TDAI_MEMORY_SERVICE_ID') || 'clerkbox'
  const ids = identity(workingDir)
  const key = JSON.stringify({ base, apiKey, serviceId, ...ids, sessionId: sessionId || '' })
  if (clientCache?.key === key) return clientCache.client
  const { MemoryClient } = await loadSdk()
  const client = new MemoryClient({
    endpoint: base, apiKey: apiKey || undefined, serviceId,
    teamId: ids.teamId, agentId: ids.agentId, userId: ids.userId,
    sessionId: sessionId || undefined,
    timeout: 8_000,
  })
  clientCache = { key, client }
  return client
}

export function isConfigured(): boolean {
  return !!endpoint()
}

export async function status(): Promise<AgentMemoryStatus> {
  const base = endpoint()
  if (!base) return { configured: false, reachable: false }
  try {
    const url = `${base.replace(/\/$/, '')}/health`
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`)
    return { configured: true, reachable: true, endpoint: base }
  } catch (error) {
    return { configured: true, reachable: false, endpoint: base, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function capture(sessionId: string, messages: AgentMemoryCaptureMessage[], workingDir?: string): Promise<void> {
  if (!sessionId || messages.length === 0) return
  const client = await getClient(workingDir, sessionId)
  if (!client) return
  const clean = messages.filter((m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && m.content.trim())
  if (clean.length === 0) return
  await client.addConversation({ messages: clean })
}

export async function search(query: string, workingDir?: string, sessionId?: string): Promise<Array<{ content: string; type?: string; score?: number }>> {
  const client = await getClient(workingDir, sessionId)
  if (!client || !query.trim()) return []
  const result = await client.searchAtomic({ query: query.slice(0, 500), limit: 8 })
  return result.items.map((item: { content: string; type?: string; score?: number }) => ({ content: item.content, type: item.type, score: item.score }))
}

export async function context(workingDir?: string): Promise<{ core: string; scenarios: Array<{ path: string; summary?: string; content: string }> }> {
  const client = await getClient(workingDir)
  if (!client) return { core: '', scenarios: [] }
  const [core, listed] = await Promise.all([client.readCore(), client.listScenarios()])
  const scenarios = await Promise.all(listed.entries.slice(0, 8).map(async (entry: { path: string; summary?: string }) => {
    const file = await client.readScenario({ path: entry.path })
    return { path: entry.path, summary: entry.summary, content: file.content || '' }
  }))
  return { core: core.content || '', scenarios }
}

export async function saveMemory(scope: 'user' | 'project', slug: string, content: string, workingDir?: string): Promise<void> {
  const client = await getClient(scope === 'project' ? workingDir : undefined)
  if (!client) return
  const safeScope = scope === 'project' ? 'project' : 'user'
  const safeSlug = slug.replace(/[^A-Za-z0-9._-]/g, '_')
  await client.writeScenario({ path: 'clerkbox/' + safeScope + '/' + safeSlug + '.md', content, summary: 'ClerkBox ' + safeScope + ' memory: ' + safeSlug })
}

export async function migrate(workingDir: string, files: Array<{ filename: string; content: string }>): Promise<AgentMemoryMigrationResult> {
  const client = await getClient(workingDir)
  if (!client) return { ok: false, imported: 0, skipped: 0, failed: 0, source: 'none', error: 'TDAI_MEMORY_ENDPOINT 未配置' }
  let imported = 0
  let skipped = 0
  let failed = 0
  let existing = new Set<string>()
  try {
    const listed = await client.listScenarios({ path_prefix: 'legacy/' })
    existing = new Set(listed.entries.map((entry: { path: string }) => entry.path))
  } catch {
    // Listing failure does not block migration; deterministic writes remain safe.
  }
  for (const file of files) {
    if (!file.filename || !file.content) { skipped++; continue }
    try {
      const safeName = file.filename.replace(/[^A-Za-z0-9._-]/g, '_')
      const scenarioPath = 'legacy/' + safeName
      if (existing.has(scenarioPath)) { skipped++; continue }
      await client.writeScenario({ path: scenarioPath, content: file.content, summary: 'ClerkBox legacy memory: ' + file.filename })
      imported++
    } catch {
      failed++
    }
  }
  return { ok: failed === 0, imported, skipped, failed, source: 'local' }
}

export async function readLocalMemoryFiles(workingDir: string): Promise<Array<{ filename: string; content: string }>> {
  const dir = path.join(workingDir, '.clerkbox', 'memory')
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => ({ filename: e.name, content: fs.readFileSync(path.join(dir, e.name), 'utf8') }))
  } catch {
    return []
  }
}
