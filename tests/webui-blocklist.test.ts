import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// webui-server 顶部 import { app } from 'electron'（仅启动 WebUI 时用），测试里打桩
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { REMOTE_INVOKE_BLOCKLIST } from '../electron/webui-server'

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

  it('electron/ 下每个 agent:* 通道都必须在黑名单里', () => {
    const channels = agentChannels()
    expect(channels.length).toBeGreaterThan(0) // 扫描失效（写法变化）时本断言先炸，避免假绿
    for (const channel of channels) expect(REMOTE_INVOKE_BLOCKLIST).toContain(channel)
  })

  it('run / 审批回执 / 快照三条具体通道被点名拦下', () => {
    expect(REMOTE_INVOKE_BLOCKLIST).toContain('agent:command')
    expect(REMOTE_INVOKE_BLOCKLIST).toContain('agent:snapshot')
    expect(REMOTE_INVOKE_BLOCKLIST).toContain('agent:host-mode')
  })
})
