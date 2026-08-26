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
  music: VibeMusic | null
  musicFolder: string | null
  audioMode: VibeAudioMode
  /** 玻璃模式当前生效轨道（运行时状态，随 VibeBackground 检测结果更新） */
  glassTrack: VibeGlassTrack | 'pending'
  toggleVibeMode: (next?: boolean) => void
  setBackground: (bg: VibeBackground) => void
  setBackgroundMode: (mode: VibeBackgroundMode) => void
  setSlideshowFolder: (folder: string | null) => void
  setSlideshowIntervalSec: (sec: number) => void
  setGlassLevel: (level: number) => void
  setMusic: (track: VibeMusic | null) => void
  setMusicFolder: (folder: string | null) => void
  setAudioMode: (mode: VibeAudioMode) => void
  setGlassTrack: (track: VibeGlassTrack | 'pending') => void
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

export const useVibeStore = create<VibeState>()(
  persist(
    (set) => ({
      isVibeMode: false,
      background: DEFAULT_BACKGROUND,
      backgroundMode: 'single',
      slideshowFolder: null,
      slideshowIntervalSec: 30,
      glassLevel: 35,
      music: DEFAULT_MUSIC,
      musicFolder: null,
      audioMode: 'local',
      glassTrack: 'pending',
      toggleVibeMode: (next) =>
        set((state) => ({ isVibeMode: next !== undefined ? next : !state.isVibeMode })),
      setBackground: (bg) => set({ background: bg }),
      setBackgroundMode: (mode) => set({ backgroundMode: pickMode(mode, BACKGROUND_MODES, 'single') }),
      setSlideshowFolder: (folder) => set({ slideshowFolder: folder }),
      setSlideshowIntervalSec: (sec) =>
        set({ slideshowIntervalSec: clampInt(sec, VIBE_SLIDESHOW_MIN_INTERVAL_SEC, VIBE_SLIDESHOW_MAX_INTERVAL_SEC, 30) }),
      setGlassLevel: (level) => set({ glassLevel: clampInt(level, 0, 100, 35) }),
      setMusic: (track) => set({ music: track, musicFolder: null }),
      setMusicFolder: (folder) => set({ musicFolder: folder, music: null }),
      setAudioMode: (mode) => set({ audioMode: pickMode(mode, AUDIO_MODES, 'local') }),
      setGlassTrack: (track) => set({ glassTrack: track }),
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
        music: state.music,
        musicFolder: state.musicFolder,
        audioMode: state.audioMode,
      }),
      // 老用户存了旧的默认 URL 时，迁移到新的默认地址；新字段缺失时回填默认值
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<VibeState> & Record<string, unknown>
        return {
          ...current,
          ...p,
          background: p.background ?? current.background,
          music: p.music ?? current.music,
          musicFolder: p.musicFolder ?? current.musicFolder,
          backgroundMode: pickMode(p.backgroundMode, BACKGROUND_MODES, 'single'),
          audioMode: pickMode(p.audioMode, AUDIO_MODES, 'local'),
          slideshowFolder: typeof p.slideshowFolder === 'string' ? p.slideshowFolder : null,
          slideshowIntervalSec: clampInt(
            p.slideshowIntervalSec,
            VIBE_SLIDESHOW_MIN_INTERVAL_SEC,
            VIBE_SLIDESHOW_MAX_INTERVAL_SEC,
            30,
          ),
          glassLevel: clampInt(p.glassLevel, 0, 100, 35),
          glassTrack: 'pending',
        }
      },
    }
  )
)

export const DEFAULT_VIBE_BACKGROUND = DEFAULT_BACKGROUND
export const DEFAULT_VIBE_MUSIC = DEFAULT_MUSIC
