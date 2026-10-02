/**
 * 撤回 / 编辑重发 / 撤销本轮文件改动 / 重试 的确认对话框（对标 ZCode v4 的四个动作面）。
 *
 * 自成一体：打开时自己 dry-run 取计划、自己执行、自己报错。
 * 这样消息流上的 RewindActions 与错误横幅上的「重试」能共用同一份判断与同一套文案，
 * 不会长成两种「看起来一样、点下去不一样」的撤回入口。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { applyRewind, previewRewind } from '../../lib/rewind-action'
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
  const files = fileRewindState(anchor)
  const [plan, setPlan] = useState<RewindPlan | null>(null)
  const [previewing, setPreviewing] = useState(true)
  const [withFiles, setWithFiles] = useState(files.enabled)
  const [draft, setDraft] = useState(anchor.content)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (mode !== 'edit') return
    textareaRef.current?.focus()
  }, [mode])

  // 打开或切换文件档时重新 dry-run：计划是「此刻磁盘状态」的快照，缓存一次就会骗人
  useEffect(() => {
    let cancelled = false
    setPreviewing(true)
    void previewRewind(sessionId, anchor.id, scopeFor(mode, withFiles))
      .then((next) => { if (!cancelled) setPlan(next) })
      .catch(() => { if (!cancelled) setPlan(null) })
      .finally(() => { if (!cancelled) setPreviewing(false) })
    return () => { cancelled = true }
  }, [mode, withFiles, sessionId, anchor.id])

  const touchesFiles = mode === 'files' || withFiles
  const restored = plan?.safeFiles ?? []
  const conflicts = plan?.unsafeFiles ?? []
  const gaps = plan?.gaps ?? []
  // 只有「确实要动文件」时才拿计划卡住确认；只撤对话时冲突照样列出来，供用户改选
  const blocked = touchesFiles && (conflicts.length > 0 || gaps.length > 0 || (plan !== null && !plan.canApply))
  // 只撤文件却一个都恢复不了：确认下去是空动作，不给这个按钮
  const nothingToDo = previewing || plan === null || (mode === 'files' && restored.length === 0)

  const confirm = useCallback(async () => {
    if (busy || nothingToDo) return
    setBusy(true)
    setFailure(null)
    let outcome
    try {
      outcome = await applyRewind(sessionId, anchor.id, scopeFor(mode, withFiles))
    } catch (err) {
      // 宿主通道 reject（IPC 层异常）也要落到界面文案上：
      // 不接住它就是「点了确认，按钮永远转圈」，用户连重试的入口都找不到
      console.error('[rewind] apply threw:', err)
      setBusy(false)
      setFailure(t('chat.rewind.error.truncate-failed'))
      return
    }
    setBusy(false)
    if (!outcome.ok) {
      setFailure(t(`chat.rewind.error.${outcome.error ?? 'plan-blocked'}`))
      return
    }
    onClose()
    // 空文本不发：截断已经生效，静默返回就是「消息没了也没跑起来」
    if (mode === 'edit' || mode === 'retry') {
      const text = (mode === 'edit' ? draft : anchor.content).trim()
      if (text) onResend?.(text, anchor)
    }
  }, [busy, nothingToDo, sessionId, anchor, mode, withFiles, draft, onClose, onResend, t])

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in"
      onClick={() => { if (!busy) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-[520px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-elevation-3 animate-pop-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy && !blocked && !nothingToDo) void confirm()
        }}
      >
        <div className="px-5 py-3.5 border-b border-dark-onSurfaceVariant/10 flex items-center gap-2">
          {blocked && <AlertTriangle size={16} className="text-md-error shrink-0" />}
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-3 text-[12px] leading-relaxed">
          {mode === 'edit' && (
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, Math.max(3, draft.split('\n').length))}
              className="w-full px-3 py-2 rounded-md3-sm bg-dark-surfaceContainer border border-dark-onSurfaceVariant/15 text-sm resize-y outline-none focus:border-md-primary/50"
            />
          )}

          <p className="text-dark-onSurfaceVariant">
            {mode === 'retry' ? t('chat.rewind.retryWillRemove') : t('chat.rewind.willRemove', { count: plan?.removedMessages ?? 0 })}
          </p>

          {showsFileToggle && (
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={withFiles}
                disabled={!files.enabled || busy}
                onChange={(e) => setWithFiles(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-dark-onSurfaceVariant">
                {t('chat.rewind.withFiles')}
                {!files.enabled && (
                  <span className="block text-[11px] opacity-70">{t(`chat.rewind.filesDisabled.${files.reason}`)}</span>
                )}
              </span>
            </label>
          )}

          {previewing && (
            <div className="flex items-center gap-2 text-[11px] text-dark-onSurfaceVariant/60">
              <Loader2 size={12} className="animate-spin" />
              <span>{t('chat.rewind.previewing')}</span>
            </div>
          )}

          {!previewing && plan === null && (
            <p className="text-[11px] text-md-error">{t('chat.rewind.previewFailed')}</p>
          )}

          {!previewing && plan && (
            <>
              {restored.length > 0 && (
                <FileList
                  heading={t('chat.rewind.willRestore', { count: restored.length })}
                  rows={restored.map((f) => ({
                    key: f.path,
                    label: shortPath(f.path),
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

          {failure && <p className="text-[11px] text-md-error">{failure}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-dark-onSurfaceVariant/10">
          {(mode === 'recall' || mode === 'retry') && blocked && !busy && (
            <button
              type="button"
              onClick={() => setWithFiles(false)}
              className="md-focus px-3 py-2 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
            >
              {t('chat.rewind.keepFiles')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="md-focus px-4 py-2 rounded-md3-sm text-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors disabled:opacity-50"
          >
            {t('chat.rewind.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy || nothingToDo || blocked}
            className="md-focus px-4 py-2 rounded-md3-sm text-sm font-medium bg-md-error text-white hover:bg-md-error/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function FileList(props: {
  heading: string
  tone?: 'error'
  rows: Array<{ key: string; label: string; note: string }>
}) {
  return (
    <div>
      <div className={`text-[11px] font-medium mb-1 ${props.tone === 'error' ? 'text-md-error' : 'text-dark-onSurfaceVariant'}`}>
        {props.heading}
      </div>
      <ul className="space-y-0.5">
        {props.rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3 font-mono text-[11px] text-dark-onSurfaceVariant/85">
            <span className="truncate" title={row.label}>{row.label}</span>
            <span className="shrink-0 opacity-70">{row.note}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
