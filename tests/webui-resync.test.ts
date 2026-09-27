/**
 * 缺口补发的远程契约（批次 B · P5）。
 *
 * 锁两件事：
 *  1. /api/agent/resync 是**触发器**，不是数据通道——响应里永远没有事件环；
 *  2. 渲染层在 WebUI 下走这条触发器，而不是被黑名单挡死的 agent:snapshot
 *     （挡死时的表现是薄客户端每次缺口都 403，连接卡在 reconnecting 退避循环里）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'

// webui-server 顶部 import { app } from 'electron'（仅启动 WebUI 时用），测试里打桩
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { parseAgentResyncBody } from '../electron/webui-server'
import { ipc } from '../src/lib/ipc-client'

describe('/api/agent/resync 请求体解析', () => {
  it('形状不对一律回 null（交给路由层报 400，不猜语义）', () => {
    expect(parseAgentResyncBody(null)).toBeNull()
    expect(parseAgentResyncBody('{"sinceSeq":1}')).toBeNull()
    expect(parseAgentResyncBody([1, 2])).toBeNull()
  })

  it('空对象按「从头回放」处理', () => {
    expect(parseAgentResyncBody({})).toEqual({ sessionId: undefined, sinceSeq: 0 })
  })

  it('sinceSeq 归一到非负整数，sessionId 只接受非空字符串', () => {
    expect(parseAgentResyncBody({ sinceSeq: -7, sessionId: 's1' })).toEqual({ sessionId: 's1', sinceSeq: 0 })
    expect(parseAgentResyncBody({ sinceSeq: 12.9 })).toEqual({ sessionId: undefined, sinceSeq: 12 })
    expect(parseAgentResyncBody({ sinceSeq: 'x', sessionId: '' })).toEqual({ sessionId: undefined, sinceSeq: 0 })
    expect(parseAgentResyncBody({ sinceSeq: Number.NaN })).toEqual({ sessionId: undefined, sinceSeq: 0 })
  })
})

describe('WebUI 侧的补发调用', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST 触发器而不是拉快照：响应里没有任何事件数据', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ result: { ok: true } }) } as unknown as Response
    }))

    const snapshot = await ipc.agentSnapshot('s1', 42)
    expect(calls[0]!.url).toBe('/api/agent/resync')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sessionId: 's1', sinceSeq: 42 })
    // 占位形状：数据从已鉴权的 SSE 回来，这里只让 await 成功
    expect(snapshot).toEqual({ activeRuns: [], queue: {}, pendingPermissions: [], lastSeq: 42 })
  })

  it('补发失败要抛错，薄客户端才能进退避重试而不是假装成功', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }) as unknown as Response))
    await expect(ipc.agentSnapshot(undefined, 7)).rejects.toThrow('WebUI resync failed (401)')
  })
})
