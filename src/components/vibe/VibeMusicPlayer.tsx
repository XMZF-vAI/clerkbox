import { useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause, SkipBack, SkipForward, Music } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useVibeStore, DEFAULT_VIBE_MUSIC } from '../../stores/vibe-store'
import { ipc } from '../../lib/ipc-client'
import { toFileUrl } from '../../lib/file-url'

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

export default function VibeMusicPlayer() {
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
  }, [currentTrack?.src])

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
    setProgress(audio.currentTime)
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Number(e.target.value)
    setProgress(audio.currentTime)
  }

  const formatTime = (t: number) => {
    if (!isFinite(t) || isNaN(t)) return '0:00'
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  if (!currentTrack) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-2 liquid-glass rounded-full text-white/90">
      <audio
        ref={audioRef}
        src={currentTrack.src}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleTimeUpdate}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={handleNext}
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
            value={progress}
            onChange={handleSeek}
            aria-label={t('vibe.seek')}
            className="flex-1 h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-white"
          />
          <span className="text-[10px] text-white/60 tabular-nums">
            {formatTime(progress)}/{formatTime(duration)}
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

      {needsUserInteraction && (
        <button
          type="button"
          onClick={handlePlayPause}
          className="ml-1 text-[10px] px-2 py-0.5 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
        >
          {t('vibe.clickToPlay')}
        </button>
      )}
    </div>
  )
}
