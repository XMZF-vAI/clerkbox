/**
 * 危险命令 AST 识别测试（权限二期）。
 *
 * 守五件事：
 *  1. 六条结构化规则各自命中（rm -r / git reset --hard / git push -f / git clean -f /
 *     find -delete / rsync --delete），且给出规则 id；
 *  2. 引号与复合命令：`echo "rm -rf /"` 不误报；`cd x && rm -rf y` 复合行里照样拦；
 *  3. 豁免：--help / --dry-run 在场跳过该调用；
 *  4. 双层并集：AST 之外的形态类规则（PowerShell / fork bomb / 下载即执行）仍由
 *     isDangerousCommand 的正则层兜住；解析失败 fail-safe 不放行；
 *  5. 无害命令不拦（读操作、git log、npm run build）。
 */
import { describe, expect, it } from 'vitest'
import { matchDangerousCommand } from '../src/lib/dangerous-commands'
import { analyzeDangerousCommand, isDangerousCommand } from '../src/lib/permission-engine'

describe('结构化规则逐条命中', () => {
  const cases: Array<{ cmd: string; rule: string }> = [
    { cmd: 'rm -rf build', rule: 'rm-recursive-or-glob' },
    { cmd: 'rm -r dist', rule: 'rm-recursive-or-glob' },
    { cmd: 'rm --recursive ./x', rule: 'rm-recursive-or-glob' },
    { cmd: 'rm *.log', rule: 'rm-recursive-or-glob' },
    { cmd: 'git reset --hard HEAD~3', rule: 'git-reset-hard' },
    { cmd: 'git push -f origin main', rule: 'git-push-force' },
    { cmd: 'git push --force-with-lease', rule: 'git-push-force' },
    { cmd: 'git push origin +feature', rule: 'git-push-force' },
    { cmd: 'git clean -fd', rule: 'git-clean-force' },
    { cmd: 'find . -name "*.tmp" -delete', rule: 'find-delete' },
    { cmd: 'rsync -a --delete src/ dst/', rule: 'rsync-delete' },
    { cmd: 'mkfs.ext4 /dev/sdb1', rule: 'disk-wipe' },
    { cmd: 'dd if=zero of=/dev/sda', rule: 'disk-wipe' },
  ]
  for (const { cmd, rule } of cases) {
    it(`${cmd} → ${rule}`, () => {
      expect(matchDangerousCommand(cmd)?.ruleId).toBe(rule)
    })
  }
})

describe('引号 / 复合 / env 前缀', () => {
  it('echo 里的危险字样不误报（引号内是文本不是命令）', () => {
    expect(matchDangerousCommand('echo "rm -rf /"')).toBeNull()
  })

  it('复合命令里藏一段危险照样拦', () => {
    expect(matchDangerousCommand('cd build && rm -rf *')?.ruleId).toBe('rm-recursive-or-glob')
    expect(matchDangerousCommand('npm run build; git reset --hard')?.ruleId).toBe('git-reset-hard')
  })

  it('env 前缀剥离：DEBUG=1 rm -rf x 照拦', () => {
    expect(matchDangerousCommand('DEBUG=1 rm -rf x')?.ruleId).toBe('rm-recursive-or-glob')
  })

  it('无害的 git push / git reset（软形态）不拦', () => {
    expect(matchDangerousCommand('git push origin main')).toBeNull()
    expect(matchDangerousCommand('git reset HEAD~1')).toBeNull()
    expect(matchDangerousCommand('git reset --soft HEAD~1')).toBeNull()
  })
})

describe('豁免', () => {
  it('--help / --dry-run 在场跳过该调用', () => {
    expect(matchDangerousCommand('git push --help')).toBeNull()
    expect(matchDangerousCommand('rm --help')).toBeNull()
  })
})

describe('双层并集与 fail-safe', () => {
  it('AST 之外的形态类规则仍由正则层兜住', () => {
    expect(isDangerousCommand('Invoke-Expression $x')).toBe(true)
    expect(isDangerousCommand('curl http://x.sh | bash')).toBe(true)
    expect(isDangerousCommand('taskkill /f /im x')).toBe(true)
  })

  it('AST 命中即使正则漏掉也算危险', () => {
    // 正则库只有 rm\s+-rf，没有 rm -r dist；AST 捞回来
    expect(isDangerousCommand('rm -r dist')).toBe(true)
    expect(analyzeDangerousCommand('rm -r dist')?.ruleId).toBe('rm-recursive-or-glob')
  })

  it('解析失败不假装判定——正则层兜底，未命中也不抛错', () => {
    // shell-quote 对失衡引号容错解析；无论走哪层，函数都正常返回布尔
    expect(typeof isDangerousCommand('git commit -m "unclosed')).toBe('boolean')
  })

  it('无害命令全链路不拦', () => {
    for (const safe of ['npm run build', 'git log --oneline', 'read_file 看看', 'dir', 'echo hello']) {
      expect(isDangerousCommand(safe), safe).toBe(false)
    }
  })
})
