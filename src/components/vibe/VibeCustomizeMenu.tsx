import { useEffect, useRef, useState } from 'react'
import { X, Image, Music, FolderOpen, File } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore, DEFAULT_VIBE_BACKGROUND, DEFAULT_VIBE_MUSIC } from '../../stores/vibe-store'
import { ipc } from '../../lib/ipc-client'

interface VibeCustomizeMenuProps {
  onClose: () => void
}

export default function VibeCustomizeMenu({ onClose }: VibeCustomizeMenuProps) {
  const { t } = useTranslation()
  const background = useVibeStore((s) => s.background)
  const music = useVibeStore((s) => s.music)
  const musicFolder = useVibeStore((s) => s.musicFolder)
  const setBackground = useVibeStore((s) => s.setBackground)
  const setMusic = useVibeStore((s) => s.setMusic)
  const setMusicFolder = useVibeStore((s) => s.setMusicFolder)

  const [bgUrl, setBgUrl] = useState(background.type === 'url' ? background.value : '')
  const [musicUrl, setMusicUrl] = useState(music?.type === 'url' ? music.value : '')

  const dialogRef = useRef<HTMLDivElement>(null)

  // Escape 关闭 + 焦点陷阱
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog) dialog.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      // 简易焦点陷阱：Tab/Shift+Tab 在 dialog 内循环
      if (e.key === 'Tab' && dialog) {
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSelectLocalBackground = async () => {
    const path = await ipc.selectImageFile()
    if (path) {
      setBackground({ type: 'local', value: path })
    }
  }

  const handleApplyBackgroundUrl = () => {
    if (bgUrl.trim()) {
      setBackground({ type: 'url', value: bgUrl.trim() })
    }
  }

  const handleResetBackground = () => {
    setBackground(DEFAULT_VIBE_BACKGROUND)
    setBgUrl(DEFAULT_VIBE_BACKGROUND.value)
  }

  const handleSelectLocalMusic = async () => {
    const path = await ipc.selectAudioFile()
    if (path) {
      setMusic({ type: 'local', value: path })
      setMusicUrl('')
    }
  }

  const handleApplyMusicUrl = () => {
    if (musicUrl.trim()) {
      setMusic({ type: 'url', value: musicUrl.trim() })
    }
  }

  const handleResetMusic = () => {
    setMusic(DEFAULT_VIBE_MUSIC)
    setMusicUrl(DEFAULT_VIBE_MUSIC.value)
  }

  const handleSelectMusicFolder = async () => {
    const folder = await ipc.selectMusicFolder()
    if (folder) {
      setMusicFolder(folder)
      setMusicUrl('')
    }
  }

  const handleClearMusicFolder = () => {
    setMusicFolder(null)
    setMusic(DEFAULT_VIBE_MUSIC)
    setMusicUrl(DEFAULT_VIBE_MUSIC.value)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-start p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} aria-hidden="true" />

      {/* Menu panel */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('vibe.customizeTitle')}
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm liquid-glass-strong rounded-3xl p-5 text-white/90 animate-slide-up focus:outline-none"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium">{t('vibe.customizeTitle')}</h3>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/15 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Background section */}
        <div className="space-y-3 mb-5">
          <div className="flex items-center gap-2 text-xs font-medium text-white/80">
            <Image size={14} />
            <span>{t('vibe.background')}</span>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={bgUrl}
              onChange={(e) => setBgUrl(e.target.value)}
              placeholder={t('vibe.bgUrlPlaceholder')}
              className="flex-1 px-3 py-1.5 text-xs bg-white/10 border border-white/20 rounded-lg placeholder-white/40 outline-none focus:border-white/40 transition-colors"
            />
            <button
              onClick={handleApplyBackgroundUrl}
              disabled={!bgUrl.trim()}
              className="px-3 py-1.5 text-xs rounded-lg bg-white/20 hover:bg-white/30 disabled:opacity-40 transition-colors"
            >
              {t('common.apply')}
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSelectLocalBackground}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
            >
              <File size={13} />
              {t('vibe.selectLocalImage')}
            </button>
            <button
              onClick={handleResetBackground}
              className="px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
            >
              {t('common.default')}
            </button>
          </div>

          {background.type === 'local' && (
            <div className="text-[10px] text-white/50 truncate">{t('vibe.currentPrefix')}{background.value}</div>
          )}
        </div>

        {/* Divider */}
        <div className="h-px bg-white/15 my-4" />

        {/* Music section */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium text-white/80">
            <Music size={14} />
            <span>{t('vibe.music')}</span>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={musicUrl}
              onChange={(e) => setMusicUrl(e.target.value)}
              placeholder={t('vibe.musicUrlPlaceholder')}
              className="flex-1 px-3 py-1.5 text-xs bg-white/10 border border-white/20 rounded-lg placeholder-white/40 outline-none focus:border-white/40 transition-colors"
            />
            <button
              onClick={handleApplyMusicUrl}
              disabled={!musicUrl.trim()}
              className="px-3 py-1.5 text-xs rounded-lg bg-white/20 hover:bg-white/30 disabled:opacity-40 transition-colors"
            >
              {t('common.apply')}
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSelectLocalMusic}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
            >
              <File size={13} />
              {t('vibe.selectLocalAudio')}
            </button>
            <button
              onClick={handleResetMusic}
              className="px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
            >
              {t('common.default')}
            </button>
          </div>

          <div className="h-px bg-white/10" />

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-white/80">
              <FolderOpen size={14} />
              <span>{t('vibe.musicFolder')}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSelectMusicFolder}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
              >
                <FolderOpen size={13} />
                {t('vibe.selectFolder')}
              </button>
              {musicFolder && (
                <button
                  onClick={handleClearMusicFolder}
                  className="px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
                >
                  {t('vibe.clear')}
                </button>
              )}
            </div>
            {musicFolder && (
              <div className="text-[10px] text-white/50 truncate">{t('vibe.currentFolderPrefix')}{musicFolder}</div>
            )}
          </div>

          {music?.type === 'local' && !musicFolder && (
            <div className="text-[10px] text-white/50 truncate">{t('vibe.currentAudioPrefix')}{music.value}</div>
          )}
        </div>
      </div>
    </div>
  )
}
