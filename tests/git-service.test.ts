/**
 * git-service 纯解析函数单测：porcelain v2 -z / numstat / rename 记法 /
 * switch stderr → issue code / log 装饰器。git 执行链路本身不在此测（需要真实仓库）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const {
  mapSwitchIssue,
  parseCommitRefs,
  parseNumstat,
  parsePorcelainV2,
} = await import('../electron/git-service')

describe('parsePorcelainV2', () => {
  it('解析分支头与 ahead/behind', () => {
    const out = [
      '# branch.oid 1234567890abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
    ].join('\0') + '\0'
    const parsed = parsePorcelainV2(out)
    expect(parsed.headRefType).toBe('branch')
    expect(parsed.branchName).toBe('main')
    expect(parsed.upstreamName).toBe('origin/main')
    expect(parsed.ahead).toBe(2)
    expect(parsed.behind).toBe(1)
    expect(parsed.records).toHaveLength(0)
  })

  it('detached HEAD 与无 upstream 头', () => {
    const out = ['# branch.oid abc', '# branch.head (detached)'].join('\0') + '\0'
    const parsed = parsePorcelainV2(out)
    expect(parsed.headRefType).toBe('detached')
    expect(parsed.branchName).toBeNull()
    expect(parsed.upstreamName).toBeNull()
  })

  it('1 记录：XY 两档拆进暂存/未暂存，路径含空格不截断', () => {
    const out = [
      '1 M. N... 100644 100644 100644 H H src/staged-only.ts',
      '1 .M N... 100644 100644 100644 H H src/work only.ts',
      '1 .D N... 100644 100644 100644 H H src/deleted.ts',
    ].join('\0') + '\0'
    const parsed = parsePorcelainV2(out)
    expect(parsed.records).toHaveLength(3)
    expect(parsed.records[0]).toMatchObject({ stagedKind: 'modified', unstagedKind: null, path: 'src/staged-only.ts' })
    expect(parsed.records[1]).toMatchObject({ stagedKind: null, unstagedKind: 'modified', path: 'src/work only.ts' })
    expect(parsed.records[2]).toMatchObject({ stagedKind: null, unstagedKind: 'deleted', path: 'src/deleted.ts' })
  })

  it('2 记录：rename 走第二个 token 存 origPath', () => {
    const out =
      ['2 R. N... 100644 100644 100644 abc123 def456 R100 new-name.ts', 'old-name.ts'].join('\0') + '\0'
    const parsed = parsePorcelainV2(out)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0]).toMatchObject({
      stagedKind: 'renamed',
      unstagedKind: null,
      path: 'new-name.ts',
      origPath: 'old-name.ts',
    })
  })

  it('u 记录进冲突档，? 记录进未跟踪档', () => {
    const out = [
      'u AU N... 000000 000000 000000 000000 h1 h2 h3 both-modified.ts',
      '? fresh.txt',
    ].join('\0') + '\0'
    const parsed = parsePorcelainV2(out)
    expect(parsed.records[0]).toMatchObject({ stagedKind: 'conflict', path: 'both-modified.ts' })
    expect(parsed.records[1]).toMatchObject({ unstagedKind: 'untracked', path: 'fresh.txt' })
  })
})

describe('parseNumstat', () => {
  it('普通行与二进制行（-z 记录 NUL 分隔）', () => {
    const map = parseNumstat('12\t3\ta.ts\0-\t-\timg.png\0')
    expect(map.get('a.ts')).toEqual({ added: 12, removed: 3 })
    expect(map.get('img.png')).toEqual({ added: null, removed: null })
  })

  it('rename 记录：path 后跟第二个 token 作 origPath', () => {
    const map = parseNumstat('1\t0\tnew.js\0old.js\0')
    expect(map.get('new.js')).toEqual({ added: 1, removed: 0, origPath: 'old.js' })
    expect(map.has('old.js')).toBe(false)
  })

  it('文件名含 " => " 不再歧义（-z 下的路径原样保留）', () => {
    const map = parseNumstat('5\t2\ta => b 记法说明.md\0')
    expect(map.get('a => b 记法说明.md')).toEqual({ added: 5, removed: 2 })
  })
})

describe('mapSwitchIssue', () => {
  it('本地改动会被覆盖', () => {
    const stderr = 'error: Your local changes to the following files would be overwritten by checkout:\n\tfile.ts'
    expect(mapSwitchIssue(stderr)).toBe('changes-would-be-overwritten')
  })

  it('未跟踪文件会被覆盖', () => {
    expect(mapSwitchIssue('error: The following untracked working tree files would be overwritten by checkout:')).toBe(
      'changes-would-be-overwritten',
    )
  })

  it('分支已被其他 worktree 检出', () => {
    expect(mapSwitchIssue("fatal: 'dev' is already used by worktree at: 'D:/other'")).toBe(
      'branch-in-other-worktree',
    )
  })

  it('无效分支名与非仓库', () => {
    expect(mapSwitchIssue('fatal: invalid reference: no/such')).toBe('unknown-branch')
    expect(mapSwitchIssue('fatal: not a git repository (or any of the parent directories): .git')).toBe(
      'not-a-repository',
    )
  })

  it('无关 stderr 返回 null', () => {
    expect(mapSwitchIssue('Switched to branch main')).toBeNull()
  })
})

describe('parseCommitRefs', () => {
  it('HEAD -> branch、remote、tag 各归其类', () => {
    const refs = parseCommitRefs('HEAD -> main, origin/main, tag: v1.0')
    expect(refs).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'branch' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v1.0', kind: 'tag' },
    ])
  })

  it('空装饰器与裸 HEAD', () => {
    expect(parseCommitRefs('')).toEqual([])
    expect(parseCommitRefs('HEAD, feature-x')).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'feature-x', kind: 'branch' },
    ])
  })
})
