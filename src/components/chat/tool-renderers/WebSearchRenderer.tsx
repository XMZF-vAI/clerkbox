import { useTranslation } from 'react-i18next'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { MonoBlock, ToolDetailPanel, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import { parseSearchResults } from './shared'
import type { ToolRendererProps } from './resolveRenderer'

export default function WebSearchRenderer({ call, result, isError, args, vibe = false }: ToolRendererProps) {
  const { t } = useTranslation()
  const running = !result
  const duration = useToolDuration(call.id, running)
  const query = String(args.query ?? '')

  if (running) return <ToolSkeleton vibe={vibe} lines={3} />

  const content = result?.content ?? ''
  const hits = parseSearchResults(content)

  return (
    <ToolDetailPanel vibe={vibe}>
      {query && (
        <span className={`truncate font-mono text-xs ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`} title={query}>
          {query}
        </span>
      )}
      {isError && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-md-error">{content}</pre>
      )}
      {!isError && hits.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {hits.map((hit) => (
            <li key={`${hit.index}-${hit.url}`} className="min-w-0">
              <div className="flex items-start gap-1">
                <span className={`min-w-0 flex-1 truncate text-xs font-medium ${vibe ? 'text-white/90' : 'text-dark-onSurface/90'}`}>
                  {hit.title}
                </span>
                {hit.url && (
                  <a
                    href={hit.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={hit.url}
                    aria-label={hit.url}
                    className="shrink-0 text-md-primary hover:opacity-80"
                  >
                    <ExternalLink size={11} />
                  </a>
                )}
              </div>
              {hit.snippet && (
                <span className={`line-clamp-2 text-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/60'}`}>
                  {hit.snippet}
                </span>
              )}
              {hit.url && (
                <span className="block truncate font-mono text-xs opacity-50">{hit.url}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {!isError && hits.length === 0 && <MonoBlock text={content} vibe={vibe} />}
      <ToolStatusLine vibe={vibe}>
        {hits.length > 0 && <span>{t('toolRenderer.hitCount', { count: hits.length })}</span>}
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
