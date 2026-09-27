import { useTranslation } from 'react-i18next'
import { AlertTriangle, LayoutGrid } from 'lucide-react'
import { MonoBlock, ToolBadge, ToolDetailPanel, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import { parseAppResult, takeLines } from './shared'
import type { ToolRendererProps } from './resolveRenderer'

/**
 * app_* 自我管控工具的渲染器。
 * 结果是纯文本（app-tools.ts 不产出结构化载荷——ToolResult 只有 content 一个字段），
 * 所以靠 shared.ts 的 parseAppResult 剥掉头部计数标记，剩余正文当等宽块展示。
 * `[...N chars omitted...]` / `[App output truncated ...]` 这类技术标记原样保留在正文里，
 * 与 execute_command 的 `[Output truncated: ...]` 同一口径。
 */
export default function AppRenderer({ call, result, isError, vibe = false }: ToolRendererProps) {
  const { t } = useTranslation()
  const running = !result
  const duration = useToolDuration(call.id, running)

  if (running) return <ToolSkeleton vibe={vibe} lines={3} />

  const content = result?.content ?? ''
  const meta = parseAppResult(content)
  const body = meta.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const preview = takeLines(body)

  return (
    <ToolDetailPanel vibe={vibe}>
      <span className={`inline-flex items-center gap-1 text-xs ${vibe ? 'text-white/70' : 'text-dark-onSurfaceVariant'}`}>
        <LayoutGrid size={11} />
        {t(`tools.${call.name}`, { defaultValue: call.name })}
      </span>

      {isError ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-md-error">{content}</pre>
      ) : (
        <MonoBlock text={preview.lines.join('\n')} vibe={vibe} />
      )}

      <ToolStatusLine vibe={vibe}>
        {meta.count && <ToolBadge tone="info">{meta.count}</ToolBadge>}
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
