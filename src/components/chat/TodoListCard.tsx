import { Check, Circle, ListTodo, Loader2, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TodoItem } from '../../types/agent'
import { useTodoStore } from '../../stores/interactive-store'

const EMPTY_TODOS: TodoItem[] = []

export default function TodoListCard({ sessionId, vibe = false }: { sessionId: string; vibe?: boolean }) {
  const { t } = useTranslation()
  const items = useTodoStore((state) => state.bySession[sessionId] || EMPTY_TODOS)
  const [expanded, setExpanded] = useState(true)
  if (items.length === 0) return null
  const completed = items.filter((item) => item.status === 'completed').length

  return (
    <section className={`mx-4 mb-3 overflow-hidden rounded-md3-md border shadow-sm animate-slide-up ${vibe ? 'border-white/20 bg-white/10 text-white' : 'border-dark-onSurfaceVariant/15 bg-dark-surfaceContainerHigh text-dark-onSurface'}`} aria-label={t('todo.title')}>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex min-h-11 w-full items-center gap-2 border-b border-current/10 px-4 py-3 text-left">
        <ListTodo size={17} className={vibe ? 'text-white/70' : 'text-md-primary'} />
        <span className="flex-1 text-sm font-medium">{t('todo.title')}</span>
        <span className="text-xs opacity-60">{completed}/{items.length}</span>
        <ChevronDown size={15} className={`transition-transform ${expanded ? '' : '-rotate-90'}`} />
      </button>
      {expanded && <div className="space-y-1 p-2">
        {items.map((item, index) => (
          <div key={`${item.text}-${index}`} className="flex min-h-10 w-full items-center gap-3 rounded-md3-sm px-2.5 text-left">
            <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${item.status === 'completed' ? 'bg-md-success text-white' : item.status === 'in_progress' ? 'text-md-primary' : 'text-current/30'}`}>
              {item.status === 'completed' ? <Check size={13} /> : item.status === 'in_progress' ? <Loader2 size={15} className="animate-spin" /> : <Circle size={15} />}
            </span>
            <span className={`min-w-0 flex-1 text-sm ${item.status === 'completed' ? 'text-current/50 line-through' : ''}`}>{item.text}</span>
            <span className="shrink-0 text-[11px] opacity-50">{t(`todo.${item.status}`)}</span>
          </div>
        ))}
      </div>}
    </section>
  )
}
