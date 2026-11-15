/**
 * 单工具行（照抄 ZCode ToolCallBlocks/ToolSummaryRow + ToolLayout 的层级与措辞）。
 *
 * 收起态：图标(16px 静止) + 类别词(font-medium) +「·」+ 目标，内容宽度、最浅灰；
 * 运行态类别词扫光（不用 spinner，ZCode：旋转图标长期占用渲染资源）；
 * chevron 悬停显现、展开转 90°；失败挂「失败」虚线下划线 + 悬停 tooltip。
 * 展开体沿用 ClerkBox 专属渲染器（diff / 终端 / 工作流看板），左导线口径不变。
 * 展开态持久、完成边沿自动展开/收起、工作流起跑即展开：沿用 tool-card-state 既有语义。
 */
import { Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronRight, CircleHelp, FilePen, Globe, LayoutGrid, ListTodo, MonitorSmartphone,
  MousePointerClick, Pencil, Search, SquareTerminal, Workflow,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StreamingToolCall, ToolCall, ToolResult } from '../../types/agent'
import {
  getToolCardOpen, hasAutoActed, hasUserTouched, markAutoActed,
  resolveToolCardAutoAction, setToolCardOpen,
} from '../../lib/tool-card-state'
import { resolveRenderer } from './tool-renderers/resolveRenderer'
import { ToolDetailLines, ToolShell, ToolSkeleton, noteToolRunning } from './tool-renderers/ToolShell'
import { parseEditDiff, stripEditDiff, type EditDiffMetaView } from './tool-renderers/shared'
import type { ToolRowItem } from './stream-rows'
import { isToolRunning } from './stream-rows'

const fileBase = (p: string) => p.split(/[\\/]/).pop() || p

type TFn = ReturnType<typeof useTranslation>['t']

/** 类别词 + 图标（ZCode kind.* 措辞；ClerkBox 特有工具沿用 tools.* 标签与既有图标） */
function toolKindMeta(name: string, running: boolean, t: TFn): { icon: ReactNode; label: string } {
  switch (name) {
    case 'read_file':
    case 'read_image':
      return { icon: <Search size={16} />, label: t(running ? 'chat.toolKind.reading' : 'chat.toolKind.read') }
    case 'list_dir':
      return { icon: <Search size={16} />, label: t(running ? 'chat.toolKind.listing' : 'chat.toolKind.list') }
    case 'search_files':
    case 'search_content':
    case 'web_search':
      return { icon: <Search size={16} />, label: t(running ? 'chat.toolKind.searching' : 'chat.toolKind.search') }
    case 'web_fetch':
      return { icon: <Globe size={16} />, label: t(running ? 'chat.toolKind.fetching' : 'chat.toolKind.webFetch') }
    case 'execute_command':
      return { icon: <SquareTerminal size={16} />, label: t(running ? 'chat.toolKind.executing' : 'chat.toolKind.terminal') }
    case 'write_file':
      return { icon: <Pencil size={16} />, label: t(running ? 'chat.toolKind.writing' : 'chat.toolKind.write') }
    case 'search_replace':
    case 'edit_file':
      return { icon: <Pencil size={16} />, label: t(running ? 'chat.toolKind.editing' : 'chat.toolKind.edit') }
    case 'todowrite':
      return { icon: <ListTodo size={16} />, label: t('chat.toolKind.todo') }
    case 'question':
      return { icon: <CircleHelp size={16} />, label: t('tools.question', { defaultValue: name }) }
    case 'create_workflow':
      return { icon: <Workflow size={16} />, label: t('tools.create_workflow', { defaultValue: name }) }
  }
  if (name.startsWith('app_')) return { icon: <LayoutGrid size={16} />, label: t(`tools.${name}`, { defaultValue: name }) }
  if (name.startsWith('computer_')) return { icon: <MonitorSmartphone size={16} />, label: t(`tools.${name}`, { defaultValue: name }) }
  if (name.startsWith('browser_')) return { icon: <MousePointerClick size={16} />, label: t(`tools.${name}`, { defaultValue: name }) }
  return { icon: <Globe size={16} />, label: t(`tools.${name}`, { defaultValue: name }) }
}

/** 行目标文本：读写类显示文件名，命令/搜索显示参数片段（沿用既有口径） */
export function chipTextFor(name: string, args: Record<string, unknown>, t: TFn): string {
  if (name.startsWith('app_')) return t(`tools.${name}`, { defaultValue: name })
  if (name === 'create_workflow') return String(args.name || '')
  if (name.startsWith('browser_') || name.startsWith('computer_')) {
    if (name === 'browser_navigate') return String(args.url || args.action || '')
    if (name === 'computer_drag') return `${args.from_x},${args.from_y} → ${args.to_x},${args.to_y}`
    if (args.x !== undefined && args.y !== undefined) return `${args.x}, ${args.y}`
    if (args.ref) return String(args.ref)
    if (args.key) return String(args.key)
    if (args.name) return String(args.name)
    if (args.text) return String(args.text).slice(0, 40)
    if (args.selector) return String(args.selector)
    return ''
  }
  if (name === 'write_file' || name === 'search_replace' || name === 'edit_file' ||
      name === 'read_file' || name === 'read_image' || name === 'list_dir') {
    return fileBase(String(args.path || ''))
  }
  if (name === 'execute_command') return String(args.command || '')
  if (name === 'search_files' || name === 'search_content') return String(args.pattern || '')
  if (name === 'web_search') return String(args.query || '')
  if (name === 'web_fetch') return String(args.url || '')
  if (name === 'question') return t('chat.chipQuestions', { count: Array.isArray(args.questions) ? args.questions.length : 0 })
  if (name === 'todowrite') return t('chat.chipTodos', { count: Array.isArray(args.items) ? args.items.length : 0 })
  const json = JSON.stringify(args)
  return json === '{}' ? '' : json.slice(0, 80)
}

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

function extractWriteFilePath(argsSoFar: string): string {
  try {
    return JSON.parse(argsSoFar).path || ''
  } catch { /* 部分 JSON 走容错抽取 */ }
  const m = argsSoFar.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (m) {
    try { return JSON.parse('"' + m[1] + '"') } catch { return m[1] }
  }
  return ''
}

interface ToolCallRowProps {
  item: ToolRowItem
  vibe?: boolean
  sessionId?: string
  /** 聚合组内的子行去图标（ZCode nestedToolRenderer showIcon=false） */
  showIcon?: boolean
}

export function ToolCallRow({ item, vibe, sessionId, showIcon = true }: ToolCallRowProps) {
  const { t } = useTranslation()
  const { call, result } = item
  const detailId = useId()
  const [open, setOpen] = useState(() => getToolCardOpen(call.id) ?? false)
  const [mountDetail, setMountDetail] = useState(() => getToolCardOpen(call.id) ?? false)
  const isError = result?.isError ?? false
  const running = isToolRunning(item)
  const Renderer = resolveRenderer(call.name)

  const parsed = useMemo<{
    meta: EditDiffMetaView | null
    detailLines: Array<{ text: string; tone: 'add' | 'del' | 'ctx' }>
  }>(() => {
    if (!result) return { meta: null, detailLines: [] }
    const diff = isError ? null : parseEditDiff(result.content)
    if (diff) return { meta: diff, detailLines: diff.lines }
    return {
      meta: null,
      detailLines: stripEditDiff(result.content).split('\n').filter((l) => l.trim()).slice(0, 5)
        .map((text) => ({ text, tone: 'ctx' as const })),
    }
  }, [result, isError])
  const { meta, detailLines } = parsed

  useEffect(() => {
    noteToolRunning(call.id, running)
  }, [call.id, running])

  useEffect(() => {
    if (open) {
      setMountDetail(true)
      return
    }
    const timer = setTimeout(() => setMountDetail(false), 300)
    return () => clearTimeout(timer)
  }, [open])

  // 工作流起跑即展开（运行看板是这次调用唯一的进度面）；用户手动收起过则不抢方向盘
  const workflowStartedRef = useRef(false)
  useEffect(() => {
    if (!running || workflowStartedRef.current) return
    if (call.name !== 'create_workflow' || hasUserTouched(call.id)) return
    workflowStartedRef.current = true
    markAutoActed(call.id)
    setToolCardOpen(call.id, true)
    setOpen(true)
  }, [running, call.id, call.name])

  // 完成边沿的自动展开/收起（每行一次，用户手动操作过的不抢）
  const wasRunningRef = useRef(running)
  useEffect(() => {
    const wasRunning = wasRunningRef.current
    wasRunningRef.current = running
    if (wasRunning === running || !wasRunning || running) return
    const action = resolveToolCardAutoAction({
      wasRunning, isRunning: running, isOpen: open,
      userTouched: hasUserTouched(call.id), toolName: call.name, hasAutoActed: hasAutoActed(call.id),
    })
    if (action === 'open' && !open) {
      markAutoActed(call.id)
      setToolCardOpen(call.id, true)
      setOpen(true)
    } else if (action === 'collapse' && open) {
      markAutoActed(call.id)
      setToolCardOpen(call.id, false)
      setOpen(false)
    }
  }, [running, open, call.id, call.name])

  const toggle = () => {
    const next = !open
    setOpen(next)
    setToolCardOpen(call.id, next, { userAction: true })
  }

  const { icon, label } = toolKindMeta(call.name, running, t)
  const chip = chipTextFor(call.name, call.arguments, t)
  const dim = vibe ? 'text-white/75' : 'text-dark-onSurfaceVariant'

  return (
    <div className="w-full min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={toggle}
        className={`md-focus group/tool inline-flex max-w-full min-w-0 items-center gap-2 self-start rounded-md3-xs py-1 text-left text-ui-sm transition-colors duration-100 max-md:min-h-11 ${dim}`}
      >
        {showIcon && <span className="shrink-0">{icon}</span>}
        <span title={label} className={`min-w-0 max-w-[60%] truncate font-medium ${running ? 'thinking-shimmer' : ''}`}>{label}</span>
        {chip && (
          <>
            <span className="shrink-0" aria-hidden>·</span>
            <span title={chip} className={`min-w-0 truncate ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/80'}`}>{chip}</span>
          </>
        )}
        {meta && meta.added > 0 && <span className="shrink-0 text-ui-xs tabular-nums text-md-success">+{meta.added}</span>}
        {meta && meta.removed > 0 && <span className="shrink-0 text-ui-xs tabular-nums text-md-error">−{meta.removed}</span>}
        {isError && (
          <span
            className="shrink-0 cursor-help whitespace-nowrap text-ui-xs text-md-error underline decoration-dotted underline-offset-2"
            title={result ? result.content.slice(0, 500) : undefined}
          >
            {t('chat.toolStatus.failed')}
          </span>
        )}
        <ChevronRight
          size={16}
          className={`stream-row-chevron shrink-0 transition-all duration-200 ${open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100'}`}
        />
      </button>
      <ToolShell open={open} id={detailId}>
        {Renderer ? (
          mountDetail ? (
            <Suspense fallback={<ToolSkeleton vibe={vibe} />}>
              <Renderer call={call} result={result} isError={isError} args={call.arguments} vibe={vibe} sessionId={sessionId} />
            </Suspense>
          ) : null
        ) : detailLines.length > 0 ? (
          <ToolDetailLines lines={detailLines} vibe={vibe} />
        ) : null}
      </ToolShell>
    </div>
  )
}

/** 流式生成中的工具调用行：参数还在部分 JSON 阶段，容错抽取目标；类别词扫光表达「在跑」 */
export function StreamingToolRow({ call, vibe }: { call: StreamingToolCall; vibe?: boolean }) {
  const { t } = useTranslation()
  const raw = useMemo(() => {
    if (call.name === 'write_file') return extractWriteFilePath(call.argsSoFar)
    const v = extractFirstStringField(call.argsSoFar, ['path', 'command', 'query', 'url', 'pattern'])
    return v
  }, [call.name, call.argsSoFar])
  const isPathTool = call.name === 'write_file' || call.name === 'search_replace' ||
    call.name === 'read_file' || call.name === 'read_image' || call.name === 'list_dir'
  const chip = isPathTool ? fileBase(raw) : raw
  const { icon, label } = toolKindMeta(call.name, true, t)
  const dim = vibe ? 'text-white/75' : 'text-dark-onSurfaceVariant'

  return (
    <div className={`inline-flex max-w-full min-w-0 items-center gap-2 self-start text-ui-sm ${dim}`}>
      <span className="shrink-0">{icon}</span>
      <span title={label} className="thinking-shimmer min-w-0 max-w-[60%] truncate font-medium">{label}</span>
      <span className={`min-w-0 truncate ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/80'}`}>
        {chip || t('toolPreview.parsing')}
      </span>
    </div>
  )
}
