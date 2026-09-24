import { create } from 'zustand'

interface UIState {
  showTaskPanel: boolean
  showSkillStore: boolean
  showScheduledTasks: boolean
  setShowTaskPanel: (show: boolean) => void
  setShowSkillStore: (show: boolean) => void
  setShowScheduledTasks: (show: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  showTaskPanel: false,
  showSkillStore: false,
  showScheduledTasks: false,
  setShowTaskPanel: (show) => set({ showTaskPanel: show }),
  setShowSkillStore: (show) => set({ showSkillStore: show, ...(show ? { showScheduledTasks: false } : {}) }),
  setShowScheduledTasks: (show) => set({ showScheduledTasks: show, ...(show ? { showSkillStore: false } : {}) }),
}))