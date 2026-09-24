/**
 * 命令与快捷键唯一事实源（对标 ZCode shared/shortcutCommands.ts）。
 *
 * 一份命令表同时喂三个消费方：
 * 1. 全局快捷键钩子（use-global-shortcuts.ts）
 * 2. 命令面板（CommandPalette.tsx，展示 + 检索 + 快捷键提示）
 * 3. 未来设置页的快捷键说明
 *
 * 约定：
 * - 所有快捷键都带 mod（Windows/Linux=Ctrl，macOS=Cmd），避免与文本输入冲突
 * - when() 返回 false 时命令在面板隐藏、快捷键不生效（如未完成引导时禁用会话类命令）
 */
import { useChatStore } from '../stores/chat-store'
import { useSettingsStore } from '../stores/settings-store'
import { useUIStore } from '../stores/ui-store'

export interface CommandShortcut {
  /** KeyboardEvent.key 的小写形式（如 'k'、','） */
  key: string
  shift?: boolean
  alt?: boolean
}

export interface CommandDef {
  id: string
  /** i18n key（commands.* 命名空间） */
  titleKey: string
  /** 搜索关键词（英文/拼音，标题之外的补充命中面） */
  keywords?: string[]
  shortcut?: CommandShortcut
  /** 当前是否可用；面板与快捷键共用同一判定 */
  when?: () => boolean
  run: () => void
}

const onboardingDone = () => useSettingsStore.getState().hasCompletedOnboarding

export const COMMANDS: CommandDef[] = [
  {
    id: 'palette.open',
    titleKey: 'commands.palette',
    keywords: ['command', 'palette', 'mingling', 'cmdk'],
    shortcut: { key: 'k' },
    run: () => useUIStore.getState().setCommandPaletteOpen(!useUIStore.getState().commandPaletteOpen),
  },
  {
    id: 'session.new',
    titleKey: 'commands.newSession',
    keywords: ['new', 'session', 'xinjian', 'create'],
    shortcut: { key: 'n' },
    when: onboardingDone,
    run: () => {
      const ui = useUIStore.getState()
      ui.setShowSkillStore(false)
      ui.setShowScheduledTasks(false)
      useChatStore.getState().createSession({ activate: true })
    },
  },
  {
    id: 'settings.open',
    titleKey: 'commands.openSettings',
    keywords: ['settings', 'preferences', 'shezhi'],
    shortcut: { key: ',' },
    run: () => useSettingsStore.getState().updateSettings({ showSettings: true }),
  },
  {
    id: 'sidebar.toggle',
    titleKey: 'commands.toggleSidebar',
    keywords: ['sidebar', 'cebianlan'],
    shortcut: { key: 'b' },
    when: onboardingDone,
    run: () => useUIStore.getState().toggleSidebar(),
  },
  {
    id: 'theme.toggle',
    titleKey: 'commands.toggleTheme',
    keywords: ['theme', 'dark', 'light', 'zhuti'],
    shortcut: { key: 'l', shift: true },
    run: () => {
      const s = useSettingsStore.getState()
      // system 跟随当前实际生效的暗色状态翻转，避免 system 下按了没反应
      const isDark =
        s.theme === 'dark' ||
        (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      s.updateSettings({ theme: isDark ? 'light' : 'dark' })
    },
  },
  {
    id: 'skillStore.open',
    titleKey: 'commands.openSkillStore',
    keywords: ['skill', 'store', 'jineng'],
    when: onboardingDone,
    run: () => useUIStore.getState().setShowSkillStore(true),
  },
  {
    id: 'scheduledTasks.open',
    titleKey: 'commands.openScheduledTasks',
    keywords: ['schedule', 'task', 'dingshi'],
    when: onboardingDone,
    run: () => useUIStore.getState().setShowScheduledTasks(true),
  },
]

/** 当前可用的命令列表（面板与快捷键共用） */
export function availableCommands(): CommandDef[] {
  return COMMANDS.filter((c) => !c.when || c.when())
}

export function isMacPlatform(): boolean {
  if (typeof window !== 'undefined' && window.clerkbox?.platform) {
    return window.clerkbox.platform === 'darwin'
  }
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
}

/** 键盘事件是否命中快捷键（mod = Ctrl 或 macOS Cmd；shift/alt 须精确一致） */
export function shortcutMatches(event: KeyboardEvent, shortcut: CommandShortcut): boolean {
  const modPressed = isMacPlatform() ? event.metaKey : event.ctrlKey
  if (!modPressed) return false
  if (!!shortcut.shift !== event.shiftKey) return false
  if (!!shortcut.alt !== event.altKey) return false
  return event.key.toLowerCase() === shortcut.key
}

/** 快捷键的展示文案（mac 用符号，其余用 Ctrl+ 前缀） */
export function formatShortcut(shortcut: CommandShortcut): string {
  const key = shortcut.key === ',' ? ',' : shortcut.key.toUpperCase()
  if (isMacPlatform()) {
    return `${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}⌘${key}`
  }
  return `Ctrl+${shortcut.alt ? 'Alt+' : ''}${shortcut.shift ? 'Shift+' : ''}${key}`
}
