import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 智能体侧定时任务工具的桩：工具只经 ipc 门面读写主进程 KV（不碰 zustand），
 * 因为宿主模式（agentHostMode=main）下工具跑在主进程，那里没有渲染层 store。
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
    executeCommandWithShell: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' })),
  }
  return { kv, ipcStub }
})
vi.mock('../src/lib/ipc-client', () => ({ ipc: ipcStub, isWebUIMode: false }))

import { toolRegistry } from '../src/lib/tool-registry'
import {
  MAX_PENDING_PROPOSALS,
  PROPOSALS_KV_KEY,
  TASKS_KV_KEY,
  parseTaskSchedule,
  readPendingProposals,
  scheduleForModel,
} from '../src/lib/scheduled-task-proposal'
import { SCHEDULE_TOOLS, SCHEDULE_TOOL_NAME, executeScheduledTaskTool } from '../src/lib/scheduled-task-tool'
import type { ScheduledTask } from '../src/types/scheduled-task'

const CTX = { sessionId: 's-current', workingDir: 'C:\\work\\proj' }

const task = (over: Partial<ScheduledTask> & { id: string; name: string }): ScheduledTask => ({
  prompt: '总结今天的提交',
  schedule: { kind: 'weekdays', hour: 18, minute: 30 },
  enabled: true,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  lastRunAt: 0,
  ...over,
})

/** 按定时任务 store 的 persist 信封写任务表（工具只读它） */
function seedTasks(tasks: ScheduledTask[], decisions: Record<string, unknown> = {}) {
  kv.set(TASKS_KV_KEY, JSON.stringify({ state: { tasks, runs: [], keepAwake: false, proposalDecisions: decisions }, version: 1 }))
}

function seedProposals(records: unknown[]) {
  kv.set(PROPOSALS_KV_KEY, JSON.stringify(records))
}

const readProposals = async () => JSON.parse(kv.get(PROPOSALS_KV_KEY) ?? '[]') as Array<Record<string, unknown>>

const validCreateArgs = {
  action: 'create',
  name: '每日提交摘要',
  prompt: '汇总本仓库今天的提交，输出三条要点。',
  schedule: { kind: 'daily', hour: 18, minute: 30 },
}

beforeEach(() => {
  kv.clear()
  vi.clearAllMocks()
})

describe('工具注册与模式可见性', () => {
  it('定义齐备：描述非空、参数是 object、action 必填', () => {
    expect(SCHEDULE_TOOLS).toHaveLength(1)
    const [definition] = SCHEDULE_TOOLS
    expect(definition.description.trim().length).toBeGreaterThan(0)
    expect(definition.parameters).toMatchObject({ type: 'object', required: ['action'] })
    expect(toolRegistry.definitions.map((d) => d.name)).toContain(SCHEDULE_TOOL_NAME)
  })

  it('除 dsh-minimal 外每种兼容模式都能用（它不是模仿上游工具名，属额外能力）', () => {
    const namesFor = (mode: 'default' | 'zcode' | 'dsh' | 'codex' | 'grok-build' | 'dsh-minimal') =>
      toolRegistry.getDefinitionsForMode(mode).map((d) => d.name)
    for (const mode of ['default', 'zcode', 'dsh', 'codex', 'grok-build'] as const) {
      expect(namesFor(mode), mode).toContain(SCHEDULE_TOOL_NAME)
    }
    expect(namesFor('dsh-minimal')).not.toContain(SCHEDULE_TOOL_NAME)
  })

  it('未知名与非法 action 都回 Error 前缀（loop 靠这个前缀判错）', async () => {
    expect(await executeScheduledTaskTool('other_tool', {}, CTX)).toContain('unknown tool')
    const bad = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'teleport' }, CTX)
    expect(bad.startsWith('Error')).toBe(true)
  })
})

describe('计划校验：只认周期 + 本地时刻', () => {
  /** 取解析失败的消息（成功时直接让断言炸掉，避免测试里到处写三元） */
  const errorOf = (result: ReturnType<typeof parseTaskSchedule>): string => {
    if (result.ok) throw new Error('expected a parse failure')
    return result.error
  }

  it('四种周期都能解析，weekly/monthly 补齐约束字段', () => {
    const weekly = parseTaskSchedule({ kind: 'weekly', weekday: 2, hour: 10, minute: 0 })
    expect(weekly.ok && weekly.value).toEqual({ kind: 'weekly', hour: 10, minute: 0, weekday: 2 })
    const monthly = parseTaskSchedule({ kind: 'monthly', month_day: 28, hour: 9, minute: 5 })
    expect(monthly.ok).toBe(true)
    if (!monthly.ok) return
    expect(monthly.value.monthDay).toBe(28)
    expect(scheduleForModel(monthly.value)).toBe('monthly on day 28 09:05')
  })

  it('一次性计划给出可转述的拒绝理由，而不是含糊报错', () => {
    for (const kind of ['once', 'interval', 'tomorrow', 'in_20_minutes']) {
      const error = errorOf(parseTaskSchedule({ kind, hour: 9, minute: 0 }))
      expect(error.startsWith('Error'), kind).toBe(true)
      expect(error, kind).toMatch(/one-shot schedule .* is not supported/)
      expect(error, kind).toMatch(/recurring only/)
    }
    // 字段级的一次性写法同样拒绝
    expect(errorOf(parseTaskSchedule({ kind: 'daily', at: '2026-09-28T09:00:00', hour: 9, minute: 0 })))
      .toMatch(/schedule.at is not supported/)
  })

  it('越界与缺字段逐个报错，绝不静默纠正', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'daily', hour: 24, minute: 0 }, 'schedule.hour must be between 0 and 23'],
      [{ kind: 'daily', hour: 9, minute: 60 }, 'schedule.minute must be between 0 and 59'],
      [{ kind: 'daily', hour: 9.5, minute: 0 }, 'whole number'],
      [{ kind: 'weekly', hour: 9, minute: 0 }, 'schedule.weekday'],
      [{ kind: 'weekly', weekday: 7, hour: 9, minute: 0 }, 'schedule.weekday'],
      [{ kind: 'monthly', hour: 9, minute: 0 }, 'schedule.month_day'],
      [{ kind: 'monthly', month_day: 29, hour: 9, minute: 0 }, 'schedule.month_day'],
      [{ kind: 'hourly', hour: 9, minute: 0 }, 'invalid; expected daily'],
      [{ kind: 'daily' }, 'schedule.hour'],
    ]
    for (const [input, expected] of cases) {
      const error = errorOf(parseTaskSchedule(input))
      expect(error, JSON.stringify(input)).toContain(expected)
    }
  })
})

describe('create：只提交提案', () => {
  it('提案落 KV，含来源会话与有效期，并明确告知尚未生效', async () => {
    const result = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { ...validCreateArgs, reason: '你上周说要每天收工前看提交' }, CTX)
    expect(result).toContain('Proposal')
    expect(result).toContain('NOT scheduled yet')
    const records = await readProposals()
    expect(records).toHaveLength(1)
    const [proposal] = records
    expect(proposal).toMatchObject({
      action: 'create',
      sessionId: 's-current',
      rationale: '你上周说要每天收工前看提交',
    })
    const draft = proposal?.draft as Record<string, unknown>
    expect(draft).toMatchObject({ name: '每日提交摘要', enabled: true })
    expect((proposal?.expiresAt as number) - (proposal?.createdAt as number)).toBeGreaterThan(0)
    // 任务表没被写过：提案在用户确认前对调度器不可见
    expect(kv.has(TASKS_KV_KEY)).toBe(false)
  })

  it('同名同计划的任务已存在时提醒模型，避免重复建', async () => {
    seedTasks([task({ id: 'task-1', name: '既有摘要' })])
    const result = await executeScheduledTaskTool(
      SCHEDULE_TOOL_NAME,
      { ...validCreateArgs, schedule: { kind: 'weekdays', hour: 18, minute: 30 } },
      CTX,
    )
    expect(result).toMatch(/already covers this same plan/)
    expect(result).toMatch(/task-1/)
  })

  it('内容残缺或超长一律拒绝', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'create', prompt: 'x', schedule: { kind: 'daily', hour: 1, minute: 0 } }, 'name is required'],
      [{ action: 'create', name: 'n', schedule: { kind: 'daily', hour: 1, minute: 0 } }, 'prompt is required'],
      [{ action: 'create', name: 'n', prompt: '  ', schedule: { kind: 'daily', hour: 1, minute: 0 } }, 'prompt is required'],
      [{ action: 'create', name: '名'.repeat(61), prompt: 'p', schedule: { kind: 'daily', hour: 1, minute: 0 } }, 'name is too long'],
      [{ action: 'create', name: 'n', prompt: 'p'.repeat(4001), schedule: { kind: 'daily', hour: 1, minute: 0 } }, 'prompt is too long'],
      [{ action: 'create', name: 'n', prompt: 'p', schedule: { kind: 'daily', hour: 1, minute: 0 }, working_dir: 'a\nb' }, 'working_dir is invalid'],
    ]
    for (const [args, expected] of cases) {
      const result = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, args, CTX)
      expect(result.startsWith('Error'), JSON.stringify(args)).toBe(true)
      expect(result, JSON.stringify(args)).toContain(expected)
    }
    expect(await readProposals()).toHaveLength(0)
  })

  it('待确认积压到上限时不再追加', async () => {
    const now = Date.now()
    seedProposals(
      Array.from({ length: MAX_PENDING_PROPOSALS }, (_, index) => ({
        id: `proposal-${index}`,
        action: 'create',
        createdAt: now,
        expiresAt: now + 3_600_000,
      })),
    )
    const result = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, validCreateArgs, CTX)
    expect(result.startsWith('Error'), result).toBe(true)
    expect(result).toMatch(/already waiting/)
  })
})

describe('update / delete / set_enabled：同样只提交提案', () => {
  beforeEach(() => {
    seedTasks([
      task({ id: 'task-1', name: '每日提交摘要', enabled: true }),
      task({ id: 'task-2', name: '周报', enabled: false, schedule: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 }, model: { providerId: 'p1', modelId: 'm1' } }),
    ])
  })

  it('未知 task_id 指向 action="list"，不猜目标任务', async () => {
    for (const action of ['update', 'delete', 'set_enabled']) {
      const missingId = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action }, CTX)
      expect(missingId.startsWith('Error'), action).toBe(true)
      expect(missingId, action).toMatch(/task_id/)
      const unknown = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action, task_id: 'nope', enabled: true, name: 'n', prompt: 'p', schedule: { kind: 'daily', hour: 1, minute: 0 } }, CTX)
      expect(unknown, action).toMatch(/no scheduled task with id "nope"/)
    }
    expect(await readProposals()).toHaveLength(0)
  })

  it('update 只把内容写进提案：启用状态与模型留给确认时的任务当前值', async () => {
    const result = await executeScheduledTaskTool(
      SCHEDULE_TOOL_NAME,
      { action: 'update', task_id: 'task-2', name: '周报（改）', prompt: '汇总本周', schedule: { kind: 'weekly', weekday: 3, hour: 17, minute: 0 } },
      CTX,
    )
    expect(result).toContain('Proposal')
    const [proposal] = await readProposals()
    expect(proposal).toMatchObject({ action: 'update', taskId: 'task-2', taskName: '周报' })
    const draft = proposal.draft as Record<string, unknown>
    expect(draft).toMatchObject({
      name: '周报（改）',
      model: null,
      schedule: { kind: 'weekly', weekday: 3, hour: 17, minute: 0 },
    })
    expect(draft.workingDir).toBeUndefined()
  })

  it('update 要求整份内容，报错时说明原因', async () => {
    const result = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'update', task_id: 'task-1', name: '只给名字' }, CTX)
    expect(result.startsWith('Error'), result).toBe(true)
    expect(result).toMatch(/update replaces the whole task content/)
  })

  it('delete 带目标任务名快照；set_enabled 要求布尔且状态相同不提案', async () => {
    const removed = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'delete', task_id: 'task-1', reason: '你说不再需要' }, CTX)
    expect(removed).toMatch(/still in place/)
    const [deleteProposal] = await readProposals()
    expect(deleteProposal).toMatchObject({ action: 'delete', taskId: 'task-1', taskName: '每日提交摘要' })
    expect(deleteProposal.draft).toBeUndefined()

    const sameState = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'set_enabled', task_id: 'task-1', enabled: true }, CTX)
    expect(sameState).toMatch(/already enabled; nothing to propose/)

    const notBool = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'set_enabled', task_id: 'task-2', enabled: 'yes' }, CTX)
    expect(notBool.startsWith('Error'), notBool).toBe(true)
    expect(notBool).toMatch(/enabled as a boolean/)

    const flipped = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'set_enabled', task_id: 'task-2', enabled: true }, CTX)
    expect(flipped).toContain('Proposal')
    const proposals = await readProposals()
    expect(proposals).toHaveLength(2)
    expect(proposals[0]).toMatchObject({ action: 'set_enabled', taskId: 'task-2', enabled: true })
  })
})

describe('list：任务与待确认提案一起给', () => {
  it('任务表为空时也给出明确结论', async () => {
    const result = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'list' }, CTX)
    expect(result).toMatch(/Scheduled tasks: none yet/)
    expect(result).toMatch(/Pending proposals awaiting the user: none/)
  })

  it('回吐 id、启用状态、计划摘要、工作目录与提案计数', async () => {
    seedTasks([task({ id: 'task-1', name: '每日提交摘要', workingDir: 'C:\\work\\demo' })])
    const now = Date.now()
    seedProposals([
      { id: 'proposal-live', action: 'create', draft: { name: '新提案', prompt: 'p', schedule: { kind: 'daily', hour: 7, minute: 0 } }, createdAt: now, expiresAt: now + 3_600_000 },
      { id: 'proposal-expired', action: 'delete', taskId: 'task-1', taskName: '每日提交摘要', createdAt: now - 100_000, expiresAt: now - 1 },
      { id: 'proposal-decided', action: 'update', taskId: 'task-1', taskName: '每日提交摘要', createdAt: now, expiresAt: now + 3_600_000 },
    ])
    kv.set(TASKS_KV_KEY, JSON.stringify({
      state: { tasks: [task({ id: 'task-1', name: '每日提交摘要', workingDir: 'C:\\work\\demo' })], proposalDecisions: { 'proposal-decided': { decision: 'accepted', at: now } } },
      version: 1,
    }))

    const result = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'list' }, CTX)
    // dir= 必须回吐：否则模型改任务内容时会把原工作目录抹掉
    expect(result).toMatch(/- id=task-1 \| enabled \| 每日提交摘要 \| weekdays 18:30 \| dir=C:\\work\\demo/)
    expect(result).toMatch(/Pending proposals awaiting the user \(1\)/)
    expect(result).toMatch(/create .*新提案.* daily 07:00/)
    // 过期与已裁决的提案不再列为待确认
    const pending = await readPendingProposals()
    expect(pending.map((item) => item.id)).toEqual(['proposal-live'])
  })

  it('脏提案记录逐条丢弃，不让待确认列表打死', async () => {
    const now = Date.now()
    const fresh = { createdAt: now, expiresAt: now + 3_600_000 }
    seedProposals([
      null,
      { id: '', action: 'create', ...fresh },
      { action: 'create', createdAt: now },
      { id: 'ok', action: 'not_an_action', ...fresh },
      { id: 'ok-2', action: 'delete', taskId: 't', ...fresh },
    ])
    const result = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'list' }, CTX)
    expect(result).toMatch(/Pending proposals awaiting the user \(1\)/)
    expect(result).toContain('ok-2')
  })

  it('KV 读失败时不抛异常，返回空表结论', async () => {
    ipcStub.kvGet.mockRejectedValueOnce(new Error('kv down'))
    ipcStub.kvGet.mockRejectedValueOnce(new Error('kv down'))
    const result = await executeScheduledTaskTool(SCHEDULE_TOOL_NAME, { action: 'list' }, CTX)
    expect(result).toMatch(/none yet/)
  })
})
