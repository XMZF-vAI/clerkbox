/**
 * dsh 极简模式静态 system prompt。
 *
 * 镜像 DeepSeek Harness（MIT, Copyright (c) 2026 DeepSeek）官方
 * `packages/preset/agent-presets/presets/minimal/agent.cordis.yml`：
 * persona 即完整提示词（complete: true），官方原文为
 * "You are a helpful software engineer assistant."，仅保留持久 shell 与
 * str_replace_editor 两个工具，运行时上下文快照全部抑制。
 *
 * 与官方语义的对齐与偏差（均记录于此，勿删）：
 * - 对齐：静态段 = 官方 persona 原文，一字不差；内置工具仅保留
 *   execute_command（shell）+ search_replace（str_replace_editor 对应物），
 *   读文件经 shell、建文件经 shell 重定向——与官方 minimal 一致；
 *   用户配置的 MCP 工具同样不注入（官方 minimal 组合只挂 shell 与编辑器
 *   两个插件，不挂任何 MCP；官方 preset.yml 自述「双工具编码 Agent」）；
 * - 偏差 1：动态段保留「工作目录 + 环境」两小节（官方 bash 自带 cwd 语义，
 *   ClerkBox 的 execute_command 需要模型知道工作目录才能正确操作）；
 * - 偏差 2：AGENTS.md / 记忆 / 技能目录 / .clerkbox 段全部不注入（对齐官方
 *   "complete prompt, nothing added" 语义）；用户显式选择的工作流段（/plan 等）
 *   仍随消息注入（用户主动发起，属会话层而非 harness 层）。
 *
 * 注意：本常量跨请求必须字节一致（prompt 前缀缓存前提），禁止注入易变内容。
 */
export const DSH_MINIMAL_SYSTEM_PROMPT = 'You are a helpful software engineer assistant.'

/**
 * dsh 极简模式的内置工具描述覆盖：官方 minimal 只有 shell + 编辑工具，
 * 默认描述里「优先用 read_file/search_files 等专用工具」的指引在该模式下
 * 不成立（这些工具不存在），故按本模式实际能力重写这两条描述。
 * 其余内置工具被过滤，MCP 工具由 registry 侧原样保留。
 */
export function dshMinimalTransformTools<T extends { name: string; description: string }>(defs: T[]): T[] {
  return defs
    .filter((d) => d.name === 'execute_command' || d.name === 'search_replace')
    .map((d) => {
      if (d.name === 'execute_command') {
        return {
          ...d,
          description:
            'Execute a command in the terminal. This is the only way to read files (cat/type), create files (echo/Set-Content redirection), list directories (dir/ls), and run programs. Windows defaults to cmd.exe (use shell=powershell for PowerShell cmdlets).\n' +
            'Usage:\n' +
            '- Commands time out after 120000 ms by default; pass timeout (ms, max 600000) for long-running commands. On timeout the process tree is killed and the captured output is returned.\n' +
            '- Output over 50000 chars is truncated and the full output is saved to a file whose path is returned.\n' +
            '- cmd notes: quote paths containing spaces with double quotes; chain commands with &&; %% for a literal %. PowerShell notes: URLs containing & must be quoted; use single-quoted strings to avoid $ expansion.',
        }
      }
      if (d.name === 'search_replace') {
        return {
          ...d,
          description:
            'Perform exact string replacement in a file. Supports a single edit (old_str/new_str) or a batch of edits in one call via edits[] (all matched against the same file content and applied atomically — if any edit fails, nothing is written).\n' +
            'Usage:\n' +
            '- There is no dedicated read tool in this mode: inspect a file with a shell command (e.g. cat) before editing, and copy old_str character-for-character from the actual file content, never paraphrased.\n' +
            '- old_str must appear exactly once in the file unless replace_all is true. If it matches multiple locations the tool errors — extend old_str with 2-3 surrounding lines to make it unique.\n' +
            '- new_str replaces old_str (empty string deletes the matched text). new_str must differ from old_str.\n' +
            '- Create new files via shell redirection (e.g. echo > file or Set-Content); this tool cannot create files.',
        }
      }
      return d
    })
}
