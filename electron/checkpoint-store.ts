/**
 * 文件变更前快照的落盘存储（消息撤回 / 改动回滚的正文仓库）。
 *
 * 为什么单独落文件而不进 SQLite：本项目的 sql.js 是「内存库 + 每次变更全量导出落盘」，
 * 把几 MB 的源文件正文塞进 messages.data 列，之后每一次写消息都要重写整个库文件。
 * 索引（路径 / 哈希 / 引用名）留在消息行里，正文在这里，与 ZCode 的 artifact store 同构。
 *
 * 目录：<userData>/checkpoints/<sessionId>/<checkpointId>.txt
 * 引用名（beforeRef）由调用方给出，这里强制校验成「纯文件名」——
 * 它可以来自一条被写坏的历史记录，绝不能让它变成 ../.. 或绝对路径。
 */
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/** 单个快照正文的上限：超过就不拍快照，改记一条 oversized 缺口（回滚档随之置灰） */
export const CHECKPOINT_MAX_BYTES = 2 * 1024 * 1024

/** 合法引用名：ck_<base36 随机> 加 .txt 后缀，不接受任何路径分隔符 */
const REF_RE = /^[A-Za-z0-9._-]{1,80}\.txt$/
const SESSION_RE = /^[A-Za-z0-9._-]{1,120}$/

/**
 * 会话 id 落盘前的映射：原 id 里可能有路径分隔符（历史数据/外部导入），
 * 统一转义成安全字符，同时保留可逆性，避免不同会话撞进同一目录。
 */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

export function sanitizeSessionId(sessionId: unknown): string | null {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return null
  return safeSegment(sessionId)
}

export function sanitizeRef(ref: unknown): string | null {
  if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.includes('..')) return null
  return ref
}

export class CheckpointStore {
  constructor(private readonly rootDir: string) {}

  private sessionDir(sessionId: string): string {
    const sid = sanitizeSessionId(sessionId)
    if (!sid) throw new Error('Invalid checkpoint session id')
    return path.join(this.rootDir, sid)
  }

  /** 写快照正文；已存在则直接复用（同一 checkpoint 重复落库不应产生第二份） */
  async put(sessionId: string, ref: string, content: string): Promise<void> {
    const file = sanitizeRef(ref)
    if (!file) throw new Error('Invalid checkpoint ref')
    const dir = this.sessionDir(sessionId)
    await fs.promises.mkdir(dir, { recursive: true })
    const target = path.join(dir, file)
    if (fs.existsSync(target)) return
    // 先写 tmp 再 rename：半途崩溃只留下一个没有索引指向的 tmp，不会写出半截快照
    const tmp = `${target}.${process.pid}.tmp`
    await fs.promises.writeFile(tmp, content, 'utf-8')
    await fs.promises.rename(tmp, target)
  }

  /** 读快照正文；不存在返回 null（缺失由回滚计划标 missing-snapshot，而不是抛错炸掉整轮） */
  async get(sessionId: string, ref: string): Promise<string | null> {
    const file = sanitizeRef(ref)
    if (!file) return null
    try {
      return await fs.promises.readFile(path.join(this.sessionDir(sessionId), file), 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      throw err
    }
  }

  /** 删除指定快照：回滚提交后、或对话被截断后回收，避免孤儿快照吃满磁盘 */
  async remove(sessionId: string, refs: string[]): Promise<void> {
    const dir = this.sessionDir(sessionId)
    for (const ref of refs) {
      const file = sanitizeRef(ref)
      if (!file) continue
      try {
        await fs.promises.unlink(path.join(dir, file))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
  }

  /** 整会话回收：删除会话时连同它的全部快照一起清掉 */
  async removeSession(sessionId: string): Promise<void> {
    try {
      await fs.promises.rm(this.sessionDir(sessionId), { recursive: true, force: true })
    } catch (err) {
      // 目录不存在是常态（该会话从没写过文件）；其余错误不该让删除会话整件事失败
      console.error('[checkpoint] removeSession failed:', err)
    }
  }
}

let instance: CheckpointStore | null = null

export function getCheckpointStore(): CheckpointStore {
  if (!instance) throw new Error('Checkpoint store not initialized')
  return instance
}

/**
 * 注册 IPC。宿主模式（agent-host 在主进程）通过 installAgentHostBridge 直调 handlerRegistry，
 * 渲染层模式走 invoke —— 与既有 db* 通道一套规矩。
 * 这三个通道都能读写本机文件，全部列入远程黑名单（见 webui-server.ts）。
 */
export function registerCheckpointIpcHandlers(userDataDir: string): void {
  instance = new CheckpointStore(path.join(userDataDir, 'checkpoints'))
  const store = instance
  ipcMain.handle('ckptPut', (_e, sessionId: string, ref: string, content: string) =>
    store.put(sessionId, ref, content),
  )
  ipcMain.handle('ckptGet', (_e, sessionId: string, ref: string) => store.get(sessionId, ref))
  ipcMain.handle('ckptRemove', (_e, sessionId: string, refs: string[]) =>
    store.remove(sessionId, Array.isArray(refs) ? refs : []),
  )
  ipcMain.handle('ckptRemoveSession', (_e, sessionId: string) => store.removeSession(sessionId))
}
