/**
 * 命令面板（Ctrl/Cmd+K）：命令 + 会话搜索二合一。
 * 对标 ZCode command-center；文件搜索待后续接入（需主进程文件索引支持）。
 *
 * 交互：↑/↓ 循环移动，Enter 执行，Esc 关闭，点击遮罩关闭。
 * 命令与会话分组合并为一个可导航列表（组头不参与选中）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, TerminalSquare, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { availableCommands, formatShortcut } from '../../lib/commands'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'

interface PaletteItem {
  key: string
  group: 'commands' | 'sessions'
  title: string
  shortcut?: string
  run: () => void
}

export default function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen)
  const sessions = useChatStore((s) => s.sessions)
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 打开时重置状态并聚焦输入框
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // Esc 必须总能关掉面板：只绑在 dialog div 上时，焦点一旦跑到面板外（Tab 出框、
  // 点选列表项后）就再也收不到 keydown，用户被关在一个关不掉的模态里。
  useEffect(() => {
    if (!open) return
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      useUIStore.getState().setCommandPaletteOpen(false)
    }
    document.addEventListener('keydown', onDocKeyDown)
    return () => document.removeEventListener('keydown', onDocKeyDown)
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase()
    const result: PaletteItem[] = []

    const commands = availableCommands().filter((cmd) => {
      if (!q) return true
      const title = t(cmd.titleKey).toLowerCase()
      return (
        title.includes(q) ||
        cmd.id.toLowerCase().includes(q) ||
        (cmd.keywords ?? []).some((k) => k.toLowerCase().includes(q))
      )
    })
    for (const cmd of commands) {
      result.push({
        key: `cmd:${cmd.id}`,
        group: 'commands',
        title: t(cmd.titleKey),
        shortcut: cmd.shortcut ? formatShortcut(cmd.shortcut) : undefined,
        run: () => cmd.run(),
      })
    }

    if (q) {
      const matched = [...sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((s) => (s.title || '').toLowerCase().includes(q))
        .slice(0, 8)
      for (const s of matched) {
        result.push({
          key: `session:${s.id}`,
          group: 'sessions',
          title: s.title || t('commandPalette.untitled'),
          run: () => {
            const ui = useUIStore.getState()
            ui.setShowSkillStore(false)
            ui.setShowScheduledTasks(false)
            useChatStore.getState().setActiveSession(s.id)
          },
        })
      }
    }
    return result
  }, [query, sessions, t])

  // 过滤导致条目变少时收敛选中下标，防止越界
  useEffect(() => {
    setActiveIndex((i) => (items.length === 0 ? 0 : Math.min(i, items.length - 1)))
  }, [items.length])

  // 高亮项保持可见
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  if (!open) return null

  const close = () => useUIStore.getState().setCommandPaletteOpen(false)

  const execute = (item: PaletteItem) => {
    close()
    item.run()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (items.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => (i + 1) % items.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => (i - 1 + items.length) % items.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = items[Math.min(activeIndex, items.length - 1)]
      if (item) execute(item)
    }
  }

  let lastGroup: PaletteItem['group'] | null = null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 backdrop-blur-[2px] animate-fade-in"
      onClick={close}
      role="presentation"
    >
      <div
        className="mt-[14vh] w-full max-w-xl mx-4 rounded-xl border border-dark-onSurfaceVariant/20 bg-dark-surface shadow-elevation-3 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={t('commands.palette')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 px-4 border-b border-dark-onSurfaceVariant/10">
          <Search size={16} className="shrink-0 text-dark-onSurfaceVariant/60" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            placeholder={t('commandPalette.placeholder')}
            className="w-full h-11 bg-transparent text-sm text-dark-onSurface placeholder:text-dark-onSurfaceVariant/50 outline-none"
          />
          <kbd className="shrink-0 rounded border border-dark-onSurfaceVariant/20 px-1.5 py-0.5 text-[10px] text-dark-onSurfaceVariant/60">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1.5">
          {items.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-dark-onSurfaceVariant/60">
              {t('commandPalette.noResults')}
            </p>
          )}
          {items.map((item, index) => {
            const showGroupHeader = item.group !== lastGroup
            lastGroup = item.group
            return (
              <div key={item.key}>
                {showGroupHeader && (
                  <p className="px-4 pt-2 pb-1 text-[11px] font-medium text-dark-onSurfaceVariant/50">
                    {item.group === 'commands' ? t('commandPalette.commands') : t('commandPalette.sessions')}
                  </p>
                )}
                <button
                  type="button"
                  data-index={index}
                  onClick={() => execute(item)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                    index === activeIndex
                      ? 'bg-md-primary/10 text-dark-onSurface'
                      : 'text-dark-onSurfaceVariant'
                  }`}
                >
                  {item.group === 'commands' ? (
                    <TerminalSquare size={15} className="shrink-0 opacity-60" />
                  ) : (
                    <MessageSquare size={15} className="shrink-0 opacity-60" />
                  )}
                  <span className="flex-1 truncate">{item.title}</span>
                  {item.shortcut && (
                    <kbd className="shrink-0 rounded border border-dark-onSurfaceVariant/20 px-1.5 py-0.5 text-[10px] text-dark-onSurfaceVariant/60">
                      {item.shortcut}
                    </kbd>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
