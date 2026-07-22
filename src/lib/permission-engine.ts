/**
 * Permission engine — standalone functions (not a React hook)
 * so they can be used inside the agent loop without hook rules.
 */

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

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command))
}
