/**
 * 主进程 Git 服务（编程模式：分支切换 / 变更审查 / 提交图谱）。
 *
 * 设计对齐 ZCode 的 GitCliRepo 思路但不引依赖：
 * - 全部走 spawn 真 git CLI，禁 shell、限超时与输出体积；
 * - status 用 porcelain v2 -z（机器可读、路径无引号歧义），diff 行数用 numstat；
 * - 「变更路径一律相对仓库根」，workDir 是仓库子目录时按前缀过滤出本目录范围的变更；
 * - git stderr 归一成稳定 issue code（UI 按 code 出文案，不拼 raw stderr 做判断）；
 * - porcelain/numstat/装饰器解析与 issue 归一导出为纯函数，tests/git-service.test.ts 直接单测。
 *
 * 远程安全：写操作通道（switch/create/stage/commit/push）全部列入 webui-server.ts 的
 * REMOTE_INVOKE_BLOCKLIST，只读通道（status/diff/branches/graph/identity）也不对
 * WebUI 放行——git 内容等同本机源码，远程视图一律隐藏 Git 面板（workbench tab desktopOnly）。
 */
import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import type {
  GitBranchIssueCode,
  GitBranchListResult,
  GitBranchMutationResult,
  GitCommitGraphCommit,
  GitCommitGraphResult,
  GitCommitRef,
  GitCommitRefKind,
  GitCommitResult,
  GitDiffResult,
  GitDiffSource,
  GitFileChange,
  GitFileKind,
  GitIdentity,
  GitPushResult,
  GitStatusResult,
  GitStatusSummary,
} from '../src/types/ipc'

// ── 执行器 ──

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** 单条 git 命令的默认超时；push 慢走 10 分钟（与 ZCode 同档） */
const GIT_TIMEOUT_MS = 15_000
const GIT_DIFF_TIMEOUT_MS = 20_000
const GIT_ADD_TIMEOUT_MS = 30_000
const GIT_COMMIT_TIMEOUT_MS = 60_000
const GIT_PUSH_TIMEOUT_MS = 600_000

const GIT_OUTPUT_CAP = 512 * 1024
const GIT_PUSH_OUTPUT_CAP = 8 * 1024 * 1024

function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS, maxBuffer = GIT_OUTPUT_CAP): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false
    // core.quotepath=false：非 ASCII 文件名保持原样输出而不是八进制转义
    // GIT_OPTIONAL_LOCKS=0：状态类命令不去抢 index.lock 做后台刷新
    let child
    try {
      child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) })
      return
    }
    let out = ''
    let errText = ''
    let truncated = false
    const timer = setTimeout(() => {
      truncated = true
      child.kill()
    }, timeoutMs)
    const finish = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const note = truncated ? '\n[clerkbox] output truncated (timeout)' : ''
      resolve({ code, stdout: out, stderr: errText + note })
    }
    child.on('error', (err) => {
      errText += String(err)
      finish(-1)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length < maxBuffer) out += chunk.toString('utf-8')
      else truncated = true
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (errText.length < maxBuffer) errText += chunk.toString('utf-8')
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

let gitAvailabilityProbe: Promise<boolean> | null = null

/** 本机是否装有 git：只探测一次，失败/成功都缓存（装 git 不需要重启应用的高频场景） */
function isGitInstalled(): Promise<boolean> {
  if (!gitAvailabilityProbe) {
    gitAvailabilityProbe = new Promise((resolve) => {
      let child
      try {
        child = spawn('git', ['--version'], { windowsHide: true })
      } catch {
        resolve(false)
        return
      }
      const timer = setTimeout(() => {
        child.kill()
        resolve(false)
      }, 5_000)
      child.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })
  }
  return gitAvailabilityProbe
}

// ── 路径与参数安全 ──

function assertAbsDir(workDir: string): void {
  if (!path.isAbsolute(workDir)) throw new Error('workDir must be an absolute path')
}

/** 仓库根相对路径的消毒：拒绝绝对路径与越出仓库根的 ../ 路径（后续喂给 git -- path） */
function assertPathInRoot(root: string, relPath: string): void {
  const abs = path.resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path escapes repository root')
  }
}

async function resolveRepoRoot(workDir: string): Promise<string | null> {
  const res = await runGit(workDir, ['rev-parse', '--show-toplevel'])
  if (res.code !== 0) return null
  const root = res.stdout.trim()
  return root ? path.normalize(root) : null
}

// ── 纯解析函数（导出供单测）──

export interface PorcelainRecord {
  stagedKind: GitFileKind | null
  unstagedKind: GitFileKind | null
  path: string
  origPath?: string
}

export interface PorcelainResult {
  headRefType: 'branch' | 'detached'
  branchName: string | null
  upstreamName: string | null
  ahead: number
  behind: number
  records: PorcelainRecord[]
}

const LETTER_KIND: Record<string, GitFileKind> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  U: 'conflict',
}

/** 解析 `git status --porcelain=v2 --branch -z` 的输出（-z：所有记录 NUL 分隔，rename 双 token） */
export function parsePorcelainV2(stdout: string): PorcelainResult {
  const result: PorcelainResult = {
    headRefType: 'branch',
    branchName: null,
    upstreamName: null,
    ahead: 0,
    behind: 0,
    records: [],
  }
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const rec = tokens[i]
    if (!rec) continue
    if (rec.startsWith('# branch.head ')) {
      const value = rec.slice('# branch.head '.length)
      if (value === '(detached)') {
        result.headRefType = 'detached'
      } else {
        result.branchName = value
      }
      continue
    }
    if (rec.startsWith('# branch.upstream ')) {
      result.upstreamName = rec.slice('# branch.upstream '.length)
      continue
    }
    if (rec.startsWith('# branch.ab ')) {
      // 形如 "+1 -2"
      const m = rec.match(/\+(\d+)\s+-(\d+)/)
      if (m) {
        result.ahead = Number(m[1])
        result.behind = Number(m[2])
      }
      continue
    }
    if (rec.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = rec.split(' ')
      const xy = parts[1] ?? '??'
      const p = parts.slice(8).join(' ')
      pushRecord(result.records, xy[0], xy[1], p)
      continue
    }
    if (rec.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>，下一个 token 是 origPath
      const parts = rec.split(' ')
      const xy = parts[1] ?? '??'
      const p = parts.slice(9).join(' ')
      const orig = tokens[i + 1] ?? ''
      i += 1
      pushRecord(result.records, xy[0], xy[1], p, orig || undefined)
      continue
    }
    if (rec.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> —— 冲突
      const parts = rec.split(' ')
      const p = parts.slice(10).join(' ')
      result.records.push({ stagedKind: 'conflict', unstagedKind: null, path: p })
      continue
    }
    if (rec.startsWith('? ')) {
      result.records.push({ stagedKind: null, unstagedKind: 'untracked', path: rec.slice(2) })
      continue
    }
    // 其余（# 的其它头部、空 token）忽略
  }
  return result
}

function pushRecord(records: PorcelainRecord[], x: string, y: string, p: string, origPath?: string): void {
  const stagedKind = x && x !== '.' ? LETTER_KIND[x] ?? 'modified' : null
  const unstagedKind = y && y !== '.' ? LETTER_KIND[y] ?? 'modified' : null
  records.push({ stagedKind, unstagedKind, path: p, origPath })
}

export interface NumstatEntry {
  added: number | null
  removed: number | null
  origPath?: string
}

/**
 * 解析 `git diff --numstat -z`：记录 NUL 分隔，rename 记录在 path 后紧跟第二个
 * NUL 分隔的 origPath token。用 -z 是为了规避 git 非 -z 输出里
 * `a => b` 缩写记法与「文件名本身就含 =>」之间的歧义。
 */
export function parseNumstat(stdout: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>()
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    const m = token.match(/^(-|\d+)\t(-|\d+)\t(.+)$/s)
    if (!m) continue
    const entry: NumstatEntry = {
      added: m[1] === '-' ? null : Number(m[1]),
      removed: m[2] === '-' ? null : Number(m[2]),
    }
    // rename 记录的第二个 token 是 origPath；普通记录（含二进制 "-\t-\t"）一定是
    // 「数字或 - 开头 + TAB」，不满足该形态的 token 才是 origPath
    const next = tokens[i + 1]
    if (next && !/^(-|\d+)\t/.test(next)) {
      entry.origPath = next
      i += 1
    }
    map.set(m[3], entry)
  }
  return map
}

/** git switch/checkout 的 stderr 归一成稳定 issue code；匹配不上返回 null */
export function mapSwitchIssue(stderr: string): GitBranchIssueCode | null {
  if (/would be overwritten/i.test(stderr)) return 'changes-would-be-overwritten'
  if (/untracked working tree file/i.test(stderr)) return 'changes-would-be-overwritten'
  if (/already used by worktree/i.test(stderr)) return 'branch-in-other-worktree'
  if (/not a git repository/i.test(stderr)) return 'not-a-repository'
  if (/invalid reference|unknown revision|not a valid (branch|object)|does not point to a valid commit/i.test(stderr)) {
    return 'unknown-branch'
  }
  return null
}

/** 解析 `git log --format=...%D` 的装饰器字段（如 "HEAD -> main, origin/main, tag: v1.0"） */
export function parseCommitRefs(decorations: string): GitCommitRef[] {
  const refs: GitCommitRef[] = []
  if (!decorations) return refs
  for (const raw of decorations.split(', ')) {
    const d = raw.trim()
    if (!d) continue
    if (d === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head' })
    } else if (d.startsWith('HEAD -> ')) {
      refs.push({ name: 'HEAD', kind: 'head' })
      refs.push({ name: d.slice('HEAD -> '.length), kind: 'branch' })
    } else if (d.startsWith('tag: ')) {
      refs.push({ name: d.slice('tag: '.length), kind: 'tag' })
    } else {
      const kind: GitCommitRefKind = d.startsWith('origin/') ? 'remote' : 'branch'
      refs.push({ name: d, kind })
    }
  }
  return refs
}

// ── 服务实现 ──

const UNTRACKED_READ_CAP = 1024 * 1024
const DIFF_PATCH_CAP = 200 * 1024

const emptySummary: GitStatusSummary = {
  isGitAvailable: false,
  isRepository: false,
  headRefType: 'branch',
  branchName: null,
  upstreamName: null,
  ahead: 0,
  behind: 0,
  unstagedCount: 0,
  stagedCount: 0,
}

/** status 的 in-flight 去重：分支芯片与审查面板同时挂载时只跑一套 git 命令 */
const statusInFlight = new Map<string, Promise<GitStatusResult>>()

async function countUntrackedLines(root: string, relPath: string): Promise<number | null> {
  try {
    const abs = path.resolve(root, relPath)
    if (!abs.startsWith(root + path.sep) && abs !== root) return null
    const stat = await fs.promises.stat(abs)
    if (!stat.isFile()) return null
    const handle = await fs.promises.open(abs, 'r')
    try {
      const buf = Buffer.alloc(Math.min(stat.size, UNTRACKED_READ_CAP))
      await handle.read(buf, 0, buf.length, 0)
      let lines = 0
      for (const byte of buf) if (byte === 0x0a) lines++
      if (stat.size <= UNTRACKED_READ_CAP && buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines++
      return lines
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function getStatus(workDir: string): Promise<GitStatusResult> {
  const summary: GitStatusSummary = { ...emptySummary, isGitAvailable: await isGitInstalled() }
  if (!summary.isGitAvailable) return { summary, unstaged: [], staged: [] }
  let root: string | null = null
  try {
    assertAbsDir(workDir)
    root = await resolveRepoRoot(workDir)
  } catch {
    return { summary, unstaged: [], staged: [] }
  }
  if (!root) return { summary, unstaged: [], staged: [] }
  summary.isRepository = true

  const [statusRes, unstagedStat, stagedStat] = await Promise.all([
    runGit(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']),
    runGit(root, ['diff', '--numstat', '-z', '--find-renames'], GIT_DIFF_TIMEOUT_MS),
    runGit(root, ['diff', '--cached', '--numstat', '-z', '--find-renames'], GIT_DIFF_TIMEOUT_MS),
  ])
  if (statusRes.code !== 0) {
    summary.isRepository = false
    return { summary, unstaged: [], staged: [] }
  }
  const parsed = parsePorcelainV2(statusRes.stdout)
  summary.headRefType = parsed.headRefType
  summary.branchName = parsed.branchName
  summary.upstreamName = parsed.upstreamName
  summary.ahead = parsed.ahead
  summary.behind = parsed.behind

  const unstagedNumstat = parseNumstat(unstagedStat.stdout)
  const stagedNumstat = parseNumstat(stagedStat.stdout)
  const unstaged: GitFileChange[] = []
  const staged: GitFileChange[] = []

  // workDir 是仓库子目录时只保留该子目录范围的变更（路径仍按仓库根口径返回）
  const scopeRel = path.relative(root, workDir).replace(/\\/g, '/')
  const inScope = (p: string) => !scopeRel || p === scopeRel || p.startsWith(scopeRel + '/')

  for (const rec of parsed.records) {
    if (!inScope(rec.path)) continue
    if (rec.stagedKind) {
      const num = stagedNumstat.get(rec.path)
      staged.push({
        path: rec.path,
        origPath: rec.origPath,
        kind: rec.stagedKind,
        added: num?.added ?? null,
        removed: num?.removed ?? null,
      })
    }
    if (rec.unstagedKind) {
      const num = unstagedNumstat.get(rec.path)
      const change: GitFileChange = {
        path: rec.path,
        origPath: rec.origPath,
        kind: rec.unstagedKind,
        added: num?.added ?? null,
        removed: num?.removed ?? null,
      }
      if (rec.unstagedKind === 'untracked' && change.added === null) {
        change.added = await countUntrackedLines(root, rec.path)
      }
      unstaged.push(change)
    }
  }
  // 章节内按路径排序，列表稳定不跳动
  const byPath = (a: GitFileChange, b: GitFileChange) => a.path.localeCompare(b.path)
  unstaged.sort(byPath)
  staged.sort(byPath)
  summary.unstagedCount = unstaged.length
  summary.stagedCount = staged.length
  return { summary, unstaged, staged }
}

async function buildUntrackedPatch(root: string, relPath: string): Promise<GitDiffResult> {
  try {
    assertPathInRoot(root, relPath)
    const abs = path.resolve(root, relPath)
    const stat = await fs.promises.stat(abs)
    if (stat.size > UNTRACKED_READ_CAP) {
      return { path: relPath, availability: 'unavailable', patch: null }
    }
    const buf = await fs.promises.readFile(abs)
    if (buf.subarray(0, 8192).includes(0)) {
      return { path: relPath, availability: 'binary', patch: null }
    }
    const content = buf.toString('utf-8')
    const lines = content.split('\n')
    // 结尾换行会多出一条空尾巴
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    let patch =
      `diff --git a/${relPath} b/${relPath}\n` +
      'new file mode 100644\n' +
      '--- /dev/null\n' +
      `+++ b/${relPath}\n` +
      `@@ -0,0 +1,${lines.length} @@\n`
    for (const line of lines) patch += `+${line}\n`
    return { path: relPath, availability: 'patch', patch }
  } catch {
    return { path: relPath, availability: 'unavailable', patch: null }
  }
}

async function getDiff(workDir: string, relPath: string, source: GitDiffSource): Promise<GitDiffResult> {
  assertAbsDir(workDir)
  const root = await resolveRepoRoot(workDir)
  if (!root) return { path: relPath, availability: 'unavailable', patch: null }
  assertPathInRoot(root, relPath)
  if (source === 'unstaged') {
    // 未跟踪文件在 diff 里没有输出，单独拼一份全加号 patch
    const ls = await runGit(root, ['ls-files', '--', relPath])
    if (ls.code !== 0 || !ls.stdout.trim()) {
      return buildUntrackedPatch(root, relPath)
    }
  }
  const args =
    source === 'staged'
      ? ['diff', '--cached', '--no-ext-diff', '--no-color', '--find-renames', '--', relPath]
      : ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--', relPath]
  const res = await runGit(root, args, GIT_DIFF_TIMEOUT_MS)
  if (res.code !== 0) return { path: relPath, availability: 'unavailable', patch: null }
  let patch = res.stdout
  if (/^Binary files .* differ$/m.test(patch)) {
    return { path: relPath, availability: 'binary', patch: null }
  }
  if (patch.length > DIFF_PATCH_CAP) {
    patch = patch.slice(0, DIFF_PATCH_CAP) + '\n[clerkbox] diff truncated'
  }
  return { path: relPath, availability: 'patch', patch }
}

async function getBranches(workDir: string): Promise<GitBranchListResult> {
  assertAbsDir(workDir)
  const root = await resolveRepoRoot(workDir)
  const empty: GitBranchListResult = { headRefType: 'branch', currentBranchName: null, branches: [] }
  if (!root) return empty
  const [headRes, refsRes] = await Promise.all([
    runGit(root, ['symbolic-ref', '-q', '--short', 'HEAD']),
    runGit(
      root,
      [
        'for-each-ref',
        'refs/heads',
        '--format=%(refname:short)%09%(upstream:short)%09%(objectname)%09%(committerdate:unix)',
      ],
    ),
  ])
  const currentBranchName = headRes.code === 0 ? headRes.stdout.trim() || null : null
  const branches = []
  for (const line of refsRes.stdout.split('\n')) {
    if (!line) continue
    const [name, upstream, hash, date] = line.split('\t')
    if (!name) continue
    branches.push({
      name,
      isCurrent: currentBranchName === name,
      upstreamName: upstream || null,
      commitHash: hash || null,
      commitTimestampMs: date && /^\d+$/.test(date) ? Number(date) * 1000 : null,
    })
  }
  // 当前分支置顶，其余按最近提交倒序（ZCode 同款排序）
  branches.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    return (b.commitTimestampMs ?? 0) - (a.commitTimestampMs ?? 0)
  })
  return {
    headRefType: currentBranchName ? 'branch' : 'detached',
    currentBranchName,
    branches,
  }
}

async function mutateBranch(
  workDir: string,
  branchName: string,
  action: 'switch' | 'create-and-switch',
): Promise<GitBranchMutationResult> {
  const fail = (issues: GitBranchMutationResult['issues']): GitBranchMutationResult => ({
    ok: false,
    action,
    branchName,
    didChange: false,
    created: false,
    issues,
  })
  assertAbsDir(workDir)
  const root = await resolveRepoRoot(workDir)
  if (!root) {
    return fail([{ code: 'not-a-repository', message: 'not a git repository' }])
  }
  if (!branchName.trim()) {
    return fail([{ code: 'unknown-branch', message: 'empty branch name' }])
  }
  const args =
    action === 'create-and-switch'
      ? ['switch', '--no-guess', '-c', branchName]
      : ['switch', '--no-guess', branchName]
  const res = await runGit(root, args, GIT_ADD_TIMEOUT_MS)
  if (res.code === 0) {
    return { ok: true, action, branchName, didChange: true, created: action === 'create-and-switch', issues: [] }
  }
  const code = mapSwitchIssue(res.stderr) ?? 'unknown-branch'
  const message = (res.stderr || res.stdout).trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'switch failed'
  return fail([{ code, message }])
}

function clampGraphParams(maxCount: number, skip: number): { maxCount: number; skip: number } {
  const mc = Number.isFinite(maxCount) ? Math.min(Math.max(Math.floor(maxCount), 1), 200) : 100
  const sk = Number.isFinite(skip) ? Math.max(Math.floor(skip), 0) : 0
  return { maxCount: mc, skip: sk }
}

async function getCommitGraph(workDir: string, maxCount: number, skip: number): Promise<GitCommitGraphResult> {
  assertAbsDir(workDir)
  const root = await resolveRepoRoot(workDir)
  if (!root) return { commits: [], hasMore: false }
  const params = clampGraphParams(maxCount, skip)
  // 多取一条判断 hasMore；刻意不用 --all，避免把隐藏 ref（如 rewind/checkpoint）卷进图谱
  const res = await runGit(
    root,
    [
      'log',
      '--branches',
      '--tags',
      '--remotes',
      '--date-order',
      '--topo-order',
      `--skip=${params.skip}`,
      `--max-count=${params.maxCount + 1}`,
      '--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D%x1e',
    ],
    GIT_DIFF_TIMEOUT_MS,
  )
  if (res.code !== 0) return { commits: [], hasMore: false }
  const records = res.stdout.split('\x1e').filter((r) => r.trim())
  const commits: GitCommitGraphCommit[] = []
  for (const record of records) {
    const [hash = '', parents = '', author = '', at = '', subject = '', decorations = ''] =
      record.replace(/^\n/, '').split('\x00')
    if (!hash) continue
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      refs: parseCommitRefs(decorations.trim()),
      subject,
      authorName: author || null,
      authoredAtMs: at && /^\d+$/.test(at) ? Number(at) * 1000 : null,
    })
  }
  const hasMore = commits.length > params.maxCount
  return { commits: commits.slice(0, params.maxCount), hasMore }
}

async function stagePaths(workDir: string, paths: string[]): Promise<void> {
  assertAbsDir(workDir)
  const root = await resolveRepoRoot(workDir)
  if (!root) throw new Error('not a git repository')
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : []
  if (list.length === 0) return
  for (const p of list) assertPathInRoot(root, p)
  const res = await runGit(root, ['add', '--', ...list], GIT_ADD_TIMEOUT_MS)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git add failed')
}

async function commit(workDir: string, message: string, paths: string[]): Promise<GitCommitResult> {
  assertAbsDir(workDir)
  const root = await resolveRepoRoot(workDir)
  if (!root) throw new Error('not a git repository')
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : []
  if (!message.trim()) throw new Error('commit message is empty')
  if (list.length > 0) {
    for (const p of list) assertPathInRoot(root, p)
    // 先暂存所选，再 `commit -- paths` 限定提交范围：未选中的已暂存项不会被卷进来
    const addRes = await runGit(root, ['add', '--', ...list], GIT_ADD_TIMEOUT_MS)
    if (addRes.code !== 0) throw new Error(addRes.stderr.trim() || 'git add failed')
  }
  const res = await runGit(root, ['commit', '-m', message, ...(list.length > 0 ? ['--', ...list] : [])], GIT_COMMIT_TIMEOUT_MS)
  if (res.code !== 0) throw new Error(res.stderr.trim().split('\n').slice(-1)[0] || 'git commit failed')
  const hash = await runGit(root, ['rev-parse', 'HEAD'])
  return { commitHash: hash.stdout.trim() }
}

async function push(workDir: string): Promise<GitPushResult> {
  assertAbsDir(workDir)
  const root = await resolveRepoRoot(workDir)
  if (!root) throw new Error('not a git repository')
  const head = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = head.stdout.trim()
  if (!branchName || branchName === 'HEAD') throw new Error('detached HEAD: nothing to push')
  const remoteRes = await runGit(root, ['config', '--get', `branch.${branchName}.remote`])
  let remoteName = remoteRes.stdout.trim()
  let setUpstream = false
  let args: string[]
  if (remoteName) {
    args = ['push']
  } else {
    const remotes = await runGit(root, ['remote'])
    remoteName = remotes.stdout.trim().split('\n')[0] || 'origin'
    args = ['push', '--set-upstream', remoteName, branchName]
    setUpstream = true
  }
  const res = await runGit(root, args, GIT_PUSH_TIMEOUT_MS, GIT_PUSH_OUTPUT_CAP)
  const trackingRes = await runGit(root, ['config', '--get', `branch.${branchName}.merge`])
  let trackingBranchName: string | null = trackingRes.stdout.trim() || null
  if (trackingBranchName) trackingBranchName = trackingBranchName.replace(/^refs\/heads\//, '')
  if (res.code !== 0) {
    const output = (res.stderr || res.stdout).trim().split('\n').slice(-6).join('\n')
    throw new Error(output || 'git push failed')
  }
  const output = (res.stderr || res.stdout).trim().split('\n').slice(-6).join('\n')
  return { branchName, remoteName, setUpstream, trackingBranchName, output }
}

async function getIdentity(workDir: string): Promise<GitIdentity> {
  assertAbsDir(workDir)
  const root = await resolveRepoRoot(workDir)
  if (!root) return { userName: null, userEmail: null }
  const [name, email] = await Promise.all([
    runGit(root, ['config', 'user.name']),
    runGit(root, ['config', 'user.email']),
  ])
  return {
    userName: name.code === 0 ? name.stdout.trim() || null : null,
    userEmail: email.code === 0 ? email.stdout.trim() || null : null,
  }
}

// ── IPC 注册 ──

/**
 * 注册 IPC。宿主模式经 installAgentHostBridge 直调 handlerRegistry（monkey-patch 自动同步）。
 * 十个通道全部不对 WebUI 放行：写通道能改本机仓库与远端，读通道吐本机源码内容，
 * 见 webui-server.ts REMOTE_INVOKE_BLOCKLIST 的 git 段。
 */
export function registerGitIpcHandlers(): void {
  ipcMain.handle('gitGetStatus', (_e, workDir: string) => {
    const key = String(workDir)
    let inflight = statusInFlight.get(key)
    if (!inflight) {
      inflight = getStatus(key).finally(() => statusInFlight.delete(key))
      statusInFlight.set(key, inflight)
    }
    return inflight
  })
  ipcMain.handle('gitGetDiff', (_e, workDir: string, path: string, source: GitDiffSource) =>
    getDiff(String(workDir), String(path), source === 'staged' ? 'staged' : 'unstaged'),
  )
  ipcMain.handle('gitGetBranches', (_e, workDir: string) => getBranches(String(workDir)))
  ipcMain.handle('gitSwitchBranch', (_e, workDir: string, branchName: string) =>
    mutateBranch(String(workDir), String(branchName), 'switch'),
  )
  ipcMain.handle('gitCreateBranchAndSwitch', (_e, workDir: string, branchName: string) =>
    mutateBranch(String(workDir), String(branchName), 'create-and-switch'),
  )
  ipcMain.handle('gitGetCommitGraph', (_e, workDir: string, maxCount: number, skip: number) =>
    getCommitGraph(String(workDir), Number(maxCount), Number(skip)),
  )
  ipcMain.handle('gitStagePaths', (_e, workDir: string, paths: string[]) => stagePaths(String(workDir), paths))
  ipcMain.handle('gitCommit', (_e, workDir: string, message: string, paths: string[]) =>
    commit(String(workDir), String(message), paths),
  )
  ipcMain.handle('gitPush', (_e, workDir: string) => push(String(workDir)))
  ipcMain.handle('gitGetIdentity', (_e, workDir: string) => getIdentity(String(workDir)))
}
