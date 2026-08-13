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
  /** Source: online(在线安装) | custom(本地导入) | global-clerkbox(~/.clerkbox/skills/) | project-clerkbox(<proj>/.clerkbox/skills/) | global-claude(~/.claude/skills/ 兼容) | project-claude(<proj>/.claude/skills/ 兼容) */
  source: 'preset' | 'online' | 'custom' | 'global-clerkbox' | 'project-clerkbox' | 'global-claude' | 'project-claude'
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

// ── CocoLoop Hub API types ──
// 数据源：hub.cocoloop.cn（SSR 抓取 RSC initialItems 数组）

export interface SkillsMPSkill {
  /** CocoLoop 数字 ID（如 "1155"） */
  id: string
  /** 显示标题（title） */
  name: string
  /** 中文标题（titleCn），可能为空 */
  titleCn?: string
  /** 作者（creator） */
  author: string
  /** 作者 slug（creatorSlug） */
  creatorSlug?: string
  /** 描述 */
  description: string
  /** CocoLoop 详情页 URL：https://hub.cocoloop.cn/skills/{id} */
  skillUrl: string
  /** 直链下载 URL：https://dl.cocoloop.cn/bss/skills/{author}-{name}-{version}.zip */
  downloadUrl: string
  /** emoji 图标 */
  emoji?: string
  /** BSS 安全等级：S+ / S / A / B / C / D */
  bssLevel?: string
  /** 下载量文本（如 "419.8k"） */
  downloads?: string
  /** 收藏量文本（如 "1922k"） */
  favorites?: string
  /** 安装量文本（如 "3.4k"） */
  installs?: string
  /** 推荐度文本（如 "0%推荐"） */
  recommend?: string
  /** 兼容旧字段：等于 downloadUrl */
  githubUrl: string
  /** 兼容旧字段：下载量数值（解析失败为 0） */
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
