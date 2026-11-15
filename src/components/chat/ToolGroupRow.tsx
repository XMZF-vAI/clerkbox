/**
 * 工具聚合组行（照抄 ZCode renderers/explore.tsx 与 execute-group.tsx）。
 *
 * 查阅组：🔍 查阅 · N 次网页抓取, N 搜索, N 列表, N 文件（非零桶按 fetch→search→list→file 序）；
 * 终端组：⌨ 终端 · N 个命令(, N 个失败)(, N 个已停止)。
 * 运行中收起态改写最新子工具动作（正在读取 / 正在执行 …），展开态恒写统计；
 * 展开体 = 左导线 + 子工具行（去图标）。组展开态按组首工具 id 持久，流式追加不丢。
 */
import { useId, useState } from 'react'
import { ChevronRight, Search, SquareTerminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getToolCardOpen, setToolCardOpen, toolGroupStateKey } from '../../lib/tool-card-state'
import { ToolShell } from './tool-renderers/ToolShell'
import { ToolCallRow, chipTextFor } from './ToolCallRow'
import {
  EXPLORE_BUCKET_ORDER, countExploreBuckets, executeGroupStats,
  isGroupRunning, latestActiveItem, type ToolRowItem,
} from './stream-rows'

interface ToolGroupRowProps {
  kind: 'explore' | 'execute'
  items: ToolRowItem[]
  vibe?: boolean
  sessionId?: string
}

export function ToolGroupRow({ kind, items, vibe, sessionId }: ToolGroupRowProps) {
  const { t } = useTranslation()
  const firstId = items[0]?.call.id ?? ''
  const groupKey = toolGroupStateKey(firstId)
  const detailId = useId()
  const [open, setOpen] = useState(() => getToolCardOpen(groupKey) ?? false)

  const running = isGroupRunning(items)
  const toggle = () => {
    const next = !open
    setOpen(next)
    setToolCardOpen(groupKey, next, { userAction: true })
  }

  const bucketLabels: Record<string, string> = {
    fetch: 'chat.explore.bucketFetch',
    search: 'chat.explore.bucketSearch',
    list: 'chat.explore.bucketList',
    file: 'chat.explore.bucketFile',
  }
  const counts = countExploreBuckets(items)
  const exploreSummary = EXPLORE_BUCKET_ORDER
    .filter((b) => counts[b] > 0)
    .map((b) => t(bucketLabels[b]!, { count: counts[b] }))
    .join(', ')
  const stats = executeGroupStats(items)
  const executeSummary = [
    t('chat.executeGroup.commands', { count: stats.total }),
    stats.failed > 0 ? t('chat.executeGroup.failed', { count: stats.failed }) : '',
    stats.stopped > 0 ? t('chat.executeGroup.stopped', { count: stats.stopped }) : '',
  ].filter(Boolean).join(', ')
  const summary = kind === 'explore' ? exploreSummary : executeSummary

  // 运行中收起态：最新子工具的动作短语（ZCode collapsedChildSummary）；展开恒写统计
  const activeChild = running && !open ? latestActiveItem(items) : undefined
  const childChip = activeChild ? chipTextFor(activeChild.call.name, activeChild.call.arguments, t) : ''
  const childActionLabel = activeChild ? runningChildLabel(activeChild.call.name, t) : ''

  const dim = vibe ? 'text-white/75' : 'text-dark-onSurfaceVariant'
  const guide = vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'
  const label = kind === 'explore' ? t('chat.explore.label') : t('chat.executeGroup.label')

  return (
    <div className="w-full min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={toggle}
        className={`md-focus group/toolgroup inline-flex max-w-full min-w-0 items-center gap-2 self-start rounded-md3-xs py-1 text-left text-ui-sm transition-colors duration-100 max-md:min-h-11 ${dim}`}
      >
        <span className="shrink-0">{kind === 'explore' ? <Search size={16} /> : <SquareTerminal size={16} />}</span>
        <span className={`shrink-0 whitespace-nowrap font-medium ${running ? 'thinking-shimmer' : ''}`}>{label}</span>
        <span className="shrink-0" aria-hidden>·</span>
        {activeChild ? (
          <span className="min-w-0 truncate">
            <span className={vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/70'}>{childActionLabel}</span>
            {childChip && <span className={vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/80'}> {childChip}</span>}
          </span>
        ) : (
          <span className={`min-w-0 truncate ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/80'}`}>{summary}</span>
        )}
        <ChevronRight
          size={16}
          className={`stream-row-chevron shrink-0 transition-all duration-200 ${open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover/toolgroup:opacity-100 group-focus-visible/toolgroup:opacity-100'}`}
        />
      </button>
      <ToolShell open={open} id={detailId}>
        <div className="pt-2">
          <div className={`ml-2 flex flex-col gap-2 border-l pl-3.5 ${guide}`}>
            {items.map((item) => (
              <ToolCallRow key={item.call.id} item={item} vibe={vibe} sessionId={sessionId} showIcon={false} />
            ))}
          </div>
        </div>
      </ToolShell>
    </div>
  )
}

/** 运行中子工具的动作词（ZCode getChildActionKindLabel：正在读取 / 正在抓取 / 正在搜索 / 正在执行） */
function runningChildLabel(name: string, t: ReturnType<typeof useTranslation>['t']): string {
  switch (name) {
    case 'read_file':
    case 'read_image': return t('chat.toolKind.reading')
    case 'list_dir': return t('chat.toolKind.listing')
    case 'search_files':
    case 'search_content':
    case 'web_search': return t('chat.toolKind.searching')
    case 'web_fetch': return t('chat.toolKind.fetching')
    case 'execute_command': return t('chat.toolKind.executing')
    default: return t('chat.toolKind.running')
  }
}
