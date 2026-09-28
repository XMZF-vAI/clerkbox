import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 定时任务 store 的提案裁决链路。
 *
 * 这份测试钉的是「谁写哪份数据」这条不变量：提案本体由提交侧（工具）写独立 KV key，
 * 渲染层只读；用户的裁决记在任务 store（渲染层单写）。所以确认提案必须经既有
 * addTask/updateTask/removeTask/setTaskEnabled 落任务表，而不是另开一条写入路径。
 */
const { kv, ipcStub } = vi.hoisted(() => {
  const kv = new Map<string, string>()
  const ipcStub = {
    kvGet: vi.fn(async (key: string) => kv.get(key) ?? null),
    kvSet: vi.fn(async (key: string, value: string) => {
      kv.set(key, value)
    }),
    kvRemove: vi.fn(async (key: string) => {
      kv.delete(key)
    }),
    setKeepAwake: vi.fn(async () => {}),
  }
  return { kv, ipcStub }
})
vi.mock('../src/lib/ipc-client', () => ({ ipc: ipcStub, isWebUIMode: false }))

import {
  PROPOSALS_KV_KEY,
  TASKS_KV_KEY,
  appendProposal,
} from '../src/lib/scheduled-task-proposal'
import {
  isProposalApplicable,
  useScheduledTasksStore,
} from '../src/stores/scheduled-tasks-store'
import en from '../src/i18n/locales/en'
import zh from '../src/i18n/locales/zh-CN'
import type { ScheduledTaskDraft, ScheduledTaskProposal } from '../src/types/scheduled-task'

const dailyDraft: ScheduledTaskDraft = {
  name: '每日提交摘要',
  prompt: '汇总本仓库今天的提交。',
  schedule: { kind: 'daily', hour: 18, minute: 30 },
  model: null,
  enabled: true,
}

const store = () => useScheduledTasksStore.getState()

/** 直接写提案 KV（模拟跨进程提交侧的落盘结果，可控制过期时间等字段） */
function seedProposalRecords(records: Array<Partial<ScheduledTaskProposal> & { id: string }>) {
  const now = Date.now()
  kv.set(
    PROPOSALS_KV_KEY,
    JSON.stringify(records.map((record) => ({ action: 'create', draft: dailyDraft, createdAt: now, expiresAt: now + 3_600_000, ...record }))),
  )
}

/** 直接写任务表 KV 里的裁决留痕（readPendingProposals 靠它过滤） */
function seedDecisions(decisions: Record<string, unknown>) {
  const existing = JSON.parse(kv.get(TASKS_KV_KEY) ?? '{}') as Record<string, unknown>
  const state = (existing.state ?? {}) as Record<string, unknown>
  kv.set(TASKS_KV_KEY, JSON.stringify({ ...existing, state: { ...state, proposalDecisions: decisions }, version: 1 }))
}

beforeEach(() => {
  kv.clear()
  useScheduledTasksStore.setState({ tasks: [], runs: [], proposals: [], proposalDecisions: {}, queue: [] })
})

describe('refreshProposals', () => {
  it('列出来自提交侧的待确认提案，过期与已裁决的不列', async () => {
    const now = Date.now()
    seedProposalRecords([
      { id: 'live' },
      { id: 'expired', createdAt: now - 100_000, expiresAt: now - 1 },
      { id: 'decided' },
    ])
    seedDecisions({ decided: { decision: 'accepted', at: now } })

    await store().refreshProposals()
    expect(store().proposals.map((item) => item.id)).toEqual(['live'])
  })

  it('内容与顺序未变时保持同一数组引用（心跳不该让页面重渲染）', async () => {
    seedProposalRecords([{ id: 'a' }, { id: 'b' }])
    await store().refreshProposals()
    const first = store().proposals
    await store().refreshProposals()
    expect(store().proposals).toBe(first)
    // 新提案插到队首 → 引用换掉
    await appendProposal({ action: 'create', draft: dailyDraft })
    await store().refreshProposals()
    expect(store().proposals).not.toBe(first)
    expect(store().proposals[0].id).not.toBe('a')
  })
})

describe('acceptProposal：只经既有任务写入路径生效', () => {
  it('update 只改内容：启用状态、模型、工作目录沿用任务当前值', async () => {
    const id = store().addTask({ ...dailyDraft, workingDir: 'C:\\work\\keep-me' })
    store().setTaskEnabled(id, false)
    const originalModel = { providerId: 'p1', modelId: 'm1' }
    store().updateTask(id, { ...dailyDraft, workingDir: 'C:\\work\\keep-me', enabled: false, model: originalModel })
    // 故意在 draft 里塞 enabled:true：确认时不该被它翻掉（曾被它悄悄重新启用）
    seedProposalRecords([
      { id: 'p-update', action: 'update', taskId: id, taskName: dailyDraft.name, draft: { ...dailyDraft, enabled: true } },
    ])
    await store().refreshProposals()

    expect(store().acceptProposal('p-update')).toBe(true)
    const updated = store().tasks.find((task) => task.id === id)
    expect(updated).toMatchObject({
      name: dailyDraft.name,
      prompt: dailyDraft.prompt,
      enabled: false,
      model: originalModel,
      workingDir: 'C:\\work\\keep-me',
    })
  })

  it('update 命中已被删除的任务时拒绝落地', async () => {
    const id = store().addTask(dailyDraft)
    seedProposalRecords([{ id: 'p-update', action: 'update', taskId: id, taskName: dailyDraft.name, draft: dailyDraft }])
    await store().refreshProposals()
    store().removeTask(id)
    expect(store().acceptProposal('p-update')).toBe(false)
    expect(store().proposals.map((item) => item.id)).toEqual(['p-update'])
  })

  it('create → 进任务表并保持启用，同时留下裁决留痕', async () => {
    seedProposalRecords([{ id: 'p-create', action: 'create', draft: dailyDraft, sessionId: 's-1' }])
    await store().refreshProposals()

    expect(store().acceptProposal('p-create')).toBe(true)
    const task = store().tasks.find((item) => item.name === dailyDraft.name)
    expect(task).toMatchObject({ enabled: true, prompt: dailyDraft.prompt, schedule: dailyDraft.schedule })
    expect(task?.lastRunAt).toBeGreaterThan(0)
    expect(store().proposals).toHaveLength(0)
    expect(store().proposalDecisions['p-create']).toMatchObject({ decision: 'accepted' })
  })

  it('update / delete / set_enabled 各自命中目标任务', async () => {
    const id = store().addTask(dailyDraft)
    const other = store().addTask({ ...dailyDraft, name: '周报', enabled: false })
    seedProposalRecords([
      { id: 'p-update', action: 'update', taskId: id, taskName: dailyDraft.name, draft: { ...dailyDraft, name: '改名后的摘要' } },
      { id: 'p-toggle', action: 'set_enabled', taskId: other, taskName: '周报', enabled: true },
      { id: 'p-delete', action: 'delete', taskId: id, taskName: dailyDraft.name },
    ])
    await store().refreshProposals()

    expect(store().acceptProposal('p-toggle')).toBe(true)
    expect(store().tasks.find((task) => task.id === other)?.enabled).toBe(true)

    expect(store().acceptProposal('p-update')).toBe(true)
    const updated = store().tasks.find((task) => task.id === id)
    expect(updated).toMatchObject({ name: '改名后的摘要', enabled: true })

    expect(store().acceptProposal('p-delete')).toBe(true)
    expect(store().tasks.find((task) => task.id === id)).toBeUndefined()
    expect(store().proposals).toHaveLength(0)
  })

  it('目标任务已不存在时拒绝落地且不改动任何状态（界面此时只给「忽略」）', async () => {
    seedProposalRecords([{ id: 'p-ghost', action: 'delete', taskId: 'gone', taskName: '已消失的任务' }])
    await store().refreshProposals()

    expect(store().acceptProposal('p-ghost')).toBe(false)
    expect(store().proposalDecisions['p-ghost']).toBeUndefined()
    expect(store().proposals.map((item) => item.id)).toEqual(['p-ghost'])
    // 忽略仍然可用：留痕后卡片不再回来
    store().rejectProposal('p-ghost')
    expect(store().proposalDecisions['p-ghost']).toMatchObject({ decision: 'rejected' })
    await store().refreshProposals()
    expect(store().proposals).toHaveLength(0)
  })

  it('未知 id 与重复确认都不炸', async () => {
    expect(store().acceptProposal('nope')).toBe(false)
    expect(store().rejectProposal('nope')).toBeUndefined()
    seedProposalRecords([{ id: 'p-once' }])
    await store().refreshProposals()
    expect(store().acceptProposal('p-once')).toBe(true)
    expect(store().acceptProposal('p-once')).toBe(false)
    expect(store().tasks).toHaveLength(1)
  })
})

describe('裁决留痕不无限增长', () => {
  it('超出保留期的旧留痕在下一次裁决时被剪掉', async () => {
    const now = Date.now()
    useScheduledTasksStore.setState({
      proposalDecisions: {
        ancient: { decision: 'rejected', at: now - 30 * 24 * 60 * 60 * 1000 },
        fresh: { decision: 'accepted', at: now - 60_000 },
      },
    })
    seedProposalRecords([{ id: 'p-new' }])
    await store().refreshProposals()
    store().acceptProposal('p-new')

    const decisions = store().proposalDecisions
    expect(decisions.ancient).toBeUndefined()
    expect(decisions.fresh).toBeTruthy()
    expect(decisions['p-new']).toMatchObject({ decision: 'accepted' })
  })

  it('留痕会持久化，重启后仍能把已处理过的提案滤掉', async () => {
    seedProposalRecords([{ id: 'p-seen' }])
    await store().refreshProposals()
    store().rejectProposal('p-seen')
    // zustand persist 写入是异步 promise，等它落进 KV
    await new Promise((resolve) => setTimeout(resolve, 0))
    const persisted = JSON.parse(kv.get(TASKS_KV_KEY) ?? '{}') as { state?: { proposalDecisions?: Record<string, unknown> } }
    expect(persisted.state?.proposalDecisions?.['p-seen']).toMatchObject({ decision: 'rejected' })
  })
})

describe('isProposalApplicable', () => {
  const proposal = (over: Partial<ScheduledTaskProposal>): ScheduledTaskProposal => ({
    id: 'p',
    action: 'create',
    draft: dailyDraft,
    createdAt: 1,
    expiresAt: 2,
    ...over,
  })

  it('create 看内容，其余看目标任务是否还在', () => {
    const tasks = [{ id: 't1', name: 'a', prompt: 'p', schedule: dailyDraft.schedule, enabled: true, createdAt: 1, updatedAt: 1 }]
    expect(isProposalApplicable(proposal({}), tasks)).toBe(true)
    expect(isProposalApplicable(proposal({ draft: undefined }), tasks)).toBe(false)
    expect(isProposalApplicable(proposal({ action: 'delete', taskId: 't1' }), tasks)).toBe(true)
    expect(isProposalApplicable(proposal({ action: 'delete', taskId: 't2' }), tasks)).toBe(false)
    expect(isProposalApplicable(proposal({ action: 'update', taskId: 't1', draft: undefined }), tasks)).toBe(false)
    expect(isProposalApplicable(proposal({ action: 'set_enabled', taskId: 't1', enabled: false }), tasks)).toBe(true)
  })
})

/**
 * 提案卡片与工具芯片的文案锁。
 *
 * ScheduledTasksPage 里的 PROPOSAL_ACTION_LABEL_KEY 是「完整 key 路径的常量表」，
 * 而 tests/i18n-keys.test.ts 只扫字面量 t('x.y') 调用，够不着它 —— 漏一个键界面会直接
 * 把 'scheduledTasks.proposal.actionDelete' 这类原始串渲染给用户。这里按组件实际用到的
 * 键逐个点名，两份语言缺一即红。
 */
describe('提案界面文案双语齐备', () => {
  const PROPOSAL_KEYS = [
    'sectionTitle',
    'sectionHint',
    'actionCreate',
    'actionUpdate',
    'actionDelete',
    'actionSetEnabled',
    'targetTask',
    'enabledTo',
    'enabledOn',
    'enabledOff',
    'reason',
    'expiresIn',
    'accept',
    'reject',
    'taskMissing',
    'viewSession',
  ]

  it(`scheduledTasks.proposal.* 全部 ${PROPOSAL_KEYS.length} 个键在中英双语都有非空字符串`, () => {
    for (const key of PROPOSAL_KEYS) {
      const zhValue = (zh as { scheduledTasks?: { proposal?: Record<string, unknown> } }).scheduledTasks?.proposal?.[key]
      const enValue = (en as { scheduledTasks?: { proposal?: Record<string, unknown> } }).scheduledTasks?.proposal?.[key]
      expect(typeof zhValue, `zh scheduledTasks.proposal.${key}`).toBe('string')
      expect(String(zhValue).trim().length, `zh scheduledTasks.proposal.${key} 非空`).toBeGreaterThan(0)
      expect(typeof enValue, `en scheduledTasks.proposal.${key}`).toBe('string')
      expect(String(enValue).trim().length, `en scheduledTasks.proposal.${key} 非空`).toBeGreaterThan(0)
    }
  })

  it('工具芯片有名字（缺失时聊天区会显示裸工具名）', () => {
    for (const locale of [zh, en]) {
      const label = (locale as { tools?: Record<string, unknown> }).tools?.scheduled_task
      expect(typeof label).toBe('string')
      expect(String(label).trim().length).toBeGreaterThan(0)
    }
  })
})
