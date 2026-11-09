/**
 * BE-05：桌面窗口刷新会中止其他渠道的流。
 *
 * 所有渠道共用一张 inflight 表，窗口清理原先调 abortAllApiRequests 一刀切：
 * 宿主 / IM / WebUI 正在生成的请求跟着一起被掐掉，而且被标成 userAborted，
 * 调用方收到 done，把半截回答当成正常结束。
 *
 * 这里锁三件事：
 * 1. 按归属中止：只结束该拥有者的流；
 * 2. 意外中断与主动停止不是一回事——意外中断要回 error，不能回 done；
 * 3. 应用退出才全局清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: () => {} }, BrowserWindow: class {} }))

import { startChatStream, abortApiRequestsForOwner, abortAllApiRequests, abortChatStream } from '../electron/api-proxy'

const cfg = { baseUrl: 'https://api.invalid.test/v1', apiKey: 'sk-test', apiCompat: 'openai' as const }

/** fetch 换成一条永远读不完的流；abort 时 read 以错误收尾，模拟真实网络 */
function stubNeverEndingFetch() {
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => ({
    ok: true,
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: () =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
        releaseLock: () => {},
        cancel: async () => {},
      }),
    },
  }))
}

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

beforeEach(() => {
  vi.stubGlobal('fetch', stubNeverEndingFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BE-05 流式请求按归属中止', () => {
  it('中止一个窗口时，宿主与其他窗口的流不受影响', async () => {
    const sentHost: Array<Record<string, unknown>> = []
    const sentWindow: Array<Record<string, unknown>> = []
    startChatStream(cfg, {}, 'req-host', (p) => sentHost.push(p), 'host')
    startChatStream(cfg, {}, 'req-w1', (p) => sentWindow.push(p), 'wc:1')
    await tick()

    abortApiRequestsForOwner('wc:1')
    await tick()

    // 窗口那条以 error 收尾（不是 done：调用方不能把半截回答当正常结束）
    expect(sentWindow.length).toBe(1)
    expect(sentWindow[0]).toHaveProperty('error')
    expect(sentWindow[0]).not.toHaveProperty('done')
    // 宿主那条完全没被碰
    expect(sentHost).toHaveLength(0)
  })

  it('主动停止仍按 done 收尾（与意外中断区分开）', async () => {
    const sent: Array<Record<string, unknown>> = []
    startChatStream(cfg, {}, 'req-user', (p) => sent.push(p), 'wc:1')
    await tick()

    abortChatStream('req-user')
    await tick()

    expect(sent.length).toBe(1)
    expect(sent[0]).toMatchObject({ done: true })
  })

  it('应用退出才全局清理：所有归属的流一起收尾', async () => {
    const sentHost: Array<Record<string, unknown>> = []
    const sentWindow: Array<Record<string, unknown>> = []
    startChatStream(cfg, {}, 'req-host', (p) => sentHost.push(p), 'host')
    startChatStream(cfg, {}, 'req-w1', (p) => sentWindow.push(p), 'wc:1')
    await tick()

    abortAllApiRequests()
    await tick()

    expect(sentHost.length).toBe(1)
    expect(sentHost[0]).toHaveProperty('error')
    expect(sentWindow.length).toBe(1)
    expect(sentWindow[0]).toHaveProperty('error')
  })

  it('中止不属于自己的归属时一条都不动', async () => {
    const sent: Array<Record<string, unknown>> = []
    startChatStream(cfg, {}, 'req-host', (p) => sent.push(p), 'host')
    await tick()

    abortApiRequestsForOwner('wc:999')
    await tick()

    expect(sent).toHaveLength(0)
  })
})
