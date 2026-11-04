/**
 * 工具契约层（报告 03 P0-2 + 报告 05 P0-1 的轻量切片）。
 *
 * 两件事，刻意都做成「追加 / 可选」，不碰既有行为：
 *  1. **描述三要素**（When to use / When NOT / 失败语义）：ZCode 的工具描述
 *     每个都把「什么时候别用我」和「失败了怎么办」写清楚，模型才不会拿
 *     write_file 去做局部替换、或把 read_file 的报错当成空文件。这里只在
 *     default 模式的描述**尾部追加**三段，原文案一字不改（harness 兼容模式
 *     各有自己的简短哲学，一律不追加）。
 *  2. **结构化错误**：工具结果仍是单轨 string（全量双轨是后续大重构），
 *     但错误可以在文本尾巴带一个 `__TOOL_ERROR__` 负载，UI/审计侧能解析出
 *     code/message/retryable，模型看到的仍是可读的 `Error: ...` 原文。
 *     这是给双轨铺路的类型锚点，不是第二套返回通道。
 */
import type { ToolDefinition } from '../types/agent'

export type ToolErrorCode =
  | 'not_found' | 'permission_denied' | 'invalid_args' | 'io_error'
  | 'stale_content' | 'unknown_tool' | 'execution_failed' | 'aborted'

export interface ToolError {
  code: ToolErrorCode
  message: string
  /** 模型是否可以换个参数重试（false = 需要用户介入或改目标） */
  retryable?: boolean
}

/** 工具结果文本里的结构化错误负载前缀（UI 解析用，模型看到的是前面的可读文案） */
export const TOOL_ERROR_PREFIX = '__TOOL_ERROR__'

/** 在既有错误文案后附结构化负载；不改变调用方拿到的可读前缀 */
export function formatToolError(error: ToolError, readableText: string): string {
  return `${readableText}\n${TOOL_ERROR_PREFIX}${JSON.stringify(error)}`
}

export function parseToolError(content: string): ToolError | null {
  const at = content.lastIndexOf(TOOL_ERROR_PREFIX)
  if (at < 0) return null
  try {
    const raw = JSON.parse(content.slice(at + TOOL_ERROR_PREFIX.length)) as Partial<ToolError>
    if (!raw || typeof raw.code !== 'string' || typeof raw.message !== 'string') return null
    return { code: raw.code as ToolErrorCode, message: raw.message, retryable: raw.retryable === true }
  } catch {
    return null
  }
}

/** 三段式描述补全：只在明确列出的核心工具上追加，避免给所有工具灌模板话 */
export interface ToolDescriptionGuide {
  whenToUse: string
  whenNot: string
  onFailure: string
}

const GUIDES: Record<string, ToolDescriptionGuide> = {
  read_file: {
    whenToUse: 'When to use: reading a text file before editing, or paging through a large file.',
    whenNot: 'When NOT: binary/image files (use read_image), or when you already have the unchanged content in context.',
    onFailure: 'On failure: "cannot read file" means the path is wrong or unreadable — check the path; a stale-content refusal means re-read before editing.',
  },
  write_file: {
    whenToUse: 'When to use: creating a new file or a deliberate full rewrite.',
    whenNot: 'When NOT: targeted changes to existing files (use search_replace) — a full rewrite risks dropping content you did not re-read.',
    onFailure: 'On failure: "cannot write file" means permissions/path/disk — do not retry blindly; report the blocker.',
  },
  search_replace: {
    whenToUse: 'When to use: an exact, localized string replacement in a file you have just read.',
    whenNot: 'When NOT: creating a file, full rewrites, or regex/fuzzy matching — this is literal exact matching only.',
    onFailure: 'On failure: "old_str not found" or "multiple matches" means extend old_str with surrounding lines; "file changed" means re-read first.',
  },
  execute_command: {
    whenToUse: 'When to use: running a build, test, or CLI the dedicated file tools cannot express.',
    whenNot: 'When NOT: reading/searching/listing files (dedicated tools are cheaper and do not need shell quoting), or destructive commands without user approval.',
    onFailure: 'On failure: read the exit output for the real cause; do not re-run a failed destructive command.',
  },
  list_dir: {
    whenToUse: 'When to use: a single directory listing at a known path.',
    whenNot: 'When NOT: recursive pattern discovery (use search_files).',
    onFailure: 'On failure: the directory does not exist or is inaccessible — verify the path instead of guessing.',
  },
  search_files: {
    whenToUse: 'When to use: finding files by glob/path pattern across the workspace.',
    whenNot: 'When NOT: searching file *contents* (use search_content).',
    onFailure: 'On failure: no matches is a valid empty result, not an error — broaden the pattern deliberately.',
  },
  search_content: {
    whenToUse: 'When to use: regex search inside file contents, then read_file for context.',
    whenNot: 'When NOT: finding files by name (use search_files), or huge binary blobs.',
    onFailure: 'On failure: invalid regex or unreadable files — fix the pattern or narrow the scope.',
  },
  web_search: {
    whenToUse: 'When to use: current/external information you cannot get from the workspace.',
    whenNot: 'When NOT: questions answerable from local files or prior context.',
    onFailure: 'On failure: network/provider errors are transient — say so and continue with local evidence rather than inventing an answer.',
  },
  web_fetch: {
    whenToUse: 'When to use: reading one specific URL you already know.',
    whenNot: 'When NOT: open-ended discovery (use web_search first), or URLs the user did not sanction.',
    onFailure: 'On failure: blocked/offline URL — report it; do not fabricate the page content.',
  },
}

export const TOOL_GUIDE_NAMES = Object.freeze(Object.keys(GUIDES))

/**
 * 给 default 模式的工具描述追加三要素。返回**新数组 + 新对象**，
 * 不 mutate 注册表里的定义；未登记的工具原样返回。
 */
export function applyToolDescriptionGuides(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.map((def) => {
    const guide = GUIDES[def.name]
    if (!guide || def.description.includes('When NOT:')) return def
    const suffix = `\n\n${guide.whenToUse}\n${guide.whenNot}\n${guide.onFailure}`
    return { ...def, description: def.description + suffix }
  })
}

/** 供 ToolDefinition 的可选元数据：声明该工具可能产生哪些结构化错误码 */
export function toolErrorCodes(def: ToolDefinition): ToolErrorCode[] | undefined {
  return def.errorCodes
}
