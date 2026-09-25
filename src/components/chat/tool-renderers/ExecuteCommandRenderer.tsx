import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { ToolBadge, ToolCopyButton, ToolDetailPanel, MonoBlock, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import { parseCommandResult, takeLines } from './shared'
import type { ToolRendererProps } from './resolveRenderer'

export default function ExecuteCommandRenderer({ call, result, isError, args, vibe = false }: ToolRendererProps) {
  const { t } = useTranslation()
  const running = !result
  const duration = useToolDuration(call.id, running)
  const command = String(args.command ?? '')
  const cwd = args.cwd ? String(args.cwd) : ''

  if (running) return <ToolSkeleton vibe={vibe} lines={3} />

  const content = result?.content ?? ''
  const meta = parseCommandResult(content)
  const stdout = takeLines(meta.stdout)
  const stderr = takeLines(meta.stderr)

  return (
    <ToolDetailPanel vibe={vibe}>
      <div className="flex items-start gap-1">
        <div className={`min-w-0 flex-1 font-mono text-xs break-all ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`}>
          <span className="opacity-60">$ </span>
          {command || t('toolRenderer.emptyCommand')}
          {cwd && <span className="ml-2 opacity-60">({cwd})</span>}
        </div>
        {command && <ToolCopyButton text={command} vibe={vibe} />}
      </div>

      {stdout.lines.length > 0 && (
        <MonoBlock text={stdout.lines.join('\n')} vibe={vibe} />
      )}
      {stdout.hidden > 0 && (
        <span className="opacity-60 text-xs">{t('toolRenderer.hiddenLines', { count: stdout.hidden })}</span>
      )}
      {stdout.lines.length === 0 && stderr.lines.length === 0 && !isError && (
        <span className="opacity-60 text-xs">{t('toolRenderer.noOutput')}</span>
      )}

      {stderr.lines.length > 0 && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          <span className="text-xs text-md-error">{t('toolRenderer.standardError')}</span>
          {takeLines(stderr.lines.join('\n'), 10).lines.map((line, i) => (
            <span key={i} title={line} className="truncate font-mono text-xs text-md-error">
              {line}
            </span>
          ))}
        </div>
      )}

      <ToolStatusLine vibe={vibe}>
        {meta.exitCode !== null && meta.exitCode === 0 && <ToolBadge tone="success">exit 0</ToolBadge>}
        {meta.exitCode !== null && meta.exitCode !== 0 && <ToolBadge tone="error">exit {meta.exitCode}</ToolBadge>}
        {meta.timedOut && <ToolBadge tone="warning">{t('toolRenderer.timedOut')}</ToolBadge>}
        {meta.encodingFallback && <ToolBadge tone="info">GBK→UTF-8</ToolBadge>}
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
