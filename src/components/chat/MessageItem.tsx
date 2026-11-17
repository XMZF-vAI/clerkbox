import { useState, memo, type ReactNode } from 'react'
import { Check, FileText, AlertTriangle, ChevronDown, ChevronUp, Wrench, Archive, Loader2, BookOpen, GitBranch, Target, BellRing, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Message } from '../../types/agent'
import { useChatStore } from '../../stores/chat-store'
import { parsePermissionAudit } from '../../lib/permission-preview'
import { MarkdownContent } from './MarkdownContent'
import { PermissionAuditRow } from './PermissionCard'
import { CopyButton, MessageActions } from './MessageActions'
import { isRenderedByUnifiedEntry } from './tool-renderers/resolveRenderer'
import { ToolCallRow } from './ToolCallRow'
import { SubAgentCard } from './SubAgentCard'
import PathImageAttachment from './PathImageAttachment'

interface MessageItemProps {
  message: Message
  vibe?: boolean
  sessionId?: string
  /** 追加在这一行动作条里的按钮（撤回/编辑等），由父级按 turn 语义下发 */
  extraActions?: ReactNode
}

/**
 * 用户气泡与特殊卡片渲染。
 * 正常助手消息（思考 / 正文 / 工具）已改由 AssistantTurnStream 按 ZCode 行流渲染，
 * 这里只保留：用户消息、压缩摘要 / 边界、权限留痕、目标判定、通知条、子代理卡、
 * 压缩 / 重试占位、历史 collapsed 消息。
 */
function MessageItem({ message, vibe = false, sessionId, extraActions }: MessageItemProps) {
  const { t } = useTranslation()
  const [collapsedExpanded, setCollapsedExpanded] = useState(false)
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const isUser = message.role === 'user'
  const isToolResult = message.role === 'tool'

  // Compact boundary message — render as a divider card
  if (message.role === 'system' && message.isCompactSummary) {
    const meta = message.compactMetadata
    const timeStr = new Date(message.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return (
      <div className="flex justify-center animate-slide-up my-2">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md3-md text-[11px] ${
          vibe
            ? 'bg-white/10 border border-white/20 text-white/60'
            : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/8 text-dark-onSurfaceVariant/50'
        }`}>
          <Archive size={12} className="flex-shrink-0" />
          <span>{t('chat.contextCompressed')}{meta ? t('chat.contextCompressedMeta', { count: meta.messagesSummarized }) : ''}</span>
          <span className="opacity-60">{timeStr}</span>
        </div>
      </div>
    )
  }

  // 权限审批留痕（system 消息，UI 专用，不进入模型上下文）——可折叠单行
  const permissionAudit = message.role === 'system' ? parsePermissionAudit(message.content) : null
  if (permissionAudit) {
    return <PermissionAuditRow record={permissionAudit} timestamp={message.timestamp} vibe={vibe} />
  }

  // Compact summary message — render as collapsible card with "摘要" label
  if (message.isCompactSummary && message.role !== 'system') {
    return (
      <div className="flex justify-center animate-slide-up my-1 min-w-0 overflow-hidden">
        <div className="w-full min-w-0">
          <button
            onClick={() => setSummaryExpanded(!summaryExpanded)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md3-sm text-[11px] transition-colors ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/60 hover:text-white/80 hover:bg-white/15'
                : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/8 text-dark-onSurfaceVariant/50 hover:text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainer/60'
            }`}
          >
            {summaryExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            <Archive size={11} />
            <span>{t('chat.compactSummary')}</span>
          </button>
          {summaryExpanded && (
            <div className={`mt-2 px-4 py-2.5 rounded-md3-md text-sm leading-relaxed min-w-0 break-words overflow-hidden [&_pre]:overflow-x-auto ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/90'
                : 'bg-dark-surfaceContainerHigh text-dark-onSurface'
            }`}>
              <MarkdownContent content={message.content} vibe={vibe} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // /goal 目标评估判定卡（system 消息，UI 专用，不进入模型上下文）：
  // in_progress=续跑中（含护栏暂停提示）/ achieved=已达成 / impossible=无法完成
  if (message.goalEvent) {
    const event = message.goalEvent
    const meta = event.verdict === 'achieved'
      ? {
          icon: Check,
          iconCls: vibe ? 'text-emerald-300' : 'text-md-success',
          boxCls: vibe
            ? 'border-emerald-300/25 bg-emerald-400/10 text-white'
            : 'border-md-success/25 bg-md-success/10 text-dark-onSurface',
          title: t('goal.checkAchieved'),
        }
      : event.verdict === 'impossible'
        ? {
            icon: AlertTriangle,
            iconCls: vibe ? 'text-amber-300' : 'text-md-error',
            boxCls: vibe
              ? 'border-amber-300/25 bg-amber-400/10 text-white'
              : 'border-md-error/25 bg-md-error/10 text-dark-onSurface',
            title: t('goal.checkImpossible'),
          }
        : {
            icon: Loader2,
            iconCls: vibe ? 'text-white/70' : 'text-md-tertiary',
            boxCls: vibe
              ? 'border-white/20 bg-white/5 text-white/90'
              : 'border-md-tertiary/25 bg-md-tertiary/10 text-dark-onSurface',
            title: t('goal.checkInProgress', { n: event.evaluations }),
          }
    const EventIcon = meta.icon
    return (
      <div className="animate-slide-up flex justify-start">
        <div className={`flex max-w-[90%] items-start gap-2.5 rounded-md3-md border px-3.5 py-2.5 text-sm ${meta.boxCls}`}>
          <EventIcon size={15} className={`mt-0.5 flex-shrink-0 ${meta.iconCls} ${event.verdict === 'in_progress' ? 'animate-spin' : ''}`} />
          <div className="min-w-0">
            <div className="font-medium">{meta.title}</div>
            {event.reason && <div className="mt-0.5 text-xs opacity-75 break-words">{event.reason}</div>}
          </div>
        </div>
      </div>
    )
  }

  // 压缩后恢复的文件消息（isCompactAttachment）—— 折叠卡片渲染，而非用户气泡。
  // 它是压缩机制自动注入的文件内容恢复（role 为 user 仅为满足 API 结构），
  // 不是用户真实发送的消息，不能渲染成绿色用户气泡。
  // 内容模式兜底：旧版本写入 DB 的文件恢复消息没有 isCompactAttachment 标记，按内容识别。
  if (message.isCompactAttachment || (message.role === 'user' && /^\[Previously read file: .+?\]\n```/.test(message.content))) {
    const fileMatch = message.content.match(/^\[Previously read file: (.+?)\]/m)
    const filePath = fileMatch?.[1] || ''
    return (
      <div className="flex justify-center animate-slide-up my-1 min-w-0 overflow-hidden">
        <div className="w-full min-w-0">
          <button
            onClick={() => setSummaryExpanded(!summaryExpanded)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md3-sm text-[11px] transition-colors ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/60 hover:text-white/80 hover:bg-white/15'
                : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/8 text-dark-onSurfaceVariant/50 hover:text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainer/60'
            }`}
          >
            {summaryExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            <FileText size={11} className="flex-shrink-0" />
            <span className="truncate">{t('chat.compactFileRestored')}{filePath ? `: ${filePath}` : ''}</span>
          </button>
          {summaryExpanded && (
            <div className={`mt-2 px-4 py-2.5 rounded-md3-md text-sm leading-relaxed min-w-0 break-words overflow-hidden [&_pre]:overflow-x-auto ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/90'
                : 'bg-dark-surfaceContainerHigh text-dark-onSurface'
            }`}>
              <MarkdownContent content={message.content} vibe={vibe} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // 文件已撤销的合成回执：它是 user 角色（system 消息不会进模型上下文），
  // 但必须画成居中的回执条而不是用户气泡，否则看起来像用户自己说了一句话。
  if (message.isRewindNotice) {
    return (
      <div className="flex justify-center animate-slide-up my-1">
        <div className={`max-w-[560px] w-full px-3 py-2 rounded-md3-md text-[11px] leading-relaxed whitespace-pre-line ${
          vibe
            ? 'bg-white/5 border border-white/[0.03] text-white/55'
            : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/[0.04] text-dark-onSurfaceVariant/65'
        }`}>
          {message.content}
        </div>
      </div>
    )
  }

  // 后台子代理完成通知：user 角色承载（要进模型上下文），但画成居中的通知条而不是
  // 用户气泡。把 <subagent-notification> XML 解析成一条条带状态图标的摘要。
  if (message.isSubAgentNotice) {
    const notifications = parseSubagentNotifications(message.content)
    const workflowNotices = parseWorkflowNotifications(message.content)
    return (
      <div className="flex justify-center animate-slide-up my-1">
        <div className={`max-w-[560px] w-full px-3 py-2 rounded-md3-md text-[11px] leading-relaxed ${
          vibe
            ? 'bg-white/5 border border-white/[0.03] text-white/55'
            : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/[0.04] text-dark-onSurfaceVariant/65'
        }`}>
          <div className="mb-1 flex items-center gap-1 font-medium">
            <BellRing className="h-3 w-3" />
            {t('chat.subAgentNoticeTitle')}
          </div>
          {notifications.map((n, i) => (
            <div key={i} className="mt-1 whitespace-pre-line">
              <span className={n.status === 'completed' ? 'text-md-success' : n.status === 'failed' ? 'text-md-error' : ''}>
                {n.status === 'completed' ? '✓' : n.status === 'failed' ? '✕' : '·'}
              </span>{' '}
              <span className="font-medium">{n.agent}</span>
              <span className="opacity-60"> ({n.agentId})</span>
              <span className="opacity-60"> · {t(`chat.subAgentNoticeStatus.${n.status}`, { defaultValue: n.status })}</span>
              {n.usage && <span className="opacity-60"> · {n.usage}</span>}
              {n.body && <div className="mt-0.5 opacity-80">{subagentNoticeExcerpt(n.body)}</div>}
            </div>
          ))}
          {workflowNotices.map((w, i) => (
            <div key={`wf-${i}`} className="mt-1 whitespace-pre-line">
              <Workflow size={10} className="mr-1 inline align-[-1px]" />
              <span className={w.status === 'completed' ? 'text-md-success' : w.status === 'aborted' ? '' : 'text-md-error'}>
                {w.status === 'completed' ? '✓' : w.status === 'aborted' ? '⏹' : '✕'}
              </span>{' '}
              <span className="font-medium">{w.name}</span>
              <span className="opacity-60"> · {t(`chat.workflowNoticeStatus.${w.status}`, { defaultValue: w.status })}</span>
              {w.body && <div className="mt-0.5 opacity-80">{subagentNoticeExcerpt(w.body)}</div>}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Tool result messages are hidden (结果挂在助手消息的 toolResults 上)
  if (isToolResult) return null

  // 正在压缩上下文占位 —— 居中显示过程提示（压缩完成后被摘要卡片替换）
  if (message._isCompacting) {
    return (
      <div className="flex justify-center animate-slide-up my-1">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md3-md text-[11px] ${
          vibe
            ? 'bg-white/5 border border-white/[0.03] text-white/50'
            : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/[0.03] text-dark-onSurfaceVariant/50'
        }`}>
          <Loader2 size={12} className="animate-spin" />
          <span>{t('chat.compactingContext')}</span>
        </div>
      </div>
    )
  }

  // 请求失败后正在重试 —— 居中显示过程提示（重试成功后清除该标记）
  if (message._retrying) {
    return (
      <div className="flex justify-center animate-slide-up my-1">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-md3-md text-[11px] ${
          vibe
            ? 'bg-white/5 border border-white/[0.03] text-white/60'
            : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/[0.03] text-dark-onSurfaceVariant/60'
        }`}>
          <Loader2 size={12} className="animate-spin" />
          <span>{t('chat.retrying', { attempt: message._retrying.attempt })}</span>
        </div>
      </div>
    )
  }

  // Sub-agent card placeholder — render as SubAgentCard
  if (message.isSubAgentCard) {
    return (
      <div className="flex justify-start animate-slide-up w-full">
        <div className="w-full max-w-md min-w-0">
          <SubAgentCard message={message} sessionId={sessionId || useChatStore.getState().activeSessionId || ''} vibe={vibe} />
        </div>
      </div>
    )
  }

  // Collapsed intermediate messages（历史压缩遗留）— show as expandable summary
  if (message.collapsed && !isUser) {
    const visibleCalls = (message.toolCalls ?? []).filter((tc) => !isRenderedByUnifiedEntry(tc.name))
    if (visibleCalls.length === 0 && !message.content.trim()) return null
    return (
      <div className="flex justify-start animate-slide-up">
        <div className="w-full">
          <button
            onClick={() => setCollapsedExpanded(!collapsedExpanded)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md3-sm text-[11px] transition-colors ${
              vibe
                ? 'bg-white/10 border border-white/20 text-white/60 hover:text-white/80 hover:bg-white/15'
                : 'bg-dark-surfaceContainer/40 border border-dark-onSurfaceVariant/8 text-dark-onSurfaceVariant/50 hover:text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainer/60'
            }`}
          >
            {collapsedExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            <Wrench size={11} />
            <span>{t('chat.collapsedSteps', { count: visibleCalls.length })}</span>
          </button>
          {collapsedExpanded && (
            <div className="mt-2 flex w-full flex-col gap-2">
              {message.content && (
                <div className={`min-w-0 break-words text-sm leading-relaxed ${
                  vibe ? 'text-white/80' : 'text-dark-onSurface/85'
                }`}>
                  <MarkdownContent content={message.content} vibe={vibe} />
                </div>
              )}
              {visibleCalls.map((call) => (
                <ToolCallRow
                  key={call.id}
                  item={{ call, result: message.toolResults?.find((r) => r.toolCallId === call.id), message }}
                  vibe={vibe}
                  sessionId={sessionId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 正常助手消息由 AssistantTurnStream 渲染；走到这里的非用户消息直接不渲染
  if (!isUser) return null

  // 用户消息附件：图片缩略图 + 文件 chip（与正文气泡分开渲染，正文为空时也要显示）
  const userImages = (message.attachments || []).filter((a) => a.kind === 'image')
  const userFiles = (message.attachments || []).filter((a) => a.kind === 'file')

  // 发送时选中的任务工作流与 Skill 快照都嵌入对应的用户消息气泡。
  const taskModeMeta = message.taskMode
    ? ({
        spec: { icon: BookOpen, name: 'Spec', cls: 'bg-md-info/15 text-md-info' },
        plan: { icon: GitBranch, name: 'Plan', cls: 'bg-md-primary/15 text-md-primary' },
        goal: { icon: Target, name: 'Goal', cls: 'bg-md-tertiary/15 text-md-tertiary' },
      } as const)[message.taskMode]
    : null
  const TaskModeIcon = taskModeMeta?.icon
  const messageSkills = message.skills || []
  const hasUserMetadata = !!taskModeMeta || messageSkills.length > 0

  return (
    <div className="message-action-scope animate-slide-up flex justify-end">
      {/* 用户侧保留右对齐气泡的限宽 —— 短输入靠右是定位手段 */}
      <div className="flex flex-col gap-1 items-end max-w-[85%] max-md:max-w-[92%]">

        {/* User message attachments - above the content bubble */}
        {(userImages.length > 0 || userFiles.length > 0) && (
          <div className="flex flex-col items-end gap-1.5">
            {userImages.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-end">
                {userImages.map((a) => (
                  a.dataUrl ? <img
                    key={a.id}
                    src={a.dataUrl}
                    alt={a.name}
                    title={a.path || a.name}
                    className="max-h-40 max-w-[240px] rounded-md3-md object-cover border border-dark-onSurfaceVariant/15"
                  /> : <PathImageAttachment key={a.id} attachment={a} vibe={vibe} />
                ))}
              </div>
            )}
            {userFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-end">
                {userFiles.map((a) => (
                  <div
                    key={a.id}
                    title={a.path}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md3-md text-xs ${
                      vibe
                        ? 'bg-white/10 border border-white/20 text-white/90'
                        : 'bg-md-primaryContainer text-md-onPrimaryContainer'
                    }`}
                  >
                    <FileText size={12} className="flex-shrink-0" />
                    <span className="truncate max-w-[200px]">{a.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Message content —— 用户侧右对齐气泡 */}
        {(message.content.trim() || hasUserMetadata) && (
          <div
            className={`relative group min-w-0 break-words text-sm leading-relaxed px-4 py-2.5 rounded-md3-md ${
              vibe ? 'liquid-glass text-white' : 'bg-md-primaryContainer text-md-onPrimaryContainer'
            }`}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {taskModeMeta && TaskModeIcon && (
                <span className={`inline-flex flex-shrink-0 items-center gap-1 rounded-md3-sm px-2 py-0.5 text-[11px] font-medium ${
                  vibe ? 'bg-white/15 text-white/90' : taskModeMeta.cls
                }`}>
                  <TaskModeIcon size={11} className="flex-shrink-0" />
                  <span>{taskModeMeta.name}</span>
                </span>
              )}
              {messageSkills.map((skill) => (
                <span
                  key={`${skill.id}-${skill.slug || skill.name}`}
                  className={`inline-flex max-w-full flex-shrink-0 items-center gap-1 rounded-md3-sm px-2 py-0.5 text-[11px] font-medium ${
                    vibe ? 'bg-white/15 text-white/90' : 'bg-dark-surface/10 text-md-onPrimaryContainer'
                  }`}
                >
                  {skill.icon && <span aria-hidden="true">{skill.icon}</span>}
                  <span className="max-w-[180px] truncate">{skill.name}</span>
                </span>
              ))}
              {message.content.trim() && (
                <span className="min-w-0 whitespace-pre-wrap break-words">{message.content}</span>
              )}
            </div>
          </div>
        )}

        {/* 动作条：复制 + 父级按 turn 语义下发的按钮（编辑/撤回/撤销文件） */}
        {(!!message.content.trim() || !!extraActions) && (
          <MessageActions vibe={vibe} className="px-1">
            <CopyButton text={message.content} vibe={vibe} />
            {extraActions}
          </MessageActions>
        )}
      </div>
    </div>
  )
}

export default memo(MessageItem)

/**
 * 通知条的正文摘录：剥掉 markdown 标记噪音（标题井号/加粗星号），折叠空白后截前 200 字。
 * 完整结果永远在子代理卡片与详情面板里 —— 通知条只负责「谁完成了、结果一句话是什么」，
 * 整段报告贴进时间线既臃肿又会把裸 markdown 符号暴露给用户。
 */
function subagentNoticeExcerpt(body: string): string {
  const cleaned = body
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned
}

/** 后台子代理通知消息的解析：<subagent-notification> XML → 摘要条目 */
function parseSubagentNotifications(content: string): Array<{ agentId: string; agent: string; type: string; status: string; body: string; usage?: string }> {
  const out: Array<{ agentId: string; agent: string; type: string; status: string; body: string; usage?: string }> = []
  const re = /<subagent-notification agentId="([^"]*)" agent="([^"]*)" type="([^"]*)" status="([^"]*)">([\s\S]*?)<\/subagent-notification>/g
  for (const m of content.matchAll(re)) {
    let body = m[5] ?? ''
    let usage: string | undefined
    const usageMatch = body.match(/<usage>([\s\S]*?)<\/usage>/)
    if (usageMatch) {
      usage = (usageMatch[1] ?? '').replace(/\s+/g, ' ').trim()
      body = body.replace(/<usage>[\s\S]*?<\/usage>/g, '').trim()
    }
    out.push({ agentId: m[1] ?? '', agent: m[2] ?? '', type: m[3] ?? '', status: m[4] ?? '', body: body.trim(), usage })
  }
  return out
}

/**
 * 后台工作流完成通知（v2）：<workflow-notification runId name status>。
 * 与 <subagent-notification> 同一信封（<background-agent-notifications>）注入，
 * 这里单独解析、单独渲染一行——工作流不是子代理，图标与状态语义都不同。
 */
function parseWorkflowNotifications(content: string): Array<{ runId: string; name: string; status: string; body: string }> {
  const out: Array<{ runId: string; name: string; status: string; body: string }> = []
  const re = /<workflow-notification runId="([^"]*)" name="([^"]*)" status="([^"]*)">([\s\S]*?)<\/workflow-notification>/g
  for (const m of content.matchAll(re)) {
    out.push({ runId: m[1] ?? '', name: m[2] ?? '', status: m[3] ?? '', body: (m[4] ?? '').trim() })
  }
  return out
}
