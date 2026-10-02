/**
 * 撤回/回滚的存储层单测：截断原语、消息增量补丁、快照落盘的路径消毒、编解码往返。
 *
 * 这一层出错用户是看不见的，出事却直接表现为「撤错消息」或「把快照写到别人的目录」，
 * 所以两种引擎（SQLite 主路径 + JSON 降级路径）都要各自钉一遍。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))

import { createChatStore } from '../electron/db'
import { CheckpointStore, sanitizeRef, sanitizeSessionId } from '../electron/checkpoint-store'
import { mapMessageRows, messageRewindPatch, messageToRow } from '../src/lib/chat-row'
import type { Message } from '../src/types/agent'

const WASM_PATH = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
const loadWasm = (): Buffer => fs.readFileSync(WASM_PATH)

let workDir: string
let tmpRoot: string

/** 用例开过的库：清理前强制落盘（见下条 afterEach 的说明） */
const opened: Array<{ flush: () => void }> = []

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerkbox-rewind-db-'))
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clerkbox-rewind-ckpt-'))
})

afterEach(() => {
  // 内存库是 300ms 防抖落盘的：不先 flush 就删临时目录，每个用例都会刷一条 ENOENT 假错，
  // 把真正的存储故障埋进噪声里。
  for (const store of opened.splice(0)) store.flush()
  for (const dir of [workDir, tmpRoot]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch { /* Windows 上偶发占用，忽略 */ }
  }
})

type Store = Awaited<ReturnType<typeof createChatStore>>

/** 开库并登记，让 afterEach 能在删目录前把它冲干净 */
async function openStore(options: Parameters<typeof createChatStore>[0]): Promise<Store> {
  const store = await createChatStore(options)
  opened.push(store)
  return store
}

/**
 * 两种引擎各开一份独立库（各自一个 userDataDir）。
 *
 * 必须在测试体内调用而不是 describe 阶段：工作目录是 beforeEach 才建的；
 * 而两份库共用同一目录时，空 wasm 那条路会把已建好的 sqlite 当成「迁移过的库」，
 * 测出来的就不是 JSON 引擎了。
 */
async function bothEngines(): Promise<Array<{ kind: string; store: Store }>> {
  const sqliteDir = path.join(workDir, 'sqlite')
  const jsonDir = path.join(workDir, 'json')
  // 引擎不会自己建 userDataDir（生产里它由 Electron 保证存在），测试要自己建出来
  fs.mkdirSync(sqliteDir, { recursive: true })
  fs.mkdirSync(jsonDir, { recursive: true })
  const sqlite = await openStore({ userDataDir: sqliteDir, wasmBinary: loadWasm() })
  const json = await openStore({ userDataDir: jsonDir, wasmBinary: Buffer.alloc(0) })
  expect(json.kind).toBe('json')
  return [{ kind: 'sqlite', store: sqlite }, { kind: 'json', store: json }]
}

describe('deleteMessagesFrom：截断到点（删除锚点及其之后）', () => {
  it('两种引擎都与 deleteMessagesBefore 方向相反，锚点自身也被删', async () => {
    for (const { store } of await bothEngines()) {
      for (const [index, id] of ['q1', 'a1', 'q2', 'a2'].entries()) {
        await store.addMessage({ id, session_id: 'd', role: id.startsWith('q') ? 'user' : 'assistant', content: id, timestamp: index + 1 })
      }
      await store.deleteMessagesFrom('d', 'q2')
      expect((await store.getMessages('d')).map((m) => m.id)).toEqual(['q1', 'a1'])
    }
  })

  it('两种引擎：fromId 不存在时不写任何一行、不涨修订号', async () => {
    for (const { store } of await bothEngines()) {
      await store.addMessage({ id: 'q1', session_id: 'd', role: 'user', content: 'q1', timestamp: 1 })
      const rev = await store.getRevision()
      await store.deleteMessagesFrom('d', 'nope')
      expect((await store.getMessages('d')).map((m) => m.id)).toEqual(['q1'])
      expect(await store.getRevision()).toBe(rev)
    }
  })

  it('两种引擎：只截本会话，别的会话一条不动', async () => {
    for (const { store } of await bothEngines()) {
      await store.addMessage({ id: 'x1', session_id: 'd', role: 'user', content: 'x1', timestamp: 1 })
      await store.addMessage({ id: 'y1', session_id: 'other', role: 'user', content: 'y1', timestamp: 1 })
      await store.deleteMessagesFrom('d', 'x1')
      expect(await store.getMessages('d')).toHaveLength(0)
      expect(await store.getMessages('other')).toHaveLength(1)
    }
  })

  it('按插入序而不是时间戳截断', async () => {
    const orderDir = path.join(workDir, 'order')
    fs.mkdirSync(orderDir, { recursive: true })
    const store = await openStore({ userDataDir: orderDir, wasmBinary: loadWasm() })
    // 时间戳倒着写：插入序才是对话序，按 timestamp 排会把分支截错
    await store.addMessage({ id: 'first', session_id: 'ts', role: 'user', content: 'a', timestamp: 9000 })
    await store.addMessage({ id: 'second', session_id: 'ts', role: 'assistant', content: 'b', timestamp: 1000 })
    await store.deleteMessagesFrom('ts', 'second')
    expect((await store.getMessages('ts')).map((m) => m.id)).toEqual(['first'])
  })
})

describe('patchMessage：增量合并，不碰没给的列', () => {
  it('两种引擎：只改指定列，正文与工具结果原样保留', async () => {
    for (const { store } of await bothEngines()) {
      await store.addMessage({
        id: 'm1',
        session_id: 'p',
        role: 'user',
        content: '正文',
        timestamp: 1,
        tool_calls: '[{"id":"t1","name":"write_file"}]',
        file_checkpoints: '[{"id":"c1"}]',
      })
      await store.patchMessage('m1', { files_reverted: 1 })
      const [row] = await store.getMessages('p')
      expect(row).toMatchObject({
        content: '正文',
        tool_calls: '[{"id":"t1","name":"write_file"}]',
        file_checkpoints: '[{"id":"c1"}]',
        files_reverted: 1,
      })
    }
  })

  it('两种引擎：id 不存在时不写、不增修订号', async () => {
    for (const { store } of await bothEngines()) {
      await store.addMessage({ id: 'real', session_id: 'p', role: 'user', content: 'x', timestamp: 1 })
      const rev = await store.getRevision()
      await store.patchMessage('ghost', { files_reverted: 1 })
      expect(await store.getRevision()).toBe(rev)
    }
  })

  it('拒绝非对象补丁（一条坏数据不该改掉整行）', async () => {
    const guardDir = path.join(workDir, 'patchguard')
    fs.mkdirSync(guardDir, { recursive: true })
    const store = await openStore({ userDataDir: guardDir, wasmBinary: loadWasm() })
    await store.addMessage({ id: 'm', session_id: 'p', role: 'user', content: 'keep', timestamp: 1 })
    await store.patchMessage('m', null as never)
    await store.patchMessage('m', '[]' as never)
    const [row] = await store.getMessages('p')
    expect(row.content).toBe('keep')
  })
})

describe('回滚三列的编解码往返', () => {
  const message: Message = {
    id: 'u1',
    role: 'user',
    content: '本轮',
    timestamp: 10,
    fileCheckpoints: [{
      id: 'c1',
      toolCallId: 't1',
      toolName: 'write_file',
      path: 'D:\\p\\a.ts',
      existedBefore: true,
      beforeRef: 'c1.txt',
      afterHash: '12:abc',
      beforeBytes: 42,
      createdAt: 11,
    }],
    mutationGaps: [{ toolName: 'execute_command', reason: 'shell' }],
    filesReverted: true,
  }

  it('Message → 行 → Message 三列都取得回来', () => {
    const row = messageToRow(message, 's')
    const back = mapMessageRows([row])[0]!
    expect(back.fileCheckpoints).toEqual(message.fileCheckpoints)
    expect(back.mutationGaps).toEqual(message.mutationGaps)
    expect(back.filesReverted).toBe(true)
  })

  it('回执标记与 is_rewind_notice 列同进同出', () => {
    const row = messageToRow({ ...message, isRewindNotice: true, fileCheckpoints: undefined, mutationGaps: undefined, filesReverted: undefined }, 's')
    expect(row.is_rewind_notice).toBe(1)
    expect(mapMessageRows([row])[0]!.isRewindNotice).toBe(true)
  })

  it('坏数据一律丢弃而不是脑补：缺 beforeRef 的快照、未知 reason 的缺口都不认', () => {
    const broken = {
      id: 's',
      session_id: 'x',
      role: 'user',
      content: '',
      timestamp: 1,
      file_checkpoints: JSON.stringify([
        { id: 'ok', toolCallId: 't', toolName: 'write_file', path: 'a.ts', existedBefore: true, beforeRef: 'ok.txt', afterHash: 'h' },
        { id: 'no-ref', toolCallId: 't', toolName: 'write_file', path: 'b.ts', existedBefore: true, afterHash: 'h' },
        { id: 'null-ref', toolCallId: 't', toolName: 'write_file', path: 'c.ts', existedBefore: true, beforeRef: null, afterHash: 'h' },
        { id: 'phantom', toolCallId: 't', toolName: 'write_file', path: 'd.ts', existedBefore: false, beforeRef: 'd.txt', afterHash: 'h' },
      ]),
      mutation_gaps: JSON.stringify([
        { toolName: 'execute_command', reason: 'shell' },
        { toolName: 'weird', reason: 'made-up-reason' },
      ]),
    }
    const [decoded] = mapMessageRows([broken as never])
    expect(decoded!.fileCheckpoints?.map((c) => c.id)).toEqual(['ok', 'phantom'])
    // existedBefore=false 却带着 beforeRef：归一成 null，别让一条脏行变成一次多余的读盘
    expect(decoded!.fileCheckpoints?.[1]?.beforeRef).toBeNull()
    expect(decoded!.mutationGaps).toEqual([{ toolName: 'execute_command', reason: 'shell' }])
  })

  it('JSON 解析失败退化成「没有快照」，不抛错打断整段历史加载', () => {
    const [decoded] = mapMessageRows([{ id: 's', session_id: 'x', role: 'user', content: '', timestamp: 1, file_checkpoints: '{oops' } as never])
    expect(decoded!.fileCheckpoints).toBeUndefined()
  })

  it('messageRewindPatch 只在消息真的带这几列时才产生补丁', () => {
    expect(messageRewindPatch({ id: 'x', role: 'user', content: '', timestamp: 1 })).toBeNull()
    expect(messageRewindPatch(message)).toMatchObject({ files_reverted: 1 })
    expect(
      messageRewindPatch({ ...message, fileCheckpoints: undefined, mutationGaps: undefined, filesReverted: undefined, isRewindNotice: true })
    ).toMatchObject({ is_rewind_notice: 1, file_checkpoints: null })
  })
})

describe('checkpoint store：落盘引用名必须只是文件名', () => {
  it('拒绝路径穿越、绝对路径与任何非 .txt 形状', () => {
    expect(sanitizeRef('ck-abc.txt')).toBe('ck-abc.txt')
    for (const bad of ['../ck.txt', '..\\ck.txt', '/etc/passwd.txt', 'C:\\windows\\x.txt', 'a/b.txt', 'ck.txt.exe', '', `${'x'.repeat(90)}.txt`]) {
      expect(sanitizeRef(bad)).toBeNull()
    }
  })

  it('会话 id 也过一遍白名单，不同会话不会撞进同一目录', () => {
    expect(sanitizeSessionId('sess-1')).toBe('sess-1')
    expect(sanitizeSessionId('../../etc')).toBeNull()
    expect(sanitizeSessionId('')).toBeNull()
  })

  it('写读删往返，且重复写同一引用不产生第二份', async () => {
    const store = new CheckpointStore(path.join(tmpRoot, 'checkpoints'))
    await store.put('s1', 'c1.txt', '旧内容')
    await store.put('s1', 'c1.txt', '不该覆盖')
    expect(await store.get('s1', 'c1.txt')).toBe('旧内容')
    await store.remove('s1', ['c1.txt', 'missing.txt'])
    expect(await store.get('s1', 'c1.txt')).toBeNull()
  })

  it('读不到返回 null 而不是抛错（缺快照要进计划里标出来，不是炸掉整轮回滚）', async () => {
    const store = new CheckpointStore(path.join(tmpRoot, 'checkpoints'))
    expect(await store.get('nobody', 'x.txt')).toBeNull()
  })

  it('removeSession 清掉整个会话目录，不存在的会话不报错', async () => {
    const store = new CheckpointStore(path.join(tmpRoot, 'checkpoints'))
    await store.put('s2', 'c.txt', 'x')
    expect(fs.existsSync(path.join(tmpRoot, 'checkpoints', 's2'))).toBe(true)
    await store.removeSession('s2')
    expect(fs.existsSync(path.join(tmpRoot, 'checkpoints', 's2'))).toBe(false)
    await expect(store.removeSession('never-existed')).resolves.toBeUndefined()
  })

  it('非法引用名在 put 上就被拒（不给一次坏历史写到项目外的机会）', async () => {
    const store = new CheckpointStore(path.join(tmpRoot, 'checkpoints'))
    await expect(store.put('s3', '../escape.txt', 'x')).rejects.toThrow(/Invalid checkpoint ref/)
    await expect(store.put('a/b', 'c.txt', 'x')).rejects.toThrow(/Invalid checkpoint session id/)
  })
})
