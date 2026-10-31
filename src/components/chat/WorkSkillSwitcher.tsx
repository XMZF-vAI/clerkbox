/**
 * 工作技能切换器（通用模式，输入框上方——与编程模式的 BranchSwitcher 同位同交互）。
 *
 * 芯片按钮：Briefcase 图标 + 「工作技能」（+ 已激活计数），点击弹出工作类技能列表：
 * 搜索过滤、已激活高亮，点击即激活/停用（复用 skills store 的 toggleSessionSkill），
 * footer 打开技能商店。工作类技能取 document/automation/online 三类；
 * 没有工作类技能时芯片整体隐藏（与分支切换器「非 git 仓库自动隐藏」对称）。
 * 弹层向上展开（输入区贴着窗口底部），Escape / 外点关闭。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Briefcase, Check, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSkillsStore } from '../../stores/skills-store'
import { useUIStore } from '../../stores/ui-store'
import type { SkillDefinition } from '../../types/skills'

// 工作类技能类别：文档/自动化/在线服务归通用模式，development 归编程，custom 不参与
const WORK_SKILL_CATEGORIES: ReadonlyArray<SkillDefinition['category']> = [
  'document',
  'automation',
  'online',
]

export default function WorkSkillSwitcher({ workDir }: { workDir?: string }) {
  const { t } = useTranslation()
  const skills = useSkillsStore((s) => s.skills)
  const sessionSkillIds = useSkillsStore((s) => s.sessionSkillIds)
  const toggleSessionSkill = useSkillsStore((s) => s.toggleSessionSkill)
  const { setShowSkillStore } = useUIStore()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const workSkills = useMemo(
    () => skills.filter((s) => WORK_SKILL_CATEGORIES.includes(s.category)),
    [skills],
  )

  // 外点 / Escape 关闭（与分支切换器同一套交互）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 没有工作类技能时整体隐藏，右侧芯片位留给空（通用模式不显示 git 分支）
  if (workSkills.length === 0) return null

  const keyword = filter.trim().toLowerCase()
  const filtered = workSkills.filter(
    (s) => s.name.toLowerCase().includes(keyword) || s.description.toLowerCase().includes(keyword),
  )
  const activeCount = workSkills.filter((s) => sessionSkillIds.includes(s.id)).length

  const toggleSkill = async (id: string) => {
    if (busyId) return
    setBusyId(id)
    try {
      await toggleSessionSkill(id, workDir || undefined)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t('workSkill.label')}
        className="flex h-[26px] max-w-[180px] items-center gap-1 rounded-md3-sm px-1.5 text-[11px] text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors"
      >
        <Briefcase size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{t('workSkill.label')}</span>
        {activeCount > 0 && (
          <span className="shrink-0 rounded-full bg-dark-surfaceContainerHigh px-1 text-[9px] leading-[14px]">
            {activeCount > 99 ? '99+' : activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t('workSkill.label')}
          className="absolute bottom-full right-0 z-40 mb-1 w-72 overflow-hidden rounded-md3-lg border border-dark-onSurfaceVariant/10 bg-dark-surfaceContainerHigh shadow-xl"
        >
          {/* 搜索 */}
          <div className="border-b border-dark-onSurfaceVariant/10 p-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('workSkill.searchPlaceholder')}
              className="w-full rounded-md3-sm bg-dark-surfaceContainer px-2 py-1.5 text-xs outline-none placeholder:text-dark-onSurfaceVariant/40 focus:ring-1 focus:ring-md-primary/50"
            />
          </div>

          {/* 技能列表 */}
          <div className="max-h-72 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-dark-onSurfaceVariant/60">
                {t('workSkill.noMatch')}
              </p>
            ) : (
              filtered.map((skill) => {
                const isActive = sessionSkillIds.includes(skill.id)
                return (
                  <button
                    key={skill.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    disabled={busyId !== null}
                    onClick={() => void toggleSkill(skill.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-dark-surfaceContainer transition-colors disabled:opacity-70"
                  >
                    <span className="w-4 shrink-0 text-center text-sm leading-none">{skill.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-xs ${isActive ? 'font-medium text-md-primary' : ''}`}>
                        {skill.name}
                      </span>
                      {skill.description && (
                        <span className="block truncate text-[10px] text-dark-onSurfaceVariant/60">
                          {skill.description}
                        </span>
                      )}
                    </span>
                    {isActive && <Check size={12} className="shrink-0 text-md-primary" />}
                  </button>
                )
              })
            )}
          </div>

          {/* footer：技能商店 */}
          <div className="border-t border-dark-onSurfaceVariant/10 p-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setShowSkillStore(true)
              }}
              className="flex h-7 items-center gap-1.5 rounded-md3-sm px-2 text-[11px] text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer hover:text-dark-onSurface transition-colors"
            >
              <Store size={12} />
              {t('workSkill.skillStore')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
