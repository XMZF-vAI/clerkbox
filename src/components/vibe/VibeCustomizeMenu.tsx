import { useEffect, useRef, useState } from 'react'
import { X, Image, Music, FolderOpen, File } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  useVibeStore,
  DEFAULT_VIBE_BACKGROUND,
  DEFAULT_VIBE_MUSIC,
  VIBE_SLIDESHOW_MIN_INTERVAL_SEC,
  VIBE_SLIDESHOW_MAX_INTERVAL_SEC,
} from '../../stores/vibe-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import HostFolderPicker from '../ui/HostFolderPicker'

interface VibeCustomizeMenuProps {
  onClose: () => void
}

type MenuTab = 'background' | 'audio'

function formatInterval(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s === 0 ? `${m}min` : `${m}min${s}s`
}

export default function VibeCustomizeMenu({ onClose }: VibeCustomizeMenuProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<MenuTab>('background')

  const background = useVibeStore((s) => s.background)
  const music = useVibeStore((s) => s.music)
  const musicFolder = useVibeStore((s) => s.musicFolder)
  const backgroundMode = useVibeStore((s) => s.backgroundMode)
  const slideshowFolder = useVibeStore((s) => s.slideshowFolder)
  const slideshowIntervalSec = useVibeStore((s) => s.slideshowIntervalSec)
  const glassLevel = useVibeStore((s) => s.glassLevel)
  const audioMode = useVibeStore((s) => s.audioMode)
  const setBackground = useVibeStore((s) => s.setBackground)
  const setMusic = useVibeStore((s) => s.setMusic)
  const setMusicFolder = useVibeStore((s) => s.setMusicFolder)
  const setBackgroundMode = useVibeStore((s) => s.setBackgroundMode)
  const setSlideshowFolder = useVibeStore((s) => s.setSlideshowFolder)
  const setSlideshowIntervalSec = useVibeStore((s) => s.setSlideshowIntervalSec)
  const setGlassLevel = useVibeStore((s) => s.setGlassLevel)
  const setAudioMode = useVibeStore((s) => s.setAudioMode)

  const [bgUrl, setBgUrl] = useState(background.type === 'url' ? background.value : '')
  const [musicUrl, setMusicUrl] = useState(music?.type === 'url' ? music.value : '')
  const [hostFolderPickerOpen, setHostFolderPickerOpen] = useState(false)
  const [hostFolderPickerTarget, setHostFolderPickerTarget] = useState<'slideshow' | 'music'>('music')

  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  /** Trap modal focus while preserving the trigger for keyboard users. */
  useEffect(() => {
    const dialog = dialogRef.current
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
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
    return () => {
      document.removeEventListener('keydown', onKey)
      const previousFocus = previousFocusRef.current
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus()
    }
  }, [onClose])

  const handleSelectLocalBackground = async () => {
    const path = await ipc.selectImageFile()
    if (path) {
      setBackground({ type: isWebUIMode ? 'url' : 'local', value: path })
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

  const handleSelectSlideshowFolder = async () => {
    if (isWebUIMode) {
      setHostFolderPickerTarget('slideshow')
      setHostFolderPickerOpen(true)
      return
    }
    const folder = await ipc.selectFolder()
    if (folder) setSlideshowFolder(folder)
  }

  const handleClearSlideshowFolder = () => setSlideshowFolder(null)

  const handleSelectLocalMusic = async () => {
    const path = await ipc.selectAudioFile()
    if (path) {
      setMusic({ type: isWebUIMode ? 'url' : 'local', value: path })
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
    if (isWebUIMode) {
      setHostFolderPickerTarget('music')
      setHostFolderPickerOpen(true)
      return
    }
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

  const segButton = (active: boolean) =>
    `flex-1 px-3 py-1.5 text-xs rounded-lg transition-colors ${
      active ? 'bg-white/25 text-white font-medium' : 'text-white/70 hover:bg-white/10'
    }`

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
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/15 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 mb-4 rounded-xl bg-white/10" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'background'}
            onClick={() => setTab('background')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
              tab === 'background' ? 'bg-white/25 text-white font-medium' : 'text-white/70 hover:bg-white/10'
            }`}
          >
            <Image size={13} />
            {t('vibe.tabBackground')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'audio'}
            onClick={() => setTab('audio')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
              tab === 'audio' ? 'bg-white/25 text-white font-medium' : 'text-white/70 hover:bg-white/10'
            }`}
          >
            <Music size={13} />
            {t('vibe.tabAudio')}
          </button>
        </div>

        {tab === 'background' && (
          <div className="space-y-4">
            {/* 背景模式三选 */}
            <div className="flex gap-1 p-1 rounded-xl bg-white/10">
              <button type="button" onClick={() => setBackgroundMode('single')} className={segButton(backgroundMode === 'single')}>
                {t('vibe.bgModeSingle')}
              </button>
              <button type="button" onClick={() => setBackgroundMode('slideshow')} className={segButton(backgroundMode === 'slideshow')}>
                {t('vibe.bgModeSlideshow')}
              </button>
              <button type="button" onClick={() => setBackgroundMode('glass')} className={segButton(backgroundMode === 'glass')}>
                {t('vibe.bgModeGlass')}
              </button>
            </div>

            {/* ── 单图模式 ── */}
            {backgroundMode === 'single' && (
              <div className="space-y-3 animate-fade-up">
                <div className="flex gap-2">
                  <input
                    type="url"
                    aria-label={t('vibe.bgUrlPlaceholder')}
                    value={bgUrl}
                    onChange={(e) => setBgUrl(e.target.value)}
                    placeholder={t('vibe.bgUrlPlaceholder')}
                    className="flex-1 px-3 py-1.5 text-xs bg-white/10 border border-white/20 rounded-lg placeholder-white/40 outline-none focus:border-white/40 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={handleApplyBackgroundUrl}
                    disabled={!bgUrl.trim()}
                    className="px-3 py-1.5 text-xs rounded-lg bg-white/20 hover:bg-white/30 disabled:opacity-40 transition-colors"
                  >
                    {t('common.apply')}
                  </button>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSelectLocalBackground}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
                  >
                    <File size={13} />
                    {t('vibe.selectLocalImage')}
                  </button>
                  <button
                    type="button"
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
            )}

            {/* ── 轮播模式 ── */}
            {backgroundMode === 'slideshow' && (
              <div className="space-y-3 animate-fade-up">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSelectSlideshowFolder}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
                  >
                    <FolderOpen size={13} />
                    {t('vibe.selectFolder')}
                  </button>
                  {slideshowFolder && (
                    <button
                      type="button"
                      onClick={handleClearSlideshowFolder}
                      className="px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
                    >
                      {t('vibe.clear')}
                    </button>
                  )}
                </div>
                {slideshowFolder ? (
                  <div className="text-[10px] text-white/50 truncate">{t('vibe.currentFolderPrefix')}{slideshowFolder}</div>
                ) : (
                  <div className="text-[10px] text-white/50">{t('vibe.slideshowEmptyHint')}</div>
                )}

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-white/70">
                    <span>{t('vibe.slideshowInterval')}</span>
                    <span className="tabular-nums text-white/90">{formatInterval(slideshowIntervalSec)}</span>
                  </div>
                  <input
                    type="range"
                    min={VIBE_SLIDESHOW_MIN_INTERVAL_SEC}
                    max={VIBE_SLIDESHOW_MAX_INTERVAL_SEC}
                    step={5}
                    value={slideshowIntervalSec}
                    onChange={(e) => setSlideshowIntervalSec(Number(e.target.value))}
                    aria-label={t('vibe.slideshowInterval')}
                    className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
                  />
                </div>
              </div>
            )}

            {/* ── 玻璃模式 ── */}
            {backgroundMode === 'glass' && (
              <div className="space-y-3 animate-fade-up">
                <div className="text-[10px] text-white/60 leading-relaxed">{t('vibe.glassHint')}</div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-white/70">
                    <span>{t('vibe.glassLevel')}</span>
                    <span className="tabular-nums text-white/90">
                      {glassLevel === 0 ? t('vibe.glassTransparent') : `${glassLevel}%`}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={glassLevel}
                    onChange={(e) => setGlassLevel(Number(e.target.value))}
                    aria-label={t('vibe.glassLevel')}
                    className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'audio' && (
          <div className="space-y-4">
            {/* 音频模式二选 */}
            <div className="flex gap-1 p-1 rounded-xl bg-white/10">
              <button type="button" onClick={() => setAudioMode('local')} className={segButton(audioMode === 'local')}>
                {t('vibe.audioModeLocal')}
              </button>
              <button type="button" onClick={() => setAudioMode('system')} className={segButton(audioMode === 'system')}>
                {t('vibe.audioModeSystem')}
              </button>
            </div>

            {/* ── 本地音乐模式 ── */}
            {audioMode === 'local' && (
              <div className="space-y-3 animate-fade-up">
                <div className="flex gap-2">
                  <input
                    type="url"
                    aria-label={t('vibe.musicUrlPlaceholder')}
                    value={musicUrl}
                    onChange={(e) => setMusicUrl(e.target.value)}
                    placeholder={t('vibe.musicUrlPlaceholder')}
                    className="flex-1 px-3 py-1.5 text-xs bg-white/10 border border-white/20 rounded-lg placeholder-white/40 outline-none focus:border-white/40 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={handleApplyMusicUrl}
                    disabled={!musicUrl.trim()}
                    className="px-3 py-1.5 text-xs rounded-lg bg-white/20 hover:bg-white/30 disabled:opacity-40 transition-colors"
                  >
                    {t('common.apply')}
                  </button>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSelectLocalMusic}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
                  >
                    <File size={13} />
                    {t('vibe.selectLocalAudio')}
                  </button>
                  <button
                    type="button"
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
                      type="button"
                      onClick={handleSelectMusicFolder}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 transition-colors"
                    >
                      <FolderOpen size={13} />
                      {t('vibe.selectFolder')}
                    </button>
                    {musicFolder && (
                      <button
                        type="button"
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
            )}

            {/* ── 系统音频模式 ── */}
            {audioMode === 'system' && (
              <div className="space-y-2 animate-fade-up">
                <div className="text-[11px] text-white/70 leading-relaxed">{t('vibe.systemAudioHint')}</div>
                <div className="text-[10px] text-white/45 leading-relaxed">{t('vibe.systemAudioControlHint')}</div>
              </div>
            )}
          </div>
        )}
      </div>
      <HostFolderPicker
        open={hostFolderPickerOpen}
        onClose={() => setHostFolderPickerOpen(false)}
        onSelect={(folder) => {
          if (hostFolderPickerTarget === 'slideshow') {
            setSlideshowFolder(folder)
          } else {
            setMusicFolder(folder)
            setMusicUrl('')
          }
        }}
        initialPath={hostFolderPickerTarget === 'slideshow' ? slideshowFolder || ipc.homeDir() : musicFolder || ipc.homeDir()}
        variant="vibe"
      />
    </div>
  )
}
