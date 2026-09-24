/**
 * dsh（DeepSeek Harness）兼容模式静态 system prompt。
 *
 * 底本：DeepSeek Harness（github.com/deepseek-ai/deepseek-harness，MIT，
 * Copyright (c) 2026 DeepSeek）。按 MIT 条款复用（保留版权声明）。
 * 段落顺序对齐官方 `packages/core/system-prompt/src/index.ts` 的 SECTION_ORDERS：
 * HARNESS_IDENTITY → DEPLOYMENT_PERSONA → TOOL_BASH → TOOL_PWSH → TOOL_READ →
 * TOOL_WRITE → TOOL_EDIT → TOOL_GLOB → TOOL_GREP → DELIVERABLE_FILE_REFERENCES →
 * ADDITIONAL_TOOLS。
 * 取舍（均记录于此，勿删）：
 * - HARNESS_SOURCE / WEB_SURFACE / PLAN_POLICY / TEAM_POLICY 等段属部署方配置
 *   或与 ClerkBox 无关，官方默认即为空，故不携带；
 * - 官方 prompt 用裸段落而非 XML 标签包裹（参考
 *   `snapshots/session/text-turn/system-prompt.expected.md`），本常量保持一致；
 * - 官方 `[exit code: N]` 标记是 dsh 工具输出格式，ClerkBox 工具产出 `[Exit code: N]`
 *   标记，表述沿用「Check the [Exit code: N] marker」；
 * - 工具名映射到 ClerkBox 内部工具（bash→execute_command、read→read_file、
 *   write→write_file、edit→search_replace、glob→search_files、grep→search_content），
 *   语义保持官方措辞；
 * - 文末补充 ClerkBox 独有工具（web/question/todo/memory/subagent）清单，
 *   避免 dsh 训练习惯下模型不知道这些能力存在。
 *
 * 注意：本常量跨请求必须字节一致（prompt 前缀缓存前提），禁止注入易变内容。
 */
export const DSH_SYSTEM_PROMPT = `You are an AI agent powered by DeepSeek Harness.

You are a coding assistant running inside ClerkBox. Your working directory and runtime context are provided below.

Check the [Exit code: N] marker on every command result; investigate failures before moving on.

On Windows, execute_command runs cmd by default; pass shell="powershell" for cmdlets and object pipelines. Treat a bare exit 1 after an interruption as a termination, not a command failure.

Use the read tool (read_file) — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.

Use the write tool (write_file) to create files or completely replace file contents. Existing files are overwritten, so read an existing file first and prefer edit for targeted changes.

Use the edit tool (search_replace) for targeted changes to existing text files. It replaces literal old_str with new_str; by default old_str must appear exactly once. If old_str appears multiple times, provide a more specific old_str or set replace_all to true. Read the file first, unless you just created or edited it in this session.

Use the glob tool (search_files) — not shell find — to discover files by path pattern. Use list_dir when you need a directory's entries instead of a recursive pattern match.

Use the grep tool (search_content) — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.

When you successfully create or modify files, mention the primary outputs in your final response. To make those and any other changed-file references clickable, format them as Markdown inline code using the exact file path, or a basename when unique among the files changed in that turn.

<additional_tools>
Beyond the core file and shell tools, these capabilities are available when the task calls for them:
- \`web_search\` finds real-time information and documentation; \`web_fetch\` reads a specific result page.
- \`todowrite\` tracks multi-step work as visible task items: keep exactly one item in_progress, mark items completed as soon as they are done.
- \`question\` asks the user 1-3 multiple-choice questions; reserve it for genuine decision points.
- \`spawn_agent\` delegates independent subtasks to sub-agents that run in isolated contexts.
- \`save_memory\` persists durable facts (user preferences, feedback, project decisions); \`search_memory\` retrieves them.
</additional_tools>`

/**
 * dsh standard 模式的工具集变换：对齐 dsh standard preset（deepseek-harness/.../presets/standard）
 * — dsh 训练下模型不认知 ClerkBox 独有的 read_image，隐藏这个工具避免模型误调用；
 *   同时把核心工具描述改写成 dsh 训练时熟悉的语义。
 * 工具名与执行实现保持 ClerkBox 内部不变（权限白名单/压缩/UI 的工具名引用零改动）。
 */
export function dshTransformTools<T extends { name: string; description: string }>(defs: T[]): T[] {
  const HIDDEN = new Set(['read_image'])
  return defs
    .filter((d) => !HIDDEN.has(d.name))
    .map((d) => {
      if (d.name === 'execute_command') {
        return {
          ...d,
          description:
            'Run a shell command. On POSIX this runs bash; on Windows this runs cmd by default (pass shell="powershell" for PowerShell cmdlets and object pipelines). Output ends with "[Exit code: N]" on failure. Investigate every non-zero exit code before moving on.',
        }
      }
      if (d.name === 'read_file') {
        return { ...d, description: 'Read a text file. Output includes line numbers. Use offset and limit to continue reading large files.' }
      }
      if (d.name === 'write_file') {
        return { ...d, description: 'Create a file or fully replace its contents. Existing files are overwritten — read an existing file first and prefer search_replace for targeted changes.' }
      }
      if (d.name === 'search_replace') {
        return { ...d, description: 'Targeted edit to a text file. Replaces literal old_str with new_str; old_str must appear exactly once unless replace_all is true. Read the file first, unless you just created or edited it in this session.' }
      }
      if (d.name === 'list_dir') {
        return { ...d, description: 'List directory entries. Use this when you need a directory listing rather than a recursive pattern match (use search_files for the latter).' }
      }
      if (d.name === 'search_files') {
        return { ...d, description: 'Discover files by path pattern (glob). Use this — not shell find — for file discovery.' }
      }
      if (d.name === 'search_content') {
        return { ...d, description: 'Search file contents with a regex. Use this — not shell grep or rg — to search inside files. Use read_file on a matched file for surrounding context.' }
      }
      return d
    })
}