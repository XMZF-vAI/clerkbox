import type { ReactElement, ReactNode } from 'react'
import type { BotProvider } from '../../../electron/im-bots/types'

/**
 * 渠道标识：自绘内联 SVG + 品牌色，不引第三方素材。
 *
 * 品牌色是**标识本身的颜色**（微信绿 / 飞书蓝），只出现在 SVG 的 fill 上，
 * 不参与主题 token 体系——界面底色、描边、文字一律仍走 `dark-*` / `md-*`，
 * 换肤时渠道 logo 不会跟着变，这正是它该有的行为。
 */

/** 微信绿（iLink 客户端同款）：仅用于二维码之外的标识 */
const WEIXIN_GREEN = '#07C160'
/** 飞书蓝 */
const FEISHU_BLUE = '#3370FF'

interface IconProps {
  className?: string
}

/** 微信：一大一小两个对话气泡 + 眼睛点 */
export function WeixinChannelIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M9.1 3.4c-4 0-7.3 2.6-7.3 5.8 0 1.9 1.1 3.6 2.8 4.7l-.7 2.1 2.4-1.3c.7.2 1.5.3 2.2.3h.5a5.6 5.6 0 0 1-.2-1.4c0-3.1 2.9-5.6 6.5-5.6h.5c-.6-2.7-3.6-4.8-7.2-4.6Z"
        fill={WEIXIN_GREEN}
      />
      <path
        d="M22.2 14.3c0-2.6-2.5-4.7-5.6-4.7s-5.6 2.1-5.6 4.7 2.5 4.7 5.6 4.7c.7 0 1.3-.1 1.9-.3l2 1.1-.6-1.7c1.6-.9 2.3-2.2 2.3-3.8Z"
        fill={WEIXIN_GREEN}
        opacity=".85"
      />
      <circle cx="6.9" cy="8.1" r=".9" fill="#fff" />
      <circle cx="11.3" cy="8.1" r=".9" fill="#fff" />
      <circle cx="14.9" cy="13.5" r=".75" fill="#fff" />
      <circle cx="18.5" cy="13.5" r=".75" fill="#fff" />
    </svg>
  )
}

/** 飞书：抽象「Lark 之翼」双弧 */
export function FeishuChannelIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path
        d="M3 6.6c2.2-.5 4 .5 5.6 2.4l3.2 3.9-4.2 5.6c-.7.9-1.9 1.2-3 .7l-1.7-.7 3.4-4.6L3 6.6Z"
        fill={FEISHU_BLUE}
      />
      <path
        d="M10.3 5.4c2.6-.6 4.8.6 7 3.2l3.4 4.1c1 1.2.7 2.7-.4 3.5l-2.2 1.6-5.1-6.3 1.1-1.6-3.8-4.5Z"
        fill={FEISHU_BLUE}
        opacity=".75"
      />
      <path d="M2.6 18.9c1.7.6 3.6.8 5.4.6l-1.3 1.6c-.3.4-.9.5-1.4.3l-3-1.2c-.4-.2-.2-.8.3-1.3Z" fill={FEISHU_BLUE} opacity=".5" />
    </svg>
  )
}

/** 渠道 → 图标组件：新增渠道只改这张表 */
const CHANNEL_ICONS: Record<BotProvider, (props: IconProps) => ReactElement> = {
  weixin: WeixinChannelIcon,
  feishu: FeishuChannelIcon,
}

export function ChannelIcon({
  provider,
  className,
}: {
  provider: BotProvider
  className?: string
}): ReactNode {
  const Icon = CHANNEL_ICONS[provider]
  return <Icon className={className} />
}

/**
 * 渠道标识的「色块底板」：底色用主题容器色（换肤跟随），图标自身保品牌色。
 * size: tile = 带圆角方块的渠道徽标，plain = 只有图形（列表行里已经贴文字时用）。
 */
export function ChannelBadge({
  provider,
  size = 'md',
}: {
  provider: BotProvider
  size?: 'sm' | 'md'
}) {
  const box = size === 'sm' ? 'w-6 h-6' : 'w-9 h-9'
  const glyph = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'
  return (
    <span
      className={`${box} flex items-center justify-center rounded-md3-sm bg-dark-surfaceContainerHigh flex-shrink-0`}
      aria-hidden
    >
      <ChannelIcon provider={provider} className={glyph} />
    </span>
  )
}
