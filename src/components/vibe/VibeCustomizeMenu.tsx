import { useId, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { X, Image, Music, FolderOpen, File, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore, DEFAULT_VIBE_BACKGROUND, DEFAULT_VIBE_MUSIC, VIBE_SLIDESHOW_MIN_INTERVAL_SEC, VIBE_SLIDESHOW_MAX_INTERVAL_SEC } from '../../stores/vibe-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import { useModalAccessibility } from '../../hooks/use-modal-accessibility'
import HostFolderPicker from '../ui/HostFolderPicker'

type MenuTab = 'background' | 'audio'
type AudioSource = 'off' | 'url' | 'file' | 'folder' | 'system'
const control = 'md-focus min-h-10 max-md:min-h-11 rounded-md3-sm border border-white/15 bg-white/5 px-3 py-2 text-ui-xs text-white/90 transition-colors hover:bg-white/10 disabled:opacity-40'
const input = 'md-focus min-h-10 max-md:min-h-11 min-w-0 w-full rounded-md3-sm border border-white/20 bg-black/20 px-3 py-2 text-ui-sm text-white placeholder:text-white/40 outline-none'
const GLASS_COPY: Record<string, string> = { pending: 'vibe.glassTrackPending', acrylic: 'vibe.glassTrackAcrylic', transparent: 'vibe.glassTrackTransparent', fallback: 'vibe.glassTrackFallback' }

export function isVibeMediaUrl(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value.trim()).protocol) } catch { return false }
}

// The host picker joins the same keyboard stack as its enclosing settings dialog.
function VibeHostFolderPicker(props: { onClose: () => void; onSelect: (path: string) => void; initialPath: string }) {
  const ref = useModalAccessibility(props.onClose)
  return <div ref={ref} tabIndex={-1}><HostFolderPicker open {...props} variant="vibe" /></div>
}

export default function VibeCustomizeMenu({ onClose, initialTab = 'background' }: { onClose: () => void; initialTab?: MenuTab }) {
  const { t } = useTranslation()
  const id = useId()
  const background = useVibeStore((s) => s.background)
  const backgroundMode = useVibeStore((s) => s.backgroundMode)
  const slideshowFolder = useVibeStore((s) => s.slideshowFolder)
  const slideshowIntervalSec = useVibeStore((s) => s.slideshowIntervalSec)
  const glassLevel = useVibeStore((s) => s.glassLevel)
  const glassTrack = useVibeStore((s) => s.glassTrack)
  const readingOpacity = useVibeStore((s) => s.readingOpacity)
  const volume = useVibeStore((s) => s.volume)
  const music = useVibeStore((s) => s.music)
  const musicFolder = useVibeStore((s) => s.musicFolder)
  const audioMode = useVibeStore((s) => s.audioMode)
  const backgroundStatus = useVibeStore((s) => s.backgroundStatus)
  const backgroundIssue = useVibeStore((s) => s.backgroundIssue)
  const [tab, setTab] = useState<MenuTab>(initialTab)
  const [bgSource, setBgSource] = useState(background.type === 'local' || background.value.startsWith('data:') ? 'file' : 'url')
  const [audioSource, setAudioSource] = useState<AudioSource>(audioMode === 'system' ? 'system' : musicFolder ? 'folder' : !music ? 'off' : music.type === 'local' || music.value.startsWith('data:') ? 'file' : 'url')
  const [bgUrl, setBgUrl] = useState(background.type === 'url' && !background.value.startsWith('data:') ? background.value : '')
  const [musicUrl, setMusicUrl] = useState(music?.type === 'url' && !music.value.startsWith('data:') ? music.value : '')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState<'slideshow' | 'music' | null>(null)
  const panelRef = useModalAccessibility(onClose)
  const settings = () => useVibeStore.getState()

  const selectFile = async (target: 'background' | 'music') => {
    setBusy(true)
    setNotice(null)
    try {
      const path = await (target === 'background' ? ipc.selectImageFile() : ipc.selectAudioFile())
      if (!path) return
      const source = { type: isWebUIMode ? 'url' as const : 'local' as const, value: path }
      if (target === 'background') settings().setBackground(source)
      else { settings().setAudioMode('local'); settings().setMusic(source) }
    } catch { setNotice('vibe.sourceSelectionFailed') } finally { setBusy(false) }
  }
  const selectFolder = async (target: 'slideshow' | 'music') => {
    setNotice(null)
    if (isWebUIMode) { setPicker(target); return }
    setBusy(true)
    try {
      const path = await (target === 'slideshow' ? ipc.selectFolder() : ipc.selectMusicFolder())
      if (path) target === 'slideshow' ? settings().setSlideshowFolder(path) : settings().setMusicFolder(path)
    } catch { setNotice('vibe.sourceSelectionFailed') } finally { setBusy(false) }
  }
  const applyUrl = (target: 'background' | 'music') => {
    const value = (target === 'background' ? bgUrl : musicUrl).trim()
    if (!isVibeMediaUrl(value)) { setUrlError(target === 'background' ? 'vibe.invalidImageUrl' : 'vibe.invalidAudioUrl'); return }
    setUrlError(null)
    if (target === 'background') settings().setBackground({ type: 'url', value })
    else { settings().setAudioMode('local'); settings().setMusic({ type: 'url', value }) }
  }
  const changeAudioSource = (source: AudioSource) => {
    setAudioSource(source)
    setNotice(null)
    setUrlError(null)
    settings().setAudioMode(source === 'system' ? 'system' : 'local')
    if (source !== 'system') settings().setMusic(null)
  }
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next: MenuTab = event.key === 'Home' ? 'background' : event.key === 'End' ? 'audio' : tab === 'background' ? 'audio' : 'background'
    setTab(next)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-vibe-tab="${next}"]`)?.focus()
  }
  const pathLabel = (value: string) => value.startsWith('data:') ? t('vibe.sourceFile') : value || t('vibe.sourceNone')
  const statusKey = backgroundStatus === 'loading' ? 'vibe.backgroundLoading' : backgroundStatus === 'ready' ? 'vibe.backgroundReady'
    : backgroundStatus === 'empty' ? 'vibe.slideshowEmpty' : backgroundIssue === 'slideshow' ? 'vibe.slideshowLoadFailed' : backgroundIssue === 'glass' ? 'vibe.glassUnavailable' : 'vibe.backgroundLoadFailed'
  const range = (label: string, value: number, change: (value: number) => void, min = 0, max = 100, step = 1, suffix = '%') => (
    <label className="block space-y-2 text-ui-xs text-white/80">
      <span className="flex justify-between gap-3"><span>{t(label)}</span><output className="tabular-nums">{value}{suffix}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={t(label)} aria-valuetext={`${value}${suffix}`} onChange={(event) => change(Number(event.target.value))} className="h-8 w-full cursor-pointer accent-white" />
    </label>
  )
  const urlForm = (target: 'background' | 'music') => (
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); applyUrl(target) }}>
      <label htmlFor={`${id}-${target}-url`} className="block text-ui-xs font-medium text-white/80">{t(target === 'background' ? 'vibe.bgUrlPlaceholder' : 'vibe.musicUrlPlaceholder')}</label>
      <div className="flex gap-2">
        <input id={`${id}-${target}-url`} type="url" value={target === 'background' ? bgUrl : musicUrl} onChange={(event) => { target === 'background' ? setBgUrl(event.target.value) : setMusicUrl(event.target.value); setUrlError(null) }} placeholder="https://" className={input} aria-invalid={!!urlError} aria-describedby={urlError ? `${id}-url-error` : undefined} />
        <button type="submit" className={`${control} shrink-0`} disabled={!(target === 'background' ? bgUrl : musicUrl).trim()}>{t('common.apply')}</button>
      </div>
      {urlError && <p id={`${id}-url-error`} role="alert" className="text-ui-xs text-white/80">{t(urlError)}</p>}
    </form>
  )

  const panel = (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm max-sm:p-2" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1} className="liquid-glass-strong relative flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-md3-xl text-white outline-none shadow-elevation-3 max-sm:max-h-[calc(100dvh-1rem)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 p-5 max-sm:p-4">
          <div className="min-w-0"><h2 id={`${id}-title`} className="text-ui-lg font-semibold">{t('vibe.customizeTitle')}</h2><p id={`${id}-description`} className="mt-1 text-ui-xs leading-relaxed text-white/60">{t('vibe.settingsDescription')}</p></div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="md-focus flex h-10 w-10 shrink-0 items-center justify-center rounded-md3-sm text-white/70 transition-colors hover:bg-white/10 max-md:h-11 max-md:w-11"><X size={18} aria-hidden /></button>
        </header>
        <div role="tablist" aria-label={t('vibe.customizeTitle')} className="mx-5 mt-4 flex shrink-0 gap-1 rounded-md3-md bg-black/20 p-1 max-sm:mx-4">
          {(['background', 'audio'] as MenuTab[]).map((item) => <button key={item} type="button" id={`${id}-${item}-tab`} data-vibe-tab={item} role="tab" aria-selected={tab === item} aria-controls={`${id}-${item}-panel`} tabIndex={tab === item ? 0 : -1} onKeyDown={tabKey} onClick={() => { setTab(item); setUrlError(null); setNotice(null) }} className={`md-focus flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md3-sm px-3 py-2 text-ui-xs transition-colors max-md:min-h-11 ${tab === item ? 'bg-white/10 font-medium text-white' : 'text-white/60 hover:bg-white/5'}`}>
            {item === 'background' ? <Image size={15} aria-hidden /> : <Music size={15} aria-hidden />}{t(item === 'background' ? 'vibe.tabBackground' : 'vibe.tabAudio')}
          </button>)}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 max-sm:p-4">
          {notice && <p role="alert" className="mb-4 rounded-md3-sm border border-white/15 bg-white/5 p-3 text-ui-xs text-white/80">{t(notice)}</p>}
          {tab === 'background' ? <section role="tabpanel" id={`${id}-background-panel`} aria-labelledby={`${id}-background-tab`} className="space-y-5">
            <fieldset className="space-y-2"><legend className="mb-2 text-ui-xs font-medium text-white/80">{t('vibe.backgroundSource')}</legend>
              <div className="grid grid-cols-3 gap-2">{(['single', 'slideshow', 'glass'] as const).map((mode) => <label key={mode} className={`${control} flex cursor-pointer items-center justify-center gap-2 ${backgroundMode === mode ? 'border-white/40 bg-white/10' : ''}`}>
                <input type="radio" name={`${id}-background-mode`} value={mode} checked={backgroundMode === mode} onChange={() => settings().setBackgroundMode(mode)} className="accent-white" />{t(mode === 'single' ? 'vibe.bgModeSingle' : mode === 'slideshow' ? 'vibe.bgModeSlideshow' : 'vibe.bgModeGlass')}
              </label>)}</div>
            </fieldset>
            {backgroundMode === 'single' && <div className="space-y-3">
              <label className="block space-y-2 text-ui-xs font-medium text-white/80"><span>{t('vibe.sourceCurrent')}</span><select value={bgSource} onChange={(event) => { setBgSource(event.target.value); setUrlError(null) }} className={input}><option value="url">{t('vibe.sourceUrl')}</option><option value="file">{t('vibe.sourceFile')}</option></select></label>
              {bgSource === 'url' ? urlForm('background') : <button type="button" onClick={() => void selectFile('background')} disabled={busy} className={`${control} flex w-full items-center justify-center gap-2`}><File size={15} aria-hidden />{t('vibe.selectLocalImage')}</button>}
              <p className="truncate text-ui-xs text-white/60" title={background.value.startsWith('data:') ? undefined : background.value}>{pathLabel(background.value)}</p>
              <button type="button" className={control} onClick={() => { settings().setBackground(DEFAULT_VIBE_BACKGROUND); setBgUrl(DEFAULT_VIBE_BACKGROUND.value); setBgSource('url'); setUrlError(null) }}>{t('vibe.resetBackground')}</button>
            </div>}
            {backgroundMode === 'slideshow' && <div className="space-y-3">
              <div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void selectFolder('slideshow')} className={`${control} flex flex-1 items-center justify-center gap-2`}><FolderOpen size={15} aria-hidden />{t(isWebUIMode ? 'vibe.sourceHostFolder' : 'vibe.selectFolder')}</button>{slideshowFolder && <button type="button" onClick={() => settings().setSlideshowFolder(null)} className={control}>{t('vibe.clear')}</button>}</div>
              <p className="truncate text-ui-xs text-white/60" title={slideshowFolder || undefined}>{pathLabel(slideshowFolder || '')}</p>
              {range('vibe.slideshowInterval', slideshowIntervalSec, settings().setSlideshowIntervalSec, VIBE_SLIDESHOW_MIN_INTERVAL_SEC, VIBE_SLIDESHOW_MAX_INTERVAL_SEC, 5, 's')}
            </div>}
            {backgroundMode === 'glass' && <div className="space-y-3"><p className="text-ui-xs leading-relaxed text-white/60">{t('vibe.glassHint')}</p>{range('vibe.glassLevel', glassLevel, settings().setGlassLevel, 0, 100, 5)}<p className="text-ui-xs leading-relaxed text-white/50">{t(GLASS_COPY[glassTrack])}</p></div>}
            <div role={backgroundStatus === 'error' ? 'alert' : 'status'} className="flex flex-wrap items-center justify-between gap-3 rounded-md3-md border border-white/10 bg-black/10 p-3"><p className="min-w-0 flex-1 text-ui-xs leading-relaxed text-white/60">{t(statusKey)}</p>{(backgroundStatus === 'error' || backgroundStatus === 'empty') && <button type="button" onClick={() => settings().retryBackground()} className={`${control} flex items-center gap-2`}><RefreshCw size={14} aria-hidden />{t('vibe.backgroundRetry')}</button>}</div>
            <div className="space-y-2 border-t border-white/10 pt-4">{range('vibe.readingOpacity', readingOpacity, settings().setReadingOpacity)}<p className="text-ui-xs leading-relaxed text-white/50">{t('vibe.readingOpacityHint')}</p></div>
          </section> : <section role="tabpanel" id={`${id}-audio-panel`} aria-labelledby={`${id}-audio-tab`} className="space-y-4">
            <label className="block space-y-2 text-ui-xs font-medium text-white/80"><span>{t('vibe.audioSource')}</span><select value={audioSource} onChange={(event) => changeAudioSource(event.target.value as AudioSource)} className={input}>{(['off', 'url', 'file', 'folder', 'system'] as AudioSource[]).map((source) => <option key={source} value={source}>{t(source === 'system' ? 'vibe.audioModeSystem' : source === 'off' ? 'vibe.sourceOff' : source === 'url' ? 'vibe.sourceUrl' : source === 'file' ? 'vibe.sourceFile' : 'vibe.sourceFolder')}</option>)}</select></label>
            {audioSource === 'url' && urlForm('music')}
            {audioSource === 'file' && <button type="button" disabled={busy} onClick={() => void selectFile('music')} className={`${control} flex w-full items-center justify-center gap-2`}><File size={15} aria-hidden />{t('vibe.selectLocalAudio')}</button>}
            {audioSource === 'folder' && <button type="button" disabled={busy} onClick={() => void selectFolder('music')} className={`${control} flex w-full items-center justify-center gap-2`}><FolderOpen size={15} aria-hidden />{t(isWebUIMode ? 'vibe.sourceHostFolder' : 'vibe.selectFolder')}</button>}
            {audioSource === 'system' ? <p className="text-ui-xs leading-relaxed text-white/60">{t('vibe.systemAudioHint')}</p> : audioSource === 'off' ? <p className="text-ui-xs text-white/60">{t('vibe.audioOff')}</p> : <p className="truncate text-ui-xs text-white/60" title={(musicFolder || music?.value)?.startsWith('data:') ? undefined : musicFolder || music?.value}>{pathLabel(musicFolder || music?.value || '')}</p>}
            {isWebUIMode && (audioSource === 'folder' || audioSource === 'file') && <p className="text-ui-xs leading-relaxed text-white/50">{t('vibe.audioWebUILocalHint')}</p>}
            {audioSource !== 'system' && <div className="space-y-2 border-t border-white/10 pt-4">{range('vibe.localVolume', volume, settings().setVolume)}<p className="text-ui-xs leading-relaxed text-white/50">{t('vibe.musicVolumeHint')}</p></div>}
            <button type="button" className={control} onClick={() => { settings().setAudioMode('local'); settings().setMusic(DEFAULT_VIBE_MUSIC); setAudioSource('url'); setMusicUrl(DEFAULT_VIBE_MUSIC.value); setUrlError(null) }}>{t('vibe.resetMusic')}</button>
          </section>}
        </div>
      </div>
      {picker && <VibeHostFolderPicker onClose={() => setPicker(null)} onSelect={(path) => { picker === 'slideshow' ? settings().setSlideshowFolder(path) : settings().setMusicFolder(path); setPicker(null) }} initialPath={(picker === 'slideshow' ? slideshowFolder : musicFolder) || ipc.homeDir()} />}
    </div>
  )
  return typeof document === 'undefined' ? panel : createPortal(panel, document.body)
}
