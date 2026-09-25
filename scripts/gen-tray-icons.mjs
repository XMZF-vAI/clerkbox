/**
 * 生成系统托盘图标。
 *
 * 设计要点：
 * - **不引入任何新依赖、不调用外部工具**（本机无 Pillow / ImageMagick）：纯 Node 手写
 *   PNG 解码（zlib inflate + 反滤波）与编码（zlib + CRC32）。`pngjs` 只是 qrcode 的
 *   传递依赖、未声明在 package.json，构建脚本不能依赖它存在。
 * - 图案取自应用图标 `build/icon.png` 的 CB 立方体，但**不能整块图标直接缩放**：
 *   图标里立方体只占约 2/3 画幅，缩到 Windows 实际显示的 16×16 会糊成一团白斑。
 *   故先量出字形包围盒、裁出来撑满托盘格，再降采样。
 * - Windows / Linux 保留源图的深色圆角底：托盘底色可能是浅色，只留白色字形会看不见。
 * - macOS 模板图要求「纯黑 + alpha」，故按亮度抠出字形剪影（含字形间的分隔缝），
 *   同一套包围盒与降采样，只差在取色方式。
 * - 输出尺寸按各平台惯例：win 32×32（Electron 自行降到 16/24）；Linux 22×22 + 44×44@2x；
 *   mac 16×16 + 32×32@2x。
 *
 * 用法：`npm run gen:tray-icons`
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'build')
const SOURCE = join(ROOT, 'build', 'icon.png')

/** 字形判定：亮度低于 LO 视为背景（含深色底与字形间的分隔缝），高于 HI 视为字形，中间平滑过渡 */
const INK_LO = 0.25
const INK_HI = 0.55
/** 包围盒四周留白占字形尺寸的比例，太小会顶到托盘格边缘 */
const PADDING = 0.06

// ── 最小 PNG 解码（仅支持本仓库源图所需：8bit / RGBA / 非隔行）──
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG')
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const bitDepth = buffer[24]
  const colorType = buffer[25]
  const interlace = buffer[27]
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(
      `unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}` +
      `（需要 8/6/0，请把源图导出为 8bit RGBA 非隔行）`,
    )
  }

  const chunks = []
  for (let off = 8; off + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(off)
    const type = buffer.toString('ascii', off + 4, off + 8)
    if (type === 'IDAT') chunks.push(buffer.subarray(off + 8, off + 8 + length))
    off += 12 + length
  }
  const stride = width * 4
  const raw = inflateSync(Buffer.concat(chunks))

  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }

  const rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    const outStart = y * stride
    for (let x = 0; x < stride; x++) {
      const byte = raw[rowStart + x]
      const a = x >= 4 ? rgba[outStart + x - 4] : 0
      const b = y > 0 ? rgba[outStart - stride + x] : 0
      const c = x >= 4 && y > 0 ? rgba[outStart - stride + x - 4] : 0
      let value
      switch (filter) {
        case 0: value = byte; break
        case 1: value = byte + a; break
        case 2: value = byte + b; break
        case 3: value = byte + ((a + b) >> 1); break
        case 4: value = byte + paeth(a, b, c); break
        default: throw new Error(`unknown PNG filter ${filter} at row ${y}`)
      }
      rgba[outStart + x] = value & 0xff
    }
  }
  return { width, height, rgba }
}

const luminanceOf = (rgba, i) =>
  (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255

/** 字形覆盖度（smoothstep 软阈值），深色底与字形分隔缝归零，白色字形为 1 */
function inkOf(rgba, i) {
  const t = Math.min(1, Math.max(0, (luminanceOf(rgba, i) - INK_LO) / (INK_HI - INK_LO)))
  return t * t * (3 - 2 * t)
}

/** 亮部（字形本体）的最小外接矩形，按正方形取边并留 PADDING，保证缩放不变形 */
function glyphRect({ width, height, rgba }) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inkOf(rgba, (y * width + x) * 4) < 0.5) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) throw new Error('源图里找不到字形（亮部像素为 0），检查 build/icon.png')

  const side = Math.max(maxX - minX, maxY - minY) + 1
  const pad = Math.round(side * PADDING)
  const extent = side + pad * 2
  const cx = (minX + maxX + 1) / 2
  const cy = (minY + maxY + 1) / 2
  // 夹在源图内：留白被切掉时宁可贴边，也不引入源图外的假像素
  const x = Math.min(Math.max(0, Math.round(cx - extent / 2)), Math.max(0, width - extent))
  const y = Math.min(Math.max(0, Math.round(cy - extent / 2)), Math.max(0, height - extent))
  return { x, y, size: Math.min(extent, width, height) }
}

/**
 * 把源图的 rect 区域降采样到 size×size：对每个输出像素覆盖的源区域做**分数边界面积
 * 加权平均**（源边长 / 目标边长通常不整除，整数盒式会偏色丢边）。
 * - photo：保留源图颜色，即深色圆角底 + 白色字形。托盘底可能是浅色，纯白字形会看不见，
 *   所以 Windows / Linux 走这条。
 * - template：macOS 模板图，只取字形覆盖度作 alpha、颜色统一为黑，由系统按菜单栏
 *   深浅自动反色。
 */
function render(src, rect, size, mode) {
  const { width, height, rgba } = src
  const out = Buffer.alloc(size * size * 4)
  const step = rect.size / size

  for (let py = 0; py < size; py++) {
    const y0 = rect.y + py * step
    const y1 = y0 + step
    for (let px = 0; px < size; px++) {
      const x0 = rect.x + px * step
      const x1 = x0 + step

      let accR = 0
      let accG = 0
      let accB = 0
      let accA = 0
      for (let sy = Math.floor(y0); sy < Math.min(height, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (wy <= 0) continue
        for (let sx = Math.floor(x0); sx < Math.min(width, Math.ceil(x1)); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
          if (wx <= 0) continue
          const weight = wx * wy
          const i = (sy * width + sx) * 4
          if (mode === 'template') {
            accA += inkOf(rgba, i) * weight
            continue
          }
          const alpha = (rgba[i + 3] / 255) * weight
          accA += alpha
          accR += rgba[i] * alpha
          accG += rgba[i + 1] * alpha
          accB += rgba[i + 2] * alpha
        }
      }

      const alpha = accA / (step * step)
      if (alpha <= 0) continue
      const o = (py * size + px) * 4
      if (mode === 'template') {
        // 模板图只用 alpha 通道，颜色统一为黑
        out[o + 3] = Math.min(255, Math.round(alpha * 255))
        continue
      }
      out[o] = Math.round(accR / accA)
      out[o + 1] = Math.round(accG / accA)
      out[o + 2] = Math.round(accB / accA)
      out[o + 3] = Math.min(255, Math.round(alpha * 255))
    }
  }
  return out
}

// ── 最小 PNG 编码（8bit RGBA / filter=None / zlib 压缩）──
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(size, rgba) {
  const stride = size * 4
  // 每行前置 1 字节 filter 类型（0 = None）
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const OUTPUTS = [
  { name: 'trayTemplate.png', size: 16, mode: 'template' },
  { name: 'trayTemplate@2x.png', size: 32, mode: 'template' },
  { name: 'tray-linux.png', size: 22, mode: 'photo' },
  { name: 'tray-linux@2x.png', size: 44, mode: 'photo' },
  { name: 'tray-win.png', size: 32, mode: 'photo' },
]

const src = decodePng(readFileSync(SOURCE))
const rect = glyphRect(src)
mkdirSync(OUT_DIR, { recursive: true })
console.log(`[tray-icons] 源图 ${src.width}×${src.height} · 字形包围盒 ${rect.size}px @(${rect.x},${rect.y})`)
for (const { name, size, mode } of OUTPUTS) {
  const rgba = render(src, rect, size, mode)
  const png = encodePng(size, rgba)
  writeFileSync(join(OUT_DIR, name), png)
  // 自检：可见像素占比（过低说明字形没框进来，过高说明底色没去掉）
  let visible = 0
  for (let i = 0; i < size * size; i++) if (rgba[i * 4 + 3] > 8) visible++
  const ratio = ((visible / (size * size)) * 100).toFixed(1)
  console.log(`[tray-icons] ${name} ${size}×${size} · 覆盖 ${ratio}% · ${png.length} 字节`)
}
