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

interface VibeState {
  isVibeMode: boolean
  background: VibeBackground
  music: VibeMusic | null
  musicFolder: string | null
  toggleVibeMode: (next?: boolean) => void
  setBackground: (bg: VibeBackground) => void
  setMusic: (track: VibeMusic | null) => void
  setMusicFolder: (folder: string | null) => void
}

const DEFAULT_BACKGROUND: VibeBackground = {
  type: 'url',
  value: 'https://download.xmzf.space/d/all.jpg?sign=76nF_pS2izwdX4O9NtrMo16a1LzhIaN8K1NX9Vuhdus=:0',
}

const DEFAULT_MUSIC: VibeMusic = {
  type: 'url',
  value: 'https://download.xmzf.space/d/well.mp3?sign=80T1gAdArbx1nhRPlVCxMh6HYUN5ZojtXqRrrfZV8aM=:0',
}

export const useVibeStore = create<VibeState>()(
  persist(
    (set) => ({
      isVibeMode: false,
      background: DEFAULT_BACKGROUND,
      music: DEFAULT_MUSIC,
      musicFolder: null,
      toggleVibeMode: (next) =>
        set((state) => ({ isVibeMode: next !== undefined ? next : !state.isVibeMode })),
      setBackground: (bg) => set({ background: bg }),
      setMusic: (track) => set({ music: track, musicFolder: null }),
      setMusicFolder: (folder) => set({ musicFolder: folder, music: null }),
    }),
    {
      name: 'clerkbox-vibe',
      storage: sharedStorage,
      partialize: (state) => ({
        background: state.background,
        music: state.music,
        musicFolder: state.musicFolder,
      }),
      // 老用户存了旧的默认 URL 时，迁移到新的默认地址
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<VibeState>
        return {
          ...current,
          ...p,
          background: p.background ?? current.background,
          music: p.music ?? current.music,
          musicFolder: p.musicFolder ?? current.musicFolder,
        }
      },
    }
  )
)

export const DEFAULT_VIBE_BACKGROUND = DEFAULT_BACKGROUND
export const DEFAULT_VIBE_MUSIC = DEFAULT_MUSIC
