// 发布脚本：GitHub REST API 创建 release 并上传资产
// 用法：node publish-release.cjs <tag> <notesFile>
// 规避 electron-builder v26 并发上传 bug（多个草稿 + 资产分裂）
const fs = require('fs')
const path = require('path')
const https = require('https')

const TOKEN = process.env.GH_TOKEN
const REPO = 'XMZF-vAI/clerkbox'
const [tag, notesFile] = process.argv.slice(2)
if (!TOKEN || !tag || !notesFile) {
  console.error('usage: node publish-release.cjs <tag> <notesFile>')
  process.exit(1)
}
const notes = fs.readFileSync(notesFile, 'utf-8')
const OUT_DIR = path.join(__dirname, 'release-out')

function api(method, urlPath, body, contentType = 'application/json', isUpload = false) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    const headers = {
      'Authorization': `Bearer ${TOKEN}`,
      'User-Agent': 'clerkbox-release-script',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (payload && !isUpload) headers['Content-Type'] = contentType
    if (isUpload) headers['Content-Type'] = contentType
    if (payload && !isUpload) headers['Content-Length'] = payload.length
    const req = https.request({
      hostname: isUpload ? 'uploads.github.com' : 'api.github.com',
      path: urlPath,
      method,
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        let json = null
        try { json = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
        if (res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 400)}`))
        } else {
          resolve(json)
        }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function uploadAsset(uploadUrl, filePath) {
  const name = encodeURIComponent(path.basename(filePath))
  const urlPath = uploadUrl.replace('https://uploads.github.com', '') + `?name=${name}`
  const data = fs.readFileSync(filePath)
  return api('POST', urlPath, data, 'application/octet-stream', true)
}

async function main() {
  // 0. 清理同名 release（含草稿），避免 v26 bug 遗留重复草稿
  const releases = await api('GET', `/repos/${REPO}/releases?per_page=100`)
  const existing = releases.filter((r) => r.tag_name === tag)
  for (const r of existing) {
    console.log(`delete existing ${r.draft ? 'draft' : 'release'} id=${r.id}`)
    await api('DELETE', `/repos/${REPO}/releases/${r.id}`)
  }

  // 1. 创建 release
  console.log(`create release ${tag} ...`)
  const release = await api('POST', `/repos/${REPO}/releases`, {
    tag_name: tag,
    name: tag.startsWith('v') ? tag : `v${tag}`,
    body: notes,
    draft: false,
    prerelease: false,
  })
  console.log(`created: id=${release.id} html_url=${release.html_url}`)

  // 2. 收集资产
  const assets = fs.readdirSync(OUT_DIR).filter((f) =>
    /\.(exe|blockmap|yml)$/i.test(f) || /latest\.yml$/i.test(f)
  )
  if (assets.length === 0) throw new Error(`no assets found in ${OUT_DIR}`)
  for (const f of assets) {
    const p = path.join(OUT_DIR, f)
    const size = fs.statSync(p).size
    console.log(`upload ${f} (${(size / 1024 / 1024).toFixed(1)} MB) ...`)
    await uploadAsset(release.upload_url, p)
  }
  console.log('DONE:', release.html_url)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
