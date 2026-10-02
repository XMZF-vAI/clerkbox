/**
 * 分支切换器（编程模式，输入框上方——ZCode 同款交互）。
 *
 * 芯片按钮：GitBranch 图标 + 当前分支名（+ dirty 计数），点击弹出分支列表：
 * 搜索过滤、当前分支高亮置顶、footer 新建分支（内联输入）与打开提交图谱。
 * 分支列表每次展开都重拉（切分支在别处发生时不会展示旧数据）；
 * 弹层向上展开（输入区贴着窗口底部），Escape / 外点关闭。
 */
import { useEffect, useRef, useState } from 'react'
import { Check, GitBranch, Loader2, Network, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import type { GitBranchListResult } from '../../types/ipc'
import GitGraphDialog from './GitGraphDialog'
import { emitGitRefresh, useGitStatus } from './use-git'

export default function BranchSwitcher({ workDir }: { workDir?: string }) {
  const { t } = useTranslation()
  const { data } = useGitStatus(workDir)
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<GitBranchListResult | null>(null)
  const [branchLoading, setBranchLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [showGraph, setShowGraph] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const summary = data?.summary
  const visible = Boolean(workDir && summary?.isRepository)
  const dirtyCount = (summary?.unstagedCount ?? 0) + (summary?.stagedCount ?? 0)

  // 外点 / Escape 关闭（与 harness 选择器同一套交互）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 展开时重拉分支列表
  useEffect(() => {
    if (!open || !workDir) return
    let disposed = false
    setBranchLoading(true)
    setFailure(null)
    ipc
      .gitGetBranches(workDir)
      .then((res) => {
        if (!disposed) setBranches(res)
      })
      .catch((err) => {
        if (!disposed) setFailure(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!disposed) setBranchLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [open, workDir])

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  if (!visible) return null

  const filtered = (branches?.branches ?? []).filter((b) =>
    b.name.toLowerCase().includes(filter.trim().toLowerCase()),
  )

  const switchTo = async (name: string) => {
    if (busy || !workDir) return
    setBusy(true)
    setFailure(null)
    try {
      const res = await ipc.gitSwitchBranch(workDir, name)
      if (!res.ok) {
        setFailure(res.issues[0]?.message ?? t('git.switchFailed'))
      } else {
        setOpen(false)
        emitGitRefresh(workDir)
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const createAndSwitch = async () => {
    const name = newName.trim()
    if (busy || !name || !workDir) return
    setBusy(true)
    setFailure(null)
    try {
      const res = await ipc.gitCreateBranchAndSwitch(workDir, name)
      if (!res.ok) {
        setFailure(res.issues[0]?.message ?? t('git.switchFailed'))
      } else {
        setCreating(false)
        setNewName('')
        setOpen(false)
        emitGitRefresh(workDir)
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t('git.switchBranch')}
        className="flex h-[26px] max-w-[180px] items-center gap-1 rounded-md3-sm px-1.5 text-[11px] text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors"
      >
        <GitBranch size={12} className="shrink-0" />
        <span className="min-w-0 truncate">
          {summary?.headRefType === 'detached' ? t('git.detached') : summary?.branchName}
        </span>
        {dirtyCount > 0 && (
          <span className="shrink-0 rounded-full bg-dark-surfaceContainerHigh px-1 text-[9px] leading-[14px]">
            {dirtyCount > 99 ? '99+' : dirtyCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t('git.switchBranch')}
          className="absolute bottom-full right-0 z-40 mb-1 w-72 overflow-hidden rounded-md3-lg border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainerHigh shadow-xl"
        >
          {/* 搜索 */}
          <div className="border-b border-dark-onSurfaceVariant/10 p-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('git.searchBranch')}
              className="w-full rounded-md3-sm bg-dark-surfaceContainer px-2 py-1.5 text-xs outline-none placeholder:text-dark-onSurfaceVariant/40 focus:ring-1 focus:ring-md-primary/50"
            />
          </div>

          {/* 分支列表 */}
          <div className="max-h-72 overflow-y-auto py-1">
            {branchLoading ? (
              <div className="flex items-center justify-center gap-1.5 py-4 text-xs text-dark-onSurfaceVariant">
                <Loader2 size={12} className="animate-spin" />
                {t('git.loading')}
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-dark-onSurfaceVariant/60">{t('git.noBranchMatch')}</p>
            ) : (
              filtered.map((branch) => {
                const isCurrent = branch.isCurrent
                return (
                  <button
                    key={branch.name}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    disabled={busy || isCurrent}
                    onClick={() => void switchTo(branch.name)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-dark-surfaceContainer transition-colors disabled:opacity-70"
                    data-branch-current={isCurrent || undefined}
                  >
                    <GitBranch size={11} className={isCurrent ? 'text-md-primary' : 'text-dark-onSurfaceVariant/50 shrink-0'} />
                    <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-medium text-md-primary' : ''}`}>
                      {branch.name}
                    </span>
                    {isCurrent && <Check size={12} className="shrink-0 text-md-primary" />}
                  </button>
                )
              })
            )}
          </div>

          {failure && (
            <p className="break-all border-t border-dark-onSurfaceVariant/10 px-3 py-2 text-[11px] text-md-error">
              {failure}
            </p>
          )}

          {/* footer：新建分支 + 图谱 */}
          <div className="border-t border-dark-onSurfaceVariant/10 p-2">
            {creating ? (
              <div className="flex items-center gap-1.5">
                <input
                  ref={inputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createAndSwitch()
                    if (e.key === 'Escape') setCreating(false)
                  }}
                  placeholder={t('git.branchNamePlaceholder')}
                  className="min-w-0 flex-1 rounded-md3-sm bg-dark-surfaceContainer px-2 py-1.5 text-xs outline-none placeholder:text-dark-onSurfaceVariant/40 focus:ring-1 focus:ring-md-primary/50"
                />
                <button
                  type="button"
                  onClick={() => void createAndSwitch()}
                  disabled={busy || !newName.trim()}
                  className="flex h-7 items-center gap-1 rounded-md3-md bg-md-primary/15 px-2 text-[11px] font-medium text-md-primary hover:bg-md-primary/25 transition-colors disabled:opacity-40"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  {t('git.createConfirm')}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex h-7 items-center gap-1.5 rounded-md3-sm px-2 text-[11px] text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer hover:text-dark-onSurface transition-colors"
                >
                  <Plus size={12} />
                  {t('git.createBranch')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    setShowGraph(true)
                  }}
                  className="flex h-7 items-center gap-1.5 rounded-md3-sm px-2 text-[11px] text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer hover:text-dark-onSurface transition-colors"
                >
                  <Network size={12} />
                  {t('git.openGraph')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showGraph && workDir && <GitGraphDialog workDir={workDir} onClose={() => setShowGraph(false)} />}
    </div>
  )
}
