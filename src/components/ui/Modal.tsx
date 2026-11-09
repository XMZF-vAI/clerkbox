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
  bodyClassName = 'px-5 py-4 space-y-3',
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
        isVibeMode ? 'inset-0' : 'inset-x-0 bottom-0 top-11'
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
        className={`${widthClass} max-w-[calc(100vw-2rem)] max-md:w-[calc(100vw-1rem)] max-h-[calc(100vh-6rem)] max-md:max-h-[calc(100vh-3rem)] bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-elevation-3 animate-pop-in outline-none`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-dark-onSurfaceVariant/10">
          <div className="flex items-center gap-2 min-w-0">
            {titleIcon && (
              <span className="flex-shrink-0 text-md-primary" aria-hidden>
                {titleIcon}
              </span>
            )}
            <h2 id={titleId} className="text-ui-base font-semibold truncate">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="md-focus flex-shrink-0 w-7 h-7 max-md:w-9 max-md:h-9 -mr-1 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-dark-onSurfaceVariant"
          >
            <X size={14} />
          </button>
        </div>

        {description && (
          <p id={descId} className="px-5 pt-3 pb-2 text-ui-sm text-dark-onSurfaceVariant leading-relaxed">
            {description}
          </p>
        )}

        <div className={`flex-1 min-h-0 ${bodyScroll ? 'overflow-y-auto' : 'overflow-hidden'} ${bodyClassName}`}>
          {children}
        </div>

        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-dark-onSurfaceVariant/10">
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
