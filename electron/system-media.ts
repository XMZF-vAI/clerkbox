/**
 * 系统媒体会话（SMTC）管理器 —— 运行在主进程。
 *
 * 读取并控制「系统正在播放」的音频（网易云 / QQ 音乐 / 浏览器等任何注册了
 * 系统媒体控制的播放器），并提供系统主音量读写。
 *
 * 实现方式：常驻 PowerShell 子进程（WinRT SMTC + 内嵌 C# COM 音量接口，零原生依赖）。
 * - stdout：每秒一行 NDJSON 状态（曲名/艺术家/封面/进度/播放状态/音量）
 * - stdin：行协议命令 toggle / play / pause / next / prev / seek <ms> / volume <0-100> / quit
 * - 状态变化经 'vibe:mediaState' 事件推送给渲染进程（WebUI 远程模式由渲染进程轮询）
 */
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { app, type BrowserWindow } from 'electron'
import type { SystemMediaState, VibeMediaCommand } from '../src/types/ipc'

const START_TIMEOUT_MS = 30_000
const STOP_DELAY_MS = 15_000
const MAX_RESTART_ATTEMPTS = 5

const PS_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace ClerkBoxAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr client);
    int UnregisterControlChangeNotify(IntPtr client);
    int GetChannelCount(out int channels);
    int SetMasterVolumeLevel(float level, Guid context);
    int SetMasterVolumeLevelScalar(float level, Guid context);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(int channel, float level, Guid context);
    int SetChannelVolumeLevelScalar(int channel, float level, Guid context);
    int GetChannelVolumeLevel(int channel, out float level);
    int GetChannelVolumeLevelScalar(int channel, out float level);
    int SetMute(bool mute, Guid context);
    int GetMute(out bool mute);
  }

  public static class Volume {
    private static IAudioEndpointVolume Endpoint() {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out device);
      if (hr != 0) throw new InvalidOperationException("no default audio endpoint");
      object iface;
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      hr = device.Activate(ref iid, 1, IntPtr.Zero, out iface);
      if (hr != 0) throw new InvalidOperationException("audio endpoint activate failed");
      return (IAudioEndpointVolume)iface;
    }
    public static float Get() {
      float level;
      Endpoint().GetMasterVolumeLevelScalar(out level);
      return level;
    }
    public static void Set(float level) {
      if (level < 0f) level = 0f;
      if (level > 1f) level = 1f;
      Endpoint().SetMasterVolumeLevelScalar(level, Guid.Empty);
    }
  }
}
"@

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSession,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null

# 泛型名 IAsyncOperation[arity] 中的反引号字符不能以字面量出现（会终止外层 JS 模板字符串），用 [char]96 拼接
$genericName = 'IAsyncOperation' + [char]96 + '1'
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $genericName
})[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$mgr = $null
try {
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch { }

Write-Output 'READY'

$stdinTask = $null
$lastKey = $null
$lastCover = $null

function Send-Command($line) {
  $parts = $line.Split(' ')
  $cmd = $parts[0]
  try {
    if ($cmd -eq 'volume') {
      if ($parts.Count -ge 2) {
        $v = [double]$parts[1]
        [ClerkBoxAudio.Volume]::Set([float]($v / 100.0))
      }
      return
    }
    if ($mgr -eq $null) { return }
    $session = $mgr.GetCurrentSession()
    if ($session -eq $null) { return }
    switch ($cmd) {
      'toggle' {
        if ($session.PlaybackInfo.PlaybackStatus.ToString() -eq 'Playing') {
          Await ($session.TryPauseAsync()) ([bool]) | Out-Null
        } else {
          Await ($session.TryPlayAsync()) ([bool]) | Out-Null
        }
      }
      'play' { Await ($session.TryPlayAsync()) ([bool]) | Out-Null }
      'pause' { Await ($session.TryPauseAsync()) ([bool]) | Out-Null }
      'next' { Await ($session.TrySkipNextAsync()) ([bool]) | Out-Null }
      'prev' { Await ($session.TrySkipPreviousAsync()) ([bool]) | Out-Null }
      'seek' {
        if ($parts.Count -ge 2) {
          $ms = [double]$parts[1]
          Await ($session.TryChangePlaybackPositionAsync([long]($ms * 10000))) ([bool]) | Out-Null
        }
      }
    }
  } catch { }
}

while ($true) {
  # 非阻塞读取命令行（保持单个挂起的 ReadLineAsync 任务，避免阻塞轮询循环）
  if ($stdinTask -eq $null) { $stdinTask = [Console]::In.ReadLineAsync() }
  if ($stdinTask.Wait(0)) {
    $line = $stdinTask.Result
    $stdinTask = $null
    if ($line -eq $null) { break }
    $line = $line.Trim()
    if ($line -eq 'quit') { break }
    if ($line.Length -gt 0) { Send-Command $line }
  }

  $obj = [ordered]@{}
  try {
    if ($mgr -eq $null) {
      $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    $session = $mgr.GetCurrentSession()
    if ($null -eq $session) {
      # 当前无活跃会话：重新请求 manager 以发现新启动的播放器
      $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
      $session = $mgr.GetCurrentSession()
    }
    if ($null -eq $session) {
      $obj.available = $false
      $lastKey = $null
      $lastCover = $null
    } else {
      $props = Await ($session.GetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $timeline = $session.GetTimelineProperties()
      $obj.available = $true
      $obj.title = [string]$props.Title
      $obj.artist = [string]$props.Artist
      $obj.album = [string]$props.AlbumTitle
      $obj.status = [string]$session.PlaybackInfo.PlaybackStatus
      $obj.positionMs = [math]::Round($timeline.Position.TotalMilliseconds)
      try {
        $obj.durationMs = [math]::Round($timeline.EndTime.TotalMilliseconds)
      } catch {
        $obj.durationMs = 0
      }
      $key = "$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
      if ($key -ne $lastKey) {
        $lastKey = $key
        $lastCover = $null
        try {
          $thumb = $props.Thumbnail
          if ($thumb -ne $null) {
            $stream = Await ($thumb.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
            $size = [uint32]$stream.Size
            if ($size -gt 0 -and $size -lt 4000000) {
              $reader = New-Object System.IO.BinaryReader($stream.AsStreamForRead())
              $bytes = $reader.ReadBytes($size)
              $lastCover = [Convert]::ToBase64String($bytes)
              $reader.Dispose()
            }
            $stream.Dispose()
          }
        } catch { }
      }
      if ($lastCover -ne $null) { $obj.cover = "data:image/jpeg;base64,$lastCover" }
    }
  } catch {
    $obj.available = $false
    $mgr = $null
  }
  try {
    $vol = [ClerkBoxAudio.Volume]::Get()
    $obj.volume = [int][math]::Round($vol * 100)
  } catch { }
  Write-Output (ConvertTo-Json ([psobject]$obj) -Compress)
  Start-Sleep -Milliseconds 1000
}
`

function normalizeState(raw: unknown): SystemMediaState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const state: SystemMediaState = { available: record.available === true }
  if (typeof record.title === 'string' && record.title) state.title = record.title
  if (typeof record.artist === 'string' && record.artist) state.artist = record.artist
  if (typeof record.album === 'string' && record.album) state.album = record.album
  if (typeof record.status === 'string' && record.status) state.status = record.status
  if (typeof record.positionMs === 'number' && Number.isFinite(record.positionMs)) state.positionMs = Math.max(0, record.positionMs)
  if (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)) state.durationMs = Math.max(0, record.durationMs)
  if (typeof record.cover === 'string' && record.cover.startsWith('data:image/')) state.cover = record.cover
  if (typeof record.volume === 'number' && Number.isFinite(record.volume)) state.volume = Math.min(100, Math.max(0, Math.round(record.volume)))
  return state
}

class SystemMediaManager {
  private proc: ChildProcess | null = null
  private scriptPath: string | null = null
  private starting: Promise<void> | null = null
  private mainWindow: BrowserWindow | null = null
  private state: SystemMediaState | null = null
  private lastLine = ''
  private stdoutBuffer = ''
  private stopTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private restartAttempts = 0
  private requestedActive = false
  private disposed = false

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  private ensureScript(): string {
    if (this.scriptPath) return this.scriptPath
    const dir = path.join(app.getPath('temp'), 'clerkbox')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'system-media.ps1')
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
        reject(new Error('system media helper startup timeout'))
        try { proc.kill() } catch { /* noop */ }
      }, START_TIMEOUT_MS)

      const onReady = (chunk: Buffer) => {
        if (settled) return
        if (!chunk.toString('utf-8').includes('READY')) return
        settled = true
        clearTimeout(readyTimer)
        proc.stdout?.off('data', onReady)
        this.restartAttempts = 0
        resolve()
      }

      proc.stdout?.on('data', onReady)
      proc.stderr?.on('data', () => {})
      proc.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      proc.once('exit', () => {
        if (this.proc === proc) this.proc = null
        this.state = null
        this.lastLine = ''
        if (!settled) {
          settled = true
          clearTimeout(readyTimer)
          reject(new Error('system media helper exited during startup'))
          return
        }
        // 非主动停止的意外退出：短暂延迟后自动重启（渲染进程无需感知）
        if (this.requestedActive && !this.disposed && this.restartAttempts < MAX_RESTART_ATTEMPTS) {
          this.restartAttempts += 1
          if (this.restartTimer) clearTimeout(this.restartTimer)
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null
            void this.ensureStarted().catch(() => {})
          }, 5_000)
        }
      })

      this.proc = proc
      this.attachLineReader(proc)
    })
  }

  private attachLineReader(proc: ChildProcess): void {
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf-8')
      let newlineIndex = this.stdoutBuffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
        if (line.startsWith('{')) {
          this.handleStateLine(line)
        }
        newlineIndex = this.stdoutBuffer.indexOf('\n')
      }
    })
  }

  private handleStateLine(line: string): void {
    if (line === this.lastLine) return
    this.lastLine = line
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const state = normalizeState(parsed)
    if (!state) return
    this.state = state
    const win = this.mainWindow
    if (win && !win.isDestroyed()) {
      win.webContents.send('vibe:mediaState', state)
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.disposed) throw new Error('system media manager disposed')
    this.requestedActive = true
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return
    if (this.starting) return this.starting
    this.starting = this.spawnProcess()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  getState(): SystemMediaState | null {
    return this.state
  }

  async sendCommand(cmd: VibeMediaCommand): Promise<boolean> {
    let line: string
    switch (cmd.type) {
      case 'toggle':
      case 'play':
      case 'pause':
      case 'next':
      case 'prev':
        line = cmd.type
        break
      case 'seek':
        line = `seek ${Math.max(0, Math.round(cmd.positionMs))}`
        break
      case 'volume':
        line = `volume ${Math.min(100, Math.max(0, Math.round(cmd.volume)))}`
        break
      default:
        return false
    }
    try {
      await this.ensureStarted()
    } catch {
      return false
    }
    const proc = this.proc
    if (!proc || proc.exitCode !== null || proc.killed || !proc.stdin) return false
    try {
      proc.stdin.write(`${line}\n`)
      return true
    } catch {
      return false
    }
  }

  /** 停止轮询（延迟回收，避免面板里来回切换音频模式时反复拉起进程） */
  stop(): void {
    this.requestedActive = false
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      this.killProcess()
    }, STOP_DELAY_MS)
  }

  private killProcess(): void {
    const proc = this.proc
    this.proc = null
    this.state = null
    this.lastLine = ''
    if (!proc) return
    try { proc.stdin?.end('quit\n') } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
  }

  /** 立即停止轮询并杀掉进程，但保持管理器可复用（窗口销毁时调用） */
  terminate(): void {
    this.requestedActive = false
    if (this.stopTimer) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.killProcess()
  }

  dispose(): void {
    this.disposed = true
    this.terminate()
  }
}

export const systemMedia = new SystemMediaManager()
