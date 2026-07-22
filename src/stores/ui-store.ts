import { create } from 'zustand'

interface UIState {
  showTaskPanel: boolean
  showSkillStore: boolean
  setShowTaskPanel: (show: boolean) => void
  setShowSkillStore: (show: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  showTaskPanel: false,
  showSkillStore: false,
  setShowTaskPanel: (show) => set({ showTaskPanel: show }),
  setShowSkillStore: (show) => set({ showSkillStore: show }),
}))
