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
            try {
              await ipc.writeSkillMd(workingDir, skill.slug, skill.skillMdContent)
            } catch (err) {
              console.error(`[skills-store] writeSkillMd failed for ${skill.slug}:`, err)
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
          // Fetch SKILL.md from GitHub
          const raw = await ipc.fetchSkillMd(mpSkill.githubUrl)
          const result = JSON.parse(raw)
          if (!result.success || !result.content) return false

          const skillMdContent = result.content as string
          const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : []
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
        const newSkill: SkillDefinition = {
          id,
          slug,
          name,
          description: (result.description || '用户自定义技能').slice(0, 100),
          icon: result.icon || '⚡',
          category: (result.category as SkillDefinition['category']) || 'custom',
          source: 'custom',
          skillMdContent: result.skillMdContent,
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
    }),
    {
      name: 'clerkbox-skills',
      version: 2,
      migrate: (persisted: any, _version: number) => {
        // Clear old preset skills and stale SkillsMP data
        if (persisted?.skills) {
          persisted.skills = persisted.skills.filter(
            (s: any) => s.source !== 'preset'
          )
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
