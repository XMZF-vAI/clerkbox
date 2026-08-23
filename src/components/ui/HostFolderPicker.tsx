import { useEffect, useState } from 'react'
import { ChevronDown, FolderOpen, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import type { FileEntry } from '../../types/ipc'

interface HostFolderPickerProps {
  open: boolean
  onClose: () => void
  onSelect: (path: string) => void
  initialPath?: string
  variant?: 'dark' | 'vibe'
}

const appendPath = (parent: string, name: string): string => {
  const separator = parent.includes('\\') ? '\\' : '/'
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`
}

const parentPath = (value: string): string | null => {
  const trimmed = value.replace(/[\\/]+$/, '') || value
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (index < 0) return null
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`
  if (index === 0) return trimmed.slice(0, 1)
  if (index === 2 && /^[A-Za-z]:/.test(trimmed)) return `${trimmed.slice(0, 3)}`
  return trimmed.slice(0, index) || null
}

export default function HostFolderPicker({
  open,
  onClose,
  onSelect,
  initialPath,
  variant = 'dark',
}: HostFolderPickerProps) {
  const { t } = useTranslation()
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const loadInitial = async () => {
      setLoading(true)
      setLoadFailed(false)
      setCurrentPath('')
      setEntries([])
      const home = await ipc.getHomeDir().catch(() => '')
      const candidates = [initialPath, home].filter((path): path is string => Boolean(path))
      for (const candidate of candidates) {
        try {
          const nextEntries = await ipc.listDir(candidate)
          if (cancelled) return
          setCurrentPath(candidate)
          setEntries(nextEntries.filter((entry) => entry.isDirectory).sort((a, b) => a.name.localeCompare(b.name)))
          setLoading(false)
          return
        } catch {
          // Fall back to the host home directory if a stale recent path is gone.
        }
      }
      if (!cancelled) {
        setLoading(false)
        setLoadFailed(true)
      }
    }

    void loadInitial()
    return () => {
      cancelled = true
    }
  }, [open, initialPath])

  if (!open) return null

  const isVibe = variant === 'vibe'
  const panelClass = isVibe
    ? 'bg-white/10 border-white/15 backdrop-blur-2xl text-white'
    : 'bg-dark-surfaceContainer border-dark-onSurfaceVariant/15 text-dark-onSurface'
  const hoverClass = isVibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh'

  const loadFolder = async (path: string) => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const nextEntries = await ipc.listDir(path)
      setCurrentPath(path)
      setEntries(nextEntries.filter((entry) => entry.isDirectory).sort((a, b) => a.name.localeCompare(b.name)))
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const navigateParent = () => {
    const parent = parentPath(currentPath)
    if (parent && parent !== currentPath) void loadFolder(parent)
  }

  return (
    <>
      <div className="fixed inset-0 z-[80] bg-black/55 animate-fade-in" onClick={onClose} aria-hidden />
      <div
        className={`fixed z-[81] inset-x-4 top-1/2 -translate-y-1/2 max-w-lg mx-auto rounded-md3-md border shadow-2xl overflow-hidden animate-fade-in ${panelClass}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.folderBrowseHost')}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-dark-onSurfaceVariant/10">
          <button
            type="button"
            onClick={navigateParent}
            disabled={!parentPath(currentPath) || loading}
            className={`p-2.5 max-md:p-3 rounded-md3-sm ${hoverClass} disabled:opacity-30`}
            title={t('chat.folderParent')}
            aria-label={t('chat.folderParent')}
          >
            <ChevronDown size={15} className="rotate-90" />
          </button>
          <span className="text-xs truncate flex-1" title={currentPath}>{currentPath || t('chat.folderNone')}</span>
          <button
            type="button"
            onClick={onClose}
            className={`p-2.5 max-md:p-3 rounded-md3-sm ${hoverClass}`}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X size={15} />
          </button>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {loading ? (
            <div className="px-3 py-8 text-center text-xs opacity-60">{t('chat.folderLoading')}</div>
          ) : loadFailed ? (
            <div className="px-3 py-8 text-center text-xs text-md-error">{t('chat.folderSelectionFailed')}</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs opacity-60">{t('chat.folderNoSubfolders')}</div>
          ) : (
            entries.map((entry) => {
              const childPath = appendPath(currentPath, entry.name)
              return (
                <button
                  key={childPath}
                  type="button"
                  onClick={() => void loadFolder(childPath)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 max-md:py-3 rounded-md3-sm text-left text-xs max-md:text-sm ${hoverClass}`}
                >
                  <FolderOpen size={14} className="text-md-info flex-shrink-0" />
                  <span className="truncate">{entry.name}</span>
                </button>
              )
            })
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-dark-onSurfaceVariant/10">
          <button type="button" onClick={onClose} className={`px-3 py-1.5 text-xs rounded-md3-sm ${hoverClass}`}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => { if (currentPath) { onSelect(currentPath); onClose() } }}
            disabled={!currentPath || loading || loadFailed}
            className="px-3 py-1.5 text-xs rounded-md3-sm bg-md-primary text-md-onPrimary hover:bg-md-primary/90 disabled:opacity-40"
          >
            {t('chat.folderUseThis')}
          </button>
        </div>
      </div>
    </>
  )
}
