import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// webui-server 顶部 import { app } from 'electron'（仅启动 WebUI 时用），测试里打桩
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { REMOTE_INVOKE_BLOCKLIST, safeTokenEquals } from '../electron/webui-server'

/**
 * 唯一刻意放行的 agent 通道。
 * 放行理由：agent:host-mode 只返回一个 'main' | 'renderer' 字符串，零副作用零数据；WebUI 侧
 * 靠它判断该连宿主还是本地自跑（agent-client.ts 的 transport.mode().catch(() => 'renderer')）。
 * 拦掉它会让远程视图误判成渲染层模式，转而要求本地持有 API Key——Key 从不下发远程，
 * 结果就是「客户端有 Key 却报缺 Key」。新增例外必须先证明它零副作用。
 */
const AGENT_CHANNEL_EXCEPTIONS: readonly string[] = ['agent:host-mode']

/** WebUI 自身的控制面：远程调用可放大暴露面或泄露内网拓扑，无正当远程场景 */
const WEBUI_CONTROL_CHANNELS: readonly string[] = ['startWebUI', 'stopWebUI', 'getLanAddresses']

/**
 * 回归锁：main.ts 对 ipcMain.handle 做了 monkey-patch，把每个 handler 同步进 handlerRegistry，
 * 于是「新加一个 ipcMain.handle」等于「顺手把这条通道开放给局域网 /api/invoke」。
 * agent:* 一旦可达就是 token 泄漏 → 以用户身份驱动本机 agent（等同 RCE）、
 * 替本地用户批准危险操作、回吐待决审批的命令预览。
 */
describe('WebUI 远程调用黑名单', () => {
  const agentChannels = (): string[] => {
    const dir = path.join(process.cwd(), 'electron')
    const found = new Set<string>()
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue
      const source = fs.readFileSync(path.join(dir, name), 'utf-8')
      for (const match of source.matchAll(/ipcMain\.handle\(\s*['"](agent:[^'"]+)['"]/g)) {
        if (match[1]) found.add(match[1])
      }
    }
    return [...found]
  }

  it('electron/ 下每个 agent:* 通道都必须在黑名单里（或在显式例外名单里）', () => {
    const channels = agentChannels()
    expect(channels.length).toBeGreaterThan(0) // 扫描失效（写法变化）时本断言先炸，避免假绿
    for (const channel of channels) {
      if (AGENT_CHANNEL_EXCEPTIONS.includes(channel)) continue
      expect(REMOTE_INVOKE_BLOCKLIST).toContain(channel)
    }
  })

  it('run 与快照两条通道被点名拦下', () => {
    expect(REMOTE_INVOKE_BLOCKLIST).toContain('agent:command')
    expect(REMOTE_INVOKE_BLOCKLIST).toContain('agent:snapshot')
  })

  it('例外名单里的通道必须真的不在黑名单（防止后人顺手禁掉、破坏 WebUI 模式判断）', () => {
    for (const channel of AGENT_CHANNEL_EXCEPTIONS) {
      expect(REMOTE_INVOKE_BLOCKLIST).not.toContain(channel)
    }
  })

  it('放行的 agent 通道恰好是例外名单本身（新增 agent:* 必须显式表态）', () => {
    const open = agentChannels().filter((c) => !REMOTE_INVOKE_BLOCKLIST.includes(c))
    expect(open.sort()).toEqual([...AGENT_CHANNEL_EXCEPTIONS].sort())
  })

  it('WebUI 控制面三通道被拦下（防远程改绑 0.0.0.0 / 泄露内网 IP）', () => {
    for (const channel of WEBUI_CONTROL_CHANNELS) {
      expect(REMOTE_INVOKE_BLOCKLIST).toContain(channel)
    }
  })
})

describe('WebUI token 恒定时间比对', () => {
  const token = 'a'.repeat(64)

  it('相等时通过', () => {
    expect(safeTokenEquals(token, token)).toBe(true)
  })

  it('任一字节不同即拒绝', () => {
    expect(safeTokenEquals('b' + token.slice(1), token)).toBe(false)
    expect(safeTokenEquals(token.slice(0, -1) + 'b', token)).toBe(false)
  })

  it('长度不等拒绝，且不进入字节比较', () => {
    expect(safeTokenEquals(token.slice(1), token)).toBe(false)
    expect(safeTokenEquals(token + 'a', token)).toBe(false)
    expect(safeTokenEquals('', token)).toBe(false)
  })

  it('expected 为空时一律拒绝（stopWebUI 后不能蒙混过关）', () => {
    expect(safeTokenEquals('', '')).toBe(false)
    expect(safeTokenEquals('anything', '')).toBe(false)
  })
})
