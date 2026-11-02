/**
 * Markdown 正文的唯一渲染组件（聊天消息 / 子代理正文 / 工作流结果共用）。
 *
 * 这里也是 dangerouslySetInnerHTML 的第二个出口——但内容一律经 renderMarkdown
 * 转义后再注入，XSS 边界仍在 lib/markdown.ts 一处收口。
 *
 * 代码高亮（shiki）经「启动预载 + 版本订阅」接入：高亮器在 main.tsx 启动时预载，
 * 就绪 / 语言补载完成时 bump 版本号，这里用 useSyncExternalStore 订阅——版本变化
 * 只让挂载中的 MarkdownContent 各自重渲一次，无 setState、不牵动父组件，与流式
 * 渲染循环互不放大（通道实现见 lib/code-highlighter.ts）。
 * 高亮器未就绪时 renderMarkdown 内部走纯文本兜底（markdown.ts 的 renderCodeBlock）。
 *
 * size：
 *  - 'base'    正文档（text-sm），对话气泡用；
 *  - 'compact' 紧凑档（text-ui-xs），工具卡 / 子代理面板这类 12px 上下文用——
 *              默认档的 h1 是 20px，塞进卡片会把行高撑破。
 */
import { memo, useMemo, useSyncExternalStore } from 'react'
import { renderMarkdown } from '../../lib/markdown'
import { getHighlightVersion, subscribeHighlightVersion } from '../../lib/code-highlighter'

export type MarkdownSize = 'base' | 'compact'

export const MarkdownContent = memo(function MarkdownContent({
  content,
  vibe,
  size = 'base',
}: {
  content: string
  vibe?: boolean
  size?: MarkdownSize
}) {
  const highlightVersion = useSyncExternalStore(subscribeHighlightVersion, getHighlightVersion)
  const html = useMemo(() => renderMarkdown(content), [content, highlightVersion])
  const classes = ['markdown-body']
  if (vibe) classes.push('md-vibe')
  if (size === 'compact') classes.push('md-compact')
  return <div className={classes.join(' ')} dangerouslySetInnerHTML={{ __html: html }} />
})
