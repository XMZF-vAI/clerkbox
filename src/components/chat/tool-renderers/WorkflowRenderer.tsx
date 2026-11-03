/**
 * create_workflow 渲染器：后台运行 = 实时看板 + 停止按钮，结束后 = 终态图 + 步骤明细。
 *
 * 数据面有三层，优先级从高到低：
 *  1. workflow-runs-store 里的实况快照（运行中每步一帧，键=toolCallId）；
 *  2. 工具结果里的 __WORKFLOW_RUN__ 尾巴（settle 时更新落库，发模型前已剥离）；
 *  3. 脚本静态分析出的静态图（确认那一刻就已经画过，运行前先顶住画面）。
 *
 * v2 后台语义下尾巴有两种含义：status='running' 的启动快照（工具立即返回时写入，
 * 实况以 store 为准）与终态快照（settle 时换上）。尾巴 running 而 store 已终态是
 * 「消息落库竞态」的正常窗口——store 优先，消息更新到达后自然切换。
 * 三层都收敛到同一个视图模型（workflow-graph 的 buildWorkflowGraphView*），所以
 * 「确认窗里的图」「运行中的图」「终态的图」是同一张图的三个状态，不是三套实现。
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, CircleCheck, CircleX, CircleDashed, Loader2, Square } from 'lucide-react'
import { MonoBlock, ToolDetailPanel, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import type { ToolRendererProps } from './resolveRenderer'
import { parseWorkflowRunTail, type WorkflowRunTail, type WorkflowStepStatus } from '../../../lib/workflow-runtime'
import { analyzeWorkflowScript, buildWorkflowGraphView, buildWorkflowGraphViewFromTail } from '../../../lib/workflow-graph'
import { useWorkflowRunsStore } from '../../../stores/workflow-runs-store'
import { stopWorkflowRunControlled } from '../../../lib/workflow-control'
import { MarkdownContent } from '../MarkdownContent'
import { WorkflowGraph } from './WorkflowGraph'

const STATUS_ICON: Record<WorkflowStepStatus, typeof CircleCheck> = {
  completed: CircleCheck,
  failed: CircleX,
  aborted: CircleX,
  running: Loader2,
}

function StepRow({ step, vibe, cachedLabel }: { step: WorkflowRunTail['steps'][0]; vibe: boolean; cachedLabel: string }) {
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
        <span className={`shrink-0 text-ui-xs font-medium ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`}>{step.cached ? '⚡ ' : ''}{step.name}</span>
        {step.cached && <span className={`shrink-0 text-ui-xs ${vibe ? 'text-white/45' : 'text-dark-onSurfaceVariant/50'}`}>{cachedLabel}</span>}
        {seconds && <span className={`shrink-0 font-mono text-ui-xs tabular-nums opacity-60 ${spinning ? 'animate-pulse' : ''}`}>{seconds}</span>}
        {step.status === 'failed' && <span className="shrink-0 text-ui-xs text-md-error">{step.excerpt ?? ''}</span>}
      </div>
      {step.status !== 'failed' && step.excerpt && (
        <span className={`line-clamp-2 pl-[18px] text-ui-xs ${vibe ? 'text-white/55' : 'text-dark-onSurfaceVariant/60'}`} title={step.excerpt}>
          {step.excerpt}
        </span>
      )}
    </div>
  )
}

export default function WorkflowRenderer({ call, result, isError, args, vibe = false, sessionId }: ToolRendererProps) {
  const { t } = useTranslation()
  const [scriptOpen, setScriptOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const running = !result
  const duration = useToolDuration(call.id, running)
  const name = String(args.name ?? '')
  const script = String(args.script ?? '')

  const graph = useMemo(() => analyzeWorkflowScript(script), [script])
  // 运行中的实时快照：只订阅自己这一格，流式期间不跟着整张 store 重渲染
  const progress = useWorkflowRunsStore((s) => s.byToolCall[call.id])
  const content = result?.content ?? ''
  const { run } = useMemo(() => parseWorkflowRunTail(content), [content])
  // v2 后台：工具立即返回，尾巴带着 running 快照——看板常驻、结果经通知回流
  const backgroundRunning = run?.status === 'running'

  const view = useMemo(() => {
    if (backgroundRunning) {
      // 实况优先；store 缺席（重启后未水合）退回静态图，等恢复侧补尾巴
      if (progress) return buildWorkflowGraphView(graph, progress)
      return buildWorkflowGraphView(graph)
    }
    if (run) return buildWorkflowGraphViewFromTail(graph, run)
    if (progress) return buildWorkflowGraphView(graph, progress)
    return buildWorkflowGraphView(graph)
  }, [backgroundRunning, graph, progress, run])

  // 还没有任何实况、也没有结果：保持骨架（脚本可能还没开始跑）
  if (running && !progress) return <ToolSkeleton vibe={vibe} lines={3} />

  const working = progress?.steps.filter((step) => step.status === 'running').length ?? 0

  const handleStop = async () => {
    if (!run?.runId || stopping) return
    setStopping(true)
    try {
      await stopWorkflowRunControlled(run.runId, sessionId ?? '')
    } finally {
      setStopping(false)
    }
  }

  return (
    <ToolDetailPanel vibe={vibe}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={`shrink-0 text-ui-xs font-medium ${vibe ? 'text-white/85' : 'text-dark-onSurface/85'}`}>
          {running || backgroundRunning ? t('toolRenderer.workflowRunning') : t('toolRenderer.workflowTitle')}
        </span>
        {name && <span className={`min-w-0 truncate text-ui-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/60'}`} title={name}>{name}</span>}
        {run?.resumedFrom && (
          <span className={`shrink-0 text-ui-xs ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/55'}`} title={run.resumedFrom}>
            {t('toolRenderer.workflowResumedFrom')}
          </span>
        )}
        <span className={`ml-auto shrink-0 text-ui-xs ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/55'}`}>
          {t('toolRenderer.workflowPhaseCount', { count: view.phases.length })}
          {(running || backgroundRunning) && working > 0 && ` · ${t('toolRenderer.workflowAgentsWorking', { count: working })}`}
        </span>
        {backgroundRunning && (
          <button
            type="button"
            onClick={handleStop}
            disabled={stopping}
            title={t('toolRenderer.workflowStop')}
            aria-label={t('toolRenderer.workflowStop')}
            className={`shrink-0 rounded-md3-xs p-0.5 transition-colors disabled:opacity-50 ${
              vibe
                ? 'text-white/55 hover:bg-white/10 hover:text-white/90'
                : 'text-dark-onSurfaceVariant/60 hover:bg-dark-surfaceContainerHigh hover:text-md-error'
            }`}
          >
            {stopping ? <Loader2 size={11} className="animate-spin" /> : <Square size={11} />}
          </button>
        )}
      </div>

      <div className="py-1.5">
        <WorkflowGraph view={view} vibe={vibe} />
      </div>

      {run && !backgroundRunning && (
        <>
          <div className="flex flex-col gap-1.5">
            {run.steps.map((step) => <StepRow key={step.key} step={step} vibe={vibe} cachedLabel={t('toolRenderer.workflowCached')} />)}
          </div>
          {run.status === 'failed' && run.error && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs text-md-error">{run.error}</pre>
          )}
          {/* 工作流的最终产出通常是一份带标题/列表/表格的汇总报告，
              按 Markdown 渲染才有结构；容器限高内滚，不占满时间线 */}
          {run.status === 'completed' && run.result && (
            <div className={`max-h-56 overflow-y-auto rounded ${vibe ? 'text-white/80' : 'text-dark-onSurface/80'}`}>
              <MarkdownContent content={run.result} vibe={vibe} size="compact" />
            </div>
          )}
          <ToolStatusLine vibe={vibe}>
            <span>{t('toolRenderer.workflowStepCount', { count: run.steps.length })}</span>
            {run.status === 'aborted' && <span className="text-md-warning">{t('toolRenderer.workflowAborted')}</span>}
            {isError && <span className="text-md-error">{t('toolRenderer.failed')}</span>}
            {duration && <span>{duration}</span>}
          </ToolStatusLine>
        </>
      )}

      {backgroundRunning && progress && (
        <div className="flex flex-col gap-1.5">
          {progress.steps.map((step) => (
            <StepRow
              key={step.key}
              vibe={vibe}
              step={{
                key: step.key,
                name: step.name,
                phase: step.phase,
                status: step.status,
                agentId: undefined,
                excerpt: undefined,
                durationMs: step.endedAt ? step.endedAt - step.startedAt : undefined,
              }}
              cachedLabel={t('toolRenderer.workflowCached')}
            />
          ))}
          {progress.steps.length === 0 && (
            <span className={`text-ui-xs ${vibe ? 'text-white/55' : 'text-dark-onSurfaceVariant/60'}`}>
              {t('toolRenderer.workflowDispatching')}
            </span>
          )}
        </div>
      )}

      {!run && !running && (
        <span className={`text-ui-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/60'}`}>
          {isError ? t('toolRenderer.failed') : t('toolPreview.parsing')}
        </span>
      )}

      {/* 脚本折叠块：确认过的 SOP 是这张卡的证据本体，默认收起不占时间线 */}
      <button
        type="button"
        onClick={() => setScriptOpen(!scriptOpen)}
        aria-expanded={scriptOpen}
        className={`flex w-fit items-center gap-1 text-ui-xs transition-colors ${
          vibe ? 'text-white/50 hover:text-white/80' : 'text-dark-onSurfaceVariant/55 hover:text-dark-onSurface/85'
        }`}
      >
        <ChevronDown size={11} className={`transition-transform ${scriptOpen ? '' : '-rotate-90'}`} />
        {t('toolRenderer.workflowScript')}
      </button>
      {scriptOpen && <MonoBlock text={script} vibe={vibe} />}
    </ToolDetailPanel>
  )
}
