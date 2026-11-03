/**
 * 工作流 journal 的落盘存储（v2 后台运行的崩溃恢复面）。
 *
 * 为什么单独落文件而不进 SQLite：与 checkpoint-store 同一条理由——sql.js 是
 * 「内存库 + 每次变更全量导出落盘」，journal 每步结算都写，塞进库会让每次
 * 写消息都背上整库导出。一 run 一文件，原子写，体量小到无所谓。
 *
 * 目录：<userData>/workflow-runs/<runId>.json
 *
 * 恢复语义（与 scheduled-tasks 的水合改判同款）：启动后宿主 list() 出全部快照，
 * status==='running' 的一律改判 interrupted——进程没了就是在跑的工作流都没了，
 * 本期不做续跑（resume-from-journal 是三期），但卡片绝不能永远空转。
 */
import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/** 保留的运行快照上限（新近优先，超限淘汰最旧） */
export const WORKFLOW_JOURNAL_MAX_RUNS = 50
/** 快照的保留时长：超过即启动清扫时删除 */
export const WORKFLOW_JOURNAL_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 合法 runId：wf-<base36 时间戳>-<base36 随机>，不接受任何路径分隔符 */
const RUN_ID_RE = /^wf-[A-Za-z0-9._-]{1,120}$/

function safeRunId(runId: unknown): string | null {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || runId.includes('..')) return null
  return runId
}

export interface WorkflowJournalEntry {
  runId: string
  sessionId: string
  toolCallId?: string
  assistantMessageId?: string
  name: string
  status: 'running' | 'completed' | 'failed' | 'aborted'
  /** 整个 WorkflowRun 的序列化（journal 只存不解释，读回来直接交给 UI） */
  payload: unknown
  savedAt: number
}

export class WorkflowJournal {
  constructor(private readonly rootDir: string) {}

  private fileOf(runId: string): string {
    const id = safeRunId(runId)
    if (!id) throw new Error('Invalid workflow run id')
    return path.join(this.rootDir, `${id}.json`)
  }

  /** 落一份运行快照（launch 与每次 settle 各调一次）；失败静默——journal 永不影响运行 */
  async put(entry: WorkflowJournalEntry): Promise<void> {
    try {
      if (!safeRunId(entry.runId)) return
      await fs.promises.mkdir(this.rootDir, { recursive: true })
      const target = this.fileOf(entry.runId)
      // 先写 tmp 再 rename：半途崩溃只留下一个无指向的 tmp，不会写出半截快照
      const tmp = `${target}.${process.pid}.tmp`
      await fs.promises.writeFile(tmp, JSON.stringify(entry), 'utf-8')
      await fs.promises.rename(tmp, target)
    } catch (err) {
      console.error('[workflow-journal] put failed:', err)
    }
  }

  /** 读全部快照，新近优先；单份损坏跳过（不炸整个恢复面） */
  async list(): Promise<WorkflowJournalEntry[]> {
    let files: string[] = []
    try {
      files = await fs.promises.readdir(this.rootDir)
    } catch {
      return []
    }
    const entries: WorkflowJournalEntry[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.promises.readFile(path.join(this.rootDir, file), 'utf-8')
        const entry = JSON.parse(raw) as WorkflowJournalEntry
        if (entry && typeof entry.runId === 'string' && entry.payload) entries.push(entry)
      } catch {
        /* 半截文件（崩溃残留的 tmp 已被后缀挡掉；损坏的 json 跳过） */
      }
    }
    entries.sort((a, b) => b.savedAt - a.savedAt)
    return entries
  }

  /** 删除单份快照（会话删除时整段回收用 removeSession） */
  async remove(runId: string): Promise<void> {
    try {
      await fs.promises.unlink(this.fileOf(runId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[workflow-journal] remove failed:', err)
    }
  }

  /** 整会话回收：删除会话时清掉它的工作流快照 */
  async removeSession(sessionId: string): Promise<void> {
    const entries = await this.list()
    for (const entry of entries) {
      if (entry.sessionId === sessionId) await this.remove(entry.runId)
    }
  }

  /**
   * 启动清扫：TTL 过期的删掉；剩下的按新近保留 MAX_RUNS 份，其余删除。
   * 只在应用启动时调一次——运行期不 GC，避免和写入打架。
   */
  async sweep(): Promise<void> {
    const entries = await this.list()
    const now = Date.now()
    let kept = 0
    for (const entry of entries) {
      const expired = now - entry.savedAt > WORKFLOW_JOURNAL_TTL_MS
      if (expired || kept >= WORKFLOW_JOURNAL_MAX_RUNS) {
        await this.remove(entry.runId)
        continue
      }
      kept += 1
    }
  }
}

let instance: WorkflowJournal | null = null

export function getWorkflowJournal(): WorkflowJournal {
  if (!instance) throw new Error('Workflow journal not initialized')
  return instance
}

/**
 * 注册 IPC。渲染层宿主经 invoke 写盘；宿主模式（agent-host 在主进程）经
 * installAgentHostBridge 直调 handlerRegistry。与 checkpoint 通道同一套规矩：
 * 都能读写本机文件，全部列入远程黑名单（见 webui-server.ts）。
 */
export function registerWorkflowJournalIpcHandlers(userDataDir: string): void {
  instance = new WorkflowJournal(path.join(userDataDir, 'workflow-runs'))
  const journal = instance
  ipcMain.handle('workflowJournalPut', (_e, entry: WorkflowJournalEntry) => journal.put(entry))
  ipcMain.handle('workflowJournalList', () => journal.list())
  ipcMain.handle('workflowJournalSweep', () => journal.sweep())
}
