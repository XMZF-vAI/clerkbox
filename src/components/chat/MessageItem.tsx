import { useState, useEffect, useRef, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Check, Terminal, FileText, FolderOpen, AlertTriangle, ChevronDown, ChevronUp, Wrench, FilePen, Globe, Pencil, Archive, Loader2, BookOpen, GitBranch, Target } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Message, StreamingToolCall } from '../../types/agent'
import { useChatStore } from '../../stores/chat-store'
import { SubAgentCard } from './SubAgentCard'

interface MessageItemProps {
  message: Message
  vibe?: boolean
  sessionId?: string
  /** 中间过程消息（非最终回复），隐藏时间戳和缓存统计 */
  isIntermediate?: boolean
}

/** Extract path and content from partial JSON args for write_file preview */
function extractWriteFileData(argsSoFar: string): { path: string; content: string } {
  // Try full parse first
  try {
    const parsed = JSON.parse(argsSoFar)
    return { path: parsed.path || '', content: parsed.content || '' }
  } catch { /* Partial JSON falls through to tolerant field extraction. */ }

  let path = ''
  let content = ''

  // Extract path with regex
  const pathMatch = argsSoFar.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (pathMatch) {
    try { path = JSON.parse('"' + pathMatch[1] + '"') } catch { path = pathMatch[1] }
  }

  // Extract content - find "content": " and take everything after
  const contentKey = argsSoFar.indexOf('"content"')
  if (contentKey !== -1) {
    const colonIdx = argsSoFar.indexOf(':', contentKey)
    const quoteIdx = argsSoFar.indexOf('"', colonIdx + 1)
    if (quoteIdx > colonIdx) {
      let raw = argsSoFar.slice(quoteIdx + 1)
      // Remove trailing incomplete escape sequences
      raw = raw.replace(/\\$/, '')
      // Unescape common JSON sequences
      content = raw
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"')
    }
  }

  return { path, content }
}

// ── 工具行渲染（紧凑行样式，参考 Tool Chips 设计）──

/** 工具结果尾部的 __EDIT_DIFF__ 元数据（write_file / search_replace 附加，供 UI 展示差异） */
interface EditDiffMetaView {
  path: string
  added: number
  removed: number
  lines: Array<{ text: string; tone: 'add' | 'del' | 'ctx' }>
}

function parseEditDiff(content: string): EditDiffMetaView | null {
  const idx = content.indexOf('\n__EDIT_DIFF__:')
  if (idx === -1) return null
  try {
    const raw = JSON.parse(content.slice(idx + '\n__EDIT_DIFF__:'.length)) as EditDiffMetaView
    if (typeof raw.path !== 'string' || !Array.isArray(raw.lines)) return null
    return { path: raw.path, added: raw.added || 0, removed: raw.removed || 0, lines: raw.lines.slice(0, 16) }
  } catch { return null }
}

function stripEditDiff(content: string): string {
  const idx = content.indexOf('\n__EDIT_DIFF__:')
  return idx === -1 ? content : content.slice(0, idx)
}

const fileBase = (p: string) => p.split(/[\\/]/).pop() || p

/** 从流式部分 JSON 中抽第一个出现的字符串字段值 */
function extractFirstStringField(argsSoFar: string, keys: string[]): string {
  for (const k of keys) {
    const m = argsSoFar.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    if (m) {
      try { return JSON.parse('"' + m[1] + '"') } catch { return m[1] }
    }
  }
  return ''
}

function toolRowIcon(name: string) {
  if (name === 'search_replace' || name === 'edit_file') return <Pencil size={13} />
  if (name === 'write_file') return <FilePen size={13} />
  if (name.includes('read') || name.includes('file')) return <FileText size={13} />
  if (name.includes('dir') || name.includes('list')) return <FolderOpen size={13} />
  if (name.includes('web') || (name.includes('search') && !name.includes('content'))) return <Globe size={13} />
  return <Terminal size={13} />
}

/** 行 chip 文本：读写类显示文件名，命令/搜索显示参数片段 */
function chipTextFor(name: string, args: Record<string, unknown>): string {
  if (name === 'write_file' || name === 'search_replace' || name === 'edit_file' ||
      name === 'read_file' || name === 'read_image' || name === 'list_dir') {
    return fileBase(String(args.path || ''))
  }
  if (name === 'execute_command') return String(args.command || '').slice(0, 80)
  if (name === 'search_files' || name === 'search_content') return String(args.pattern || '')
  if (name === 'web_search') return String(args.query || '')
  if (name === 'web_fetch') return String(args.url || '')
  const json = JSON.stringify(args)
  return json === '{}' ? '' : json.slice(0, 80)
}

/** 单个工具调用行：图标 + 动作标签 + 参数 chip；悬停露出 chevron，点击展开明细 */
function ToolRow({ toolCall, result, vibe }: {
  toolCall: NonNullable<Message['toolCalls']>[0]
  result?: Message['toolResults']
  vibe?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const toolResult = result?.find((r) => r.toolCallId === toolCall.id)
  const isError = toolResult?.isError ?? false
  const running = !toolResult
  const meta = toolResult && !isError ? parseEditDiff(toolResult.content) : null
  const detailLines = useMemo<Array<{ text: string; tone: 'add' | 'del' | 'ctx' }>>(() => {
    if (!toolResult) return []
    if (meta) return meta.lines
    return stripEditDiff(toolResult.content).split('\n')
      .filter((l) => l.trim()).slice(0, 5)
      .map((text) => ({ text, tone: 'ctx' as const }))
  }, [toolResult, meta])

  const label = toolCall.name === 'write_file'
    ? t('chat.toolRowWrite', { count: String(toolCall.arguments.content || '').split('\n').length })
    : t(`tools.${toolCall.name}`, { defaultValue: toolCall.name })
  const chip = chipTextFor(toolCall.name, toolCall.arguments)

  return (
    <div className="animate-fade-up">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`group/row flex h-7 w-full items-center gap-2 rounded-md3-xs px-1.5 text-left transition-colors duration-100 ${
          vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh/40'
        }`}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <span
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/row:opacity-0 ${open ? 'opacity-0' : 'opacity-100'} ${
              isError ? 'text-md-error' : running ? 'text-md-info' : vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/50'
            }`}
          >
            {isError ? <AlertTriangle size={13} /> : running ? <Loader2 size={13} className="animate-spin" /> : toolRowIcon(toolCall.name)}
          </span>
          <ChevronDown
            size={12}
            className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${
              open ? 'opacity-100' : 'opacity-0 -rotate-90'
            } ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/50'}`}
          />
        </span>
        <span className={`shrink-0 text-[12px] font-medium ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`}>{label}</span>
        <span className={`inline-flex h-5 min-w-0 flex-1 items-center truncate rounded-md3-xs px-1.5 font-mono text-[11px] ${
          vibe ? 'bg-white/[0.06] text-white/60' : 'bg-dark-surfaceContainer/60 text-dark-onSurfaceVariant/70'
        }`}>
          {chip || '…'}
        </span>
        {meta && meta.added > 0 && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-md-success">+{meta.added}</span>
        )}
        {meta && meta.removed > 0 && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-md-error">−{meta.removed}</span>
        )}
        {isError && <span className="shrink-0 text-[10px] text-md-error">{t('toolPreview.executionFailed')}</span>}
      </button>
      {/* 展开明细：grid-rows 折叠过渡 + 左边框缩进 */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' }}
      >
        <div className="min-h-0 overflow-hidden">
          {detailLines.length > 0 && (
            <div className={`mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l py-0.5 pl-3.5 ${
              vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'
            }`}>
              {detailLines.map((line, i) => (
                <span
                  key={i}
                  title={line.text}
                  className={`truncate font-mono text-[11px] leading-[1.6] ${
                    line.tone === 'add' ? 'text-md-success' : line.tone === 'del' ? 'text-md-error' : vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/60'
                  }`}
                >
                  {line.text}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 流式生成中的工具调用行：与完成态同款行样式，参数从部分 JSON 容错抽取 */
function StreamingToolRow({ call, vibe }: { call: StreamingToolCall; vibe?: boolean }) {
  const { t } = useTranslation()
  const raw = useMemo(() => {
    if (call.name === 'write_file') return extractWriteFileData(call.argsSoFar).path
    const v = extractFirstStringField(call.argsSoFar, ['path', 'command', 'query', 'url', 'pattern'])
    return v.length > 80 ? v.slice(0, 80) : v
  }, [call.name, call.argsSoFar])
  const isPathTool = call.name === 'write_file' || call.name === 'search_replace' ||
    call.name === 'read_file' || call.name === 'read_image' || call.name === 'list_dir'
  const chip = isPathTool ? fileBase(raw) : raw

  return (
    <div className="flex h-7 w-full items-center gap-2 rounded-md3-xs px-1.5 animate-fade-up">
      <span className={`flex size-4 shrink-0 items-center justify-center ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/60'}`}>
        <Loader2 size={13} className="animate-spin" />
      </span>
      <span className={`shrink-0 text-[12px] font-medium ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`}>
        {t(`tools.${call.name}`, { defaultValue: call.name })}
      </span>
      <span className={`inline-flex h-5 min-w-0 flex-1 items-center truncate rounded-md3-xs px-1.5 font-mono text-[11px] ${
        vibe ? 'bg-white/[0.06] text-white/60' : 'bg-dark-surfaceContainer/60 text-dark-onSurfaceVariant/70'
      }`}>
        {chip || t('toolPreview.parsing')}
      </span>
      <span className="ml-auto shrink-0 animate-pulse-soft text-[10px] text-md-info">{t('toolPreview.executing')}</span>
    </div>
  )
}

function StreamingToolRows({ calls, vibe }: { calls: StreamingToolCall[]; vibe?: boolean }) {
  if (!calls.length) return null
  return (
    <div className="mt-1 flex w-full flex-col gap-0.5">
      {calls.map((tc) => <StreamingToolRow key={tc.id} call={tc} vibe={vibe} />)}
    </div>
  )
}

/** 文件差异 chips：run 完成后聚合各文件增删行数，悬停弹出 diff 预览浮层。
 *  浮层经 portal 渲染到 body —— 消息列表容器带 transform，会重定义 fixed 坐标系。 */
function DiffChips({ metas, vibe }: { metas: EditDiffMetaView[]; vibe?: boolean }) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<{ meta: EditDiffMetaView; x: number; top?: number; bottom?: number } | null>(null)

  const openPreview = (meta: EditDiffMetaView) => (e: React.SyntheticEvent) => {
    const rect = (e.currentTarget as Element).getBoundingClientRect()
    const height = 30 + Math.min(meta.lines.length, 16) * 20
    const fitsBelow = rect.bottom + 6 + height <= window.innerHeight - 12
    setPreview({
      meta,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 320)),
      ...(fitsBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
    })
  }
  const closePreview = (path: string) => () =>
    setPreview((cur) => (cur?.meta.path === path ? null : cur))

  return (
    <div className={`mt-2 flex max-w-full flex-wrap gap-1.5 border-t pt-2 ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/[0.06]'}`}>
      {metas.map((m, i) => (
        <span key={m.path} className="relative" onMouseEnter={openPreview(m)} onMouseLeave={closePreview(m.path)}>
          <button
            type="button"
            aria-label={t('chat.diffPreviewLabel', { file: fileBase(m.path) })}
            className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-md3-xs px-2 font-mono text-[11px] transition-colors duration-100 animate-pop-in ${
              vibe
                ? 'bg-white/[0.08] text-white/85 hover:bg-white/15'
                : 'border border-dark-onSurfaceVariant/[0.06] bg-dark-surfaceContainer/60 text-dark-onSurface/85 hover:bg-dark-surfaceContainerHigh/60'
            }`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span className="min-w-0 truncate">{fileBase(m.path)}</span>
            {m.added > 0 && <span className="shrink-0 tabular-nums text-md-success">+{m.added}</span>}
            {m.removed > 0 && <span className="shrink-0 tabular-nums text-md-error">−{m.removed}</span>}
          </button>
        </span>
      ))}
      {preview && typeof document !== 'undefined' && createPortal(
        <div
          className={`fixed z-50 w-80 overflow-hidden rounded-md3-md border shadow-2xl ${
            vibe ? 'border-white/10 bg-white/10 backdrop-blur-xl' : 'border-dark-onSurfaceVariant/10 bg-dark-surfaceContainerHighest'
          }`}
          style={{
            left: preview.x,
            top: preview.top,
            bottom: preview.bottom,
            animation: 'popIn 160ms cubic-bezier(0.23,1,0.32,1) both',
            transformOrigin: preview.top === undefined ? 'bottom left' : 'top left',
          }}
        >
          <div className={`flex items-center justify-between border-b px-2.5 py-1.5 font-mono text-[11px] ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/[0.06]'}`}>
            <span className={`min-w-0 truncate ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/70'}`} title={preview.meta.path}>
              {fileBase(preview.meta.path)}
            </span>
            <span className="shrink-0 tabular-nums">
              {preview.meta.added > 0 && <span className="text-md-success"> +{preview.meta.added}</span>}
              {preview.meta.removed > 0 && <span className="text-md-error"> −{preview.meta.removed}</span>}
            </span>
          </div>
          <div className="py-1 font-mono text-[11px] leading-[1.8]">
            {preview.meta.lines.map((line, i) => (
              <div
                key={i}
                className={`flex gap-2 px-2.5 whitespace-pre ${
                  line.tone === 'add' ? 'bg-md-success/8 text-md-success'
                  : line.tone === 'del' ? 'bg-md-error/8 text-md-error'
                  : vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/60'
                }`}
              >
                <span className="w-3 shrink-0 select-none">{line.tone === 'add' ? '+' : line.tone === 'del' ? '−' : ' '}</span>
                <span className="min-w-0 truncate" title={line.text}>{line.text}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

/** 工具运行组：折叠头部「N 个工具调用」+ 紧凑行列表 + 差异 chips */
function ToolRunGroup({ toolCalls, toolResults, vibe, defaultOpen = false, finishReason }: {
  toolCalls: NonNullable<Message['toolCalls']>
  toolResults?: Message['toolResults']
  vibe?: boolean
  defaultOpen?: boolean
  /** 消息完成原因；流式过程中工具组默认展开，完成后自动收起 */
  finishReason?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(defaultOpen)

  // 流式过程中保持工具组展开，消息完成后自动收起
  useEffect(() => {
    if (defaultOpen && finishReason) {
      setOpen(false)
    }
  }, [finishReason, defaultOpen])
  const visible = toolCalls.filter((tc) => tc.name !== 'spawn_agent')
  const running = visible.some((tc) => !toolResults?.some((r) => r.toolCallId === tc.id))
  const diffMetas = useMemo(() => {
    const byPath = new Map<string, EditDiffMetaView>()
    for (const r of toolResults || []) {
      const meta = parseEditDiff(r.content)
      if (!meta || r.isError) continue
      const cur = byPath.get(meta.path)
      if (cur) {
        cur.added += meta.added
        cur.removed += meta.removed
        cur.lines = meta.lines
      } else {
        byPath.set(meta.path, { ...meta })
      }
    }
    return Array.from(byPath.values())
  }, [toolResults])

  if (visible.length === 0) return null

  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex w-fit items-center gap-1.5 rounded-md3-xs px-1.5 py-1 text-[12px] transition-colors duration-100 ${
          vibe ? 'text-white/60 hover:bg-white/10' : 'text-dark-onSurfaceVariant/60 hover:bg-dark-surfaceContainerHigh/40'
        }`}
      >
        <ChevronDown size={12} className={`transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
        <span className="tabular-nums">{t('chat.toolRunSummary', { count: visible.length })}</span>
        {running && <span className="size-1.5 animate-pulse-soft rounded-full bg-md-info" />}
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0, transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1 flex flex-col gap-0.5">
            {visible.map((tc) => (
              <ToolRow key={tc.id} toolCall={tc} result={toolResults} vibe={vibe} />
            ))}
          </div>
          {!running && diffMetas.length > 0 && <DiffChips metas={diffMetas} vibe={vibe} />}
        </div>
      </div>
    </div>
  )
}

interface ThinkingHeaderProps {
  thinkingContent: string
  isStreaming: boolean
  hasContent: boolean
  finishReason?: string
  expanded: boolean
  onToggle: () => void
  vibe?: boolean
}

/** Thinking header: shimmer while streaming, summary when done */
function ThinkingHeader({ thinkingContent, isStreaming, hasContent, finishReason, expanded, onToggle, vibe }: ThinkingHeaderProps) {
  const { t } = useTranslation()
  const startRef = useRef<number | null>(null)
  const endRef = useRef<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [done, setDone] = useState(false)

  // Start and stop the timer only when thinking content or stream state changes.
  useEffect(() => {
    if (!thinkingContent) {
      startRef.current = null
      endRef.current = null
      setElapsed(0)
      setDone(false)
      return
    }

    // Mark start when thinking content first appears
    if (startRef.current == null) {
      startRef.current = Date.now()
      setDone(false)
    }

    // Thinking is done when:
    // 1. Message has final content (reply started) → thinking phase ended
    // 2. finishReason present → entire message finished
    // 3. !isStreaming → stream ended
    if ((hasContent || finishReason || !isStreaming) && endRef.current == null) {
      endRef.current = Date.now()
      const secs = Math.max(1, Math.round((endRef.current - startRef.current) / 1000))
      setElapsed(secs)
      setDone(true)
    }
  }, [thinkingContent, isStreaming, hasContent, finishReason])

  // Keep the ticker independent so renders do not recreate its interval.
  useEffect(() => {
    if (done || startRef.current == null) return
    const id = setInterval(() => {
      if (startRef.current != null) {
        setElapsed(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)))
      }
    }, 500)
    return () => clearInterval(id)
  }, [done])

  const summaryText = !done
    ? t('chat.thinkingInProgress')
    : t('chat.thinkingDone', { count: elapsed })

  return (
    <div className="w-full mb-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 py-1 group"
      >
        <span
          className={`text-sm font-medium tracking-wide ${
            !done ? 'thinking-shimmer' : vibe ? 'text-white/70' : 'text-dark-onSurfaceVariant/60'
          }`}
        >
          {summaryText}
        </span>
        <span
          className={`transition-transform ${expanded ? 'rotate-180' : ''} ${
            vibe
              ? 'text-white/40 group-hover:text-white/60'
              : 'text-dark-onSurfaceVariant/30 group-hover:text-dark-onSurfaceVariant/50'
          }`}
        >
          <ChevronDown size={12} />
        </span>
      </button>
      {expanded && (
        <div
          className={`mt-1 p-3 rounded-md3-sm text-[12px] leading-relaxed whitespace-pre-wrap max-h-[300px] overflow-y-auto ${
            vibe
              ? 'liquid-glass-subtle border border-white/20 text-white/80'
              : 'bg-md-secondary/5 border border-md-secondary/10 text-dark-onSurfaceVariant/60'
          }`}
        >
          {thinkingContent}
        </div>
      )}
    </div>
  )
}

/** Full markdown renderer */
const MarkdownContent = memo(function MarkdownContent({ content, vibe }: { content: string; vibe?: boolean }) {
  const html = useMemo(() => renderMarkdown(content), [content])
  return <div className={`markdown-body${vibe ? ' md-vibe' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
})

function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeLang = ''
  let codeLines: string[] = []
  let inList = false
  let inOrderedList = false
  let inTable = false
  let tableRows: string[] = []

  const closeList = () => {
    if (inList) { result.push('</ul>'); inList = false }
    if (inOrderedList) { result.push('</ol>'); inOrderedList = false }
  }

  const closeTable = () => {
    if (!inTable) return
    // A table requires a header and a separator row to avoid dropping plain text.
    // 否则这不是合法 markdown 表格，回退为普通段落渲染，避免数据丢失。
    if (tableRows.length >= 2 && isTableSeparatorLine(tableRows[1])) {
      result.push('<table class="markdown-table"><thead><tr>')
      const headerCells = splitTableCells(tableRows[0])
      headerCells.forEach((cell) => {
        result.push(`<th>${inlineFormat(cell.trim())}</th>`)
      })
      result.push('</tr></thead><tbody>')
      for (let r = 2; r < tableRows.length; r++) {
        result.push('<tr>')
        splitTableCells(tableRows[r]).forEach((cell) => {
          result.push(`<td>${inlineFormat(cell.trim())}</td>`)
        })
        result.push('</tr>')
      }
      result.push('</tbody></table>')
    } else {
      // 回退为段落渲染
      tableRows.forEach((row) => {
        result.push(`<p>${inlineFormat(row)}</p>`)
      })
    }
    inTable = false
    tableRows = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      closeList()
      closeTable()
      if (inCodeBlock) {
        result.push(`<pre class="code-block"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        inCodeBlock = false
        codeLines = []
        codeLang = ''
        continue
      } else {
        inCodeBlock = true
        codeLang = line.trim().slice(3)
        codeLines = []
        continue
      }
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      closeList()
      closeTable()
      const level = headingMatch[1].length
      result.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`)
      continue
    }

    const ulMatch = line.match(/^[\s]*[-*+]\s+(.+)/)
    if (ulMatch) {
      closeTable()
      if (inOrderedList) { closeList() }
      if (!inList) { result.push('<ul>'); inList = true }
      result.push(`<li>${inlineFormat(ulMatch[1])}</li>`)
      continue
    }

    const olMatch = line.match(/^[\s]*\d+\.\s+(.+)/)
    if (olMatch) {
      closeTable()
      if (inList) { closeList() }
      if (!inOrderedList) { result.push('<ol>'); inOrderedList = true }
      result.push(`<li>${inlineFormat(olMatch[1])}</li>`)
      continue
    }

    if (/^[-*_]{3,}$/.test(line.trim())) {
      closeList()
      closeTable()
      result.push('<hr />')
      continue
    }

    const bqMatch = line.match(/^>\s*(.*)/)
    if (bqMatch) {
      closeList()
      closeTable()
      result.push(`<blockquote>${inlineFormat(bqMatch[1])}</blockquote>`)
      continue
    }

    if (isTableLine(line)) {
      closeList()
      if (!inTable) inTable = true
      tableRows.push(line)
      continue
    } else if (inTable) {
      closeTable()
    }

    if (line.trim() === '') {
      closeList()
      closeTable()
      continue
    }

    closeList()
    closeTable()
    result.push(`<p>${inlineFormat(line)}</p>`)
  }

  closeList()
  closeTable()
  if (inCodeBlock) {
    result.push(`<pre class="code-block"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  }

  return result.join('')
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return false
  // 至少有一个非空 cell（避免把单个 "|" 当表格）
  const cells = trimmed.split('|').filter((s) => s.trim() !== '')
  return cells.length >= 1
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return false
  // 去掉首尾的 | 后，所有 cell 必须只含 - / : / | / 空格，且至少有一个 - 字符
  const cells = trimmed.split('|').filter((s) => s.trim() !== '')
  if (cells.length === 0) return false
  return cells.every((c) => /^[-:|\s]+$/.test(c.trim()) && c.includes('-'))
}

function splitTableCells(line: string): string[] {
  return line
    .split('|')
    .map((s) => s.trim())
    .filter((s, i, arr) => {
      if (i === 0 || i === arr.length - 1) return s !== ''
      return true
    })
}

function inlineFormat(text: string): string {
  let html = escapeHtml(text)
  const protectedHtml: string[] = []
  const protect = (value: string) => {
    const index = protectedHtml.push(value) - 1
    return `\uE000${index}\uE000`
  }

  html = html.replace(/`([^`]+)`/g, (_match, code: string) => protect(`<code class="inline-code">${code}</code>`))
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const safeHref = sanitizeLinkHref(href)
    return protect(safeHref ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>` : label)
  })
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>')
  html = html.replace(/\uE000(\d+)\uE000/g, (_match, index: string) => protectedHtml[Number(index)] || '')
  return html
}

function sanitizeLinkHref(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || /[\u0000-\u001F\u007F\s]/.test(trimmed)) return null
  if (/[<>"']/.test(trimmed)) return null
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (/^(#|\/|\.\/|\.\.\/)/.test(trimmed)) return trimmed
  return null
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function MessageItem({ message, vibe = false, sessionId, isIntermediate = false }: MessageItemProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [collapsedExpanded, setCollapsedExpanded] = useState(false)
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const isUser = message.role === 'user'
  const isToolResult = message.role === 'tool'
  const isTruncated = message.finishReason === 'length'
  const hasThinking = !!message.thinkingContent && message.thinkingContent.length > 0
  const hasVisibleToolCalls = message.toolCalls?.some((tc) => tc.name !== 'spawn_agent') ?? false
  const cacheReadTokens = message.usage?.cache_read_input_tokens ?? 0
  const cacheCreatedTokens = message.usage?.cache_creation_input_tokens ?? 0
  const cacheEligibleTokens = cacheReadTokens + cacheCreatedTokens
  // OpenAI 兼容端点只报命中不报写入（creation=0），此时按 read/prompt 算真实命中率
  const cacheHitRate = cacheCreatedTokens > 0
    ? Math.round(cacheReadTokens / cacheEligibleTokens * 100)
    : message.usage?.prompt_tokens
      ? Math.round(cacheReadTokens / message.usage.prompt_tokens * 100)
      : 0

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy message:', error)
    }
  }

  // Compact boundary message — render as a divider card
  if (message.role === 'system' && message.isCompactSummary) {
    const meta = message.compactMetadata
    const timeStr = new Date(message.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return (
      <div className="flex justify-center animate-slide-up my-2">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md3-md text-[11px] ${
          vibe
            ? 'bg-white/10 border border-white/20 text-white/60'
            : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/8 text-dark-onSurfaceVariant/50'
        }`}>
          <Archive size={12} className="flex-shrink-0" />
          <span>{t('chat.contextCompressed')}{meta ? t('chat.contextCompressedMeta', { count: meta.messagesSummarized }) : ''}</span>
          <span className="opacity-60">{timeStr}</span>
        </div>
      </div>
    )
  }

  // Compact summary message — render as collapsible card with "摘要" label
  if (message.isCompactSummary && message.role !== 'system') {
    return (
      <div className="flex justify-center animate-slide-up my-1 min-w-0 overflow-hidden">
        <div className="w-full max-w-[90%] min-w-0">
          <button
            onClick={() => setSummaryExpanded(!summaryExpanded)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md3-sm text-[11px] transition-colors ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/60 hover:text-white/80 hover:bg-white/15'
                : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/8 text-dark-onSurfaceVariant/50 hover:text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainer/60'
            }`}
          >
            {summaryExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            <Archive size={11} />
            <span>{t('chat.compactSummary')}</span>
          </button>
          {summaryExpanded && (
            <div className={`mt-2 px-4 py-2.5 rounded-md3-md text-sm leading-relaxed min-w-0 break-words overflow-hidden [&_pre]:overflow-x-auto ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/90'
                : 'bg-dark-surfaceContainerHigh text-dark-onSurface'
            }`}>
              <MarkdownContent content={message.content} vibe={vibe} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // 压缩后恢复的文件消息（isCompactAttachment）—— 折叠卡片渲染，而非用户气泡。
  // 它是压缩机制自动注入的文件内容恢复（role 为 user 仅为满足 API 结构），
  // 不是用户真实发送的消息，不能渲染成绿色用户气泡。
  // 内容模式兜底：旧版本写入 DB 的文件恢复消息没有 isCompactAttachment 标记，按内容识别。
  if (message.isCompactAttachment || (message.role === 'user' && /^\[Previously read file: .+?\]\n```/.test(message.content))) {
    const fileMatch = message.content.match(/^\[Previously read file: (.+?)\]/m)
    const filePath = fileMatch?.[1] || ''
    return (
      <div className="flex justify-center animate-slide-up my-1 min-w-0 overflow-hidden">
        <div className="w-full max-w-[90%] min-w-0">
          <button
            onClick={() => setSummaryExpanded(!summaryExpanded)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md3-sm text-[11px] transition-colors ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/60 hover:text-white/80 hover:bg-white/15'
                : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/8 text-dark-onSurfaceVariant/50 hover:text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainer/60'
            }`}
          >
            {summaryExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            <FileText size={11} className="flex-shrink-0" />
            <span className="truncate">{t('chat.compactFileRestored')}{filePath ? `: ${filePath}` : ''}</span>
          </button>
          {summaryExpanded && (
            <div className={`mt-2 px-4 py-2.5 rounded-md3-md text-sm leading-relaxed min-w-0 break-words overflow-hidden [&_pre]:overflow-x-auto ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/90'
                : 'bg-dark-surfaceContainerHigh text-dark-onSurface'
            }`}>
              <MarkdownContent content={message.content} vibe={vibe} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // Tool result messages are hidden (displayed inside ToolCallBar)
  if (isToolResult) return null

  // 正在压缩上下文占位 —— 居中显示过程提示（压缩完成后被摘要卡片替换）
  if (message._isCompacting) {
    return (
      <div className="flex justify-center animate-slide-up my-1">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md3-md text-[11px] ${
          vibe
            ? 'bg-white/5 border border-white/[0.03] text-white/50'
            : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/[0.03] text-dark-onSurfaceVariant/50'
        }`}>
          <Loader2 size={12} className="animate-spin" />
          <span>{t('chat.compactingContext')}</span>
        </div>
      </div>
    )
  }

  // 请求失败后正在重试 —— 居中显示过程提示（重试成功后清除该标记）
  if (message._retrying) {
    return (
      <div className="flex justify-center animate-slide-up my-1">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md3-md text-[11px] ${
          vibe
            ? 'bg-white/5 border border-white/[0.03] text-white/60'
            : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/[0.03] text-dark-onSurfaceVariant/60'
        }`}>
          <Loader2 size={12} className="animate-spin" />
          <span>{t('chat.retrying', { attempt: message._retrying.attempt })}</span>
        </div>
      </div>
    )
  }

  // Sub-agent card placeholder — render as SubAgentCard
  if (message.isSubAgentCard) {
    return (
      <div className="flex justify-start animate-slide-up w-full">
        <div className="w-full max-w-md min-w-0">
          <SubAgentCard message={message} sessionId={sessionId || useChatStore.getState().activeSessionId || ''} vibe={vibe} />
        </div>
      </div>
    )
  }

  // Collapsed intermediate messages — show as expandable summary
  if (message.collapsed && !isUser) {
    const toolCallsCount = message.toolCalls?.length || 0
    // 既无正文也无工具调用的空折叠消息直接不渲染（历史数据兜底，避免出现空气泡）
    if (toolCallsCount === 0 && !message.content.trim()) return null
    return (
      <div className="flex justify-start animate-slide-up">
        <div className="max-w-[90%]">
          <button
            onClick={() => setCollapsedExpanded(!collapsedExpanded)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md3-sm text-[11px] transition-colors ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/60 hover:text-white/80 hover:bg-white/15'
                : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/8 text-dark-onSurfaceVariant/50 hover:text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainer/60'
            }`}
          >
            {collapsedExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            <Wrench size={11} />
            <span>{t('chat.collapsedSteps', { count: toolCallsCount })}</span>
          </button>
          {collapsedExpanded && (
            <div className="mt-2 w-full">
              {message.content && (
                <div className={`relative group px-4 py-2.5 rounded-md3-md text-sm leading-relaxed ${
                  vibe
                    ? 'bg-white/10 border border-white/20 text-white/90'
                    : 'bg-dark-surfaceContainerHigh text-dark-onSurface'
                }`}>
                  <MarkdownContent content={message.content} vibe={vibe} />
                </div>
              )}
              {message.toolCalls && (
                <ToolRunGroup toolCalls={message.toolCalls} toolResults={message.toolResults} vibe={vibe} />
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (
    message.role === 'assistant' &&
    !message.isSubAgentCard &&
    !message.content.trim() &&
    !hasThinking &&
    !message.streamingToolCalls?.length &&
    !hasVisibleToolCalls
  ) {
    return null
  }

  // 用户消息附件：图片缩略图 + 文件 chip（与正文气泡分开渲染，正文为空时也要显示）
  const userImages = isUser ? (message.attachments || []).filter((a) => a.kind === 'image' && a.dataUrl) : []
  const userFiles = isUser ? (message.attachments || []).filter((a) => a.kind === 'file') : []

  // 发送时选中的任务工作流（/spec /plan /goal）→ 气泡上方的小标识
  const taskModeMeta = isUser && message.taskMode
    ? ({
        spec: { icon: BookOpen, name: 'Spec', cls: 'bg-md-info/15 text-md-info' },
        plan: { icon: GitBranch, name: 'Plan', cls: 'bg-md-primary/15 text-md-primary' },
        goal: { icon: Target, name: 'Goal', cls: 'bg-md-tertiary/15 text-md-tertiary' },
      } as const)[message.taskMode]
    : null

  return (
    <div className={`animate-slide-up ${isUser ? 'flex justify-end' : 'flex justify-start'}`}>
      <div className={`flex flex-col ${isUser ? 'items-end max-w-[85%]' : 'items-start max-w-[90%]'}`}>

        {/* User message attachments - above the content bubble */}
        {(userImages.length > 0 || userFiles.length > 0) && (
          <div className="flex flex-col items-end gap-1.5 mb-1.5">
            {userImages.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-end">
                {userImages.map((a) => (
                  <img
                    key={a.id}
                    src={a.dataUrl}
                    alt={a.name}
                    title={a.path || a.name}
                    className="max-h-40 max-w-[240px] rounded-md3-md object-cover border border-dark-onSurfaceVariant/15"
                  />
                ))}
              </div>
            )}
            {userFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-end">
                {userFiles.map((a) => (
                  <div
                    key={a.id}
                    title={a.path}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md3-md text-xs ${
                      vibe
                        ? 'bg-white/10 border border-white/20 text-white/90'
                        : 'bg-md-primaryContainer text-md-onPrimaryContainer'
                    }`}
                  >
                    <FileText size={12} className="flex-shrink-0" />
                    <span className="truncate max-w-[200px]">{a.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Thinking content - collapsible */}
        {hasThinking && !isUser && (
          <ThinkingHeader
            thinkingContent={message.thinkingContent || ''}
            isStreaming={!!message._isStreaming}
            hasContent={!!message.content}
            finishReason={message.finishReason}
            expanded={thinkingExpanded}
            onToggle={() => setThinkingExpanded(!thinkingExpanded)}
            vibe={vibe}
          />
        )}

        {/* Task workflow badge (/spec /plan /goal) - above the content bubble */}
        {taskModeMeta && (
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-md3-sm text-[11px] font-medium mb-1 ${
            vibe ? 'bg-white/15 text-white/90' : taskModeMeta.cls
          }`}>
            <taskModeMeta.icon size={11} className="flex-shrink-0" />
            <span>{taskModeMeta.name}</span>
          </div>
        )}

        {/* Message content bubble */}
        {message.content.trim() && (
          <div
            className={`relative group px-4 py-2.5 rounded-md3-md text-sm leading-relaxed ${
              isUser
                ? vibe
                  ? 'liquid-glass text-white'
                  : 'bg-md-primaryContainer text-md-onPrimaryContainer'
                : vibe
                  ? 'liquid-glass-subtle text-white/90'
                  : 'bg-dark-surfaceContainerHigh text-dark-onSurface'
            }`}
          >
            {!isUser && (
              <button
                type="button"
                onClick={handleCopy}
                aria-label={t('common.copy')}
                title={t('common.copy')}
                className={`absolute top-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded-md3-xs ${
                  vibe ? 'hover:bg-white/15' : 'hover:bg-dark-surfaceContainer'
                }`}
              >
                {copied ? <Check size={12} className="text-md-success" /> : <Copy size={12} className={vibe ? 'text-white/70' : ''} />}
              </button>
            )}
            {isUser ? message.content : <MarkdownContent content={message.content} vibe={vibe} />}
          </div>
        )}

        {/* 流式生成中的工具调用行 — 与完成态同款紧凑行样式 */}
        {!isUser && message.streamingToolCalls?.length ? (
          <StreamingToolRows calls={message.streamingToolCalls} vibe={vibe} />
        ) : null}

        {/* 工具运行组：过程消息直接平铺工具行，最终回复保留折叠头部 */}
        {!isUser && message.toolCalls && (
          isIntermediate ? (
            <div className="w-full mt-1 flex flex-col gap-0.5">
              {message.toolCalls
                .filter((tc) => tc.name !== 'spawn_agent')
                .map((tc) => (
                  <ToolRow key={tc.id} toolCall={tc} result={message.toolResults} vibe={vibe} />
                ))}
            </div>
          ) : (
            <ToolRunGroup
              toolCalls={message.toolCalls}
              toolResults={message.toolResults}
              vibe={vibe}
              defaultOpen={!!message.streamingToolCalls?.length || !message.finishReason}
              finishReason={message.finishReason}
            />
          )
        )}

        {/* Truncation warning */}
        {isTruncated && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-md-warning">
            <AlertTriangle size={10} />
            {t('chat.truncated')}
          </div>
        )}

        {cacheEligibleTokens > 0 && !isUser && !isIntermediate && (
          <span className={`text-[10px] mt-1 px-1 ${vibe ? 'text-white/45' : 'text-dark-onSurfaceVariant/40'}`}>
            {t('chat.cacheStats', {
              rate: cacheHitRate,
              read: cacheReadTokens.toLocaleString(),
              created: cacheCreatedTokens.toLocaleString(),
            })}
          </span>
        )}

        {/* Timestamp —— 过程消息不显示时间戳，仅在用户消息和最终回复上显示 */}
        {!isIntermediate && (isUser || !!message.content.trim() || hasThinking) && (
          <span className={`text-[10px] mt-1 px-1 ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/30'}`}>
            {new Date(message.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
    </div>
  )
}

export default memo(MessageItem)
