/**
 * 命令面板（Ctrl/Cmd+K）：命令 + 会话搜索二合一。
 * 对标 ZCode command-center；文件搜索待后续接入（需主进程文件索引支持）。
 *
 * 交互：↑/↓ 循环移动，Enter 执行，Esc 关闭，点击遮罩关闭。
 * 命令与会话分组合并为一个可导航列表（组头不参与选中）。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, TerminalSquare, MessageSquare, X, ArrowUp, ArrowDown, CornerDownLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { availableCommands, formatShortcut } from '../../lib/commands'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'
import { useVibeStore } from '../../stores/vibe-store'
import { useModalAccessibility } from '../../hooks/use-modal-accessibility'

interface PaletteItem {
  key: string
  group: 'commands' | 'sessions'
  title: string
  description?: string
  shortcut?: string
  run: () => void
}

export default function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen)
  const sessions = useChatStore((s) => s.sessions)
  const vibe = useVibeStore((s) => s.isVibeMode)
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const close = () => useUIStore.getState().setCommandPaletteOpen(false)
  const panelRef = useModalAccessibility(close, inputRef, { active: open })

  // 打开时重置状态并聚焦输入框
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase()
    const result: PaletteItem[] = []

    const commands = availableCommands().filter((cmd) => {
      if (cmd.id === 'palette.open') return false
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

    {
      const matched = [...sessions]
        .filter((s) => s.messages.length > 0)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .filter((s) => !q || `${s.title || ''} ${s.workingDir || ''}`.toLowerCase().includes(q))
        .slice(0, q ? 12 : 5)
      for (const s of matched) {
        result.push({
          key: `session:${s.id}`,
          group: 'sessions',
          title: s.title || t('commandPalette.untitled'),
          description: s.workingDir?.split(/[/\\]/).filter(Boolean).pop(),
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

  const execute = (item: PaletteItem) => {
    close()
    item.run()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
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

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/50 px-4 pb-4 pt-[12vh] backdrop-blur-sm animate-fade-in max-md:px-2 max-md:pt-16"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`flex max-h-[78dvh] w-full max-w-xl flex-col overflow-hidden rounded-md3-lg border shadow-elevation-3 outline-none animate-pop-in ${vibe ? 'liquid-glass-strong text-white' : 'border-dark-onSurfaceVariant/15 bg-dark-surface text-dark-onSurface'}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('commands.palette')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`flex shrink-0 items-center gap-3 border-b px-4 ${vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/10'}`}>
          <Search size={16} className="shrink-0 text-dark-onSurfaceVariant/60" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label={t('commandPalette.placeholder')}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items.length ? `${listId}-${Math.min(activeIndex, items.length - 1)}` : undefined}
            onKeyDown={onKeyDown}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            placeholder={t('commandPalette.placeholder')}
            className={`h-14 min-w-0 flex-1 bg-transparent text-ui-base outline-none ${vibe ? 'placeholder:text-white/50' : 'placeholder:text-dark-onSurfaceVariant/60'}`}
          />
          <button type="button" onClick={close} aria-label={t('common.close')} title={t('common.close')}
            className={`md-focus flex h-9 w-9 shrink-0 items-center justify-center rounded-md3-sm max-md:h-11 max-md:w-11 ${vibe ? 'hover:bg-white/10' : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'}`}>
            <X size={17} />
          </button>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label={t('commands.palette')} className="min-h-0 overflow-y-auto overscroll-contain p-2">
          {items.length === 0 && (
            <p role="presentation" className="px-4 py-10 text-center text-ui-sm opacity-60">
              {t('commandPalette.noResults')}
            </p>
          )}
          {items.map((item, index) => {
            const showGroupHeader = item.group !== lastGroup
            lastGroup = item.group
            return (
              <div key={item.key} role="presentation">
                {showGroupHeader && (
                  <p role="presentation" className="px-3 pb-2 pt-3 text-ui-xs font-medium opacity-60">
                    {item.group === 'commands' ? t('commandPalette.commands') : t(query.trim() ? 'commandPalette.sessions' : 'commandPalette.recentSessions')}
                  </p>
                )}
                <button
                  type="button"
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === Math.min(activeIndex, items.length - 1)}
                  tabIndex={-1}
                  data-index={index}
                  onClick={() => execute(item)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex min-h-11 w-full items-center gap-3 rounded-md3-sm px-3 py-2.5 text-left text-ui-sm transition-colors ${
                    index === activeIndex
                      ? vibe ? 'bg-white/15 text-white' : 'bg-dark-surfaceContainerHigh text-dark-onSurface'
                      : vibe ? 'text-white/75' : 'text-dark-onSurfaceVariant'
                  }`}
                >
                  {item.group === 'commands' ? (
                    <TerminalSquare size={15} className="shrink-0 opacity-60" />
                  ) : (
                    <MessageSquare size={15} className="shrink-0 opacity-60" />
                  )}
                  <span className="min-w-0 flex-1"><span className="block truncate">{item.title}</span>
                    {item.description && <span className="mt-0.5 block truncate text-ui-xs opacity-60">{item.description}</span>}
                  </span>
                  {item.shortcut && (
                    <kbd className={`shrink-0 rounded-md3-xs border px-1.5 py-0.5 text-ui-xs opacity-60 ${vibe ? 'border-white/20' : 'border-dark-onSurfaceVariant/20'}`}>
                      {item.shortcut}
                    </kbd>
                  )}
                </button>
              </div>
            )
          })}
        </div>
        <div className={`flex shrink-0 items-center gap-4 border-t px-4 py-3 text-ui-xs ${vibe ? 'border-white/15 text-white/60' : 'border-dark-onSurfaceVariant/10 text-dark-onSurfaceVariant/60'}`}>
          <span className="inline-flex items-center gap-1"><ArrowUp size={12} /><ArrowDown size={12} /> {t('commandPalette.navigate')}</span>
          <span className="inline-flex items-center gap-1"><CornerDownLeft size={13} /> {t('commandPalette.execute')}</span>
          <span className="ml-auto tabular-nums" role="status">{t('commandPalette.resultCount', { count: items.length })}</span>
        </div>
      </div>
    </div>, document.body,
  )
}
