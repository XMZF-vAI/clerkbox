/**
 * Skill catalog rendering for the agent system prompt.
 *
 * 注入「全部已安装技能」的轻量目录（name + description + SKILL.md 路径），
 * 让 AI 无需用户手动激活即可自主发现并按需读取技能（渐进披露第一层）。
 * 预算与降级策略对齐 Claude Code 的 skill listing：
 * 总字符预算 + 单条描述截断 + 三级降级（全量 → 均摊截断 → 只留名字）。
 */

export interface SkillCatalogEntry {
  id: string
  slug: string
  name: string
  description: string
  triggerKeywords: string[]
  version: string
  /** 图标 emoji（UI 芯片展示用，不进提示词） */
  icon: string
  skillMdPath: string
  chainsTo: string[]
  /** 用户本轮显式激活（优先遵循；其余技能 AI 可自主取用） */
  active: boolean
}

/** 目录总字符预算（≈2k token；对齐 Claude Code 的 8000 字符默认预算） */
const CATALOG_CHAR_BUDGET = 8000
/** 单条 description 截断上限（对齐 Claude Code MAX_LISTING_DESC_CHARS=250） */
const MAX_DESC_CHARS = 250
/** 降级到「只留名字」之前，每条 description 至少保留的字符数 */
const MIN_DESC_FLOOR = 24

/** 截断长文本并追加省略号（max ≤0 返回空串；不足 max 原样返回） */
export function trimWithEllipsis(text: string, max: number): string {
  if (max <= 0) return ''
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function renderLine(entry: SkillCatalogEntry, descMax: number): { line: string; descRendered: number } {
  const kw = entry.triggerKeywords.length > 0 ? ` | keywords: ${entry.triggerKeywords.join(', ')}` : ''
  const ver = entry.version ? `@${entry.version}` : ''
  const chain = entry.chainsTo.length > 0 ? ` | chains_to: ${entry.chainsTo.join(', ')}` : ''
  const desc = trimWithEllipsis(entry.description || entry.name, descMax)
  const marker = entry.active ? '⚡ ' : ''
  const line = `- ${marker}\`${entry.slug}\`${ver} → ${entry.skillMdPath} | ${entry.name}: ${desc}${kw}${chain}`
  return { line, descRendered: desc.length }
}

/**
 * 渲染技能目录（三级降级，参考 Claude Code formatCommandsWithinBudget）：
 * 1) 全量 description（每条 ≤250 字符）放得下 → 直接渲染；
 * 2) 超预算 → 剩余空间均摊到各条 description 均匀截断；
 * 3) 仍超 → 只留 `slug → 路径 | name`，再超则按序截断条数并追加省略计数行。
 * 用户激活的技能排最前，各级降级都优先保全它们。
 */
export function renderSkillCatalog(entries: SkillCatalogEntry[]): string {
  if (entries.length === 0) return ''
  // 激活技能排最前，其余保持原顺序
  const ordered = [...entries].sort((a, b) => Number(b.active) - Number(a.active))

  // Tier 1: 全量 description
  let rendered = ordered.map((e) => renderLine(e, MAX_DESC_CHARS))
  let total = rendered.reduce((acc, r) => acc + r.line.length + 1, 0)
  if (total <= CATALOG_CHAR_BUDGET) {
    return rendered.map((r) => r.line).join('\n')
  }

  // Tier 2: 均摊截断。每行固定开销 = 行长 − 实际渲染的 description 长度
  const overheads = rendered.map((r) => r.line.length - r.descRendered)
  const overheadTotal = overheads.reduce((acc, o) => acc + o, 0)
  const descSpace = CATALOG_CHAR_BUDGET - overheadTotal - ordered.length
  const perDesc = Math.floor(descSpace / ordered.length)
  if (perDesc >= MIN_DESC_FLOOR) {
    rendered = ordered.map((e) => renderLine(e, Math.min(MAX_DESC_CHARS, perDesc)))
    return rendered.map((r) => r.line).join('\n')
  }

  // Tier 3: 只留 slug → 路径 | name（去掉描述/关键词/链式字段）
  const skeleton = ordered.map((e) => {
    const marker = e.active ? '⚡ ' : ''
    return `- ${marker}\`${e.slug}\` → ${e.skillMdPath} | ${e.name}`
  })
  const omittedLine = (n: number) =>
    `- … ${n} additional skills omitted from this catalog (display budget reached).`
  // 从尾部逐条丢弃直到放得下；省略提示行本身也计入预算
  let keep = skeleton.length
  while (keep > 0) {
    const omitted = skeleton.length - keep
    const size = skeleton.slice(0, keep).reduce((acc, l) => acc + l.length + 1, 0)
      + (omitted > 0 ? omittedLine(omitted).length + 1 : 0)
    if (size <= CATALOG_CHAR_BUDGET) break
    keep -= 1
  }
  const omitted = skeleton.length - keep
  if (omitted > 0) {
    return [...skeleton.slice(0, keep), omittedLine(omitted)].join('\n')
  }
  return skeleton.join('\n')
}
