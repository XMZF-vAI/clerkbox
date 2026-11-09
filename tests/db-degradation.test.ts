import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// db.ts 顶部 import { ipcMain } from 'electron'（仅 registerDbIpcHandlers 使用），测试里打桩
vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))

import { createChatStore } from '../electron/db'

const WASM_PATH = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
const loadWasm = (): Buffer => fs.readFileSync(WASM_PATH)

let workDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerkbox-db-degrade-'))
})

afterEach(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch { /* Windows 上偶发占用，忽略 */ }
})

const legacyPath = (): string => path.join(workDir, 'clerkbox-db.json')

function writeLegacy(data: unknown): string {
  fs.writeFileSync(legacyPath(), JSON.stringify(data, null, 2), 'utf-8')
  return legacyPath()
}

/** 一份可迁移的旧库：会话 s1 + 两条消息 */
const legacyFixture = (messageTimestamp = 1000, content = '旧内容') => ({
  sessions: [{ id: 's1', title: '会话一', created_at: 1000, updated_at: 2000 }],
  messages: {
    s1: [
      { id: 'm1', session_id: 's1', role: 'user', content, timestamp: messageTimestamp },
      { id: 'm2', session_id: 's1', role: 'assistant', content: '回复', timestamp: messageTimestamp + 1 },
    ],
  },
  recentsFolders: [],
  revision: 7,
})

/**
 * BE-02：SQLite → JSON 降级 → SQLite 恢复形成的数据分叉。
 *
 * 回归点：降级恢复时旧实现只在「空库」时导入 JSON，于是降级期间写入的新消息在恢复后
 * 彻底看不见（会话侧的历史也同样看不见，因为降级读的是过期快照）。
 */
describe('BE-02 降级写入在恢复后并回 SQLite', () => {
  it('降级期间新增的会话与消息，恢复后与原 SQLite 数据同时存在', async () => {
    // 正常期：SQLite 里有 s1 与 m1
    const sqlite = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    await sqlite.createSession({ id: 's1', title: '正常会话', created_at: 1000, updated_at: 1000 })
    await sqlite.addMessage({ id: 'm1', session_id: 's1', role: 'user', content: '降级前的消息', timestamp: 1000 })
    sqlite.flush()

    // 降级：wasm 缺失 → JSON 引擎。降级视图是空的（没有旧 JSON 可还原），但写入是真的
    const degraded = await createChatStore({ userDataDir: workDir })
    expect(degraded.kind).toBe('json')
    await degraded.createSession({ id: 's2', title: '降级会话', created_at: 2000, updated_at: 2000 })
    await degraded.addMessage({ id: 'm9', session_id: 's2', role: 'user', content: '降级期间的消息', timestamp: 2000 })

    // 恢复：wasm 回来了
    const recovered = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect(recovered.kind).toBe('sqlite')
    const sessions = (await recovered.getAllSessions()).map((s) => s.id).sort()
    expect(sessions).toEqual(['s1', 's2'])
    const messages = (await recovered.getMessages('s2')).map((m) => m.id)
    expect(messages).toEqual(['m9'])
    // 降级前那条也不能丢
    expect((await recovered.getMessages('s1')).map((m) => m.id)).toEqual(['m1'])
  })

  it('同一条消息两侧都有时取较新的一份，并把落败的那份留在冲突备份里', async () => {
    // 先让旧库迁进 SQLite（m1 的时间戳是 1000）
    writeLegacy(legacyFixture(1000, '旧内容'))
    const sqlite = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect((await sqlite.getMessages('s1')).map((m) => m.content)).toEqual(['旧内容', '回复'])
    sqlite.flush()

    // 模拟「外部又写回一份 JSON」，其中 m1 更新（时间戳 5000）且内容不同
    writeLegacy(legacyFixture(5000, '新内容'))
    const degraded = await createChatStore({ userDataDir: workDir })
    expect(degraded.kind).toBe('json')
    // 降级期间产生一次写入：降级标记随这次写入落盘
    await degraded.addMessage({ id: 'm9', session_id: 's1', role: 'user', content: '降级期消息', timestamp: 5000 })

    const recovered = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    const messages = await recovered.getMessages('s1')
    const m1 = messages.find((m) => m.id === 'm1')
    expect(m1?.content).toBe('新内容') // 较新的一份胜出

    // 落败的一份不许凭空消失：必须留在冲突备份文件里
    const conflicts = fs.readdirSync(workDir).filter((f) => f.includes('.conflicts-'))
    expect(conflicts.length).toBe(1)
    const recorded = JSON.parse(fs.readFileSync(path.join(workDir, conflicts[0]!), 'utf-8')) as Array<{ id: string }>
    expect(recorded.map((r) => r.id)).toContain('m1')
  })

  it('降级期间删掉的会话与消息，恢复后不会在 SQLite 里复活', async () => {
    writeLegacy(legacyFixture())
    const sqlite = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect((await sqlite.getAllSessions()).length).toBe(1)
    sqlite.flush()

    // 外部又写回一份同样内容的 JSON，降级期间把整个会话删掉
    writeLegacy(legacyFixture())
    const degraded = await createChatStore({ userDataDir: workDir })
    expect(degraded.kind).toBe('json')
    await degraded.deleteSession('s1')

    const recovered = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect((await recovered.getAllSessions()).length).toBe(0)
    expect((await recovered.getMessages('s1')).length).toBe(0)
  })

  it('降级本身不改用户的 JSON 文件（标记随第一次写入才落盘）', async () => {
    writeLegacy(legacyFixture())
    const sqlite = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    sqlite.flush()
    writeLegacy(legacyFixture())
    const rawBefore = fs.readFileSync(legacyPath(), 'utf-8')

    const degraded = await createChatStore({ userDataDir: workDir })
    expect(degraded.kind).toBe('json')
    expect(fs.readFileSync(legacyPath(), 'utf-8')).toBe(rawBefore)
  })

  it('两边都没有增量时不产生合并副作用（JSON 与 SQLite 内容保持一致）', async () => {
    writeLegacy(legacyFixture())
    const sqlite = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    sqlite.flush()
    const before = (await sqlite.getAllSessions()).map((s) => s.id)

    const recovered = await createChatStore({ userDataDir: workDir, wasmBinary: loadWasm() })
    expect((await recovered.getAllSessions()).map((s) => s.id)).toEqual(before)
  })
})
