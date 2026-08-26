/**
 * Windows 真·亚克力玻璃效果 —— 运行在主进程。
 *
 * 通过 SetWindowCompositionAttribute（未公开但被 TranslucentTB / electron-acrylic 等
 * 广泛使用的 DWM 接口）给透明窗口叠加系统级实时模糊，透出桌面壁纸。
 *
 * 实现方式：常驻 PowerShell 子进程 + 内嵌 C#（零原生依赖），stdin 行协议：
 *   blur <hwnd> <alphaHex>  → 开启亚克力，alpha 为磨砂叠色（AABBGGRR 高位字节）
 *   clear <hwnd>            → 关闭特效，恢复纯透明窗口
 *   quit                    → 退出助手进程
 * 每条命令回执一行：OK <hresult> 或 ERR <message>
 */
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

const START_TIMEOUT_MS = 20_000
const COMMAND_TIMEOUT_MS = 8_000

const PS_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ClerkBoxAcrylic {
  [StructLayout(LayoutKind.Sequential)]
  public struct AccentPolicy {
    public int AccentState;
    public int AccentFlags;
    public uint GradientColor;
    public int AnimationId;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct WindowCompositionAttributeData {
    public int Attribute;
    public IntPtr Data;
    public int SizeOfData;
  }

  [DllImport("user32.dll")]
  public static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

  public static int Apply(IntPtr hwnd, int state, int alpha) {
    AccentPolicy policy = new AccentPolicy();
    policy.AccentState = state;
    policy.AccentFlags = 0;
    policy.GradientColor = ((uint)alpha) << 24;
    WindowCompositionAttributeData data = new WindowCompositionAttributeData();
    data.Attribute = 19;
    data.SizeOfData = Marshal.SizeOf(typeof(AccentPolicy));
    data.Data = Marshal.AllocHGlobal(data.SizeOfData);
    Marshal.StructureToPtr(policy, data.Data, false);
    int hr = SetWindowCompositionAttribute(hwnd, ref data);
    Marshal.FreeHGlobal(data.Data);
    return hr;
  }
}
"@

Write-Output 'READY'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  if ($line -eq 'quit') { break }
  $parts = $line.Split(' ')
  try {
    if ($parts.Count -lt 2) {
      Write-Output 'ERR bad-command'
      continue
    }
    $hwnd = [IntPtr]::new([Int64]$parts[1])
    if ($parts[0] -eq 'blur') {
      if ($parts.Count -lt 3) { Write-Output 'ERR missing-alpha'; continue }
      $alpha = [int][Convert]::ToUInt32($parts[2], 16)
      if ($alpha -gt 255) { $alpha = 255 }
      $hr = [ClerkBoxAcrylic]::Apply($hwnd, 4, $alpha)
      Write-Output "OK $hr"
    } elseif ($parts[0] -eq 'clear') {
      $hr = [ClerkBoxAcrylic]::Apply($hwnd, 0, 0)
      Write-Output "OK $hr"
    } else {
      Write-Output 'ERR unknown-command'
    }
  } catch {
    Write-Output "ERR $($_.Exception.Message)"
  }
}
`

interface PendingCommand {
  resolve: (hr: number) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class WinAcrylicManager {
  private proc: ChildProcess | null = null
  private scriptPath: string | null = null
  private starting: Promise<void> | null = null
  private pending: PendingCommand[] = []
  private stdoutBuffer = ''
  private lastHwnd: string | null = null
  private disposed = false

  private ensureScript(): string {
    if (this.scriptPath) return this.scriptPath
    const dir = path.join(app.getPath('temp'), 'clerkbox')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'win-acrylic.ps1')
    fs.writeFileSync(file, PS_SCRIPT, 'utf-8')
    this.scriptPath = file
    return file
  }

  private spawnProcess(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.ensureScript()],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )

      const readyTimer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('acrylic helper startup timeout'))
        try { proc.kill() } catch { /* noop */ }
      }, START_TIMEOUT_MS)

      const onReady = (chunk: Buffer) => {
        if (settled) return
        if (!chunk.toString('utf-8').includes('READY')) return
        settled = true
        clearTimeout(readyTimer)
        proc.stdout?.off('data', onReady)
        resolve()
      }

      proc.stdout?.on('data', onReady)
      // Add-Type 编译进度等噪声走 stderr，直接丢弃
      proc.stderr?.on('data', () => {})
      proc.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      proc.once('exit', () => {
        if (this.proc === proc) this.proc = null
        const pending = this.pending.splice(0)
        for (const item of pending) {
          clearTimeout(item.timer)
          item.reject(new Error('acrylic helper exited'))
        }
        if (!settled) {
          settled = true
          clearTimeout(readyTimer)
          reject(new Error('acrylic helper exited during startup'))
        }
      })

      this.proc = proc
      this.attachResponseReader(proc)
    })
  }

  private attachResponseReader(proc: ChildProcess): void {
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf-8')
      let newlineIndex = this.stdoutBuffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
        if (line.startsWith('OK ') || line.startsWith('ERR')) {
          const pending = this.pending.shift()
          if (!pending) continue
          clearTimeout(pending.timer)
          if (line.startsWith('OK ')) {
            const hr = Number.parseInt(line.slice(3).trim(), 10)
            pending.resolve(Number.isFinite(hr) ? hr : -1)
          } else {
            pending.reject(new Error(line.slice(4).trim() || 'acrylic command failed'))
          }
        }
        newlineIndex = this.stdoutBuffer.indexOf('\n')
      }
    })
  }

  private async ensureProcess(): Promise<void> {
    if (this.disposed) throw new Error('acrylic manager disposed')
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return
    if (this.starting) return this.starting
    this.starting = this.spawnProcess()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private send(command: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const proc = this.proc
      if (!proc || proc.exitCode !== null || proc.killed || !proc.stdin) {
        reject(new Error('acrylic helper not running'))
        return
      }
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(pending)
        if (index !== -1) this.pending.splice(index, 1)
        reject(new Error('acrylic command timeout'))
      }, COMMAND_TIMEOUT_MS)
      const pending: PendingCommand = {
        resolve,
        reject,
        timer,
      }
      this.pending.push(pending)
      proc.stdin.write(`${command}\n`)
    })
  }

  /** 读取 Electron 原生窗口句柄 Buffer 为十进制字符串 */
  private hwndToString(hwnd: Buffer): string {
    if (hwnd.length >= 8) return hwnd.readBigUInt64LE(0).toString()
    if (hwnd.length >= 4) return hwnd.readUInt32LE(0).toString()
    return '0'
  }

  /**
   * 设置玻璃程度。level 0 关闭特效（纯透明），1-100 映射为亚克力磨砂叠色 alpha。
   * 返回 ok=false 表示系统不支持（调用方降级到壁纸快照）。
   */
  async setAcrylic(hwnd: Buffer, level: number): Promise<{ ok: boolean }> {
    const lvl = Math.min(100, Math.max(0, Math.round(level)))
    const hwndString = this.hwndToString(hwnd)
    this.lastHwnd = hwndString
    try {
      await this.ensureProcess()
    } catch {
      return { ok: false }
    }
    try {
      if (lvl === 0) {
        const hr = await this.send(`clear ${hwndString}`)
        return { ok: hr === 0 }
      }
      // 1-100 → 叠色 alpha 1-150：越磨砂越暗，兼顾白字可读性
      const alpha = 1 + Math.round((lvl / 100) * 149)
      const hr = await this.send(`blur ${hwndString} ${alpha.toString(16).padStart(2, '0')}`)
      return { ok: hr === 0 }
    } catch {
      return { ok: false }
    }
  }

  /** 关闭特效（恢复普通透明窗口） */
  async clearAcrylic(hwnd?: Buffer): Promise<void> {
    const hwndString = hwnd ? this.hwndToString(hwnd) : this.lastHwnd
    if (!hwndString) return
    if (!this.proc || this.proc.exitCode !== null || this.proc.killed) return
    try {
      await this.send(`clear ${hwndString}`)
    } catch {
      // 助手进程异常时静默失败：窗口销毁/退出场景无需报告
    }
  }

  /** 终止助手进程但保持管理器可复用（窗口销毁时调用，特效随窗口一起消失） */
  terminate(): void {
    const proc = this.proc
    this.proc = null
    if (!proc) return
    const pending = this.pending.splice(0)
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(new Error('acrylic helper terminated'))
    }
    try { proc.stdin?.end('quit\n') } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
  }

  dispose(): void {
    this.disposed = true
    this.terminate()
  }
}

export const winAcrylic = new WinAcrylicManager()
