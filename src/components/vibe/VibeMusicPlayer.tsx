import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2, Music, Pause, Play, RotateCcw, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore, type VibeMusic } from '../../stores/vibe-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import {
  AudioPlaybackIntent, AudioSourceError, audioTrackName, audioTracksFromFolder,
  clampAudioPosition, formatAudioTime, resolveAudioSource, type AudioFailure, type AudioTrack,
} from '../../lib/vibe-audio'
import type { SystemMediaState, VibeMediaCommand } from '../../types/ipc'

const controlClass = 'md-focus flex h-10 w-10 shrink-0 items-center justify-center rounded-md3-sm text-white/80 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30'
const rangeClass = 'md-focus h-9 min-w-0 w-full cursor-pointer accent-white disabled:cursor-not-allowed disabled:opacity-30'
const failureKeys: Record<AudioFailure, string> = {
  unavailable: 'vibe.audioUnavailable',
  'empty-folder': 'vibe.audioEmptyFolder',
  'web-local-unavailable': 'vibe.audioWebUILocalUnsupported',
  'too-large': 'vibe.audioFileTooLarge',
}

export default function VibeMusicPlayer() {
  const mode = useVibeStore((state) => state.audioMode)
  const music = useVibeStore((state) => state.music)
  const folder = useVibeStore((state) => state.musicFolder)
  if (mode === 'system') return <SystemMusicPlayer />
  // Source replacement starts paused; opening/closing the panel preserves this instance.
  return <LocalMusicPlayer key={JSON.stringify([music?.type, music?.value, folder])} music={music} folder={folder} />
}

function Recovery({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className="rounded-md3-sm border border-white/15 bg-black/20 p-3 text-ui-xs text-white/80">
      <p className="flex items-start gap-2 leading-relaxed"><AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden /><span className="min-w-0 break-words">{message}</span></p>
      <button type="button" onClick={onRetry} className="md-focus mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-md3-sm px-2 text-ui-xs text-white/90 hover:bg-white/10"><RotateCcw size={14} aria-hidden />{t('vibe.audioRetry')}</button>
    </div>
  )
}

function LocalMusicPlayer({ music, folder }: { music: VibeMusic | null; folder: string | null }) {
  const { t } = useTranslation()
  const volume = useVibeStore((state) => state.volume)
  const setVolume = useVibeStore((state) => state.setVolume)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const intent = useRef(new AudioPlaybackIntent())
  const hasPlayed = useRef(false)
  const [tracks, setTracks] = useState<AudioTrack[]>([])
  const [index, setIndex] = useState(0)
  const [resolved, setResolved] = useState<{ track: AudioTrack; src: string } | null>(null)
  const [reload, setReload] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'playing' | 'paused' | 'blocked' | 'error'>('loading')
  const [failure, setFailure] = useState<AudioFailure | null>(null)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [scrub, setScrub] = useState<number | null>(null)
  const scrubRef = useRef<number | null>(null)
  const track = tracks[index]
  const source = resolved?.track === track ? resolved?.src ?? '' : ''
  const off = !music && !folder

  useEffect(() => {
    let cancelled = false
    intent.current.resetSource()
    hasPlayed.current = false
    audioRef.current?.pause()
    setResolved(null)
    setFailure(null)
    setTracks([])
    setIndex(0)
    setStatus('loading')
    if (off) return
    void (async () => {
      try {
        let next: AudioTrack[]
        if (folder) {
          let entries
          try { entries = await ipc.listDir(folder) }
          catch { throw new AudioSourceError(isWebUIMode ? 'web-local-unavailable' : 'unavailable') }
          next = audioTracksFromFolder(folder, entries)
          if (!next.length) throw new AudioSourceError('empty-folder')
        } else {
          next = music ? [{ name: audioTrackName(music.value), value: music.value, local: music.type === 'local' }] : []
        }
        if (!cancelled) setTracks(next)
      } catch (error) {
        if (!cancelled) {
          setFailure(error instanceof AudioSourceError ? error.reason : 'unavailable')
          setStatus('error')
        }
      }
    })()
    return () => { cancelled = true; intent.current.resetSource() }
  }, [music, folder, off, reload])

  useEffect(() => {
    let cancelled = false
    intent.current.changeTrack()
    audioRef.current?.pause()
    setResolved(null)
    setPosition(0)
    setDuration(0)
    scrubRef.current = null
    setScrub(null)
    if (!track) return
    setFailure(null)
    setStatus('loading')
    void resolveAudioSource(track, {
      webUI: isWebUIMode,
      fileExists: (path) => ipc.fileExists(path),
      readFileBase64: (path) => ipc.readFileBase64(path),
    }).then((src) => {
      if (!cancelled) setResolved({ track, src })
    }).catch((error) => {
      if (!cancelled) {
        intent.current.pause()
        setFailure(error instanceof AudioSourceError ? error.reason : 'unavailable')
        setStatus('error')
      }
    })
    return () => { cancelled = true; intent.current.changeTrack() }
  }, [track])

  const attemptPlayback = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return
    const outcome = await intent.current.play(audio)
    if (outcome === 'stale' || outcome === 'idle') return
    setStatus(outcome)
    if (outcome === 'error') setFailure('unavailable')
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !source) return
    audio.volume = volume / 100
    if (intent.current.wantsPlayback) void attemptPlayback()
  }, [source, attemptPlayback])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume / 100
  }, [volume])

  const togglePlayback = () => {
    const audio = audioRef.current
    if (!audio || !source) return
    if (intent.current.wantsPlayback) {
      intent.current.pause()
      audio.pause()
      setStatus('paused')
    } else {
      hasPlayed.current = true
      intent.current.request()
      setFailure(null)
      setStatus('loading')
      void attemptPlayback()
    }
  }

  const changeTrack = (step: number) => {
    if (tracks.length < 2) return
    intent.current.changeTrack()
    audioRef.current?.pause()
    setIndex((current) => (current + step + tracks.length) % tracks.length)
  }

  const readPosition = () => {
    const audio = audioRef.current
    if (!audio) return
    const total = Number.isFinite(audio.duration) ? audio.duration : 0
    setDuration(total)
    if (scrubRef.current === null) setPosition(clampAudioPosition(audio.currentTime, total))
  }

  const commitSeek = () => {
    const value = scrubRef.current
    if (value === null) return
    scrubRef.current = null
    setScrub(null)
    const audio = audioRef.current
    if (!audio || duration <= 0) return
    try {
      audio.currentTime = clampAudioPosition(value, duration)
      setPosition(audio.currentTime)
    } catch { /* Metadata may have changed between a drag and its commit. */ }
  }

  const visibleStatus = off ? 'vibe.audioOff' : status === 'error' ? 'vibe.audioUnavailable'
    : status === 'blocked' ? 'vibe.audioInteractionRequired' : `vibe.audio${status[0].toUpperCase()}${status.slice(1)}`
  const displayPosition = clampAudioPosition(scrub ?? position, duration)
  const playingIntent = intent.current.wantsPlayback

  return (
    <section className="min-w-0 w-full max-w-full space-y-3 text-white/90" aria-label={t('vibe.tabAudio')}>
      <audio key={track?.value ?? 'off'} ref={audioRef} src={source || undefined} preload="metadata" loop={tracks.length === 1}
        onLoadedMetadata={() => { readPosition(); if (!intent.current.wantsPlayback) setStatus((current) => current === 'blocked' || current === 'error' ? current : hasPlayed.current ? 'paused' : 'ready') }}
        onCanPlay={() => { if (!intent.current.wantsPlayback) setStatus((current) => current === 'blocked' || current === 'error' ? current : hasPlayed.current ? 'paused' : 'ready') }}
        onTimeUpdate={readPosition}
        onPlay={() => { if (intent.current.wantsPlayback) setStatus('playing'); else audioRef.current?.pause() }}
        onPlaying={() => { if (intent.current.wantsPlayback) setStatus('playing') }}
        onPause={() => { if (!intent.current.wantsPlayback && hasPlayed.current) setStatus((current) => current === 'blocked' || current === 'error' ? current : 'paused') }}
        onWaiting={() => { if (intent.current.wantsPlayback) setStatus('loading') }}
        onEnded={() => { if (intent.current.wantsPlayback) changeTrack(1) }}
        onError={() => { if (source) { intent.current.pause(); setStatus('error'); setFailure('unavailable') } }} />
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md3-sm bg-white/10"><Music size={18} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-sm font-medium" title={off ? undefined : track?.name}>{off ? t('vibe.audioOff') : track?.name || t('vibe.unknownAudio')}</p>
          <p role="status" aria-live="polite" className="mt-0.5 text-ui-xs leading-relaxed text-white/60">{t(visibleStatus)}{tracks.length > 1 && <span className="ml-2 font-mono tabular-nums">{index + 1}/{tracks.length}</span>}</p>
        </div>
      </div>
      {off ? <p className="text-ui-xs leading-relaxed text-white/60">{t('vibe.audioOffHint')}</p> : <>
        <div className="flex items-center justify-center gap-2">
          <button type="button" onClick={() => changeTrack(-1)} disabled={tracks.length < 2} aria-label={t('vibe.previousTrack')} title={t('vibe.previousTrack')} className={controlClass}><SkipBack size={18} aria-hidden /></button>
          <button type="button" onClick={togglePlayback} disabled={!source || status === 'error'} aria-label={t(playingIntent ? 'vibe.pause' : 'vibe.play')} title={t(playingIntent ? 'vibe.pause' : 'vibe.play')} className={`${controlClass} bg-white/15 text-white hover:bg-white/25`}>
            {status === 'loading' && playingIntent ? <Loader2 size={19} className="animate-spin" aria-hidden /> : playingIntent ? <Pause size={19} aria-hidden /> : <Play size={19} aria-hidden />}
          </button>
          <button type="button" onClick={() => changeTrack(1)} disabled={tracks.length < 2} aria-label={t('vibe.nextTrack')} title={t('vibe.nextTrack')} className={controlClass}><SkipForward size={18} aria-hidden /></button>
        </div>
        <div className="min-w-0">
          <input type="range" min={0} max={duration || 1} step={0.1} value={displayPosition} disabled={!source || duration <= 0}
            onChange={(event) => { const value = Number(event.target.value); scrubRef.current = value; setScrub(value) }}
            onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} onPointerCancel={commitSeek}
            aria-label={t('vibe.seek')} aria-valuetext={`${formatAudioTime(displayPosition * 1000)} / ${formatAudioTime(duration * 1000)}`} className={rangeClass} />
          <div className="flex justify-between gap-2 font-mono text-ui-xs tabular-nums text-white/60"><span>{formatAudioTime(displayPosition * 1000)}</span><span>{formatAudioTime(duration * 1000)}</span></div>
        </div>
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-white/60">
          <Volume2 size={16} aria-hidden />
          <input type="range" min={0} max={100} value={volume} onChange={(event) => setVolume(Number(event.target.value))} aria-label={t('vibe.localVolume')} aria-valuetext={`${volume}%`} className={rangeClass} />
          <span className="w-10 text-right font-mono text-ui-xs tabular-nums">{volume}%</span>
        </div>
      </>}
      {failure && <Recovery message={t(failureKeys[failure])} onRetry={() => setReload((value) => value + 1)} />}
      {status === 'blocked' && <button type="button" onClick={togglePlayback} className="md-focus min-h-9 w-full rounded-md3-sm bg-white/10 px-3 text-ui-xs hover:bg-white/15">{t('vibe.clickToPlay')}</button>}
    </section>
  )
}

function SystemMusicPlayer() {
  const { t } = useTranslation()
  const [state, setState] = useState<SystemMediaState | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [position, setPosition] = useState(0)
  const [scrub, setScrub] = useState<number | null>(null)
  const [volume, setVolume] = useState<number | null>(null)
  const scrubRef = useRef<number | null>(null)
  const volumeDraft = useRef<number | null>(null)
  const mounted = useRef(true)

  const pull = useCallback(async () => {
    try {
      const snapshot = await ipc.vibeMediaGetState()
      if (mounted.current) { setState(snapshot); setFailed(!snapshot) }
    } catch { if (mounted.current) setFailed(true) }
    finally { if (mounted.current) setLoading(false) }
  }, [])

  useEffect(() => {
    mounted.current = true
    void pull()
    const off = ipc.onVibeMediaState((snapshot) => { if (mounted.current) { setState(snapshot); setLoading(false); setFailed(false) } })
    const poll = isWebUIMode ? window.setInterval(() => void pull(), 2000) : undefined
    return () => {
      mounted.current = false
      off()
      if (poll !== undefined) window.clearInterval(poll)
      // Stops observation, not playback in the user's external media application.
      void ipc.vibeMediaStop().catch(() => {})
    }
  }, [pull])

  useEffect(() => {
    if (!state) return
    if (scrubRef.current === null) setPosition(state.positionMs ?? 0)
    if (volumeDraft.current === null) setVolume(state.volume ?? null)
  }, [state])

  useEffect(() => {
    scrubRef.current = null
    setScrub(null)
    setPosition(state?.positionMs ?? 0)
  }, [state?.title, state?.artist, state?.durationMs])

  useEffect(() => {
    if (state?.status !== 'Playing') return
    const timer = window.setInterval(() => {
      if (scrubRef.current === null) setPosition((current) => clampAudioPosition(current + 500, state.durationMs ?? 0))
    }, 500)
    return () => window.clearInterval(timer)
  }, [state?.status, state?.durationMs])

  const send = async (command: VibeMediaCommand) => {
    setBusy(true)
    setFailed(false)
    try {
      if (!(await ipc.vibeMediaCommand(command))) throw new Error('media command unavailable')
      await pull()
    } catch { if (mounted.current) setFailed(true) }
    finally { if (mounted.current) setBusy(false) }
  }

  const duration = state?.durationMs ?? 0
  const displayPosition = clampAudioPosition(scrub ?? position, duration)
  const playing = state?.status === 'Playing'
  const available = !!state?.available
  const commitSeek = () => {
    const value = scrubRef.current
    if (value === null) return
    scrubRef.current = null
    setScrub(null)
    setPosition(clampAudioPosition(value, duration))
    void send({ type: 'seek', positionMs: clampAudioPosition(value, duration) })
  }
  const commitVolume = () => {
    const value = volumeDraft.current
    if (value === null) return
    volumeDraft.current = null
    void send({ type: 'volume', volume: value })
  }
  const retry = () => { setLoading(true); setFailed(false); void pull() }

  return (
    <section className="min-w-0 w-full max-w-full space-y-3 text-white/90" aria-label={t('vibe.audioModeSystem')}>
      <div className="flex min-w-0 items-center gap-3">
        {state?.cover ? <img src={state.cover} alt="" className="h-10 w-10 shrink-0 rounded-md3-sm object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md3-sm bg-white/10"><Music size={18} aria-hidden /></span>}
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-sm font-medium" title={state?.title}>{state?.title || t('vibe.audioModeSystem')}</p>
          <p role="status" aria-live="polite" className="mt-0.5 text-ui-xs leading-relaxed text-white/60">{loading ? t('vibe.audioLoading') : !available ? t('vibe.audioNoSystemSession') : t(playing ? 'vibe.audioPlaying' : 'vibe.audioPaused')}</p>
          {state?.artist && <p className="mt-0.5 truncate text-ui-xs text-white/60" title={state.artist}>{state.artist}</p>}
        </div>
      </div>
      <div className="flex items-center justify-center gap-2">
        <button type="button" onClick={() => void send({ type: 'prev' })} disabled={!available || busy} aria-label={t('vibe.previousTrack')} title={t('vibe.previousTrack')} className={controlClass}><SkipBack size={18} aria-hidden /></button>
        <button type="button" onClick={() => void send({ type: playing ? 'pause' : 'play' })} disabled={!available || busy} aria-label={t(playing ? 'vibe.pause' : 'vibe.play')} title={t(playing ? 'vibe.pause' : 'vibe.play')} className={`${controlClass} bg-white/15 text-white hover:bg-white/25`}>{busy || loading ? <Loader2 size={19} className="animate-spin" aria-hidden /> : playing ? <Pause size={19} aria-hidden /> : <Play size={19} aria-hidden />}</button>
        <button type="button" onClick={() => void send({ type: 'next' })} disabled={!available || busy} aria-label={t('vibe.nextTrack')} title={t('vibe.nextTrack')} className={controlClass}><SkipForward size={18} aria-hidden /></button>
      </div>
      <div className="min-w-0">
        <input type="range" min={0} max={duration || 1} step={1000} value={displayPosition} disabled={!available || duration <= 0 || busy}
          onChange={(event) => { const value = Number(event.target.value); scrubRef.current = value; setScrub(value) }}
          onPointerUp={commitSeek} onKeyUp={commitSeek} onBlur={commitSeek} onPointerCancel={commitSeek}
          aria-label={t('vibe.seek')} aria-valuetext={`${formatAudioTime(displayPosition)} / ${formatAudioTime(duration)}`} className={rangeClass} />
        <div className="flex justify-between gap-2 font-mono text-ui-xs tabular-nums text-white/60"><span>{formatAudioTime(displayPosition)}</span><span>{formatAudioTime(duration)}</span></div>
      </div>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-white/60">
        <Volume2 size={16} aria-hidden />
        <input type="range" min={0} max={100} value={volume ?? 0} disabled={volume === null || busy}
          onChange={(event) => { const value = Number(event.target.value); volumeDraft.current = value; setVolume(value) }}
          onPointerUp={commitVolume} onKeyUp={commitVolume} onBlur={commitVolume} onPointerCancel={commitVolume}
          aria-label={t('vibe.volume')} aria-valuetext={volume === null ? t('vibe.audioSystemUnavailable') : `${volume}%`} className={rangeClass} />
        <span className="w-10 text-right font-mono text-ui-xs tabular-nums">{volume === null ? '—' : `${volume}%`}</span>
      </div>
      {failed && <Recovery message={t('vibe.audioSystemUnavailable')} onRetry={retry} />}
      {!loading && !available && !failed && <button type="button" onClick={retry} className="md-focus min-h-9 w-full rounded-md3-sm bg-white/10 px-3 text-ui-xs hover:bg-white/15">{t('vibe.audioRetry')}</button>}
    </section>
  )
}
