import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// db.ts 顶部 import { ipcMain } from 'electron'（仅 registerDbIpcHandlers 使用），测试里打桩
vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))

import { createChatStore } from '../electron/db'
import { deriveSessionTitle } from '../src/lib/chat-row'

const WASM_PATH = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
const loadWasm = (): Buffer => fs.readFileSync(WASM_PATH)

let workDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerkbox-db-test-'))
})

afterEach(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch { /* Windows 上偶发占用，忽略 */ }
})

/** 旧 JSON 库样例（含未知扩展字段以验证整行保真迁移） */
const legacyFixture = () => ({
  sessions: [
    { id: 's1', title: '会话一', created_at: 1000, updated_at: 2000, working_dir: 'D:\\proj' },
    { id: 's2', title: '新会话', created_at: 1500, updated_at: 1600, custom_future_field: { a: 1 } },
  ],
  messages: {
    s1: [
      { id: 'm1', session_id: 's1', role: 'user', content: '你好', timestamp: 1100 },
      {
        id: 'm2',
        session_id: 's1',
        role: 'assistant',
        content: '你好呀',
        timestamp: 1200,
        tool_calls: '[{"id":"t1","name":"read_file"}]',
        is_compact: 1,
      },
    ],
    s2: [],
  },
  recentsFolders: ['D:\\proj', 'D:\\work'],
  revision: 42,
})

function writeLegacy(dir: string, data: unknown): string {
  const file = path.join(dir, 'clerkbox-db.json')
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
  return file
}

describe('createChatStore 迁移（老用户升级路径）', () => {
  it('旧 JSON 数据完整迁移到 SQLite，原文件改名为 .migrated-*.bak 且内容保留', async () => {
    const legacyPath = writeLegacy(workDir, legacyFixture())
    const legacyRaw = fs.readFileSync(legacyPath, 'utf-8')

    const store = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect(store.kind).toBe('sqlite')

    const sessions = await store.getAllSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({ id: 's1', title: '会话一', updated_at: 2000, working_dir: 'D:\\proj' })
    // 未知字段（未来扩展）也随整行 JSON 保真迁移
    expect(sessions[1]!.custom_future_field).toEqual({ a: 1 })

    const messages = await store.getMessages('s1')
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(messages[1]).toMatchObject({ content: '你好呀', tool_calls: '[{"id":"t1","name":"read_file"}]', is_compact: 1 })

    expect(await store.getRevision()).toBe(42)
    expect(await store.getRecents()).toEqual(['D:\\proj', 'D:\\work'])

    // 原 JSON 不删除，改名备份且字节级保留
    expect(fs.existsSync(legacyPath)).toBe(false)
    const backups = fs.readdirSync(workDir).filter((f) => f.includes('clerkbox-db.json.migrated-'))
    expect(backups).toHaveLength(1)
    expect(fs.readFileSync(path.join(workDir, backups[0]!), 'utf-8')).toBe(legacyRaw)
  })

  it('迁移幂等：二次启动不重复迁移、不丢数据', async () => {
    writeLegacy(workDir, legacyFixture())
    const first = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    await first.addMessage({ id: 'm3', session_id: 's1', role: 'user', content: '追加', timestamp: 3000 })
    first.flush()

    const second = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    const messages = await second.getMessages('s1')
    expect(messages).toHaveLength(3)
    expect(messages[2]!.content).toBe('追加')
    expect((await second.getAllSessions()).length).toBe(2)
  })

  it('全新用户：无旧文件时不迁移，空库可用', async () => {
    const store = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect(store.kind).toBe('sqlite')
    expect(await store.getAllSessions()).toEqual([])
    await store.createSession({ id: 'n1', title: '新会话', created_at: 1, updated_at: 1 })
    expect(await store.getAllSessions()).toHaveLength(1)
  })

  it('SQLite 文件损坏：备份后重建，并可从仍存在的旧 JSON 补救数据', async () => {
    writeLegacy(workDir, legacyFixture())
    const first = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    first.flush()
    // 把旧 JSON 放回 + 写入垃圾字节模拟库损坏
    writeLegacy(workDir, legacyFixture())
    fs.writeFileSync(path.join(workDir, 'clerkbox.db'), Buffer.from('not-a-sqlite-file'))

    const store = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect(store.kind).toBe('sqlite')
    expect(
      fs.readdirSync(workDir).some((f) => /clerkbox\.db\.(corrupt|legacy-unmarked)-/.test(f)),
    ).toBe(true)
    expect((await store.getAllSessions()).length).toBe(2)
  })

  it('遗留未标记 clerkbox.db + 旧 JSON：以 JSON 为权威源，遗留库改名备份不丢', async () => {
    // 构造一个「来自旧版本/其他引擎」的合法 SQLite 库（无迁移标记）
    const initSqlModule: unknown = await import('sql.js')
    const initSql = ((initSqlModule as { default?: unknown }).default ?? initSqlModule) as (
      cfg: { wasmBinary: Buffer },
    ) => Promise<{ Database: new () => { run: (sql: string) => void; export: () => Uint8Array } }>
    const SQL = await initSql({ wasmBinary: loadWasm() })
    const foreign = new SQL.Database()
    foreign.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)')
    foreign.run(`INSERT INTO sessions VALUES ('june-old', '六月旧数据')`)
    fs.writeFileSync(path.join(workDir, 'clerkbox.db'), Buffer.from(foreign.export()))
    writeLegacy(workDir, legacyFixture())

    const store = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect(store.kind).toBe('sqlite')
    const ids = (await store.getAllSessions()).map((s) => s.id)
    expect(ids).toEqual(['s1', 's2']) // JSON 数据生效，旧库的 'june-old' 不出现
    expect(fs.readdirSync(workDir).some((f) => f.includes('clerkbox.db.legacy-unmarked-'))).toBe(true)
  })
})

describe('createChatStore 降级（wasm 不可用）', () => {
  it('缺少 wasm 时降级 JSON 引擎：旧文件不改名、功能可用', async () => {
    const legacyPath = writeLegacy(workDir, legacyFixture())
    const store = await createChatStore({ userDataDir: workDir })
    expect(store.kind).toBe('json')

    // 降级路径行为与旧版一致：文件原地读写
    expect(fs.existsSync(legacyPath)).toBe(true)
    expect((await store.getAllSessions()).length).toBe(2)
    await store.addMessage({ id: 'm9', session_id: 's1', role: 'user', content: 'x', timestamp: 10 })
    expect((await store.getMessages('s1')).map((m) => m.id)).toEqual(['m1', 'm2', 'm9'])
  })

  it('已迁移用户遇到 wasm 缺失：绝不删库，并还原 JSON 副本使历史可见', async () => {
    writeLegacy(workDir, legacyFixture())
    const first = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    first.flush()
    // 迁移成功那一刻，旧 JSON 已被改名移走
    expect(fs.existsSync(path.join(workDir, 'clerkbox-db.json'))).toBe(false)

    const store = await createChatStore({ userDataDir: workDir }) // 无 wasm → 降级
    expect(store.kind).toBe('json')
    // 回归点：降级分支曾无条件 rmSync 掉 clerkbox.db，而那一刻唯一的数据源就是这个文件，
    // 结果是「一次 wasm 读取失败 = 历史全空」，且第一次写入会重建空 JSON 让回退永久胜出。
    expect(fs.existsSync(path.join(workDir, 'clerkbox.db'))).toBe(true)
    expect((await store.getAllSessions()).map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('降级引擎打开空路径前先还原 .migrated-*.bak（不覆盖已存在的 JSON）', async () => {
    writeLegacy(workDir, legacyFixture())
    const first = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    first.flush()
    const stillThere = path.join(workDir, 'clerkbox-db.json')
    writeLegacy(workDir, legacyFixture()) // 模拟外部又写回了一份 JSON
    const rawBefore = fs.readFileSync(stillThere, 'utf-8')
    const store = await createChatStore({ userDataDir: workDir })
    expect(store.kind).toBe('json')
    expect(fs.readFileSync(stillThere, 'utf-8')).toBe(rawBefore) // 有就用现成的，不拿备份去盖
  })
})

describe('SQLite 引擎语义（与旧 JSON 引擎对齐）', () => {
  let store: Awaited<ReturnType<typeof createChatStore>>

  beforeEach(async () => {
    store = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
  })

  it('持续写入不得把落盘无限推后：防抖有上限，流式期间也会写盘', async () => {
    vi.useFakeTimers()
    try {
      const file = path.join(workDir, 'clerkbox.db')
      fs.rmSync(file, { force: true })
      let persisted = false
      // 每 50ms 一次写（agent-core 的流式节流口径）：纯 300ms 防抖会被不断重置而永不落地
      for (let i = 0; i < 60 && !persisted; i++) {
        await store.addMessage({ id: `cap-${i}`, session_id: 's', role: 'user', content: 'x', timestamp: i })
        vi.advanceTimersByTime(50)
        persisted = fs.existsSync(file)
      }
      expect(persisted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('addMessage 对已存在消息原位替换，保持插入序', async () => {
    await store.addMessage({ id: 'a', session_id: 's', role: 'user', content: '1', timestamp: 1 })
    await store.addMessage({ id: 'b', session_id: 's', role: 'assistant', content: '2', timestamp: 2 })
    await store.addMessage({ id: 'a', session_id: 's', role: 'user', content: '1-更新', timestamp: 3 })
    const messages = await store.getMessages('s')
    expect(messages.map((m) => m.id)).toEqual(['a', 'b'])
    expect(messages[0]!.content).toBe('1-更新')
  })

  it('addMessage 自愈重建缺失的会话行（标题规则与渲染层/宿主同源）并触碰 updated_at', async () => {
    const content = '这是一条用于派生标题的长内容超过二十个字符测试并且长到应当被截断'
    await store.addMessage({ id: 'x', session_id: 'ghost', role: 'user', content, timestamp: 5000 })
    const sessions = await store.getAllSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe('ghost')
    // 过去这里自有一套「20 字 + …」的规则，与 chat-row 的 30 字并存：自愈建行的会话
    // 与渲染层/宿主改名的会话会长出两种标题。现在断言同源，规则改动会同时暴露。
    expect(String(sessions[0]!.title)).toBe(deriveSessionTitle(content))
    expect(sessions[0]!.updated_at).toBe(5000)
  })

  it('createSession 重复写入保持原位（rowid 不重排），合并字段照常生效', async () => {
    await store.createSession({ id: 'a', title: 'A', created_at: 1, updated_at: 1 })
    await store.createSession({ id: 'b', title: 'B', created_at: 2, updated_at: 2 })
    await store.createSession({ id: 'a', title: 'A 改名', created_at: 1, updated_at: 9, working_dir: 'D:\\p' })
    const rows = await store.getAllSessions()
    // getAllSessions 按 rowid 排序：INSERT OR REPLACE 是「删了再插」，会把重新打开的会话甩到末尾
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(rows[0]).toMatchObject({ title: 'A 改名', updated_at: 9, working_dir: 'D:\\p' })
  })

  it('修订号随写操作自增；updateMessage 未命中不写不增', async () => {
    const before = await store.getRevision()
    await store.createSession({ id: 'r1', title: 't', created_at: 1, updated_at: 1 })
    expect(await store.getRevision()).toBe(before + 1)
    await store.updateMessage('missing-id', 'x')
    expect(await store.getRevision()).toBe(before + 1)
    await store.addMessage({ id: 'mm', session_id: 'r1', role: 'user', content: 'hi', timestamp: 2 })
    await store.updateMessage('mm', 'hi-updated')
    expect((await store.getMessages('r1'))[0]!.content).toBe('hi-updated')
    expect(await store.getRevision()).toBe(before + 3)
  })

  it('deleteMessagesBefore 保留目标消息及其之后；beforeId 缺失时不写', async () => {
    for (const id of ['q1', 'q2', 'q3']) {
      await store.addMessage({ id, session_id: 'd', role: 'user', content: id, timestamp: Date.now() })
    }
    const rev = await store.getRevision()
    await store.deleteMessagesBefore('d', 'q2')
    expect((await store.getMessages('d')).map((m) => m.id)).toEqual(['q2', 'q3'])
    await store.deleteMessagesBefore('d', 'nope')
    expect(await store.getRevision()).toBe(rev + 1)
  })

  it('compactMessages 原子整体替换并按给定顺序写入', async () => {
    await store.addMessage({ id: 'old', session_id: 'c', role: 'user', content: 'old', timestamp: 1 })
    await store.compactMessages('c', [
      { id: 'sum', session_id: 'c', role: 'assistant', content: '摘要', timestamp: 100, is_compact: 1 },
      { id: 'keep', session_id: 'c', role: 'user', content: '最近', timestamp: 200 },
    ])
    expect((await store.getMessages('c')).map((m) => m.id)).toEqual(['sum', 'keep'])
  })

  it('getRecentSessions 按 updated_at 降序，供托盘菜单直读', async () => {
    await store.createSession({ id: 'old-s', title: '旧', created_at: 1, updated_at: 10 })
    await store.createSession({ id: 'new-s', title: '新', created_at: 2, updated_at: 20 })
    expect((await store.getRecentSessions()).map((s) => s.id)).toEqual(['new-s', 'old-s'])
  })

  it('flush 后数据持久化到磁盘并可被新实例读取', async () => {
    await store.createSession({ id: 'p1', title: '持久化', created_at: 1, updated_at: 1 })
    store.flush()
    const reopened = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect((await reopened.getAllSessions()).map((s) => s.id)).toEqual(['p1'])
  })
})

