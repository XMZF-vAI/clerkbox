/**
 * 工作流 journal 落盘测试：put/list 的往返、损坏文件跳过、TTL/上限清扫。
 * 真 fs + 临时目录（抄 db.test.ts 的骨架），electron 只 mock ipcMain。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }))

import { WorkflowJournal, WORKFLOW_JOURNAL_MAX_RUNS, WORKFLOW_JOURNAL_TTL_MS } from '../electron/workflow-journal'

let dir: string

function makeEntry(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    sessionId: 's1',
    toolCallId: `call-${runId}`,
    assistantMessageId: `msg-${runId}`,
    name: '工作流',
    status: 'completed' as const,
    payload: { id: runId, status: 'completed' },
    savedAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-journal-test-'))
})

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发占用，容忍 */
  }
})

describe('WorkflowJournal', () => {
  it('put → list 往返；新近优先', async () => {
    const journal = new WorkflowJournal(dir)
    await journal.put(makeEntry('wf-1-a'))
    await new Promise((r) => setTimeout(r, 5))
    await journal.put(makeEntry('wf-2-b'))
    const entries = await journal.list()
    expect(entries.map((e) => e.runId)).toEqual(['wf-2-b', 'wf-1-a'])
    expect(entries[0]!.payload).toEqual({ id: 'wf-2-b', status: 'completed' })
  })

  it('非法 runId 拒写；目录缺失 list 返回空', async () => {
    const journal = new WorkflowJournal(dir)
    await journal.put(makeEntry('../../etc/passwd'))
    expect(await journal.list()).toHaveLength(0)
    const empty = new WorkflowJournal(path.join(dir, 'nope'))
    expect(await empty.list()).toEqual([])
  })

  it('损坏的 json 跳过，不炸整个恢复面', async () => {
    const journal = new WorkflowJournal(dir)
    await journal.put(makeEntry('wf-1-a'))
    fs.writeFileSync(path.join(dir, 'wf-2-broken.json'), '{ half', 'utf-8')
    const entries = await journal.list()
    expect(entries.map((e) => e.runId)).toEqual(['wf-1-a'])
  })

  it('sweep：TTL 过期删除、超限保留新近 MAX 份', async () => {
    const journal = new WorkflowJournal(dir)
    await journal.put(makeEntry('wf-1-old', { savedAt: Date.now() - WORKFLOW_JOURNAL_TTL_MS - 1000 }))
    for (let i = 0; i < WORKFLOW_JOURNAL_MAX_RUNS + 2; i++) {
      await journal.put(makeEntry(`wf-keep-${i}`))
      await new Promise((r) => setTimeout(r, 2))
    }
    await journal.sweep()
    const entries = await journal.list()
    expect(entries.some((e) => e.runId === 'wf-1-old')).toBe(false)
    expect(entries).toHaveLength(WORKFLOW_JOURNAL_MAX_RUNS)
    // 保留的应是最新的一批
    expect(entries[0]!.runId).toBe(`wf-keep-${WORKFLOW_JOURNAL_MAX_RUNS + 1}`)
  })

  it('remove / removeSession 按会话回收', async () => {
    const journal = new WorkflowJournal(dir)
    await journal.put(makeEntry('wf-1-a', { sessionId: 's-A' }))
    await journal.put(makeEntry('wf-2-b', { sessionId: 's-B' }))
    await journal.removeSession('s-A')
    const entries = await journal.list()
    expect(entries.map((e) => e.sessionId)).toEqual(['s-B'])
    await journal.remove('wf-2-b')
    expect(await journal.list()).toHaveLength(0)
  })
})
