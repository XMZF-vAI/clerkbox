/**
 * 撤回/回滚新增通道的远程暴露回归锁。
 *
 * main.ts 把每个 ipcMain.handle 自动同步进 handlerRegistry，于是「为回滚加一条通道」
 * 等于「顺手把这条通道开放给局域网 /api/invoke」。回滚这套里每一条新通道都能
 * 往本机写/删文件或改写消息行，所以一条都不许远程可达。
 *
 * 通道名靠扫描源码得到，不写死清单：改名或新加一条时会立刻被这条锁抓住。
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: { handle: () => {} } }))

import { REMOTE_INVOKE_BLOCKLIST } from '../electron/webui-server'

/** 撤回/回滚相关通道的名字特征（ckpt* 快照仓库 + 两条消息改写原语 + 文件删除） */
const REWIND_CHANNEL_RE = /^(ckpt|dbDeleteMessagesFrom$|dbPatchMessage$|deleteFile$)/

function rewindChannelsInCode(): string[] {
  const dir = path.join(process.cwd(), 'electron')
  const found = new Set<string>()
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.ts')) continue
    const source = fs.readFileSync(path.join(dir, name), 'utf-8')
    for (const match of source.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) {
      if (match[1] && REWIND_CHANNEL_RE.test(match[1])) found.add(match[1])
    }
  }
  return [...found].sort()
}

describe('撤回/回滚通道的远程门', () => {
  it('扫描确实找到了这几条通道（写法变了要先让这条锁失败，别假绿）', () => {
    const channels = rewindChannelsInCode()
    expect(channels.length).toBeGreaterThanOrEqual(7)
    expect(channels).toEqual(expect.arrayContaining([
      'ckptPut', 'ckptGet', 'ckptRemove', 'ckptRemoveSession',
      'dbDeleteMessagesFrom', 'dbPatchMessage', 'deleteFile',
    ]))
  })

  it('每一条都在黑名单里：撤回是本地专属动作，不给远程开后门', () => {
    for (const channel of rewindChannelsInCode()) {
      expect(REMOTE_INVOKE_BLOCKLIST, `${channel} 必须拒绝远程 /api/invoke`).toContain(channel)
    }
  })
})
