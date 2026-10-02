import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * Windows 输入助手的**编码契约**守卫。
 *
 * 由来：「桌面控制工具暂时不可用」，报错是「找不到类型 [ClerkBoxInput]」。
 * 排查下来 C# 一行错都没有，Add-Type -Path 编译同一份代码直接过。
 *
 * 真凶是**文件编码**：`ensureScript` 原来用 `writeFileSync(file, script, 'utf-8')`，
 * 不写 BOM。而 Windows PowerShell 5.1 对没有 BOM 的 .ps1 按系统 ANSI 码页解码
 * （本机 GBK），脚本里的中文注释被解成乱码，把内嵌 C# 源撑坏 → Add-Type 编译失败。
 *
 * 迷惑性在于两件事叠加：
 *   1. 报错指向运行时的「类型找不到」，真凶在编译期的文件编码；
 *   2. 脚本里 `$ErrorActionPreference = 'Continue'` 让编译失败变成**非终止**错误，
 *      于是脚本继续跑到命令分发，每条命令都报一次「找不到类型」——
 *      一个编译错误被伪装成了十几次莫名其妙的运行时错误。
 *
 * 所以这里锁三条：写 BOM、Add-Type 期间必须 Stop、失败信息要带得上 stderr。
 */

const source = readFileSync(
  fileURLToPath(new URL('../electron/computer-input.ts', import.meta.url)),
  'utf8',
)

describe('Windows 输入助手的编码契约', () => {
  it('落盘必须带 UTF-8 BOM（无 BOM 时 PowerShell 5.1 按 ANSI 解码，中文注释会撑坏 C# 源）', () => {
    const write = source.match(/writeFileSync\(\s*file\s*,[\s\S]{0,120}/)
    expect(write).not.toBeNull()
    const line = write![0]
    expect(line).toMatch(/`\\uFEFF\$\{WIN_INPUT_SCRIPT\}`/)
    // 同时确认不是裸写
    expect(line).not.toMatch(/WIN_INPUT_SCRIPT,\s*'utf-8'\)/)
  })

  it('Add-Type 期间 $ErrorActionPreference 必须是 Stop', () => {
    // 必须是 Stop 出现在 Add-Type 之前，Continue 出现在之后
    const stopIdx = source.indexOf("$ErrorActionPreference = 'Stop'")
    const addTypeIdx = source.indexOf('Add-Type -TypeDefinition')
    const continueIdx = source.indexOf("$ErrorActionPreference = 'Continue'")
    expect(stopIdx).toBeGreaterThan(-1)
    expect(addTypeIdx).toBeGreaterThan(stopIdx)
    expect(continueIdx).toBeGreaterThan(addTypeIdx)
  })

  it('命令分发阶段才降级为 Continue（单条命令失败不该拖垮整个助手）', () => {
    const loopIdx = source.indexOf('while ($true) {')
    expect(loopIdx).toBeGreaterThan(source.indexOf("$ErrorActionPreference = 'Continue'"))
  })

  it('启动失败要带上 stderr，否则只剩一句无信息量的「工具不可用」', () => {
    expect(source).toContain('private startupError(')
    expect(source).toContain("proc.stderr?.on('data'")
    // 两条启动失败路径都要用它
    expect(source).toContain("reject(this.startupError('startup timeout'))")
    expect(source).toMatch(/reject\(this\.startupError\(`exited during startup/)
  })

  it('READY 只在类型编译成功之后打印', () => {
    const readyIdx = source.indexOf("Write-Output 'READY'")
    const continueIdx = source.indexOf("$ErrorActionPreference = 'Continue'")
    // Continue（类型已就绪）之后才是 READY
    expect(readyIdx).toBeGreaterThan(continueIdx)
  })
})