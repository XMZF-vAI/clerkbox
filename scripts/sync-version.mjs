/**
 * 发版时唯一需要改的版本号是 package.json 的 version 字段。
 * 本脚本在构建前据此生成 build/license.txt（安装器许可协议），
 * 其余版本引用各自动态取值：About 页 = vite define 的 __APP_VERSION__，
 * MCP Client = app.getVersion()。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// license.txt 为 GBK 字节流，用 latin1 读写做 1:1 字节替换，避免任何编码转换
const tmpl = readFileSync(join(root, 'build', 'license.txt.tmpl')).toString('latin1')
if (!tmpl.includes('{{VERSION}}')) {
  console.error('[sync-version] build/license.txt.tmpl 缺少 {{VERSION}} 占位符')
  process.exit(1)
}
writeFileSync(
  join(root, 'build', 'license.txt'),
  Buffer.from(tmpl.replaceAll('{{VERSION}}', version), 'latin1'),
)
console.log(`[sync-version] build/license.txt -> v${version}`)
