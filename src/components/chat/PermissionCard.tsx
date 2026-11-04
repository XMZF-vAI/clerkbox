import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, Check, ChevronDown, ChevronRight, ChevronUp, Clock, GitBranch, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { DiffLineList } from './tool-renderers/ToolShell'
import { useChatStore } from '../../stores/chat-store'
import { agentClient } from '../../lib/agent-client'
import { isWebUIMode } from '../../lib/ipc-client'
import { usePermissionStore, resolveLocalPermission, type HostPermission, type LocalPermission } from '../../stores/permission-store'
import { useSettingsStore } from '../../stores/settings-store'
import { buildSuggestedRule } from '../../lib/permission-rules'
import { makeId } from '../../agent-core/loop'
import { ipc } from '../../lib/ipc-client'
import { computeEditDiff, type EditDiffMeta } from '../../lib/edit-diff'
import {
  buildPermissionPreview,
  decisionToScope,
  findPendingApprovalCall,
  formatPermissionAuditContent,
  type PermissionAuditRecord,
  type PermissionDecision,
  type PermissionRequestStatus,
  type PermissionRiskLevel,
} from '../../lib/permission-preview'
import { buildWorkflowGraphView } from '../../lib/workflow-graph'
import { WorkflowGraph } from './tool-renderers/WorkflowGraph'
import { MonoBlock } from './tool-renderers/ToolShell'

/**
 * 批次 D 定义的交互语义色（见 DESIGN.md §1.3）：ask=待审批、confirmation=危险确认。
 * surface/foreground 成对取用（对比度按整面对比设计，不再叠透明度），描边与强调块由前景派生。
 */
export const PERMISSION_TONES = {
  ask: {
    surface: 'bg-md-askSurface',
    border: 'border-md-askForeground/20',
    foreground: 'text-md-askForeground',
    accent: 'bg-md-askForeground/10',
  },
  confirmation: {
    surface: 'bg-md-confirmationSurface',
    border: 'border-md-confirmationForeground/25',
    foreground: 'text-md-confirmationForeground',
    accent: 'bg-md-confirmationForeground/10',
  },
} as const

const VIBE_TONE = {
  surface: 'bg-white/10',
  border: 'border-white/20',
  foreground: 'text-white/90',
  accent: 'bg-white/15',
} as const

type ToneSet = { surface: string; border: string; foreground: string; accent: string }

const RISK_ICON: Record<PermissionRiskLevel, typeof ShieldAlert> = {
  dangerous: ShieldAlert,
  warning: ShieldQuestion,
  info: ShieldCheck,
}

const DECISION_LABEL_KEY: Record<PermissionDecision, string> = {
  deny: 'chat.permission.resultDeny',
  deny_always: 'chat.permission.resultDenyAlways',
  allow_once: 'chat.permission.resultAllowOnce',
  allow_session: 'chat.permission.resultAllowAlways',
  allow_project: 'chat.permission.resultAllowProject',
}

function toneFor(risk: PermissionRiskLevel, vibe: boolean): ToneSet {
  if (vibe) return VIBE_TONE
  return risk === 'dangerous' ? PERMISSION_TONES.confirmation : PERMISSION_TONES.ask
}

/**
 * 选项顺序即语义（序号 = 键盘快捷键）：一次性 → 会话级 → 项目级 → 拒绝。
 * 项目级规则（allow_project / deny_always）只对可生成稳定 subject 的工具出现，
 * 危险命令、浏览器/桌面动作、工作流/MCP 一律裁掉（见 buildApprovalOptions）。
 */
const APPROVAL_OPTIONS: Array<{ decision: PermissionDecision; labelKey: string; Icon: typeof Check }> = [
  { decision: 'allow_once', labelKey: 'chat.permission.allowOnce', Icon: Check },
  { decision: 'allow_session', labelKey: 'chat.permission.allowAlways', Icon: ShieldCheck },
  { decision: 'allow_project', labelKey: 'chat.permission.allowProject', Icon: ShieldCheck },
  { decision: 'deny_always', labelKey: 'chat.permission.denyAlways', Icon: Ban },
  { decision: 'deny', labelKey: 'chat.permission.deny', Icon: Ban },
]

/** 是否允许该预览写出项目级规则（稳定 subject、非高危、非能力级授权） */
function supportsProjectRules(preview: { kind: string; risk: string }): boolean {
  if (preview.kind === 'command' && preview.risk === 'dangerous') return false
  return preview.kind === 'command' || preview.kind === 'file'
}

/**
 * 项目级决策 → 写一条持久规则（两张卡片共用）。规则数据存在渲染层的
 * settings persist 里：宿主模式（主进程）的 loop 用的是 run 命令下发的
 * settings 快照，下一轮 run 起就会命中；当前这次仍由 promise 放行/拒绝。
 */
function persistProjectRule(
  decision: PermissionDecision,
  target: { tool: string; args: Record<string, unknown>; workingDir: string }
): void {
  if (decision !== 'allow_project' && decision !== 'deny_always') return
  const rule = buildSuggestedRule(
    target,
    decision === 'allow_project' ? 'allow' : 'deny',
    target.workingDir
  )
  if (rule) useSettingsStore.getState().upsertPermissionRule(rule)
}

/**
 * 写文件 / 局部替换审批的变更预览：与执行期同一套 computeEditDiff——
 * 用户批准时看到的就是执行后将落盘的那份变更，而不是等宽路径串。
 * 读不到旧文件按「新文件」处理（全部新增）；读失败不阻塞审批（回落等宽预览）。
 */
function FileDiffPreview({ tool, path, args, vibe }: {
  tool: string
  path: string
  args: Record<string, unknown>
  vibe: boolean
}) {
  const { t } = useTranslation()
  const [diff, setDiff] = useState<EditDiffMeta | null>(null)
  const [newFile, setNewFile] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let oldText: string | null = null
      try {
        oldText = await ipc.readFile(path)
      } catch {
        oldText = null // 多半是新文件
      }
      if (cancelled) return
      try {
        if (tool === 'write_file') {
          const content = String(args.content ?? '')
          setNewFile(oldText === null)
          setDiff(computeEditDiff(path, oldText ?? '', content))
          return
        }
        // search_replace / edit_file：把编辑逐个应用到旧文，再对「应用后」做 diff
        const edits = Array.isArray(args.edits)
          ? (args.edits as Array<{ old_str?: unknown; new_str?: unknown }>)
          : [{ old_str: args.old_str, new_str: args.new_str }]
        if (oldText === null) {
          setNewFile(true)
          setDiff(null)
          return
        }
        let work = oldText
        for (const edit of edits) {
          const from = String(edit?.old_str ?? '')
          const to = String(edit?.new_str ?? '')
          if (from && work.includes(from)) work = work.split(from).join(to)
        }
        setNewFile(false)
        setDiff(computeEditDiff(path, oldText, work))
      } catch {
        setDiff(null)
      }
    })()
    return () => { cancelled = true }
  }, [tool, path, args])

  if (!diff) {
    return newFile ? (
      <div className={`rounded-md3-sm border px-3 py-2 text-ui-xs ${vibe ? 'border-white/20 text-white/70' : 'border-dark-onSurfaceVariant/20 text-dark-onSurfaceVariant/80'}`}>
        {t('chat.permission.fileDiffNew')}
      </div>
    ) : null
  }
  return (
    <div className="rounded-md3-sm border px-3 py-2">
      <div className={`mb-1 flex items-center gap-2 text-ui-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/70'}`}>
        <span>{newFile ? t('chat.permission.fileDiffNew') : t('chat.permission.fileDiffTitle')}</span>
        <span className="text-md-success">+{diff.added}</span>
        <span className="text-md-error">−{diff.removed}</span>
      </div>
      <DiffLineList lines={diff.lines} vibe={vibe} />
    </div>
  )
}

/**
 * 审批选项：**编号单选列表**，不是并排按钮。
 *
 * 为什么不是三个按钮：这是用户在做风险决策，不是填表。编号列表把
 * 「允许多久」和「允不允许」排在同一个可扫读的序列里，用户能在动作之前
 * 看清全部后果；三个并排按钮则把「允许一次」和「本会话始终允许」做成同权重的邻居，
 * 点错的代价不对称却看不出来。
 *
 * 交互：点一次选中，再点一次提交；1/2/3 直接提交；上下键移动；回车确认。
 * 默认停在「允许一次」—— 这是唯一无副作用的那个选项。
 */
function ApprovalOptionList({
  vibe,
  onResolve,
  options,
  hint,
}: {
  vibe: boolean
  onResolve: (decision: PermissionDecision) => () => void
  /** 审批选项（顺序即语义）。调用方按风险裁剪：危险命令不给「本会话始终允许」。 */
  options: Array<{ decision: PermissionDecision; label: string; Icon: typeof Check }>
  /** 选项区下方的补充说明（如危险命令的单次语义） */
  hint?: string
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<PermissionDecision>(options[0]?.decision ?? 'allow_once')

  const commit = (decision: PermissionDecision) => onResolve(decision)()

  return (
    <div
      role="listbox"
      aria-label={t('chat.permission.title')}
      className="border-t border-current/10 px-4 py-3"
      onKeyDown={(e) => {
        if (['1', '2', '3'].includes(e.key) && Number(e.key) <= options.length) {
          e.preventDefault()
          commit(options[Number(e.key) - 1]!.decision)
          return
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const delta = e.key === 'ArrowDown' ? 1 : -1
          setSelected((current) => {
            const index = options.findIndex((option) => option.decision === current)
            const next = (index + delta + options.length) % options.length
            return options[next]!.decision
          })
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          commit(selected)
        }
      }}
    >
      {options.map((option, index) => {
        const isSelected = option.decision === selected
        const Icon = option.Icon
        return (
          <button
            key={option.decision}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => (isSelected ? commit(option.decision) : setSelected(option.decision))}
            className={`flex w-full items-center gap-3 rounded-md3-sm px-3 py-2 text-left transition-colors focus-visible:outline-none ${
              isSelected
                ? vibe ? 'bg-white/15' : 'bg-dark-surfaceContainerHigh'
                : vibe ? 'hover:bg-white/8' : 'hover:bg-dark-surfaceContainerHigh/60'
            }`}
          >
            <span className={`w-4 shrink-0 self-center text-xs font-medium ${isSelected ? '' : 'opacity-55'}`}>{index + 1}</span>
            <Icon size={13} className="shrink-0 opacity-70" />
            <span className={`min-w-0 text-xs font-medium ${isSelected ? '' : 'opacity-75'}`}>{option.label}</span>
          </button>
        )
      })}
      <div className="mt-2 text-xs opacity-70">{hint ?? t('chat.permission.hint')}</div>
    </div>
  )
}

/**
 * 工作流确认卡（对标 ZCode `WorkflowPermissionBlock` 的版式，不变量一致）：
 * 表头问句 + 名字 + 右侧阶段数 → 并行度行 → 泳道流程图 → 脚本折叠 → 编号选项。
 *
 * 为什么值得单独一张卡：确认的对象不是一条命令或一个路径，而是**一整张编排**。
 * 只给五行脚本头，人没法判断「它到底会派几个子代理、分几段跑」——流程图把这件事
 * 一屏说清；脚本仍然可展开，证据没有被藏起来。
 */
function WorkflowPermissionCard({ request, onResolve, interactive = true, vibe = false }: PermissionCardProps) {
  const { t } = useTranslation()
  const { preview, status } = request
  const [scriptOpen, setScriptOpen] = useState(false)
  const graph = preview.graph
  const view = useMemo(() => (graph ? buildWorkflowGraphView(graph) : null), [graph])
  const name = preview.target
  const showActions = status === 'pending' && interactive
  const resolve = (decision: PermissionDecision) => () => onResolve?.(request.id, decision)

  const surface = vibe
    ? 'bg-white/10 border-white/20 text-white/90'
    : 'bg-dark-surfaceContainer border-dark-onSurfaceVariant/10 text-dark-onSurface'

  return (
    <section
      role="group"
      aria-label={t('chat.permission.title')}
      // min-h-0 + overflow-y-auto：卡片是消息列里的一个 flex 子项，内容（图 + 脚本）可能
      // 比剩余高度还高。不让自己滚，展开脚本后编号选项会被输入栏裁掉——用户就没法批了。
      className={`mx-4 mb-3 min-h-0 overflow-y-auto overflow-x-hidden rounded-md3-lg border shadow-sm animate-slide-up ${surface}`}
    >
      <div className={`flex items-center gap-1.5 px-4 pt-3 text-ui-xs ${vibe ? 'text-white/55' : 'text-dark-onSurfaceVariant/60'}`}>
        <ShieldQuestion size={12} className="shrink-0" />
        <span>{t('chat.permission.title')}</span>
      </div>

      <div className="flex items-start gap-2.5 px-4 pb-1 pt-1.5">
        <GitBranch size={17} className="mt-0.5 shrink-0 opacity-70" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="shrink-0 text-ui-sm font-medium">{t('chat.permission.runWorkflow')}</span>
            <span className="min-w-0 truncate text-ui-sm" title={name}>{name}</span>
            <span className={`ml-auto shrink-0 text-ui-xs ${vibe ? 'text-white/55' : 'text-dark-onSurfaceVariant/60'}`}>
              {t('chat.permission.workflowPhaseCount', { count: view?.phases.length ?? 0 })}
            </span>
          </div>
          <div className={`mt-0.5 text-ui-xs ${vibe ? 'text-white/55' : 'text-dark-onSurfaceVariant/60'}`}>
            {t('chat.permission.workflowParallel', { count: view?.maxParallel ?? 1 })}
            <span className="opacity-70"> · {t('chat.permission.workflowStaticHint')}</span>
          </div>
          {typeof request.args?.saved === 'string' && request.args.saved && (
            <div className={`mt-1 text-ui-xs ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/70'}`}>
              {t('chat.permission.workflowSavedSource', { name: String(request.args.saved) })}
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-3">
        {view ? (
          <WorkflowGraph view={view} vibe={vibe} />
        ) : (
          <pre className={`max-h-40 overflow-auto whitespace-pre font-mono text-ui-xs ${vibe ? 'text-white/80' : 'text-dark-onSurface/80'}`}>
            {preview.monospace}
          </pre>
        )}
      </div>

      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={() => setScriptOpen((open) => !open)}
          aria-expanded={scriptOpen}
          className={`flex w-fit items-center gap-1 text-ui-xs transition-colors ${
            vibe ? 'text-white/50 hover:text-white/80' : 'text-dark-onSurfaceVariant/55 hover:text-dark-onSurface/85'
          }`}
        >
          {scriptOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {t('chat.permission.workflowScriptToggle')}
        </button>
        {scriptOpen && <div className="mt-1"><MonoBlock text={preview.script ?? preview.monospace} vibe={vibe} /></div>}
      </div>

      {showActions ? (
        <ApprovalOptionList
          vibe={vibe}
          onResolve={resolve}
          options={APPROVAL_OPTIONS.map((option) => ({
            ...option,
            label: t(option.decision === 'allow_session' ? 'chat.permission.allowSessionWorkflow' : option.labelKey),
          }))}
        />
      ) : status === 'pending' ? (
        <div className="flex items-center gap-2 border-t border-current/10 px-4 py-2 text-ui-xs">
          <Clock size={12} className="shrink-0" />
          <span>{t('chat.permission.awaitHostHint')}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-t border-current/10 px-4 py-2 text-ui-xs">
          <Check size={12} />
          <span>{t(DECISION_LABEL_KEY[request.decision ?? 'deny'])}</span>
          <span className="opacity-70">{name}</span>
        </div>
      )}
    </section>
  )
}

export interface PermissionRequestView {
  /** 阶段一 = `${sessionId}:${toolCallId}`；阶段二 = permission.requested 的请求 id */
  id: string
  /** 来源工具名（原始 name） */
  tool: string
  /** 原始入参（个别确认卡要读特定字段，如工作流的 saved 来源）；镜像态可缺省 */
  args?: Record<string, unknown>
  preview: ReturnType<typeof buildPermissionPreview>
  status: PermissionRequestStatus
  /** status='resolved' 时的审批结果 */
  decision?: PermissionDecision
  requestedAt: number
  /** 本会话此前已「始终允许」过同一操作 */
  previouslyGranted?: boolean
}

export interface PermissionCardProps {
  request: PermissionRequestView
  /** 阶段二换数据源时保持不变：宿主只需替换此回调的实现 */
  onResolve?: (id: string, decision: PermissionDecision) => void
  /** false = 镜像态：本组件不拥有放行权（阶段一），只展示风险预览，不伪装成决策入口 */
  interactive?: boolean
  vibe?: boolean
}

export function PermissionCard({ request, onResolve, interactive = true, vibe = false }: PermissionCardProps) {
  const { t } = useTranslation()
  const { preview, status } = request
  const tone = toneFor(preview.risk, vibe)
  const RiskIcon = RISK_ICON[preview.risk]
  const resolve = (decision: PermissionDecision) => () => onResolve?.(request.id, decision)
  const toolLabel = t(`tools.${request.tool}`, { defaultValue: request.tool })
  const showActions = status === 'pending' && interactive
  // 危险命令只给「允许一次」：内容每条都不同的高危命令不能有持久闸门
  // （对齐 ZCode guarded 的 user-once——该次审批不提供总是允许、不写规则）。
  // 浏览/桌面的「本会话允许」是能力级授权，不在裁剪之列。
  const dangerOnce = preview.kind === 'command' && preview.risk === 'dangerous'
  const projectRules = supportsProjectRules(preview)
  const approvalOptions = APPROVAL_OPTIONS
    .filter((option) => !(dangerOnce && ['allow_session', 'allow_project', 'deny_always'].includes(option.decision)))
    .filter((option) => projectRules || !['allow_project', 'deny_always'].includes(option.decision))
    .map((option) => ({ ...option, label: t(option.labelKey) }))

  // 工作流确认：画得出静态图才换版式；图空（脚本没写成字面形态）时回落通用卡
  if (request.tool === 'create_workflow' && preview.graph && preview.graph.phases.length > 0) {
    return <WorkflowPermissionCard request={request} onResolve={onResolve} interactive={interactive} vibe={vibe} />
  }

  return (
    <section
      role="group"
      aria-label={t('chat.permission.title')}
      className={`mx-4 mb-3 overflow-hidden rounded-md3-md border shadow-sm animate-slide-up ${tone.surface} ${tone.border} ${tone.foreground}`}
    >
      <div className="flex items-start gap-2.5 px-4 py-3">
        <RiskIcon size={17} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t('chat.permission.title')}</span>
            <span className={`inline-flex items-center rounded-md3-xs px-1.5 py-0.5 text-xs ${tone.accent}`}>
              {toolLabel}
            </span>
            {request.previouslyGranted && (
              <span className="text-xs opacity-70">{t('chat.permission.previouslyGranted')}</span>
            )}
          </div>
          {preview.reasonKeys.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs opacity-80">
              {preview.reasonKeys.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="px-4 pb-3">
        {preview.kind === 'file' && request.args && (request.tool === 'write_file' || request.tool === 'search_replace' || request.tool === 'edit_file') && preview.target ? (
          <FileDiffPreview
            tool={request.tool}
            path={preview.target}
            args={request.args}
            vibe={vibe}
          />
        ) : (
          <div className={`rounded-md3-sm border px-3 py-2 ${tone.border}`}>
            <div className="text-xs opacity-70">{t('chat.permission.targetLabel')}</div>
            <pre
              className={`mt-0.5 max-h-40 overflow-auto whitespace-pre font-mono text-xs ${tone.foreground}`}
              aria-label={t('chat.permission.targetAria')}
            >
              {preview.monospace || t('chat.permission.emptyTarget')}
            </pre>
            {preview.truncated && <div className="mt-1 text-xs opacity-70">{t('chat.permission.truncated')}</div>}
          </div>
        )}
      </div>

      {showActions ? (
        <ApprovalOptionList
          vibe={vibe}
          onResolve={resolve}
          options={approvalOptions}
          hint={dangerOnce ? t('chat.permission.dangerOnceHint') : undefined}
        />
      ) : status === 'pending' ? (
        <div className="flex items-center gap-2 border-t border-current/10 px-4 py-2 text-xs">
          <Clock size={12} className="shrink-0" />
          <span>{t('chat.permission.awaitHostHint')}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-t border-current/10 px-4 py-2 text-xs">
          {status === 'expired' ? (
            <span>{t('chat.permission.expired')}</span>
          ) : (
            <>
              <Check size={12} />
              <span>{t(DECISION_LABEL_KEY[request.decision ?? 'deny'])}</span>
              <span className="opacity-70">{toolLabel}</span>
            </>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * 宿主模式（C2 阶段二）：数据源是宿主的 permission.requested 事件，带 tool/args，
 * 所以卡片既画得出富预览也算得出「本会话允许」的匹配键；三个按钮真的决定放行。
 * 这份 store 只在宿主模式下会被写入，本地路径的放行权仍在原生确认框里（见下方镜像态）。
 */
const NO_PENDING: HostPermission[] = []

function HostPermissionCard({ request, vibe }: { request: HostPermission; vibe: boolean }) {
  const { t } = useTranslation()
  const preview = useMemo(
    () => buildPermissionPreview(request.tool, request.args, { workingDir: request.workingDir }),
    [request.tool, request.args, request.workingDir]
  )
  const view = useMemo<PermissionRequestView>(
    () => ({
      id: request.requestId,
      tool: request.tool,
      preview,
      status: 'pending',
      requestedAt: request.requestedAt,
      previouslyGranted: false,
    }),
    [request.requestId, request.tool, request.requestedAt, preview]
  )

  const resolve = (decision: PermissionDecision) => {
    // 项目级规则由渲染层 settings 落盘（宿主下一轮 run 的 settings 快照会带上）
    persistProjectRule(decision, { tool: request.tool, args: request.args, workingDir: request.workingDir })
    // 只回布尔给宿主不够：「本会话允许」要让它记住匹配键，否则后台无人看管的 run
    // 会带着同一个目标一次次撞回 120s 超时
    void agentClient.send({
      type: 'permission.resolve',
      sessionId: request.sessionId,
      requestId: request.requestId,
      approved: decision === 'allow_once' || decision === 'allow_session' || decision === 'allow_project',
      scope: decisionToScope(decision),
    })
    // 乐观收尾；宿主的 permission.settled 到达时再 settle 一次是幂等的
    usePermissionStore.getState().settle(request.sessionId, request.requestId)
  }

  // 远程视图（WebUI）只读：宿主侧 permission.resolve 对远程命令一律拒绝，
  // 这里把按钮画出来就是骗人——点下去卡片乐观收尾，宿主那边却在等 120s 超时。
  if (isWebUIMode) {
    return (
      <div className="space-y-1.5">
        <p className={`text-[11px] ${vibe ? 'text-white/55' : 'text-dark-onSurfaceVariant/70'}`}>
          {t('agent.approvalLocalOnly')}
        </p>
        <PermissionCard request={view} interactive={false} vibe={vibe} />
      </div>
    )
  }

  return <PermissionCard request={view} onResolve={(_id, decision) => resolve(decision)} interactive vibe={vibe} />
}

/**
 * 渲染层本地待批（权限三期起覆盖所有 reason）：loop 在同进程里等 promise，
 * 这里负责画卡与兑现。数据源是 permission-store 的 `localBySession`——不是消息
 * 扫描推断出来的镜像态，所以卡片真的拥有放行权（interactive）。
 *
 * 用户选了项目级选项时，在同一处写 settings.permissionRules（persist 落盘）：
 * 规则是纯数据，不经过 IPC，也不改会话内存，重启后由 checkToolPermission 命中。
 */
const NO_LOCAL: LocalPermission[] = []

function LocalPermissionCard({ request, vibe }: { request: LocalPermission; vibe: boolean }) {
  const addMessage = useChatStore((s) => s.addMessage)
  const preview = useMemo(
    () => buildPermissionPreview(request.tool, request.args, { workingDir: request.workingDir }),
    [request.tool, request.args, request.workingDir]
  )
  const view = useMemo<PermissionRequestView>(
    () => ({
      id: request.requestId,
      tool: request.tool,
      args: request.args,
      preview,
      status: 'pending',
      requestedAt: request.requestedAt,
    }),
    [request.requestId, request.tool, request.args, request.requestedAt, preview]
  )

  const handleResolve = (id: string, decision: PermissionDecision) => {
    // 项目级选项：先落规则（同步 set，下一次 checkToolPermission 立刻能命中），
    // 再兑现 promise。危险命令/能力级动作不会走到这里——选项已被裁掉。
    persistProjectRule(decision, { tool: request.tool, args: request.args, workingDir: request.workingDir })
    // 先兑现 promise（loop 立刻继续/中止），再补一条对话留痕
    resolveLocalPermission(request.sessionId, id, decision)
    const at = Date.now()
    addMessage(request.sessionId, {
      id: makeId(),
      role: 'system',
      content: formatPermissionAuditContent({
        decision,
        tool: request.tool,
        target: preview.target,
        risk: preview.risk,
        at,
      }),
      timestamp: at,
    })
  }

  return <PermissionCard request={view} onResolve={handleResolve} interactive vibe={vibe} />
}

/**
 * 挂载点：宿主模式走上面的事件数据源；渲染层本地路径这里是镜像态
 * （confirm-danger 会话状态 + 尚未收尾的门控工具调用推断出来），interactive=false
 * 是因为那条路径的放行权在原生确认框手里，卡片不该伪装成决策入口。
 */
export function PermissionApprovalCard({ sessionId, vibe = false }: { sessionId: string; vibe?: boolean }) {
  const hostPending = usePermissionStore((s) => s.bySession[sessionId] ?? NO_PENDING)
  const localPending = usePermissionStore((s) => s.localBySession[sessionId] ?? NO_LOCAL)
  const status = useChatStore((s) => s.sessionStatus[sessionId])
  const messages = useChatStore((s) => s.sessions.find((session) => session.id === sessionId)?.messages)
  const workingDir = useChatStore((s) => {
    const session = s.sessions.find((item) => item.id === sessionId)
    return session?.workingDir || session?.defaultWorkDir || ''
  })
  const addMessage = useChatStore((s) => s.addMessage)
  const [answered, setAnswered] = useState<{ requestId: string; decision: PermissionDecision } | null>(null)
  const [grants, setGrants] = useState<{ sessionId: string; keys: string[] }>({ sessionId, keys: [] })

  const request = useMemo<PermissionRequestView | null>(() => {
    if (status !== 'confirm-danger' || !messages) return null
    const pending = findPendingApprovalCall(messages)
    if (!pending) return null
    const id = `${sessionId}:${pending.toolCallId}`
    const preview = buildPermissionPreview(pending.tool, pending.args, { workingDir })
    const requestedAt = messages[messages.length - 1]?.timestamp ?? Date.now()
    if (answered?.requestId === id) {
      return { id, tool: pending.tool, args: pending.args, preview, status: 'resolved', decision: answered.decision, requestedAt }
    }
    return {
      id,
      tool: pending.tool,
      args: pending.args,
      preview,
      status: 'pending',
      requestedAt,
      previouslyGranted: grants.sessionId === sessionId && grants.keys.includes(preview.grantKey),
    }
  }, [status, messages, sessionId, workingDir, answered, grants])

  // 本地待批（工作流确认）优先：它握着 loop 的 promise，晚一帧画出来就是白等
  if (localPending.length > 0) return <LocalPermissionCard request={localPending[0]!} vibe={vibe} />

  // 宿主模式下待批来自事件流；镜像态（靠消息扫描 + 会话状态推断）让位给它
  if (hostPending.length > 0) return <HostPermissionCard request={hostPending[0]} vibe={vibe} />

  if (!request) return null

  const handleResolve = (id: string, decision: PermissionDecision) => {
    setAnswered({ requestId: id, decision })
    persistProjectRule(decision, { tool: request.tool, args: request.args ?? {}, workingDir })
    if (decision === 'allow_session') {
      const grantKey = request.preview.grantKey
      setGrants((current) => {
        const keys = current.sessionId === sessionId ? current.keys : []
        return keys.includes(grantKey) ? current : { sessionId, keys: [...keys, grantKey] }
      })
    }
    const at = Date.now()
    addMessage(sessionId, {
      id: makeId(),
      role: 'system',
      content: formatPermissionAuditContent({
        decision,
        tool: request.tool,
        target: request.preview.target,
        risk: request.preview.risk,
        at,
      }),
      timestamp: at,
    })
  }

  return <PermissionCard request={request} onResolve={handleResolve} interactive={false} vibe={vibe} />
}

/** 审批结果留痕：对话流内的可折叠 system 行 */
export function PermissionAuditRow({
  record,
  timestamp,
  vibe = false,
}: {
  record: PermissionAuditRecord
  timestamp: number
  vibe?: boolean
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const tone = toneFor(record.risk, vibe)
  const timeStr = new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="my-1 flex min-w-0 justify-center overflow-hidden">
      <div className="w-full max-w-[90%] min-w-0">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className={`flex w-full items-center gap-2 rounded-md3-sm border px-3 py-1.5 text-xs transition-colors ${tone.surface} ${tone.border} ${tone.foreground}`}
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          <ShieldCheck size={11} className="shrink-0" />
          <span className="shrink-0 font-medium">{t(DECISION_LABEL_KEY[record.decision])}</span>
          <span className="min-w-0 truncate opacity-80">
            {t(`tools.${record.tool}`, { defaultValue: record.tool })}
          </span>
          <span className="ml-auto shrink-0 opacity-60">{timeStr}</span>
        </button>
        {expanded && (
          <div className={`mt-1 rounded-md3-sm border px-3 py-2 text-xs ${tone.surface} ${tone.border} ${tone.foreground}`}>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">{record.target}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

export default PermissionCard
