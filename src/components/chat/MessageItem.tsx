import { useState, useEffect, useRef, useMemo, memo } from 'react'
import { Copy, Check, Terminal, FileText, FolderOpen, AlertTriangle, ChevronDown, ChevronUp, Wrench, FilePen, Globe, Pencil, Archive, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Message, StreamingToolCall } from '../../types/agent'
import { useChatStore } from '../../stores/chat-store'
import ThinkingShimmer from './ThinkingShimmer'
import { SubAgentCard } from './SubAgentCard'

interface MessageItemProps {
  message: Message
  vibe?: boolean
  sessionId?: string
}

/** Extract path and content from partial JSON args for write_file preview */
function extractWriteFileData(argsSoFar: string): { path: string; content: string } {
  // Try full parse first
  try {
    const parsed = JSON.parse(argsSoFar)
    return { path: parsed.path || '', content: parsed.content || '' }
  } catch {}

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

/** Streaming write_file preview card */
function WriteFilePreviewCard({ streamingCall }: { streamingCall: StreamingToolCall }) {
  const { t } = useTranslation()
  const { path, content } = useMemo(() => extractWriteFileData(streamingCall.argsSoFar), [streamingCall.argsSoFar])
  const scrollRef = useRef<HTMLPreElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Auto-scroll to bottom as content streams in (throttled)
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      // Use requestAnimationFrame to avoid layout thrashing
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      })
    }
  }, [content, autoScroll])

  const lineCount = content.split('\n').length

  return (
    <div className="rounded-md3-md border border-md-info/[0.03] bg-md-info/5 overflow-hidden max-w-md">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-md-info/8 border-b border-md-info/[0.03]">
        <FilePen size={12} className="text-md-info flex-shrink-0" />
        <span className="text-[11px] font-medium text-md-info truncate">
          {path || t('toolPreview.generatingPath')}
        </span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-md3-xs bg-md-info/15 text-md-info animate-pulse-soft flex-shrink-0">
          {t('toolPreview.writing')}
        </span>
        <span className="text-[10px] text-dark-onSurfaceVariant/40 flex-shrink-0">
          {lineCount} {t('common.lines')}
        </span>
      </div>
      {/* Content preview - fixed height with scroll */}
      <div
        className="relative"
        onMouseEnter={() => setAutoScroll(false)}
        onMouseLeave={() => setAutoScroll(true)}
      >
        <pre
          ref={scrollRef}
          className="px-3 py-2 text-[11px] font-mono leading-relaxed text-dark-onSurface/80 overflow-y-auto max-h-[200px] whitespace-pre-wrap break-all"
        >
          {content || '...'}
          <span className="inline-block w-1.5 h-3 bg-md-info animate-pulse-soft ml-0.5 align-text-bottom" />
        </pre>
      </div>
    </div>
  )
}

/** Streaming search_replace preview card */
function SearchReplacePreviewCard({ streamingCall }: { streamingCall: StreamingToolCall }) {
  const { t } = useTranslation()
  let path = ''
  let oldPreview = ''
  let newPreview = ''
  try {
    const parsed = JSON.parse(streamingCall.argsSoFar)
    path = parsed.path || ''
    oldPreview = (parsed.old_str || '').slice(0, 80).replace(/\n/g, '↵')
    newPreview = (parsed.new_str || '').slice(0, 80).replace(/\n/g, '↵')
  } catch {
    const pathMatch = streamingCall.argsSoFar.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (pathMatch) path = pathMatch[1]
  }

  return (
    <div className="rounded-md3-md border border-md-primary/[0.03] bg-md-primary/5 overflow-hidden max-w-md">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-md-primary/8 border-b border-md-primary/[0.03]">
        <Pencil size={12} className="text-md-primary flex-shrink-0" />
        <span className="text-[11px] font-medium text-md-primary truncate">
          {path || t('toolPreview.parsing')}
        </span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-md3-xs bg-md-primary/15 text-md-primary animate-pulse-soft flex-shrink-0">
          {t('toolPreview.searchReplacing')}
        </span>
      </div>
      <div className="px-3 py-2 text-[11px] font-mono leading-relaxed space-y-1">
        {oldPreview && (
          <div className="flex gap-2">
            <span className="text-md-error/60 flex-shrink-0">-</span>
            <span className="text-md-error/80 whitespace-pre-wrap break-all">{oldPreview}{oldPreview.length >= 80 ? '...' : ''}</span>
          </div>
        )}
        {newPreview && (
          <div className="flex gap-2">
            <span className="text-md-success/60 flex-shrink-0">+</span>
            <span className="text-md-success/80 whitespace-pre-wrap break-all">{newPreview}{newPreview.length >= 80 ? '...' : ''}</span>
          </div>
        )}
        {!oldPreview && !newPreview && (
          <span className="text-dark-onSurfaceVariant/40">{t('toolPreview.receivingArgs')}</span>
        )}
      </div>
    </div>
  )
}

/** Streaming edit_file preview card */
function EditFilePreviewCard({ streamingCall }: { streamingCall: StreamingToolCall }) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLPreElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Try to extract path and operations from partial JSON
  let path = ''
  let opsPreview = ''
  try {
    const parsed = JSON.parse(streamingCall.argsSoFar)
    path = parsed.path || ''
    if (Array.isArray(parsed.operations)) {
      opsPreview = parsed.operations.map((op: { type?: string; line?: number; content?: string; count?: number }, i: number) => {
        const type = op.type || '?'
        const line = op.line || '?'
        const lines = type === 'delete' ? (op.count || 1) : (op.content?.split('\n').length || 1)
        if (type === 'replace') return t('toolPreview.replaceLines', { line, count: lines })
        if (type === 'insert') return t('toolPreview.insertLines', { line, count: lines })
        if (type === 'delete') return t('toolPreview.deleteLines', { line, count: lines })
        return t('toolPreview.operationN', { n: i + 1 })
      }).join('\n')
    }
  } catch {
    // Partial JSON - try regex for path
    const pathMatch = streamingCall.argsSoFar.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (pathMatch) path = pathMatch[1]
    opsPreview = t('toolPreview.parsingOps')
  }

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [opsPreview, autoScroll])

  return (
    <div className="rounded-md3-md border border-md-success/[0.03] bg-md-success/5 overflow-hidden max-w-md">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-md-success/8 border-b border-md-success/[0.03]">
        <Pencil size={12} className="text-md-success flex-shrink-0" />
        <span className="text-[11px] font-medium text-md-success truncate">
          {path || t('toolPreview.generatingPath')}
        </span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-md3-xs bg-md-success/15 text-md-success animate-pulse-soft flex-shrink-0">
          {t('toolPreview.editing')}
        </span>
      </div>
      {/* Operations preview */}
      <div
        className="relative"
        onMouseEnter={() => setAutoScroll(false)}
        onMouseLeave={() => setAutoScroll(true)}
      >
        <pre
          ref={scrollRef}
          className="px-3 py-2 text-[11px] font-mono leading-relaxed text-dark-onSurface/80 overflow-y-auto max-h-[120px] whitespace-pre-wrap"
        >
          {opsPreview || '...'}
          <span className="inline-block w-1.5 h-3 bg-md-success animate-pulse-soft ml-0.5 align-text-bottom" />
        </pre>
      </div>
    </div>
  )
}

/** Compact tool call bar - horizontal strip style */
function ToolCallBar({ toolCall, result, vibe }: { toolCall: NonNullable<Message['toolCalls']>[0]; result?: Message['toolResults']; vibe?: boolean }) {
  // U1: Hook 必须放在 early return 之前，否则违反 Rules of Hooks。
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  // spawn_agent 由 SubAgentCard 单独展示，不显示原始工具调用条
  if (toolCall.name === 'spawn_agent') return null
  const toolResult = result?.find((r) => r.toolCallId === toolCall.id)
  const isError = toolResult?.isError ?? false

  const toolIcon = toolCall.name === 'edit_file' || toolCall.name === 'search_replace'
    ? <Pencil size={12} />
    : toolCall.name.includes('file') || toolCall.name.includes('read') || toolCall.name.includes('write')
    ? <FileText size={12} />
    : toolCall.name.includes('dir') || toolCall.name.includes('list')
    ? <FolderOpen size={12} />
    : toolCall.name.includes('web') || (toolCall.name.includes('search') && !toolCall.name.includes('content'))
    ? <Globe size={12} />
    : <Terminal size={12} />

  const displayName = t(`tools.${toolCall.name}`, { defaultValue: toolCall.name })

  const getArgsPreview = () => {
    const args = toolCall.arguments
    if (toolCall.name === 'read_file' || toolCall.name === 'list_dir') return String(args.path || '')
    if (toolCall.name === 'write_file' || toolCall.name === 'edit_file' || toolCall.name === 'search_replace') return String(args.path || '')
    if (toolCall.name === 'execute_command') return String(args.command || '').slice(0, 80)
    if (toolCall.name === 'search_files') return `${args.pattern} in ${args.path}`
    if (toolCall.name === 'search_content') return `/${args.pattern}/ in ${args.path}`
    if (toolCall.name === 'web_search') return String(args.query || '')
    if (toolCall.name === 'web_fetch') return String(args.url || '')
    return JSON.stringify(args)
  }

  // Parse diff info from edit_file tool result
  let editAddedLines = 0
  let editRemovedLines = 0
  if (toolCall.name === 'edit_file' && toolResult) {
    const content = toolResult.content || ''
    const diffMatch = content.match(/__EDIT_DIFF__:(.*)/s)
    if (diffMatch) {
      try {
        const diffData = JSON.parse(diffMatch[1])
        editAddedLines = diffData.addedLines || 0
        editRemovedLines = diffData.removedLines || 0
      } catch {}
    }
  }

  return (
    <div className={`rounded-md3-xs border overflow-hidden max-w-md ${
      isError
        ? vibe
          ? 'border-md-error/30 bg-md-error/10'
          : 'border-md-error/15 bg-md-error/5'
        : vibe
          ? 'liquid-glass-subtle border-white/[0.03]'
          : 'border-dark-onSurfaceVariant/[0.03] bg-dark-surfaceContainer/40'
    }`}>
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={`tc-detail-${toolCall.id}`}
        aria-label={t('toolPreview.toolCallStatus', { name: displayName, status: toolResult ? (isError ? t('toolPreview.statusFailed') : t('toolPreview.statusComplete')) : t('toolPreview.statusExecuting') })}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] transition-colors ${
          vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh/40'
        }`}
      >
        {isError ? <AlertTriangle size={11} className="text-md-error flex-shrink-0" /> : <span className={vibe ? 'text-white/60 flex-shrink-0' : 'text-dark-onSurfaceVariant/50 flex-shrink-0'}>{toolIcon}</span>}
        <span className={vibe ? 'font-medium text-white/80' : 'font-medium text-dark-onSurfaceVariant/80'}>{displayName}</span>
        <span className={vibe ? 'text-white/40 truncate' : 'text-dark-onSurfaceVariant/30 truncate'}>{getArgsPreview()}</span>
        {toolResult && (
          <span className={`ml-auto text-[10px] px-1 py-0.5 rounded-md3-xs flex-shrink-0 ${isError ? 'bg-md-error/15 text-md-error' : 'bg-md-success/15 text-md-success'}`}>
            {isError ? t('toolPreview.executionFailed') : t('toolPreview.executionComplete')}
          </span>
        )}
        {!isError && toolCall.name === 'edit_file' && editAddedLines > 0 && (
          <span className="text-[10px] px-1 py-0.5 rounded-md3-xs bg-md-success/10 text-md-success flex-shrink-0">
            +{editAddedLines}
          </span>
        )}
        {!isError && toolCall.name === 'edit_file' && editRemovedLines > 0 && (
          <span className="text-[10px] px-1 py-0.5 rounded-md3-xs bg-md-error/10 text-md-error flex-shrink-0">
            -{editRemovedLines}
          </span>
        )}
        {!toolResult && (
          <span className="ml-auto text-[10px] px-1 py-0.5 rounded-md3-xs bg-md-info/15 text-md-info animate-pulse-soft flex-shrink-0">
            {t('toolPreview.executing')}
          </span>
        )}
        <span className={`flex-shrink-0 ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/30'}`}>
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </span>
      </button>
      {expanded && (
        <div
          id={`tc-detail-${toolCall.id}`}
          className={`px-3 pb-2 space-y-2 text-[11px] border-t ${vibe ? 'border-white/[0.03]' : 'border-dark-onSurfaceVariant/[0.03]'}`}
        >
          <div className="pt-2">
            <span className={vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/40'}>{t('chat.toolParams')}</span>
            <pre className={`mt-1 p-2 rounded-md3-xs overflow-x-auto text-[10px] ${
              vibe ? 'bg-black/30 text-white/90' : 'bg-dark-surfaceContainerHigh'
            }`}>
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>
          {toolResult && (
            <div>
              <span className={vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/40'}>{t('chat.toolResult')}</span>
              <pre className={`mt-1 p-2 rounded-md3-xs overflow-x-auto max-h-48 text-[10px] whitespace-pre-wrap ${
                isError ? 'bg-md-error/8 text-md-error' : vibe ? 'bg-black/30 text-white/90' : 'bg-dark-surfaceContainerHigh'
              }`}>
                {toolResult.content}
              </pre>
            </div>
          )}
        </div>
      )}
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

  // P4: 状态标记 effect —— 只在 thinkingContent / 流式状态变化时启动/结束计时
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

  // P4: tick effect —— 独立维护，避免每次 render 重建 setInterval
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
      <button onClick={onToggle} className="flex items-center gap-1.5 py-1 group">
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
    // U2: 表格至少需要表头 + 分隔符两行；分隔符行必须所有 cell 都是 - / : / | / 空格。
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

function MessageItem({ message, vibe = false, sessionId }: MessageItemProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [collapsedExpanded, setCollapsedExpanded] = useState(false)
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const isUser = message.role === 'user'
  const isToolResult = message.role === 'tool'
  const isTruncated = message.finishReason === 'length'
  const hasThinking = !!message.thinkingContent && message.thinkingContent.length > 0
  const hasStreamingWriteFile = message.streamingToolCalls?.some(tc => tc.name === 'write_file')

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
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
      <div className="flex justify-center animate-slide-up my-1">
        <div className="w-full max-w-[90%]">
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
            <div className={`mt-2 px-4 py-2.5 rounded-md3-md text-sm leading-relaxed ${
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
            <div className="mt-2">
              <div className={`relative group px-4 py-2.5 rounded-md3-md text-sm leading-relaxed ${
                vibe
                  ? 'bg-white/10 border border-white/20 text-white/90'
                  : 'bg-dark-surfaceContainerHigh text-dark-onSurface'
              }`}>
                <MarkdownContent content={message.content || ''} vibe={vibe} />
              </div>
              {message.toolCalls && message.toolCalls.some((tc) => tc.name !== 'spawn_agent') && (
                <div className="mt-1.5 space-y-1">
                  {message.toolCalls.filter((tc) => tc.name !== 'spawn_agent').map((tc) => (
                    <ToolCallBar key={tc.id} toolCall={tc} result={message.toolResults} vibe={vibe} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`animate-slide-up ${isUser ? 'flex justify-end' : 'flex justify-start'}`}>
      <div className={`flex flex-col ${isUser ? 'items-end max-w-[85%]' : 'items-start max-w-[90%]'}`}>

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

        {/* Thinking indicator when streaming but no visible output yet */}
        {!isUser && message._isStreaming && !message.content && !message.thinkingContent && !message.streamingToolCalls?.length && (
          <ThinkingShimmer />
        )}

        {/* Message content bubble */}
        {message.content && (
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
                onClick={handleCopy}
                className={`absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded-md3-xs ${
                  vibe ? 'hover:bg-white/15' : 'hover:bg-dark-surfaceContainer'
                }`}
              >
                {copied ? <Check size={12} className="text-md-success" /> : <Copy size={12} className={vibe ? 'text-white/70' : ''} />}
              </button>
            )}
            {isUser ? message.content : <MarkdownContent content={message.content} vibe={vibe} />}
          </div>
        )}

        {/* Streaming write_file / search_replace preview cards — 放在 content 下方，与已完成的 ToolCallBar 一致 */}
        {!isUser && message.streamingToolCalls?.map((tc) => (
          tc.name === 'write_file' ? (
            <WriteFilePreviewCard key={tc.id} streamingCall={tc} />
          ) : tc.name === 'edit_file' ? (
            <EditFilePreviewCard key={tc.id} streamingCall={tc} />
          ) : tc.name === 'search_replace' ? (
            <SearchReplacePreviewCard key={tc.id} streamingCall={tc} />
          ) : (
            <div key={tc.id} className={`flex items-center gap-2 px-3 py-1.5 text-[11px] rounded-md3-xs mb-1 max-w-md ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/60'
                : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/8 text-dark-onSurfaceVariant/50'
            }`}>
              {tc.name.includes('file') ? <FileText size={11} /> : <Terminal size={11} />}
              <span>{t('chat.streamingToolCall', { name: tc.name })}</span>
              <span className="ml-auto w-1.5 h-1.5 rounded-full bg-md-info animate-pulse-soft" />
            </div>
          )
        ))}

        {/* Tool calls - compact horizontal bars (only for completed tool calls, not streaming) */}
        {!message.streamingToolCalls?.length && message.toolCalls && message.toolCalls.some((tc) => tc.name !== 'spawn_agent') && (
          <div className="w-full mt-1.5 space-y-1">
            {message.toolCalls.filter((tc) => tc.name !== 'spawn_agent').map((tc) => (
              <ToolCallBar key={tc.id} toolCall={tc} result={message.toolResults} vibe={vibe} />
            ))}
          </div>
        )}

        {/* Truncation warning */}
        {isTruncated && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-md-warning">
            <AlertTriangle size={10} />
            {t('chat.truncated')}
          </div>
        )}

        {/* Timestamp */}
        <span className={`text-[10px] mt-1 px-1 ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/30'}`}>
          {new Date(message.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  )
}

export default memo(MessageItem)
