/**
 * 跨平台路径比较与安全判断工具。
 *
 * 从 use-agent.ts 抽出（原为内联 helper）：权限引擎（系统目录写入/工作目录边界）
 * 与 chat-store / ChatInput 的目录去重都依赖同一套「仅用于比较」的规范化规则，
 * 收敛到一处避免规则漂移。全部函数只做字符串运算，不做 IO。
 */

/** Normalize separators and dot segments for path-comparison only. */
export function normalizePathForComparison(value: string): string {
  const slashNormalized = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  const driveMatch = slashNormalized.match(/^[A-Za-z]:\//)
  const prefix = driveMatch ? driveMatch[0] : slashNormalized.startsWith('//') ? '//' : slashNormalized.startsWith('/') ? '/' : ''
  const remainder = prefix ? slashNormalized.slice(prefix.length) : slashNormalized
  const segments: string[] = []
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
      else if (!prefix) segments.push(segment)
      continue
    }
    segments.push(segment)
  }
  const normalized = `${prefix}${segments.join('/')}`
  return normalized.length > prefix.length ? normalized.replace(/\/$/, '') : normalized
}

/** Determine whether one normalized path is inside another across supported platforms. */
export function isPathInside(child: string, parent: string): boolean {
  if (!child || !parent) return false
  const normalizedChild = normalizePathForComparison(child)
  const normalizedParent = normalizePathForComparison(parent)
  const usesWindowsCaseRules = /^[A-Za-z]:\//.test(normalizedChild) ||
    /^[A-Za-z]:\//.test(normalizedParent) ||
    normalizedChild.startsWith('//') ||
    normalizedParent.startsWith('//')
  const a = usesWindowsCaseRules ? normalizedChild.toLowerCase() : normalizedChild
  const b = usesWindowsCaseRules ? normalizedParent.toLowerCase() : normalizedParent
  if (a === b) return true
  return a.startsWith(b.endsWith('/') ? b : `${b}/`)
}

/** Recognize absolute Windows, UNC, and POSIX paths before resolving tool input. */
export function isAbsolutePath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/.test(value)
}

/** Protect platform directories regardless of slash style or letter casing. */
export function isSystemPath(value: string): boolean {
  const normalized = normalizePathForComparison(value).toLowerCase()
  return normalized === '/etc' || normalized.startsWith('/etc/') ||
    normalized === 'c:/windows' || normalized.startsWith('c:/windows/') ||
    normalized === 'c:/program files' || normalized.startsWith('c:/program files/')
}

/** Resolve a tool input path against the session working directory. */
export function resolveToolPath(workingDir: string, input: unknown): string {
  const requested = String(input || '')
  if (!workingDir || isAbsolutePath(requested)) return requested
  const separator = workingDir.includes('\\') ? '\\' : '/'
  return `${workingDir}${separator}${requested}`
}

/** Join a base directory with relative segments, following the base's separator style (no IO). */
export function joinPath(base: string, ...segments: string[]): string {
  const separator = base.includes('\\') ? '\\' : '/'
  const cleaned = segments
    .flatMap((s) => String(s).split(/[\\/]+/))
    .filter((s) => s && s !== '.')
  return cleaned.length ? `${base.replace(/[\\/]+$/, '')}${separator}${cleaned.join(separator)}` : base
}

/**
 * 目录去重用的可比形式：统一分隔符、去尾斜杠；Windows 盘符/UNC 路径
 * 额外转小写（Windows 文件系统大小写不敏感），POSIX 路径保持大小写敏感。
 */
export function comparableFolderPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}
