import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 截图产物的**字节级**守卫。
 *
 * 这条测试的由来：渲染层曾用 `ipc.writeFile`（文本通道，`fs.writeFileSync(p, s, 'utf-8')`）
 * 落盘截图，传进去的是 `data:image/png;base64,...` 字符串 —— 磁盘上得到的是一个
 * 「长得像 data URL 的文本文件」，不是 PNG。再把它 base64 发给模型，服务端就报
 * `invalid image content: decode image config: image: unknown format`。
 *
 * 静态检查抓不到这类问题（两边类型都是 string），只有去读真实字节才看得见。
 * 这里直接对「主进程落盘的那份代码」做同样语义的验证：把 data URL 按 PNG/JPEG
 * 解出来，确认魔数与声明的 mime 一致 —— 这正是模型侧解码器做的事。
 */

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf-8')

/** data URL → { mime, bytes }。解码失败返回 null */
function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  if (!match) return null
  return { mime: match[1]!, bytes: Buffer.from(match[2]!, 'base64') }
}

/** 各格式的魔数。模型侧的图片解码器认的就是这几个 */
const MAGIC: Array<{ mime: string; hex: string[] }> = [
  { mime: 'image/png', hex: ['89', '50', '4e', '47'] },
  { mime: 'image/jpeg', hex: ['ff', 'd8', 'ff'] },
]

function magicOf(bytes: Buffer): string | null {
  for (const { mime, hex } of MAGIC) {
    if (hex.every((byte, index) => bytes[index]?.toString(16).padStart(2, '0') === byte)) return mime
  }
  return null
}

describe('image bytes vs declared mime', () => {
  it('一份真实 PNG 的 data URL：解码后魔数与声明一致', () => {
    // 1x1 透明 PNG
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const decoded = decodeDataUrl(png)
    expect(decoded).not.toBeNull()
    expect(decoded!.mime).toBe('image/png')
    expect(magicOf(decoded!.bytes)).toBe('image/png')
  })

  it('这正是 ipc.writeFile 会毁掉的东西：写出去的字节不是图片', () => {
    // 这就是渲染层曾经传给文本通道的内容
    const asWritten = Buffer.from('data:image/png;base64,iVBORw0KGgo=', 'utf-8')
    // 落盘后读到的是 ASCII 文本，魔数识别不出任何图片格式
    expect(magicOf(asWritten)).toBeNull()
    expect(asWritten.subarray(0, 5).toString('utf-8')).toBe('data:')
    // 而模型侧拿到的是这段文本的 base64 —— 解出来仍然是文本，不是 PNG
    const roundTripped = decodeDataUrl(`data:image/png;base64,${asWritten.toString('base64')}`)
    expect(roundTripped).not.toBeNull()
    expect(magicOf(roundTripped!.bytes)).toBeNull()
  })
})

describe('主进程落盘路径', () => {
  const IMAGE_MODULE = read('electron/agent-image.ts')

  it('persistImageToTmp 用二进制写文件，不经过文本通道', () => {
    const fn = IMAGE_MODULE.slice(IMAGE_MODULE.indexOf('export function persistImageToTmp'))
    expect(fn, '找不到 persistImageToTmp').toContain('persistImageToTmp')
    // 关键：writeFileSync 不带 'utf-8' 编码参数
    expect(fn).toMatch(/fs\.writeFileSync\(([^)]*)\)/)
    const call = /fs\.writeFileSync\(([^)]*)\)/.exec(fn)![1]!
    expect(call, '落盘调用带了 utf-8 —— 那就是文本通道').not.toContain("'utf-8'")
    // 字节来自 NativeImage 而不是 data URL 字符串
    expect(fn).toContain('toPNG()')
    expect(fn).toContain('toJPEG(')
  })

  it('落盘前先解码校验，坏图不写文件（避免产出一个必然被模型拒收的路径）', () => {
    const fn = IMAGE_MODULE.slice(IMAGE_MODULE.indexOf('export function persistImageToTmp'))
    expect(fn.indexOf('isEmpty()')).toBeLessThan(fn.indexOf('writeFileSync'))
  })

  it('目录是 ~/.clerkbox/tmp，与既有溢出转存同一处', () => {
    const fn = IMAGE_MODULE.slice(IMAGE_MODULE.indexOf('export function persistImageToTmp'))
    expect(fn).toContain("'.clerkbox'")
    expect(fn).toContain("'tmp'")
  })
})

describe('渲染层不再自己写截图文件', () => {
  for (const file of ['src/lib/browser-tools.ts', 'src/lib/computer-tools.ts']) {
    it(`${file} 不再调用 ipc.writeFile 落截图`, () => {
      const source = read(file)
      expect(source, `${file} 又开始用文本通道写图片了`).not.toMatch(/ipc\.writeFile\(/)
      // 但仍必须消费主进程回传的引用
      expect(source).toContain('imageRef')
      expect(source).toContain('recordImage')
    })
  }

  it('两个执行器都把主进程给的 imageRef 原样上报（含 fullScreen 区域标记）', () => {
    for (const file of ['src/lib/browser-tools.ts', 'src/lib/computer-tools.ts']) {
      const source = read(file)
      const fn = source.slice(source.indexOf('function attachScreenshot'))
      expect(fn, file).toContain('ctx.recordImage(ref)')
    }
  })
})

describe('契约层：结果同时带 image 与 imageRef 的语义', () => {
  const CONTRACT = read('src/lib/agent-actions.ts')

  it('两个结果类型都声明了 imageRef', () => {
    expect(CONTRACT).toMatch(/interface BrowserCommandResult[\s\S]*?imageRef\?: AgentActionImageRef/)
    expect(CONTRACT).toMatch(/interface ComputerActionResult[\s\S]*?imageRef\?: AgentActionImageRef/)
  })

  it('结果类型里没有 image 字段：内联 data URL 只许在主进程内部流转', () => {
    // 一旦有人图省事把 dataUrl 直接回给工具层，模型就会收到未经落盘校验的字节
    for (const name of ['BrowserCommandResult', 'ComputerActionResult']) {
      const body = CONTRACT.slice(CONTRACT.indexOf(`interface ${name}`), CONTRACT.indexOf('\n}', CONTRACT.indexOf(`interface ${name}`)))
      expect(body, `${name} 不该再暴露 image`).not.toMatch(/^\s+image\??:/m)
    }
  })

  it('AgentActionImage 注明 dataUrl 只在主进程内部流转', () => {
    expect(CONTRACT).toContain('绝不能出现在工具结果里')
  })
})
