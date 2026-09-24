/**
 * 全局快捷键钩子：消费 commands.ts 唯一事实源。
 *
 * 细节：
 * - IME 组合输入期间（isComposing）不触发，避免中文输入误命中
 * - 命令面板打开时只响应「关闭面板」自身（Ctrl/Cmd+K），其余按键交给面板处理
 * - 全部快捷键都带 mod 键，因此输入框聚焦时也允许触发（与 VS Code 一致）
 */
import { useEffect } from 'react'
import { COMMANDS, shortcutMatches } from '../lib/commands'
import { useUIStore } from '../stores/ui-store'

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return
      if (!event.ctrlKey && !event.metaKey) return

      const paletteOpen = useUIStore.getState().commandPaletteOpen
      for (const command of COMMANDS) {
        if (!command.shortcut || !shortcutMatches(event, command.shortcut)) continue
        if (paletteOpen && command.id !== 'palette.open') return
        if (command.when && !command.when()) return
        event.preventDefault()
        command.run()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
