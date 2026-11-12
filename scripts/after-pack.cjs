/**
 * electron-builder afterPack 钩子：修复 macOS 上 node-pty 的 PTY 无法创建问题。
 *
 * 现象：ptyCreate 抛 `Error: posix_spawnp failed`（node_modules/node-pty/lib/unixTerminal.js）。
 * 根因：node-pty 的 Unix 后端在 fork 时需要执行 `spawn-helper`（一个 Mach-O 可执行
 * 文件）。electron-builder 把 node-pty 解包到 `app.asar.unpacked/` 后，该文件的可执行
 * 位可能丢失，且它与 Electron 主程序的 hardened runtime / 代码签名不匹配，导致
 * posix_spawnp 被系统拒绝。
 *
 * 修复：打包完成后（dmg 生成前）遍历 app.asar.unpacked 里的 node-pty/prebuilds，
 * 对所有 spawn-helper 与 pty.node 执行 chmod 755 并 ad-hoc 重签名。
 * 仅在 darwin 目标执行；文件不存在或非 mach-O 时静默跳过，保证幂等、不阻断构建。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

/** 递归收集 dir 下所有匹配 fileName 的文件路径。 */
function findFiles(dir, fileName, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findFiles(full, fileName, out)
    else if (entry.name === fileName) out.push(full)
  }
  return out
}

module.exports = async function afterPack(context) {
  // electron-builder 传入 electronPlatformName：darwin / win32 / linux
  if (context.electronPlatformName !== 'darwin') return

  const appOutDir = context.appOutDir
  // 定位 <App>.app/Contents/Resources/app.asar.unpacked
  let asarUnpacked = null
  try {
    const appDir = fs.readdirSync(appOutDir).find((n) => n.endsWith('.app'))
    if (appDir) {
      const candidate = path.join(appOutDir, appDir, 'Contents', 'Resources', 'app.asar.unpacked')
      if (fs.existsSync(candidate)) asarUnpacked = candidate
    }
  } catch {
    /* 目录结构异常则跳过，不阻断构建 */
  }
  if (!asarUnpacked) {
    console.log('[afterPack] app.asar.unpacked not found; skipping node-pty fix')
    return
  }

  const nodePtyRoot = path.join(asarUnpacked, 'node_modules', 'node-pty')
  if (!fs.existsSync(nodePtyRoot)) return

  const targets = [
    ...findFiles(nodePtyRoot, 'spawn-helper'),
    ...findFiles(nodePtyRoot, 'pty.node'),
  ]
  if (targets.length === 0) {
    console.log('[afterPack] no node-pty binaries found; skipping')
    return
  }

  for (const file of targets) {
    try {
      fs.chmodSync(file, 0o755)
    } catch (e) {
      console.warn(`[afterPack] chmod failed for ${file}: ${e.message}`)
    }
    // ad-hoc 重签名：解除 quarantine / 与 hardened runtime 不一致导致的 spawn 拒绝。
    // 仅在 codesign 可用的 macOS 构建机上执行；失败不致命（保留原签名继续）。
    try {
      execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'ignore' })
      console.log(`[afterPack] chmod + ad-hoc signed ${path.relative(asarUnpacked, file)}`)
    } catch (e) {
      console.warn(`[afterPack] codesign failed for ${file}: ${e.message}`)
    }
  }
}
