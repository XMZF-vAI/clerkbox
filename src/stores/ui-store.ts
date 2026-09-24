import { create } from 'zustand'

interface UIState {
  showTaskPanel: boolean
  showSkillStore: boolean
  showScheduledTasks: boolean
  /** 命令面板开关（Ctrl/Cmd+K） */
  commandPaletteOpen: boolean
  /** 桌面端侧边栏折叠态（从 App 提升到 store，供快捷键/命令面板驱动） */
  sidebarCollapsed: boolean
  setShowTaskPanel: (show: boolean) => void
  setShowSkillStore: (show: boolean) => void
  setShowScheduledTasks: (show: boolean) => void
  setCommandPaletteOpen: (open: boolean) => void
  toggleSidebar: () => void
}

export const useUIStore = create<UIState>((set) => ({
  showTaskPanel: false,
  showSkillStore: false,
  showScheduledTasks: false,
  commandPaletteOpen: false,
  sidebarCollapsed: false,
  setShowTaskPanel: (show) => set({ showTaskPanel: show }),
  setShowSkillStore: (show) => set({ showSkillStore: show, ...(show ? { showScheduledTasks: false } : {}) }),
  setShowScheduledTasks: (show) => set({ showScheduledTasks: show, ...(show ? { showSkillStore: false } : {}) }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}))