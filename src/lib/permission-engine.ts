/**
 * Permission engine — standalone functions (not a React hook)
 * so they can be used inside the agent loop without hook rules.
 *
 * 危险命令识别是**双层**的（权限二期）：
 * 1. AST 层（dangerous-commands.ts）：shell-quote 解析 → 调用序列 → 结构化规则，
 *    能看懂引号/转义/复合命令，命中带规则 id；
 * 2. 正则层（本文件的 DANGEROUS_PATTERNS）：Windows cmdlet、fork bomb、下载即执行
 *    这类不适合词法结构的形态，以及 **解析失败时的兜底网**。
 * 两层取并集——AST 识别不了的形态正则兜着，正则漏掉的结构化形态 AST 捞回来，
 * 任何一层命中都算危险（fail-closed）。
 */
import { matchDangerousCommand } from './dangerous-commands'

const DANGEROUS_PATTERNS = [
  // Destructive filesystem operations
  /rm\s+-rf/i,
  /rmdir\s+\/[sq]/i,
  /del\s+\/[sq]/i,
  /del\s+\/f\s+\/s\s+\/q/i,
  />\s*\/dev\/(null|zero)/i,
  /mkfs/i,
  /dd\s+if/i,
  /format\s+[a-z]:/i,
  // Fork bomb variants
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
  // Piped download-and-execute (any common interpreter)
  /curl[^;&|]*\|.*\b(sh|bash|zsh|python|python3|node|nodejs|perl|ruby|cmd|powershell)\b/i,
  /wget[^;&|]*\|.*\b(sh|bash|zsh|python|python3|node|nodejs|perl|ruby|cmd|powershell)\b/i,
  // Windows dangerous cmdlets / aliases
  /Stop-Computer/i,
  /Restart-Computer/i,
  /Remove-Item\s+.*-(Recurse|recurse|r)\b.*-(Force|force|f)\b/i,
  /ri\s+.*-re\s+-fo/i,
  /Invoke-Expression/i,
  /\biex\s+/i,
  /powershell.*-(enc|encodedcommand|EncodedCommand)/i,
  // System / network manipulation
  /shutdown/i,
  /taskkill\s+.*\/f/i,
  /net\s+(user|localgroup|share|start|stop)/i,
  /reg\s+(add|delete|import|export)/i,
  /sc\s+(create|delete|config)\s+/i,
  // Credential / shadow copies
  /vssadmin\s+delete\s+shadows/i,
  /wbadmin\s+delete\s+catalog/i,
]

/** AST 层命中详情（规则 id + 命中片段）；无命中或解析失败返回 null */
export function analyzeDangerousCommand(command: string) {
  return matchDangerousCommand(command)
}

export function isDangerousCommand(command: string): boolean {
  // AST 层先说「命中」就是命中
  if (matchDangerousCommand(command)) return true
  // AST 层说「无命中」分两种：解析成功且干净（正则仍兜底，形态类规则在 AST 之外）
  // 与解析失败（fail-safe，正则必须兜住）——两层并集，谁命中都算危险
  return DANGEROUS_PATTERNS.some((p) => p.test(command))
}
