import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, Check, ChevronDown, ChevronUp, Clock, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useChatStore } from '../../stores/chat-store'
import { agentClient } from '../../lib/agent-client'
import { usePermissionStore, type HostPermission } from '../../stores/permission-store'
import { makeId } from '../../agent-core/loop'
import {
  buildPermissionPreview,
  findPendingApprovalCall,
  formatPermissionAuditContent,
  type PermissionAuditRecord,
  type PermissionDecision,
  type PermissionRequestStatus,
  type PermissionRiskLevel,
} from '../../lib/permission-preview'

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
  allow_once: 'chat.permission.resultAllowOnce',
  allow_session: 'chat.permission.resultAllowAlways',
}

function toneFor(risk: PermissionRiskLevel, vibe: boolean): ToneSet {
  if (vibe) return VIBE_TONE
  return risk === 'dangerous' ? PERMISSION_TONES.confirmation : PERMISSION_TONES.ask
}

const BUTTON_BASE =
  'inline-flex items-center gap-1 rounded-md3-xs px-2.5 py-1.5 text-xs font-medium transition-opacity hover:opacity-80'

export interface PermissionRequestView {
  /** 阶段一 = `${sessionId}:${toolCallId}`；阶段二 = permission.requested 的请求 id */
  id: string
  /** 来源工具名（原始 name） */
  tool: string
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
      </div>

      {showActions ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-current/10 px-4 py-3">
          <button type="button" onClick={resolve('deny')} className={`${BUTTON_BASE} border border-current/25`}>
            <Ban size={12} />
            {t('chat.permission.deny')}
          </button>
          <button type="button" onClick={resolve('allow_once')} className={`${BUTTON_BASE} ${tone.accent}`}>
            <Check size={12} />
            {t('chat.permission.allowOnce')}
          </button>
          <button type="button" onClick={resolve('allow_session')} className={`${BUTTON_BASE} ${tone.accent}`}>
            <ShieldCheck size={12} />
            {t('chat.permission.allowAlways')}
          </button>
          <span className="ml-auto text-xs opacity-70">{t('chat.permission.hint')}</span>
        </div>
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
    // 只回布尔给宿主不够：「本会话允许」要让它记住匹配键，否则后台无人看管的 run
    // 会带着同一个目标一次次撞回 120s 超时
    void agentClient.send({
      type: 'permission.resolve',
      sessionId: request.sessionId,
      requestId: request.requestId,
      approved: decision !== 'deny',
      scope: decision === 'allow_session' ? 'session' : 'once',
    })
    // 乐观收尾；宿主的 permission.settled 到达时再 settle 一次是幂等的
    usePermissionStore.getState().settle(request.sessionId, request.requestId)
  }

  return <PermissionCard request={view} onResolve={(_id, decision) => resolve(decision)} interactive vibe={vibe} />
}

/**
 * 挂载点：宿主模式走上面的事件数据源；渲染层本地路径这里是镜像态
 * （confirm-danger 会话状态 + 尚未收尾的门控工具调用推断出来），interactive=false
 * 是因为那条路径的放行权在原生确认框手里，卡片不该伪装成决策入口。
 */
export function PermissionApprovalCard({ sessionId, vibe = false }: { sessionId: string; vibe?: boolean }) {
  const hostPending = usePermissionStore((s) => s.bySession[sessionId] ?? NO_PENDING)
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
      return { id, tool: pending.tool, preview, status: 'resolved', decision: answered.decision, requestedAt }
    }
    return {
      id,
      tool: pending.tool,
      preview,
      status: 'pending',
      requestedAt,
      previouslyGranted: grants.sessionId === sessionId && grants.keys.includes(preview.grantKey),
    }
  }, [status, messages, sessionId, workingDir, answered, grants])

  // 宿主模式下待批来自事件流；镜像态（靠消息扫描 + 会话状态推断）让位给它
  if (hostPending.length > 0) return <HostPermissionCard request={hostPending[0]} vibe={vibe} />

  if (!request) return null

  const handleResolve = (id: string, decision: PermissionDecision) => {
    setAnswered({ requestId: id, decision })
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
