import { useMemo, useState } from 'react'
import { CircleHelp, Check, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useInteractiveStore } from '../../stores/interactive-store'

export default function QuestionCard({ sessionId, vibe = false }: { sessionId: string; vibe?: boolean }) {
  const { t } = useTranslation()
  const pending = useInteractiveStore((state) => state.pendingQuestions[sessionId])
  const resolveQuestion = useInteractiveStore((state) => state.resolveQuestion)
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState(true)

  const answers = useMemo(() => {
    if (!pending) return {}
    return Object.fromEntries(pending.questions.map((question) => {
      const choice = selected[question.id]
      return [question.id, choice === '__other__' ? ((other[question.id] || '').trim() ? [(other[question.id] || '').trim()] : []) : choice ? [choice] : []]
    })) as Record<string, string[]>
  }, [other, pending, selected])

  if (!pending) return null

  const submit = () => resolveQuestion(sessionId, pending.id, answers)
  const answered = pending.questions.every((question) => (answers[question.id] || []).length > 0)
  // 已答数 / 总数（进度展示真实作答进度，而不是恒等的 n/n）
  const answeredCount = pending.questions.filter((question) => (answers[question.id] || []).length > 0).length

  return (
    <section className={`mx-4 mb-3 overflow-hidden rounded-md3-md border shadow-sm animate-slide-up ${
      vibe ? 'border-white/20 bg-white/10 text-white' : 'border-dark-onSurfaceVariant/15 bg-dark-surfaceContainerHigh text-dark-onSurface'
    }`} aria-label={t('question.title')}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-3 text-left"
      >
        <CircleHelp size={17} className={vibe ? 'text-white/70' : 'text-md-primary'} />
        <span className="flex-1 text-sm font-medium">{t('question.title')}</span>
        <span className="text-xs opacity-60">{answeredCount}/{pending.questions.length}</span>
        <ChevronDown size={15} className={`transition-transform ${expanded ? '' : '-rotate-90'}`} />
      </button>
      {expanded && (
        <div className="space-y-4 border-t border-current/10 px-4 pb-4 pt-3">
          {pending.questions.map((question) => {
            const value = selected[question.id] || ''
            return (
              <div key={question.id} className="space-y-2">
                <div className="text-sm font-medium">{question.question}</div>
                <div className="grid gap-2">
                  {question.options.map((option) => {
                    const active = value === option.label
                    return (
                      <button
                        type="button"
                        key={option.label}
                        onClick={() => setSelected((state) => ({ ...state, [question.id]: option.label }))}
                        className={`flex min-h-11 items-start gap-3 rounded-md3-sm border px-3 py-2 text-left transition-colors ${
                          active
                            ? vibe ? 'border-white/60 bg-white/15' : 'border-md-primary bg-md-primary/10'
                            : vibe ? 'border-white/15 bg-white/5 hover:bg-white/10' : 'border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/40 hover:bg-dark-surfaceContainer'
                        }`}
                      >
                        <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${active ? 'border-md-primary bg-md-primary text-white' : 'border-current/25'}`}>
                          {active && <Check size={11} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm">{option.label}</span>
                          {option.description && <span className="mt-0.5 block text-xs opacity-60">{option.description}</span>}
                        </span>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    onClick={() => setSelected((state) => ({ ...state, [question.id]: '__other__' }))}
                    className={`flex min-h-11 items-center gap-3 rounded-md3-sm border px-3 py-2 text-left transition-colors ${
                      value === '__other__' ? vibe ? 'border-white/60 bg-white/15' : 'border-md-primary bg-md-primary/10' : vibe ? 'border-white/15 bg-white/5 hover:bg-white/10' : 'border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/40 hover:bg-dark-surfaceContainer'
                    }`}
                  >
                    <span className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${value === '__other__' ? 'border-md-primary bg-md-primary text-white' : 'border-current/25'}`}>{value === '__other__' && <Check size={11} />}</span>
                    <span className="text-sm">{t('question.other')}</span>
                  </button>
                  {value === '__other__' && (
                    <input
                      autoFocus
                      value={other[question.id] || ''}
                      onChange={(event) => setOther((state) => ({ ...state, [question.id]: event.target.value }))}
                      placeholder={t('question.otherPlaceholder')}
                      className={`min-h-11 rounded-md3-sm border px-3 text-sm outline-none focus:ring-2 ${vibe ? 'border-white/20 bg-white/10 text-white placeholder:text-white/40 focus:ring-white/30' : 'border-dark-onSurfaceVariant/20 bg-dark-surface text-dark-onSurface placeholder:text-dark-onSurfaceVariant/50 focus:ring-md-primary/30'}`}
                    />
                  )}
                </div>
              </div>
            )
          })}
          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" onClick={() => resolveQuestion(sessionId, pending.id, {})} className="min-h-10 px-2 text-sm opacity-70 transition-opacity hover:opacity-100">{t('question.ignore')}</button>
            <button type="button" onClick={submit} disabled={!answered} className="min-h-10 rounded-md3-sm bg-md-primary px-4 text-sm font-medium text-md-onPrimary transition-opacity disabled:cursor-not-allowed disabled:opacity-40">{t('question.submit')}</button>
          </div>
        </div>
      )}
    </section>
  )
}
