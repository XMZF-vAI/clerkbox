/**
 * 工作流泳道图（确认窗的静态图 + 运行中的实时看板，同一份渲染）。
 *
 * 纯 DOM + 一层 SVG：SVG 只画轨道（直角折线），站、药丸、灯都是普通元素——文字不该
 * 进 SVG，否则截断、字体缩放、vibe 主题全要重写一遍。
 *
 * 视觉口径取自 ZCode 的 `components/workflow-timeline`（站宽 168 / 站距 24 / 药丸最多
 * 5 枚 + 「还有 N 个」），但**只抄机制不抄视觉**：颜色一律走 md-* token，字号走 text-ui-*。
 *
 * 诚实边界：这张图来自脚本的静态扫描（见 workflow-graph.ts），条件分支按字面路径画；
 * 运行中用实况快照覆盖同一批站与药丸。
 */
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Check, Loader2, X } from 'lucide-react'
import type { WorkflowGraphView, WorkflowGraphViewPhase, WorkflowNodeStatus } from '../../../lib/workflow-graph'

/** 站宽 / 站距 / 灯心（与 ZCode 设计画布同值） */
const STATION_WIDTH = 168
const STATION_GAP = 24
const STATION_PITCH = STATION_WIDTH + STATION_GAP
const MARK_X = 8
const RAIL_Y = 34
const LANE_GAP = 8
const RAIL_ROW = 44
/** 一列最多摊开的药丸数；其余折成「还有 N 个」 */
const MAX_PILLS = 5

/** 药丸头像色：按名字散列，**仅用于区分**，没有任何语义 */
const TONE_CLASS = ['bg-md-primary', 'bg-md-success', 'bg-md-warning', 'bg-md-tertiary'] as const

function dotClass(status: WorkflowNodeStatus, vibe: boolean): string {
  switch (status) {
    case 'running':
      return 'bg-md-warning ring-2 ring-md-warning/25 animate-pulse'
    case 'completed':
      return 'bg-md-success'
    case 'failed':
    case 'aborted':
      return 'bg-md-error'
    default:
      // 空心站：确认窗里全部是这一种；运行中 = 还没到
      return vibe ? 'border border-white/35 bg-transparent' : 'border border-dark-onSurfaceVariant/40 bg-transparent'
  }
}

function railPath(x1: number, x2: number, y: number, y0: number): string {
  if (y === y0) return `M ${x1} ${y0} L ${x2} ${y0}`
  const r = 4
  return `M ${x1} ${y0} L ${x1} ${y + r} Q ${x1} ${y} ${x1 + r} ${y} L ${x2 - r} ${y} Q ${x2} ${y} ${x2} ${y + r} L ${x2} ${y0}`
}

function Pill({ node, vibe }: { node: WorkflowGraphViewPhase['nodes'][number]; vibe: boolean }) {
  const surface = vibe ? 'bg-white/10' : 'bg-dark-surfaceContainerHigh'
  const text = vibe ? 'text-white/80' : 'text-dark-onSurface/80'
  return (
    <div className={`flex w-full items-center gap-1.5 rounded-full px-2 py-1 ${surface}`} title={node.name}>
      <span className={`size-2 shrink-0 rounded-full ${TONE_CLASS[node.tone % TONE_CLASS.length]}`} aria-hidden />
      <span className={`min-w-0 truncate text-ui-xs ${text}`}>{node.name}</span>
      {node.status === 'running' && <Loader2 size={11} className="ml-auto shrink-0 animate-spin text-md-warning" aria-hidden />}
      {node.status === 'completed' && <Check size={11} className={`ml-auto shrink-0 ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/45'}`} />}
      {(node.status === 'failed' || node.status === 'aborted') && <X size={11} className="ml-auto shrink-0 text-md-error" />}
    </div>
  )
}

export function WorkflowGraph({ view, vibe = false }: { view: WorkflowGraphView; vibe?: boolean }) {
  const { t } = useTranslation()
  if (view.phases.length === 0) return null

  const count = view.phases.length
  const width = count * STATION_WIDTH + (count - 1) * STATION_GAP
  const railStroke = vibe ? 'stroke-white/20' : 'stroke-dark-onSurfaceVariant/25'

  return (
    <div
      className="overflow-x-auto"
      role="img"
      aria-label={t('toolRenderer.workflowGraphAria', { phases: count, steps: view.totalSteps })}
    >
      <div className="relative flex gap-6" style={{ width }}>
        {/* 轨道层：只画线，不承载任何文字 */}
        <svg
          className="pointer-events-none absolute left-0 top-0"
          width={width}
          height={RAIL_ROW}
          aria-hidden
        >
          {view.phases.map((phase, index) => {
            const x1 = index * STATION_PITCH + MARK_X
            const x2 = (index + 1) * STATION_PITCH + MARK_X
            if (index === count - 1) return null
            const lanes = Math.min(3, Math.max(0, phase.lanes))
            return (
              <g key={`rail-${index}`}>
                {Array.from({ length: lanes }, (_, lane) => (
                  <path
                    key={lane}
                    d={railPath(x1, x2, RAIL_Y - (lane + 1) * LANE_GAP, RAIL_Y)}
                    className={`${railStroke} fill-none`}
                    strokeWidth={1}
                  />
                ))}
                <path d={railPath(x1, x2, RAIL_Y, RAIL_Y)} className={`${railStroke} fill-none`} strokeWidth={1} />
              </g>
            )
          })}
        </svg>

        {view.phases.map((phase, index) => {
          const overflow = phase.nodes.length - MAX_PILLS
          const label = phase.name || t('toolRenderer.workflowUngrouped')
          return (
            <div key={`${phase.name}-${index}`} className="relative z-10 flex flex-col gap-1.5" style={{ width: STATION_WIDTH }}>
              <div className="relative" style={{ height: RAIL_ROW }}>
                <span
                  className={`absolute size-2.5 rounded-full ${dotClass(phase.status, vibe)}`}
                  style={{ left: MARK_X - 5, top: RAIL_Y - 5 }}
                  aria-hidden
                />
              </div>
              <div className="flex min-w-0 items-baseline gap-1">
                <span
                  className={`min-w-0 truncate text-ui-xs ${vibe ? 'text-white/70' : 'text-dark-onSurface/75'}`}
                  title={label}
                >
                  {label}
                </span>
                {phase.total > 0 && (
                  <span className={`shrink-0 font-mono text-ui-xs tabular-nums ${vibe ? 'text-white/45' : 'text-dark-onSurfaceVariant/50'}`}>
                    {phase.done}/{phase.total}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {phase.nodes.slice(0, MAX_PILLS).map((node, nodeIndex) => (
                  <Pill key={`${node.name}-${nodeIndex}`} node={node} vibe={vibe} />
                ))}
                {overflow > 0 && (
                  <div className={`flex w-full items-center gap-1.5 rounded-full px-2 py-1 ${vibe ? 'bg-white/10' : 'bg-dark-surfaceContainerHigh'}`}>
                    <span className="flex shrink-0 -space-x-1" aria-hidden>
                      {phase.nodes.slice(MAX_PILLS, MAX_PILLS + 3).map((node, dotIndex) => (
                        <span
                          key={`dot-${dotIndex}`}
                          className={`size-2.5 rounded-full ring-1 ${TONE_CLASS[node.tone % TONE_CLASS.length]} ${vibe ? 'ring-white/20' : 'ring-dark-surfaceContainerHigh'}`}
                        />
                      ))}
                    </span>
                    <span className={`min-w-0 truncate text-ui-xs ${vibe ? 'text-white/55' : 'text-dark-onSurfaceVariant/60'}`}>
                      {t('toolRenderer.workflowMore', { count: overflow })}
                    </span>
                    <ArrowUpRight size={11} className={`ml-auto shrink-0 ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/45'}`} />
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default WorkflowGraph
