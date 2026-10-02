/**
 * 采集侧契约单测：写文件工具 → 变更前快照。
 *
 * 钉的是两件容易悄悄断掉的事：
 * 1. write_file / search_replace 把**写盘前的原始字节**交出来（不是归一化后的文本），
 *    否则回滚还原的就是一个被改过行尾/BOM 的赝品。
 * 2. 快照存不下时必须转成一条缺口，而不是静默返回「没有快照」——
 *    静默会让界面以为本轮没动过文件，用户点撤回时文件被留在改动后的状态却毫无提示。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  exists: new Set<string>(),
  put: [] as Array<{ sessionId: string; ref: string; content: string }>,
  removed: [] as string[],
  putThrows: false,
}))

vi.mock('../src/lib/ipc-client', () => ({
  isWebUIMode: false,
  ipc: {
    readFile: async (p: string) => {
      if (!h.files.has(p)) throw new Error(`File not found: ${p}`)
      return h.files.get(p)!
    },
    writeFile: async (p: string, content: string) => {
      h.files.set(p, content)
      h.exists.add(p)
    },
    fileExists: async (p: string) => h.exists.has(p),
    ckptPut: async (sessionId: string, ref: string, content: string) => {
      if (h.putThrows) throw new Error('disk gone')
      h.put.push({ sessionId, ref, content })
    },
    ckptGet: async (_sessionId: string, ref: string) => (ref === 'known.txt' ? 'OLD' : null),
    ckptRemove: async (_sessionId: string, refs: string[]) => { h.removed.push(...refs) },
    ckptRemoveSession: async () => {},
  },
}))

import { saveFileMutation, readSnapshotFile, dropSnapshotFiles } from '../src/lib/checkpoint-recorder'
import { toolRegistry } from '../src/lib/tool-registry'
import { MAX_SNAPSHOT_BYTES, contentFingerprint } from '../src/lib/rewind'
import type { FileCheckpoint, FileMutation } from '../src/types/agent'

const P = 'D:/proj/a.ts'

function mutation(overrides: Partial<FileMutation> = {}): FileMutation {
  return {
    toolCallId: 't1',
    toolName: 'write_file',
    path: P,
    existedBefore: true,
    before: 'OLD',
    after: 'NEW',
    ...overrides,
  }
}

beforeEach(() => {
  h.files = new Map<string, string>()
  h.exists = new Set<string>()
  h.put = []
  h.removed = []
  h.putThrows = false
})

describe('saveFileMutation', () => {
  it('已有文件：正文落盘并换回一条可用的索引，afterHash 与变更后内容一致', async () => {
    const { checkpoint, gap } = await saveFileMutation('s1', mutation())
    expect(gap).toBeNull()
    expect(checkpoint).toMatchObject({
      toolCallId: 't1',
      toolName: 'write_file',
      path: P,
      existedBefore: true,
      beforeBytes: 3,
    })
    expect(checkpoint!.beforeRef).toBe(`${checkpoint!.id}.txt`)
    expect(h.put).toEqual([{ sessionId: 's1', ref: checkpoint!.beforeRef!, content: 'OLD' }])
    // 指纹必须与「执行器算出来的当前内容」同一套算法，否则每次回滚都会误报被外部修改
    expect(checkpoint!.afterHash).toBe(contentFingerprint('NEW'))
  })

  it('本轮新建的文件：不落正文，回滚动作就是删除', async () => {
    const { checkpoint, gap } = await saveFileMutation('s1', mutation({ existedBefore: false, before: null }))
    expect(gap).toBeNull()
    expect(checkpoint!.existedBefore).toBe(false)
    expect(checkpoint!.beforeRef).toBeNull()
    expect(checkpoint!.beforeBytes).toBe(0)
    expect(h.put).toHaveLength(0)
  })

  it('文件存在却读不出正文 → unreadable，绝不能降级成「新建」（回滚会把已存在的文件删掉）', async () => {
    const { checkpoint, gap } = await saveFileMutation('s1', mutation({ before: null }))
    expect(checkpoint).toBeNull()
    expect(gap).toEqual({ toolName: 'write_file', path: P, reason: 'unreadable' })
  })

  it('超限与二进制都不拍快照，各留一条对应原因的缺口', async () => {
    const big = await saveFileMutation('s1', mutation({ before: 'a'.repeat(MAX_SNAPSHOT_BYTES + 1) }))
    expect(big.checkpoint).toBeNull()
    expect(big.gap?.reason).toBe('oversized')

    const bin = await saveFileMutation('s1', mutation({ before: 'x\u0000y' }))
    expect(bin.checkpoint).toBeNull()
    expect(bin.gap?.reason).toBe('binary')
  })

  it('落盘失败只影响回滚能力，不影响这次写入本身（文件已经按模型的意思改好了）', async () => {
    h.putThrows = true
    const { checkpoint, gap } = await saveFileMutation('s1', mutation())
    expect(checkpoint).toBeNull()
    expect(gap?.reason).toBe('unreadable')
  })
})

describe('write_file 工具的采集回调', () => {
  it('覆盖写：交出磁盘上的原始旧内容与新内容', async () => {
    h.files.set(P, 'OLD\r\n')
    h.exists.add(P)
    const seen: FileMutation[] = []
    const out = await toolRegistry.execute('write_file', { path: P, content: 'NEW\n' }, {
      toolCallId: 'call-1',
      recordFileMutation: async (m) => { seen.push(m) },
    })
    expect(out).toContain('File written')
    expect(seen).toHaveLength(1)
    // 原样字节：CRLF 与尾部换行都不许被归一化掉
    expect(seen[0]).toMatchObject({ toolCallId: 'call-1', toolName: 'write_file', existedBefore: true, before: 'OLD\r\n', after: 'NEW\n' })
  })

  it('新建：读不到旧内容且确认不存在，记成 existedBefore=false', async () => {
    const seen: FileMutation[] = []
    const out = await toolRegistry.execute('write_file', { path: 'D:/proj/new.ts', content: 'x' }, {
      toolCallId: 'call-2',
      recordFileMutation: async (m) => { seen.push(m) },
    })
    expect(out).toContain('File created')
    expect(seen[0]).toMatchObject({ existedBefore: false, before: null })
  })

  it('没有回调时行为与改造前一致（不该因为没装配回滚就改变写入结果）', async () => {
    h.files.set(P, 'OLD')
    h.exists.add(P)
    const out = await toolRegistry.execute('write_file', { path: P, content: 'NEW' }, {})
    expect(out).toContain('File written')
    expect(h.files.get(P)).toBe('NEW')
  })

  it('写入失败不拍快照（失败的调用不该留下一份永远用不上的正文）', async () => {
    const out = await toolRegistry.execute('search_replace', { path: 'D:/proj/gone.ts', old_str: 'a', new_str: 'b' }, {
      recordFileMutation: async () => { throw new Error('不该被调用') },
    })
    expect(out).toContain('Error')
  })
})

describe('search_replace 工具的采集回调', () => {
  it('交出的 before 是含 BOM 与原行尾的原始内容，after 是真正写回磁盘的那份', async () => {
    const raw = '\uFEFFline1\r\nline2\r\n'
    h.files.set(P, raw)
    h.exists.add(P)
    const seen: FileMutation[] = []
    const out = await toolRegistry.execute('search_replace', { path: P, old_str: 'line2', new_str: 'lineX' }, {
      toolCallId: 'call-3',
      recordFileMutation: async (m) => { seen.push(m) },
    })
    expect(out).toContain('File edited')
    expect(seen[0]!.before).toBe(raw)
    expect(seen[0]!.after).toBe(h.files.get(P))
    expect(seen[0]!.existedBefore).toBe(true)
    // 行尾与 BOM 在写回时原样保留，所以 after 里仍应看到 CRLF
    expect(seen[0]!.after).toContain('\r\n')
  })
})

describe('快照读回收', () => {
  it('读快照：命中给正文，读不到统一 null（由计划标 missing-snapshot）', async () => {
    expect(await readSnapshotFile('s1', 'known.txt')).toBe('OLD')
    expect(await readSnapshotFile('s1', '')).toBeNull()
    expect(await readSnapshotFile('s1', 'nope.txt')).toBeNull()
  })

  it('回收失败不冒泡：撤回已经成功，不能让一次清理失败把它标成失败', async () => {
    await expect(dropSnapshotFiles('s1', ['a.txt', 'b.txt'])).resolves.toBeUndefined()
    expect(h.removed).toEqual(['a.txt', 'b.txt'])
    await expect(dropSnapshotFiles('s1', [])).resolves.toBeUndefined()
  })
})

/** 类型形状自检：索引结构变了要在这里先炸，而不是在回滚时静默丢字段 */
describe('FileCheckpoint 形状', () => {
  it('每条快照 id 唯一且引用名可由 id 推出', async () => {
    const first = await saveFileMutation('s1', mutation())
    const second = await saveFileMutation('s1', mutation({ path: 'D:/proj/b.ts' }))
    const a = first.checkpoint as FileCheckpoint
    const b = second.checkpoint as FileCheckpoint
    expect(a.id).not.toBe(b.id)
    expect(b.beforeRef).toBe(`${b.id}.txt`)
  })
})
