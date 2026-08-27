import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { PtyCreateInfo } from '../src/types/ipc'

/**
 * 内置工作台终端（node-pty 真 TTY）。
 *
 * 渲染层每个终端标签对应一个 PTY 会话，以标签 id 作为会话 id。
 * 输出通过 webContents 推送（pty:data / pty:exit），输入走单向 ipcRenderer.send，
 * 避免 xterm 高频回显走 invoke 队列。
 */

const MAX_TERMINALS = 8

// CLERKBOX_DEBUG_PTY=1 时输出终端会话生命周期日志（排查输入/输出链路用）
const DEBUG_PTY = process.env.CLERKBOX_DEBUG_PTY === '1'
const debugLog = (...args: unknown[]) => {
  if (DEBUG_PTY) console.log('[pty]', ...args)
}

const terminals = new Map<string, IPty>()

function pickShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: [] }
  if (process.platform === 'darwin') return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] }
  return { file: process.env.SHELL || '/bin/bash', args: [] }
}

/** 广播给所有窗口（正常只有主窗口；多窗口时各终端 id 天然隔离） */
function broadcast(channel: string, ...args: unknown[]) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

export function registerTerminalHandlers() {
  ipcMain.handle('ptyCreate', (_event, info: PtyCreateInfo) => {
    if (!info || typeof info.id !== 'string' || !info.id) throw new Error('Invalid terminal id')
    if (terminals.size >= MAX_TERMINALS) throw new Error('Too many terminals')

    // 同 id 重复创建（React 严格模式双挂载等）：先回收旧会话再重建
    terminals.get(info.id)?.kill()

    let cwd = typeof info.cwd === 'string' && info.cwd ? info.cwd : ''
    try {
      if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = os.homedir()
    } catch {
      cwd = os.homedir()
    }

    const shell = pickShell()
    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: Math.max(2, Math.min(500, Math.floor(info.cols ?? 80))),
      rows: Math.max(2, Math.min(200, Math.floor(info.rows ?? 24))),
      cwd,
      env: process.env as { [key: string]: string },
      // Windows ConPTY 关闭宿主终端时控制台列表查询可能抛错，属已知清理期噪音
      useConpty: process.platform === 'win32',
    })

    terminals.set(info.id, proc)
    debugLog('spawn', info.id, 'cwd=', cwd)
    proc.onData((data) => broadcast('pty:data', info.id, data))
    proc.onExit(({ exitCode }) => {
      terminals.delete(info.id)
      debugLog('exit', info.id, 'code=', exitCode)
      broadcast('pty:exit', info.id, exitCode)
    })

    return { ok: true }
  })

  ipcMain.on('ptyInput', (_event, id: unknown, data: unknown) => {
    if (typeof id !== 'string' || typeof data !== 'string') return
    const proc = terminals.get(id)
    debugLog('input', id, 'alive=', !!proc, 'len=', data.length)
    proc?.write(data)
  })

  ipcMain.on('ptyResize', (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id !== 'string') return
    try {
      terminals.get(id)?.resize(
        Math.max(2, Math.min(500, Math.floor(Number(cols) || 80))),
        Math.max(2, Math.min(200, Math.floor(Number(rows) || 24)))
      )
    } catch {
      // 会话可能已退出，忽略 resize 失败
    }
  })

  ipcMain.handle('ptyKill', (_event, id: string) => {
    if (typeof id !== 'string') return
    const proc = terminals.get(id)
    if (!proc) return
    terminals.delete(id)
    debugLog('kill', id)
    try {
      proc.kill()
    } catch {
      // 进程可能已退出；ConPTY 清理噪音到此为止
    }
  })
}

/** 应用退出前回收全部终端进程（main.ts before-quit 调用） */
export function disposeAllTerminals() {
  for (const [, proc] of terminals) {
    try {
      proc.kill()
    } catch {
      /* 已退出则忽略 */
    }
  }
  terminals.clear()
}
