import { Briefcase, SquareTerminal } from 'lucide-react'
import { useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import type { InterfaceMode } from '../../types/agent'

const MODES: Array<{ value: InterfaceMode; icon: typeof SquareTerminal }> = [
  { value: 'coding', icon: SquareTerminal },
  { value: 'general', icon: Briefcase },
]

/** 展示模式偏好；两个选项始终可见，方向键与 Tab 遵循单选组约定。 */
export default function ModeToggle() {
  const { t } = useTranslation()
  const interfaceMode = useSettingsStore((s) => s.interfaceMode)
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? (index + 1) % MODES.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? (index - 1 + MODES.length) % MODES.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? MODES.length - 1
            : -1
    if (nextIndex < 0) return
    event.preventDefault()
    useSettingsStore.getState().updateSettings({ interfaceMode: MODES[nextIndex].value })
    buttonRefs.current[nextIndex]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('interfaceMode.toggleAria')}
      className="grid grid-cols-2 gap-1 rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainer/50 p-1"
    >
      {MODES.map(({ value, icon: Icon }, index) => {
        const active = interfaceMode === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            ref={(element) => { buttonRefs.current[index] = element }}
            title={t(`interfaceMode.${value}`)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            onClick={() => {
              if (!active) useSettingsStore.getState().updateSettings({ interfaceMode: value })
            }}
            className={`md-focus flex min-h-8 items-center justify-center gap-2 rounded-md3-sm border px-2 py-1 max-md:min-h-11 transition-colors duration-200 ${
              active
                ? 'border-dark-onSurfaceVariant/10 bg-dark-surfaceBright text-dark-onSurface shadow-elevation-1'
                : 'border-transparent text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface'
            }`}
          >
            <Icon size={14} className="shrink-0" />
            <span className="text-ui-xs font-medium whitespace-nowrap">
              {t(`interfaceMode.${value}`)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
