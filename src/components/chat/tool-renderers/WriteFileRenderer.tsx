import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { DiffLineList, ToolBadge, ToolCopyButton, ToolDetailPanel, MonoBlock, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import { fileBase, parseEditDiff, stripEditDiff } from './shared'
import type { ToolRendererProps } from './resolveRenderer'

export default function WriteFileRenderer({ call, result, isError, args, vibe = false }: ToolRendererProps) {
  const { t } = useTranslation()
  const running = !result
  const duration = useToolDuration(call.id, running)
  const path = String(args.path ?? '')
  const contentLines = String(args.content ?? '').split('\n').length

  if (running) return <ToolSkeleton vibe={vibe} lines={2} />

  const raw = result?.content ?? ''
  const diff = !isError ? parseEditDiff(raw) : null
  const message = stripEditDiff(raw)

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
      {diff ? (
        <DiffLineList lines={diff.lines} vibe={vibe} />
      ) : (
        <MonoBlock text={message} vibe={vibe} />
      )}
      <ToolStatusLine vibe={vibe}>
        {diff && diff.added > 0 && <ToolBadge tone="success">+{diff.added}</ToolBadge>}
        {diff && diff.removed > 0 && <ToolBadge tone="error">−{diff.removed}</ToolBadge>}
        {!diff && contentLines > 1 && <span>{t('toolRenderer.lineCount', { count: contentLines })}</span>}
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
