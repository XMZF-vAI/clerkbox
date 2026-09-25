import { useTranslation } from 'react-i18next'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { MonoBlock, ToolBadge, ToolDetailPanel, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import { formatBytes, takeLines } from './shared'
import type { ToolRendererProps } from './resolveRenderer'

export default function WebFetchRenderer({ call, result, isError, args, vibe = false }: ToolRendererProps) {
  const { t } = useTranslation()
  const running = !result
  const duration = useToolDuration(call.id, running)
  const url = String(args.url ?? '')

  if (running) return <ToolSkeleton vibe={vibe} lines={3} />

  const content = result?.content ?? ''
  const preview = takeLines(content, 60)

  return (
    <ToolDetailPanel vibe={vibe}>
      <div className="flex items-start gap-1">
        <span className={`min-w-0 flex-1 font-mono text-xs break-all ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`}>
          {url || t('toolRenderer.unknownTarget')}
        </span>
        {/^https?:\/\//.test(url) && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={url}
            aria-label={url}
            className="shrink-0 text-md-primary hover:opacity-80"
          >
            <ExternalLink size={11} />
          </a>
        )}
      </div>
      {isError ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-md-error">{content}</pre>
      ) : (
        <MonoBlock text={preview.lines.join('\n')} vibe={vibe} />
      )}
      <ToolStatusLine vibe={vibe}>
        {!isError && <ToolBadge tone="info">{formatBytes(content.length)}</ToolBadge>}
        {preview.hidden > 0 && <span>{t('toolRenderer.hiddenLines', { count: preview.hidden })}</span>}
        {isError && (
          <span className="inline-flex items-center gap-1 text-xs text-md-error">
            <AlertTriangle size={11} />
            {t('toolRenderer.failed')}
          </span>
        )}
        {duration && <span>{duration}</span>}
      </ToolStatusLine>
    </ToolDetailPanel>
  )
}
