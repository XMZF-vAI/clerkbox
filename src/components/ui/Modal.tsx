import { useId, type ReactNode } from 'react'
import { useModalAccessibility } from '../../hooks/use-modal-accessibility'
export { useOverlayKeyboardLock } from '../../hooks/use-modal-accessibility'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore } from '../../stores/vibe-store'

/**
 * 轻量 Modal 基座。
 *
 * 视觉对齐 `ConfirmDialog.tsx`（遮罩/面板/头/身/尾的既成组合，见 DESIGN.md §4.1），
 * 差别只有两点：① 内容走 children（管理面板需要自己的分区结构，不是「一段话 + 两个按钮」）；
 * ② 经 portal 挂到 body —— 侧栏与工作台容器都带 transform，会把 fixed 的坐标系重定义掉，
 *    与 `MessageItem.tsx` 的浮层同一个理由。
 *
 * 与设置页、确认框共用键盘栈，保证只有栈顶响应 Escape / Tab。
 * 保留 useOverlayKeyboardLock 导出，兼容机器人管理与绑定面板。
 */

interface ModalProps {
  title: string
  /** 副标题：有值时挂 aria-describedby，同时显示在标题下方 */
  description?: string
  onClose: () => void
  children: ReactNode
  /** 标题左侧图标（渠道 / 功能标识），纯装饰，不参与无障碍名 */
  titleIcon?: ReactNode
  /** 底部操作区：不传则不渲染 footer（省掉一条分隔线） */
  footer?: ReactNode
  /** 面板宽度类，默认 w-[560px]；宽弹窗传 w-[680px] */
  widthClass?: string
  /** 正文内边距覆盖：主从式面板要自己控制成 p-0 + 内部分区 */
  bodyClassName?: string
  /** 正文是否自带滚动：主从式面板把滚动交给右栏，这里关掉以免出现两条滚动条 */
  bodyScroll?: boolean
}

export default function Modal({
  title,
  description,
  onClose,
  children,
  titleIcon,
  footer,
  widthClass = 'w-[560px]',
  bodyClassName = 'px-6 py-5 max-md:px-4 space-y-4',
  bodyScroll = true,
}: ModalProps) {
  const { t } = useTranslation()
  const isVibeMode = useVibeStore((s) => s.isVibeMode)
  const titleId = useId()
  const descId = useId()
  const panelRef = useModalAccessibility(onClose, undefined, { respectOverlayLock: true })

  const panel = (
    <div
      className={`fixed ${
        isVibeMode ? 'inset-0' : 'inset-x-0 bottom-0 top-11 max-md:top-14'
      } z-50 flex items-center justify-center ${
        isVibeMode ? 'bg-black/50 backdrop-blur-sm' : 'bg-black/60'
      } animate-fade-in`}
      onMouseDown={(e) => {
        // 只认点遮罩本身：面板里的拖选、文字选中不该关窗
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        // 高度上限用 rem 之外的算式：弹窗要贴着视口走，字号放大时靠内部滚动兜住
        className={`${widthClass} max-w-[calc(100vw-2rem)] max-md:w-[calc(100vw-1rem)] max-h-[calc(100dvh-6rem)] max-md:max-h-[calc(100dvh-5rem)] bg-dark-surfaceDim text-dark-onSurface rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-elevation-3 animate-pop-in outline-none overflow-hidden`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 py-5 max-md:px-4 border-b border-dark-onSurfaceVariant/10">
          <div className="flex items-start gap-3 min-w-0">
            {titleIcon && (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer text-md-primary" aria-hidden>
                {titleIcon}
              </span>
            )}
            <div className="min-w-0">
              <h2 id={titleId} className="text-ui-lg font-semibold break-words">{title}</h2>
              {description && (
                <p id={descId} className="mt-1 text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{description}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="md-focus flex-shrink-0 w-9 h-9 max-md:w-11 max-md:h-11 -mr-1 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
          >
            <X size={14} />
          </button>
        </div>

        <div className={`flex-1 min-h-0 ${bodyScroll ? 'overflow-y-auto overscroll-contain' : 'overflow-hidden'} ${bodyClassName}`}>
          {children}
        </div>

        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-6 py-4 max-md:px-4 border-t border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/40">
            {footer}
          </div>
        )}
      </div>
    </div>
  )

  // 测试环境（jsdom 之外的 SSR / node 直跑）没有 document：返回 null 而不是抛
  if (typeof document === 'undefined') return null
  return createPortal(panel, document.body)
}
