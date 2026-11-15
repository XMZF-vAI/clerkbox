import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useModalAccessibility } from '../../hooks/use-modal-accessibility'
import { AlertTriangle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore } from '../../stores/vibe-store'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  variant?: 'danger' | 'default'
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  title,
  message,
  confirmText,
  cancelText,
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const isVibeMode = useVibeStore((s) => s.isVibeMode)
  const finalConfirmText = confirmText || t('confirmDialog.confirm')
  const finalCancelText = cancelText || t('confirmDialog.cancel')
  const titleId = useId()
  const messageId = useId()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useModalAccessibility(onCancel, variant === 'danger' ? cancelButtonRef : confirmButtonRef)

  const panel = (
    // 普通模式下让出标题栏区域（top-11），保证窗口控制按钮始终可见可用；
    // 普通模式不用背景模糊（与清晰标题栏产生割裂感），仅均匀变暗
    <div
      className={`fixed ${isVibeMode ? 'inset-0' : 'inset-x-0 bottom-0 top-11 max-md:top-14'} z-[80] flex items-center justify-center ${isVibeMode ? 'bg-black/50 backdrop-blur-sm' : 'bg-black/60'} animate-fade-in`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        className="w-[440px] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-6rem)] bg-dark-surfaceDim text-dark-onSurface rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-elevation-3 animate-pop-in outline-none overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 px-6 py-5 max-md:px-4 border-b border-dark-onSurfaceVariant/10">
          <div className="flex min-w-0 items-center gap-3">
            {variant === 'danger' && (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md3-md bg-md-error/10 text-md-error" aria-hidden><AlertTriangle size={18} /></span>
            )}
            <h2 id={titleId} className="text-ui-base font-semibold break-words">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('common.close')}
            className="md-focus w-9 h-9 max-md:w-11 max-md:h-11 shrink-0 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 overflow-y-auto overscroll-contain px-6 py-5 max-md:px-4">
          <p id={messageId} className="text-ui-sm text-dark-onSurfaceVariant leading-relaxed whitespace-pre-line break-words">{message}</p>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-6 py-4 max-md:px-4 border-t border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/40">
          <button
            type="button"
            ref={cancelButtonRef}
            onClick={onCancel}
            className="md-focus min-h-10 max-md:min-h-11 px-4 py-2 rounded-md3-sm text-ui-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
          >
            {finalCancelText}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={onConfirm}
            className={`md-focus min-h-10 max-md:min-h-11 px-4 py-2 rounded-md3-sm text-ui-sm font-medium transition-colors ${
              variant === 'danger'
                ? 'bg-md-error text-md-onError hover:bg-md-error/90'
                : 'bg-md-primary text-md-onPrimary hover:bg-md-primary/90'
            }`}
          >
            {finalConfirmText}
          </button>
        </div>
      </div>
    </div>
  )
  // 确认框可能来自带入场 transform 的管理弹窗；挂到 body 才能覆盖整个视口。
  return typeof document === 'undefined' ? null : createPortal(panel, document.body)
}
