import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SkillDefinition, SkillsMPSkill, SkillsMPSearchResult } from '../types/skills'
import { ipc } from '../lib/ipc-client'

interface SkillsState {
  /** All installed skills (only online-downloaded, no preset) */
  skills: SkillDefinition[]
  /** Skills enabled for the current session (by id) */
  sessionSkillIds: string[]
  /** Online search results */
  searchResults: SkillsMPSkill[]
  /** Search loading state */
  searchLoading: boolean
  /** Search query */
  searchQuery: string
  /** Search pagination */
  searchPage: number
  searchTotal: number
  searchHasNext: boolean
  /** Recommended skills (fetched on store open) */
  recommendedSkills: SkillsMPSkill[]
  recommendedLoading: boolean

  /** Toggle a skill on/off for the current session, sync to disk */
  toggleSessionSkill: (id: string, workingDir?: string) => Promise<void>
  /** Set the full list of session skills */
  setSessionSkills: (ids: string[]) => void
  /** Get all skills enabled for the current session */
  getSessionSkills: () => SkillDefinition[]
  /** Get active skill slugs for system prompt */
  getActiveSkillSlugs: () => string[]
  /** Get lightweight active skill index (不含 SKILL.md 正文) for progressive loading */
  getActiveSkillIndex: () => Array<{
    slug: string
    name: string
    description: string
    triggerKeywords: string[]
    version: string
    skillMdPath: string
    chainsTo: string[]
  }>
  /** Reset session skills (for new conversation) */
  resetSessionSkills: () => void

  /** Search SkillsMP marketplace */
  searchOnlineSkills: (query: string, page?: number) => Promise<void>
  /** Install an online skill (fetch SKILL.md, add to skills list) */
  installOnlineSkill: (mpSkill: SkillsMPSkill) => Promise<boolean>
  /** Uninstall an online skill (remove from skills list + disk) */
  uninstallOnlineSkill: (id: string, workingDir?: string) => Promise<void>
  /** Clear search results */
  clearSearch: () => void
  /** Load recommended skills from SkillsMP */
  loadRecommended: () => Promise<void>
  /** Install a custom skill from .skill or .zip file */
  installCustomSkill: (filePath: string) => Promise<{ success: boolean; error?: string }>
  /** 发现 .claude/skills/ 标准路径下的技能（全局 + 项目级），slug+source 去重后追加 */
  discoverStandardSkills: (workingDir: string) => Promise<void>
}

const generateSkillId = (mpSkill: SkillsMPSkill): string => {
  return 'online-' + mpSkill.id.replace(/[^a-zA-Z0-9-_]/g, '_')
}

const generateCustomSkillId = (name: string): string => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `skill-${Date.now()}`
  return `custom-${slug}-${Date.now().toString(36)}`
}

const generateSlug = (name: string): string => {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `skill-${Date.now()}`
}

export const useSkillsStore = create<SkillsState>()(
  persist(
    (set, get) => ({
      skills: [],
      sessionSkillIds: [],
      searchResults: [],
      searchLoading: false,
      searchQuery: '',
      searchPage: 1,
      searchTotal: 0,
      searchHasNext: false,
      recommendedSkills: [],
      recommendedLoading: false,

      toggleSessionSkill: async (id: string, workingDir?: string) => {
        const { sessionSkillIds, skills } = get()
        const skill = skills.find((s) => s.id === id)
        if (!skill) return

        const isActive = sessionSkillIds.includes(id)

        if (isActive) {
          // 停用：所有 source 都调 removeSkillDir 清理（global-claude/project-claude
          // 若没写过盘，removeSkillDir 的 fs.existsSync 检查会无害跳过）
          // M11: 先更新 UI，写盘失败则回滚并打印错误
          set({ sessionSkillIds: sessionSkillIds.filter((sid) => sid !== id) })
          if (workingDir) {
            try {
              await ipc.removeSkillDir(workingDir, skill.slug)
            } catch (err) {
              console.error(`[skills-store] removeSkillDir failed for ${skill.slug}:`, err)
              set({ sessionSkillIds: [...get().sessionSkillIds, id] })
            }
          }
        } else {
          set({ sessionSkillIds: [...sessionSkillIds, id] })
          if (workingDir) {
            // 标准路径技能（clerkbox/claude 全局+项目级）不写盘，直接引用原路径
            if (skill.source === 'global-clerkbox' || skill.source === 'project-clerkbox' || skill.source === 'global-claude' || skill.source === 'project-claude') return
            // online/custom 技能写盘完整文件目录（files 空时回退单文件）
            const files = skill.files && skill.files.length > 0
              ? skill.files
              : [{ path: 'SKILL.md', content: skill.skillMdContent }]
            try {
              await ipc.writeSkillDir(workingDir, skill.slug, files)
            } catch (err) {
              console.error(`[skills-store] writeSkillDir failed for ${skill.slug}:`, err)
              set({ sessionSkillIds: get().sessionSkillIds.filter((sid) => sid !== id) })
            }
          }
        }
      },

      setSessionSkills: (ids: string[]) => {
        set({ sessionSkillIds: ids })
      },

      getSessionSkills: () => {
        const { skills, sessionSkillIds } = get()
        return skills.filter((s) => sessionSkillIds.includes(s.id))
      },

      getActiveSkillSlugs: () => {
        const { skills, sessionSkillIds } = get()
        return skills.filter((s) => sessionSkillIds.includes(s.id)).map((s) => s.slug)
      },

      getActiveSkillIndex: () => {
        const { skills, sessionSkillIds } = get()
        return skills
          .filter((s) => sessionSkillIds.includes(s.id))
          .map((s) => ({
            slug: s.slug,
            name: s.name,
            description: s.description,
            triggerKeywords: s.triggerKeywords || [],
            version: s.version || '',
            // global-claude/project-claude 技能用其原绝对路径；online/custom 已写盘用相对路径
            skillMdPath: s.skillMdPath || `.clerkbox/skills/${s.slug}/SKILL.md`,
            chainsTo: s.chainsTo || [],
          }))
      },

      resetSessionSkills: () => {
        set({ sessionSkillIds: [] })
      },

      searchOnlineSkills: async (query: string, page: number = 1) => {
        set({ searchLoading: true, searchQuery: query })
        try {
          const raw = await ipc.skillsSearch(query, page, 20)
          const result: SkillsMPSearchResult = JSON.parse(raw)
          if (result.success && result.data) {
            set({
              searchResults: result.data.skills,
              searchPage: result.data.pagination.page,
              searchTotal: result.data.pagination.total,
              searchHasNext: result.data.pagination.hasNext,
              searchLoading: false,
            })
          } else {
            set({ searchResults: [], searchLoading: false })
          }
        } catch {
          set({ searchResults: [], searchLoading: false })
        }
      },

      installOnlineSkill: async (mpSkill: SkillsMPSkill): Promise<boolean> => {
        const id = generateSkillId(mpSkill)
        const { skills } = get()
        // Already installed?
        if (skills.find((s) => s.id === id)) return true

        try {
          // 优先：整目录拉取（含 SKILL.md 与所有附属文件）
          let files: Array<{ path: string; content: string }> = []
          let warnings: string[] = []
          let skillMdContent = ''

          try {
            const raw = await ipc.fetchSkillFromRepo(mpSkill.githubUrl)
            const result = JSON.parse(raw)
            if (result.success && Array.isArray(result.files) && result.files.length > 0) {
              files = result.files
              warnings = Array.isArray(result.warnings) ? result.warnings : []
              const skillMdFile = files.find((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))
              skillMdContent = skillMdFile ? skillMdFile.content : ''
            }
          } catch {
            // 整目录拉取异常，下面走回退
          }

          // 回退：单文件模式（兼容旧逻辑）
          if (!skillMdContent) {
            const raw = await ipc.fetchSkillMd(mpSkill.githubUrl)
            const result = JSON.parse(raw)
            if (!result.success || !result.content) return false
            skillMdContent = result.content as string
            warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : []
            files = [{ path: 'SKILL.md', content: skillMdContent }]
          }

          // Generate a slug from the skill name
          const slug = mpSkill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `skill-${Date.now()}`

          const newSkill: SkillDefinition = {
            id,
            slug,
            name: mpSkill.name,
            description: (mpSkill.description || '').slice(0, 100),
            icon: '⚡',
            category: 'online',
            source: 'online',
            skillMdContent,
            warnings,
            triggerKeywords: [],
            version: '',
            author: mpSkill.author || '',
            chainsTo: [],
            files,
          }

          set({ skills: [...skills, newSkill] })
          return true
        } catch {
          return false
        }
      },

      uninstallOnlineSkill: async (id: string, workingDir?: string) => {
        const { skills, sessionSkillIds } = get()
        const skill = skills.find((s) => s.id === id)
        if (!skill) return

        // Remove from session if active
        const newSessionIds = sessionSkillIds.filter((sid) => sid !== id)
        // Remove from skills list
        const newSkills = skills.filter((s) => s.id !== id)

        set({ skills: newSkills, sessionSkillIds: newSessionIds })

        // Remove from disk
        if (workingDir) {
          try {
            await ipc.removeSkillDir(workingDir, skill.slug)
          } catch (err) {
            console.error(`[skills-store] uninstall removeSkillDir failed for ${skill.slug}:`, err)
            // Rollback: put skill back into state
            set({ skills: [...get().skills, skill], sessionSkillIds: get().sessionSkillIds })
          }
        }
      },

      clearSearch: () => {
        set({ searchResults: [], searchQuery: '', searchPage: 1, searchTotal: 0, searchHasNext: false })
      },

      installCustomSkill: async (filePath: string) => {
        const result = await ipc.parseSkillFile(filePath)
        if (!result.success || !result.skillMdContent) {
          return { success: false, error: result.error || '解析技能文件失败' }
        }
        const { skills } = get()
        const name = result.name || '自定义技能'
        const id = generateCustomSkillId(name)
        const slug = generateSlug(name)
        // 从 result.files 取文件列表；若 result.files 缺失或空则回退单文件
        const files = result.files && result.files.length > 0
          ? result.files
          : [{ path: 'SKILL.md', content: result.skillMdContent }]
        const newSkill: SkillDefinition = {
          id,
          slug,
          name,
          description: (result.description || '用户自定义技能').slice(0, 100),
          icon: result.icon || '⚡',
          category: (result.category as SkillDefinition['category']) || 'custom',
          source: 'custom',
          skillMdContent: result.skillMdContent,
          triggerKeywords: [],
          version: '',
          author: '',
          chainsTo: [],
          files,
        }
        set({ skills: [...skills, newSkill] })
        return { success: true }
      },

      loadRecommended: async () => {
        set({ recommendedLoading: true })
        try {
          // Search npm registry for popular agent-skills packages
          const queries = ['office', 'design', 'work', 'code']
          const allResults: SkillsMPSkill[] = []
          for (const q of queries) {
            try {
              const raw = await ipc.skillsSearch(q, 1, 6)
              const result: SkillsMPSearchResult = JSON.parse(raw)
              if (result.success && result.data) {
                allResults.push(...result.data.skills)
              }
            } catch { /* skip failed queries */ }
          }
          // Deduplicate by id
          const seen = new Set<string>()
          const deduped = allResults.filter((s) => {
            if (seen.has(s.id)) return false
            seen.add(s.id)
            return true
          })
          // Sort by stars and take top 12
          const sorted = deduped.sort((a, b) => b.stars - a.stars).slice(0, 12)
          set({ recommendedSkills: sorted, recommendedLoading: false })
        } catch {
          set({ recommendedLoading: false })
        }
      },

      discoverStandardSkills: async (workingDir: string) => {
        try {
          const raw = await ipc.scanSkillDirs(workingDir)
          const discovered = JSON.parse(raw) as Array<{
            slug: string
            name: string
            description: string
            icon: string
            category: string
            triggerKeywords: string[]
            version: string
            author: string
            chainsTo: string[]
            source: 'global-clerkbox' | 'project-clerkbox' | 'global-claude' | 'project-claude'
            skillMdPath: string
            skillMdContent: string
            files: Array<{ path: string; content: string }>
          }>
          const { skills } = get()
          // 去重策略：
          //  - clerkbox 路径发现的技能：用 slug 去重（任何 source 已有该 slug 则跳过），
          //    因为 .clerkbox/skills/ 也是 online/custom 技能激活写盘的目录，避免重复发现已安装技能
          //  - claude 兼容路径发现的技能：用 slug+source 去重，保留同名技能在不同路径共存的灵活性
          const existingSlugs = new Set(skills.map((s) => s.slug))
          const existingSlugSource = new Set(skills.map((s) => `${s.slug}:${s.source}`))
          const newSkills: SkillDefinition[] = discovered
            .filter((d) => {
              if (d.source === 'global-clerkbox' || d.source === 'project-clerkbox') {
                // clerkbox 路径：slug 已存在则跳过（避免重复发现写盘的 online/custom 技能）
                return !existingSlugs.has(d.slug)
              }
              // claude 兼容路径：slug+source 去重
              return !existingSlugSource.has(`${d.slug}:${d.source}`)
            })
            .map((d) => ({
              id: `${d.source}-${d.slug}`,
              slug: d.slug,
              name: d.name,
              description: d.description,
              icon: d.icon,
              category: 'custom' as const,
              skillMdContent: d.skillMdContent,
              source: d.source,
              triggerKeywords: d.triggerKeywords,
              version: d.version,
              author: d.author,
              chainsTo: d.chainsTo,
              files: d.files,
              skillMdPath: d.skillMdPath,
            }))
          if (newSkills.length > 0) {
            set({ skills: [...get().skills, ...newSkills] })
          }
        } catch (e) {
          console.error('[skills-store] discoverStandardSkills failed:', e)
        }
      },
    }),
    {
      name: 'clerkbox-skills',
      version: 2,
      migrate: (persisted: any, _version: number) => {
        // Clear old preset skills and stale SkillsMP data
        if (persisted?.skills) {
          persisted.skills = persisted.skills
            .filter((s: any) => s.source !== 'preset')
            // 补齐旧技能缺失的新字段，防止渲染时访问 undefined 崩溃
            .map((s: any) => ({
              ...s,
              triggerKeywords: Array.isArray(s.triggerKeywords) ? s.triggerKeywords : [],
              version: typeof s.version === 'string' ? s.version : '',
              author: typeof s.author === 'string' ? s.author : '',
              chainsTo: Array.isArray(s.chainsTo) ? s.chainsTo : [],
              files: Array.isArray(s.files) ? s.files : (s.skillMdContent ? [{ path: 'SKILL.md', content: s.skillMdContent }] : []),
            }))
        }
        return persisted
      },
      partialize: (state) => ({
        // Persist installed online skills + session skill ids
        skills: state.skills,
        sessionSkillIds: state.sessionSkillIds,
      }),
    }
  )
)
