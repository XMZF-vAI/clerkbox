/**
 * ClerkBox Skill System Types
 * Skills are written as SKILL.md files into .clerkbox/skills/<slug>/
 * AI reads them on-demand based on system prompt instructions
 */

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
  /** Source: preset (built-in), online (downloaded from marketplace), or custom (user-defined) */
  source: 'preset' | 'online' | 'custom'
  /** Validation/installation warnings (e.g. external source review reminder) */
  warnings?: string[]
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
