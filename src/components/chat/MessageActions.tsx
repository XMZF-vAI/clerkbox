/**
 * 消息条上的操作按钮（对标 ZCode v4 的 MessageActions / MessageAction）。
 *
 * 三条约定，都是从 ZCode 直接抄来的做法，散在各消息组件里会长出四种悬浮条：
 * - **只在 hover / focus-within 时出现**，触屏（max-md）常驻 —— 键盘用户 Tab 进来也要看得见。
 * - 图标按钮不带文字，`aria-label` + `<span className="sr-only">` + 原生 `title` 三处同一个词，
 *   且文案一律走 i18n（ZCode 在 ConversationRowView 里明确禁止硬编码语言）。
 * - 动作条是消息行这个 `group/msg` 的子元素，不是气泡的子元素：
 *   挂在气泡里就只有压在气泡上才亮，挂在这一行上则整行都是热区。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** 复制成功后打勾保持多久（ZCode 取 1200ms；太短看不清，太长像卡住） */
const COPIED_FEEDBACK_MS = 1200

interface MessageActionsProps {
  children: ReactNode
  vibe?: boolean
  className?: string
}

/** 一条消息的动作条容器。父级必须带 `group/msg`，否则按钮永远不会显出来。 */
export function MessageActions({ children, vibe = false, className = '' }: MessageActionsProps) {
  return (
    <div
      className={`flex items-center gap-1 mt-0.5 opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 transition-opacity max-md:opacity-100 ${
        vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/55'
      } ${className}`}
    >
      {children}
    </div>
  )
}

interface MessageActionButtonProps {
  /** 常规态图标 */
  icon: ReactNode
  /** 已生效态图标（如复制完变成对勾）；不传就不换 */
  activeIcon?: ReactNode
  label: string
  onClick: () => void
  /** 选中态（如反馈已点）：底色提亮 */
  active?: boolean
  disabled?: boolean
  /** 禁用原因：ZCode 把它放进 tooltip，按钮灰掉但用户知道为什么 */
  disabledReason?: string
  vibe?: boolean
}

export function MessageActionButton({
  icon,
  activeIcon,
  label,
  onClick,
  active = false,
  disabled = false,
  disabledReason,
  vibe = false,
}: MessageActionButtonProps) {
  const shown = active && activeIcon ? activeIcon : icon
  // 禁用态的 button 元素不派发 hover 事件，title 就不弹；原因只能挂在包裹层上
  const hint = disabled && disabledReason ? disabledReason : label
  return (
    <span title={hint} className="inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active || undefined}
        className={`w-6 h-6 flex items-center justify-center rounded-md3-xs transition-colors ${
          disabled
            ? 'opacity-40 cursor-not-allowed'
            : vibe
              ? 'hover:bg-white/15 text-white/55 hover:text-white/85'
              : 'hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant/55 hover:text-dark-onSurfaceVariant'
        }`}
      >
        {shown}
        <span className="sr-only">{label}</span>
      </button>
    </span>
  )
}

interface CopyButtonProps {
  /** 要复制的正文；父级可以传「整轮合并文本」而不是这一条（ZCode 轮尾就是这个语义） */
  text: string
  /** tooltip 文案；默认「复制」，轮尾那种要写清楚复制的是整轮 */
  title?: string
  vibe?: boolean
}

/** 复制按钮：点击写剪贴板，1.2s 内显示对勾。剪贴板被拒时只在控制台报错，不打扰用户 */
export function CopyButton({ text, title, vibe = false }: CopyButtonProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    } catch (error) {
      console.error('Failed to copy message:', error)
    }
  }, [text])

  if (!text.trim()) return null

  return (
    <MessageActionButton
      icon={<Copy size={12} />}
      activeIcon={<Check size={12} className="text-md-success" />}
      label={title || t('common.copy')}
      onClick={() => void handleCopy()}
      active={copied}
      vibe={vibe}
    />
  )
}
