/**
 * Per-turn relevant-skill matching（每轮相关技能提醒）。
 *
 * 参考 Claude Code「每轮动态 surface 相关技能」与 Codex 的触发规则：
 * 在用户消息发出时，用技能目录的元数据（trigger_keywords / name / description）
 * 与消息文本做词面重叠匹配，命中者以 <system-reminder> 注入当轮消息层，
 * 提醒模型目录里有可能相关的技能。语义相关性最终仍由模型判断 ——
 * 这里只做程序化兜底，防止「明显匹配的技能被漏掉」。纯函数，不做 IO。
 */
import type { SkillCatalogEntry } from './skill-catalog'
import { trimWithEllipsis } from './skill-catalog'

/** 单轮最多提醒的技能数（防提醒本身膨胀） */
const MAX_HINTS = 3
/** description 词面命中的最低次数（弱信号阈值，避免泛词误报） */
const MIN_DESC_HITS = 2
/** 参与拉丁词匹配的最短词长 */
const MIN_WORD_LEN = 4
/** name 词子串匹配的最短长度（'ppt' 等常见技术缩写为 3 字符） */
const MIN_NAME_WORD_LEN = 3
/** 提醒中单条 description 的截断长度 */
const HINT_DESC_CHARS = 160

/** 高频泛词黑名单：出现在 description 里不代表与任务相关 */
const STOPWORDS = new Set([
  'about', 'after', 'also', 'based', 'before', 'content', 'create', 'creating', 'document',
  'documents', 'file', 'files', 'from', 'generate', 'generating', 'help', 'helps', 'into',
  'make', 'making', 'more', 'need', 'needed', 'other', 'provide', 'provides', 'support',
  'that', 'their', 'them', 'then', 'there', 'these', 'this', 'tool', 'tools', 'used',
  'user', 'users', 'using', 'when', 'with', 'without', 'work', 'working', 'works', 'your',
])

function latinWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z0-9_-]+/g) ?? []
}

function textWordSet(text: string): Set<string> {
  return new Set(latinWords(text).filter((w) => w.length >= MIN_WORD_LEN && !STOPWORDS.has(w)))
}

/** 提取连续 CJK 2-gram（中/日/韩），供中文 description 与中文消息的词面重叠匹配 */
function cjkBigrams(text: string): string[] {
  const runs = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []
  const grams: string[] = []
  for (const run of runs) {
    for (let i = 0; i + 2 <= run.length; i++) grams.push(run.slice(i, i + 2))
  }
  return grams
}

interface ScoredSkill {
  entry: SkillCatalogEntry
  score: number
}

/**
 * 匹配评分：
 * - trigger_keywords 命中（子串，≥2 字符）：每命中 +3（最强信号）；
 * - name 拉丁词以子串命中消息文本（≥3 字符、非泛词）：每命中 +2
 *   （子串而非全等：'pptx' 能命中 '做一份 ppt' 这类缩写输入）；
 * - description 拉丁词/CJK 2-gram 命中：达到 MIN_DESC_HITS 次才计分（每命中 +1）。
 * 已激活技能不参与（它们已在 Active 列表中，无需提醒）。
 */
function scoreEntry(entry: SkillCatalogEntry, text: string, words: Set<string>): number {
  let score = 0
  for (const kw of entry.triggerKeywords) {
    const k = kw.trim().toLowerCase()
    if (k.length >= 2 && text.includes(k)) score += 3
  }
  for (const w of latinWords(entry.name)) {
    if (w.length < MIN_NAME_WORD_LEN || STOPWORDS.has(w)) continue
    // 双向包含：'pptx' 能命中 'make a pptx'（正）也能命中 '做一份 ppt'（反）
    if (text.includes(w) || latinWords(text).some((t) => t.length >= MIN_NAME_WORD_LEN && w.includes(t))) {
      score += 2
    }
  }
  let descHits = 0
  const seen = new Set<string>()
  for (const w of latinWords(entry.description)) {
    if (words.has(w) && !seen.has(w)) {
      seen.add(w)
      descHits += 1
    }
  }
  // CJK 2-gram：description 与中文技能名都参与（'文档处理' 能命中 '帮我处理文档'）
  for (const source of [entry.description, entry.name]) {
    for (const gram of cjkBigrams(source)) {
      if (!seen.has(gram) && text.includes(gram)) {
        seen.add(gram)
        descHits += 1
      }
    }
  }
  if (descHits >= MIN_DESC_HITS) score += descHits
  return score
}

/**
 * 构建当轮的相关技能提醒；无命中返回 null（调用方不注入任何内容）。
 * 提醒文本为提示词层英文，包裹在 <system-reminder> 中且明确「不匹配则忽略」，
 * 误报代价低（模型自行忽略），漏报才是主要风险，因此阈值取宽松档。
 */
export function buildRelevantSkillReminder(userText: string, catalog: SkillCatalogEntry[]): string | null {
  const text = userText.toLowerCase()
  if (!text.trim() || catalog.length === 0) return null
  const words = textWordSet(userText)
  const scored: ScoredSkill[] = []
  for (const entry of catalog) {
    if (entry.active) continue
    const score = scoreEntry(entry, text, words)
    if (score > 0) scored.push({ entry, score })
  }
  if (scored.length === 0) return null
  scored.sort((a, b) => b.score - a.score)
  const lines = scored.slice(0, MAX_HINTS).map(({ entry }) =>
    `- \`${entry.slug}\` → ${entry.skillMdPath} | ${entry.name}: ${trimWithEllipsis(entry.description || entry.name, HINT_DESC_CHARS)}`
  )
  return [
    '<system-reminder>',
    "The following installed skills may be relevant to the user's request. For each one that matches the task, read its SKILL.md (path shown in the skill catalog) before acting on the task. If none actually matches, ignore this reminder and proceed normally.",
    ...lines,
    '</system-reminder>',
  ].join('\n')
}
