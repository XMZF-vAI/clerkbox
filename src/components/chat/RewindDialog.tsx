/**
 * 撤回 / 编辑重发 / 撤销本轮文件改动 / 重试 的确认对话框（对标 ZCode v4 的四个动作面）。
 *
 * 自成一体：打开时自己 dry-run 取计划、自己执行、自己报错。
 * 这样消息流上的 RewindActions 与错误横幅上的「重试」能共用同一份判断与同一套文案，
 * 不会长成两种「看起来一样、点下去不一样」的撤回入口。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { applyRewind, previewRewind } from '../../lib/rewind-action'
import { useModalAccessibility } from '../../hooks/use-modal-accessibility'
import { hasChatDraft, useChatStore } from '../../stores/chat-store'
import { useVibeStore } from '../../stores/vibe-store'
import type { Message, RewindPlan, RewindScope } from '../../types/agent'

export type RewindMode = 'recall' | 'edit' | 'files' | 'retry'

/** 本轮是否具备「带文件回滚」的条件（与计划侧同源：只有快照、未被撤销、没有无法证明的改动） */
export function fileRewindState(anchor: Message): {
  enabled: boolean
  reason: 'available' | 'noFiles' | 'reverted' | 'gaps'
} {
  if (anchor.filesReverted) return { enabled: false, reason: 'reverted' }
  if ((anchor.fileCheckpoints?.length ?? 0) === 0) return { enabled: false, reason: 'noFiles' }
  if ((anchor.mutationGaps?.length ?? 0) > 0) return { enabled: false, reason: 'gaps' }
  return { enabled: true, reason: 'available' }
}

function scopeFor(mode: RewindMode, withFiles: boolean): RewindScope {
  if (mode === 'files') return 'workspace'
  return withFiles ? 'both' : 'conversation'
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 路径太长时保留最后两级，够用且不撑破对话框 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts.length <= 3 ? path : `…/${parts.slice(-2).join('/')}`
}

export interface RewindDialogProps {
  sessionId: string
  anchor: Message
  mode: RewindMode
  onClose: () => void
  /** 撤回成功之后要发的新文本（edit 用编辑框内容，retry 用原文；recall/files 不传） */
  onResend?: (content: string, anchor: Message) => void
}

export default function RewindDialog({ sessionId, anchor, mode, onClose, onResend }: RewindDialogProps) {
  const { t } = useTranslation()
  const vibe = useVibeStore((s) => s.isVibeMode)
  const streaming = useChatStore((s) => s.streamingSessionIds.has(sessionId))
  const compacting = useChatStore((s) => s.compactingSessionIds.has(sessionId))
  const stopping = useChatStore((s) => s.stoppingSessionIds.has(sessionId))
  const submitting = useChatStore((s) => !!s.draftSubmitting[sessionId])
  const rewinding = useChatStore((s) => s.rewindingSessionIds.has(sessionId))
  const queued = useChatStore((s) => !!s.queuedMessages[sessionId]?.length)
  const currentDraft = useChatStore((s) => s.drafts[sessionId])
  const [plan, setPlan] = useState<RewindPlan | null>(null)
  const [previewing, setPreviewing] = useState(true)
  const [withFiles, setWithFiles] = useState(mode === 'files')
  const [draft, setDraft] = useState(anchor.content)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [filePreviewUnavailable, setFilePreviewUnavailable] = useState(false)
  const [previewRevision, setPreviewRevision] = useState(0)
  const busyRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const close = useCallback(() => {
    if (!busyRef.current && !busy && !rewinding) onClose()
  }, [busy, rewinding, onClose])
  const dialogRef = useModalAccessibility(close, mode === 'edit' ? textareaRef : cancelRef)

  // 始终预览整个尾段的文件范围，默认确认仍只删除对话。版本由 apply 再校验。
  useEffect(() => {
    let cancelled = false
    setPreviewing(true)
    setPlan(null)
    setFilePreviewUnavailable(false)
    const loadPlan = async () => {
      try {
        const next = await previewRewind(sessionId, anchor.id, mode === 'files' ? 'workspace' : 'both')
        if (next || mode === 'files') return next
      } catch (error) {
        if (mode === 'files') throw error
      }
      // 文件预览失败不应拦住只撤对话；此范围由宿主保证完全不读盘。
      if (cancelled) return null
      setFilePreviewUnavailable(true)
      setWithFiles(false)
      return previewRewind(sessionId, anchor.id, 'conversation')
    }
    void loadPlan()
      .then((next) => { if (!cancelled) setPlan(next) })
      .catch(() => { if (!cancelled) setPlan(null) })
      .finally(() => { if (!cancelled) setPreviewing(false) })
    return () => { cancelled = true }
  }, [mode, sessionId, anchor.id, previewRevision])

  const touchesFiles = mode === 'files' || withFiles
  const restored = plan?.safeFiles ?? []
  const conflicts = plan?.unsafeFiles ?? []
  const gaps = plan?.gaps ?? []
  const files = filePreviewUnavailable ? { enabled: false, reason: 'previewUnavailable' as const }
    : !plan ? { enabled: false, reason: 'noFiles' as const }
    : anchor.filesReverted ? { enabled: false, reason: 'reverted' as const }
    : gaps.length > 0 ? { enabled: false, reason: 'gaps' as const }
    : restored.length + conflicts.length === 0 ? { enabled: false, reason: 'noFiles' as const }
    : { enabled: true, reason: 'available' as const }
  const sessionReason = rewinding ? t('chat.rewind.busy.rewinding')
    : submitting ? t('chat.rewind.busy.submitting')
    : compacting ? t('chat.rewind.busy.compacting')
    : streaming || stopping ? t('chat.rewind.busy.running')
    : queued ? t('chat.rewind.busy.queued')
    : null
  const draftConflict = mode === 'recall' && hasChatDraft(currentDraft)
  // 只有「确实要动文件」时才拿计划卡住确认；只撤对话时冲突照样列出来，供用户改选
  const blocked = touchesFiles && (conflicts.length > 0 || gaps.length > 0 || (plan !== null && !plan.canApply))
  // 只撤文件却一个都恢复不了：确认下去是空动作，不给这个按钮
  const emptyResend = (mode === 'edit' || mode === 'retry') &&
    !(mode === 'edit' ? draft : anchor.content).trim() && !anchor.attachments?.length
  const nothingToDo = previewing || plan === null || (mode === 'files' && restored.length === 0) || emptyResend

  const confirm = useCallback(async () => {
    if (busyRef.current || busy || nothingToDo || blocked || sessionReason || draftConflict) return
    busyRef.current = true
    setBusy(true)
    setFailure(null)
    let outcome
    try {
      outcome = await applyRewind(sessionId, anchor.id, scopeFor(mode, withFiles), {
        expectedHistoryVersion: plan!.historyVersion,
        restoreDraft: mode === 'recall',
      })
    } catch (err) {
      // 宿主通道 reject（IPC 层异常）也要落到界面文案上：
      // 不接住它就是「点了确认，按钮永远转圈」，用户连重试的入口都找不到
      console.error('[rewind] apply threw:', err)
      busyRef.current = false
      setBusy(false)
      setFailure(t('chat.rewind.error.truncate-failed'))
      return
    }
    busyRef.current = false
    setBusy(false)
    if (!outcome.ok) {
      setFailure(t(`chat.rewind.error.${outcome.error ?? 'plan-blocked'}`))
      return
    }
    onClose()
    // 附件消息允许没有正文；空文本且无附件已在确认前阻止。
    if (mode === 'edit' || mode === 'retry') {
      const text = (mode === 'edit' ? draft : anchor.content).trim()
      if (text || anchor.attachments?.length) onResend?.(text, anchor)
    }
  }, [busy, nothingToDo, blocked, sessionReason, draftConflict, sessionId, anchor, mode, withFiles, draft, plan, onClose, onResend, t])

  const title =
    mode === 'edit' ? t('chat.rewind.editTitle') :
    mode === 'retry' ? t('chat.rewind.retryTitle') :
    mode === 'files' ? t('chat.rewind.filesTitle') :
    t('chat.rewind.recallTitle')

  const confirmLabel =
    mode === 'edit' ? t('chat.rewind.editConfirm') :
    mode === 'retry' ? t('chat.rewind.retryConfirm') :
    t('chat.rewind.confirm')

  const showsFileToggle = mode !== 'files'

  const panel = (
    <div
      className={`fixed ${vibe ? 'inset-0 bg-black/50 backdrop-blur-sm' : 'inset-x-0 bottom-0 top-11 max-md:top-14 bg-black/60'} z-[80] flex items-center justify-center p-4 animate-fade-in`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
        className="w-[540px] max-w-full max-h-[calc(100dvh-6rem)] text-dark-onSurface bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-elevation-3 animate-pop-in outline-none overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void confirm()
          }
        }}
      >
        <div className="shrink-0 px-5 py-4 border-b border-dark-onSurfaceVariant/10 flex items-center gap-2">
          {blocked && <AlertTriangle size={16} className="text-md-error shrink-0" />}
          <h2 id={titleId} className="flex-1 text-sm font-semibold">{title}</h2>
          <button type="button" onClick={close} disabled={busy || rewinding} aria-label={t('common.close')} className="md-focus flex h-9 w-9 shrink-0 items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh disabled:opacity-40">
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 px-5 py-4 overflow-y-auto overscroll-contain space-y-4 text-ui-sm leading-relaxed">
          {mode === 'edit' && (
            <textarea
              ref={textareaRef}
              value={draft}
              aria-label={t('chat.rewind.editTitle')}
              disabled={busy || !!sessionReason}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, Math.max(3, draft.split('\n').length))}
              className="w-full px-3 py-2 rounded-md3-sm bg-dark-surfaceContainer border border-dark-onSurfaceVariant/15 text-sm resize-y outline-none focus:border-md-primary/50"
            />
          )}

          <p id={descriptionId} className="text-dark-onSurfaceVariant">
            {mode === 'files' ? t('chat.rewind.filesOnly')
              : plan ? t('chat.rewind.willRemove', { count: plan.removedMessages })
              : t('chat.rewind.rangeDescription')}
          </p>
          {mode !== 'files' && (
            <section aria-label={t('chat.rewind.selectedMessage')} className="min-w-0 rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/60 px-3 py-3">
              <h3 className="mb-2 text-ui-xs font-medium text-dark-onSurfaceVariant">{t('chat.rewind.selectedMessage')}</h3>
              {anchor.content && <p className="max-h-28 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-ui-sm">{anchor.content}</p>}
              {(!!anchor.attachments?.length || !!anchor.taskMode) && (
                <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 text-ui-xs text-dark-onSurfaceVariant">
                  {anchor.taskMode && <span className="rounded-md3-xs bg-md-primary/10 px-2 py-1 text-md-primary">{t('chat.rewind.selectedTaskMode', { mode: t({ spec: 'chat.cmdSpecName', plan: 'chat.cmdPlanName', goal: 'chat.cmdGoalName' }[anchor.taskMode]) })}</span>}
                  {anchor.attachments?.map((attachment) => <span key={attachment.id} title={attachment.name} className="max-w-full truncate rounded-md3-xs bg-dark-surfaceContainerHigh px-2 py-1">{attachment.name}</span>)}
                </div>
              )}
            </section>
          )}
          {mode === 'recall' && <p className="text-dark-onSurfaceVariant/75">{t('chat.rewind.restoreDraft')}</p>}
          {mode === 'retry' && <p className="text-dark-onSurfaceVariant/75">{t('chat.rewind.retryWillRemove')}</p>}

          {showsFileToggle && (
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={withFiles}
                disabled={!files.enabled || busy || !!sessionReason || previewing}
                onChange={(e) => { setWithFiles(e.target.checked); setFailure(null) }}
                className="mt-0.5"
              />
              <span className="text-dark-onSurfaceVariant">
                {t('chat.rewind.withFiles')}
                {!previewing && !files.enabled && (
                  <span className="block text-[11px] opacity-70">{t(`chat.rewind.filesDisabled.${files.reason}`)}</span>
                )}
              </span>
            </label>
          )}
          {showsFileToggle && !withFiles && <p className="text-[11px] text-dark-onSurfaceVariant/70">{t('chat.rewind.filesKept')}</p>}

          {previewing && (
            <div className="flex items-center gap-2 text-[11px] text-dark-onSurfaceVariant/60">
              <Loader2 size={12} className="animate-spin" />
              <span>{t('chat.rewind.previewing')}</span>
            </div>
          )}

          {!previewing && plan === null && (
            <p role="alert" className="text-[11px] text-md-error">{t('chat.rewind.previewFailed')}</p>
          )}

          {!previewing && plan && (
            <>
              {restored.length > 0 && (
                <FileList
                  heading={t(touchesFiles ? 'chat.rewind.willRestore' : 'chat.rewind.affectedFiles', { count: restored.length })}
                  rows={restored.map((f) => ({
                    key: f.path,
                    label: shortPath(f.path),
                    title: f.path,
                    note: f.action === 'delete' ? t('chat.rewind.deleteNew') : formatBytes(f.bytes),
                  }))}
                />
              )}
              {conflicts.length > 0 && (
                <FileList
                  tone="error"
                  heading={t('chat.rewind.conflicts', { count: conflicts.length })}
                  rows={conflicts.map((f) => ({
                    key: f.path,
                    label: shortPath(f.path),
                    title: f.path,
                    note: t(`chat.rewind.conflictReason.${f.reason ?? 'unreadable'}`),
                  }))}
                />
              )}
              {gaps.length > 0 && (
                <p className="text-[11px] text-md-error/90">
                  {t('chat.rewind.gaps', { tools: gaps.map((g) => g.toolName).join('、') })}
                </p>
              )}
              {mode === 'files' && restored.length === 0 && conflicts.length === 0 && (
                <p className="text-dark-onSurfaceVariant/70">{t('chat.rewind.nothingToUndo')}</p>
              )}
            </>
          )}

          {blocked && !previewing && (
            <p className="text-[11px] text-md-error">
              {mode === 'recall' || mode === 'retry'
                ? t('chat.rewind.conflictBlockedWithAlternative')
                : t('chat.rewind.conflictBlocked')}
            </p>
          )}

          {sessionReason && <p role="status" className="text-ui-xs text-dark-onSurfaceVariant">{sessionReason}</p>}
          {draftConflict && <p role="alert" className="text-ui-xs text-md-error">{t('chat.rewind.error.draft-conflict')}</p>}
          {failure && <p role="alert" className="text-ui-xs text-md-error">{failure}</p>}
          {!busy && !previewing && (failure || !plan) && (
            <button type="button" onClick={() => { setFailure(null); setPreviewRevision((value) => value + 1) }} className="md-focus rounded-md3-sm px-3 py-2 text-ui-xs text-md-primary hover:bg-md-primary/10">
              {t('chat.rewind.refreshPreview')}
            </button>
          )}
        </div>

        <div className="shrink-0 flex flex-wrap items-center justify-end gap-2 px-5 py-4 border-t border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/40">
          {(mode === 'recall' || mode === 'retry') && blocked && !busy && (
            <button
              type="button"
              onClick={() => { setWithFiles(false); setFailure(null) }}
              className="md-focus px-3 py-2 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
            >
              {t('chat.rewind.keepFiles')}
            </button>
          )}
          <button
            type="button"
            ref={cancelRef}
            onClick={close}
            disabled={busy || rewinding}
            className="md-focus min-h-10 max-md:min-h-11 px-4 py-2 rounded-md3-sm text-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors disabled:opacity-50"
          >
            {t('chat.rewind.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || nothingToDo || blocked || !!sessionReason || draftConflict}
            className="md-focus min-h-10 max-md:min-h-11 px-4 py-2 rounded-md3-sm text-sm font-medium bg-md-error text-white hover:bg-md-error/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <span className="flex items-center gap-2"><Loader2 size={13} className="animate-spin" />{t('chat.rewind.busy.rewinding')}</span> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? null : createPortal(panel, document.body)
}

function FileList(props: {
  heading: string
  tone?: 'error'
  rows: Array<{ key: string; label: string; note: string; title?: string }>
}) {
  return (
    <div>
      <div className={`text-[11px] font-medium mb-1 ${props.tone === 'error' ? 'text-md-error' : 'text-dark-onSurfaceVariant'}`}>
        {props.heading}
      </div>
      <ul className="space-y-0.5">
        {props.rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3 font-mono text-[11px] text-dark-onSurfaceVariant/85">
            <span className="min-w-0 truncate" title={row.title ?? row.label}>{row.label}</span>
            <span className="shrink-0 opacity-70">{row.note}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
