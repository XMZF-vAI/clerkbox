import { ipc } from './ipc-client'
import { slugify } from './memory'
import type { ToolDefinition, MemoryEntry } from '../types/agent'
import type { McpToolInfo } from '../types/ipc'

// ── Static (builtin) tool definitions ──

const fileTools: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      '读取指定路径的文件内容，返回带行号的完整文本。先读文件再编辑，确保你对文件内容有准确了解。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_image',
    description:
      '读取图片文件的结构化信息：格式、像素尺寸、文件大小、主色调（前 5 种颜色及占比）。' +
      '用于了解图片的基本属性，而不是返回二进制乱码（read_file 读图片会得到乱码）。' +
      '注意：本工具不提供图片的视觉语义内容（如文字、物体识别）；若你支持图片输入，用户在消息里附带的图片会直接可见，无需调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '图片文件的绝对路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      '将完整内容写入文件。如果文件不存在则创建，存在则覆盖。非常适合创建新文件或需要大幅重写的场景。写入前会自动创建 .clerkbox-bak 备份。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
        content: { type: 'string', description: '要写入的完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search_replace',
    description:
      '在文件中搜索指定文本并替换。通过精确字符串匹配定位要修改的内容，无需数行号。\n' +
      '使用方法：\n' +
      '1. 先用 read_file 读取文件，找到需要修改的精确文本片段\n' +
      '2. 将原文本放入 old_str 参数（必须原样复制，不能改写）\n' +
      '3. 将修改后的文本放入 new_str 参数\n' +
      '重要约束：old_str 在整个文件中必须只出现一次（除非设 replace_all=true），否则工具会报错并列出所有匹配位置',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件的绝对路径',
        },
        old_str: {
          type: 'string',
          description:
            '要被替换的原始文本。必须是从文件中精确复制的文本，包括所有空格、缩进和换行。可以是一行或多行。',
        },
        new_str: {
          type: 'string',
          description:
            '替换后的新文本。如果设为空字符串则删除匹配内容。',
        },
        replace_all: {
          type: 'boolean',
          description:
            '是否替换文件中所有匹配位置。默认 false（必须唯一匹配），设为 true 可替换所有出现。',
        },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },
  {
    name: 'list_dir',
    description: '列出指定目录下的文件和子目录。返回每个条目的名称和类型。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录的绝对路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: '在指定目录下递归搜索匹配模式的文件。支持通配符，如 *.ts、*.json。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名匹配模式（如 *.ts、test*.json）' },
        path: { type: 'string', description: '搜索的根目录绝对路径' },
      },
      required: ['pattern', 'path'],
    },
  },
  {
    name: 'search_content',
    description: '在文件内容中搜索匹配正则表达式的文本行。返回匹配的文件、行号和内容。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的正则表达式模式' },
        path: { type: 'string', description: '搜索的目录绝对路径' },
        filePattern: { type: 'string', description: '文件名过滤模式（如 *.ts），可选' },
      },
      required: ['pattern', 'path'],
    },
  },
]

const shellTools: ToolDefinition[] = [
  {
    name: 'execute_command',
    description: '在终端执行命令。Windows 下默认使用 cmd.exe（避免 PowerShell 特殊字符问题）。需要 PowerShell 特性时可选 shell=powershell。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选），默认为当前项目目录' },
        shell: { type: 'string', description: 'Shell 类型：cmd（默认）或 powershell。简单命令用 cmd，需要 PowerShell cmdlet 时用 powershell', enum: ['cmd', 'powershell'] },
      },
      required: ['command'],
    },
  },
]

const webTools: ToolDefinition[] = [
  {
    name: 'web_search',
    description: '搜索互联网，返回相关结果列表。适合查询实时信息、新闻、资料等。不需要知道某信息时不要调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回结果数量，默认 5，最大 10' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: '访问指定 URL 的网页，提取并返回页面的文本内容。适合读取网页文章、文档、API 响应等。会自动将 HTML 转为可读文本。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要访问的网页 URL（必须以 http:// 或 https:// 开头）' },
        maxLength: { type: 'number', description: '返回内容的最大字符数，默认 30000' },
      },
      required: ['url'],
    },
  },
]

const memoryTools: ToolDefinition[] = [
  {
    name: 'save_memory',
    description:
      '保存一条结构化记忆到 .clerkbox/memory/ 目录。会自动生成 frontmatter 并更新 MEMORY.md 索引。用于记录用户偏好、反馈、项目决策、外部引用等持久信息。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '记忆名称（中文或英文，会被 slug 化为文件名）' },
        type: { type: 'string', description: '记忆类型', enum: ['user', 'feedback', 'project', 'reference'] },
        description: { type: 'string', description: '一行简短描述（会写入 frontmatter 和 MEMORY.md 索引行）' },
        content: { type: 'string', description: '记忆的完整内容（markdown 格式）' },
        scope: { type: 'string', enum: ['user', 'project'], description: '记忆范围：user=全局（跨所有会话共享，默认），project=当前工作目录。用户身份/偏好/反馈用 user，项目决策用 project。' },
      },
      required: ['name', 'type', 'description', 'content'],
    },
  },
  {
    name: 'search_memory',
    description:
      '按关键词或类型检索 .clerkbox/memory/ 下的记忆文件。不传参数时返回所有记忆条目的列表。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（在 name/description/content 中匹配）' },
        type: { type: 'string', description: '按类型筛选', enum: ['user', 'feedback', 'project', 'reference'] },
      },
    },
  },
]

const agentTools: ToolDefinition[] = [
  {
    name: 'spawn_agent',
    description: '派生一个子 agent 执行独立子任务。子 agent 在隔离的上下文中工作，拥有独立的工具集和对话历史，完成后返回结果总结。支持并行派生多个子 agent（在一条消息中调用多次本工具）。',
    parameters: {
      type: 'object',
      properties: {
        agent_type: {
          type: 'string',
          description: '子 agent 类型。可用类型：explore（只读侦察）、general（通用任务），或自定义 agent 类型。'
        },
        prompt: {
          type: 'string',
          description: '给子 agent 的完整任务指令。应包含：任务目标、相关上下文、期望输出格式。子 agent 不会看到父对话历史，所有必要信息都要在此 prompt 中提供。'
        }
      },
      required: ['agent_type', 'prompt']
    }
  }
]

// ── Tool registry ──

export interface ToolContext {
  workingDir?: string
  homeDir?: string
  sessionId?: string
  readFileState?: Map<string, { content: string; timestamp: number }>
  spawnSubAgent?: (agentType: string, prompt: string) => Promise<string>
}

/** Maximum characters to return from read_file */
const MAX_READ_LENGTH = 100000
/** Suffix for backup files created before writes */
const BACKUP_SUFFIX = '.clerkbox-bak'

/** Create a backup of a file before modification.
 *  Returns the backup path, or null if the file doesn't exist (no backup needed). */
async function backupFile(filePath: string): Promise<string | null> {
  try {
    const content = await ipc.readFile(filePath)
    const bakPath = filePath + BACKUP_SUFFIX
    await ipc.writeFile(bakPath, content)
    return bakPath
  } catch {
    return null // File doesn't exist yet, no backup needed
  }
}

/** Format file content with line numbers for AI readability */
function formatWithLineNumbers(content: string): string {
  // Normalize line endings to LF for consistent display
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  // Remove trailing empty entry if file ends with newline
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const maxLineNum = lines.length
  const padding = String(maxLineNum).length
  // Only show line numbers for reasonable-size files (<5000 lines)
  if (maxLineNum > 5000) {
    return content.slice(0, MAX_READ_LENGTH) +
      `\n\n... [文件共 ${maxLineNum} 行，行号省略，已截断显示前 ${MAX_READ_LENGTH} 字符]`
  }
  const numbered = lines.map((line, i) => {
    const num = String(i + 1).padStart(padding, ' ')
    return `${num}│ ${line}`
  }).join('\n')
  if (numbered.length > MAX_READ_LENGTH) {
    return numbered.slice(0, MAX_READ_LENGTH) +
      `\n\n... [文件共 ${maxLineNum} 行，已截断显示前 ${MAX_READ_LENGTH} 字符]`
  }
  return numbered
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
  if (lineDiff > 0) return `(+${lineDiff} 行)`
  if (lineDiff < 0) return `(${lineDiff} 行)`
  if (oldContent !== newContent) return '(内容已变更)'
  return '(无变化)'
}

/** Escape a string for safe interpolation into PowerShell double-quoted strings.
 *  Prevents command injection via unescaped ", $, or backtick characters. */
function escapePS(s: string): string {
  return s.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"')
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
    this.builtinDefinitions = [...fileTools, ...shellTools, ...webTools, ...memoryTools, ...agentTools]
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

  /** Execute a tool by name */
  async execute(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
    switch (name) {
      case 'read_file': {
        const path = String(args.path)
        try {
          const raw = await ipc.readFile(path)
          const content = formatWithLineNumbers(raw)
          // Track read file for post-compaction restoration
          if (ctx?.readFileState) {
            ctx.readFileState.set(path, { content: raw, timestamp: Date.now() })
          }
          return content
        } catch (e) {
          return `Error: 无法读取文件 ${path} - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'read_image': {
        const path = String(args.path)
        try {
          return await analyzeImageFile(path)
        } catch (e) {
          return `Error: 无法读取图片 ${path} - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'write_file': {
        const path = String(args.path)
        const content = String(args.content)
        try {
          // 读取旧内容供 diff 元数据（新文件则为空串）
          let oldContent = ''
          try { oldContent = await ipc.readFile(path) } catch { /* 新文件 */ }
          // Auto-backup before overwriting
          const bakPath = await backupFile(path)
          await ipc.writeFile(path, content)
          const diffMeta = computeEditDiff(path, oldContent, content)
          const diffTail = `\n__EDIT_DIFF__:${JSON.stringify(diffMeta)}`
          if (bakPath) {
            return `✅ 文件已写入: ${path} (${content.length} 字符)\n📦 备份: ${bakPath}${diffTail}`
          }
          return `✅ 文件已创建: ${path} (${content.length} 字符)${diffTail}`
        } catch (e) {
          return `Error: 无法写入文件 ${path} - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'search_replace': {
        const path = String(args.path)
        const oldStr = String(args.old_str)
        const newStr = String(args.new_str)
        const replaceAll = args.replace_all === true

        if (oldStr.length === 0) {
          return 'Error: old_str 不能为空字符串。请提供要替换的确切文本。'
        }

        try {
          const original = await ipc.readFile(path)

          // Detect original line endings
          const hasCRLF = original.includes('\r\n')
          const originalLineEnding = hasCRLF ? '\r\n' : '\n'

          // ── Search step (with line-ending normalization) ──
          // Normalize both sides to LF for matching, since AI copies text
          // from read_file output which always uses LF.
          const normalizedOriginal = original.replace(/\r\n/g, '\n')
          const normalizedOld = oldStr.replace(/\r\n/g, '\n')
          const normalizedNew = newStr.replace(/\r\n/g, '\n')

          let startIdx = 0
          const matches: number[] = []
          while (true) {
            const idx = normalizedOriginal.indexOf(normalizedOld, startIdx)
            if (idx === -1) break
            matches.push(idx)
            startIdx = idx + normalizedOld.length
          }

          if (matches.length === 0) {
            // Not found — try with CRLF normalization the other way
            const normalizedOldCRLF = oldStr.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
            let crlfIdx = 0
            const crlfMatches: number[] = []
            while (true) {
              const idx = original.indexOf(normalizedOldCRLF, crlfIdx)
              if (idx === -1) break
              crlfMatches.push(idx)
              crlfIdx = idx + normalizedOldCRLF.length
            }

            if (crlfMatches.length > 0) {
              return `Error: 未找到要替换的文本（行尾符差异：文件使用 CRLF，但 old_str 使用的是 LF）。\n请重新用 read_file 读取文件，确保精确复制原文（包括不可见字符）。`
            }

            // Try to find similar text for debugging
            const firstLine = normalizedOld.split('\n')[0].trim()
            if (firstLine.length > 10) {
              // Search for the first non-empty line of old_str in the file
              const searchLines = normalizedOld.split('\n')
              const sigLine = searchLines.find(l => l.trim().length > 10)
              if (sigLine) {
                const idx = normalizedOriginal.indexOf(sigLine.trim())
                if (idx !== -1) {
                  // Show surrounding context
                  const ctxStart = Math.max(0, idx - 50)
                  const ctxEnd = Math.min(normalizedOriginal.length, idx + sigLine.length + 50)
                  const ctx = normalizedOriginal.slice(ctxStart, ctxEnd)
                  return `Error: 未找到精确匹配的文本，但找到了相似行。old_str 可能与原文有差异（空格、缩进、换行符）。\n\n文件中相似位置的内容：\n\`\`\`\n...${ctx}...\n\`\`\`\n\n请用 read_file 重新读取文件，确保 old_str 是精确复制的内容。`
                }
              }
            }
            return `Error: 在文件中未找到 old_str 指定的文本。可能原因：\n1. 文件已被修改\n2. 空格/缩进/换行符不匹配\n3. 文本中包含了不可见字符\n\n请用 read_file 重新读取文件，精确复制需要替换的文本（不要手动改写）。`
          }

          if (!replaceAll && matches.length > 1) {
            // Multiple matches — ask for specificity
            const lines = normalizedOriginal.split('\n')
            const contexts = matches.slice(0, 3).map((idx, i) => {
              // Find line number
              let lineNum = 1
              let charCount = 0
              for (let li = 0; li < lines.length; li++) {
                if (charCount + lines[li].length + 1 > idx) {
                  lineNum = li + 1
                  break
                }
                charCount += lines[li].length + 1
              }
              const preview = normalizedOld.slice(0, 80).replace(/\n/g, '↵')
              return `  匹配 #${i + 1}: 第 ${lineNum} 行 → "${preview}${normalizedOld.length > 80 ? '...' : ''}"`
            }).join('\n')

            const suggestion = matches.length > 3
              ? `\n（共 ${matches.length} 处匹配，上面仅显示前 3 处）`
              : ''

            return `Error: old_str 在文件中匹配到 ${matches.length} 处（超过 1 处）。请使用更长的上下文使匹配唯一。\n` +
              `匹配位置：\n${contexts}${suggestion}\n\n` +
              `提示：在你的 old_str 中多包含几行上下文（前后各加 2-3 行），确保整个字符串在文件中只出现一次。`
          }

          // ── Replace step ──
          const bakPath = await backupFile(path)
          let result: string
          if (replaceAll) {
            // Replace all occurrences (need to handle overlapping matches carefully)
            // Use a simple global replace on normalized content
            // Escape special regex characters in oldStr
            const escaped = normalizedOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            result = normalizedOriginal.replace(new RegExp(escaped, 'g'), () => normalizedNew)
          } else {
            // Single replacement at exact position
            result = normalizedOriginal.slice(0, matches[0]) +
              normalizedNew +
              normalizedOriginal.slice(matches[0] + normalizedOld.length)
          }

          // Write the result, preserving original line endings
          const finalResult = hasCRLF
            ? result.replace(/\n/g, '\r\n')
            : result
          await ipc.writeFile(path, finalResult)

          const diff = generateDiff(normalizedOriginal, result)
          const matchCount = replaceAll ? matches.length : 1
          const diffMeta = computeEditDiff(path, normalizedOriginal, result)
          return `✅ 文件已编辑: ${path} ${diff}\n` +
            `📦 备份: ${bakPath}\n` +
            `替换了 ${matchCount} 处匹配` +
            `\n__EDIT_DIFF__:${JSON.stringify(diffMeta)}`
        } catch (e) {
          return `Error: 搜索替换失败 ${path} - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'list_dir': {
        const path = String(args.path)
        try {
          const entries = await ipc.listDir(path)
          if (entries.length === 0) {
            return '目录为空'
          }
          const dirs = entries.filter((e) => e.isDirectory).map((e) => `📁 ${e.name}/`)
          const files = entries.filter((e) => e.isFile).map((e) => `📄 ${e.name}`)
          return [...dirs, ...files].join('\n')
        } catch (e) {
          return `Error: 无法列出目录 ${path} - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'search_files': {
        const pattern = String(args.pattern)
        const path = String(args.path)
        const safePath = escapePS(path)
        const safePattern = escapePS(pattern)
        try {
          const result = await ipc.executeCommandWithShell(
            `Get-ChildItem -Path "${safePath}" -Filter "${safePattern}" -Recurse -File | Select-Object -First 50 FullName | Format-Table -HideTableHeaders`,
            path,
            'powershell'
          )
          if (result.exitCode !== 0) {
            return `Error: 搜索失败 - ${result.stderr}`
          }
          const files = result.stdout.trim()
          return files || `未找到匹配 "${pattern}" 的文件`
        } catch (e) {
          return `Error: 搜索文件失败 - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'search_content': {
        const pattern = String(args.pattern)
        const path = String(args.path)
        const filePattern = args.filePattern ? String(args.filePattern) : '*'
        const safePath = escapePS(path)
        const safePattern = escapePS(pattern)
        const safeFilePattern = escapePS(filePattern)
        try {
          const cmd = filePattern !== '*'
            ? `Get-ChildItem -Path "${safePath}" -Filter "${safeFilePattern}" -Recurse -File | Select-String -Pattern "${safePattern}" | Select-Object -First 30 | ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }`
            : `Select-String -Path "${safePath}\\*" -Pattern "${safePattern}" -Recurse | Select-Object -First 30 | ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim())" }`
          const result = await ipc.executeCommandWithShell(cmd, path, 'powershell')
          if (result.exitCode !== 0) {
            if (!result.stdout.trim() && !result.stderr.trim()) {
              return `未找到匹配 "${pattern}" 的内容`
            }
            if (!result.stdout.trim()) {
              return `Error: 搜索内容失败 - ${result.stderr}`
            }
          }
          const matches = result.stdout.trim()
          return matches || `未找到匹配 "${pattern}" 的内容`
        } catch (e) {
          return `Error: 搜索内容失败 - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'execute_command': {
        const command = String(args.command)
        const cwd = args.cwd ? String(args.cwd) : undefined
        const shellType = args.shell ? String(args.shell) : 'cmd'
        try {
          const result = await ipc.executeCommandWithShell(command, cwd, shellType, ctx?.sessionId)
          let output = ''
          if (result.stdout?.trim()) output += result.stdout.trim()
          if (result.stderr?.trim()) output += `\n[STDERR] ${result.stderr.trim()}`
          if (result.exitCode !== 0) output += `\n[退出码: ${result.exitCode}]`
          if (output.length > 50000) {
            output = output.slice(0, 50000) + '\n\n... [输出过长，已截断]'
          }
          if (result.encodingFallback) {
            output += '\n[编码: GBK→UTF-8]'
          }
          return output || '命令执行完成（无输出）'
        } catch (e) {
          return `Error: 命令执行失败 - ${e instanceof Error ? e.message : String(e)}`
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
            return `未找到 "${query}" 的搜索结果`
          }
          return result.map((r, i) =>
            `${i + 1}. **${r.title}**\n   ${r.snippet}\n   ${r.url}`
          ).join('\n\n')
        } catch (e) {
          return `Error: 搜索失败 - ${e instanceof Error ? e.message : String(e)}`
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
          return `Error: 访问网页失败 - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'save_memory': {
        const memName = String(args.name)
        const memType = String(args.type)
        const memDesc = String(args.description)
        const memContent = String(args.content)
        const scope = (args.scope as string) || 'user'
        if (!memName.trim() || memName.length > 200 || memDesc.length > 500 || memContent.length > 900_000) {
          return 'Error: 记忆名称、描述或内容长度无效'
        }
        if (!['user', 'project'].includes(scope)) {
          return 'Error: 记忆 scope 必须是 user 或 project'
        }
        if (!['user', 'feedback', 'project', 'reference'].includes(memType)) {
          return 'Error: 记忆 type 无效'
        }
        // 根据 scope 选择目标目录
        const targetDir = scope === 'project' ? ctx?.workingDir : ctx?.homeDir
        if (!targetDir) {
          return scope === 'project'
            ? 'Error: 未设置工作目录，无法保存项目级记忆'
            : 'Error: 未获取到用户主目录，无法保存全局记忆'
        }
        try {
          const slug = slugify(memName)
          const frontmatter = `name: ${memName}\ndescription: ${memDesc}\ntype: ${memType}`
          await ipc.writeMemoryFile(targetDir, slug, frontmatter, memContent)
          const entryLine = `- [${memName}](${slug}.md) — ${memDesc}`
          await ipc.updateMemoryIndex(targetDir, entryLine, slug)
          const scopeLabel = scope === 'project' ? '项目级' : '全局'
          return `✅ 记忆已保存: ${slug}.md\n类型: ${memType}\n范围: ${scopeLabel}\n索引已更新`
        } catch (e) {
          return `Error: 保存记忆失败 - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'search_memory': {
        const query = args.query ? String(args.query).slice(0, 200) : undefined
        const memType = args.type ? String(args.type) : undefined
        if (!ctx?.homeDir && !ctx?.workingDir) {
          return 'Error: 未设置工作目录和主目录，无法搜索记忆'
        }
        try {
          const results: Array<{ entry: MemoryEntry; scope: string }> = []
          // 搜索全局
          if (ctx.homeDir) {
            const globalEntries = await ipc.searchMemoryFiles(ctx.homeDir, query, memType)
            for (const entry of globalEntries) {
              results.push({ entry, scope: '🌐 全局' })
            }
          }
          // 搜索项目级（避免与全局重复）
          if (ctx.workingDir && ctx.workingDir !== ctx.homeDir) {
            const projectEntries = await ipc.searchMemoryFiles(ctx.workingDir, query, memType)
            for (const entry of projectEntries) {
              results.push({ entry, scope: '📁 项目' })
            }
          }
          if (results.length === 0) {
            return '未找到匹配的记忆'
          }
          return results.map(({ entry, scope }) =>
            `${scope} 📄 ${entry.filename}\n   类型: ${entry.type || '未分类'}\n   描述: ${entry.description || '无'}\n   内容片段: ${entry.content.slice(0, 200)}${entry.content.length > 200 ? '...' : ''}`
          ).join('\n\n')
        } catch (e) {
          return `Error: 搜索记忆失败 - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      case 'spawn_agent': {
        const agentType = String(args.agent_type)
        const subPrompt = String(args.prompt)
        if (!ctx?.spawnSubAgent) {
          return 'Error: 子 agent 派生功能未初始化'
        }
        try {
          const result = await ctx.spawnSubAgent(agentType, subPrompt)
          return result
        } catch (e) {
          return `Error: 子 agent 执行失败 - ${e instanceof Error ? e.message : String(e)}`
        }
      }
      default: {
        // MCP 工具（mcp__<server>__<tool>）：转发到主进程 McpManager 执行
        if (name.startsWith('mcp__')) {
          try {
            const result = await ipc.mcpCallTool(name, args ?? {})
            return result.content
          } catch (e) {
            return `Error: MCP 工具调用失败 ${name} - ${e instanceof Error ? e.message : String(e)}`
          }
        }
        return `Error: 未知工具 "${name}"`
      }
    }
  }
}

/** Singleton tool registry instance */
export const toolRegistry = new ToolRegistry()
