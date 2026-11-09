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

// NSIS 靠 BOM 判定许可文本编码：无 BOM 时按构建机 ANSI 代码页解码，中文协议在非 936
// 代码页上就是乱码。electron-builder 只有多语言 license_*.txt 分支会补 BOM，自动探测到的
// 单文件 build/license.txt 原样交给 MUI_PAGE_LICENSE，所以 BOM 必须由这里写入。
const tmpl = readFileSync(join(root, 'build', 'license.txt.tmpl'), 'utf8').replace(/^\uFEFF/, '')
if (!tmpl.includes('{{VERSION}}')) {
  console.error('[sync-version] build/license.txt.tmpl 缺少 {{VERSION}} 占位符')
  process.exit(1)
}
writeFileSync(
  join(root, 'build', 'license.txt'),
  `\uFEFF${tmpl.replaceAll('{{VERSION}}', version).replace(/\r?\n/g, '\r\n')}`,
  'utf8',
)
console.log(`[sync-version] build/license.txt -> v${version}`)
