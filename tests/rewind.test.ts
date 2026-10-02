/**
 * 撤回/回滚纯逻辑单测（src/lib/rewind.ts）。
 *
 * 这一层钉住的是「会不会删错用户文件」的判定，所以重点全在边界：
 * 折叠取哪一份、指纹不符怎么处理、shell 改动如何把带文件的撤回整体挡掉。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_SNAPSHOT_BYTES,
  byteLength,
  buildRewindNotice,
  buildRewindPlan,
  checkpointRef,
  classifyMutation,
  collectRangeCheckpoints,
  collectRangeToolNames,
  contentFingerprint,
  foldEarliestPerPath,
  gapFromToolCall,
  isRewindableUserMessage,
  isTruncatedRead,
  lastRewindableTurnIndex,
  normalizePathKey,
  rangeAlreadyReverted,
} from '../src/lib/rewind'
import type { FileCheckpoint, Message } from '../src/types/agent'

function user(content: string, id = `u-${content}`): Message {
  return { id, role: 'user', content, timestamp: 1 }
}
function assistant(id: string, toolCalls: Array<{ id: string; name: string }>): Message {
  return { id, role: 'assistant', content: '', timestamp: 1, toolCalls: toolCalls.map((c) => ({ ...c, arguments: {} })) }
}

function cp(overrides: Partial<FileCheckpoint> & { id: string; path: string }): FileCheckpoint {
  return {
    toolCallId: 't1',
    toolName: 'write_file',
    existedBefore: true,
    beforeRef: `${overrides.id}.txt`,
    afterHash: 'AFTER',
    beforeBytes: 10,
    createdAt: 1,
    ...overrides,
  }
}

/** 造一份「磁盘 + 快照」双假文件系统：readFile 与 readSnapshot 都从这两张表里取 */
function makeFs(files: Record<string, string>, snapshots: Record<string, string>) {
  return {
    readFile: async (p: string) => (p in files ? files[p] : null),
    readSnapshot: async (ref: string) => (ref in snapshots ? snapshots[ref] : null),
  }
}

describe('内容指纹与采集分类', () => {
  it('同内容同指纹，改一个字符就不同', () => {
    expect(contentFingerprint('hello\n')).toBe(contentFingerprint('hello\n'))
    expect(contentFingerprint('hello\n')).not.toBe(contentFingerprint('hello\r\n'))
  })

  it('指纹带长度：前缀相同、长度不同的文件不能撞车', () => {
    const a = contentFingerprint('aaa')
    const b = contentFingerprint('aaaa')
    expect(a.split(':')[0]).not.toBe(b.split(':')[0])
  })

  it('byteLength 按 UTF-8 算，中文不是 1 字节', () => {
    expect(byteLength('中文')).toBe(6)
    expect(byteLength('ab')).toBe(2)
  })

  it('识别 readFile 的截断返回（截断串绝不能当成完整旧内容存下来）', () => {
    expect(isTruncatedRead('x\n\n[... 文件过大，已截断，共 12345678 字节 ...]')).toBe(true)
    expect(isTruncatedRead('普通文件内容，含「已截断」三个字也不会误判：没有尾部标记')).toBe(false)
    expect(isTruncatedRead('const a = 1')).toBe(false)
  })

  it('分类：空/不存在不拦，二进制与超限拦，截断优先于体积', () => {
    expect(classifyMutation(null)).toBeNull()
    expect(classifyMutation('')).toBeNull()
    expect(classifyMutation('x\u0000y')).toBe('binary')
    expect(classifyMutation('a'.repeat(MAX_SNAPSHOT_BYTES + 1))).toBe('oversized')
    expect(classifyMutation(`${'a'.repeat(MAX_SNAPSHOT_BYTES + 1)}\n\n[... 文件过大，已截断，共 9 字节 ...]`)).toBe('oversized')
  })

  it('快照引用名固定成 <id>.txt，与 checkpoint-store 的白名单形状一致', () => {
    expect(checkpointRef('ck-abc')).toBe('ck-abc.txt')
  })
})

describe('工具调用 → 无法回滚的改动', () => {
  it('write_file / search_replace 由快照覆盖，不记缺口', () => {
    expect(gapFromToolCall('write_file')).toBeNull()
    expect(gapFromToolCall('search_replace')).toBeNull()
  })

  it('只读工具不记缺口', () => {
    for (const name of ['read_file', 'list_dir', 'search_content', 'web_fetch', 'todowrite', 'spawn_agent']) {
      expect(gapFromToolCall(name)).toBeNull()
    }
  })

  it('shell 类记 shell，MCP 与未知工具记 untracked-tool（默认挡）', () => {
    expect(gapFromToolCall('execute_command')).toEqual({ toolName: 'execute_command', reason: 'shell' })
    expect(gapFromToolCall('mcp__github__edit_file')?.reason).toBe('untracked-tool')
    // 白名单之外一律按不可证明处理：新加工具时不会因为漏登记而骗人
    expect(gapFromToolCall('some_future_tool')?.reason).toBe('untracked-tool')
  })
})

describe('锚点与范围', () => {
  it('合成消息不能当撤回锚点', () => {
    expect(isRewindableUserMessage(user('真话'))).toBe(true)
    expect(isRewindableUserMessage({ ...user('压缩边界'), role: 'system', isCompactSummary: true })).toBe(false)
    expect(isRewindableUserMessage({ ...user('附件恢复'), isCompactAttachment: true })).toBe(false)
    expect(isRewindableUserMessage({ ...user('回执'), isRewindNotice: true })).toBe(false)
    expect(isRewindableUserMessage({ ...user('卡片'), isSubAgentCard: true })).toBe(false)
    expect(isRewindableUserMessage({ ...user('判定'), goalEvent: { verdict: 'achieved', reason: '', evaluations: 1 } })).toBe(false)
    expect(isRewindableUserMessage({ id: 'a', role: 'assistant', content: '', timestamp: 1 })).toBe(false)
  })

  it('最后一轮 = 最后一条真实用户消息，末尾的回执与工具消息不改变判定', () => {
    const messages = [
      user('第一条'),
      assistant('a1', [{ id: 'c', name: 'write_file' }]),
      user('第二条'),
      assistant('a2', []),
      { ...user('回执'), isRewindNotice: true },
    ]
    expect(lastRewindableTurnIndex(messages)).toBe(2)
  })

  it('空会话与全是合成消息时返回 -1', () => {
    expect(lastRewindableTurnIndex([])).toBe(-1)
    expect(lastRewindableTurnIndex([{ ...user('回执'), isRewindNotice: true }])).toBe(-1)
  })

  it('范围收集对整段尾段取并集，不只是锚点那一条', () => {
    const messages = [
      user('上一轮', 'u0'),
      { ...user('本轮', 'u1'), fileCheckpoints: [cp({ id: 'c1', path: 'a.ts' })] },
      { ...assistant('a1', []), fileCheckpoints: [cp({ id: 'c2', path: 'b.ts' })] },
    ]
    expect(collectRangeCheckpoints(messages, 1).map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(collectRangeCheckpoints(messages, 0).map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('路径折叠按创建顺序取最早那份，且分隔符大小写视为同一文件', () => {
    const folded = foldEarliestPerPath([
      cp({ id: 'first', path: 'src/a.ts', beforeBytes: 1 }),
      cp({ id: 'second', path: 'src\\a.ts', beforeBytes: 2 }),
      cp({ id: 'other', path: 'src/B.ts' }),
    ])
    expect(folded.map((f) => f.id)).toEqual(['first', 'other'])
    expect(normalizePathKey('C:\\x\\y\\')).toBe('c:/x/y')
  })

  it('collectRangeToolNames 去重且只看尾段', () => {
    const messages = [
      assistant('a0', [{ id: 'c', name: 'read_file' }]),
      { ...user('本轮', 'u1'), },
      assistant('a1', [{ id: 'c', name: 'execute_command' }, { id: 'd', name: 'execute_command' }]),
    ]
    expect(collectRangeToolNames(messages, 1).sort()).toEqual(['execute_command'])
  })

  it('rangeAlreadyReverted 扫整段尾段而不只是锚点', () => {
    const messages = [user('u'), { ...assistant('a', []), filesReverted: true }]
    expect(rangeAlreadyReverted(messages, 0)).toBe(true)
    expect(rangeAlreadyReverted(messages, 1)).toBe(true)
    expect(rangeAlreadyReverted(messages, 2)).toBe(false)
  })
})

describe('回滚计划', () => {
  const anchor = (checkpoints: FileCheckpoint[], extra: Partial<Message> = {}): Message => ({
    ...user('本轮'),
    fileCheckpoints: checkpoints,
    ...extra,
  })

  it('全部对得上：给出 restore/delete，canApply 为真', async () => {
    const messages = [anchor([
      cp({ id: 'c1', path: '/p/a.ts', existedBefore: true, beforeRef: 'c1.txt', afterHash: contentFingerprint('newA') }),
      cp({ id: 'c2', path: '/p/b.ts', existedBefore: false, beforeRef: null, afterHash: contentFingerprint('newB') }),
    ])]
    const plan = await buildRewindPlan({
      messages,
      fromIndex: 0,
      scope: 'both',
      ...makeFs({ '/p/a.ts': 'newA', '/p/b.ts': 'newB' }, { 'c1.txt': 'oldA' }),
    })
    expect(plan.canApply).toBe(true)
    expect(plan.safeFiles.map((f) => [f.path, f.action])).toEqual([['/p/a.ts', 'restore'], ['/p/b.ts', 'delete']])
    expect(plan.removedMessages).toBe(1)
  })

  it('文件被用户手改过 → external_modified，整体拒绝', async () => {
    const messages = [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint('newA') })])]
    const plan = await buildRewindPlan({
      messages,
      fromIndex: 0,
      scope: 'both',
      ...makeFs({ '/p/a.ts': '用户自己改的' }, { 'c1.txt': 'oldA' }),
    })
    expect(plan.canApply).toBe(false)
    expect(plan.unsafeFiles[0]?.reason).toBe('external_modified')
    expect(plan.safeFiles).toHaveLength(0)
  })

  it('文件被外部删掉 → 当前指纹是 missing，同样判不符', async () => {
    const messages = [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint('newA') })])]
    const plan = await buildRewindPlan({ messages, fromIndex: 0, scope: 'both', ...makeFs({}, { 'c1.txt': 'oldA' }) })
    expect(plan.unsafeFiles[0]?.reason).toBe('external_modified')
    expect(plan.unsafeFiles[0]?.currentHash).toBe('missing')
  })

  it('快照正文丢了 → missing-snapshot', async () => {
    const messages = [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint('newA') })])]
    const plan = await buildRewindPlan({ messages, fromIndex: 0, scope: 'both', ...makeFs({ '/p/a.ts': 'newA' }, {}) })
    expect(plan.unsafeFiles[0]?.reason).toBe('missing-snapshot')
    expect(plan.canApply).toBe(false)
  })

  it('delete 动作不需要读快照，快照目录空着也能成立', async () => {
    const messages = [anchor([cp({ id: 'c2', path: '/p/b.ts', existedBefore: false, beforeRef: null, afterHash: contentFingerprint('newB') })])]
    const plan = await buildRewindPlan({ messages, fromIndex: 0, scope: 'both', ...makeFs({ '/p/b.ts': 'newB' }, {}) })
    expect(plan.canApply).toBe(true)
    expect(plan.safeFiles[0]?.action).toBe('delete')
  })

  it('本轮跑过 shell → gaps 非空，带文件的撤回整体 fail-closed', async () => {
    const messages = [
      { ...anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint('newA') })]), toolCalls: [{ id: 'x', name: 'execute_command', arguments: {} }] },
    ]
    const plan = await buildRewindPlan({ messages, fromIndex: 0, scope: 'both', ...makeFs({ '/p/a.ts': 'newA' }, { 'c1.txt': 'oldA' }) })
    expect(plan.gaps).toEqual([{ toolName: 'execute_command', reason: 'shell' }])
    expect(plan.canApply).toBe(false)
  })

  it('采集侧记下的 oversized 缺口一并进计划', async () => {
    const messages = [anchor([], { mutationGaps: [{ toolName: 'write_file', path: '/p/big.ts', reason: 'oversized' }] })]
    const plan = await buildRewindPlan({ messages, fromIndex: 0, scope: 'both', ...makeFs({}, {}) })
    expect(plan.gaps).toHaveLength(1)
    expect(plan.canApply).toBe(false)
  })

  it('同一缺口不因来源重复而计两次', async () => {
    const messages = [
      {
        ...anchor([], { mutationGaps: [{ toolName: 'execute_command', reason: 'shell' }] }),
        toolCalls: [{ id: 'x', name: 'execute_command', arguments: {} }],
      },
    ]
    const plan = await buildRewindPlan({ messages, fromIndex: 0, scope: 'both', ...makeFs({}, {}) })
    expect(plan.gaps).toHaveLength(1)
  })

  it('scope=workspace 不删消息，removedMessages 恒为 0', async () => {
    const messages = [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint('newA') })]), user('下一条')]
    const plan = await buildRewindPlan({ messages, fromIndex: 0, scope: 'workspace', ...makeFs({ '/p/a.ts': 'newA' }, { 'c1.txt': 'oldA' }) })
    expect(plan.removedMessages).toBe(0)
    expect(plan.canApply).toBe(true)
  })

  it('超大文件拒绝回滚：当前内容超过上限时标 unreadable 而不是硬写', async () => {
    const huge = 'x'.repeat(9 * 1024 * 1024)
    const messages = [anchor([cp({ id: 'c1', path: '/p/a.ts', afterHash: contentFingerprint(huge) })])]
    const plan = await buildRewindPlan({ messages, fromIndex: 0, scope: 'both', ...makeFs({ '/p/a.ts': huge }, { 'c1.txt': 'oldA' }) })
    expect(plan.unsafeFiles[0]?.reason).toBe('unreadable')
  })
})

describe('只撤文件的上下文回执', () => {
  it('明写「对话历史未被改写」，否则模型会把回滚理解成活儿没干过', () => {
    const text = buildRewindNotice([{ path: '/p/a.ts', action: 'restore' }], 0)
    expect(text).toContain('/p/a.ts')
    expect(text).toContain('RESTORED')
    expect(text).toContain('对话历史没有被这次操作改写')
    expect(text).not.toContain('无法由快照回滚')
  })

  it('删除动作与无法回滚的改动数都如实写进回执', () => {
    const text = buildRewindNotice([{ path: '/p/b.ts', action: 'delete' }], 2)
    expect(text).toContain('DELETED /p/b.ts')
    expect(text).toContain('2')
  })
})
