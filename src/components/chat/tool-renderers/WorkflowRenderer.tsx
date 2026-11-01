/**
 * create_workflow 渲染器：脚本摘要 + 阶段/步骤状态表。
 *
 * 运行数据来自工具结果里的 __WORKFLOW_RUN__ UI 尾巴（发模型前已剥离，见
 * workflow-runtime.ts）；运行中（尚无结果）显示骨架——每个步骤自身是真实的
 * 子代理卡片，实时状态看卡片，这里只承担「工作流全貌」。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, CircleCheck, CircleX, CircleDashed, Loader2 } from 'lucide-react'
import { MonoBlock, ToolDetailPanel, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import type { ToolRendererProps } from './resolveRenderer'
import { parseWorkflowRunTail, type WorkflowRunTail, type WorkflowStepStatus } from '../../../lib/workflow-runtime'

const STATUS_ICON: Record<WorkflowStepStatus, typeof CircleCheck> = {
  completed: CircleCheck,
  failed: CircleX,
  aborted: CircleX,
  running: Loader2,
}

function StepRow({ step, vibe }: { step: WorkflowRunTail['steps'][0]; vibe: boolean }) {
  const Icon = STATUS_ICON[step.status] ?? CircleDashed
  const spinning = step.status === 'running'
  const tone = step.status === 'completed'
    ? 'text-md-success'
    : step.status === 'running'
      ? 'text-md-info'
      : 'text-md-error'
  const seconds = step.durationMs ? `${(step.durationMs / 1000).toFixed(1)}s` : ''
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <Icon size={12} className={`shrink-0 ${tone} ${spinning ? 'animate-spin' : ''}`} />
        <span className={`shrink-0 text-xs font-medium ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`}>{step.name}</span>
        {seconds && <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-60">{seconds}</span>}
        {step.status === 'failed' && <span className="shrink-0 text-[10px] text-md-error">{step.excerpt ?? ''}</span>}
      </div>
      {step.status !== 'failed' && step.excerpt && (
        <span className={`line-clamp-2 pl-[18px] text-xs ${vibe ? 'text-white/55' : 'text-dark-onSurfaceVariant/60'}`} title={step.excerpt}>
          {step.excerpt}
        </span>
      )}
    </div>
  )
}

export default function WorkflowRenderer({ call, result, isError, args, vibe = false }: ToolRendererProps) {
  const { t } = useTranslation()
  const [scriptOpen, setScriptOpen] = useState(false)
  const running = !result
  const duration = useToolDuration(call.id, running)
  const name = String(args.name ?? '')

  if (running) return <ToolSkeleton vibe={vibe} lines={3} />

  const content = result?.content ?? ''
  const { run } = parseWorkflowRunTail(content)

  return (
    <ToolDetailPanel vibe={vibe}>
      {run ? (
        <>
          {run.phases.length > 0 && (
            <span className={`text-xs ${vibe ? 'text-white/70' : 'text-dark-onSurfaceVariant/70'}`}>
              {run.phases.join(' → ')}
            </span>
          )}
          <div className="flex flex-col gap-1.5">
            {run.steps.map((step) => <StepRow key={step.key} step={step} vibe={vibe} />)}
          </div>
          {run.status === 'failed' && run.error && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-md-error">{run.error}</pre>
          )}
          {run.status === 'completed' && run.result && (
            <div className={`line-clamp-4 whitespace-pre-wrap break-words text-xs ${vibe ? 'text-white/75' : 'text-dark-onSurface/75'}`} title={run.result}>
              {run.result}
            </div>
          )}
          <ToolStatusLine vibe={vibe}>
            <span>{t('toolRenderer.workflowStepCount', { count: run.steps.length })}</span>
            {run.status === 'aborted' && <span className="text-md-warning">{t('toolRenderer.workflowAborted')}</span>}
            {isError && <span className="text-md-error">{t('toolRenderer.failed')}</span>}
            {duration && <span>{duration}</span>}
          </ToolStatusLine>
        </>
      ) : (
        <span className={`text-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/60'}`}>
          {isError ? t('toolRenderer.failed') : t('toolPreview.parsing')}
        </span>
      )}
      {/* 脚本折叠块：确认过的 SOP 是这张卡的证据本体，默认收起不占时间线 */}
      <button
        type="button"
        onClick={() => setScriptOpen(!scriptOpen)}
        aria-expanded={scriptOpen}
        className={`flex w-fit items-center gap-1 text-[11px] transition-colors ${
          vibe ? 'text-white/50 hover:text-white/80' : 'text-dark-onSurfaceVariant/55 hover:text-dark-onSurface/85'
        }`}
      >
        <ChevronDown size={11} className={`transition-transform ${scriptOpen ? '' : '-rotate-90'}`} />
        {t('toolRenderer.workflowScript')}
      </button>
      {scriptOpen && <MonoBlock text={String(args.script ?? '')} vibe={vibe} />}
      {!name && null}
    </ToolDetailPanel>
  )
}
