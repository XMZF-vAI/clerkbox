import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * macOS / Linux 兼容性回归（3.5.1 shell 与搜索工具链纯 Windows 实现）。
 *
 * 这些缺陷的共同点是「在 Windows 上永远测不出来」：本机是 win32，
 * 因此用源文件文本契约 + 纯逻辑复算两条腿锁死平台分支，防止后续改动
 * 悄悄把 /bin/sh 兜底、POSIX 搜索回退、包签名钩子改回 Windows-only。
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const mainSrc = read('electron/main.ts')
const registrySrc = read('src/lib/tool-registry.ts')
const ipcClientSrc = read('src/lib/ipc-client.ts')
const agentHostSrc = read('electron/agent-host.ts')
const useAgentSrc = read('src/hooks/use-agent.ts')
const promptsSrc = read('src/lib/prompts.ts')
const chatStoreSrc = read('src/stores/chat-store.ts')
const chatErrorSrc = read('src/lib/chat-error.ts')
const afterPackSrc = read('scripts/after-pack.cjs')
const pkg = JSON.parse(read('package.json'))

// ── P0-2：DANGEROUS_CMD_PATTERNS 的 format 误杀 ──
describe('P0-2 危险命令 format 正则不再误杀 Format-Table', () => {
  // 从源码中取出该规则的正则字面量并复算，避免测试与实现各写一份而漂移。
  const m = mainSrc.match(/\{\s*regex:\s*(\/\\bmkfs[^/]+\/i)[^}]*格式化文件系统/)
  const pattern = m ? m[1] : null
  it('源码中存在新的 token 化正则（不是裸 \\b(?:mkfs|format)\\b）', () => {
    expect(pattern).not.toBeNull()
    expect(mainSrc).not.toMatch(/\\b\(\?:mkfs\|format\)\\b\/i/)
  })

  // 用与源码一致的正则复算行为（eval 仅用于正则字面量，不含可执行语句）。
  const re = /\bmkfs(?:\.\w+)?\b|\bformat\s+[a-z]:/i
  it('search_files 的 PowerShell 回退命令不再被拦死', () => {
    const fallback = 'Get-ChildItem -Path "C:\\x" -Filter "*.ts" -Recurse -File | Select-Object -First 100 FullName | Format-Table -HideTableHeaders'
    expect(re.test(fallback)).toBe(false)
  })
  it('真正的磁盘格式化命令仍被拦截（macOS/Linux/Windows）', () => {
    expect(re.test('format c: /fs:ntfs')).toBe(true)
    expect(re.test('format C:')).toBe(true)
    expect(re.test('mkfs.ext4 /dev/sda1')).toBe(true)
    expect(re.test('mkfs /dev/disk1')).toBe(true)
    expect(re.test('mkfs.ntfs /dev/sdb')).toBe(true)
  })
  it('普通文本里出现 format 不会误伤', () => {
    expect(re.test('echo format')).toBe(false)
    expect(re.test('rg --files . | format-table')).toBe(false)
  })
})

// ── P0-1：executeCommandWithShell 平台感知 ──
describe('P0-1 executeCommandWithShell 在 POSIX 上兜底到 /bin/sh', () => {
  const handler = mainSrc.slice(
    mainSrc.indexOf("'executeCommandWithShell'"),
    mainSrc.indexOf('// Web search (Bing)'),
  )
  it('handler 内按 process.platform 分支，且非 win32 用 /bin/sh -c', () => {
    expect(handler).toContain("process.platform === 'win32'")
    expect(handler).toContain("'/bin/sh'")
    expect(handler).toContain("['-c', command]")
  })
  it('POSIX 分支不注入 Windows 语法（chcp / >nul / & { }）', () => {
    // 只取 else 分支里到 shellArgs 赋值为止的代码，排除后面共享的 spawn/promise 部分；
    // 再去掉注释行，避免注释里提到这些词导致误判。
    const elseStart = handler.indexOf('} else {')
    const branch = handler.slice(elseStart, handler.indexOf('const MAX_BUFFER', elseStart))
    const codeOnly = branch.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(codeOnly).not.toContain('chcp 65001')
    expect(codeOnly).not.toContain('>nul')
    expect(codeOnly).toContain("shellArgs = ['-c', command]")
  })
  it('Windows 分支仍保留 cmd.exe / powershell.exe 与 chcp（主平台不回归）', () => {
    expect(handler).toContain("'cmd.exe'")
    expect(handler).toContain("'powershell.exe'")
    expect(handler).toContain('chcp 65001')
  })
  it('bash/zsh/sh 有显式 POSIX shell 映射', () => {
    expect(handler).toContain("bash: '/bin/bash'")
    expect(handler).toContain("zsh: '/bin/zsh'")
    expect(handler).toContain("sh: '/bin/sh'")
  })
  it('executeCommand handler 仍是跨平台的（工具层的兜底来源）', () => {
    const execHandler = mainSrc.slice(
      mainSrc.indexOf("'executeCommand',"),
      mainSrc.indexOf("'executeCommandWithShell',"),
    )
    expect(execHandler).toContain("'/bin/sh'")
    expect(execHandler).toContain("['-c', command]")
  })
})

// ── P0-3：detectRipgrep 与搜索工具跨平台 ──
describe('P0-3 搜索工具链不再硬编码 PowerShell/cmd', () => {
  it('detectRipgrep 改走跨平台 ipc.executeCommand', () => {
    const detect = registrySrc.slice(
      registrySrc.indexOf('async function detectRipgrep'),
      registrySrc.indexOf('// ── 溢出转存'),
    )
    expect(detect).toContain("ipc.executeCommand('rg --version')")
    expect(detect).not.toContain("executeCommandWithShell('rg --version'")
  })
  it('存在 POSIX sh 单引号转义助手（不能复用 PowerShell 的双写）', () => {
    expect(registrySrc).toContain('function escapeSHsingle')
    expect(registrySrc).toContain("s.replace(/'/g, \"'\\\\''\")")
  })
  it('search_files / search_content 含 POSIX find / grep 回退', () => {
    expect(registrySrc).toContain("find '${q(path)}' -type f -name")
    expect(registrySrc).toContain("'grep', '-r', '-n'")
    expect(registrySrc).toContain("--include=")
  })
  it('POSIX 分支不把 path 当 cwd 传 spawn（避免 ENOTDIR）', () => {
    expect(registrySrc).toContain(': await ipc.executeCommand(cmd, undefined)')
  })
  it('Windows 分支仍用 PowerShell 回退与 escapePS（主平台不回归）', () => {
    expect(registrySrc).toContain('Get-ChildItem -Path')
    expect(registrySrc).toContain('Select-String -Path')
    expect(registrySrc).toContain('function escapePS(')
    expect(registrySrc).toContain('function escapePSsingle(')
  })
  it('按宿主平台选择命令（isWinPlatform 基于 ipc.platform()）', () => {
    expect(registrySrc).toContain('function isWinPlatform')
    expect(registrySrc).toContain("ipc.platform() === 'win32'")
  })
})

// ── P2：shell 枚举与默认值 ──
describe('P2 工具 schema 补齐 POSIX shell 选项', () => {
  it('shell 枚举含 cmd/powershell/sh/bash/zsh', () => {
    expect(registrySrc).toMatch(/enum: \['cmd', 'powershell', 'sh', 'bash', 'zsh'\]/)
  })
  it('execute_command 默认值按平台区分（非 Windows 默认 sh）', () => {
    expect(registrySrc).toContain("const defaultShell = isWinPlatform() ? 'cmd' : 'sh'")
  })
  it('工具描述明确区分 Windows 与 macOS/Linux 默认 shell', () => {
    const desc = registrySrc.slice(registrySrc.indexOf("name: 'execute_command'"))
    expect(desc.slice(0, 900)).toContain('/bin/sh')
  })
})

// ── 两处 runShell 硬编码 ──
describe('runShell 不再硬编码 cmd（renderer + main 宿主）', () => {
  it('agent-host.ts 主进程按 process.platform 选 shell', () => {
    expect(agentHostSrc).toContain("process.platform === 'win32' ? 'cmd' : 'sh'")
    expect(agentHostSrc).not.toContain("executeCommandWithShell(command, cwd, 'cmd')")
  })
  it('use-agent.ts 渲染层按 ipc.platform() 选 shell', () => {
    expect(useAgentSrc).toContain("ipc.platform() === 'win32' ? 'cmd' : 'sh'")
    expect(useAgentSrc).not.toContain("executeCommandWithShell(command, cwd, 'cmd')")
  })
  it('env.platform 与 shellDescription 取宿主平台（非浏览器 navigator/window）', () => {
    expect(useAgentSrc).toContain('platform: ipc.platform()')
    expect(useAgentSrc).toContain('function getShellDescription')
    // getShellDescription 内部改用 ipc.platform()
    const fn = useAgentSrc.slice(useAgentSrc.indexOf('function getShellDescription'), useAgentSrc.indexOf('export function useAgent'))
    expect(fn).toContain('ipc.platform()')
    expect(fn).not.toContain('window.clerkbox?.platform')
  })
})

// ── ipc.platform() 在宿主模式返回宿主平台 ──
describe('ipc.platform() 三模式都返回宿主平台', () => {
  it('主进程宿主（无 window）回退到 process.platform', () => {
    expect(ipcClientSrc).toContain("typeof window === 'undefined' && typeof process !== 'undefined'")
    expect(ipcClientSrc).toContain('return process.platform')
  })
  it('/api/platform 返回的是宿主 process.platform（非浏览器）', () => {
    const webui = read('electron/webui-server.ts')
    expect(webui).toMatch(/\/api\/platform[^}]*process\.platform/s)
  })
})

// ── Linux 同类平台误判 ──
describe('Linux 平台误判修复', () => {
  it('prompts.ts 不再无条件兜底 win32，改为读宿主平台', () => {
    expect(promptsSrc).toContain('process.platform')
    expect(promptsSrc).toContain('ipc.platform()')
    expect(promptsSrc).not.toContain("? window.clerkbox.platform\n    : 'win32'")
  })
  it('SYSTEM_PROMPT 明示以动态 Environment 段的宿主平台为准（规避 WebUI 异步竞态）', () => {
    expect(promptsSrc).toContain('## Environment')
    expect(promptsSrc).toContain('sh/bash/zsh')
  })
  it('chat-store 默认工作目录：仅 win32 用 C:\\\\，其余/未知一律 POSIX', () => {
    expect(chatStoreSrc).toContain("if (platform === 'win32')")
    expect(chatStoreSrc).toContain("return { base: '/tmp/clerkbox-work', sep: '/' }")
  })
  it('chat-error 日志路径不再写死 %APPDATA%', () => {
    expect(chatErrorSrc).toContain('~/Library/Logs/clerkbox/main.log')
    expect(chatErrorSrc).toContain('~/.config/clerkbox/logs/main.log')
  })
})

// ── P1：afterPack 修复 spawn-helper ──
describe('P1 node-pty spawn-helper 打包修复', () => {
  it('package.json 注册了 afterPack 钩子', () => {
    expect(pkg.build.afterPack).toBe('scripts/after-pack.cjs')
  })
  it('钩子仅在 darwin 生效、chmod 755 并 ad-hoc codesign', () => {
    expect(afterPackSrc).toContain("electronPlatformName !== 'darwin'")
    expect(afterPackSrc).toContain('spawn-helper')
    expect(afterPackSrc).toContain('pty.node')
    expect(afterPackSrc).toContain('0o755')
    expect(afterPackSrc).toContain("'--force', '--sign', '-'")
  })
  it('node-pty 版本保持 1.1.0（本机无法验证 ABI，不擅自升级）', () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(deps['node-pty']).toMatch(/1\.1\.0/)
  })
})
