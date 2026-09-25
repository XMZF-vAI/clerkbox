import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from 'lucide-react'
import { formatElapsed } from './shared'

/** 折叠壳：与 MessageItem 的工具行折叠交互保持同一份 grid-rows 动效与类名 */
export function ToolShell({ open, children }: { open: boolean; children?: ReactNode }) {
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-300"
      style={{
        gridTemplateRows: open ? '1fr' : '0fr',
        opacity: open ? 1 : 0,
        transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
      }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

/** 明细缩进面板（左边框），与既有工具明细的视觉口径一致 */
export function ToolDetailPanel({ vibe = false, children }: { vibe?: boolean; children?: ReactNode }) {
  return (
    <div className={`mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l py-0.5 pl-3.5 ${
      vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'
    }`}>
      {children}
    </div>
  )
}

/** 通用回退明细：结果头几行的纯文本行列表（MessageItem 现状实现，逐像素保持） */
export function ToolDetailLines({ lines, vibe = false }: {
  lines: Array<{ text: string; tone: 'add' | 'del' | 'ctx' }>
  vibe?: boolean
}) {
  return (
    <ToolDetailPanel vibe={vibe}>
      {lines.map((line, i) => (
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
    </ToolDetailPanel>
  )
}

/** 等宽块：复用 markdown 的 code-block 样式（自带横向滚动，不假设外层有滚动容器） */
export function MonoBlock({ text, vibe = false, className = '' }: { text: string; vibe?: boolean; className?: string }) {
  return (
    <div className={`markdown-body min-w-0${vibe ? ' md-vibe' : ''} ${className}`}>
      <pre className="code-block max-h-64 overflow-auto whitespace-pre">
        <code>{text}</code>
      </pre>
    </div>
  )
}

const CHIP_BASE = 'inline-flex shrink-0 items-center rounded-md3-xs px-1.5 py-0.5 font-mono text-xs tabular-nums'

export type ToolBadgeTone = 'success' | 'error' | 'warning' | 'info'

const BADGE_CLASS: Record<ToolBadgeTone, string> = {
  success: 'bg-md-success/10 text-md-success',
  error: 'bg-md-error/10 text-md-error',
  warning: 'bg-md-warning/10 text-md-warning',
  info: 'bg-md-info/10 text-md-info',
}

export function ToolBadge({ tone, children }: { tone: ToolBadgeTone; children: ReactNode }) {
  return <span className={`${CHIP_BASE} ${BADGE_CLASS[tone]}`}>{children}</span>
}

/** 状态角标 + 耗时：渲染器统一使用的收尾行 */
export function ToolStatusLine({ vibe = false, children }: { vibe?: boolean; children?: ReactNode }) {
  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/60'}`}>
      {children}
    </div>
  )
}

/** 内联红绿 diff 行（write_file / search_replace 共用） */
export function DiffLineList({ lines, vibe = false }: {
  lines: Array<{ text: string; tone: 'add' | 'del' | 'ctx' }>
  vibe?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((line, i) => (
        <span
          key={i}
          title={line.text}
          className={`flex gap-2 truncate font-mono text-xs ${
            line.tone === 'add' ? 'text-md-success' : line.tone === 'del' ? 'text-md-error' : vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/60'
          }`}
        >
          <span className="w-3 shrink-0 select-none">{line.tone === 'add' ? '+' : line.tone === 'del' ? '−' : ' '}</span>
          <span className="min-w-0 truncate">{line.text}</span>
        </span>
      ))}
    </div>
  )
}

/** 流式未齐时的骨架态 */
export function ToolSkeleton({ vibe = false, lines = 2 }: { vibe?: boolean; lines?: number }) {
  return (
    <ToolDetailPanel vibe={vibe}>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className={`h-3 rounded-md3-xs animate-pulse-soft ${vibe ? 'bg-white/10' : 'bg-dark-onSurfaceVariant/10'}`}
          style={{ width: `${88 - i * 18}%` }}
        />
      ))}
    </ToolDetailPanel>
  )
}

/** 复制按钮：渲染器内的原文复制入口（不依赖外层宽度） */
export function ToolCopyButton({ text, vibe = false }: { text: string; vibe?: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch (e) {
      console.error('Failed to copy tool payload:', e)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={t('common.copy')}
      title={t('common.copy')}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md3-xs transition-colors ${
        vibe ? 'text-white/60 hover:bg-white/15' : 'text-dark-onSurfaceVariant/50 hover:bg-dark-surfaceContainerHigh/60'
      }`}
    >
      {copied ? <Check size={11} className="text-md-success" /> : <Copy size={11} />}
    </button>
  )
}

// ── 耗时测量 ──────────────────────────────────────────────────────────────
// 渲染器只在展开时挂载，耗时必须在工具行（常驻）侧记录，渲染器按 callId 读取。
const DURATION_TRACK_LIMIT = 300
const durationTrack = new Map<string, { start: number; end?: number }>()

export function noteToolRunning(callId: string, running: boolean): void {
  const current = durationTrack.get(callId)
  if (running) {
    if (!current) {
      if (durationTrack.size >= DURATION_TRACK_LIMIT) {
        const oldest = durationTrack.keys().next().value
        if (typeof oldest === 'string') durationTrack.delete(oldest)
      }
      durationTrack.set(callId, { start: Date.now() })
    }
    return
  }
  if (current && current.end === undefined) durationTrack.set(callId, { ...current, end: Date.now() })
}

export function getToolDuration(callId: string): number | null {
  const entry = durationTrack.get(callId)
  if (!entry) return null
  return (entry.end ?? Date.now()) - entry.start
}

export function useToolDuration(callId: string, running: boolean): string {
  const [, force] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [running])
  const ms = getToolDuration(callId)
  return ms === null ? '' : formatElapsed(ms)
}
