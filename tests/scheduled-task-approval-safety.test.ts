import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 提案审批的安全性回归。
 *
 * 上一版有四个洞，每一个都对应用户「批准的东西」与「自己看到的东西」之间存在落差：
 *  1. prompt 最长 4000 字符，卡片只显示 2 行且无法展开 —— 用户在批准自己没看完的文字；
 *  2. acceptProposal 的 update 分支用 draft.workingDir 覆盖任务目录 —— 一个「只改措辞」
 *     的提案就能把任务搬到任意目录，而卡片上根本不显示目录；
 *  3. withProposalsLock 只是进程内互斥，双宿主各有一把，提案会被互相覆盖；
 *  4. 上限按「未过期」计数，用户批量批准后 24 小时内 agent 一条都提交不进来。
 */
const { kv, ipcStub, swallow } = vi.hoisted(() => {
  const kv = new Map<string, string>()
  // swallow > 0 时，接下来几次写提案会被「另一个进程」覆盖掉（丢掉刚写的那条）
  const swallow = { count: 0 }
  const ipcStub = {
    kvGet: vi.fn(async (key: string) => kv.get(key) ?? null),
    kvSet: vi.fn(async (key: string, value: string) => {
      if (key === 'clerkbox-scheduled-task-proposals' && swallow.count > 0) {
        swallow.count--
        const parsed = JSON.parse(value) as Array<{ id: string }>
        kv.set(key, JSON.stringify(parsed.slice(1)))
        return
      }
      kv.set(key, value)
    }),
    kvRemove: vi.fn(async (key: string) => {
      kv.delete(key)
    }),
    setKeepAwake: vi.fn(async () => {}),
  }
  return { kv, ipcStub, swallow }
})
vi.mock('../src/lib/ipc-client', () => ({ ipc: ipcStub, isWebUIMode: false }))

import {
  PROPOSALS_KV_KEY,
  TASKS_KV_KEY,
  MAX_PENDING_PROPOSALS,
  appendProposal,
} from '../src/lib/scheduled-task-proposal'
import { useScheduledTasksStore } from '../src/stores/scheduled-tasks-store'
import en from '../src/i18n/locales/en'
import zh from '../src/i18n/locales/zh-CN'
import type { ScheduledTaskDraft } from '../src/types/scheduled-task'

const store = () => useScheduledTasksStore.getState()

const draft = (over: Partial<ScheduledTaskDraft> = {}): ScheduledTaskDraft => ({
  name: '每日摘要',
  prompt: '汇总今天的提交。',
  schedule: { kind: 'daily', hour: 18, minute: 30 },
  model: null,
  enabled: true,
  ...over,
})

/** 播一个带指定字段的任务，供 update 提案去「试图修改」 */
function seedTask(fields: Partial<ScheduledTaskDraft> = {}) {
  return store().addTask(draft(fields))
}

beforeEach(() => {
  kv.clear()
  swallow.count = 0
  useScheduledTasksStore.setState({ tasks: [], runs: [], proposals: [], proposalDecisions: {} })
})

// ── 修 2：update 提案不得改动工作目录 / 启用状态 / 模型 ──

describe('update 提案只改内容', () => {
  it('任务原有工作目录不会被提案里的 working_dir 改掉', () => {
    const taskId = seedTask({ workingDir: 'C:\\work\\safe' })
    // 提案试图把目录搬到别处
    kv.set(
      PROPOSALS_KV_KEY,
      JSON.stringify([
        {
          id: 'p-move',
          action: 'update',
          taskId,
          taskName: '每日摘要',
          draft: draft({ name: '每日摘要（改名）', workingDir: 'C:\\Users\\victim\\.ssh' }),
          createdAt: Date.now(),
          expiresAt: Date.now() + 3_600_000,
        },
      ]),
    )
    store().proposals = JSON.parse(kv.get(PROPOSALS_KV_KEY) as string) as never

    expect(store().acceptProposal('p-move')).toBe(true)
    const task = store().tasks.find((t) => t.id === taskId)
    expect(task?.name).toBe('每日摘要（改名）')
    expect(task?.workingDir, '工作目录必须沿用，提案里传什么都不能改').toBe('C:\\work\\safe')
  })

  it('停用中的任务不会被 update 提案重新启用（老反例不能复发）', () => {
    const taskId = store().addTask(draft())
    store().setTaskEnabled(taskId, false)
    store().proposals = [
      {
        id: 'p-enable',
        action: 'update',
        taskId,
        taskName: '每日摘要',
        // parseTaskDraft 恒给 enabled: true，正是「提案里带着启用意图」的形态
        draft: draft({ name: '改名了' }),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      },
    ] as never

    expect(store().acceptProposal('p-enable')).toBe(true)
    expect(store().tasks.find((t) => t.id === taskId)?.enabled).toBe(false)
  })

  it('模型覆盖也不会被提案顺手改掉', () => {
    const taskId = store().addTask(draft({ model: { providerId: 'p1', modelId: 'm-keep' } }))
    store().proposals = [
      {
        id: 'p-model',
        action: 'update',
        taskId,
        taskName: '每日摘要',
        draft: draft({ model: { providerId: 'pX', modelId: 'm-new' } }),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      },
    ] as never

    expect(store().acceptProposal('p-model')).toBe(true)
    expect(store().tasks.find((t) => t.id === taskId)?.model).toEqual({ providerId: 'p1', modelId: 'm-keep' })
  })
})

// ── 修 3：跨进程写覆盖要能自愈，失败必须明说 ──

describe('提案落盘的写后回读', () => {
  it('被另一个进程覆盖一次后重试成功（提案不丢）', async () => {
    swallow.count = 1
    const result = await appendProposal({ action: 'create', draft: draft() })
    expect('error' in result).toBe(false)
    const stored = JSON.parse(kv.get(PROPOSALS_KV_KEY) as string) as Array<{ id: string }>
    expect(stored.some((p) => p.id === (result as { id: string }).id), '重试后提案必须在场').toBe(true)
  })

  it('连续被覆盖到超限则明确报错，绝不假装提交成功', async () => {
    swallow.count = 99
    const result = await appendProposal({ action: 'create', draft: draft() })
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toMatch(/could not be stored/)
    expect((result as { error: string }).error).toMatch(/did NOT get submitted/)
  })
})

// ── 修 4：上限按「待确认」计数 ──

describe('待确认提案上限', () => {
  it('已裁决的记录不占名额（批量批准后仍能继续提交）', async () => {
    const now = Date.now()
    const decided = Array.from({ length: MAX_PENDING_PROPOSALS }, (_, i) => ({
      id: `done-${i}`,
      action: 'create' as const,
      draft: draft(),
      createdAt: now - 1000,
      expiresAt: now + 3_600_000,
    }))
    kv.set(PROPOSALS_KV_KEY, JSON.stringify(decided))
    // 全部标记为已裁决
    kv.set(
      TASKS_KV_KEY,
      JSON.stringify({
        state: {
          tasks: [],
          runs: [],
          proposalDecisions: Object.fromEntries(decided.map((d) => [d.id, { decision: 'accepted', at: now }])),
        },
        version: 1,
      }),
    )

    const result = await appendProposal({ action: 'create', draft: draft() })
    expect('error' in result, '20 条已裁决的不该把名额占满').toBe(false)
  })

  it('真正待确认的满 20 条仍然拒绝', async () => {
    const now = Date.now()
    kv.set(
      PROPOSALS_KV_KEY,
      JSON.stringify(
        Array.from({ length: MAX_PENDING_PROPOSALS }, (_, i) => ({
          id: `live-${i}`,
          action: 'create' as const,
          draft: draft(),
          createdAt: now,
          expiresAt: now + 3_600_000,
        })),
      ),
    )
    const result = await appendProposal({ action: 'create', draft: draft() })
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toMatch(/already waiting/)
  })
})

// ── 修 1：长 prompt 不能被无条件折叠 ──

describe('提案卡的 prompt 可见性', () => {
  const page = () =>
    fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'scheduled', 'ScheduledTasksPage.tsx'), 'utf-8')

  it('prompt 不再无条件 line-clamp-2（折叠必须由展开状态决定）', () => {
    const source = page()
    expect(source).toMatch(/promptExpanded\s*\?\s*''\s*:\s*'line-clamp-2'/)
    // 折叠状态下仍允许 2 行，但有展开按钮兜底
    expect(source).toContain('promptExpand')
    expect(source).toContain('promptCollapse')
  })

  it('折叠阈值有常量，且卡片按提案动作展示工作目录', () => {
    const source = page()
    expect(source).toContain('PROMPT_CLAMP_CHARS')
    expect(source).toContain("proposal.action === 'create' && proposal.draft?.workingDir")
    expect(source).toContain("proposal.action === 'update'")
  })

  it('新增的四个文案键双语都在', () => {
    type ProposalDict = { scheduledTasks: { proposal: Record<string, string> } }
    const zhProposal = (zh as unknown as ProposalDict).scheduledTasks.proposal
    const enProposal = (en as unknown as ProposalDict).scheduledTasks.proposal
    for (const key of ['promptExpand', 'promptCollapse', 'workDir', 'workDirKept'] as const) {
      expect(zhProposal[key], `zh.${key}`).toBeTruthy()
      expect(enProposal[key], `en.${key}`).toBeTruthy()
    }
  })
})
