/**
 * 生成系统托盘图标（Task 0）。
 *
 * 设计要点：
 * - **不引入任何新依赖、不调用外部工具**（本机无 Pillow / ImageMagick）：用纯 Node 手写
 *   PNG 编码（zlib + CRC32），几何图形用「距离场 + 4× 超采样」栅格化，天然带抗锯齿。
 * - 图案取自 `src/assets/lunora-logo.svg` 的轮廓（C 形弧环 + 勾形三笔 + 圆点），去掉
 *   深色底与彩色填充：mac 出「纯黑 + alpha」模板图（系统自动反色）；Linux 出品牌色图。
 * - 输出尺寸按各平台惯例：mac 16×16 + 32×32@2x；Linux 22×22 + 44×44@2x。
 *
 * 用法：`npm run gen:tray-icons`
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'build')
/** 与 lunora-logo.svg 一致的源坐标系尺寸 */
const VIEW = 128
/** 每个输出像素的超采样密度（8×8 = 65 级灰度抗锯齿，小尺寸下足够锐利） */
const SUPERSAMPLE = 8

// ── 图案几何（取自 src/assets/lunora-logo.svg 的轮廓，去掉深色底与彩色填充）──
/** C 形弧环：大圆分量减去小圆分量 */
const CRESCENT = { outer: { cx: 71, cy: 65, r: 42 }, inner: { cx: 73, cy: 64, r: 34 } }
/** 勾形三笔（stroke-width 12，圆头） */
const STROKE_WIDTH = 12
const STROKES = [
  [{ x: 47, y: 84 }, { x: 76, y: 84 }],
  [{ x: 47, y: 84 }, { x: 83, y: 48 }],
  [{ x: 83, y: 48 }, { x: 95, y: 48 }],
]
/** 弧环缺口处的圆点 */
const DOT = { cx: 95, cy: 48, r: 4 }

const CLR_CRESCENT = [0xcc, 0x78, 0x5c]
const CLR_STROKE = [0xd8, 0xb7, 0x79]
const CLR_DOT = [0x7f, 0xc8, 0xb4]
/** mac 模板图只用 alpha 通道，颜色统一为黑 */
const CLR_TEMPLATE = [0, 0, 0]

const insideCircle = (x, y, c) => (x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.r * c.r

/** 点到线段的距离（用平方比较避免开方） */
function distanceToSegmentSq(x, y, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq))
  const px = a.x + t * dx
  const py = a.y + t * dy
  return (x - px) ** 2 + (y - py) ** 2
}

/** 逐层叠加的图形（画序：弧环 → 三笔 → 圆点） */
function layers(variant) {
  const monochrome = variant === 'template'
  const strokeColor = monochrome ? CLR_TEMPLATE : CLR_STROKE
  const radiusSq = (STROKE_WIDTH / 2) ** 2
  return [
    {
      color: monochrome ? CLR_TEMPLATE : CLR_CRESCENT,
      inside: (x, y) =>
        insideCircle(x, y, CRESCENT.outer) && !insideCircle(x, y, CRESCENT.inner),
    },
    {
      color: strokeColor,
      inside: (x, y) => STROKES.some(([a, b]) => distanceToSegmentSq(x, y, a, b) <= radiusSq),
    },
    {
      color: monochrome ? CLR_TEMPLATE : CLR_DOT,
      inside: (x, y) => insideCircle(x, y, DOT),
    },
  ]
}

/**
 * 栅格化并合成到 RGBA 缓冲。
 * 采用预乘累加（premultiplied source-over），最后再反预乘，保证半透明边缘不发灰。
 */
function render(size, variant) {
  const samples = SUPERSAMPLE * SUPERSAMPLE
  const acc = new Float64Array(size * size * 4)
  const scale = VIEW / size

  for (const layer of layers(variant)) {
    const [cr, cg, cb] = layer.color
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        let hits = 0
        for (let sy = 0; sy < SUPERSAMPLE; sy++) {
          for (let sx = 0; sx < SUPERSAMPLE; sx++) {
            const ux = (px + (sx + 0.5) / SUPERSAMPLE) * scale
            const uy = (py + (sy + 0.5) / SUPERSAMPLE) * scale
            if (layer.inside(ux, uy)) hits++
          }
        }
        if (hits === 0) continue
        const coverage = hits / samples
        const inv = 1 - coverage
        const i = (py * size + px) * 4
        acc[i] = cr * coverage + acc[i] * inv
        acc[i + 1] = cg * coverage + acc[i + 1] * inv
        acc[i + 2] = cb * coverage + acc[i + 2] * inv
        acc[i + 3] = coverage + acc[i + 3] * inv
      }
    }
  }

  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const alpha = acc[i * 4 + 3]
    if (alpha <= 0) continue
    rgba[i * 4] = Math.round(acc[i * 4] / alpha)
    rgba[i * 4 + 1] = Math.round(acc[i * 4 + 1] / alpha)
    rgba[i * 4 + 2] = Math.round(acc[i * 4 + 2] / alpha)
    rgba[i * 4 + 3] = Math.round(alpha * 255)
  }
  return rgba
}

// ── 最小 PNG 编码（8bit RGBA / filter=None / zlib 压缩，不依赖任何图像库）──
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

// ── 输出：mac 模板图（纯黑 + alpha，系统自动反色） / Windows 与 Linux 品牌色图 ──
// 注：Windows 不用 build/icon.ico（那是深色圆角方块的应用图标，16px 缩到暗色任务栏会糊成一块），
// 改用透明底品牌字形，观感与 Linux 一致。
const OUTPUTS = [
  { name: 'trayTemplate.png', size: 16, variant: 'template' },
  { name: 'trayTemplate@2x.png', size: 32, variant: 'template' },
  { name: 'tray-linux.png', size: 22, variant: 'brand' },
  { name: 'tray-linux@2x.png', size: 44, variant: 'brand' },
  { name: 'tray-win.png', size: 32, variant: 'brand' },
]

mkdirSync(OUT_DIR, { recursive: true })
for (const { name, size, variant } of OUTPUTS) {
  const rgba = render(size, variant)
  const png = encodePng(size, rgba)
  writeFileSync(join(OUT_DIR, name), png)
  // 自检：不透明像素占比（过低说明图形没画进去，过高说明透明背景丢了）
  let opaque = 0
  for (let i = 0; i < size * size; i++) if (rgba[i * 4 + 3] > 8) opaque++
  const ratio = ((opaque / (size * size)) * 100).toFixed(1)
  console.log(`[tray-icons] ${name} ${size}×${size} · 覆盖 ${ratio}% · ${png.length} 字节`)
}

