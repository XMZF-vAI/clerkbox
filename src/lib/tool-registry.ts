import { ipc } from './ipc-client'
import { slugify } from './memory'
import { HARNESS_MODE_CONTENT } from './harness-modes'
import type { ToolDefinition, MemoryEntry, TodoItem, UserQuestion, ReadFileSnapshot, HarnessMode } from '../types/agent'
import type { McpToolInfo } from '../types/ipc'

// ── Shared limits（与工具描述中的数值严格一致，改动时两处同步）──

/** read_file：单次最多返回的行数（也是默认值） */
const MAX_READ_LINES = 2000
/** read_file：单次最多返回的字节数 */
const MAX_READ_BYTES = 50 * 1024
/** read_file：单行超过此长度被截断 */
const MAX_READ_LINE_CHARS = 2000
/** execute_command：返回给模型的输出上限（超出转存临时文件） */
const MAX_COMMAND_OUTPUT_CHARS = 50_000
/** execute_command：默认/最大超时（毫秒），与 main.ts 的钳制一致 */
const COMMAND_DEFAULT_TIMEOUT_MS = 120_000
const COMMAND_MAX_TIMEOUT_MS = 600_000
/** 搜索工具：返回的匹配/文件条目上限 */
const SEARCH_MAX_ENTRIES = 100
/** 搜索工具：单行输出截断长度 */
const SEARCH_MAX_LINE_CHARS = 500

// ── Static (builtin) tool definitions ──

const fileTools: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read a text file from the local filesystem, returned with line numbers (format: "N│ content" — never include the "N│ " prefix when editing).\n' +
      'Usage:\n' +
      '- By default returns up to 2000 lines starting from line 1, capped at 50KB per call.\n' +
      '- Use offset (1-indexed line number) and limit to read later sections of large files. When the result ends with "(Showing lines X-Y of N. Use offset=Z to continue.)", call again with the given offset to keep reading.\n' +
      '- Read a file before editing it, so your search_replace old_str matches the real content exactly.\n' +
      '- For images use read_image instead; this tool returns garbled bytes for binary files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed). Only provide when the file is too large to read at once.' },
        limit: { type: 'number', description: 'Maximum number of lines to read (default and max: 2000).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_image',
    description:
      'Read structured metadata of an image file: format, pixel dimensions, file size, and the top-5 dominant colors with percentages.\n' +
      'Note: this does NOT provide visual/semantic content (no OCR, no object recognition). It is for checking basic image properties, not for "looking at" the image. If you support image input, images the user attaches to a message are directly visible to you and you never need this tool for them.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the image file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write complete content to a file, creating it if it does not exist, overwriting if it does.\n' +
      'Usage:\n' +
      '- Use for creating new files or full rewrites. Prefer search_replace for modifying existing files.\n' +
      '- If the file already exists, read it with read_file first, then write the complete new content (no placeholders or omitted sections).\n' +
      '- NEVER create files unless they are necessary for the goal; never proactively create documentation (*.md) or README files unless asked.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'The complete content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search_replace',
    description:
      'Perform exact string replacement in a file. Supports a single edit (old_str/new_str) or a batch of edits in one call via edits[] (all matched against the same file content and applied atomically — if any edit fails, nothing is written).\n' +
      'Usage:\n' +
      '- You must read_file the file before editing. old_str must be copied character-for-character from the read output (everything AFTER the "N│ " line-number prefix, including all spaces and indentation), never paraphrased.\n' +
      '- old_str must appear exactly once in the file unless replace_all is true. If it matches multiple locations the tool errors — extend old_str with 2-3 surrounding lines to make it unique.\n' +
      '- When changing multiple separate locations in one file, prefer one call with edits[] over several sequential calls. Each entry is independent and must be unique on its own; entries must not overlap.\n' +
      '- Minor character mismatches are auto-corrected (curly vs straight quotes, non-breaking/full-width spaces, dash variants); the file keeps its original characters.\n' +
      '- new_str replaces old_str (empty string deletes the matched text). new_str must differ from old_str.\n' +
      '- The tool refuses to edit a file that changed on disk since your last read — re-read it first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        old_str: {
          type: 'string',
          description:
            'The exact text to replace, copied verbatim from the file. Must be unique in the file (or use replace_all). Can be one line or multiple lines. Ignored when edits[] is provided.',
        },
        new_str: {
          type: 'string',
          description: 'The replacement text. Set to empty string to delete the matched content. Ignored when edits[] is provided.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence of old_str (default false: old_str must match exactly once).',
        },
        edits: {
          type: 'array',
          description: 'Batch mode: multiple {old_str, new_str, replace_all?} entries applied to the same file atomically in one call (max 20). Takes precedence over the single old_str/new_str parameters.',
          items: {
            type: 'object',
            properties: {
              old_str: { type: 'string', description: 'Exact text to replace; must be unique in the file unless replace_all is true' },
              new_str: { type: 'string', description: 'Replacement text; empty string deletes' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence of this entry\'s old_str' },
            },
            required: ['old_str', 'new_str'],
          },
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List the files and subdirectories of a directory. Returns each entry with its type (dir/file).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the directory' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description:
      'Find files by glob pattern (e.g. *.ts, test*.json, **/*.spec.ts), recursively. Respects .gitignore when ripgrep is available. Returns up to 100 file paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'File name glob pattern (e.g. *.ts, test*.json)' },
        path: { type: 'string', description: 'Absolute path of the root directory to search' },
      },
      required: ['pattern', 'path'],
    },
  },
  {
    name: 'search_content',
    description:
      'Search file contents with a regular expression. Returns up to 100 matching lines as "path:line: text"; long lines are truncated to 500 chars.\n' +
      'Usage notes: pattern uses regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Use filePattern to filter files (e.g. *.ts). Use ignoreCase for case-insensitive matching. No matches returns a clear message.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        path: { type: 'string', description: 'Absolute path of the directory to search' },
        filePattern: { type: 'string', description: 'Optional file name glob filter (e.g. *.ts)' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default false)' },
      },
      required: ['pattern', 'path'],
    },
  },
]

const shellTools: ToolDefinition[] = [
  {
    name: 'execute_command',
    description:
      'Execute a command in the terminal. Windows defaults to cmd.exe (use shell=powershell for PowerShell cmdlets).\n' +
      'Usage:\n' +
      '- Prefer the dedicated tools instead of shell commands: read_file over cat/type, write_file/search_replace over echo/Set-Content/Out-File, search_files/search_content over find/Select-String. Reserve this tool for running programs, git, npm, package managers, and other system operations.\n' +
      '- Commands time out after 120000 ms by default; pass timeout (ms, max 600000) for long-running commands. On timeout the process tree is killed and the captured output is returned.\n' +
      '- Output over 50000 chars is truncated and the full output is saved to a file whose path is returned — use read_file with offset/limit to inspect it instead of re-running the command.\n' +
      '- cmd notes: quote paths containing spaces with double quotes; chain commands with &&; %% for a literal %. PowerShell notes: URLs containing & must be quoted; use single-quoted strings to avoid $ expansion.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to the current project directory)' },
        shell: { type: 'string', description: 'Shell type: cmd (default) or powershell. Use cmd for simple commands, powershell for cmdlets/object pipelines', enum: ['cmd', 'powershell'] },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000). The process tree is killed when it expires.' },
      },
      required: ['command'],
    },
  },
]

const webTools: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search the internet for real-time information, news, or documentation. Returns a list of results with title, snippet and URL (default 5, max 10). Do not call it for information you already know.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        count: { type: 'number', description: 'Number of results, default 5, max 10' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a URL and return the page as readable text (HTML converted). Content is capped (default 30000 chars, max 100000 via maxLength).\n' +
      'Usage: use for reading web articles, docs, or API responses found via web_search. Only http:// and https:// URLs are allowed.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch (must start with http:// or https://)' },
        maxLength: { type: 'number', description: 'Maximum characters to return, default 30000, max 100000' },
      },
      required: ['url'],
    },
  },
]

const memoryTools: ToolDefinition[] = [
  {
    name: 'save_memory',
    description:
      'Persist a structured memory note under .clerkbox/memory/ with frontmatter and an updated MEMORY.md index. Use for durable facts: user preferences, feedback, project decisions, external references.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Memory name (Chinese or English; slugified into the file name)' },
        type: { type: 'string', description: 'Memory type', enum: ['user', 'feedback', 'project', 'reference'] },
        description: { type: 'string', description: 'One-line summary (written to frontmatter and the MEMORY.md index line)' },
        content: { type: 'string', description: 'Full memory content (markdown)' },
        scope: { type: 'string', enum: ['user', 'project'], description: 'Memory scope: user=global (shared across sessions, default), project=current working directory. User identity/preferences/feedback → user; project decisions → project.' },
      },
      required: ['name', 'type', 'description', 'content'],
    },
  },
  {
    name: 'search_memory',
    description: 'Search memory notes by keyword or type. Without parameters, lists all memory entries.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (matched against name/description/content)' },
        type: { type: 'string', description: 'Filter by type', enum: ['user', 'feedback', 'project', 'reference'] },
      },
    },
  },
]

const agentTools: ToolDefinition[] = [
  {
    name: 'spawn_agent',
    description:
      'Spawn a sub-agent that executes an independent subtask in an isolated context with its own toolset and history, returning a result summary. Multiple spawn_agent calls in one message run in parallel.\n' +
      'Usage notes:\n' +
      '- Use for parallelizable independent research/queries, or to keep bulky exploration output out of the main context. Do NOT use for a single known file lookup — read_file/search directly is faster.\n' +
      '- Once work is delegated, do not duplicate it yourself: continue with other work or wait for the result.\n' +
      '- The sub-agent sees none of this conversation: put the task goal, relevant context (paths, constraints, what you already tried), and the expected output format entirely in the prompt. State whether it should only research or also write code.',
    parameters: {
      type: 'object',
      properties: {
        agent_type: {
          type: 'string',
          description: 'Sub-agent type. Available: explore (read-only reconnaissance), general (general tasks), or a custom agent type.',
        },
        prompt: {
          type: 'string',
          description: 'Complete task instructions for the sub-agent: goal, context, expected output format. It must be self-contained.',
        },
      },
      required: ['agent_type', 'prompt'],
    },
  },
]

const interactiveTools: ToolDefinition[] = [
  {
    name: 'question',
    description: 'Ask the user 1-3 short questions and wait for answers. Each question offers 2-3 mutually exclusive options (the user can also type a custom answer). Use only for key decisions or confirmations — never to request approval to continue working.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to show, at most 3.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable identifier for mapping answers (snake_case)' },
              header: { type: 'string', description: 'Short title, max 12 characters' },
              question: { type: 'string', description: 'The question in one sentence' },
              options: {
                type: 'array',
                description: '2-3 mutually exclusive options, each with label and description',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label', 'description'],
                },
              },
            },
            required: ['id', 'header', 'question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'todowrite',
    description:
      'Create or update the task list for the current task. Use proactively for multi-step work (3+ steps): capture the plan, mark exactly one item in_progress while working, and mark items completed immediately when done — do not batch completions. Skip it for single trivial tasks.\n' +
      'Each call must pass the complete current list.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The complete task list; every call replaces the previous list.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Task description (imperative form, e.g. "Run tests")' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              completed: { type: 'boolean', description: 'Legacy boolean: true means completed' },
            },
            required: ['text', 'status'],
          },
        },
      },
      required: ['items'],
    },
  },
]

// ── Tool registry ──

export interface ToolContext {
  workingDir?: string
  homeDir?: string
  sessionId?: string
  readFileState?: Map<string, ReadFileSnapshot>
  spawnSubAgent?: (agentType: string, prompt: string) => Promise<string>
  requestUserInput?: (questions: UserQuestion[]) => Promise<Record<string, string[]>>
  updateTodoList?: (items: TodoItem[]) => void
}

/** Escape a string for safe interpolation into PowerShell double-quoted strings.
 *  Prevents command injection via unescaped ", $, or backtick characters. */
function escapePS(s: string): string {
  return s.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"')
}

/** Escape a string for interpolation into a PowerShell single-quoted string (rg 调用用）。
 *  单引号字符串内唯一的特殊字符就是 ' 本身，双写即可转义。 */
function escapePSsingle(s: string): string {
  return s.replace(/'/g, "''")
}

// ── Ripgrep 探测（进程内缓存；不可用则搜索工具回退 PowerShell）──

let rgAvailable: boolean | null = null
async function detectRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable
  try {
    const r = await ipc.executeCommandWithShell('rg --version', undefined, 'cmd')
    rgAvailable = r.exitCode === 0
  } catch {
    rgAvailable = false
  }
  return rgAvailable
}

// ── 溢出转存：超出上限的输出写入 ~/.clerkbox/tmp/，把路径交还模型 ──

/** 把超大工具输出转存为文件，返回可读路径；失败返回 null（调用方退化为纯截断）。 */
async function spillOutputToTempFile(content: string, ctx: ToolContext | undefined, tag: string): Promise<string | null> {
  const home = ctx?.homeDir
  if (!home) return null
  const fileName = `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.log`
  const sep = home.includes('\\') ? '\\' : '/'
  const spillPath = `${home.replace(/[\\/]+$/, '')}${sep}.clerkbox${sep}tmp${sep}${fileName}`
  try {
    await ipc.writeFile(spillPath, content)
    return spillPath
  } catch {
    return null
  }
}

/** 文件不存在时，在同目录找名字相近的候选文件，生成 "Did you mean" 提示（减少模型的无效往返）。 */
async function suggestSimilarFiles(path: string): Promise<string> {
  try {
    const dirEnd = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
    if (dirEnd <= 0) return ''
    const dir = path.slice(0, dirEnd)
    const base = path.slice(dirEnd + 1)
    if (!base) return ''
    const entries = await ipc.listDir(dir)
    const lower = base.toLowerCase()
    const candidates = entries
      .map((e) => e.name)
      .filter((n) => n.toLowerCase() !== lower)
      .filter((n) => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase()))
      .slice(0, 3)
    if (candidates.length === 0) return ''
    const sep = path.includes('\\') ? '\\' : '/'
    return `\n\nDid you mean one of these?\n${candidates.map((c) => `- ${dir}${sep}${c}`).join('\n')}`
  } catch {
    return ''
  }
}

// ── search_replace 匹配辅助：三级回退定位 ──

/** Unicode 归一化折叠表（全部为 1:1 单字符映射，折叠后索引可直接映射回原串）。
 *  模型从 read_file 输出复制文本时经常把弯引号写成直引号、带进 NBSP/全角空格，
 *  或文件使用 en/em dash——精确匹配失败后用折叠空间重试，命中则按文件真实区间替换。 */
const CHAR_FOLDS: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/[\u00A0\u2007\u202F\u3000]/g, ' '],
  [/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-'],
]

function foldChars(s: string): string {
  let out = s
  for (const [re, rep] of CHAR_FOLDS) out = out.replace(re, rep)
  return out
}

/** 非重叠地找出 needle 在 haystack 中的所有出现区间。 */
function exactRanges(haystack: string, needle: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    ranges.push({ start: idx, end: idx + needle.length })
    from = idx + needle.length
  }
  return ranges
}

type LocateResult =
  | { kind: 'ok'; ranges: Array<{ start: number; end: number }>; fuzzy: boolean }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; count: number; firstStarts: number[] }

/** 把文本行尾统一为 LF（\r\n 与孤立的 \r 都归一，与 formatReadResult 的显示口径一致） */
function normalizeLf(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** 计算字符下标对应的行号（1-indexed），用于 ambiguous 错误的行号列表 */
function lineNumberOfIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * 在 content（LF 归一化文本）中定位 oldStr，两级回退：
 * 1. 精确匹配 → 2. Unicode 归一化折叠（弯引号/NBSP/dash 等隐形差异）。
 * （CRLF 差异无需单独一级：调用方已把两侧都归一为 LF，模型从剪贴板带回的
 *  \r\n 会在精确匹配阶段直接命中。）
 * replaceAll=false 时要求恰好一个匹配，多于一个返回 ambiguous（附前 3 处行号）。
 */
function locateEditRanges(content: string, oldStr: string, replaceAll: boolean): LocateResult {
  const pick = (ranges: Array<{ start: number; end: number }>, fuzzy: boolean): LocateResult => {
    if (!replaceAll && ranges.length > 1) {
      return { kind: 'ambiguous', count: ranges.length, firstStarts: ranges.slice(0, 3).map((r) => r.start) }
    }
    return { kind: 'ok', ranges: replaceAll ? ranges : [ranges[0]!], fuzzy }
  }
  const ranges = exactRanges(content, oldStr)
  if (ranges.length > 0) return pick(ranges, false)
  // 第 2 级：Unicode 归一化重试（1:1 字符映射，索引直接适用于原文）
  const folded = exactRanges(foldChars(content), foldChars(oldStr))
  if (folded.length > 0) return pick(folded, true)
  return { kind: 'not-found' }
}

/** Format file content with line numbers for AI readability（分页 + 50KB 上限 + 可行动的续读提示） */
function formatReadResult(raw: string, offset: number, limit: number, path: string): string {
  // Normalize line endings to LF for consistent display
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const allLines = normalized.split('\n')
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop()
  const total = allLines.length

  if (total === 0) {
    return '(Empty file)'
  }
  if (offset > total) {
    return `Error: offset ${offset} is beyond end of file (${total} lines total). Re-read with offset=${total > 0 ? total : 1} or without offset.`
  }

  const end = Math.min(offset - 1 + limit, total)
  const padding = String(total).length
  let out = ''
  let shown = 0
  for (let i = offset - 1; i < end; i++) {
    const original = allLines[i]
    const line = original.length > MAX_READ_LINE_CHARS
      ? original.slice(0, MAX_READ_LINE_CHARS) + `... (line truncated to ${MAX_READ_LINE_CHARS} chars)`
      : original
    const rendered = `${String(i + 1).padStart(padding, ' ')}│ ${line}\n`
    if (out.length + rendered.length > MAX_READ_BYTES) {
      if (shown === 0) {
        // 单行就超过 50KB：给模型一条可行动的抽取指引，而不是空手而归
        return `[Line ${offset} exceeds the 50KB display limit and cannot be shown. Extract it via execute_command, e.g. PowerShell: Get-Content "${path}" | Select-Object -Skip ${offset - 1} -First 1]`
      }
      break
    }
    out += rendered
    shown++
  }

  const lastShown = offset - 1 + shown
  if (lastShown < total) {
    out += `\n(Showing lines ${offset}-${lastShown} of ${total}. Use offset=${lastShown + 1} to continue.)`
  } else {
    out += `\n(End of file - total ${total} lines)`
  }
  return out
}

/** read_image 工具实现：读取图片元数据 + canvas 降采样统计主色调 */
async function analyzeImageFile(path: string): Promise<string> {
  const dataUrl = await ipc.readImageFileBase64(path)
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || 'unknown'
  const formatNames: Record<string, string> = {
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/gif': 'GIF',
    'image/webp': 'WebP',
    'image/bmp': 'BMP',
    'image/svg+xml': 'SVG',
  }
  const format = formatNames[mime] || mime

  // 文件大小从 base64 长度推算（避免 atob 整段解码大文件）
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const sizeBytes = Math.floor((b64.length * 3) / 4) - padding

  // 解码拿像素尺寸
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('图片解码失败（格式不支持或文件损坏）'))
    img.src = dataUrl
  })
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (w === 0 || h === 0) throw new Error('无法确定图片尺寸（SVG 未声明宽高？）')

  // 主色调：降采样到最多 64×64，逐像素按 32 级量化桶统计
  const SAMPLE = 64
  const scale = Math.min(1, SAMPLE / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale))
  const ch = Math.max(1, Math.round(h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建 canvas 上下文')
  ctx.drawImage(img, 0, 0, cw, ch)
  const data = ctx.getImageData(0, 0, cw, ch).data
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>()
  let opaque = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 32) continue // 跳过近透明像素
    opaque++
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const key = `${r >> 5}-${g >> 5}-${b >> 5}`
    const cur = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 }
    cur.count++
    cur.r += r
    cur.g += g
    cur.b += b
    buckets.set(key, cur)
  }
  const top = Array.from(buckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((v) => {
      const r = Math.round(v.r / v.count)
      const g = Math.round(v.g / v.count)
      const b = Math.round(v.b / v.count)
      const hex = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()
      return `${hex} ${((v.count / Math.max(1, opaque)) * 100).toFixed(0)}%`
    })

  const sizeStr = sizeBytes > 1024 * 1024
    ? `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`
    : `${(sizeBytes / 1024).toFixed(1)} KB`
  return [
    `📷 图片: ${path}`,
    `格式: ${format} · 尺寸: ${w}×${h}px · 大小: ${sizeStr}`,
    `主色调: ${top.length > 0 ? top.join(', ') : '(全透明)'}`,
  ].join('\n')
}

/**
 * Generate a unified diff between old and new content.
 * Returns a human-readable summary of the change.
 */
function generateDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const oldLen = oldLines.length
  const newLen = newLines.length
  const lineDiff = newLen - oldLen
  if (lineDiff > 0) return `(+${lineDiff} lines)`
  if (lineDiff < 0) return `(${lineDiff} lines)`
  if (oldContent !== newContent) return '(content changed)'
  return '(no change)'
}

// ── 编辑差异元数据（UI 渲染 file-diff chips 与悬停预览用）──

export interface EditDiffLine {
  text: string
  tone: 'add' | 'del' | 'ctx'
}

export interface EditDiffMeta {
  path: string
  added: number
  removed: number
  /** 供悬停预览的小样本行（上下文截断，超长折叠） */
  lines: EditDiffLine[]
}

const DIFF_CTX = 2
const DIFF_SIDE_CAP = 12

/**
 * 行级 diff：公共前缀/后缀压缩，中间整块替换。
 * write_file 整文件重写与 search_replace 局部修改都适用；
 * 只输出 UI 预览用的小样本（前后各 2 行 ctx，del/add 各至多 12 行），不追求补丁最小化。
 */
function computeEditDiff(path: string, oldText: string, newText: string): EditDiffMeta {
  const a = oldText.length === 0 ? [] : oldText.split('\n')
  const b = newText.length === 0 ? [] : newText.split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const removed = a.length - pre - suf
  const added = b.length - pre - suf

  const lines: EditDiffLine[] = []
  for (let i = Math.max(0, pre - DIFF_CTX); i < pre; i++) lines.push({ text: a[i], tone: 'ctx' })
  const delEnd = a.length - suf
  const addEnd = b.length - suf
  for (let i = pre; i < Math.min(delEnd, pre + DIFF_SIDE_CAP); i++) lines.push({ text: a[i], tone: 'del' })
  if (delEnd - pre > DIFF_SIDE_CAP) lines.push({ text: `… 共 ${delEnd - pre} 行删除`, tone: 'ctx' })
  for (let i = pre; i < Math.min(addEnd, pre + DIFF_SIDE_CAP); i++) lines.push({ text: b[i], tone: 'add' })
  if (addEnd - pre > DIFF_SIDE_CAP) lines.push({ text: `… 共 ${addEnd - pre} 行新增`, tone: 'ctx' })
  // 变更区之后紧邻的公共尾部 ctx（a 与 b 在该区间内容一致，取 a 即可）
  for (let i = delEnd; i < Math.min(a.length - suf, delEnd + DIFF_CTX); i++) lines.push({ text: a[i], tone: 'ctx' })

  return { path, added, removed, lines }
}

class ToolRegistry {
  private builtinDefinitions: ToolDefinition[]
  private mcpDefinitions: ToolDefinition[] = []

  constructor() {
    this.builtinDefinitions = [...fileTools, ...shellTools, ...webTools, ...memoryTools, ...agentTools, ...interactiveTools]
  }

  /** 注入当前已连接 MCP 服务器提供的工具（mcp-store 同步后调用） */
  setMcpTools(tools: McpToolInfo[]): void {
    this.mcpDefinitions = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  }

  /** Get all tool definitions */
  get definitions(): ToolDefinition[] {
    return [...this.builtinDefinitions, ...this.mcpDefinitions]
  }

  /**
   * 按会话锁定的 harness 模式取工具定义：兼容模式对内置工具做过滤/描述覆盖
   * （见 harness-modes.ts，工具名与实现不变）。MCP 工具默认保留；仅
   * dsh-minimal 例外——官方 minimal 组合不挂任何 MCP 插件，故一并裁剪。
   */
  getDefinitionsForMode(mode: HarnessMode): ToolDefinition[] {
    if (mode === 'default') return this.definitions
    const content = HARNESS_MODE_CONTENT[mode]
    const transform = content.transformTools
    const builtins = transform ? transform(this.builtinDefinitions) : this.builtinDefinitions
    return content.includeMcpTools === false ? builtins : [...builtins, ...this.mcpDefinitions]
  }

  /** Execute a tool by name */
  async execute(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
    switch (name) {
      case 'read_file': {
        const path = String(args.path)
        const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) > 0
          ? Math.floor(Number(args.offset))
          : 1
        const limit = Math.min(
          Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : MAX_READ_LINES,
          MAX_READ_LINES
        )
        try {
          const raw = await ipc.readFile(path)
          // Track read file for post-compaction restoration & edit-staleness checks
          if (ctx?.readFileState) {
            // 同文件同区间且内容未变 → 返回 stub 而非重发全文：
            // 早先的 read 结果仍在上下文中，重复发送浪费 token 并破坏前缀缓存
            const prev = ctx.readFileState.get(path)
            if (prev && prev.content === raw && prev.lastOffset === offset && prev.lastLimit === limit) {
              return 'File unchanged since the last read: the content from the earlier read_file result in this conversation is still current — refer to it instead of re-reading. (Use a different offset/limit if you need another range.)'
            }
            ctx.readFileState.set(path, { content: raw, timestamp: Date.now(), lastOffset: offset, lastLimit: limit })
          }
          return formatReadResult(raw, offset, limit, path)
        } catch (e) {
          const hint = await suggestSimilarFiles(path)
          return `Error: cannot read file ${path} - ${e instanceof Error ? e.message : String(e)}${hint}`
        }
      }
      case 'read_image': {
        const path = String(args.path)
        try {
          return await analyzeImageFile(path)
        } catch (e) {
          return `Error: cannot read image ${path} - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'write_file': {
        const path = String(args.path)
        const content = String(args.content)
        try {
          // 读取旧内容供 diff 元数据（新文件则为空串）
          let oldContent = ''
          try { oldContent = await ipc.readFile(path) } catch { /* 新文件 */ }
          await ipc.writeFile(path, content)
          // 写入后同步 read 快照：后续 search_replace 不会误判「文件已被外部修改」
          if (ctx?.readFileState) {
            ctx.readFileState.set(path, { content, timestamp: Date.now() })
          }
          const diffMeta = computeEditDiff(path, oldContent, content)
          const label = oldContent ? 'File written' : 'File created'
          return `✅ ${label}: ${path} (${content.length} chars) ${generateDiff(oldContent, content)}\n__EDIT_DIFF__:${JSON.stringify(diffMeta)}`
        } catch (e) {
          return `Error: cannot write file ${path} - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'search_replace': {
        const path = String(args.path)

        // ── 参数归一化：单次编辑（old_str/new_str）或批量编辑（edits[]，对同一份原始内容定位、原子应用）──
        interface EditOp { oldStr: string; newStr: string; replaceAll: boolean }
        const parseOp = (raw: unknown, label: string): EditOp | string => {
          if (!raw || typeof raw !== 'object') return `${label}: invalid edit entry`
          const o = raw as Record<string, unknown>
          if (typeof o.old_str !== 'string' || o.old_str.length === 0) {
            return `${label}: old_str must be a non-empty string (use write_file for an intentional full-file rewrite)`
          }
          if (typeof o.new_str !== 'string') return `${label}: new_str must be a string (use "" to delete the matched text)`
          if (o.old_str === o.new_str) return `${label}: old_str and new_str are exactly the same`
          return { oldStr: o.old_str, newStr: o.new_str, replaceAll: o.replace_all === true }
        }
        const ops: EditOp[] = []
        if (Array.isArray(args.edits)) {
          if (args.edits.length === 0) return 'Error: edits must contain at least one {old_str, new_str} entry'
          if (args.edits.length > 20) return 'Error: too many edits in one call (max 20)'
          for (const [i, item] of args.edits.entries()) {
            const op = parseOp(item, `edits[${i}]`)
            if (typeof op === 'string') return `Error: ${op}`
            ops.push(op)
          }
        } else {
          const op = parseOp(args, 'search_replace')
          if (typeof op === 'string') return `Error: ${op}`
          ops.push(op)
        }

        try {
          const rawOriginal = await ipc.readFile(path)

          // ── Staleness check：文件在上次 read_file 之后被外部改动则拒绝编辑 ──
          // 内容比对（而非 mtime）——Windows 上云同步/杀软会无内容变更地刷新 mtime。
          const snapshot = ctx?.readFileState?.get(path)
          if (snapshot && snapshot.content !== rawOriginal) {
            return 'Error: File has been modified since your last read (by the user or another process). Re-read the file with read_file before editing.'
          }

          // BOM：匹配前剥离，写回时原样保留（模型给的 old_str 永远不含隐形 BOM）
          const hadBom = rawOriginal.charCodeAt(0) === 0xFEFF
          const original = hadBom ? rawOriginal.slice(1) : rawOriginal

          // Detect original line endings; read_file 输出恒为 LF（\r\n 与孤立 \r 都归一），
          // 匹配统一在 LF 空间进行，与模型看到的显示口径一致
          const hasCRLF = original.includes('\r\n')
          const normalizedOriginal = normalizeLf(original)

          // ── 定位所有编辑：全部基于同一份原始内容（非增量），避免位置漂移 ──
          interface Located { start: number; end: number; newStr: string; fuzzy: boolean }
          const located: Located[] = []
          for (const [i, op] of ops.entries()) {
            const label = ops.length > 1 ? `edits[${i}]` : 'old_str'
            const loc = locateEditRanges(normalizedOriginal, normalizeLf(op.oldStr), op.replaceAll)
            if (loc.kind === 'ambiguous') {
              const preview = op.oldStr.slice(0, 80).replace(/\n/g, '↵')
              const lineNums = loc.firstStarts.map((s) => lineNumberOfIndex(normalizedOriginal, s)).join(', ')
              const more = loc.count > 3 ? `\n(${loc.count} matches in total, showing the first 3)` : ''
              return `Error: ${label} matches ${loc.count} locations (expected exactly 1). Make it unique.\n` +
                `Match lines: ${lineNums} → "${preview}${op.oldStr.length > 80 ? '...' : ''}"${more}\n\n` +
                `Tip: include 2-3 more surrounding lines in old_str so the string appears only once in the file, or set replace_all=true to replace every occurrence.`
            }
            if (loc.kind === 'not-found') {
              // 相似行提示：old_str 的某个非空行能在文件里找到 → 大概率是空白/不可见字符差异
              const searchLines = op.oldStr.split('\n')
              const sigLine = searchLines.find((l) => l.trim().length > 10)
              if (sigLine) {
                const idx = normalizedOriginal.indexOf(sigLine.trim())
                if (idx !== -1) {
                  const ctxStart = Math.max(0, idx - 50)
                  const ctxEnd = Math.min(normalizedOriginal.length, idx + sigLine.length + 50)
                  const nearby = normalizedOriginal.slice(ctxStart, ctxEnd)
                  return `Error: ${label} not found, but a similar line exists nearby — old_str likely differs in whitespace/indentation or quote style.\n\nNearby file content:\n\`\`\`\n...${nearby}...\n\`\`\`\n\nRe-read the file and make old_str an exact copy of the content.`
                }
              }
              return `Error: ${label} not found in file. Possible causes:\n1. The file was modified (re-read it)\n2. Whitespace/indentation/line-ending mismatch\n3. Invisible characters in the text\n\nRe-read the file with read_file and copy the text to replace exactly (do not paraphrase it).`
            }
            for (const r of loc.ranges) {
              located.push({ start: r.start, end: r.end, newStr: normalizeLf(op.newStr), fuzzy: loc.fuzzy })
            }
          }

          // 重叠检测：两个编辑命中同一区域会互相破坏语义，拒绝执行（原子性：一个不写盘）
          located.sort((a, b) => a.start - b.start)
          for (let i = 1; i < located.length; i++) {
            if (located[i]!.start < located[i - 1]!.end) {
              return 'Error: edits overlap in the file — merge them into a single edit or extend the surrounding context to separate them.'
            }
          }

          // ── 倒序应用（后面的编辑不影响前面编辑的位置）──
          let result = normalizedOriginal
          for (let i = located.length - 1; i >= 0; i--) {
            const m = located[i]!
            result = result.slice(0, m.start) + m.newStr + result.slice(m.end)
          }

          // 写回：恢复原行尾风格与 BOM
          const finalResult = (hadBom ? '\uFEFF' : '') + (hasCRLF ? result.replace(/\n/g, '\r\n') : result)
          await ipc.writeFile(path, finalResult)

          // 写入后同步 read 快照，保证连续编辑的过期检测基于最新内容
          if (ctx?.readFileState) {
            ctx.readFileState.set(path, { content: finalResult, timestamp: Date.now() })
          }

          const diff = generateDiff(normalizedOriginal, result)
          const diffMeta = computeEditDiff(path, normalizedOriginal, result)
          const fuzzyCount = located.filter((m) => m.fuzzy).length
          const fuzzyNote = fuzzyCount > 0
            ? ` (${fuzzyCount} matched via Unicode normalization — curly quotes/NBSP/dash differences were auto-corrected)`
            : ''
          return `✅ File edited: ${path} ${diff}\nApplied ${located.length} edit(s)${fuzzyNote}` +
            `\n__EDIT_DIFF__:${JSON.stringify(diffMeta)}`
        } catch (e) {
          const hint = await suggestSimilarFiles(path)
          return `Error: search_replace failed for ${path} - ${e instanceof Error ? e.message : String(e)}${hint}`
        }
      }
      case 'list_dir': {
        const path = String(args.path)
        try {
          const entries = await ipc.listDir(path)
          if (entries.length === 0) {
            return 'Directory is empty'
          }
          const dirs = entries.filter((e) => e.isDirectory).map((e) => `📁 ${e.name}/`)
          const files = entries.filter((e) => e.isFile).map((e) => `📄 ${e.name}`)
          return [...dirs, ...files].join('\n')
        } catch (e) {
          return `Error: cannot list directory ${path} - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'search_files': {
        const pattern = String(args.pattern)
        const path = String(args.path)
        try {
          // 优先 ripgrep（快、尊重 .gitignore）；不可用回退 PowerShell
          if (await detectRipgrep()) {
            const cmd = `rg --files '${escapePSsingle(path)}' --glob '${escapePSsingle(pattern)}' --hidden --no-messages`
            const result = await ipc.executeCommandWithShell(cmd, path, 'powershell')
            const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
            if (lines.length === 0) {
              return result.exitCode !== 0 && result.stderr.trim()
                ? `Error: file search failed - ${result.stderr.trim()}`
                : `No files matching "${pattern}" found`
            }
            const shown = lines.slice(0, SEARCH_MAX_ENTRIES)
            const tail = lines.length > SEARCH_MAX_ENTRIES
              ? `\n(${lines.length} files found, showing first ${SEARCH_MAX_ENTRIES}. Refine the pattern or path to narrow the results.)`
              : ''
            return shown.join('\n') + tail
          }
          const safePath = escapePS(path)
          const safePattern = escapePS(pattern)
          const result = await ipc.executeCommandWithShell(
            `Get-ChildItem -Path "${safePath}" -Filter "${safePattern}" -Recurse -File | Select-Object -First ${SEARCH_MAX_ENTRIES} FullName | Format-Table -HideTableHeaders`,
            path,
            'powershell'
          )
          if (result.exitCode !== 0) {
            return `Error: search failed - ${result.stderr}`
          }
          const files = result.stdout.trim()
          return files || `No files matching "${pattern}" found`
        } catch (e) {
          return `Error: file search failed - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'search_content': {
        const pattern = String(args.pattern)
        const path = String(args.path)
        const filePattern = args.filePattern ? String(args.filePattern) : ''
        const ignoreCase = args.ignoreCase === true
        try {
          // 优先 ripgrep（快、尊重 .gitignore、输出稳定）；不可用回退 PowerShell Select-String
          if (await detectRipgrep()) {
            const parts = ['rg --line-number --no-heading --color never --hidden --no-messages']
            if (ignoreCase) parts.push('-i')
            if (filePattern) parts.push(`--glob '${escapePSsingle(filePattern)}'`)
            parts.push(`-e '${escapePSsingle(pattern)}'`)
            parts.push(`'${escapePSsingle(path)}'`)
            const result = await ipc.executeCommandWithShell(parts.join(' '), path, 'powershell')
            const lines = result.stdout.split('\n').map((l) => (l.length > SEARCH_MAX_LINE_CHARS ? l.slice(0, SEARCH_MAX_LINE_CHARS) + '... [truncated]' : l)).filter((l) => l.trim())
            if (lines.length === 0) {
              return result.exitCode !== 0 && result.stderr.trim()
                ? `Error: content search failed - ${result.stderr.trim()}`
                : `No matches found for "${pattern}"`
            }
            const shown = lines.slice(0, SEARCH_MAX_ENTRIES)
            const tail = lines.length > SEARCH_MAX_ENTRIES
              ? `\n(${lines.length} matches, showing first ${SEARCH_MAX_ENTRIES}. Use a more specific pattern, path or filePattern.)`
              : ''
            return shown.join('\n') + tail
          }
          const safePath = escapePS(path)
          const safePattern = escapePS(pattern)
          const safeFilePattern = escapePS(filePattern || '*')
          const cmd = filePattern
            ? `Get-ChildItem -Path "${safePath}" -Filter "${safeFilePattern}" -Recurse -File | Select-String -Pattern "${safePattern}" | Select-Object -First 30 | ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }`
            : `Select-String -Path "${safePath}\\*" -Pattern "${safePattern}" -Recurse | Select-Object -First 30 | ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }`
          const result = await ipc.executeCommandWithShell(cmd, path, 'powershell')
          if (result.exitCode !== 0) {
            if (!result.stdout.trim() && !result.stderr.trim()) {
              return `No matches found for "${pattern}"`
            }
            if (!result.stdout.trim()) {
              return `Error: content search failed - ${result.stderr}`
            }
          }
          const matches = result.stdout.trim()
          return matches || `No matches found for "${pattern}"`
        } catch (e) {
          return `Error: content search failed - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'execute_command': {
        const command = String(args.command)
        const cwd = args.cwd ? String(args.cwd) : undefined
        const shellType = args.shell ? String(args.shell) : 'cmd'
        const timeoutMs = Math.min(
          Number.isFinite(Number(args.timeout)) && Number(args.timeout) > 0 ? Math.floor(Number(args.timeout)) : COMMAND_DEFAULT_TIMEOUT_MS,
          COMMAND_MAX_TIMEOUT_MS
        )
        try {
          const result = await ipc.executeCommandWithShell(command, cwd, shellType, ctx?.sessionId, timeoutMs)
          let output = ''
          if (result.stdout?.trim()) output += result.stdout.trim()
          if (result.stderr?.trim()) output += `\n[STDERR] ${result.stderr.trim()}`
          if (result.exitCode !== 0) output += `\n[Exit code: ${result.exitCode}]`
          if (result.encodingFallback) {
            output += '\n[Encoding: GBK→UTF-8]'
          }
          if (result.timedOut) {
            output += `\n[Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. If it legitimately needs longer, retry with a larger timeout value in ms (max ${COMMAND_MAX_TIMEOUT_MS}).]`
          }
          // 输出超限：全量转存临时文件，模型只看尾部（错误通常在末尾），并拿到文件路径
          if (output.length > MAX_COMMAND_OUTPUT_CHARS) {
            const spillPath = await spillOutputToTempFile(output, ctx, 'cmd-output')
            const tail = output.slice(-MAX_COMMAND_OUTPUT_CHARS)
            output = spillPath
              ? `[Output truncated: showing the last ~${MAX_COMMAND_OUTPUT_CHARS} chars. Full output saved to: ${spillPath} — use read_file with offset/limit to inspect it instead of re-running the command.]\n\n${tail}`
              : `${output.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n\n... [Output truncated at ${MAX_COMMAND_OUTPUT_CHARS} chars]`
          }
          return output || 'Command completed (no output)'
        } catch (e) {
          return `Error: command execution failed - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'web_search': {
        const query = String(args.query)
        const count = typeof args.count === 'number' ? Math.min(args.count, 10) : 5
        try {
          const result = await ipc.webSearch(query, count)
          if ('error' in result) {
            return `Error: ${result.error}`
          }
          if (!Array.isArray(result) || result.length === 0) {
            return `No search results found for "${query}"`
          }
          return result.map((r, i) =>
            `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`
          ).join('\n\n')
        } catch (e) {
          return `Error: search failed - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'web_fetch': {
        const url = String(args.url)
        const maxLength = typeof args.maxLength === 'number' ? args.maxLength : 30000
        try {
          const result = await ipc.webFetch(url, maxLength)
          if ('error' in result) {
            return `Error: ${result.error}`
          }
          return result.content
        } catch (e) {
          return `Error: cannot fetch webpage - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'save_memory': {
        const memName = String(args.name)
        const memType = String(args.type)
        const memDesc = String(args.description)
        const memContent = String(args.content)
        const scope = (args.scope as string) || 'user'
        if (!memName.trim() || memName.length > 200 || memDesc.length > 500 || memContent.length > 900_000) {
          return 'Error: invalid memory name, description or content length'
        }
        if (!['user', 'project'].includes(scope)) {
          return 'Error: memory scope must be user or project'
        }
        if (!['user', 'feedback', 'project', 'reference'].includes(memType)) {
          return 'Error: invalid memory type'
        }
        // 根据 scope 选择目标目录
        const targetDir = scope === 'project' ? ctx?.workingDir : ctx?.homeDir
        if (!targetDir) {
          return scope === 'project'
            ? 'Error: no working directory set; cannot save a project-scoped memory'
            : 'Error: user home directory unavailable; cannot save memory'
        }
        try {
          const slug = slugify(memName)
          const frontmatter = `name: ${memName}\ndescription: ${memDesc}\ntype: ${memType}`
          await ipc.writeMemoryFile(targetDir, slug, frontmatter, memContent)
          const entryLine = `- [${memName}](${slug}.md) — ${memDesc}`
          await ipc.updateMemoryIndex(targetDir, entryLine, slug)
          const scopeLabel = scope === 'project' ? 'project' : 'global'
          return `✅ Memory saved: ${slug}.md\nType: ${memType}\nScope: ${scopeLabel}\nIndex updated`
        } catch (e) {
          return `Error: failed to save memory - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'search_memory': {
        const query = args.query ? String(args.query).slice(0, 200) : undefined
        const memType = args.type ? String(args.type) : undefined
        if (!ctx?.homeDir && !ctx?.workingDir) {
          return 'Error: no working directory or home directory set; cannot search memory'
        }
        try {
          const results: Array<{ entry: MemoryEntry; scope: string }> = []
          // 搜索全局
          if (ctx.homeDir) {
            const globalEntries = await ipc.searchMemoryFiles(ctx.homeDir, query, memType)
            for (const entry of globalEntries) {
              results.push({ entry, scope: '🌐 global' })
            }
          }
          // 搜索项目级（避免与全局重复）
          if (ctx.workingDir && ctx.workingDir !== ctx.homeDir) {
            const projectEntries = await ipc.searchMemoryFiles(ctx.workingDir, query, memType)
            for (const entry of projectEntries) {
              results.push({ entry, scope: '📁 project' })
            }
          }
          if (results.length === 0) {
            return 'No matching memory found'
          }
          return results.map(({ entry, scope }) =>
            `${scope} 📄 ${entry.filename}\n   Type: ${entry.type || 'uncategorized'}\n   Description: ${entry.description || 'none'}\n   Excerpt: ${entry.content.slice(0, 200)}${entry.content.length > 200 ? '...' : ''}`
          ).join('\n\n')
        } catch (e) {
          return `Error: memory search failed - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'spawn_agent': {
        const agentType = String(args.agent_type)
        const subPrompt = String(args.prompt)
        if (!ctx?.spawnSubAgent) {
          return 'Error: sub-agent spawning is not initialized'
        }
        try {
          const result = await ctx.spawnSubAgent(agentType, subPrompt)
          return result
        } catch (e) {
          return `Error: sub-agent execution failed - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'question': {
        if (!ctx?.requestUserInput) return 'Error: question tool is not initialized'
        const raw = Array.isArray(args.questions) ? args.questions : []
        const questions = raw.slice(0, 3).flatMap((item): UserQuestion[] => {
          if (!item || typeof item !== 'object') return []
          const q = item as Record<string, unknown>
          const options = Array.isArray(q.options)
            ? q.options.flatMap((option): Array<{ label: string; description: string }> => {
                if (!option || typeof option !== 'object') return []
                const o = option as Record<string, unknown>
                return typeof o.label === 'string' ? [{ label: o.label, description: typeof o.description === 'string' ? o.description : '' }] : []
              }).slice(0, 3)
            : []
          if (typeof q.question !== 'string' || options.length === 0) return []
          return [{
            id: typeof q.id === 'string' && q.id ? q.id : `question_${Date.now()}`,
            header: typeof q.header === 'string' ? q.header.slice(0, 12) : 'Question',
            question: q.question,
            options,
          }]
        })
        if (questions.length === 0) return 'Error: question requires at least one question with options'
        try {
          const answers = await ctx.requestUserInput(questions)
          return JSON.stringify({ answers })
        } catch (e) {
          return `Error: question was cancelled - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'todowrite': {
        if (!ctx?.updateTodoList) return 'Error: todo tool is not initialized'
        const raw = Array.isArray(args.items) ? args.items : []
        const items = raw.flatMap((item): TodoItem[] => {
          if (!item || typeof item !== 'object') return []
          const value = item as Record<string, unknown>
          if (typeof value.text !== 'string' || !value.text.trim()) return []
          const status = value.completed === true || value.status === 'completed'
            ? 'completed'
            : value.status === 'in_progress' ? 'in_progress' : 'pending'
          return [{ text: value.text.trim(), status }]
        }).slice(0, 50)
        ctx.updateTodoList(items)
        return JSON.stringify({ items })
      }
      default: {
        // MCP 工具（mcp__<server>__<tool>）：转发到主进程 McpManager 执行
        if (name.startsWith('mcp__')) {
          try {
            const result = await ipc.mcpCallTool(name, args ?? {})
            return result.content
          } catch (e) {
            return `Error: MCP tool call failed ${name} - ${e instanceof Error ? e.message : String(e)}`
          }
        }
        return `Error: unknown tool "${name}"`
      }
    }
  }
}

/** Singleton tool registry instance */
export const toolRegistry = new ToolRegistry()
