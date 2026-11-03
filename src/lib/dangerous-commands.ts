/**
 * 危险命令的 AST 化识别（权限二期，对标 ZCode guarded 的 matchDangerousCommand）。
 *
 * 为什么要 AST：正则识别整条命令行，`echo "rm -rf /"`、`git push origin +feature`
 * 这类要么误报要么漏报。这里把命令行解析成「调用」序列（按 && ; || | & 切开），
 * 每个调用拆出 命令名 / 旗标 / 目标，再按结构化规则判定——命中返回规则 id。
 *
 * 边界（明示不装傻）：
 * - 解析走 shell-quote（处理引号/转义/操作符）；**解析不了 ≠ 安全**——调用方在
 *   parse 抛错时必须回落正则库（fail-safe，见 permission-engine）。
 * - shell-quote 不保留「引号包裹」信息：'-r' 作为文件名字面量会被当旗标——
 *   判定方向是宁可错拦（fail-closed），由用户在审批里放行。
 * - 豁免：`-h` / `--help` / `--dry-run` 在场时该调用跳过（看帮助不是破坏）。
 */
import { parse } from 'shell-quote'

export interface DangerousMatch {
  /** 规则 id（审计与 UI 高亮用） */
  ruleId: string
  /** 命中的那个调用（原始片段） */
  invocation: string
}

/** 解析后的单个调用：env 前缀剥离后的命令名 + 其余词 */
interface Invocation {
  command: string
  words: string[]
  raw: string
}

const EXEMPT_FLAGS = new Set(['-h', '--help', '--dry-run'])

function isOp(token: unknown): token is { op: string } {
  return typeof token === 'object' && token !== null && 'op' in (token as Record<string, unknown>)
}

/** 把 token 流切成调用序列（按 shell 控制操作符切；管道两侧也算独立调用） */
export function splitInvocations(tokens: ReturnType<typeof parse>): Invocation[] {
  const invocations: Invocation[] = []
  let current: string[] = []

  const flush = () => {
    if (current.length === 0) return
    // 剥离 env 前缀（FOO=1 rm -r x → rm -r x）
    let words = current
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1)
    if (words.length > 0) {
      invocations.push({ command: words[0]!, words: words.slice(1), raw: words.join(' ') })
    }
    current = []
  }

  for (const token of tokens) {
    // glob 对象也带 op 字段（op:'glob'），必须先于操作符分支处理——
    // 否则 rm *.log 的裸 glob 目标会被当成操作符丢掉
    if (typeof token === 'object' && token !== null && 'pattern' in (token as Record<string, unknown>)) {
      current.push(String((token as { pattern: unknown }).pattern))
      continue
    }
    if (isOp(token)) {
      // 控制流与管道操作符都切开：rm -rf a | grep x 的 rm 一样要拦
      if (['&&', '||', ';', ';;', '|', '&'].includes(token.op)) flush()
      // 重定向等其余 op 只是边界，不切
      continue
    }
    if (typeof token === 'string') current.push(token)
  }
  flush()
  return invocations
}

/** 旗标集合（把 --flag=value 拆成 --flag；合并 -abc 短旗标簇） */
function flagsOf(words: string[]): Set<string> {
  const flags = new Set<string>()
  for (const w of words) {
    if (!w.startsWith('-') || w === '-') continue
    if (w.startsWith('--')) {
      flags.add(w.split('=')[0]!)
    } else {
      // -rf → -r, -f
      for (const ch of w.slice(1)) flags.add(`-${ch}`)
    }
  }
  return flags
}

const hasHelpExempt = (flags: Set<string>) => ['--help'].some((f) => flags.has(f)) || [...flags].some((f) => EXEMPT_FLAGS.has(f))

/**
 * 结构化危险规则。全部 AST 判定；每条返回 ruleId 或 null。
 * 豁免在 rule 内部各自处理（不是所有规则都该被 --dry-run 豁掉）。
 */
const RULES: Array<{ id: string; match: (inv: Invocation, flags: Set<string>, rawWords: string[]) => boolean }> = [
  {
    // rm -r/-R/--recursive；或带裸 glob 目标（rm *.log 的展开不可预知）
    id: 'rm-recursive-or-glob',
    match: (inv, flags) => {
      if (inv.command !== 'rm') return false
      if (flags.has('-r') || flags.has('-R') || flags.has('--recursive')) return true
      return inv.words.some((w) => !w.startsWith('-') && /[*?[]/.test(w))
    },
  },
  {
    id: 'git-reset-hard',
    match: (inv, flags) => inv.command === 'git' && inv.words[0] === 'reset' && flags.has('--hard'),
  },
  {
    id: 'git-push-force',
    match: (inv, flags) => {
      if (inv.command !== 'git' || inv.words[0] !== 'push') return false
      if (['-f', '--force', '--force-with-lease', '--mirror'].some((f) => flags.has(f))) return true
      // refspec 前导 + 号（git push origin +main）
      return inv.words.some((w) => w.startsWith('+') && w.length > 1)
    },
  },
  {
    id: 'git-clean-force',
    match: (inv, flags) => inv.command === 'git' && inv.words[0] === 'clean' && (flags.has('-f') || flags.has('--force')),
  },
  {
    id: 'find-delete',
    match: (inv) => inv.command === 'find' && inv.words.includes('-delete'),
  },
  {
    id: 'rsync-delete',
    match: (inv, flags) => inv.command === 'rsync' && [...flags].some((f) => f === '--delete' || f.startsWith('--delete-')),
  },
  {
    id: 'disk-wipe',
    // mkfs / dd of=块设备 / format：低频但不可逆的盘级破坏
    match: (inv, flags, rawWords) => {
      if (['mkfs', 'mkfs.ext4', 'mkfs.ntfs', 'format'].includes(inv.command)) return true
      if (inv.command === 'dd' && rawWords.some((w) => /^of=\/dev\//.test(w))) return true
      return false
    },
  },
]

/**
 * 结构化判定一条命令行。返回第一条命中的规则；无命中返回 null。
 * 注意：本函数只做「识别」，不构成第二道权限判定——放行/拦截仍由权限模式决定。
 */
export function matchDangerousCommand(command: string): DangerousMatch | null {
  if (!command || !command.trim()) return null
  let tokens: ReturnType<typeof parse>
  try {
    tokens = parse(command)
  } catch {
    return null // 解析不了由调用方回落正则（本函数不假装能判定）
  }
  for (const inv of splitInvocations(tokens)) {
    const flags = flagsOf(inv.words)
    if (hasHelpExempt(flags)) continue
    for (const rule of RULES) {
      if (rule.match(inv, flags, inv.words)) return { ruleId: rule.id, invocation: inv.raw }
    }
  }
  return null
}
