/**
 * Git 图谱弹窗（入口：分支切换器 footer，与 ZCode 同款形态）。
 *
 * 渲染 = 绝对定位 SVG（泳道连线与节点）覆盖层 + HTML 提交行表格：
 * - 数据 `git log --date-order --topo-order` 分页 50 条，滚动到近底自动加载下一页；
 * - 每行显示 refs 徽标 / subject / 时间 / 作者 / 短 hash，点击展开详情条（完整 hash、parents）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, GitMerge, Loader2, RefreshCw, Tag, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import type { GitCommitGraphCommit, GitCommitRef } from '../../types/ipc'
import {
  GRAPH_LANE_COLORS,
  GRAPH_LANE_GAP,
  GRAPH_ROW_HEIGHT,
  edgePath,
  layoutGitGraph,
  nodeX,
  nodeY,
} from './git-graph-layout'

const PAGE_SIZE = 50

const LANE_STROKE = ['stroke-emerald-400', 'stroke-sky-400', 'stroke-amber-400', 'stroke-fuchsia-400']
const LANE_FILL = ['fill-emerald-400', 'fill-sky-400', 'fill-amber-400', 'fill-fuchsia-400']

function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

function formatTime(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function RefBadge({ ref: refInfo }: { ref: GitCommitRef }) {
  if (refInfo.kind === 'tag') {
    return (
      <span className="flex shrink-0 items-center gap-0.5 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] leading-[15px] text-amber-300">
        <Tag size={8} />
        {refInfo.name}
      </span>
    )
  }
  if (refInfo.kind === 'head') {
    return (
      <span className="shrink-0 rounded border border-md-primary/50 bg-md-primary/15 px-1 text-[9px] leading-[15px] font-medium text-md-primary">
        {refInfo.name}
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-0.5 rounded border border-dark-onSurfaceVariant/25 px-1 text-[9px] leading-[15px] text-dark-onSurfaceVariant/80">
      <GitBranch size={8} />
      {refInfo.name}
    </span>
  )
}

export default function GitGraphDialog({ workDir, onClose }: { workDir: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [commits, setCommits] = useState<GitCommitGraphCommit[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [expandedHash, setExpandedHash] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fetchingMoreRef = useRef(false)

  const fetchPage = useCallback(
    async (skip: number) => {
      const res = await ipc.gitGetCommitGraph(workDir, PAGE_SIZE, skip)
      return res
    },
    [workDir],
  )

  const loadFirstPage = useCallback(() => {
    setLoading(true)
    setFailure(null)
    fetchPage(0)
      .then((res) => {
        setCommits(res.commits)
        setHasMore(res.hasMore)
        setExpandedHash(null)
      })
      .catch((err) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [fetchPage])

  useEffect(() => {
    loadFirstPage()
  }, [loadFirstPage])

  const loadMore = useCallback(() => {
    if (fetchingMoreRef.current || !hasMore) return
    fetchingMoreRef.current = true
    setLoadingMore(true)
    fetchPage(commits.length)
      .then((res) => {
        setCommits((prev) => [...prev, ...res.commits])
        setHasMore(res.hasMore)
      })
      .catch((err) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        fetchingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [commits.length, fetchPage, hasMore])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 96) loadMore()
  }

  const layout = layoutGitGraph(commits)
  const svgWidth = Math.max(64, layout.laneCount * GRAPH_LANE_GAP + 16)
  const svgHeight = commits.length * GRAPH_ROW_HEIGHT

  // 泳道 stroke/fill 按索引轮换；数量变化时兜底回第一个颜色
  const strokeOf = (colorIndex: number) => LANE_STROKE[colorIndex % GRAPH_LANE_COLORS]
  const fillOf = (colorIndex: number) => LANE_FILL[colorIndex % GRAPH_LANE_COLORS]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('git.graphTitle')}
        className="w-[720px] max-w-[calc(100vw-2rem)] h-[70vh] bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-elevation-3 animate-pop-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-dark-onSurfaceVariant/10 px-4">
          <GitBranch size={14} className="text-md-primary" />
          <h2 className="text-sm font-semibold">{t('git.graphTitle')}</h2>
          <span className="flex-1" />
          <button
            type="button"
            onClick={loadFirstPage}
            title={t('git.refresh')}
            aria-label={t('git.refresh')}
            className="flex h-7 w-7 items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-7 w-7 items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div ref={listRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-dark-onSurfaceVariant">
              <Loader2 size={14} className="animate-spin" />
              {t('git.loading')}
            </div>
          ) : failure ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-md-error">{failure}</div>
          ) : commits.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs text-dark-onSurfaceVariant/70">
              {t('git.graphEmpty')}
            </div>
          ) : (
            <div className="relative" style={{ minHeight: svgHeight }}>
              {/* 泳道 SVG 覆盖层 */}
              <svg
                className="pointer-events-none absolute left-0 top-0"
                width={svgWidth}
                height={svgHeight}
                aria-hidden
              >
                {layout.edges.map((edge, i) => (
                  <path
                    key={`e${i}`}
                    d={edgePath(edge.from, edge.to)}
                    fill="none"
                    strokeWidth={1.5}
                    className={strokeOf(edge.colorIndex)}
                    opacity={edge.to ? 0.8 : 0.4}
                  />
                ))}
                {layout.nodes.map((node) => (
                  <circle
                    key={node.hash}
                    cx={nodeX(node.lane)}
                    cy={nodeY(node.row)}
                    r={5}
                    className={fillOf(node.colorIndex)}
                    stroke="currentColor"
                  />
                ))}
              </svg>

              {/* 提交行 */}
              {commits.map((commit) => {
                const isMerge = commit.parents.length > 1
                const isOpen = expandedHash === commit.hash
                return (
                  <div key={commit.hash}>
                    <button
                      type="button"
                      onClick={() => setExpandedHash(isOpen ? null : commit.hash)}
                      className="grid w-full grid-cols-[64px_1fr_auto] items-center gap-2 pr-3 text-left hover:bg-dark-surfaceContainer transition-colors"
                      style={{ height: GRAPH_ROW_HEIGHT }}
                      aria-expanded={isOpen}
                    >
                      <span aria-hidden />
                      <span className="flex min-w-0 items-center gap-1.5">
                        {commit.refs.map((r) => (
                          <RefBadge key={`${commit.hash}:${r.kind}:${r.name}`} ref={r} />
                        ))}
                        {isMerge && <GitMerge size={11} className="shrink-0 text-dark-onSurfaceVariant/60" />}
                        <span className="min-w-0 truncate text-xs text-dark-onSurface">
                          {commit.subject || shortHash(commit.hash)}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3 font-mono text-[10px] text-dark-onSurfaceVariant/60">
                        <span className="w-[76px] text-right">{formatTime(commit.authoredAtMs)}</span>
                        <span className="w-[80px] truncate text-right">{commit.authorName ?? ''}</span>
                        <span className="w-[52px] text-right">{shortHash(commit.hash)}</span>
                      </span>
                    </button>
                    {isOpen && (
                      <div className="border-y border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/50 px-4 py-2 text-[11px] text-dark-onSurfaceVariant">
                        <div className="flex flex-wrap items-center gap-2">
                          {commit.refs.map((r) => (
                            <RefBadge key={`d:${commit.hash}:${r.kind}:${r.name}`} ref={r} />
                          ))}
                        </div>
                        <p className="mt-1 break-all text-dark-onSurface">{commit.subject}</p>
                        <p className="mt-1 break-all font-mono">
                          {t('git.graphHash')}: {commit.hash}
                        </p>
                        <p className="mt-0.5 break-all font-mono">
                          {t('git.graphParents')}: {commit.parents.map(shortHash).join(', ') || '—'}
                        </p>
                        <p className="mt-0.5">
                          {commit.authorName ?? '—'}
                          {commit.authoredAtMs ? ` · ${new Date(commit.authoredAtMs).toLocaleString()}` : ''}
                        </p>
                      </div>
                    )}
                  </div>
                )
              })}
              {loadingMore && (
                <div className="flex items-center justify-center gap-1.5 py-3 text-xs text-dark-onSurfaceVariant">
                  <Loader2 size={12} className="animate-spin" />
                  {t('git.graphLoadingMore')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
