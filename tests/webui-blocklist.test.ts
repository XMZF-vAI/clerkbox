import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// webui-server 顶部 import { app } from 'electron'（仅启动 WebUI 时用），测试里打桩
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { REMOTE_INVOKE_BLOCKLIST, safeTokenEquals } from '../electron/webui-server'
import { BOTS_IPC_CHANNELS } from '../electron/im-bots/types'

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

  /**
   * Agent 动作通道：风险高于 executeCommand。
   * agentBrowser:command 能让远程调用方驱动本机 Agent 浏览器（导航任意 http(s)、点页面、填表单）；
   * computerUse:command 更进一步——它合成的是用户真实桌面上的鼠标键盘事件，
   * 能在任何应用里点击、输入、启动程序。两者都没有正当的远程调用场景。
   */
  it('Agent 动作通道被拦下', () => {
    expect(REMOTE_INVOKE_BLOCKLIST).toContain('agentBrowser:command')
    expect(REMOTE_INVOKE_BLOCKLIST).toContain('agentBrowser:ensurePanel')
    expect(REMOTE_INVOKE_BLOCKLIST).toContain('computerUse:command')
  })

  it('新增的桌面能力通道默认在黑名单里（防止后人加 handler 时忘了同步）', () => {
    const dir = path.join(process.cwd(), 'electron')
    const found = new Set<string>()
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue
      const source = fs.readFileSync(path.join(dir, name), 'utf-8')
      for (const match of source.matchAll(/ipcMain\.handle\(\s*['"]((?:agentBrowser|computerUse|cua):[^'"]+)['"]/g)) {
        if (match[1]) found.add(match[1])
      }
    }
    expect(found.size).toBeGreaterThan(0) // 扫描失效时先炸，避免假绿
    for (const channel of found) {
      // 零副作用的只读探测（agentBrowser:ready）不在黑名单：它只回一个布尔
      if (channel === 'agentBrowser:ready') {
        expect(REMOTE_INVOKE_BLOCKLIST).not.toContain(channel)
        continue
      }
      expect(REMOTE_INVOKE_BLOCKLIST, channel).toContain(channel)
    }
  })
})

/**
 * IM 机器人管理通道（bots:*）：整组桌面专属，一条都不许对远程可达。
 *
 * 三条断言各管一种腐坏方向：
 * 1. 注册了 handler 却没进黑名单 → 局域网能生成绑定码 / 改机器人配置；
 * 2. 黑名单里写了不存在的通道 → 后人以为防过了，其实那条通道另有注册写法；
 * 3. 常量表里有但没人注册 → WebUI/preload 侧调过去只会拿到「unknown handler」。
 */
describe('IM 机器人远程调用守卫', () => {
  /**
   * 扫出 bots:* 的真实注册。
   * 两种写法都要认：字符串字面量（`ipcMain.handle('bots:list', ...)`）与常量表引用
   * （`ipcMain.handle(BOTS_IPC_CHANNELS.list, ...)`）。只认前者的话，用常量表注册的
   * 全部通道都会被扫成 0 条，测试反而「绿」得什么都不校验——那比没有测试更糟。
   */
  const scanBotsChannels = (): Set<string> => {
    const dir = path.join(process.cwd(), 'electron')
    const found = new Set<string>()
    const literal = /ipcMain\.handle\(\s*['"](bots:[^'"]+)['"]/g
    // 常量表成员名 → 通道值（成员名与值一一对应，见 im-bots/types.ts 的 BOTS_IPC_CHANNELS）
    const byMember = new Map(Object.entries(BOTS_IPC_CHANNELS).map(([name, value]) => [name, String(value)]))
    const constant = /ipcMain\.handle\(\s*BOTS_IPC_CHANNELS\.([A-Za-z0-9_]+)/g
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        const source = fs.readFileSync(full, 'utf-8')
        for (const match of source.matchAll(literal)) if (match[1]) found.add(match[1])
        for (const match of source.matchAll(constant)) {
          const channel = match[1] ? byMember.get(match[1]) : undefined
          if (channel) found.add(channel)
        }
      }
    }
    walk(dir)
    return found
  }

  const declaredBotsChannels = Object.values(BOTS_IPC_CHANNELS)

  it('electron/ 下每个 bots:* 通道都在黑名单里（无任何例外）', () => {
    const registered = scanBotsChannels()
    expect(registered.size).toBeGreaterThan(0) // 扫描失效（写法变化）时先炸，避免假绿
    for (const channel of registered) {
      expect(REMOTE_INVOKE_BLOCKLIST, channel).toContain(channel)
    }
  })

  it('黑名单里的每条 bots:* 都对应真实注册或常量表条目（不留骗人的死条目）', () => {
    const registered = scanBotsChannels()
    for (const channel of REMOTE_INVOKE_BLOCKLIST.filter((item) => item.startsWith('bots:'))) {
      expect(registered.has(channel) || (declaredBotsChannels as string[]).includes(channel), channel).toBe(true)
    }
  })

  it('常量表与真实注册的通道一一对应（加 handler 必进常量表，进常量表必落实现）', () => {
    expect([...scanBotsChannels()].sort()).toEqual([...declaredBotsChannels].map(String).sort())
  })

  it('事件推送通道不进黑名单也无害：它们只由主进程单向 send，不经 /api/invoke 受理', () => {
    // 这里只是把设计写下来：/api/invoke 只能命中 handlerRegistry，
    // webContents.send 的通道名（bots:changed / bots:status / bots:weixinQr）不在其中。
    for (const event of ['bots:changed', 'bots:status', 'bots:weixinQr']) {
      expect(REMOTE_INVOKE_BLOCKLIST.includes(event)).toBe(false)
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
