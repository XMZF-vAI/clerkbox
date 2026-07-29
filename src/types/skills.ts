/**
 * ClerkBox Skill System Types
 * Skills are written as SKILL.md files into .clerkbox/skills/<slug>/
 * AI reads them on-demand based on system prompt instructions
 */

/** 技能包含的单个文件（path 相对技能目录，如 'SKILL.md'、'references/api.md'） */
export interface SkillFile {
  /** 相对技能目录的文件路径，如 'SKILL.md'、'references/api.md' */
  path: string
  /** 文件内容 */
  content: string
}

export interface SkillDefinition {
  /** Unique skill id, e.g. 'pptx', 'browser-automation' */
  id: string
  /** Directory slug for .clerkbox/skills/<slug>/ */
  slug: string
  /** Display name */
  name: string
  /** Short description */
  description: string
  /** Icon emoji */
  icon: string
  /** Category for grouping */
  category: 'document' | 'automation' | 'development' | 'online' | 'custom'
  /** SKILL.md content (frontmatter + body) written to disk when activated */
  skillMdContent: string
  /** Source: preset (built-in), online (downloaded from marketplace), custom (user-defined), or claude-config 引用 */
  source: 'preset' | 'online' | 'custom' | 'global-claude' | 'project-claude'
  /** Validation/installation warnings (e.g. external source review reminder) */
  warnings?: string[]
  /** 触发关键词（来自 frontmatter trigger_keywords，默认空数组） */
  triggerKeywords: string[]
  /** 版本号（来自 frontmatter version，默认空字符串） */
  version: string
  /** 作者（来自 frontmatter author，默认空字符串） */
  author: string
  /** 链式编排后继技能 slug 列表（来自 frontmatter chains_to，默认空数组） */
  chainsTo: string[]
  /** 技能包含的所有文件（含 SKILL.md 与子目录文件）；单文件旧技能可只含一项 {path:'SKILL.md', content: skillMdContent} */
  files: SkillFile[]
  /** 仅 global-claude/project-claude source 使用，指向原 SKILL.md 绝对路径，用于不写盘直接引用 */
  skillMdPath?: string
}

// ── SkillsMP API types ──

export interface SkillsMPSkill {
  id: string
  name: string
  author: string
  description: string
  githubUrl: string
  skillUrl: string
  stars: number
  updatedAt: string
}

export interface SkillsMPSearchResult {
  success: boolean
  data?: {
    skills: SkillsMPSkill[]
    pagination: {
      page: number
      limit: number
      total: number
      totalPages: number
      hasNext: boolean
      hasPrev: boolean
    }
    filters: {
      search: string
      sortBy: string
    }
  }
  meta?: {
    requestId: string
    responseTimeMs: number
  }
  error?: {
    code: string
    message: string
  }
}
