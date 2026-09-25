import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { MonoBlock, ToolBadge, ToolCopyButton, ToolDetailPanel, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import { fileBase, parseReadResult, takeLines } from './shared'
import type { ToolRendererProps } from './resolveRenderer'

export default function ReadFileRenderer({ call, result, isError, args, vibe = false }: ToolRendererProps) {
  const { t } = useTranslation()
  const running = !result
  const duration = useToolDuration(call.id, running)
  const path = String(args.path ?? '')

  if (running) return <ToolSkeleton vibe={vibe} lines={3} />

  const content = result?.content ?? ''
  const meta = parseReadResult(content)
  const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? Number(args.offset) : 1
  const preview = takeLines(meta.lines.map((l) => (l.no === null ? l.text : `${l.no}│${l.text}`)).join('\n'), 80)

  return (
    <ToolDetailPanel vibe={vibe}>
      <div className="flex items-start gap-1">
        <span
          title={path}
          className={`min-w-0 flex-1 font-mono text-xs break-all ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`}
        >
          {fileBase(path) || t('toolRenderer.unknownTarget')}
        </span>
        {path && <ToolCopyButton text={path} vibe={vibe} />}
      </div>
      {isError ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-md-error">{content}</pre>
      ) : (
        <MonoBlock text={preview.lines.join('\n')} vibe={vibe} />
      )}
      <ToolStatusLine vibe={vibe}>
        {meta.startLine !== null && meta.endLine !== null && (
          <ToolBadge tone="info">L{meta.startLine}–L{meta.endLine}</ToolBadge>
        )}
        {meta.lineCount > 0 && <span>{t('toolRenderer.lineCount', { count: meta.lineCount })}</span>}
        {meta.lineCount === 0 && !isError && offset > 1 && (
          <span className="opacity-70">{t('toolRenderer.rereadStub')}</span>
        )}
        {isError && (
          <span className="inline-flex items-center gap-1 text-xs text-md-error">
            <AlertTriangle size={11} />
            {t('toolRenderer.failed')}
          </span>
        )}
        {duration && <span>{duration}</span>}
      </ToolStatusLine>
      {preview.hidden > 0 && (
        <span className="opacity-60 text-xs">{t('toolRenderer.hiddenLines', { count: preview.hidden })}</span>
      )}
    </ToolDetailPanel>
  )
}
