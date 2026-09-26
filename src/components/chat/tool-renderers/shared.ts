/** 工具结果解析与展示格式化（渲染器与 MessageItem 共用，避免同一份解析逻辑两处漂移） */

/** 工具结果尾部的 __EDIT_DIFF__ 元数据（write_file / search_replace 附加，供 UI 展示差异） */
export interface EditDiffMetaView {
  path: string
  added: number
  removed: number
  lines: Array<{ text: string; tone: 'add' | 'del' | 'ctx' }>
}

const EDIT_DIFF_MARKER = '\n__EDIT_DIFF__:'

export function parseEditDiff(content: string): EditDiffMetaView | null {
  const idx = content.indexOf(EDIT_DIFF_MARKER)
  if (idx === -1) return null
  try {
    const raw = JSON.parse(content.slice(idx + EDIT_DIFF_MARKER.length)) as EditDiffMetaView
    if (typeof raw.path !== 'string' || !Array.isArray(raw.lines)) return null
    return { path: raw.path, added: raw.added || 0, removed: raw.removed || 0, lines: raw.lines.slice(0, 16) }
  } catch {
    return null
  }
}

export function stripEditDiff(content: string): string {
  const idx = content.indexOf(EDIT_DIFF_MARKER)
  return idx === -1 ? content : content.slice(0, idx)
}

/** execute_command 结果的尾部标记（tool-registry 追加）：退出码 / 超时 / 编码回退 */
export interface CommandResultMeta {
  exitCode: number | null
  timedOut: boolean
  encodingFallback: boolean
  stderr: string
  stdout: string
}

export function parseCommandResult(content: string): CommandResultMeta {
  const exitMatch = content.match(/\[Exit code:\s*(-?\d+)\]/)
  const stderrMatch = content.match(/\[STDERR\]([\s\S]*?)(?=\n\[Exit code:|\n\[Encoding:|\n\[Command timed out|$)/)
  let stdout = content
  if (stderrMatch) stdout = stdout.replace(`[STDERR]${stderrMatch[1]}`, '')
  for (const marker of [/\[Exit code:\s*-?\d+\]/, /\[Encoding: GBK→UTF-8\]/, /\[Command timed out[^\]]*\]/]) {
    stdout = stdout.replace(marker, '')
  }
  return {
    exitCode: exitMatch ? Number(exitMatch[1]) : null,
    timedOut: /\[Command timed out/.test(content),
    encodingFallback: /\[Encoding: GBK→UTF-8\]/.test(content),
    stderr: (stderrMatch?.[1] || '').trim(),
    stdout: stdout.trim(),
  }
}

/** read_file 结果是 `  12│ 内容` 的行号格式：取区间与正文（去掉行号前缀便于复制） */
export interface ReadResultMeta {
  lineCount: number
  startLine: number | null
  endLine: number | null
  lines: Array<{ no: number | null; text: string }>
  body: string
}

const READ_LINE_PATTERN = /^(\s*\d+)│(.*)$/

export function parseReadResult(content: string): ReadResultMeta {
  const rawLines = content.split('\n')
  const parsed: Array<{ no: number | null; text: string }> = []
  for (const line of rawLines) {
    const match = line.match(READ_LINE_PATTERN)
    if (match) parsed.push({ no: Number(match[1]), text: match[2] })
    else parsed.push({ no: null, text: line })
  }
  const numbered = parsed.filter((l): l is { no: number; text: string } => l.no !== null)
  return {
    lineCount: numbered.length,
    startLine: numbered.length ? Number(numbered[0].no) : null,
    endLine: numbered.length ? Number(numbered[numbered.length - 1].no) : null,
    lines: parsed,
    body: numbered.map((l) => l.text).join('\n') || content,
  }
}

/** web_search 结果块：`1. **标题**\n   摘要\n   URL` */
export interface SearchHit {
  index: number
  title: string
  snippet: string
  url: string
}

export function parseSearchResults(content: string): SearchHit[] {
  const blocks = content.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  const hits: SearchHit[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const titleMatch = lines[0].match(/^\d+\.\s*\*\*(.+?)\*\*$/)
    // 单块格式不符只跳过这一块：return 会让前面已解析出的结果全部作废
    if (!titleMatch) continue
    const urlLine = [...lines].reverse().find((l) => /^https?:\/\//.test(l)) || ''
    const snippet = lines
      .filter((l) => l !== lines[0] && l !== urlLine)
      .join(' ')
    hits.push({
      index: hits.length + 1,
      title: titleMatch[1],
      snippet,
      url: urlLine,
    })
  }
  return hits
}

/** mcp__<server>__<tool> 的名字拆解（渲染徽标用） */
export function splitMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return { server: rest, tool: '' }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

/** 正文预览行数上限（渲染器只展示头部，其余靠工具条展开后的滚动区） */
export const PREVIEW_LINE_LIMIT = 20

export function takeLines(text: string, limit = PREVIEW_LINE_LIMIT): { lines: string[]; hidden: number } {
  const lines = text.split('\n')
  if (lines.length <= limit) return { lines, hidden: 0 }
  return { lines: lines.slice(0, limit), hidden: lines.length - limit }
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export const fileBase = (p: string): string => p.split(/[\\/]/).pop() || p
