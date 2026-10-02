/**
 * 回滚执行器单测（src/lib/rewind-service.ts）。
 *
 * 只注入一个假 io，就能把「顺序不变式」钉死：
 * 先读全快照再动盘、写失败逆序补偿、文件事务成功之后才提交对话截断、
 * 抢占不到运行中的会话就整体不动。这四条是这套功能唯一会伤到用户数据的地方。
 */
import { describe, expect, it } from 'vitest'
import { executeRewind, type RewindIo } from '../src/lib/rewind-service'
import { contentFingerprint } from '../src/lib/rewind'
import type { FileCheckpoint, Message } from '../src/types/agent'

function anchor(checkpoints: FileCheckpoint[], extra: Partial<Message> = {}): Message {
  return { id: 'u1', role: 'user', content: '本轮', timestamp: 1, fileCheckpoints: checkpoints, ...extra }
}

function cp(overrides: Partial<FileCheckpoint> & { id: string; path: string }): FileCheckpoint {
  return {
    toolCallId: 't1',
    toolName: 'write_file',
    existedBefore: true,
    beforeRef: `${overrides.id}.txt`,
    afterHash: contentFingerprint('after'),
    beforeBytes: 4,
    createdAt: 1,
    ...overrides,
  }
}

interface FakeOptions {
  files?: Record<string, string | null>
  snapshots?: Record<string, string | null>
  /** 第 N 次写盘时抛错（0 基），用于验证 journal 逆序补偿 */
  failOnWrite?: number
  failOnReadSnapshot?: string
  truncateThrows?: boolean
}

function makeIo(options: FakeOptions = {}) {
  const files: Record<string, string | null> = { ...(options.files ?? {}) }
  const snapshots: Record<string, string | null> = { ...(options.snapshots ?? {}) }
  const log: string[] = []
  let writes = 0
  const io: RewindIo & { log: typeof log; files: typeof files; truncated: string[]; reverted: string[]; notices: string[] } = {
    log,
    files,
    truncated: [],
    reverted: [],
    notices: [],
    readFile: async (p) => {
      log.push(`read:${p}`)
      return files[p] ?? null
    },
    writeFile: async (p, content) => {
      log.push(`write:${p}`)
      if (options.failOnWrite === writes) {
        writes += 1
        throw new Error('disk full')
      }
      writes += 1
      files[p] = content
    },
    deleteFile: async (p) => {
      log.push(`delete:${p}`)
      if (options.failOnWrite === writes) {
        writes += 1
        throw new Error('disk full')
      }
      writes += 1
      files[p] = null
    },
    readSnapshot: async (ref) => {
      log.push(`snapshot:${ref}`)
      if (options.failOnReadSnapshot === ref) return null
      return snapshots[ref] ?? null
    },
    dropSnapshots: async (refs) => {
      log.push(`drop:${refs.join(',')}`)
    },
    truncate: async (fromId) => {
      log.push(`truncate:${fromId}`)
      if (options.truncateThrows) throw new Error('db busy')
      io.truncated.push(fromId)
    },
    markReverted: async (id) => {
      io.reverted.push(id)
    },
    addNotice: async (content) => {
      io.notices.push(content)
    },
  }
  return io
}

const AFTER_A = 'A-new'
const AFTER_B = 'B-new'

describe('executeRewind 的受理与拒绝', () => {
  it('锚点不存在或不是真实用户消息时什么都不做', async () => {
    const io = makeIo()
    const outcome = await executeRewind(io, { getMessages: async () => [], anchorMessageId: 'nope', scope: 'both' })
    expect(outcome).toMatchObject({ ok: false, error: 'no-checkpoint', removedMessages: 0 })
    expect(io.log).toEqual([])

    const notice = { id: 'n', role: 'user' as const, content: '回执', timestamp: 1, isRewindNotice: true }
    const blocked = await executeRewind(io, { getMessages: async () => [notice], anchorMessageId: 'n', scope: 'both' })
    expect(blocked.ok).toBe(false)
  })

  it('宿主确认停不下正在跑的会话时整体不动（fail-closed）', async () => {
    const io = makeIo({
      files: { '/p/a.ts': AFTER_A },
      snapshots: { 'c1.txt': 'A-old' },
    })
    const outcome = await executeRewind(io, {
      getMessages: async () => [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) })])],
      anchorMessageId: 'u1',
      scope: 'both',
      abortActiveRun: async () => false,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('session-busy')
    // 抢占是第一步：停不下来就连读都不读，更不写
    expect(io.log).toEqual([])
  })

  it('已经撤销过的轮次不允许再撤一次', async () => {
    const io = makeIo({ files: { '/p/a.ts': 'A-old' }, snapshots: { 'c1.txt': 'A-old' } })
    const messages = [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint('A-old') })], { filesReverted: true })]
    const outcome = await executeRewind(io, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'workspace' })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('no-checkpoint')
    expect(io.log.filter((l) => l.startsWith('write'))).toEqual([])
  })

  it('只撤文件但本轮没有文件改动：不给一个空动作', async () => {
    const io = makeIo()
    const outcome = await executeRewind(io, { getMessages: async () => [anchor([])], anchorMessageId: 'u1', scope: 'workspace' })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('no-checkpoint')
    expect(io.notices).toHaveLength(0)
  })

  it('有文件对不上快照时拒绝带文件回滚，但只撤对话仍然放行', async () => {
    const messages = [
      anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) })]),
      { id: 'a1', role: 'assistant' as const, content: '', timestamp: 1 },
    ]
    const conflicted = makeIo({ files: { '/p/a.ts': '用户自己改的' }, snapshots: { 'c1.txt': 'A-old' } })
    const blocked = await executeRewind(conflicted, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'both' })
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toBe('plan-blocked')
    expect(conflicted.truncated).toEqual([])

    const kept = makeIo({ files: { '/p/a.ts': '用户自己改的' }, snapshots: { 'c1.txt': 'A-old' } })
    const conversationOnly = await executeRewind(kept, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'conversation' })
    expect(conversationOnly.ok).toBe(true)
    expect(conversationOnly.removedMessages).toBe(2)
    expect(kept.truncated).toEqual(['u1'])
    expect(kept.files['/p/a.ts']).toBe('用户自己改的')
  })
})

describe('执行顺序不变式', () => {
  it('scope=both：先把文件写回，再提交对话截断', async () => {
    const io = makeIo({
      files: { '/p/a.ts': AFTER_A, '/p/b.ts': AFTER_B },
      snapshots: { 'c1.txt': 'A-old', 'c2.txt': 'B-old' },
    })
    const messages = [
      anchor([
        cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) }),
        cp({ id: 'c2', path: '/p/b.ts', afterHash: contentFingerprint(AFTER_B) }),
      ]),
    ]
    const outcome = await executeRewind(io, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'both' })
    expect(outcome.ok).toBe(true)
    expect(io.files).toEqual({ '/p/a.ts': 'A-old', '/p/b.ts': 'B-old' })
    // 截断必须在两次写盘之后；顺序错了就会出现「消息没了、文件回了一半」
    expect(io.log.indexOf('truncate:u1')).toBeGreaterThan(io.log.indexOf('write:/p/b.ts'))
    // 消息删掉后快照就是孤儿，必须回收
    expect(io.log).toContain('drop:c1.txt,c2.txt')
  })

  it('任何一份快照读不到都在动盘之前被拒，一个文件都不写', async () => {
    const io = makeIo({
      files: { '/p/a.ts': AFTER_A, '/p/b.ts': AFTER_B },
      snapshots: { 'c1.txt': 'A-old', 'c2.txt': 'B-old' },
      failOnReadSnapshot: 'c2.txt',
    })
    const messages = [
      anchor([
        cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) }),
        cp({ id: 'c2', path: '/p/b.ts', afterHash: contentFingerprint(AFTER_B) }),
      ]),
    ]
    const outcome = await executeRewind(io, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'both' })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('plan-blocked')
    expect(io.log.some((line) => line.startsWith('write:') || line.startsWith('delete:'))).toBe(false)
    expect(io.truncated).toEqual([])
  })

  it('计划与执行只读一次快照：同一份正文不重复动盘', async () => {
    const io = makeIo({
      files: { '/p/a.ts': AFTER_A, '/p/b.ts': AFTER_B },
      snapshots: { 'c1.txt': 'A-old', 'c2.txt': 'B-old' },
    })
    const messages = [
      anchor([
        cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) }),
        cp({ id: 'c2', path: '/p/b.ts', afterHash: contentFingerprint(AFTER_B) }),
      ]),
    ]
    const outcome = await executeRewind(io, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'both' })
    expect(outcome.ok).toBe(true)
    expect(io.log.filter((l) => l === 'snapshot:c1.txt')).toHaveLength(1)
    expect(io.log.filter((l) => l === 'snapshot:c2.txt')).toHaveLength(1)
  })

  it('写到一半失败：按 journal 逆序把已经写的文件还原，且不截断对话', async () => {
    const io = makeIo({
      files: { '/p/a.ts': AFTER_A, '/p/b.ts': AFTER_B },
      snapshots: { 'c1.txt': 'A-old', 'c2.txt': 'B-old' },
      // a.ts 已经写成 A-old，接着恢复 b.ts 时磁盘炸了
      failOnWrite: 1,
    })
    const messages = [
      anchor([
        cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) }),
        cp({ id: 'c2', path: '/p/b.ts', afterHash: contentFingerprint(AFTER_B) }),
      ]),
    ]
    const outcome = await executeRewind(io, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'both' })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('write-failed')
    expect(outcome.compensated).toBe(true)
    // 两个文件都回到执行前的样子：补偿把 a.ts 写回了 AFTER_A
    expect(io.files['/p/a.ts']).toBe(AFTER_A)
    expect(io.files['/p/b.ts']).toBe(AFTER_B)
    expect(io.truncated).toEqual([])
  })

  it('补偿也失败时如实上报 compensated=false，不给一个轻飘飘的失败', async () => {
    const messages = [
      anchor([
        cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) }),
        cp({ id: 'c2', path: '/p/b.ts', afterHash: contentFingerprint(AFTER_B) }),
      ]),
    ]
    let writeCalls = 0
    const io = makeIo({ files: { '/p/a.ts': AFTER_A, '/p/b.ts': AFTER_B }, snapshots: { 'c1.txt': 'A-old', 'c2.txt': 'B-old' } })
    io.writeFile = async () => {
      writeCalls += 1
      // 第 1 次（回滚 a.ts）成功；第 2 次（回滚 b.ts）炸盘；之后的补偿写全部炸
      if (writeCalls === 1) return
      throw new Error('disk gone')
    }
    const outcome = await executeRewind(io, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'both' })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('write-failed')
    // 补偿写不动盘：必须承认 workspace 停在半撤销状态，而不是报一句「已回滚」
    expect(outcome.compensated).toBe(false)
    expect(io.truncated).toEqual([])
  })

  it('文件都写好了但截断失败：明确报 truncate-failed，而不是抛异常或假称成功', async () => {
    const io = makeIo({ files: { '/p/a.ts': AFTER_A }, snapshots: { 'c1.txt': 'A-old' } })
    io.truncate = async () => { throw new Error('db busy') }
    const outcome = await executeRewind(io, {
      getMessages: async () => [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) })])],
      anchorMessageId: 'u1',
      scope: 'both',
    })
    // 截断失败既不抛异常也不报成功：那是「文件回了、消息还在」的半程状态，
    // 必须作为明确的失败结果回到界面，让用户立刻看得见、能重来一次。
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('truncate-failed')
    expect(outcome.restored).toEqual([{ path: '/p/a.ts', action: 'restore' }])
    expect(io.files['/p/a.ts']).toBe('A-old')
  })

  it('抢占之后重读消息：run 收尾时补写的那几条也在截断范围内', async () => {
    const before = [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) })])]
    const afterAbort = [...before, { id: 'a9', role: 'assistant' as const, content: '停之前刚写的收尾', timestamp: 2 }]
    let reads = 0
    const io = makeIo({ files: { '/p/a.ts': AFTER_A }, snapshots: { 'c1.txt': 'A-old' } })
    const outcome = await executeRewind(io, {
      getMessages: async () => {
        reads += 1
        return reads === 1 ? before : afterAbort
      },
      anchorMessageId: 'u1',
      scope: 'both',
      abortActiveRun: async () => true,
    })
    expect(outcome.ok).toBe(true)
    // 第一次读只为确认锚点可撤回，第二次（抢占后）才是截断依据：收尾消息一并被删掉
    expect(reads).toBe(2)
    expect(outcome.removedMessages).toBe(2)
  })
})

describe('三种 scope 的落点', () => {
  const messages = [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) })])]

  it('conversation：只截断，一个文件都不碰', async () => {
    const io = makeIo({ files: { '/p/a.ts': AFTER_A }, snapshots: { 'c1.txt': 'A-old' } })
    const outcome = await executeRewind(io, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'conversation' })
    expect(outcome.ok).toBe(true)
    expect(io.files['/p/a.ts']).toBe(AFTER_A)
    expect(io.truncated).toEqual(['u1'])
    expect(io.notices).toHaveLength(0)
    expect(io.reverted).toEqual([])
  })

  it('workspace：只动文件 + 标记已撤销 + 补一条回执，对话一行不删', async () => {
    const io = makeIo({ files: { '/p/a.ts': AFTER_A }, snapshots: { 'c1.txt': 'A-old' } })
    const outcome = await executeRewind(io, { getMessages: async () => messages, anchorMessageId: 'u1', scope: 'workspace' })
    expect(outcome.ok).toBe(true)
    expect(outcome.removedMessages).toBe(0)
    expect(io.files['/p/a.ts']).toBe('A-old')
    expect(io.truncated).toEqual([])
    expect(io.reverted).toEqual(['u1'])
    expect(io.notices[0]).toContain('RESTORED /p/a.ts')
    // 快照索引必须留着：之后撤回这条消息时还要靠它回收正文
    expect(io.log).not.toContain('drop:c1.txt')
  })

  it('新建的文件在回滚时删掉，删除动作不需要读快照', async () => {
    const io = makeIo({ files: { '/p/new.ts': 'created' } })
    const created = [anchor([cp({ id: 'c9', path: '/p/new.ts', existedBefore: false, beforeRef: null, afterHash: contentFingerprint('created') })])]
    const outcome = await executeRewind(io, { getMessages: async () => created, anchorMessageId: 'u1', scope: 'workspace' })
    expect(outcome.ok).toBe(true)
    expect(io.files['/p/new.ts']).toBeNull()
    expect(io.log).not.toContain('snapshot:')
  })

  it('取消信号在写盘间隙生效：整体按 cancelled 收尾并回补已写的文件', async () => {
    const io = makeIo({
      files: { '/p/a.ts': AFTER_A, '/p/b.ts': AFTER_B },
      snapshots: { 'c1.txt': 'A-old', 'c2.txt': 'B-old' },
    })
    let cancelled = false
    const originalWrite = io.writeFile
    io.writeFile = async (p, c) => {
      await originalWrite(p, c)
      // 第一个文件写完后用户反悔：剩下的一个不许再写，已经写的要回补
      cancelled = true
    }
    const messages = [
      anchor([
        cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(AFTER_A) }),
        cp({ id: 'c2', path: '/p/b.ts', afterHash: contentFingerprint(AFTER_B) }),
      ]),
    ]
    const outcome = await executeRewind(io, {
      getMessages: async () => messages,
      anchorMessageId: 'u1',
      scope: 'workspace',
      isCancelled: () => cancelled,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('cancelled')
    expect(outcome.compensated).toBe(true)
    expect(io.files['/p/a.ts']).toBe(AFTER_A)
    expect(io.files['/p/b.ts']).toBe(AFTER_B)
    expect(io.truncated).toEqual([])
  })
})
