/** Three-way field merge shared by local and paired clients. All writes use the host KV queue. */
export const REMOTE_SHARED_STATE_KEYS = new Set([
  'clerkbox-settings', 'clerkbox-skills', 'clerkbox-vibe', 'clerkbox-scheduled-tasks',
  'clerkbox-token-usage', 'clerkbox-account', 'clerkbox-joule',
  'clerkbox-goal-store', 'clerkbox-todo-store',
])
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const SECRET = /^(?:apiKey|accessToken|refreshToken|password|passphrase|clientSecret|secret|token|authorization)$/i
const META = /^(?:apiKeyConfigured|remoteSecretsConfigured)$/
function record(value: unknown): value is Record<string, Json> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function parse(raw: string | null): Json | undefined {
  if (raw === null) return undefined
  if (typeof raw !== 'string' || raw.length > 8 * 1024 * 1024) throw new Error('remote-invalid-state')
  const value = JSON.parse(raw, (key, item) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('remote-invalid-state')
    return item
  }) as Json
  if (!record(value) || !record(value.state)) throw new Error('remote-invalid-state')
  return value
}
function project(value: Json, parent = ''): Json {
  if (Array.isArray(value)) return value.map(item => project(item, parent))
  if (!record(value)) return value
  const result: Record<string, Json> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET.test(key) || parent === 'env' || parent === 'headers') result[key] = ''
    else result[key] = project(item, key)
  }
  if (typeof value.apiKey === 'string') result.apiKeyConfigured = value.apiKey.length > 0
  return result
}
/** A blank secret in a projected form means "unchanged", never "erase the host key". */
function preserveSecrets(current: Json | undefined, next: Json | undefined, parent = ''): Json | undefined {
  if (Array.isArray(next)) {
    return next.map((item, index) => {
      const old = Array.isArray(current)
        ? (record(item) && typeof item.id === 'string' ? current.find(entry => record(entry) && entry.id === item.id) : current[index])
        : undefined
      return preserveSecrets(old, item, parent) as Json
    })
  }
  if (!record(next)) return next
  const result: Record<string, Json> = {}
  for (const [key, value] of Object.entries(next)) {
    if (META.test(key)) continue
    const old = record(current) ? current[key] : undefined
    if ((SECRET.test(key) || parent === 'env' || parent === 'headers') && value === '' && old !== undefined) result[key] = old
    else result[key] = preserveSecrets(old, value, key) as Json
  }
  return result
}
function merge(current: Json | undefined, base: Json | undefined, value: Json | undefined): Json | undefined {
  if (same(base, value)) return current
  if (same(current, base) || same(current, value)) return value
  if (record(base) && record(value) && (current === undefined || record(current))) {
    const result: Record<string, Json> = { ...(current ?? {}) }
    for (const key of new Set([...Object.keys(base), ...Object.keys(value)])) {
      if (META.test(key)) continue
      const next = merge(record(current) ? current[key] : undefined, base[key], value[key])
      if (next === undefined) delete result[key]
      else result[key] = next
    }
    return result
  }
  // Arrays are atomic: concurrent edits are surfaced instead of losing tasks/providers/skills.
  throw new Error('remote-state-conflict')
}
export function projectRemoteState(name: string, raw: string | null): string | null {
  if (!REMOTE_SHARED_STATE_KEYS.has(name)) throw new Error('remote-forbidden-state')
  const value = parse(raw)
  return value === undefined ? null : JSON.stringify(project(value))
}
export function mergeRemoteState(name: string, currentRaw: string | null, baseRaw: string | null, valueRaw: string | null): string | null {
  if (!REMOTE_SHARED_STATE_KEYS.has(name)) throw new Error('remote-forbidden-state')
  const current = parse(currentRaw)
  const base = preserveSecrets(current, parse(baseRaw))
  const value = preserveSecrets(current, parse(valueRaw))
  const next = merge(current, base, value)
  return next === undefined ? null : JSON.stringify(next)
}
