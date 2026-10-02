import { Briefcase, SquareTerminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import type { InterfaceMode } from '../../types/agent'

const MODES: Array<{ value: InterfaceMode; icon: typeof SquareTerminal }> = [
  { value: 'coding', icon: SquareTerminal },
  { value: 'general', icon: Briefcase },
]

/**
 * 「编程 / 通用」界面模式切换（参考 Qoder 的胶囊分段控件）：
 * 选中段展开为「图标 + 文字」的高亮胶囊，未选中段收起为仅图标。
 * 模式是纯展示层偏好（问候语、占位符等技术细节的呈现粒度），不改变 Agent 能力。
 */
export default function ModeToggle() {
  const { t } = useTranslation()
  const interfaceMode = useSettingsStore((s) => s.interfaceMode)

  return (
    <div
      role="radiogroup"
      aria-label={t('interfaceMode.toggleAria')}
      className="flex items-center p-0.5 rounded-full bg-dark-surfaceContainerHigh/70 border border-dark-onSurfaceVariant/10"
    >
      {MODES.map(({ value, icon: Icon }) => {
        const active = interfaceMode === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={t(`interfaceMode.${value}`)}
            onClick={() => {
              if (!active) useSettingsStore.getState().updateSettings({ interfaceMode: value })
            }}
            className={`md-focus flex items-center h-7 rounded-full transition-all duration-200 ${
              active
                ? 'px-2.5 gap-1.5 border border-md-primary/50 bg-md-primary/10 text-md-primary'
                : 'w-8 justify-center text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface'
            }`}
          >
            <Icon size={13} className="shrink-0" />
            {active && (
              <span className="text-xs font-medium whitespace-nowrap leading-none">
                {t(`interfaceMode.${value}`)}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
