/**
 * 工作台 Git 审查面板（编程模式专属 tab）。
 *
 * 结构对齐 ZCode 的 GitPane：数据源切换（未暂存/已暂存）+ 变更文件列表（+/- 行数）
 * + 展开懒加载 per-file diff；写操作（提交/推送）走独立弹窗，面板本体保持只读。
 * 刷新 = 打开时拉取 + 操作成功后广播 + 手动刷新按钮；没有 watcher 自动刷新。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  CloudUpload,
  FileDiff,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import type { GitDiffResult, GitFileChange, GitStatusSummary } from '../../types/ipc'
import DiffView from '../git/DiffView'
import { emitGitRefresh, useGitStatus } from '../git/use-git'

type SourceId = 'unstaged' | 'staged'

/** 文件行展示：目录弱化、文件名加亮（路径为仓库根相对） */
function FilePathLabel({ path, vibe }: { path: string; vibe?: boolean }) {
  const idx = path.lastIndexOf('/')
  const dir = idx === -1 ? '' : path.slice(0, idx + 1)
  const base = idx === -1 ? path : path.slice(idx + 1)
  return (
    <span className="min-w-0 truncate font-mono text-[11px]">
      <span className={vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/55'}>{dir}</span>
      <span className={vibe ? 'text-white/90' : 'text-dark-onSurface'}>{base}</span>
    </span>
  )
}

/** +/- 行数；二进制文件显示 BIN 徽标 */
function ChangeStat({ change }: { change: GitFileChange }) {
  const { t } = useTranslation()
  if (change.added === null && change.removed === null) {
    return (
      <span className="shrink-0 rounded px-1 text-[10px] font-medium bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant/70">
        BIN
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
      {change.kind !== 'deleted' && change.added !== null && change.added > 0 && (
        <span className="text-emerald-400">+{change.added}</span>
      )}
      {change.kind !== 'added' && change.removed !== null && change.removed > 0 && (
        <span className="text-red-400">-{change.removed}</span>
      )}
      {change.added === 0 && change.removed === 0 && (
        <span className="text-dark-onSurfaceVariant/50">{t('git.noLineChanges')}</span>
      )}
    </span>
  )
}

function KindBadge({ change }: { change: GitFileChange }) {
  const { t } = useTranslation()
  const map: Record<string, { label: string; className: string }> = {
    added: { label: t('git.kind.added'), className: 'text-emerald-400 border-emerald-500/30' },
    deleted: { label: t('git.kind.deleted'), className: 'text-red-400 border-red-500/30' },
    renamed: { label: t('git.kind.renamed'), className: 'text-sky-400 border-sky-500/30' },
    conflict: { label: t('git.kind.conflict'), className: 'text-amber-400 border-amber-500/30' },
    untracked: { label: t('git.kind.untracked'), className: 'text-dark-onSurfaceVariant/70 border-dark-onSurfaceVariant/25' },
  }
  const meta = map[change.kind]
  if (!meta) return null
  return (
    <span className={`shrink-0 rounded border px-1 text-[9px] leading-[14px] ${meta.className}`}>
      {meta.label}
    </span>
  )
}

// ── 提交弹窗 ──

function CommitDialog({
  workDir,
  changes,
  onClose,
}: {
  workDir: string
  changes: GitFileChange[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(changes.map((c) => c.path)))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const allSelected = selected.size === changes.length
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(changes.map((c) => c.path)))
  }
  const toggleOne = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const submit = async () => {
    if (busy || !message.trim() || selected.size === 0) return
    setBusy(true)
    setFailure(null)
    try {
      await ipc.gitCommit(workDir, message, [...selected])
      emitGitRefresh(workDir)
      onClose()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('git.commitTitle')}
        className="w-[520px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-elevation-3 animate-pop-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) void submit()
        }}
      >
        <div className="px-5 py-3.5 border-b border-dark-onSurfaceVariant/10">
          <h2 className="text-sm font-semibold">{t('git.commitTitle')}</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <div className="flex items-center justify-between pb-2">
            <label className="flex items-center gap-2 text-xs text-dark-onSurfaceVariant cursor-pointer">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-md-primary" />
              {t('git.selectAll')}
            </label>
            <span className="text-[11px] text-dark-onSurfaceVariant/60">
              {t('git.selectedCount', { count: selected.size })}
            </span>
          </div>
          <div className="rounded-md3-md border border-dark-onSurfaceVariant/10 divide-y divide-dark-onSurfaceVariant/5 max-h-56 overflow-y-auto">
            {changes.map((c) => (
              <label
                key={c.path}
                className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-dark-surfaceContainer cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.path)}
                  onChange={() => toggleOne(c.path)}
                  className="accent-md-primary shrink-0"
                />
                <FilePathLabel path={c.path} />
                {c.origPath && (
                  <span className="shrink-0 truncate font-mono text-[10px] text-dark-onSurfaceVariant/45">
                    ← {c.origPath}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  <KindBadge change={c} />
                  <ChangeStat change={c} />
                </span>
              </label>
            ))}
          </div>
          <textarea
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('git.commitMessagePlaceholder')}
            rows={3}
            className="mt-3 w-full resize-none rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer px-3 py-2 text-sm outline-none focus:border-md-primary/50 placeholder:text-dark-onSurfaceVariant/40"
          />
          {failure && (
            <p className="mt-2 break-all rounded-md3-sm bg-md-error/10 px-2.5 py-1.5 text-xs text-md-error">{failure}</p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-dark-onSurfaceVariant/10">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md3-md px-3 py-1.5 text-xs hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !message.trim() || selected.size === 0}
            className="flex items-center gap-1.5 rounded-md3-md bg-md-primary px-3.5 py-1.5 text-xs font-medium text-md-onPrimary hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {busy ? t('git.commitRunning') : t('git.commitButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 推送弹窗 ──

function PushDialog({
  workDir,
  summary,
  onClose,
}: {
  workDir: string
  summary: GitStatusSummary
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await ipc.gitPush(workDir)
      setDone(result.output || t('git.pushDone'))
      emitGitRefresh(workDir)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('git.pushTitle')}
        className="w-[460px] max-w-[calc(100vw-2rem)] bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10 flex flex-col shadow-elevation-3 animate-pop-in"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onClose()
        }}
      >
        <div className="px-5 py-3.5 border-b border-dark-onSurfaceVariant/10">
          <h2 className="text-sm font-semibold">{t('git.pushTitle')}</h2>
        </div>
        <div className="px-5 py-3 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <GitBranch size={13} className="text-dark-onSurfaceVariant shrink-0" />
            <span className="font-medium">{summary.branchName}</span>
            <span className="text-dark-onSurfaceVariant/60">
              {summary.upstreamName
                ? t('git.pushUpstream', { upstream: summary.upstreamName, ahead: summary.ahead, behind: summary.behind })
                : t('git.pushNoUpstream')}
            </span>
          </div>
          {done && (
            <pre className="whitespace-pre-wrap break-all rounded-md3-sm bg-dark-surfaceContainer px-2.5 py-2 text-[11px] text-emerald-300">
              {done}
            </pre>
          )}
          {failure && (
            <pre className="whitespace-pre-wrap break-all rounded-md3-sm bg-md-error/10 px-2.5 py-2 text-[11px] text-md-error">
              {failure}
            </pre>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-dark-onSurfaceVariant/10">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md3-md px-3 py-1.5 text-xs hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant transition-colors"
          >
            {done ? t('common.close') : t('common.cancel')}
          </button>
          {!done && (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md3-md bg-md-primary px-3.5 py-1.5 text-xs font-medium text-md-onPrimary hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <CloudUpload size={13} />}
              {busy ? t('git.pushRunning') : t('git.pushButton')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 面板本体 ──

export default function GitPanel({
  vibe,
  workDir,
  onClose,
}: {
  vibe?: boolean
  workDir?: string
  onClose?: () => void
}) {
  const { t } = useTranslation()
  const { data, loading, error, refresh } = useGitStatus(workDir)
  const [source, setSource] = useState<SourceId>('unstaged')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, GitDiffResult | 'loading'>>({})
  const [showCommit, setShowCommit] = useState(false)
  const [showPush, setShowPush] = useState(false)

  // 目录切换或数据刷新后清空 diff 缓存与展开态：缓存按「当时的仓库状态」渲染，不能跨刷新复用
  useEffect(() => {
    setDiffs({})
    setExpanded(null)
  }, [workDir, data])

  // Escape 关闭整个 tab（与 tab 栏 X 同义）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const changes = source === 'unstaged' ? data?.unstaged ?? [] : data?.staged ?? []
  const totalChanges = (data?.unstaged.length ?? 0) + (data?.staged.length ?? 0)

  const toggleExpand = (path: string) => {
    if (expanded === path) {
      setExpanded(null)
      return
    }
    setExpanded(path)
    const key = `${source}:${path}`
    if (!workDir || diffs[key]) return
    setDiffs((prev) => ({ ...prev, [key]: 'loading' }))
    ipc
      .gitGetDiff(workDir, path, source)
      .then((res) => setDiffs((prev) => ({ ...prev, [key]: res })))
      .catch(() =>
        setDiffs((prev) => ({ ...prev, [key]: { path, availability: 'unavailable', patch: null } })),
      )
  }

  const summary = data?.summary
  const canWrite = Boolean(workDir && summary?.isRepository && summary.branchName)

  const emptyHint = useMemo(() => {
    if (!workDir) return null
    if (loading && !data) return t('git.loading')
    if (error) return error
    if (!summary) return null
    if (!summary.isGitAvailable) return t('git.gitMissing')
    if (!summary.isRepository) return t('git.notGitRepo')
    return null
  }, [workDir, loading, data, error, summary, t])

  const renderDiff = (path: string) => {
    const res = diffs[`${source}:${path}`]
    if (!res || res === 'loading') {
      return (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-dark-onSurfaceVariant">
          <Loader2 size={12} className="animate-spin" />
          {t('git.loadingDiff')}
        </div>
      )
    }
    if (res.availability === 'binary') {
      return <div className="px-3 py-2 text-xs text-dark-onSurfaceVariant/70">{t('git.binaryFile')}</div>
    }
    if (res.availability === 'unavailable' || !res.patch) {
      return <div className="px-3 py-2 text-xs text-dark-onSurfaceVariant/70">{t('git.diffUnavailable')}</div>
    }
    return <DiffView patch={res.patch} />
  }

  return (
    <div className={`flex h-full flex-col ${vibe ? 'text-white' : 'bg-dark-surface'}`}>
      {/* 顶部：数据源 + 操作 */}
      <div
        className={`flex h-10 shrink-0 items-center gap-1 border-b px-2 ${
          vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'
        }`}
      >
        <button
          type="button"
          onClick={() => { setSource('unstaged'); setExpanded(null) }}
          className={`flex h-7 items-center gap-1.5 rounded-md3-md px-2 text-xs transition-colors ${
            source === 'unstaged'
              ? 'bg-md-primary/15 text-md-primary'
              : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh'
          }`}
        >
          {t('git.source.unstaged')}
          <span className="rounded-full bg-dark-surfaceContainerHigh px-1.5 text-[10px]">
            {data?.unstaged.length ?? 0}
          </span>
        </button>
        <button
          type="button"
          onClick={() => { setSource('staged'); setExpanded(null) }}
          className={`flex h-7 items-center gap-1.5 rounded-md3-md px-2 text-xs transition-colors ${
            source === 'staged'
              ? 'bg-md-primary/15 text-md-primary'
              : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh'
          }`}
        >
          {t('git.source.staged')}
          <span className="rounded-full bg-dark-surfaceContainerHigh px-1.5 text-[10px]">
            {data?.staged.length ?? 0}
          </span>
        </button>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => setShowPush(true)}
          disabled={!canWrite}
          title={t('git.pushTitle')}
          aria-label={t('git.pushTitle')}
          className="flex h-7 w-7 items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors disabled:opacity-40"
        >
          <CloudUpload size={14} />
        </button>
        <button
          type="button"
          onClick={() => setShowCommit(true)}
          disabled={!canWrite || totalChanges === 0}
          className="flex h-7 items-center gap-1.5 rounded-md3-md bg-md-primary/15 px-2 text-xs font-medium text-md-primary hover:bg-md-primary/25 transition-colors disabled:opacity-40"
        >
          <Plus size={13} />
          {t('git.commit')}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={!workDir}
          title={t('git.refresh')}
          aria-label={t('git.refresh')}
          className="flex h-7 w-7 items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors disabled:opacity-40"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 分支行 */}
      {summary?.isRepository && (
        <div
          className={`flex h-8 shrink-0 items-center gap-2 border-b px-3 text-[11px] ${
            vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'
          }`}
        >
          {summary.headRefType === 'detached' ? (
            <span className="flex items-center gap-1.5 text-dark-onSurfaceVariant">
              <CircleSlash size={12} />
              {t('git.detached')}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <GitBranch size={12} className="text-md-primary" />
              <span className="font-medium">{summary.branchName}</span>
            </span>
          )}
          {summary.upstreamName && (summary.ahead > 0 || summary.behind > 0) && (
            <span className="flex items-center gap-1.5 font-mono text-dark-onSurfaceVariant/70">
              {summary.ahead > 0 && <span>↑{summary.ahead}</span>}
              {summary.behind > 0 && <span>↓{summary.behind}</span>}
            </span>
          )}
        </div>
      )}

      {/* 主体 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {emptyHint ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <FileDiff size={22} className="text-dark-onSurfaceVariant/40" />
            <p className="text-xs text-dark-onSurfaceVariant/70">{emptyHint}</p>
          </div>
        ) : changes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Check size={22} className="text-emerald-400/70" />
            <p className="text-xs text-dark-onSurfaceVariant/70">{t('git.noChanges', { source: t(`git.source.${source}`) })}</p>
          </div>
        ) : (
          changes.map((change) => {
            const isOpen = expanded === change.path
            return (
              <div key={`${source}:${change.path}`}>
                <button
                  type="button"
                  onClick={() => toggleExpand(change.path)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    vibe ? 'hover:bg-white/5' : 'hover:bg-dark-surfaceContainer'
                  }`}
                  aria-expanded={isOpen}
                >
                  {isOpen ? (
                    <ChevronDown size={12} className="shrink-0 text-dark-onSurfaceVariant/60" />
                  ) : (
                    <ChevronRight size={12} className="shrink-0 text-dark-onSurfaceVariant/60" />
                  )}
                  <FilePathLabel path={change.path} vibe={vibe} />
                  <span className="ml-auto flex items-center gap-1.5">
                    <KindBadge change={change} />
                    <ChangeStat change={change} />
                  </span>
                </button>
                {isOpen && <div className="px-3 pb-2">{renderDiff(change.path)}</div>}
              </div>
            )
          })
        )}
      </div>

      {/* 底部错误条（拉取失败但已有旧数据时仍然可见） */}
      {error && data && (
        <div
          className={`flex shrink-0 items-center gap-1.5 border-t px-3 py-1.5 text-[11px] text-md-error ${
            vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'
          }`}
        >
          <CircleAlert size={12} className="shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {showCommit && workDir && totalChanges > 0 && (() => {
        // 暂存/未暂存可能同时含同一个文件（部分暂存），按路径去重：提交列表以路径为单位
        const seen = new Set<string>()
        const all: GitFileChange[] = []
        for (const c of [...(data?.staged ?? []), ...(data?.unstaged ?? [])]) {
          if (seen.has(c.path)) continue
          seen.add(c.path)
          all.push(c)
        }
        return <CommitDialog workDir={workDir} changes={all} onClose={() => setShowCommit(false)} />
      })()}
      {showPush && workDir && summary && (
        <PushDialog workDir={workDir} summary={summary} onClose={() => setShowPush(false)} />
      )}
    </div>
  )
}
