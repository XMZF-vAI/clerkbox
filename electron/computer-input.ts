/**
 * 桌面输入合成的平台后端
 *
 * 三平台各一条路，语义完全一致（坐标一律是屏幕物理像素）：
 *   - Windows：常驻 PowerShell 子进程 + 内嵌 C# `SendInput`。**必须常驻**：
 *     每次点击拉一个 powershell.exe 要 300~500ms，交互式使用根本没法接受。
 *     协议与 electron/win-acrylic.ts 完全一致（stdin 行协议 + 每行一条回执）。
 *   - macOS：`osascript`（System Events）。按次拉起，进程本身够快。
 *   - Linux：`xdotool`。同上。
 *
 * 为什么不用 robotjs / nut-js / koffi：本仓 `npmRebuild: false`，新增原生模块不会被
 * 为 Electron 42 重建，发布包直接起不来。仓库里已经有「PowerShell + 内嵌 C#」
 * 这条成熟范式（win-acrylic.ts / system-media.ts），沿用它不引入任何新依赖。
 */
import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { app, screen } from 'electron'
import type { ComputerAppInfo, ComputerMouseButton } from '../src/lib/agent-actions'

/**
 * 虚拟桌面矩形 = 所有显示器 bounds 的并集。
 * 副屏摆在主屏左边/上边时并集原点是负数，SendInput 归一化必须先减掉这个原点。
 */
export function virtualDesktopRect(): VirtualDesktopRect {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) {
    return { x: 0, y: 0, width: 1920, height: 1080 }
  }
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const display of displays) {
    const b = display.bounds
    left = Math.min(left, b.x)
    top = Math.min(top, b.y)
    right = Math.max(right, b.x + b.width)
    bottom = Math.max(bottom, b.y + b.height)
  }
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

const START_TIMEOUT_MS = 25_000
const COMMAND_TIMEOUT_MS = 8_000

/** 文本/键名走 base64 传：stdin 是行协议，换行/引号/非 ASCII 都不能裸传 */
function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64')
}

/** 虚拟桌面的物理像素矩形（所有显示器并集）。Windows 的 SendInput 归一化基准就是它 */
export interface VirtualDesktopRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopInputBackend {
  readonly platform: 'win32' | 'darwin' | 'linux' | 'unsupported'
  /**
   * 同步虚拟桌面几何。仅 Windows 需要（SendInput 的 ABSOLUTE 归一化依赖它）；
   * 其余平台用各自的原生坐标语义，实现为 no-op。
   */
  setVirtualDesktop(rect: VirtualDesktopRect): Promise<void>
  move(x: number, y: number): Promise<void>
  click(x: number, y: number, button: ComputerMouseButton, clickCount: number): Promise<void>
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>
  scroll(x: number | undefined, y: number | undefined, deltaX: number, deltaY: number): Promise<void>
  type(text: string): Promise<void>
  key(spec: string): Promise<void>
  listApps(): Promise<ComputerAppInfo[]>
  openApp(name: string): Promise<void>
  dispose(): void
}

export class DesktopUnsupportedError extends Error {
  constructor(readonly platform: string) {
    super(`Computer use input synthesis is not available on this platform (${platform}).`)
    this.name = 'DesktopUnsupportedError'
  }
}

// ── Windows：常驻 PowerShell + SendInput ──

const WIN_INPUT_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Add-Type 必须失败即停。下面那句 'Continue' 会让编译错误变成非终止错误，
# 脚本继续往下跑到命令分发，于是每条命令都报「找不到类型 [ClerkBoxInput]」——
# 一个编译错误被伪装成了十几次莫名其妙的运行时错误。宁可启动就失败。
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ClerkBoxInput {
  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x01000;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  // SendInput 的 ABSOLUTE 归一化基准。必须由 Node 侧（Electron）下发 —— 不能在这里问
  // [System.Windows.Forms.Screen]：未声明 DPI 感知的那条 PowerShell 进程拿到的是
  // **逻辑**虚拟像素，而 SendInput 吃的是**物理**像素。125%/150% 缩放的屏幕上两者不等，
  // 拿逻辑值当分母会让每一次落点都系统性偏左偏上（这正是「点击总是点不到东西」的真凶）。
  public static int DeskX = 0;
  public static int DeskY = 0;
  public static int DeskW = 1920;
  public static int DeskH = 1080;

  public static void SetDesktop(int x, int y, int w, int h) {
    DeskX = x; DeskY = y; DeskW = w; DeskH = h;
  }

  static uint Norm(int v, int max) {
    if (max <= 0) return 0;
    long n = (long)Math.Round(v * 65535.0 / max);
    if (n < 0) n = 0;
    if (n > 65535) n = 65535;
    return (uint)n;
  }

  static void Send(INPUT[] inputs) {
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  static INPUT Mouse(int x, int y, uint flags, uint data) {
    INPUT i = new INPUT();
    i.type = INPUT_MOUSE;
    // 减去虚拟桌面原点：副屏在虚拟桌面里坐标是负的（显示在主屏左侧时），
    // 不减就会算出负的归一化值
    i.u.mi.dx = (int)Norm(x - DeskX, DeskW);
    i.u.mi.dy = (int)Norm(y - DeskY, DeskH);
    i.u.mi.mouseData = data;
    // VIRTUALDESK：没有它，ABSOLUTE 的 0~65535 只映射主屏，多屏时副屏一律点不到
    i.u.mi.dwFlags = flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    return i;
  }

  public static void Move(int x, int y) {
    Send(new INPUT[] { Mouse(x, y, MOUSEEVENTF_MOVE, 0) });
  }

  public static void Click(int x, int y, int button, int count) {
    uint down, up;
    if (button == 2) { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
    else if (button == 3) { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
    else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }
    Move(x, y);
    System.Threading.Thread.Sleep(15);
    for (int i = 0; i < count; i++) {
      Send(new INPUT[] { Mouse(x, y, down, 0) });
      System.Threading.Thread.Sleep(20);
      Send(new INPUT[] { Mouse(x, y, up, 0) });
      if (i < count - 1) System.Threading.Thread.Sleep(40);
    }
  }

  public static void Drag(int fx, int fy, int tx, int ty) {
    // Interpolate instead of one jump: many widgets only react in dragover, so a teleport reads as no drag at all.
    const int STEPS = 12;
    Mouse(fx, fy, MOUSEEVENTF_MOVE, 0);
    System.Threading.Thread.Sleep(20);
    Send(new INPUT[] { Mouse(fx, fy, MOUSEEVENTF_LEFTDOWN, 0) });
    System.Threading.Thread.Sleep(30);
    for (int i = 1; i <= STEPS; i++) {
      int cx = fx + (tx - fx) * i / STEPS;
      int cy = fy + (ty - fy) * i / STEPS;
      Send(new INPUT[] { Mouse(cx, cy, MOUSEEVENTF_MOVE, 0) });
      System.Threading.Thread.Sleep(12);
    }
    System.Threading.Thread.Sleep(30);
    Send(new INPUT[] { Mouse(tx, ty, MOUSEEVENTF_LEFTUP, 0) });
  }

  public static void Scroll(int x, int y, int dx, int dy) {
    if (x >= 0 && y >= 0) Move(x, y);
    if (dx != 0) Send(new INPUT[] { Mouse(x, y, MOUSEEVENTF_HWHEEL, unchecked((uint)(dx * 120))) });
    if (dy != 0) Send(new INPUT[] { Mouse(x, y, MOUSEEVENTF_WHEEL, unchecked((uint)(dy * 120))) });
  }

  static void KeyRaw(ushort vk, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    Send(new INPUT[] { i });
  }

  static void KeyChar(char c, bool up) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wScan = c;
    i.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    Send(new INPUT[] { i });
  }

  /** Key name to virtual key code. 0 means the name is not a known key. */
  static ushort VkOf(string name) {
    switch (name.ToLowerInvariant()) {
      case "enter": case "return": return 0x0D;
      case "escape": case "esc": return 0x1B;
      case "tab": return 0x09;
      case "space": return 0x20;
      case "backspace": return 0x08;
      case "delete": case "del": return 0x2E;
      case "insert": case "ins": return 0x2D;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pageup": return 0x21;
      case "pagedown": return 0x22;
      case "up": case "arrowup": return 0x26;
      case "down": case "arrowdown": return 0x28;
      case "left": case "arrowleft": return 0x25;
      case "right": case "arrowright": return 0x27;
      case "shift": return 0x10;
      case "control": case "ctrl": return 0x11;
      case "alt": return 0x12;
      case "meta": case "win": case "super": case "cmd": case "command": return 0x5B;
      case "printscreen": return 0x2C;
      case "pause": return 0x13;
      case "capslock": return 0x14;
      default: break;
    }
    if (name.Length == 1) {
      char c = char.ToUpperInvariant(name[0]);
      if (c >= 'A' && c <= 'Z') return (ushort)c;
      if (c >= '0' && c <= '9') return (ushort)c;
      if (c == '+') return 0xBB;
      if (c == '-') return 0xBD;
      if (c == '=') return 0xBB;
      if (c == ',') return 0xBC;
      if (c == '.') return 0xBE;
      if (c == '/') return 0xBF;
      if (c == ';') return 0xBA;
      if (c == '\'') return 0xDE;
      if (c == '[') return 0xDB;
      if (c == ']') return 0xDD;
      if (c == '\\') return 0xDC;
      // Backtick is written as (char)96: this C# lives inside a TS template literal,
      // so a literal backtick character would terminate the template.
      if (c == (char)96) return 0xC0;
    }
    return 0;
  }

  /** Spec looks like "ctrl+shift+s": hold modifiers, tap the main key, release modifiers in reverse. */
  public static void KeyCombo(string spec) {
    string[] parts = spec.Split('+');
    var vks = new System.Collections.Generic.List<ushort>();
    for (int i = 0; i < parts.Length; i++) {
      string p = parts[i].Trim();
      if (p.Length == 0) continue;
      // A bare "+" key splits into two empty parts; fall back to the character key in that case.
      ushort vk = VkOf(p);
      if (vk == 0) {
        if (parts.Length == 1 && p.Length == 1) { KeyChar(p[0], false); KeyChar(p[0], true); return; }
        continue;
      }
      vks.Add(vk);
    }
    if (vks.Count == 0) return;
    for (int i = 0; i < vks.Count - 1; i++) KeyRaw(vks[i], false);
    KeyRaw(vks[vks.Count - 1], false);
    KeyRaw(vks[vks.Count - 1], true);
    for (int i = vks.Count - 2; i >= 0; i--) KeyRaw(vks[i], true);
  }

  /**
   * Inject text character by character through KEYEVENTF_UNICODE rather than VkKeyScan: Unicode
   * injection bypasses the active keyboard layout, so CJK / emoji / accented characters land exactly,
   * whereas layout-mapped synthesis silently drops all of them to "?".
   */
  public static void TypeText(string text) {
    foreach (char c in text) {
      if (c == '\r' || c == '\n') { KeyRaw(0x0D, false); KeyRaw(0x0D, true); continue; }
      if (c == '\t') { KeyRaw(0x09, false); KeyRaw(0x09, true); continue; }
      KeyChar(c, false);
      KeyChar(c, true);
    }
  }
}
"@

# 到了这里说明类型编译成功。命令分发里的单条失败不该拖垮整个助手，
# 交回 'Continue' 让它继续服务下一条命令（每条命令自己 try/catch 并回 ERR 行）。
$ErrorActionPreference = 'Continue'

Write-Output 'READY'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  if ($line -eq 'quit') { break }
  $parts = $line.Split(' ')
  try {
    switch ($parts[0]) {
      'desk' { [ClerkBoxInput]::SetDesktop([int]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4]); Write-Output 'OK' }
      'move' { [ClerkBoxInput]::Move([int]$parts[1], [int]$parts[2]); Write-Output 'OK' }
      'click' { [ClerkBoxInput]::Click([int]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4]); Write-Output 'OK' }
      'drag' { [ClerkBoxInput]::Drag([int]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4]); Write-Output 'OK' }
      'scroll' { [ClerkBoxInput]::Scroll([int]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4]); Write-Output 'OK' }
      'type' { [ClerkBoxInput]::TypeText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))); Write-Output 'OK' }
      'key' { [ClerkBoxInput]::KeyCombo([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))); Write-Output 'OK' }
      'apps' {
        $list = Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 60 -Property ProcessName, Id, MainWindowTitle
        $json = $list | ConvertTo-Json -Compress
        if ($null -eq $json) { $json = '[]' }
        Write-Output "OK $json"
      }
      'open' { Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))); Write-Output 'OK' }
      default { Write-Output 'ERR unknown-command' }
    }
  } catch {
    Write-Output "ERR $($_.Exception.Message)"
  }
}
`

interface PendingCommand {
  resolve: (payload: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class WindowsInputBackend implements DesktopInputBackend {
  readonly platform = 'win32' as const
  private proc: ChildProcess | null = null
  private scriptPath: string | null = null
  private starting: Promise<void> | null = null
  private pending: PendingCommand[] = []
  private buffer = ''
  private desk: VirtualDesktopRect | null = null
  /** 启动期的 stderr：Add-Type 编译失败的原因只在这里，不留档就得靠猜 */
  private startupStderr = ''

  /** 启动失败的完整原因。编译错误只出现在 stderr，丢掉它就只剩一句「helper 退出了」 */
  private startupError(reason: string): Error {
    const detail = this.startupStderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' | ')
    const base = `computer input helper startup failed: ${reason}`
    return new Error(detail ? `${base} — ${detail}` : base)
  }

  private ensureScript(): string {
    if (this.scriptPath) return this.scriptPath
    const dir = path.join(app.getPath('temp'), 'clerkbox')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'computer-input.ps1')
    // **必须写 UTF-8 BOM。** Windows PowerShell 5.1 对没有 BOM 的 .ps1 按系统 ANSI
    // 码页解码（本机是 GBK），脚本里的中文注释会被解成乱码，把内嵌 C# 源撑坏 ——
    // Add-Type 编译失败，而类型名 [ClerkBoxInput] 于是「不存在」。
    // 这个坑的表现极具迷惑性：报错指向运行时的类型找不到，真凶是文件编码。
    fs.writeFileSync(file, `\uFEFF${WIN_INPUT_SCRIPT}`, 'utf-8')
    this.scriptPath = file
    return file
  }

  private async spawnProcess(): Promise<void> {
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
        reject(this.startupError('startup timeout'))
        try { proc.kill() } catch { /* noop */ }
      }, START_TIMEOUT_MS)

      const onReady = (chunk: Buffer) => {
        if (settled) return
        if (!chunk.toString('utf-8').includes('READY')) return
        settled = true
        clearTimeout(readyTimer)
        proc.stdout?.off('data', onReady)
        this.attachReader(proc)
        resolve()
      }
proc.stdout?.on('data', onReady)
    // 启动期收 stderr：Add-Type 编译失败的原因只在这里
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (this.startupStderr.length < 8_000) this.startupStderr += chunk.toString('utf-8')
    })
      proc.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      proc.once('exit', () => {
        if (this.proc === proc) this.proc = null
        const waiting = this.pending.splice(0)
        for (const item of waiting) {
          clearTimeout(item.timer)
          item.reject(new Error('computer input helper exited'))
        }
        if (!settled) {
          settled = true
          clearTimeout(readyTimer)
          // 没等到 READY 就退了 —— 绝大多数情况是内嵌 C# 没编译过。
          // 把 stderr 带上，否则用户只看到「桌面控制工具暂时不可用」这种无信息量的报错
          reject(this.startupError(`exited during startup (code ${proc.exitCode})`))
        }
      })
      this.proc = proc
    })
  }

  private attachReader(proc: ChildProcess): void {
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8')
      let idx = this.buffer.indexOf('\n')
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (line.startsWith('OK') || line.startsWith('ERR')) {
          const pending = this.pending.shift()
          if (pending) {
            clearTimeout(pending.timer)
            if (line.startsWith('OK')) pending.resolve(line.slice(2).trim())
            else pending.reject(new Error(line.slice(4).trim() || 'computer input command failed'))
          }
        }
        idx = this.buffer.indexOf('\n')
      }
    })
  }

  private async ensureProcess(): Promise<void> {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      // 进程还活着，但几何只在启动时同步过一次。热插拔/改分辨率后基准会过期，
      // 这里比对一次，变了才补发，避免每次点击都多一轮往返
      if (this.desk && this.deskChanged()) await this.sendDesk()
      return
    }
    if (!this.starting) this.starting = this.spawnProcess()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
    if (this.desk) await this.sendDesk()
  }

  private deskChanged(): boolean {
    return screen
      .getAllDisplays()
      .map(virtualDesktopRect)
      .some((next) => !this.desk || next.x !== this.desk.x || next.y !== this.desk.y || next.width !== this.desk.width || next.height !== this.desk.height)
  }

  private async sendDesk(): Promise<void> {
    const rect = virtualDesktopRect()
    this.desk = rect
    await this.send(`desk ${rect.x} ${rect.y} ${rect.width} ${rect.height}`)
  }

  async setVirtualDesktop(rect: VirtualDesktopRect): Promise<void> {
    this.desk = rect
    await this.ensureProcess()
    await this.send(`desk ${rect.x} ${rect.y} ${rect.width} ${rect.height}`)
  }

  private send(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc = this.proc
      if (!proc || proc.exitCode !== null || proc.killed || !proc.stdin) {
        reject(new Error('computer input helper is not running'))
        return
      }
      const timer = setTimeout(() => {
        const i = this.pending.indexOf(entry)
        if (i !== -1) this.pending.splice(i, 1)
        reject(new Error('computer input command timeout'))
      }, COMMAND_TIMEOUT_MS)
      const entry: PendingCommand = { resolve, reject, timer }
      this.pending.push(entry)
      proc.stdin.write(`${command}\n`)
    })
  }

  async move(x: number, y: number): Promise<void> {
    await this.ensureProcess()
    await this.send(`move ${Math.round(x)} ${Math.round(y)}`)
  }
  async click(x: number, y: number, button: ComputerMouseButton, clickCount: number): Promise<void> {
    await this.ensureProcess()
    await this.send(`click ${Math.round(x)} ${Math.round(y)} ${button === 'right' ? 2 : button === 'middle' ? 3 : 1} ${clickCount}`)
  }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.ensureProcess()
    await this.send(`drag ${Math.round(from.x)} ${Math.round(from.y)} ${Math.round(to.x)} ${Math.round(to.y)}`)
  }
  async scroll(x: number | undefined, y: number | undefined, deltaX: number, deltaY: number): Promise<void> {
    await this.ensureProcess()
    await this.send(`scroll ${Math.round(x ?? -1)} ${Math.round(y ?? -1)} ${Math.round(deltaX)} ${Math.round(deltaY)}`)
  }
  async type(text: string): Promise<void> {
    await this.ensureProcess()
    await this.send(`type ${b64(text)}`)
  }
  async key(spec: string): Promise<void> {
    await this.ensureProcess()
    await this.send(`key ${b64(spec)}`)
  }
  async listApps(): Promise<ComputerAppInfo[]> {
    await this.ensureProcess()
    const payload = await this.send('apps')
    try {
      const parsed = JSON.parse(payload || '[]') as Array<{ ProcessName?: string; Id?: number; MainWindowTitle?: string }>
      return parsed.map((p) => ({ name: p.MainWindowTitle || p.ProcessName || 'unknown', pid: p.Id }))
    } catch {
      return []
    }
  }
  async openApp(name: string): Promise<void> {
    await this.ensureProcess()
    await this.send(`open ${b64(name)}`)
  }
  dispose(): void {
    const proc = this.proc
    this.proc = null
    if (!proc) return
    const waiting = this.pending.splice(0)
    for (const item of waiting) {
      clearTimeout(item.timer)
      item.reject(new Error('computer input helper terminated'))
    }
    try { proc.stdin?.end('quit\n') } catch { /* noop */ }
    try { proc.kill() } catch { /* noop */ }
  }
}

// ── macOS：osascript / System Events ──

/** AppleScript 字符串字面量转义：引号与反斜杠必须处理，否则标题里带引号就注入失败 */
function osaString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** macOS 键名 → System Events key code（只覆盖最常用的，其余回落到 Unicode 键入） */
const MAC_KEY_CODES: Record<string, number> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  command: 55,
  cmd: 55,
  shift: 56,
  control: 59,
  ctrl: 59,
  option: 58,
  alt: 58,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101,
  f10: 109, f11: 103, f12: 111,
}

class MacInputBackend implements DesktopInputBackend {
  readonly platform = 'darwin' as const
  async setVirtualDesktop(): Promise<void> {
    // System Events / cliclick 直接吃屏幕坐标，不做 65535 归一化，无需同步基准
  }
  /** System Events 没有指针移动/拖拽/滚轮原语，这三个动作要靠 cliclick；探测一次缓存结果 */
  private cliclickAvailable: boolean | null = null

  private run(script: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc = spawn('osascript', ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* noop */ }
        reject(new Error('osascript command timeout'))
      }, COMMAND_TIMEOUT_MS)
      proc.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8') })
      proc.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8') })
      proc.once('error', (e) => { clearTimeout(timer); reject(e) })
      proc.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(out.trim())
        else reject(new Error(err.trim() || `osascript exited with ${code}`))
      })
    })
  }

  private hasCliclick(): Promise<boolean> {
    if (this.cliclickAvailable !== null) return Promise.resolve(this.cliclickAvailable)
    return new Promise<boolean>((resolve) => {
      const proc = spawn('cliclick', ['-V'], { stdio: 'ignore' })
      proc.once('error', () => { this.cliclickAvailable = false; resolve(false) })
      proc.once('exit', (code) => { this.cliclickAvailable = code === 0; resolve(code === 0) })
    })
  }

  private cliclick(args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('cliclick', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* noop */ }
        reject(new Error('cliclick command timeout'))
      }, COMMAND_TIMEOUT_MS)
      proc.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8') })
      proc.once('error', (e) => { clearTimeout(timer); reject(new Error(`cliclick is not available: ${e.message}`)) })
      proc.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(err.trim() || `cliclick exited with ${code}`))
      })
    })
  }

  /**
   * 指针移动 / 拖拽 / 滚轮在 macOS 上只能靠 cliclick。
   * 没有它时明确报 platform_unsupported —— 用 System Events 去改窗口位置冒充移动指针、
   * 用 ⌘↓ 冒充滚轮，都是会「看起来成功但实际没做」的实现，比不做更糟。
   */
  private async requireCliclick(action: string): Promise<void> {
    if (!(await this.hasCliclick())) {
      throw new DesktopUnsupportedError(`macOS ${action} (install cliclick: brew install cliclick)`)
    }
  }

  async move(x: number, y: number): Promise<void> {
    await this.requireCliclick('pointer move')
    await this.cliclick([`m:${Math.round(x)},${Math.round(y)}`])
  }
  async click(x: number, y: number, button: ComputerMouseButton, clickCount: number): Promise<void> {
    const at = `{${Math.round(x)}, ${Math.round(y)}}`
    for (let i = 0; i < Math.max(1, clickCount); i++) {
      if (button === 'right') await this.run(`tell application "System Events" to click at ${at} using {button 2}`)
      else if (button === 'middle') await this.run(`tell application "System Events" to click at ${at} using {button 3}`)
      else if (clickCount >= 2) await this.run(`tell application "System Events" to double click at ${at}`)
      else await this.run(`tell application "System Events" to click at ${at}`)
      if (i < clickCount - 1) await new Promise((r) => setTimeout(r, 60))
    }
  }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.requireCliclick('drag')
    await this.cliclick([`dd:${Math.round(from.x)},${Math.round(from.y)}`, `du:${Math.round(to.x)},${Math.round(to.y)}`])
  }
  async scroll(x: number | undefined, y: number | undefined, deltaX: number, deltaY: number): Promise<void> {
    await this.requireCliclick('scroll')
    if (x !== undefined && y !== undefined) await this.cliclick([`m:${Math.round(x)},${Math.round(y)}`])
    const notches = Math.max(-20, Math.min(20, Math.round(-deltaY / 3)))
    if (notches !== 0) await this.cliclick([`wd:${notches}`])
  }
  async type(text: string): Promise<void> {
    await this.run(`tell application "System Events" to keystroke ${osaString(text)}`)
  }
  async key(spec: string): Promise<void> {
    const parts = spec.split('+').map((p) => p.trim()).filter(Boolean)
    const main = parts[parts.length - 1] ?? ''
    const mods = parts.slice(0, -1).map((m) => {
      const code = MAC_KEY_CODES[m.toLowerCase()]
      return code ? `${code} down` : ''
    }).filter(Boolean)
    const code = MAC_KEY_CODES[main.toLowerCase()]
    if (code !== undefined) {
      await this.run(`tell application "System Events" to key code ${code}${mods.length ? ` using {${mods.join(', ')}}` : ''}`)
      return
    }
    if (main.length === 1) {
      await this.run(`tell application "System Events" to keystroke ${osaString(main)}`)
      return
    }
    throw new Error(`Unsupported key on macOS: ${main}`)
  }
  async listApps(): Promise<ComputerAppInfo[]> {
    const out = await this.run('tell application "System Events" to get {name, unix id} of every process whose background only is false')
    const items = out.split('|').map((s) => s.split(', '))
    return items.map(([name, pid]) => ({ name: (name || '').trim(), pid: Number.parseInt(pid, 10) || undefined })).filter((a) => a.name)
  }
  async openApp(name: string): Promise<void> {
    await this.run(`tell application ${osaString(name)} to activate`)
  }
  dispose(): void { /* 按次拉起，无常驻资源 */ }
}

// ── Linux：xdotool ──

class LinuxInputBackend implements DesktopInputBackend {
  readonly platform = 'linux' as const
  async setVirtualDesktop(): Promise<void> {
    // xdotool 直接吃屏幕坐标
  }

  private run(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc = spawn('xdotool', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try { proc.kill() } catch { /* noop */ }
        reject(new Error('xdotool command timeout'))
      }, COMMAND_TIMEOUT_MS)
      proc.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8') })
      proc.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8') })
      proc.once('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`xdotool is not available: ${e.message}`))
      })
      proc.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(out.trim())
        else reject(new Error(err.trim() || `xdotool exited with ${code}`))
      })
    })
  }

  async move(x: number, y: number): Promise<void> { await this.run(['mousemove', String(Math.round(x)), String(Math.round(y))]) }
  async click(x: number, y: number, button: ComputerMouseButton, clickCount: number): Promise<void> {
    await this.run(['mousemove', String(Math.round(x)), String(Math.round(y))])
    for (let i = 0; i < Math.max(1, clickCount); i++) {
      await this.run(['click', button === 'right' ? '3' : button === 'middle' ? '2' : '1'])
      if (i < clickCount - 1) await new Promise((r) => setTimeout(r, 60))
    }
  }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.run(['mousemove', String(Math.round(from.x)), String(Math.round(from.y)), 'mousedown', '1'])
    const steps = 12
    for (let i = 1; i <= steps; i++) {
      await this.run(['mousemove', String(Math.round(from.x + ((to.x - from.x) * i) / steps)), String(Math.round(from.y + ((to.y - from.y) * i) / steps))])
    }
    await this.run(['mouseup', '1'])
  }
  async scroll(x: number | undefined, y: number | undefined, deltaX: number, deltaY: number): Promise<void> {
    if (x !== undefined && y !== undefined) await this.run(['mousemove', String(Math.round(x)), String(Math.round(y))])
    const notches = Math.max(-20, Math.min(20, Math.round(-deltaY / 3)))
    if (notches !== 0) await this.run(['click', '--repeat', String(Math.abs(notches)), notches > 0 ? '5' : '4'])
    if (deltaX !== 0) await this.run(['click', String(Math.max(-20, Math.min(20, Math.round(deltaX / 3)))), '7'])
  }
  async type(text: string): Promise<void> { await this.run(['type', '--clearmodifiers', '--delay', '8', text]) }
  async key(spec: string): Promise<void> { await this.run(['key', '--clearmodifiers', spec]) }
  async listApps(): Promise<ComputerAppInfo[]> {
    const out = await this.run(['search', '--onlyvisible', '--name', ''])
    return out.split('\n').map((line) => line.trim()).filter(Boolean).map((name) => ({ name }))
  }
  async openApp(name: string): Promise<void> {
    const proc = spawn('xdg-open', [name], { stdio: 'ignore', detached: true })
    proc.unref()
  }
  dispose(): void { /* 按次拉起，无常驻资源 */ }
}

let backend: DesktopInputBackend | null = null

export function getDesktopInputBackend(): DesktopInputBackend {
  if (backend) return backend
  if (process.platform === 'win32') backend = new WindowsInputBackend()
  else if (process.platform === 'darwin') backend = new MacInputBackend()
  else if (process.platform === 'linux') backend = new LinuxInputBackend()
  else backend = new UnsupportedBackend()
  return backend
}

class UnsupportedBackend implements DesktopInputBackend {
  readonly platform = 'unsupported' as const
  async setVirtualDesktop(): Promise<void> {
    // 任何动作都会走 fail()，这里不可能被用到
  }
  private fail(): never {
    throw new DesktopUnsupportedError(process.platform)
  }
  async move(): Promise<void> { this.fail() }
  async click(): Promise<void> { this.fail() }
  async drag(): Promise<void> { this.fail() }
  async scroll(): Promise<void> { this.fail() }
  async type(): Promise<void> { this.fail() }
  async key(): Promise<void> { this.fail() }
  async listApps(): Promise<ComputerAppInfo[]> { this.fail() }
  async openApp(): Promise<void> { this.fail() }
  dispose(): void { /* noop */ }
}

export function disposeDesktopInputBackend(): void {
  backend?.dispose()
  backend = null
}
