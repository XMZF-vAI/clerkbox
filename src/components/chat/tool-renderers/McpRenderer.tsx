import { useTranslation } from 'react-i18next'
import { AlertTriangle, Server } from 'lucide-react'
import { MonoBlock, ToolBadge, ToolDetailPanel, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import { splitMcpToolName, takeLines } from './shared'
import type { ToolRendererProps } from './resolveRenderer'

function toJsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export default function McpRenderer({ call, result, isError, args, vibe = false }: ToolRendererProps) {
  const { t } = useTranslation()
  const running = !result
  const duration = useToolDuration(call.id, running)
  const parsed = splitMcpToolName(call.name)

  if (running) return <ToolSkeleton vibe={vibe} />

  const content = result?.content ?? ''
  const argsPreview = takeLines(toJsonText(args), 20)
  const resultPreview = takeLines(content, 60)

  return (
    <ToolDetailPanel vibe={vibe}>
      <div className={`flex items-center gap-1.5 text-xs ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`}>
        <Server size={11} className="shrink-0 opacity-70" />
        <span className="min-w-0 truncate font-mono">{parsed?.server || t('toolRenderer.unknownTarget')}</span>
        {parsed?.tool && (
          <span className={`min-w-0 truncate opacity-70 ${vibe ? 'text-white/70' : 'text-dark-onSurfaceVariant/70'}`}>
            {parsed.tool}
          </span>
        )}
      </div>
      {argsPreview.lines.length > 0 && argsPreview.lines.join('\n') !== '{}' && (
        <>
          <span className="text-xs opacity-60">{t('toolRenderer.arguments')}</span>
          <MonoBlock text={argsPreview.lines.join('\n')} vibe={vibe} />
        </>
      )}
      {isError ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-md-error">{content}</pre>
      ) : (
        <MonoBlock text={resultPreview.lines.join('\n') || t('toolRenderer.noOutput')} vibe={vibe} />
      )}
      <ToolStatusLine vibe={vibe}>
        {resultPreview.hidden > 0 && <span>{t('toolRenderer.hiddenLines', { count: resultPreview.hidden })}</span>}
        {isError && (
          <span className="inline-flex items-center gap-1 text-xs text-md-error">
            <AlertTriangle size={11} />
            {t('toolRenderer.failed')}
          </span>
        )}
        {!isError && <ToolBadge tone="success">MCP</ToolBadge>}
        {duration && <span>{duration}</span>}
      </ToolStatusLine>
    </ToolDetailPanel>
  )
}
