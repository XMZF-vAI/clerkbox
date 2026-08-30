import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SkillDefinition, SkillsMPSkill, SkillsMPSearchResult } from '../types/skills'
import { ipc } from '../lib/ipc-client'
import { sharedStorage } from '../lib/shared-storage'
import { joinPath } from '../lib/path-safety'
import type { SkillCatalogEntry } from '../lib/skill-catalog'

// slug 级 mutex：同一技能的写盘/删除操作串行执行，防止"停用→快速激活"竞态
// （removeSkillDir 在 writeSkillDir 之后完成导致刚写入的目录被删除）
const skillMutex = new Map<string, Promise<void>>()
const STANDARD_SKILL_SOURCES = new Set([
  'global-clerkbox',
  'project-clerkbox',
  'global-claude',
  'project-claude',
])
let standardSkillDiscoverySequence = 0
function withSkillLock<T>(slug: string, task: () => Promise<T>): Promise<T> {
  const prev = skillMutex.get(slug) ?? Promise.resolve()
  const next = prev.then(task, task) as unknown as Promise<void>
  skillMutex.set(slug, next)
  // Observe both outcomes so cleanup does not create an unhandled rejected promise.
  void next.then(
    () => { if (skillMutex.get(slug) === next) skillMutex.delete(slug) },
    () => { if (skillMutex.get(slug) === next) skillMutex.delete(slug) }
  )
  return next as unknown as Promise<T>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function storedFiles(value: unknown, skillMdContent: unknown): Array<{ path: string; content: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((file) =>
      isRecord(file) && typeof file.path === 'string' && typeof file.content === 'string'
        ? [{ path: file.path, content: file.content }]
        : []
    )
  }
  return typeof skillMdContent === 'string' ? [{ path: 'SKILL.md', content: skillMdContent }] : []
}

interface DiscoveredSkill {
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
}

function isDiscoveredSkill(value: unknown): value is DiscoveredSkill {
  if (!isRecord(value)) return false
  const validFiles = Array.isArray(value.files) && value.files.every(
    (file) => isRecord(file) && typeof file.path === 'string' && typeof file.content === 'string'
  )
  return (
    typeof value.slug === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.icon === 'string' &&
    typeof value.category === 'string' &&
    isStringList(value.triggerKeywords) &&
    typeof value.version === 'string' &&
    typeof value.author === 'string' &&
    isStringList(value.chainsTo) &&
    typeof value.skillMdPath === 'string' &&
    typeof value.skillMdContent === 'string' &&
    validFiles &&
    STANDARD_SKILL_SOURCES.has(value.source as string)
  )
}

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
  /** Sync all enabled user-installed skills to a working directory */
  syncSessionSkills: (workingDir: string) => Promise<void>
  /** Set the full list of session skills */
  setSessionSkills: (ids: string[]) => void
  /** Get all skills enabled for the current session */
  getSessionSkills: () => SkillDefinition[]
  /** Get active skill slugs for system prompt */
  getActiveSkillSlugs: () => string[]
  /** Get the full catalog of installed skills (轻量索引：不含 SKILL.md 正文)，
   *  含未激活技能 —— AI 依据目录自主发现并按需读取（渐进披露第一层） */
  getSkillCatalog: () => SkillCatalogEntry[]
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
  return `custom-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

const generateSlug = (name: string): string => {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `skill-${Date.now()}`
}

/** online/custom 技能的完整文件列表（files 空时回退单文件 SKILL.md） */
function skillFiles(skill: SkillDefinition): Array<{ path: string; content: string }> {
  return skill.files && skill.files.length > 0
    ? skill.files
    : [{ path: 'SKILL.md', content: skill.skillMdContent }]
}

/** 把 online/custom 技能写入全局技能库 ~/.clerkbox/skills/<slug>/。
 *  「已安装 = 磁盘可读」是 AI 自主加载的前提（不依赖用户激活时的项目级写盘）。
 *  幂等：以 store 内容覆盖；失败仅记录（下次发现流程会重试补写）。 */
async function writeGlobalSkillCopy(skill: SkillDefinition): Promise<void> {
  const home = ipc.homeDir()
  if (!home) return
  await withSkillLock(skill.slug, async () => {
    // 写前复查：卸载可能已移除该技能，避免发现流程的兜底写盘把已卸载技能复活回磁盘
    if (!useSkillsStore.getState().skills.some((s) => s.id === skill.id)) return
    try {
      await ipc.writeSkillDir(home, skill.slug, skillFiles(skill))
    } catch (err) {
      console.error(`[skills-store] global skill copy failed for ${skill.slug}:`, err)
    }
  })
}

/** 从全局技能库移除副本（卸载时调用，防止重启后被当作 global-clerkbox 技能重新发现） */
async function removeGlobalSkillCopy(slug: string): Promise<boolean> {
  const home = ipc.homeDir()
  if (!home) return true
  try {
    await withSkillLock(slug, async () => {
      await ipc.removeSkillDir(home, slug)
    })
    return true
  } catch (err) {
    console.error(`[skills-store] global skill removal failed for ${slug}:`, err)
    return false
  }
}

function uniqueSkillSlug(baseSlug: string, skills: SkillDefinition[]): string {
  const existing = new Set(skills.map((skill) => skill.slug.toLowerCase()))
  if (!existing.has(baseSlug.toLowerCase())) return baseSlug

  let suffix = 2
  let candidate = `${baseSlug}-${suffix}`
  while (existing.has(candidate.toLowerCase())) {
    suffix += 1
    candidate = `${baseSlug}-${suffix}`
  }
  return candidate
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
          // 停用：UI 立即更新保证响应性，IO 操作加 slug 级锁串行化防竞态
          set({ sessionSkillIds: sessionSkillIds.filter((sid) => sid !== id) })
          if (workingDir) {
            await withSkillLock(skill.slug, async () => {
              try {
                await ipc.removeSkillDir(workingDir, skill.slug)
              } catch (err) {
                console.error(`[skills-store] removeSkillDir failed for ${skill.slug}:`, err)
                set((state) => ({
                  sessionSkillIds: state.sessionSkillIds.includes(id)
                    ? state.sessionSkillIds
                    : [...state.sessionSkillIds, id],
                }))
              }
            })
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
            await withSkillLock(skill.slug, async () => {
              try {
                await ipc.writeSkillDir(workingDir, skill.slug, files)
              } catch (err) {
                console.error(`[skills-store] writeSkillDir failed for ${skill.slug}:`, err)
                set({ sessionSkillIds: get().sessionSkillIds.filter((sid) => sid !== id) })
              }
            })
          }
        }
      },

      syncSessionSkills: async (workingDir: string) => {
        const activeSkills = get().skills.filter(
          (skill) =>
            get().sessionSkillIds.includes(skill.id) &&
            (skill.source === 'online' || skill.source === 'custom')
        )

        await Promise.all(activeSkills.map(async (skill) => {
          await withSkillLock(skill.slug, async () => {
            const currentSkill = get().skills.find((item) => item.id === skill.id)
            if (!currentSkill || !get().sessionSkillIds.includes(skill.id)) return
            const files = currentSkill.files && currentSkill.files.length > 0
              ? currentSkill.files
              : [{ path: 'SKILL.md', content: currentSkill.skillMdContent }]
            await ipc.writeSkillDir(workingDir, currentSkill.slug, files)
          })
        })).catch((error) => {
          console.error('[skills-store] syncSessionSkills failed:', error)
        })
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

      getSkillCatalog: () => {
        const { skills, sessionSkillIds } = get()
        const home = ipc.homeDir()
        return skills.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          description: s.description,
          triggerKeywords: s.triggerKeywords || [],
          version: s.version || '',
          icon: s.icon || '',
          chainsTo: s.chainsTo || [],
          active: sessionSkillIds.includes(s.id),
          // global/project-clerkbox 与 claude 兼容技能带原绝对路径；
          // online/custom 技能指向全局技能库 ~/.clerkbox/skills/<slug>/SKILL.md（安装即落盘）
          skillMdPath:
            s.skillMdPath ||
            (home
              ? joinPath(home, '.clerkbox', 'skills', s.slug, 'SKILL.md')
              : `.clerkbox/skills/${s.slug}/SKILL.md`),
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
          if (result.success && result.data && Array.isArray(result.data.skills)) {
            // 防御：强制 id 为 string
            const skills = result.data.skills.map((s) => ({ ...s, id: String(s.id) }))
            // page > 1 时追加而非覆盖（支持"加载更多"语义）
            const merged = page > 1 ? [...get().searchResults, ...skills] : skills
            set({
              searchResults: merged,
              searchPage: result.data.pagination.page,
              searchTotal: result.data.pagination.total,
              searchHasNext: result.data.pagination.hasNext,
              searchLoading: false,
            })
          } else {
            console.error('[skills-store] searchOnlineSkills failed:', result)
            set({ searchResults: [], searchPage: 1, searchTotal: 0, searchHasNext: false, searchLoading: false })
          }
        } catch (err) {
          console.error('[skills-store] searchOnlineSkills error:', err)
          set({ searchResults: [], searchPage: 1, searchTotal: 0, searchHasNext: false, searchLoading: false })
        }
      },

      installOnlineSkill: async (mpSkill: SkillsMPSkill): Promise<boolean> => {
        const id = generateSkillId(mpSkill)
        // Already installed?
        if (get().skills.some((skill) => skill.id === id)) return true

        try {
          // 一次性下载 zip + 解压：fetchSkillFromRepo 已包含完整文件列表与 SKILL.md 内容，
          // 不再回退到 fetchSkillMd 重复下载同一 zip 包。
          const raw = await ipc.fetchSkillFromRepo(mpSkill.downloadUrl || mpSkill.githubUrl)
          const result = JSON.parse(raw)
          if (!result.success || !Array.isArray(result.files) || result.files.length === 0) {
            return false
          }
          const files = result.files as Array<{ path: string; content: string }>
          const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : []
          const skillMdFile = files.find((f) => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'))
          if (!skillMdFile) return false
          const skillMdContent = skillMdFile.content

          const newSkill: SkillDefinition = {
            id,
            slug: uniqueSkillSlug(generateSlug(mpSkill.name), get().skills),
            name: mpSkill.titleCn || mpSkill.name,
            description: (mpSkill.description || '').slice(0, 100),
            icon: '',
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
          let added = false
          set((state) => {
            if (state.skills.some((skill) => skill.id === id)) return state
            added = true
            return { skills: [...state.skills, newSkill] }
          })
          // 安装即落盘全局技能库：保证 AI 无需用户激活也能读取（AI 自主加载前提）
          if (added) await writeGlobalSkillCopy(newSkill)
          return true
        } catch {
          return false
        }
      },

      uninstallOnlineSkill: async (id: string, workingDir?: string) => {
        const { skills, sessionSkillIds } = get()
        const skill = skills.find((s) => s.id === id)
        if (!skill) return

        // 先删全局技能库副本（失败则回滚，防止重启后被当作 global-clerkbox 技能重新发现）
        const globalRemoved = await removeGlobalSkillCopy(skill.slug)
        if (!globalRemoved) {
          console.error(`[skills-store] uninstall aborted for ${skill.slug}: global copy removal failed`)
          return
        }

        // Remove from session if active
        const newSessionIds = sessionSkillIds.filter((sid) => sid !== id)
        // Remove from skills list
        const newSkills = skills.filter((s) => s.id !== id)

        set({ skills: newSkills, sessionSkillIds: newSessionIds })

        // Remove from disk (项目级激活副本)
        if (workingDir) {
          try {
            await ipc.removeSkillDir(workingDir, skill.slug)
          } catch (err) {
            console.error(`[skills-store] uninstall removeSkillDir failed for ${skill.slug}:`, err)
            // Rollback: put skill back into state
            set((state) => ({
              skills: state.skills.some((current) => current.id === skill.id)
                ? state.skills
                : [...state.skills, skill],
              sessionSkillIds: state.sessionSkillIds,
            }))
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
        const skillMdContent = result.skillMdContent
        const name = result.name || '自定义技能'
        const id = generateCustomSkillId(name)
        // 从 result.files 取文件列表；若 result.files 缺失或空则回退单文件
        const files = result.files && result.files.length > 0
          ? result.files
          : [{ path: 'SKILL.md', content: skillMdContent }]
        const newSkill: SkillDefinition = {
          id,
          slug: uniqueSkillSlug(generateSlug(name), get().skills),
          name,
          description: (result.description || '用户自定义技能').slice(0, 100),
          icon: result.icon || '',
          category: (result.category as SkillDefinition['category']) || 'custom',
          source: 'custom',
          skillMdContent,
          triggerKeywords: [],
          version: '',
          author: '',
          chainsTo: [],
          files,
        }
        set((state) => ({ skills: [...state.skills, newSkill] }))
        // 安装即落盘全局技能库（同 online 技能）
        await writeGlobalSkillCopy(newSkill)
        return { success: true }
      },

      loadRecommended: async () => {
        set({ recommendedLoading: true })
        try {
          // CocoLoop Hub /search 路由返回 SSR HTML 含 initialItems（热门技能列表）
          const raw = await ipc.skillsSearch('', 1, 12)
          const result: SkillsMPSearchResult = JSON.parse(raw)
          if (result.success && result.data && Array.isArray(result.data.skills)) {
            // 防御：CocoLoop 后端 id 可能为 number，强制转 string 避免 UI 层 .replace 报错
            const skills = result.data.skills.map((s) => ({ ...s, id: String(s.id) }))
            // CocoLoop 已按热度返回，按下载量数值倒序兜底排序
            const sorted = [...skills].sort((a, b) => b.stars - a.stars).slice(0, 12)
            set({ recommendedSkills: sorted, recommendedLoading: false })
          } else {
            console.error('[skills-store] loadRecommended: API returned non-success or empty', result)
            set({ recommendedSkills: [], recommendedLoading: false })
          }
        } catch (err) {
          console.error('[skills-store] loadRecommended failed:', err)
          set({ recommendedSkills: [], recommendedLoading: false })
        }
      },

      discoverStandardSkills: async (workingDir: string) => {
        const requestSequence = ++standardSkillDiscoverySequence
        try {
          const raw = await ipc.scanSkillDirs(workingDir)
          const parsed: unknown = JSON.parse(raw)
          if (!Array.isArray(parsed)) throw new Error('Invalid skill discovery payload')
          if (requestSequence !== standardSkillDiscoverySequence) return

          const discovered = parsed.filter(isDiscoveredSkill)
          const installedSkills = get().skills.filter((skill) => !STANDARD_SKILL_SOURCES.has(skill.source))
          // 去重策略：
          //  - clerkbox 路径发现的技能：用 slug 去重（任何 source 已有该 slug 则跳过），
          //    因为 .clerkbox/skills/ 也是 online/custom 技能激活写盘的目录，避免重复发现已安装技能
          //  - claude 兼容路径发现的技能：用 slug+source 去重，保留同名技能在不同路径共存的灵活性
          const existingSlugs = new Set(installedSkills.map((skill) => skill.slug))
          const existingSlugSource = new Set(installedSkills.map((skill) => `${skill.slug}:${skill.source}`))
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
          const skills = [...installedSkills, ...newSkills]
          set({
            skills,
            sessionSkillIds: get().sessionSkillIds.filter((id) => skills.some((skill) => skill.id === id)),
          })
          // 迁移兜底：早期版本安装的 online/custom 技能可能还没有全局库副本
          // （AI 自主加载依赖「已安装 = 磁盘可读」）。发现流程顺带幂等补写。
          for (const skill of get().skills) {
            if (skill.source === 'online' || skill.source === 'custom') {
              void writeGlobalSkillCopy(skill)
            }
          }
        } catch (e) {
          console.error('[skills-store] discoverStandardSkills failed:', e)
        }
      },
    }),
    {
      name: 'clerkbox-skills',
      storage: sharedStorage,
      version: 2,
      migrate: (persisted: unknown, _version: number): Partial<SkillsState> => {
        const state = isRecord(persisted) ? persisted : {}
        const skills = Array.isArray(state.skills)
          ? state.skills.flatMap((skill) => {
              if (!isRecord(skill) || skill.source === 'preset') return []
              return [{
                ...skill,
                triggerKeywords: stringList(skill.triggerKeywords),
                version: typeof skill.version === 'string' ? skill.version : '',
                author: typeof skill.author === 'string' ? skill.author : '',
                chainsTo: stringList(skill.chainsTo),
                files: storedFiles(skill.files, skill.skillMdContent),
              }]
            })
          : []
        // 显式只保留需要持久化的字段，丢弃可能残留的 recommendedSkills/searchResults 等旧字段，
        // 避免 useEffect 检测到非空 recommendedSkills 而不触发重新加载。
        const sessionSkillIds = Array.isArray(state.sessionSkillIds) ? state.sessionSkillIds : []
        return { skills, sessionSkillIds } as Partial<SkillsState>
      },
      partialize: (state) => ({
        // 仅持久化用户安装的 online/custom 技能 + 会话激活技能 id。
        // 标准路径技能（clerkbox/claude 全局+项目级）不持久化：它们带绝对 skillMdPath，
        // 跨 workingDir 切换后旧路径失效，且 slug 去重会阻塞新目录重新发现。每次启动由 discoverStandardSkills 重新发现。
        skills: state.skills.filter(
          (s) => s.source === 'online' || s.source === 'custom'
        ),
        sessionSkillIds: state.sessionSkillIds,
      }),
    }
  )
)
