/**
 * 会话存储引擎（A3）：SQLite（sql.js WASM）主引擎 + 旧 JSON 引擎降级兜底。
 *
 * 设计要点（目标：老用户升级零事故）：
 * 1. IPC 契约不变：db* handler 的名称/参数/返回结构与 JSON 时代完全一致，渲染层零改动。
 * 2. 迁移：首次启动检测到 clerkbox-db.json 且 SQLite 库为空时，在单事务内整体导入；
 *    成功后旧 JSON 重命名为 clerkbox-db.json.migrated-<ts>.bak 永久保留（绝不删除用户数据）。
 * 3. 降级：SQLite 初始化/迁移任何一步失败 → 删除半成品 clerkbox.db，回退到原 JSON 引擎，
 *    功能完全不受影响（错误写入日志便于诊断）。
 * 4. 写入：内存库即时生效 + 300ms 防抖落盘（tmp+rename 原子写）+ 退出前 flush；
 *    不再有「每次写消息都 JSON.stringify 全库」的写放大。
 * 5. 整行 JSON 入 data 列：保留行的全部字段（含未来新增字段），语义与 JSON 引擎逐一对齐
 *    （upsert 原位替换、消息插入序、自愈重建会话行、updated_at 触碰规则）。
 */
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

type Row = Record<string, unknown>

// sql.js 的最小结构类型与动态加载：
// - 不用 import 静态引入（该包只有 UMD/CJS，Electron CJS 与 vitest ESM 两种加载环境形态不同）
// - exec/run 返回的表结构按本地类型消费，避免依赖 @types/sql.js 的导出细节
type SqlValueLike = string | number | Uint8Array | null

interface SqlJsDatabase {
  run(sql: string, params?: SqlValueLike[]): void
  exec(sql: string, params?: SqlValueLike[]): Array<{ columns: string[]; values: SqlValueLike[][] }>
  prepare(sql: string): { run(params?: SqlValueLike[]): void; free(): void }
  export(): Uint8Array
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | null) => SqlJsDatabase
}

/** 跨 CJS/ESM 加载 sql.js 并注入 wasm 二进制（Electron 主进程打包路径与测试环境都能用） */
async function loadSqlJs(wasmBinary: Buffer): Promise<SqlJsStatic> {
  const mod: unknown = await import('sql.js')
  const candidate = (mod as { default?: unknown }).default ?? mod
  if (typeof candidate !== 'function') throw new Error('sql.js module shape unexpected')
  const initFn = candidate as (config: { wasmBinary: Buffer }) => Promise<SqlJsStatic>
  return await initFn({ wasmBinary })
}

export interface TraySessionItem {
  id: string
  title: string
  updatedAt: number
}

export interface ChatStore {
  readonly kind: 'sqlite' | 'json'
  createSession(row: Row): Promise<void>
  updateSessionTitle(id: string, title: string, updatedAt: number): Promise<void>
  deleteSession(id: string): Promise<void>
  getAllSessions(): Promise<Row[]>
  getRecents(): Promise<string[]>
  getRevision(): Promise<number>
  setRecents(recents: unknown): Promise<void>
  addMessage(row: Row): Promise<void>
  updateMessage(
    id: string,
    content: string,
    toolCalls?: string,
    toolResults?: string,
    thinkingContent?: string | null,
    finishReason?: string | null,
  ): Promise<void>
  getMessages(sessionId: string): Promise<Row[]>
  deleteMessagesBefore(sessionId: string, beforeId: string): Promise<void>
  clearMessages(sessionId: string): Promise<void>
  compactMessages(sessionId: string, rows: Row[]): Promise<void>
  getRecentSessions(): Promise<TraySessionItem[]>
  /** 退出前强制落盘（同步）；JSON 引擎为 no-op */
  flush(): void
}

const LEGACY_JSON_NAME = 'clerkbox-db.json'
const SQLITE_NAME = 'clerkbox.db'
/** 内存库防抖落盘间隔：流式期间高频写合并成一次 export */
const PERSIST_DEBOUNCE_MS = 300

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 会话自愈行的标题派生（与旧 JSON 引擎同规则：首条消息前 20 字） */
function deriveSessionTitle(content: unknown): string {
  const text = typeof content === 'string' ? content.trim().replace(/\s+/g, ' ') : ''
  return text ? (text.length > 20 ? text.slice(0, 20) + '…' : text) : '新会话'
}

/** 原子写文件：tmp + rename，rename 失败降级 copy（与 rt-account 同模式） */
function writeFileAtomic(filePath: string, data: Buffer | string): void {
  const tmp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  try {
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try {
      fs.copyFileSync(tmp, filePath)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
    if (!fs.existsSync(filePath)) throw err
  }
}

// ── 旧 JSON 格式读取（迁移与降级引擎共用的宽容解析，语义同原 readDb）──

interface LegacyDatabase {
  sessions: Row[]
  messages: Record<string, Row[]>
  recentsFolders?: string[]
  revision?: number
}

function parseLegacyJson(text: string): LegacyDatabase {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new Error('Database root must be an object')
  return {
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isRecord) : [],
    messages: isRecord(parsed.messages)
      ? Object.fromEntries(
          Object.entries(parsed.messages).map(([id, rows]) => [
            id,
            Array.isArray(rows) ? rows.filter(isRecord) : [],
          ]),
        )
      : {},
    recentsFolders: Array.isArray(parsed.recentsFolders)
      ? parsed.recentsFolders.filter((f): f is string => typeof f === 'string')
      : [],
    revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
  }
}

// ── SQLite 引擎（sql.js WASM，内存库 + 防抖原子落盘）──

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
-- 引擎标记：本引擎创建/接管的库才有此键，用于识别「遗留库」与「我们自己的库」
INSERT OR IGNORE INTO kv (key, value) VALUES ('engineVersion', 'sqlite-1');
`

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

class SqliteChatStore implements ChatStore {
  readonly kind = 'sqlite' as const
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly db: SqlJsDatabase,
    private readonly filePath: string,
    private revision: number,
    private recents: string[],
  ) {}

  /** 每次写操作后调用：全局修订号 +1（供另一端 dbGetRevision 廉价检测）并调度落盘 */
  private afterMutation(): void {
    this.revision += 1
    this.db.run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('revision', ?)`, [String(this.revision)])
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => this.flush(), PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }

  /** 强制落盘（同步）：退出路径与防抖回调共用；失败只记日志不影响内存态 */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      writeFileAtomic(this.filePath, Buffer.from(this.db.export()))
    } catch (error) {
      console.error('[db] sqlite persist failed:', error)
    }
  }

  private queryRows(sql: string, params: (string | number)[]): Row[] {
    const result = this.db.exec(sql, params)
    if (result.length === 0 || !result[0]) return []
    const { columns, values } = result[0]
    return values.map((v) => {
      const obj: Row = {}
      columns.forEach((col, i) => {
        obj[col] = v[i] as unknown
      })
      return obj
    })
  }

  private queryDataRows(sql: string, params: (string | number)[]): Row[] {
    return this.queryRows(sql, params).map((row) => JSON.parse(asString(row.data)) as Row)
  }

  /** 同步会话 updated_at（列与整行 JSON 双写，与旧引擎 touchSessionUpdatedAt 同义） */
  private touchSession(sessionId: string, ts: number): void {
    const rows = this.queryDataRows('SELECT data FROM sessions WHERE id = ?', [sessionId])
    if (rows.length === 0 || !rows[0]) return
    const session = rows[0]
    session.updated_at = ts
    this.db.run('UPDATE sessions SET updated_at = ?, data = ? WHERE id = ?', [
      ts,
      JSON.stringify(session),
      sessionId,
    ])
  }

  /** 会话行缺失时自愈重建（与旧引擎同策略：消息不成孤儿） */
  private ensureSessionRow(sessionId: string, ts: number, contentForTitle: unknown): void {
    const exists = this.queryRows('SELECT id FROM sessions WHERE id = ?', [sessionId])
    if (exists.length > 0) return
    const row: Row = {
      id: sessionId,
      title: deriveSessionTitle(contentForTitle),
      created_at: ts,
      updated_at: ts,
    }
    this.db.run('INSERT INTO sessions (id, title, updated_at, data) VALUES (?, ?, ?, ?)', [
      sessionId,
      asString(row.title),
      ts,
      JSON.stringify(row),
    ])
  }

  // ── 读操作（内存库直查，无磁盘 I/O）──

  async getAllSessions(): Promise<Row[]> {
    return this.queryDataRows('SELECT data FROM sessions ORDER BY rowid', [])
  }

  async getMessages(sessionId: string): Promise<Row[]> {
    // ORDER BY rowid = 插入序（与 JSON 数组序一致）；upsert 走 UPDATE 原位不打乱顺序
    return this.queryDataRows('SELECT data FROM messages WHERE session_id = ? ORDER BY rowid', [sessionId])
  }

  async getRecents(): Promise<string[]> {
    return [...this.recents]
  }

  async getRevision(): Promise<number> {
    return this.revision
  }

  async getRecentSessions(): Promise<TraySessionItem[]> {
    return this.queryRows('SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC', []).map(
      (row) => ({
        id: asString(row.id),
        title: asString(row.title),
        updatedAt: asNumber(row.updated_at),
      }),
    )
  }

  // ── 写操作（语义与旧 JSON 引擎逐一对齐）──

  async createSession(row: Row): Promise<void> {
    if (typeof row?.id !== 'string' || !row.id) throw new Error('Invalid session row')
    const existing = this.queryDataRows('SELECT data FROM sessions WHERE id = ?', [row.id])
    const merged: Row = existing.length > 0 ? { ...existing[0], ...row } : row
    this.db.run('INSERT OR REPLACE INTO sessions (id, title, updated_at, data) VALUES (?, ?, ?, ?)', [
      row.id,
      asString(merged.title),
      asNumber(merged.updated_at),
      JSON.stringify(merged),
    ])
    this.afterMutation()
  }

  async updateSessionTitle(id: string, title: string, updatedAt: number): Promise<void> {
    const rows = this.queryDataRows('SELECT data FROM sessions WHERE id = ?', [id])
    if (rows.length > 0 && rows[0]) {
      const session = rows[0]
      session.title = title
      session.updated_at = updatedAt
      this.db.run('UPDATE sessions SET title = ?, updated_at = ?, data = ? WHERE id = ?', [
        title,
        updatedAt,
        JSON.stringify(session),
        id,
      ])
    }
    // 与旧引擎一致：会话不存在也照常提交（修订号照常 +1）
    this.afterMutation()
  }

  async deleteSession(id: string): Promise<void> {
    this.db.run('DELETE FROM sessions WHERE id = ?', [id])
    this.db.run('DELETE FROM messages WHERE session_id = ?', [id])
    this.afterMutation()
  }

  async setRecents(recents: unknown): Promise<void> {
    this.recents = Array.isArray(recents)
      ? recents.filter((f): f is string => typeof f === 'string').slice(0, 8)
      : []
    this.db.run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('recentsFolders', ?)`, [
      JSON.stringify(this.recents),
    ])
    this.afterMutation()
  }

  async addMessage(row: Row): Promise<void> {
    if (typeof row?.id !== 'string' || !row.id || typeof row.session_id !== 'string' || !row.session_id) {
      throw new Error('Invalid message row')
    }
    const ts = asNumber(row.timestamp, Date.now())
    this.db.run('BEGIN')
    try {
      const existing = this.queryRows('SELECT rowid FROM messages WHERE id = ?', [row.id])
      const data = JSON.stringify(row)
      if (existing.length > 0) {
        // 原位更新保持插入序（同旧引擎的 msgs[idx] = row）
        this.db.run('UPDATE messages SET session_id = ?, timestamp = ?, data = ? WHERE id = ?', [
          row.session_id,
          ts,
          data,
          row.id,
        ])
      } else {
        this.db.run('INSERT INTO messages (id, session_id, timestamp, data) VALUES (?, ?, ?, ?)', [
          row.id,
          row.session_id,
          ts,
          data,
        ])
      }
      this.ensureSessionRow(row.session_id, ts, row.content)
      this.touchSession(row.session_id, ts)
      this.db.run('COMMIT')
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
    this.afterMutation()
  }

  async updateMessage(
    id: string,
    content: string,
    toolCalls?: string,
    toolResults?: string,
    thinkingContent?: string | null,
    finishReason?: string | null,
  ): Promise<void> {
    const rows = this.queryDataRows('SELECT data FROM messages WHERE id = ?', [id])
    if (rows.length === 0 || !rows[0]) return // 未找到：与旧引擎一致不写不 bump
    const row = rows[0]
    row.content = content
    if (toolCalls !== undefined) row.tool_calls = toolCalls
    if (toolResults !== undefined) row.tool_results = toolResults
    if (thinkingContent !== undefined) row.thinking_content = thinkingContent
    if (finishReason !== undefined) row.finish_reason = finishReason

    this.db.run('BEGIN')
    try {
      this.db.run('UPDATE messages SET data = ? WHERE id = ?', [JSON.stringify(row), id])
      this.touchSession(asString(row.session_id), Date.now())
      this.db.run('COMMIT')
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
    this.afterMutation()
  }

  async deleteMessagesBefore(sessionId: string, beforeId: string): Promise<void> {
    const found = this.queryRows('SELECT rowid FROM messages WHERE session_id = ? AND id = ?', [
      sessionId,
      beforeId,
    ])
    if (found.length === 0 || !found[0]) return
    this.db.run('DELETE FROM messages WHERE session_id = ? AND rowid < ?', [
      sessionId,
      asNumber(found[0].rowid),
    ])
    this.afterMutation()
  }

  async clearMessages(sessionId: string): Promise<void> {
    this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
    this.afterMutation()
  }

  /** 原子压缩：事务内整体替换该会话消息（对应旧引擎借 writeDb 原子性的语义） */
  async compactMessages(sessionId: string, rows: Row[]): Promise<void> {
    if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(rows)) {
      throw new Error('Invalid compact payload')
    }
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== 'string' || !row.id) {
        throw new Error('Invalid message row in compact payload')
      }
    }
    this.db.run('BEGIN')
    try {
      this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
      for (const row of rows) {
        this.db.run('INSERT INTO messages (id, session_id, timestamp, data) VALUES (?, ?, ?, ?)', [
          asString(row.id),
          sessionId,
          asNumber(row.timestamp, Date.now()),
          JSON.stringify(row),
        ])
      }
      if (rows.length > 0) {
        const last = rows[rows.length - 1]!
        this.ensureSessionRow(sessionId, asNumber(last.timestamp, Date.now()), last.content)
      }
      this.touchSession(sessionId, Date.now())
      this.db.run('COMMIT')
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
    this.afterMutation()
  }
}


// ── JSON 引擎（旧实现原样保留为降级路径：SQLite 不可用时行为与旧版完全一致）──

class JsonChatStore implements ChatStore {
  readonly kind = 'json' as const
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private enqueue(fn: () => void): Promise<void> {
    const write = this.writeQueue.then(fn)
    this.writeQueue = write.catch((err) => {
      console.error('[db] JSON write failed:', err)
    })
    return write
  }

  private async settled(): Promise<void> {
    await this.writeQueue
  }

  private readDb(): LegacyDatabase {
    try {
      if (fs.existsSync(this.filePath)) {
        return parseLegacyJson(fs.readFileSync(this.filePath, 'utf-8'))
      }
    } catch {
      // 损坏时备份后按空库处理（与旧引擎一致，绝不阻塞启动）
      try {
        if (fs.existsSync(this.filePath)) {
          fs.copyFileSync(this.filePath, `${this.filePath}.backup.${Date.now()}`)
          console.error('[db] JSON corrupt, backed up')
        }
      } catch { /* 备份失败保留原始错误 */ }
    }
    return { sessions: [], messages: {}, recentsFolders: [], revision: 0 }
  }

  private writeDb(db: LegacyDatabase): void {
    db.revision = (db.revision || 0) + 1
    writeFileAtomic(this.filePath, JSON.stringify(db, null, 2))
  }

  private touch(db: LegacyDatabase, sessionId: string, ts: number): void {
    const session = db.sessions.find((s) => s.id === sessionId)
    if (session) session.updated_at = ts
  }

  flush(): void { /* JSON 引擎每次写入即落盘，无需 flush */ }

  async createSession(row: Row): Promise<void> {
    await this.enqueue(() => {
      if (typeof row?.id !== 'string' || !row.id) throw new Error('Invalid session row')
      const db = this.readDb()
      const idx = db.sessions.findIndex((s) => s.id === row.id)
      if (idx === -1) db.sessions.push(row)
      else db.sessions[idx] = { ...db.sessions[idx], ...row }
      if (!db.messages[row.id]) db.messages[row.id] = []
      this.writeDb(db)
    })
  }

  async updateSessionTitle(id: string, title: string, updatedAt: number): Promise<void> {
    await this.enqueue(() => {
      const db = this.readDb()
      const session = db.sessions.find((s) => s.id === id)
      if (session) {
        session.title = title
        session.updated_at = updatedAt
      }
      this.writeDb(db)
    })
  }

  async deleteSession(id: string): Promise<void> {
    await this.enqueue(() => {
      const db = this.readDb()
      db.sessions = db.sessions.filter((s) => s.id !== id)
      delete db.messages[id]
      this.writeDb(db)
    })
  }

  async getAllSessions(): Promise<Row[]> {
    await this.settled()
    return this.readDb().sessions
  }

  async getRecents(): Promise<string[]> {
    await this.settled()
    return this.readDb().recentsFolders || []
  }

  async getRevision(): Promise<number> {
    await this.settled()
    return this.readDb().revision || 0
  }

  async getRecentSessions(): Promise<TraySessionItem[]> {
    await this.settled()
    return this.readDb()
      .sessions.map((row) => ({
        id: asString(row.id),
        title: asString(row.title),
        updatedAt: asNumber(row.updated_at),
      }))
      .filter((row) => row.id !== '')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async setRecents(recents: unknown): Promise<void> {
    await this.enqueue(() => {
      const db = this.readDb()
      db.recentsFolders = Array.isArray(recents)
        ? recents.filter((f): f is string => typeof f === 'string').slice(0, 8)
        : []
      this.writeDb(db)
    })
  }

  async addMessage(row: Row): Promise<void> {
    await this.enqueue(() => {
      if (typeof row?.id !== 'string' || !row.id || typeof row.session_id !== 'string' || !row.session_id) {
        throw new Error('Invalid message row')
      }
      const db = this.readDb()
      if (!db.messages[row.session_id]) db.messages[row.session_id] = []
      const msgs = db.messages[row.session_id]!
      const idx = msgs.findIndex((m) => m.id === row.id)
      if (idx !== -1) msgs[idx] = row
      else msgs.push(row)
      const ts = asNumber(row.timestamp, Date.now())
      if (!db.sessions.some((s) => s.id === row.session_id)) {
        db.sessions.push({
          id: row.session_id,
          title: deriveSessionTitle(row.content),
          created_at: ts,
          updated_at: ts,
        })
      }
      this.touch(db, row.session_id, ts)
      this.writeDb(db)
    })
  }

  async updateMessage(
    id: string,
    content: string,
    toolCalls?: string,
    toolResults?: string,
    thinkingContent?: string | null,
    finishReason?: string | null,
  ): Promise<void> {
    await this.enqueue(() => {
      const db = this.readDb()
      let found = false
      for (const [sessionId, msgs] of Object.entries(db.messages)) {
        const msg = msgs.find((m) => m.id === id)
        if (msg) {
          msg.content = content
          if (toolCalls !== undefined) msg.tool_calls = toolCalls
          if (toolResults !== undefined) msg.tool_results = toolResults
          if (thinkingContent !== undefined) msg.thinking_content = thinkingContent
          if (finishReason !== undefined) msg.finish_reason = finishReason
          this.touch(db, sessionId, Date.now())
          found = true
          break
        }
      }
      if (found) this.writeDb(db)
    })
  }

  async getMessages(sessionId: string): Promise<Row[]> {
    await this.settled()
    return this.readDb().messages[sessionId] || []
  }

  async deleteMessagesBefore(sessionId: string, beforeId: string): Promise<void> {
    await this.enqueue(() => {
      const db = this.readDb()
      const msgs = db.messages[sessionId]
      if (!msgs) return
      const idx = msgs.findIndex((m) => m.id === beforeId)
      if (idx === -1) return
      db.messages[sessionId] = msgs.slice(idx)
      this.writeDb(db)
    })
  }

  async clearMessages(sessionId: string): Promise<void> {
    await this.enqueue(() => {
      const db = this.readDb()
      db.messages[sessionId] = []
      this.writeDb(db)
    })
  }

  async compactMessages(sessionId: string, rows: Row[]): Promise<void> {
    await this.enqueue(() => {
      if (typeof sessionId !== 'string' || !sessionId || !Array.isArray(rows)) {
        throw new Error('Invalid compact payload')
      }
      for (const row of rows) {
        if (!isRecord(row) || typeof row.id !== 'string' || !row.id) {
          throw new Error('Invalid message row in compact payload')
        }
      }
      const db = this.readDb()
      db.messages[sessionId] = [...rows]
      if (rows.length > 0 && !db.sessions.some((s) => s.id === sessionId)) {
        const last = rows[rows.length - 1]!
        const ts = asNumber(last.timestamp, Date.now())
        db.sessions.push({ id: sessionId, title: deriveSessionTitle(last.content), created_at: ts, updated_at: ts })
      }
      this.touch(db, sessionId, Date.now())
      this.writeDb(db)
    })
  }
}


// ── 工厂：优先 SQLite（含旧 JSON 迁移），任何失败降级到 JSON 引擎 ──

export interface CreateChatStoreOptions {
  userDataDir: string
  /** sql-wasm.wasm 的字节；缺失（打包异常等）直接降级 JSON 引擎 */
  wasmBinary?: Buffer
}

export async function createChatStore(options: CreateChatStoreOptions): Promise<ChatStore> {
  const sqlitePath = path.join(options.userDataDir, SQLITE_NAME)
  const legacyPath = path.join(options.userDataDir, LEGACY_JSON_NAME)

  try {
    if (!options.wasmBinary || options.wasmBinary.length === 0) {
      throw new Error('sql.js wasm binary missing')
    }
    const SQL = await loadSqlJs(options.wasmBinary)

    // 遗留文件判定（老用户升级安全的关键）：
    // clerkbox.db 若已存在但没有引擎标记（engineVersion），说明它来自旧版本/其他引擎，
    // 其 schema 可能与当前不一致、数据也可能过期 —— 一律改名备份后重建，绝不直接复用。
    // v2.5.1 及更早版本的真正数据源是 clerkbox-db.json，因此「有 JSON 就以 JSON 为准」。
    let hasOurMarker = false
    if (fs.existsSync(sqlitePath)) {
      try {
        const probe = new SQL.Database(fs.readFileSync(sqlitePath))
        const probeResult = probe.exec(`SELECT value FROM kv WHERE key = 'engineVersion'`)
        hasOurMarker = (probeResult[0]?.values.length ?? 0) > 0
        // 有标记的库还要能通过自身 schema 自检，否则同样视为损坏
        if (hasOurMarker) {
          probe.run(SCHEMA_SQL)
          probe.exec('SELECT COUNT(*) FROM sessions')
        }
      } catch {
        hasOurMarker = false
      }
      if (!hasOurMarker) {
        try { fs.renameSync(sqlitePath, `${sqlitePath}.legacy-unmarked-${Date.now()}.bak`) } catch { /* ignore */ }
      }
    }

    let db: SqlJsDatabase
    if (fs.existsSync(sqlitePath) && hasOurMarker) {
      try {
        db = new SQL.Database(fs.readFileSync(sqlitePath))
        db.run(SCHEMA_SQL)
        db.exec('SELECT COUNT(*) FROM sessions')
      } catch {
        // 库文件损坏：备份后重建（数据可从 *.corrupt-*.bak 或旧 JSON 恢复）
        try { fs.copyFileSync(sqlitePath, `${sqlitePath}.corrupt-${Date.now()}.bak`) } catch { /* ignore */ }
        db = new SQL.Database()
        db.run(SCHEMA_SQL)
      }
    } else {
      db = new SQL.Database()
      db.run(SCHEMA_SQL)
    }

    // 迁移触发条件：库是新建的、或损坏重建后为空的，且旧 JSON 存在
    const empty =
      db.exec('SELECT COUNT(*) FROM sessions')[0]?.values[0]?.[0] === 0 &&
      db.exec('SELECT COUNT(*) FROM messages')[0]?.values[0]?.[0] === 0
    if (empty && fs.existsSync(legacyPath)) {
      const legacy = parseLegacyJson(fs.readFileSync(legacyPath, 'utf-8'))
      db.run('BEGIN')
      try {
        const insertSession = db.prepare(
          'INSERT OR REPLACE INTO sessions (id, title, updated_at, data) VALUES (?, ?, ?, ?)',
        )
        for (const s of legacy.sessions) {
          const sessionId = s.id
          if (typeof sessionId !== 'string' || !sessionId) continue
          insertSession.run([sessionId, asString(s.title), asNumber(s.updated_at), JSON.stringify(s)])
        }
        insertSession.free()
        const insertMessage = db.prepare(
          'INSERT OR REPLACE INTO messages (id, session_id, timestamp, data) VALUES (?, ?, ?, ?)',
        )
        for (const [fallbackSessionId, msgs] of Object.entries(legacy.messages)) {
          for (const m of msgs) {
            const messageId = m.id
            if (typeof messageId !== 'string' || !messageId) continue
            const sid = typeof m.session_id === 'string' && m.session_id ? m.session_id : fallbackSessionId
            const row = { ...m, session_id: sid }
            insertMessage.run([messageId, sid, asNumber(m.timestamp), JSON.stringify(row)])
          }
        }
        insertMessage.free()
        db.run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('revision', ?)`, [String(legacy.revision ?? 0)])
        db.run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('recentsFolders', ?)`, [
          JSON.stringify(legacy.recentsFolders ?? []),
        ])
        // 迁移标记：后续启动据此判断「库是本引擎的」，避免重复导入或被遗留库干扰
        db.run(`INSERT OR REPLACE INTO kv (key, value) VALUES ('migratedFromJsonAt', ?)`, [
          String(Date.now()),
        ])
        db.run('COMMIT')
      } catch (error) {
        db.run('ROLLBACK')
        throw error
      }
      // 迁移成功才改名旧文件（永久保留为 .bak，绝不删除）
      try {
        fs.renameSync(legacyPath, `${legacyPath}.migrated-${Date.now()}.bak`)
      } catch { /* 改名失败不致命：下次启动库非空，不会重复迁移 */ }
      console.log(`[db] migrated legacy JSON store → SQLite (${legacy.sessions.length} sessions)`)
    }

    const revisionRow = db.exec(`SELECT value FROM kv WHERE key = 'revision'`)
    const recentsRow = db.exec(`SELECT value FROM kv WHERE key = 'recentsFolders'`)
    const store = new SqliteChatStore(
      db,
      sqlitePath,
      Number(revisionRow[0]?.values[0]?.[0] ?? 0) || 0,
      JSON.parse(String(recentsRow[0]?.values[0]?.[0] ?? '[]')) as string[],
    )
    store.flush() // 迁移/建库后立即落盘，确保崩溃不丢迁移成果
    return store
  } catch (error) {
    // 降级：删除半成品库文件（如有），回退旧 JSON 引擎，功能与数据完全不受影响
    console.error('[db] SQLite init/migrate failed, falling back to legacy JSON store:', error)
    try {
      if (fs.existsSync(sqlitePath)) fs.copyFileSync(sqlitePath, `${sqlitePath}.failed-${Date.now()}.bak`)
      if (fs.existsSync(sqlitePath)) fs.rmSync(sqlitePath, { force: true })
    } catch { /* 清理失败不阻塞降级 */ }
    return new JsonChatStore(legacyPath)
  }
}

// ── IPC 注册：handler 名称/参数/返回与旧 JSON 时代完全一致（渲染层零改动）──

export function registerDbIpcHandlers(store: ChatStore): void {
  ipcMain.handle('dbCreateSession', (_e, row: Row) => store.createSession(row))
  ipcMain.handle('dbUpdateSessionTitle', (_e, id: string, title: string, updatedAt: number) =>
    store.updateSessionTitle(id, title, updatedAt),
  )
  ipcMain.handle('dbDeleteSession', (_e, id: string) => store.deleteSession(id))
  ipcMain.handle('dbGetAllSessions', () => store.getAllSessions())
  ipcMain.handle('dbGetRecents', () => store.getRecents())
  ipcMain.handle('dbGetRevision', () => store.getRevision())
  ipcMain.handle('dbSetRecents', (_e, recents: unknown) => store.setRecents(recents))
  ipcMain.handle('dbAddMessage', (_e, row: Row) => store.addMessage(row))
  ipcMain.handle(
    'dbUpdateMessage',
    (
      _e,
      id: string,
      content: string,
      toolCalls?: string,
      toolResults?: string,
      thinkingContent?: string | null,
      finishReason?: string | null,
    ) => store.updateMessage(id, content, toolCalls, toolResults, thinkingContent, finishReason),
  )
  ipcMain.handle('dbGetMessages', (_e, sessionId: string) => store.getMessages(sessionId))
  ipcMain.handle('dbDeleteMessagesBefore', (_e, sessionId: string, beforeId: string) =>
    store.deleteMessagesBefore(sessionId, beforeId),
  )
  ipcMain.handle('dbClearMessages', (_e, sessionId: string) => store.clearMessages(sessionId))
  ipcMain.handle('dbCompactMessages', (_e, sessionId: string, rows: Row[]) =>
    store.compactMessages(sessionId, rows),
  )
}

