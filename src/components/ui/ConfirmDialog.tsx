import { useEffect } from 'react'
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
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, onConfirm])

  return (
    // 普通模式下让出标题栏区域（top-11），保证窗口控制按钮始终可见可用；
    // 普通模式不用背景模糊（与清晰标题栏产生割裂感），仅均匀变暗
    <div
      className={`fixed ${isVibeMode ? 'inset-0' : 'inset-x-0 bottom-0 top-11'} z-50 flex items-center justify-center ${isVibeMode ? 'bg-black/50 backdrop-blur-sm' : 'bg-black/60'} animate-fade-in`}
      onClick={onCancel}
    >
      <div
        className="w-[400px] bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-onSurfaceVariant/10">
          <div className="flex items-center gap-2">
            {variant === 'danger' && (
              <AlertTriangle size={18} className="text-md-error" />
            )}
            <h2 className="text-base font-semibold">{title}</h2>
          </div>
          <button
            onClick={onCancel}
            className="w-7 h-7 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <p className="text-sm text-dark-onSurfaceVariant leading-relaxed">{message}</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-dark-onSurfaceVariant/10">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md3-sm text-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
          >
            {finalCancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-md3-sm text-sm font-medium transition-colors ${
              variant === 'danger'
                ? 'bg-md-error text-white hover:bg-md-error/90'
                : 'bg-md-primary text-md-onPrimary hover:bg-md-primary/90'
            }`}
          >
            {finalConfirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
