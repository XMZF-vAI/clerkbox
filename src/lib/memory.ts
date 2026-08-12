import type { MemoryEntry, MemoryType } from '../types/agent'
import { ipc } from '../lib/ipc-client'

// 记忆系统常量
export const MAX_MEMORY_LINES = 200
export const MAX_MEMORY_BYTES = 25000
export const MEMORY_DIRNAME = 'memory'
export const ENTRYPOINT_NAME = 'MEMORY.md'
// 全局记忆全量注入 system prompt 的上限：单条 2000 字符，总计 8000 字符
const MAX_INLINE_ENTRY_CHARS = 2000
const MAX_INLINE_TOTAL_CHARS = 8000

// 解析 frontmatter 的 type 字段值，非法/缺失返回 undefined
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (raw === 'user' || raw === 'feedback' || raw === 'project' || raw === 'reference') {
    return raw
  }
  return undefined
}

// 将记忆名称转为文件名安全的 slug
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) {
    return `memory-${Date.now()}`
  }
  return slug
}

// 扫描记忆目录下所有记忆文件
export async function scanMemoryFiles(workingDir: string): Promise<MemoryEntry[]> {
  return ipc.scanMemory(workingDir)
}

// 按关键词或类型检索记忆
export async function searchMemory(
  workingDir: string,
  query?: string,
  type?: string,
): Promise<MemoryEntry[]> {
  return ipc.searchMemoryFiles(workingDir, query, type)
}

// 构建注入 system prompt 的记忆指令字符串
// 全局记忆：完整内容直接注入（无需查工具即可知道用户身份/偏好/反馈）
// 项目级记忆：仅注入 MEMORY.md 索引（内容需用 search_memory 查询，避免 prompt 过大）
export async function buildMemoryPrompt(workingDir: string, homeDir: string): Promise<string> {
  const readProject = workingDir && workingDir !== homeDir
  // 并行：全局记忆条目列表（含完整内容）+ 项目级 MEMORY.md 索引
  const [globalEntries, projectRes] = await Promise.all([
    ipc.scanMemory(homeDir),
    readProject ? ipc.readMemoryIndex(workingDir) : Promise.resolve<{ content: string; wasTruncated: boolean; reason?: string }>({ content: '', wasTruncated: false }),
  ])

  // ── 全局记忆：全量内容注入 ──
  let globalInlineSection = ''
  let globalTruncated = false
  if (globalEntries.length > 0) {
    const parts: string[] = []
    let totalChars = 0
    for (const entry of [...globalEntries].sort((a, b) => a.filename.localeCompare(b.filename))) {
      const typeLabel = entry.type ? `[${entry.type}]` : '[未分类]'
      const header = `### ${typeLabel} ${entry.name || entry.filename}`
      // 单条内容截断
      let body = entry.content
      if (body.length > MAX_INLINE_ENTRY_CHARS) {
        body = body.slice(0, MAX_INLINE_ENTRY_CHARS) + '\n...(内容过长已截断，用 search_memory 查看完整内容)'
      }
      const block = `${header}\n${body}`
      // 总量截断
      if (totalChars + block.length > MAX_INLINE_TOTAL_CHARS) {
        globalTruncated = true
        break
      }
      parts.push(block)
      totalChars += block.length
    }
    globalInlineSection = parts.join('\n\n---\n\n')
  }

  // ── 项目级记忆：仅注入索引 ──
  const projectContent = projectRes.content.trim()

  // 合并展示
  let memorySection: string
  if (globalInlineSection && projectContent) {
    memorySection = `### 🌐 全局记忆（完整内容，跨所有会话共享）\n${globalInlineSection}\n\n### 📁 项目记忆索引（当前工作目录，用 search_memory 查具体内容）\n${projectContent}`
  } else if (globalInlineSection) {
    memorySection = globalInlineSection
  } else if (projectContent) {
    memorySection = projectContent
  } else {
    memorySection = '你的 MEMORY.md 当前为空。保存新记忆后，索引会出现在这里。'
  }

  const sections: string[] = [
    '# 记忆系统',
    '',
    '你有一个持久化的双层文件记忆系统：全局记忆位于 `~/.clerkbox/memory/`（跨所有会话共享，存用户身份/偏好/反馈），项目记忆位于 `<workingDir>/.clerkbox/memory/`（当前工作目录，存项目决策）。直接用 save_memory 工具写入即可，用 scope 参数选择范围。',
    '',
    '**全局记忆的完整内容已直接注入下方 system prompt，你无需调用任何工具即可知道用户身份、偏好和反馈。**项目级记忆仅展示索引，需要具体内容时用 search_memory 查询。',
    '',
    '你应该逐步积累记忆，让未来的对话能完整了解：用户是谁、用户希望如何协作、应避免或重复的行为、用户交给你的工作的上下文。',
    '',
    '如果用户明确要求你记住某事，立即用 save_memory 保存。如果要求忘记，找到并删除相关条目。',
    '',
    '## 记忆类型',
    '',
    '记忆分为四种类型（闭集，不允许其他类型）：',
    '',
    '- **user**：用户的角色、目标、职责、知识。当你了解到用户的角色、偏好、职责或知识时保存。',
    '- **feedback**：用户给你的工作方式指导——包括该避免什么和该继续什么。当用户纠正你的方法（“不要那样”）或确认某个非显然的方法有效时保存。必须包含 **Why**（原因）和 **How to apply**（如何应用）。',
    '- **project**：你了解到的项目进行中的工作、目标、决策、事故等无法从代码或 git 历史派生的信息。当了解到谁在做什么、为什么、何时做时保存。相对日期要转为绝对日期。',
    '- **reference**：外部系统的信息指针。当了解到外部系统的资源及其用途时保存。',
    '',
    '## 什么不该记',
    '',
    '- 代码模式、约定、架构、文件路径、项目结构——这些可以通过读取当前项目状态派生',
    '- git 历史、最近变更——git log / git blame 是权威来源',
    '- 调试解决方案或修复配方——修复在代码里，commit message 有上下文',
    '- 临时任务细节：进行中的工作、临时状态、当前对话上下文',
    '',
    '即使用户明确要求保存，这些排除项也适用。',
    '',
    '## 如何保存记忆',
    '',
    '使用 save_memory 工具保存，参数：name（记忆名称）、type（类型）、description（一行描述）、content（记忆内容）、scope（范围，user=全局默认，project=当前工作目录）。保存后系统会自动在对应范围的 MEMORY.md 索引中添加条目。',
    '',
    '### scope 选择指南（重要）',
    '',
    '**用 user scope（全局，跨所有会话共享）当记忆满足以下任一条件：**',
    '- 描述用户是谁：角色、身份、技能、知识背景（如"用户是前端工程师"、"用户熟悉 React 但不熟 Rust"）',
    '- 描述用户的通用偏好：工作风格、沟通偏好、代码风格（如"用户喜欢简洁回答"、"用户偏好中文注释"）',
    '- 用户对 AI 协作方式的反馈：该避免什么、该继续什么（如"用户要求不要主动重构无关代码"）',
    '- 用户明确要求"记住"且不绑定到某个具体项目的事项',
    '- 通用的外部资源指针：与项目无关的文档、工具、账号（如"用户的 GitHub 用户名是 xxx"）',
    '',
    '**用 project scope（项目级，仅当前工作目录）当记忆满足以下任一条件：**',
    '- 描述当前项目的决策、架构、进度（如"本项目用 Zustand 而非 Redux"、"本次任务目标是重构 auth 模块"）',
    '- 项目特定的约定、配置、依赖版本（如"本项目 Node 版本要求 20+"）',
    '- 项目特定的人员、分工、时间线（如"前端由 A 负责，截止 2026-08"）',
    '- 项目特定的外部资源（如"本项目的 API 文档地址是 xxx"、"本项目的 CI 配置在 .github/workflows/xxx"）',
    '- 记忆只在当前项目目录下有意义，换到其他项目就失效',
    '',
    '**判断口诀**：如果这条记忆换一个项目/工作目录仍然成立 → user scope；如果只在当前项目/工作目录有意义 → project scope。',
    '',
    '- 按主题语义组织记忆，不要按时间顺序',
    '- 更新或删除错误/过时的记忆',
    '- 不要写重复记忆，先检查是否有现有记忆可更新',
    '- feedback/project 类型建议结构：先写规则/事实，然后 **Why:** 行和 **How to apply:** 行',
    '',
    '## 何时访问记忆',
    '',
    '- 全局记忆已直接注入上方，无需查询',
    '- 项目级记忆：当内容看起来相关，或用户引用之前对话的工作时，用 search_memory 查具体内容',
    '- 当用户明确要求检查、回忆或记住时，必须访问记忆',
    '',
    '## 漂移验证',
    '',
    '记忆可能随时间过时。在基于记忆回答或建立假设之前，先读取当前文件/资源状态验证记忆是否仍然正确。如果回忆的记忆与当前信息冲突，信任当前观察到的——并更新或删除过时记忆。',
    '',
    '## 记忆工具',
    '',
    '- **save_memory**：保存新记忆或更新现有记忆（scope 参数选择 user 全局或 project 项目）',
    '- **search_memory**：按关键词或类型检索记忆（同时搜索全局和项目级）',
    '',
    '## 记忆内容',
    '',
    memorySection,
  ]

  // 截断警告
  if (globalTruncated) {
    sections.push('')
    sections.push(
      `> 警告：全局记忆内容过多，仅注入了前 ${MAX_INLINE_TOTAL_CHARS} 字符。剩余记忆用 search_memory 查询。`,
    )
  }
  if (projectRes.wasTruncated) {
    sections.push('')
    sections.push(
      `> 警告：项目级 MEMORY.md 已被截断（${projectRes.reason}）。请精简索引条目，将详情移入 topic 文件。`,
    )
  }

  return sections.join('\n')
}
