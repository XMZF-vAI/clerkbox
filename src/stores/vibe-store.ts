import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { sharedStorage } from '../lib/shared-storage'

export interface VibeBackground {
  type: 'url' | 'local'
  value: string
}

export interface VibeMusic {
  type: 'url' | 'local'
  value: string
}

/** 背景模式：单图片 / 文件夹轮播 / 透明玻璃 */
export type VibeBackgroundMode = 'single' | 'slideshow' | 'glass'

/** 音频模式：本地音乐 / 系统正在播放 */
export type VibeAudioMode = 'local' | 'system'

/** 玻璃模式实际生效的渲染轨道（VibeBackground 写入，不持久化） */
export type VibeGlassTrack = 'acrylic' | 'transparent' | 'fallback'
export type VibeBackgroundStatus = 'loading' | 'ready' | 'error' | 'empty'
export type VibeBackgroundIssue = 'single' | 'slideshow' | 'glass' | null

export const VIBE_SLIDESHOW_MIN_INTERVAL_SEC = 5
export const VIBE_SLIDESHOW_MAX_INTERVAL_SEC = 300

const BACKGROUND_MODES: VibeBackgroundMode[] = ['single', 'slideshow', 'glass']
const AUDIO_MODES: VibeAudioMode[] = ['local', 'system']

interface VibeState {
  isVibeMode: boolean
  background: VibeBackground
  backgroundMode: VibeBackgroundMode
  slideshowFolder: string | null
  slideshowIntervalSec: number
  /** 玻璃程度 0-100：0 = 全透明，越大越磨砂 */
  glassLevel: number
  readingOpacity: number
  volume: number
  music: VibeMusic | null
  musicFolder: string | null
  audioMode: VibeAudioMode
  /** 玻璃模式当前生效轨道（运行时状态，随 VibeBackground 检测结果更新） */
  glassTrack: VibeGlassTrack | 'pending'
  backgroundStatus: VibeBackgroundStatus
  backgroundIssue: VibeBackgroundIssue
  backgroundRetryToken: number
  toggleVibeMode: (next?: boolean) => void
  setBackground: (bg: VibeBackground) => void
  setBackgroundMode: (mode: VibeBackgroundMode) => void
  setSlideshowFolder: (folder: string | null) => void
  setSlideshowIntervalSec: (sec: number) => void
  setGlassLevel: (level: number) => void
  setReadingOpacity: (opacity: number) => void
  setVolume: (volume: number) => void
  setMusic: (track: VibeMusic | null) => void
  setMusicFolder: (folder: string | null) => void
  setAudioMode: (mode: VibeAudioMode) => void
  setGlassTrack: (track: VibeGlassTrack | 'pending') => void
  setBackgroundState: (status: VibeBackgroundStatus, issue?: VibeBackgroundIssue) => void
  retryBackground: () => void
}

const DEFAULT_BACKGROUND: VibeBackground = {
  type: 'url',
  value: 'https://download.xmzf.space/d/all.jpg?sign=76nF_pS2izwdX4O9NtrMo16a1LzhIaN8K1NX9Vuhdus=:0',
}

const DEFAULT_MUSIC: VibeMusic = {
  type: 'url',
  value: 'https://download.xmzf.space/d/well.mp3?sign=80T1gAdArbx1nhRPlVCxMh6HYUN5ZojtXqRrrfZV8aM=:0',
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

function pickMode<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback
}

function validMedia(value: unknown): value is VibeBackground {
  if (!value || typeof value !== 'object') return false
  const media = value as Partial<VibeBackground>
  return (media.type === 'url' || media.type === 'local') && typeof media.value === 'string' && !!media.value.trim()
}

/** Keep old preferences compatible while preserving an explicit music-off value. */
export function mergeVibePreferences(persisted: unknown, current: VibeState): VibeState {
  const p = (persisted && typeof persisted === 'object' ? persisted : {}) as Record<string, unknown>
  const musicFolder = typeof p.musicFolder === 'string' && p.musicFolder.trim() ? p.musicFolder : null
  const music = Object.prototype.hasOwnProperty.call(p, 'music')
    ? p.music === null ? null : validMedia(p.music) ? p.music : current.music
    : current.music
  return {
    ...current,
    background: validMedia(p.background) ? p.background : current.background,
    music: musicFolder ? null : music,
    musicFolder,
    backgroundMode: pickMode(p.backgroundMode, BACKGROUND_MODES, 'single'),
    audioMode: pickMode(p.audioMode, AUDIO_MODES, 'local'),
    slideshowFolder: typeof p.slideshowFolder === 'string' && p.slideshowFolder.trim() ? p.slideshowFolder : null,
    slideshowIntervalSec: clampInt(p.slideshowIntervalSec, VIBE_SLIDESHOW_MIN_INTERVAL_SEC, VIBE_SLIDESHOW_MAX_INTERVAL_SEC, 30),
    glassLevel: clampInt(p.glassLevel, 0, 100, 35),
    readingOpacity: clampInt(p.readingOpacity, 0, 100, 60),
    volume: clampInt(p.volume, 0, 100, 35),
    glassTrack: 'pending',
    backgroundStatus: 'loading',
    backgroundIssue: null,
    backgroundRetryToken: 0,
  }
}

export const useVibeStore = create<VibeState>()(
  persist(
    (set) => ({
      isVibeMode: false,
      background: DEFAULT_BACKGROUND,
      backgroundMode: 'single',
      slideshowFolder: null,
      slideshowIntervalSec: 30,
      glassLevel: 35,
      readingOpacity: 60,
      volume: 35,
      music: DEFAULT_MUSIC,
      musicFolder: null,
      audioMode: 'local',
      glassTrack: 'pending',
      backgroundStatus: 'loading',
      backgroundIssue: null,
      backgroundRetryToken: 0,
      toggleVibeMode: (next) =>
        set((state) => ({ isVibeMode: next !== undefined ? next : !state.isVibeMode })),
      setBackground: (bg) => set({ background: bg }),
      setBackgroundMode: (mode) => set({ backgroundMode: pickMode(mode, BACKGROUND_MODES, 'single') }),
      setSlideshowFolder: (folder) => set({ slideshowFolder: folder }),
      setSlideshowIntervalSec: (sec) =>
        set({ slideshowIntervalSec: clampInt(sec, VIBE_SLIDESHOW_MIN_INTERVAL_SEC, VIBE_SLIDESHOW_MAX_INTERVAL_SEC, 30) }),
      setGlassLevel: (level) => set({ glassLevel: clampInt(level, 0, 100, 35) }),
      setReadingOpacity: (opacity) => set({ readingOpacity: clampInt(opacity, 0, 100, 60) }),
      setVolume: (volume) => set({ volume: clampInt(volume, 0, 100, 35) }),
      setMusic: (track) => set({ music: track, musicFolder: null }),
      setMusicFolder: (folder) => set({ musicFolder: folder, ...(folder ? { music: null } : {}) }),
      setAudioMode: (mode) => set({ audioMode: pickMode(mode, AUDIO_MODES, 'local') }),
      setGlassTrack: (track) => set({ glassTrack: track }),
      setBackgroundState: (status, issue = null) => set({ backgroundStatus: status, backgroundIssue: issue }),
      retryBackground: () => set((state) => ({ backgroundRetryToken: state.backgroundRetryToken + 1 })),
    }),
    {
      name: 'clerkbox-vibe',
      storage: sharedStorage,
      partialize: (state) => ({
        background: state.background,
        backgroundMode: state.backgroundMode,
        slideshowFolder: state.slideshowFolder,
        slideshowIntervalSec: state.slideshowIntervalSec,
        glassLevel: state.glassLevel,
        readingOpacity: state.readingOpacity,
        volume: state.volume,
        music: state.music,
        musicFolder: state.musicFolder,
        audioMode: state.audioMode,
      }),
      merge: mergeVibePreferences,
    }
  )
)

export const DEFAULT_VIBE_BACKGROUND = DEFAULT_BACKGROUND
export const DEFAULT_VIBE_MUSIC = DEFAULT_MUSIC
