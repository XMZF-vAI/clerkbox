/**
 * 一轮助手的会话流（照抄 ZCode 的时间线层级）：思考行 / 正文段 / 工具行按自然顺序平铺，
 * 连续只读工具聚成查阅组、连续命令聚成终端组；没有回合级折叠头（ZCode 完成态也全行可见）。
 *
 * 特殊卡片（子代理 / 权限留痕 / 压缩摘要 / 通知条等）原样透传 MessageItem。
 * 轮尾保留 ClerkBox 既有功能：整轮复制、缓存统计、截断警告、中止轮的文件差异 chips。
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Message } from '../../types/agent'
import { MarkdownContent } from './MarkdownContent'
import MessageItem from './MessageItem'
import { CopyButton, MessageActions } from './MessageActions'
import { ReasoningRow } from './ReasoningRow'
import { StreamingToolRow, ToolCallRow } from './ToolCallRow'
import { ToolGroupRow } from './ToolGroupRow'
import { buildStreamRows } from './stream-rows'
import { parseEditDiff, type EditDiffMetaView } from './tool-renderers/shared'
import Modal from '../ui/Modal'

const fileBase = (p: string) => p.split(/[\\/]/).pop() || p

/** 文件差异 chips：中止轮收尾时聚合各文件增删行数，悬停弹出 diff 预览（沿用既有实现） */
function DiffChips({ metas, vibe }: { metas: EditDiffMetaView[]; vibe?: boolean }) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<{ meta: EditDiffMetaView; x: number; top?: number; bottom?: number } | null>(null)
  const [selectedDiff, setSelectedDiff] = useState<EditDiffMetaView | null>(null)
  const previewId = useId()

  useEffect(() => {
    if (!preview) return
    const dismiss = () => setPreview(null)
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [preview !== null])

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
  const closePreview = (path: string) => () => setPreview((cur) => (cur?.meta.path === path ? null : cur))

  return (
    <div className={`mt-1 flex max-w-full flex-wrap gap-1.5 border-t pt-2 ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/[0.06]'}`}>
      {metas.map((m, i) => (
        <span key={m.path} className="relative" onMouseEnter={openPreview(m)} onMouseLeave={closePreview(m.path)}>
          <button
            type="button"
            aria-label={t('chat.diffPreviewLabel', { file: fileBase(m.path) })}
            aria-describedby={preview?.meta.path === m.path ? previewId : undefined}
            aria-haspopup="dialog"
            onFocus={openPreview(m)}
            onBlur={closePreview(m.path)}
            onClick={() => { setPreview(null); setSelectedDiff(m) }}
            className={`md-focus inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md3-xs px-2 font-mono text-ui-xs transition-colors duration-100 animate-pop-in max-md:min-h-11 ${
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
          id={previewId}
          role="tooltip"
          className={`pointer-events-none fixed z-50 w-80 max-w-[calc(100vw-1.5rem)] max-h-[60dvh] overflow-hidden rounded-md3-md border shadow-elevation-3 ${
            vibe ? 'border-white/15 bg-dark-surfaceContainerHighest/95 backdrop-blur-xl' : 'border-dark-onSurfaceVariant/15 bg-dark-surfaceContainerHighest'
          }`}
          style={{
            left: preview.x,
            top: preview.top,
            bottom: preview.bottom,
            animation: 'popIn 160ms cubic-bezier(0.23,1,0.32,1) both',
            transformOrigin: preview.top === undefined ? 'bottom left' : 'top left',
          }}
        >
          <div className={`flex items-center justify-between border-b px-2.5 py-1.5 font-mono text-ui-xs ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'}`}>
            <span className={`min-w-0 truncate ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/70'}`} title={preview.meta.path}>
              {fileBase(preview.meta.path)}
            </span>
            <span className="shrink-0 tabular-nums">
              {preview.meta.added > 0 && <span className="text-md-success"> +{preview.meta.added}</span>}
              {preview.meta.removed > 0 && <span className="text-md-error"> −{preview.meta.removed}</span>}
            </span>
          </div>
          <div className="py-1 font-mono text-ui-xs leading-relaxed">
            {preview.meta.lines.slice(0, 16).map((line, i) => (
              <div
                key={i}
                className={`flex gap-2 px-2.5 whitespace-pre ${
                  line.tone === 'add' ? 'bg-md-success/10 text-md-success'
                  : line.tone === 'del' ? 'bg-md-error/10 text-md-error'
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
      {selectedDiff && (
        <Modal title={t('chat.diffPreviewLabel', { file: fileBase(selectedDiff.path) })}
          description={selectedDiff.path} onClose={() => setSelectedDiff(null)} widthClass="w-[800px]"
          bodyClassName="p-0">
          <div className="min-w-0 overflow-x-auto py-3 font-mono text-ui-xs leading-relaxed">
            {selectedDiff.lines.map((line, index) => (
              <div key={index} className={`flex min-w-max gap-3 whitespace-pre px-4 py-0.5 ${line.tone === 'add' ? 'bg-md-success/10 text-md-success' : line.tone === 'del' ? 'bg-md-error/10 text-md-error' : 'text-dark-onSurfaceVariant'}`}>
                <span aria-hidden className="w-3 shrink-0 select-none">{line.tone === 'add' ? '+' : line.tone === 'del' ? '−' : ' '}</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}

interface AssistantTurnStreamProps {
  messages: Message[]
  vibe?: boolean
  sessionId?: string
}

export function AssistantTurnStream({ messages, vibe, sessionId }: AssistantTurnStreamProps) {
  const { t } = useTranslation()
  const rows = useMemo(() => buildStreamRows(messages), [messages])

  // 轮尾元信息锚定最后一条「正常助手消息」（特殊卡片不算最终回复）
  const finalAssistant = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!
      if (m.role === 'assistant' && !m.isSubAgentCard && !m.isCompactSummary && !m.collapsed && !m._isCompacting && !m._retrying) return m
    }
    return null
  }, [messages])

  // 整轮复制口径不变：一轮可能分几段说话，多段时复制整轮合并文本
  const turnText = useMemo(
    () => messages
      .filter((m) => m.role === 'assistant' && !m.isSubAgentCard && !!m.content.trim())
      .map((m) => m.content.trim())
      .join('\n\n'),
    [messages],
  )
  const finalContent = finalAssistant?.content.trim() ?? ''
  const mergedIsMoreThanFinal = turnText.trim() !== finalContent

  // 中止轮（最终消息带工具且已完成）才显示文件差异 chips —— 与旧 ToolRunGroup 同一触发口径
  const diffMetas = useMemo(() => {
    if (!finalAssistant?.toolCalls?.length || !finalAssistant.finishReason) return []
    const byPath = new Map<string, EditDiffMetaView>()
    for (const r of finalAssistant.toolResults || []) {
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
  }, [finalAssistant])

  const cacheReadTokens = finalAssistant?.usage?.cache_read_input_tokens ?? 0
  const cacheCreatedTokens = finalAssistant?.usage?.cache_creation_input_tokens ?? 0
  const cacheEligibleTokens = cacheReadTokens + cacheCreatedTokens
  const cacheHitRate = cacheCreatedTokens > 0
    ? Math.round(cacheReadTokens / cacheEligibleTokens * 100)
    : finalAssistant?.usage?.prompt_tokens
      ? Math.round(cacheReadTokens / finalAssistant.usage.prompt_tokens * 100)
      : 0
  const isTruncated = finalAssistant?.finishReason === 'length'

  if (rows.length === 0) return null

  return (
    <div className="message-action-scope flex w-full min-w-0 flex-col gap-4">
      {rows.map((row) => {
        switch (row.kind) {
          case 'thinking':
            return <ReasoningRow key={row.key} message={row.message} vibe={vibe} />
          case 'text':
            return (
              <div key={row.key} className={`min-w-0 break-words py-1 text-ui-sm leading-relaxed ${vibe ? 'text-white/90' : 'text-dark-onSurface'}`}>
                <MarkdownContent content={row.message.content} vibe={vibe} />
              </div>
            )
          case 'tool':
            return <ToolCallRow key={row.key} item={row.item} vibe={vibe} sessionId={sessionId} />
          case 'streamingTool':
            return <StreamingToolRow key={row.key} call={row.call} vibe={vibe} />
          case 'exploreGroup':
          case 'executeGroup':
            return <ToolGroupRow key={row.key} kind={row.kind === 'exploreGroup' ? 'explore' : 'execute'} items={row.items} vibe={vibe} sessionId={sessionId} />
          case 'special':
            return <MessageItem key={row.key} message={row.message} vibe={vibe} sessionId={sessionId} />
        }
      })}

      {/* 轮尾：文件差异（中止轮）+ 截断警告 + 缓存统计 + 整轮复制 */}
      {diffMetas.length > 0 && <DiffChips metas={diffMetas} vibe={vibe} />}
      {isTruncated && (
        <div className="flex items-center gap-1.5 pl-0.5 text-ui-xs text-md-warning">
          <AlertTriangle size={10} />
          {t('chat.truncated')}
        </div>
      )}
      {cacheEligibleTokens > 0 && (
        <span className={`pl-0.5 text-ui-xs ${vibe ? 'text-white/65' : 'text-dark-onSurfaceVariant/80'}`}>
          {t('chat.cacheStats', {
            rate: cacheHitRate,
            read: cacheReadTokens.toLocaleString(),
            created: cacheCreatedTokens.toLocaleString(),
          })}
        </span>
      )}
      {turnText.trim() && (
        <MessageActions vibe={vibe} className="pl-0.5">
          <CopyButton
            text={mergedIsMoreThanFinal ? turnText : finalContent}
            title={mergedIsMoreThanFinal ? t('chat.copyTurn') : undefined}
            vibe={vibe}
          />
        </MessageActions>
      )}
    </div>
  )
}
