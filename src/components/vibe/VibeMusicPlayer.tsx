import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, SkipBack, SkipForward, Music, Volume2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore, DEFAULT_VIBE_MUSIC } from '../../stores/vibe-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import { toFileUrl } from '../../lib/file-url'
import type { SystemMediaState } from '../../types/ipc'

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']

interface Track {
  name: string
  src: string
}

function fileNameFromPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || ''
}

function ext(path: string): string {
  return path.split('.').pop()?.toLowerCase() || ''
}

function formatTime(ms: number): string {
  if (!isFinite(ms) || isNaN(ms) || ms < 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VibeMusicPlayer() {
  const audioMode = useVibeStore((s) => s.audioMode)
  if (audioMode === 'system') return <SystemMusicPlayer />
  return <LocalMusicPlayer />
}

/** 模式一：本地音频（原有逻辑） */
function LocalMusicPlayer() {
  const { t } = useTranslation()
  const music = useVibeStore((s) => s.music)
  const musicFolder = useVibeStore((s) => s.musicFolder)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [trackIndex, setTrackIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [needsUserInteraction, setNeedsUserInteraction] = useState(false)
  const [trackError, setTrackError] = useState(false)
  const [volume, setVolume] = useState(100)
  // 拖动进度时本地暂存，松手才提交 seek（对齐系统播放器手感，避免逐帧 seek 卡顿）
  const [scrub, setScrub] = useState<number | null>(null)
  const scrubRef = useRef<number | null>(null)
  const currentTrack = tracks[trackIndex] || tracks[0]

  // Build track list
  useEffect(() => {
    let cancelled = false
    const loadTracks = async () => {
      if (musicFolder) {
        try {
          const entries = await ipc.listDir(musicFolder)
          const files = entries
            .filter((e) => e.isFile && AUDIO_EXTENSIONS.includes(ext(e.name)))
            .map((e) => e.name)
            .sort()
          if (files.length > 0) {
            if (cancelled) return
            setTracks(files.map((name) => ({ name, src: toFileUrl(`${musicFolder}/${name}`) })))
            setTrackIndex(0)
            return
          }
        } catch (e) {
          console.error('Failed to load music folder:', e)
        }
      }
      if (cancelled) return

      if (music) {
        if (music.type === 'local') {
          const exists = await ipc.fileExists(music.value)
          if (cancelled) return
          if (!exists) {
            setTracks([{ name: fileNameFromPath(DEFAULT_VIBE_MUSIC.value), src: DEFAULT_VIBE_MUSIC.value }])
          } else {
            setTracks([{ name: fileNameFromPath(music.value), src: toFileUrl(music.value) }])
          }
        } else {
          setTracks([{ name: fileNameFromPath(music.value), src: music.value }])
        }
        setTrackIndex(0)
        return
      }

      setTracks([{ name: fileNameFromPath(DEFAULT_VIBE_MUSIC.value), src: DEFAULT_VIBE_MUSIC.value }])
      setTrackIndex(0)
    }

    void loadTracks()
    return () => {
      cancelled = true
    }
  }, [music, musicFolder])

  useEffect(() => {
    setProgress(0)
    setDuration(0)
    setTrackError(false)
  }, [currentTrack?.src])

  // 音量滑块 → audio 元素（换轨后 src 重建同样生效）
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume / 100
  }, [volume, currentTrack?.src])

  // Auto-play when track changes
  const tryPlay = useCallback(async () => {
    if (!audioRef.current || !currentTrack) return
    try {
      setNeedsUserInteraction(false)
      await audioRef.current.play()
      setIsPlaying(true)
    } catch {
      setNeedsUserInteraction(true)
      setIsPlaying(false)
    }
  }, [currentTrack])

  useEffect(() => {
    if (currentTrack) {
      tryPlay()
    }
  }, [currentTrack, tryPlay])

  const handlePlayPause = async () => {
    if (!audioRef.current) return
    if (isPlaying) {
      audioRef.current.pause()
      setIsPlaying(false)
    } else {
      try {
        await audioRef.current.play()
        setIsPlaying(true)
        setNeedsUserInteraction(false)
      } catch {
        setNeedsUserInteraction(true)
      }
    }
  }

  const handlePrev = () => {
    if (tracks.length <= 1) return
    setTrackIndex((i) => (i - 1 + tracks.length) % tracks.length)
  }

  const handleNext = () => {
    if (tracks.length <= 1) return
    setTrackIndex((i) => (i + 1) % tracks.length)
  }

  const handleTimeUpdate = () => {
    const audio = audioRef.current
    if (!audio) return
    // 拖动中不回写进度，保持用户手感
    if (scrubRef.current === null) setProgress(audio.currentTime)
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
  }

  const beginScrub = (value: number) => {
    scrubRef.current = value
    setScrub(value)
  }

  const commitScrub = () => {
    const value = scrubRef.current
    if (value === null) return
    scrubRef.current = null
    setScrub(null)
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = value
    setProgress(value)
  }

  if (!currentTrack) return null

  // 根元素不再自带定位：由 VibeControls 的顶部右侧统一槽位容器负责摆放
  return (
    <div className="flex items-center gap-3 px-4 py-2 liquid-glass rounded-full text-white/90 max-w-[min(92vw,560px)]">
      <audio
        ref={audioRef}
        src={currentTrack.src}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleTimeUpdate}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={handleNext}
        onError={() => setTrackError(true)}
        loop={tracks.length === 1}
      />

      <Music size={16} className="text-white/70" />

      <div className="flex flex-col min-w-[140px]">
        <span className="text-xs font-medium truncate max-w-[160px]">{currentTrack.name || t('vibe.unknownAudio')}</span>
        <div className="flex items-center gap-2 mt-1">
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={scrub ?? progress}
            onChange={(e) => beginScrub(Number(e.target.value))}
            onPointerUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={commitScrub}
            aria-label={t('vibe.seek')}
            className="flex-1 h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
          />
          <span className="text-[10px] text-white/60 tabular-nums">
            {formatTime((scrub ?? progress) * 1000)}/{formatTime(duration * 1000)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handlePrev}
          disabled={tracks.length <= 1}
          aria-label={t('vibe.previousTrack')}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/15 disabled:opacity-30 transition-colors"
        >
          <SkipBack size={14} />
        </button>
        <button
          type="button"
          onClick={handlePlayPause}
          aria-label={isPlaying ? t('vibe.pause') : t('vibe.play')}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors"
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={tracks.length <= 1}
          aria-label={t('vibe.nextTrack')}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/15 disabled:opacity-30 transition-colors"
        >
          <SkipForward size={14} />
        </button>
      </div>

      {/* 本地音量（与系统播放器对称；窄屏隐藏防溢出） */}
      <div className="flex items-center gap-1.5 shrink-0 max-md:hidden">
        <Volume2 size={13} className="text-white/60" />
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label={t('vibe.localVolume')}
          className="w-16 h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
        />
      </div>

      {/* 曲目加载失败（外链过期/文件被删）：轻量提示，不再静默无声 */}
      {trackError && (
        <span className="ml-1 text-[10px] px-2 py-0.5 rounded-full bg-white/15 text-white/80 shrink-0">
          {t('vibe.audioLoadFailed')}
        </span>
      )}

      {needsUserInteraction && (
        <button
          type="button"
          onClick={handlePlayPause}
          className="ml-1 text-[10px] px-2 py-0.5 rounded-full bg-white/20 hover:bg-white/30 transition-colors shrink-0"
        >
          {t('vibe.clickToPlay')}
        </button>
      )}
    </div>
  )
}

/** 模式二：系统正在播放 —— SMTC 会话卡片（封面/进度/控制/音量） */
function SystemMusicPlayer() {
  const { t } = useTranslation()
  const [state, setState] = useState<SystemMediaState | null>(null)
  const [positionMs, setPositionMs] = useState(0)
  const [scrubMs, setScrubMs] = useState<number | null>(null)
  const [volume, setVolume] = useState<number | null>(null)
  const scrubRef = useRef<number | null>(null)
  const volumeTimerRef = useRef<number | null>(null)

  // 拉起主进程轮询助手 + 订阅状态推送（WebUI 无推送通道，走 2s 轮询）
  useEffect(() => {
    let cancelled = false

    const pull = async () => {
      try {
        const s = await ipc.vibeMediaGetState()
        if (!cancelled && s) setState(s)
      } catch { /* 主进程暂时不可用：等待下一轮 */ }
    }
    void pull()

    const off = ipc.onVibeMediaState((s) => setState(s))

    let pollId: number | null = null
    if (isWebUIMode) {
      pollId = window.setInterval(() => void pull(), 2000)
    }

    return () => {
      cancelled = true
      off()
      if (pollId !== null) window.clearInterval(pollId)
      void ipc.vibeMediaStop()
    }
  }, [])

  // 状态到达：同步进度与音量（拖动中的滑块不覆盖用户手感；scrub 走 ref 避免提交瞬间被旧状态回写）
  useEffect(() => {
    if (!state) return
    const pos = state.positionMs
    if (typeof pos === 'number' && scrubRef.current === null) {
      setPositionMs(pos)
    }
    if (typeof state.volume === 'number' && volumeTimerRef.current === null) {
      setVolume(state.volume)
    }
  }, [state])

  // 播放中本地插值进度，进度条每 500ms 平滑走一格
  useEffect(() => {
    if (state?.status !== 'Playing') return
    const id = window.setInterval(() => {
      setPositionMs((p) => (scrubRef.current !== null ? p : p + 500))
    }, 500)
    return () => window.clearInterval(id)
  }, [state?.status])

  const sendCommand = useCallback((cmd: Parameters<typeof ipc.vibeMediaCommand>[0]) => {
    void ipc.vibeMediaCommand(cmd)
  }, [])

  const beginScrub = (value: number) => {
    scrubRef.current = value
    setScrubMs(value)
  }

  const commitScrub = () => {
    const value = scrubRef.current
    if (value === null) return
    scrubRef.current = null
    setScrubMs(null)
    sendCommand({ type: 'seek', positionMs: value })
    setPositionMs(value)
  }

  const handleVolume = (value: number) => {
    setVolume(value)
    if (volumeTimerRef.current !== null) window.clearTimeout(volumeTimerRef.current)
    volumeTimerRef.current = window.setTimeout(() => {
      volumeTimerRef.current = null
      sendCommand({ type: 'volume', volume: value })
    }, 180)
  }

  useEffect(() => {
    return () => {
      if (volumeTimerRef.current !== null) window.clearTimeout(volumeTimerRef.current)
    }
  }, [])

  const durationMs = state?.durationMs ?? 0
  const isPlaying = state?.status === 'Playing'
  const displayMs = scrubMs ?? positionMs

  // 无活跃会话：不渲染任何占位胶囊（无音频时保持右上角干净，布局由统一槽位容器负责）
  if (!state || !state.available) return null

  return (
    <div className="flex items-center gap-3 px-4 py-2 liquid-glass rounded-full text-white/90 max-w-[min(92vw,520px)]">
      {/* 封面 */}
      {state.cover ? (
        <img
          src={state.cover}
          alt=""
          className="w-10 h-10 rounded-full object-cover border border-white/20 shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded-full bg-white/10 border border-white/20 flex items-center justify-center shrink-0">
          <Music size={16} className="text-white/70" />
        </div>
      )}

      {/* 曲目信息 + 进度 */}
      <div className="flex flex-col min-w-[140px] flex-1">
        <span className="text-xs font-medium truncate max-w-[180px]">
          {state.title || t('vibe.unknownAudio')}
        </span>
        <span className="text-[10px] text-white/60 truncate max-w-[180px]">
          {state.artist || t('vibe.unknownArtist')}
        </span>
        <div className="flex items-center gap-2 mt-1">
          <input
            type="range"
            min={0}
            max={durationMs || 1}
            step={1000}
            value={displayMs}
            onChange={(e) => beginScrub(Number(e.target.value))}
            onPointerUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={commitScrub}
            aria-label={t('vibe.seek')}
            className="flex-1 h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
          />
          <span className="text-[10px] text-white/60 tabular-nums whitespace-nowrap">
            {formatTime(displayMs)}/{formatTime(durationMs)}
          </span>
        </div>
      </div>

      {/* 播放控制 */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => sendCommand({ type: 'prev' })}
          aria-label={t('vibe.previousTrack')}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/15 transition-colors"
        >
          <SkipBack size={14} />
        </button>
        <button
          type="button"
          onClick={() => sendCommand(isPlaying ? { type: 'pause' } : { type: 'play' })}
          aria-label={isPlaying ? t('vibe.pause') : t('vibe.play')}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white/20 hover:bg-white/30 transition-colors"
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
        </button>
        <button
          type="button"
          onClick={() => sendCommand({ type: 'next' })}
          aria-label={t('vibe.nextTrack')}
          className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/15 transition-colors"
        >
          <SkipForward size={14} />
        </button>
      </div>

      {/* 系统音量 */}
      <div className="flex items-center gap-1.5 shrink-0 max-md:hidden">
        <Volume2 size={13} className="text-white/60" />
        <input
          type="range"
          min={0}
          max={100}
          value={volume ?? state.volume ?? 100}
          onChange={(e) => handleVolume(Number(e.target.value))}
          aria-label={t('vibe.volume')}
          className="w-16 h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
        />
      </div>
    </div>
  )
}
