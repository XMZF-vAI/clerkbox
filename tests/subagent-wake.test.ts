/**
 * 后台任务空闲唤醒（v2 工作流 + 权限三期子代理）。
 * 源码文本断言：两种宿主都有入口、四条终态都入队并唤醒、唤醒轮守卫齐备。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const loop = read('src/agent-core/loop.ts')
const useAgent = read('src/hooks/use-agent.ts')
const host = read('electron/agent-host.ts')
const workflowTools = read('src/lib/workflow-tools.ts')

describe('后台子代理终态唤醒', () => {
  it('四条终态通知统一经 pushSubagentNotification（入队 + requestWake）', () => {
    const pushes = loop.match(/pushSubagentNotification\(ctx, formatSubagentNotification\(/g) ?? []
    expect(pushes.length).toBe(4)
    expect(loop).toContain('ctx.pendingSubagentNotifications.push(text)')
    expect(loop).toContain('ctx.requestWake?.()')
    expect(loop).not.toContain('ctx.pendingSubagentNotifications.push(formatSubagentNotification(')
  })
})

describe('两种宿主都装配唤醒', () => {
  it('渲染层：wakeSession 守卫齐全 + ctx.requestWake 挂载', () => {
    expect(useAgent).toContain('const wakeSession = useCallback')
    expect(useAgent).toContain('if (state.streamingSessionIds.has(sessionId)) return')
    expect(useAgent).toContain('if (ctx.pendingSubagentNotifications.length === 0) return')
    expect(useAgent).toContain('ctx.requestWake = () => wakeFnRef.current?.()')
  })

  it('主进程宿主：wakeIdleSession + startRun 的 wake 分支不落 user 消息', () => {
    expect(host).toContain('ctx.requestWake = () => this.wakeIdleSession(s)')
    expect(host).toContain('private wakeIdleSession(s: HostSession): void')
    expect(host).toContain('if (s.run || ctx.pendingSubagentNotifications.length === 0) return')
    expect(host).toContain('void this.startRun(s, { ...cmd, content: \'\' }, { wake: true })')
    expect(host).toContain('const userMsg: Message | null = meta.wake ? null : {')
    expect(host).toContain('if (userMsg) this.persistMessage(s, userMsg)')
    expect(host).toContain('!userMsg ? history')
  })

  it('工作流 settle 仍沿用同一 requestWake 桥（aborted 不唤醒）', () => {
    expect(workflowTools).toContain("if (run.status !== 'aborted') bridge.requestWake()")
  })
})
