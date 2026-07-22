import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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
  value: 'https://images.pexels.com/photos/572897/pexels-photo-572897.jpeg?auto=compress&cs=tinysrgb&w=1920&h=1080&fit=crop',
}

const DEFAULT_MUSIC: VibeMusic = {
  type: 'url',
  value: 'https://xmzf.space/bj.mp3',
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
      partialize: (state) => ({
        background: state.background,
        music: state.music,
        musicFolder: state.musicFolder,
      }),
    }
  )
)

export const DEFAULT_VIBE_BACKGROUND = DEFAULT_BACKGROUND
export const DEFAULT_VIBE_MUSIC = DEFAULT_MUSIC
