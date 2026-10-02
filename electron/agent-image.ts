/**
 * 截图进模型前的体积治理
 *
 * 一张 1280×800 的 PNG base64 约 300KB~1.5MB，直接塞进工具结果会让上下文瞬间爆掉。
 * 契约里定的是 200 KiB base64 / 2000 px 上限（对标 ZCode 的
 * MCP_IMAGE_INLINE_BASE64_BYTES = 200*1024 与 2000px 模型视觉上限），
 * 这里负责把原始截图压进这个预算。
 *
 * 降采样与重压都放在主进程做：只有这里有 `nativeImage`，
 * 渲染进程拿到的只是已经压好的结果，不必为每张图再发一次 IPC。
 */
import { app, nativeImage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { AGENT_ACTION_LIMITS, type AgentActionImage } from '../src/lib/agent-actions'

/** data URL 体积估算：base64 长度 × 3/4 还原为原始字节 */
function base64ByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? Math.floor(((dataUrl.length - comma - 1) * 3) / 4) : dataUrl.length
}

function downscaleByWidth(image: Electron.NativeImage, width: number): Electron.NativeImage {
  const size = image.getSize()
  if (size.width <= width) return image
  return image.resize({
    width,
    height: Math.max(1, Math.round((size.height * width) / size.width)),
    quality: 'good',
  })
}

/**
 * 把一张截图压进内联预算。
 *
 * 策略：先按最长边降采样到上限；仍然超预算就改用 JPEG 逐级降质量重编码。
 * 保留 PNG 只在它本来就够小时才做 —— 截图类图像（大量纯色文字界面）JPEG 体积差一个量级，
 * 一上来就转 JPEG 会在本来够用的情况下白白掉画质。
 * 连最低质量都塞不下时返回 null，由调用方退化成「只回页面状态，不回图」，
 * 而不是把一张巨图硬推进请求里。
 */
export function fitImageToInlineBudget(raw: AgentActionImage): AgentActionImage | null {
  const budget = AGENT_ACTION_LIMITS.screenshotInlineBase64Bytes
  if (base64ByteLength(raw.dataUrl) <= budget && raw.width <= AGENT_ACTION_LIMITS.screenshotMaxDimension) {
    return raw
  }

  const decoded = nativeImage.createFromDataURL(raw.dataUrl)
  if (decoded.isEmpty()) return null

  const longEdge = Math.max(decoded.getSize().width, decoded.getSize().height)
  const scale = longEdge > AGENT_ACTION_LIMITS.screenshotMaxDimension
    ? AGENT_ACTION_LIMITS.screenshotMaxDimension / longEdge
    : 1
  const scaled = scale < 1 ? downscaleByWidth(decoded, Math.max(1, Math.round(decoded.getSize().width * scale))) : decoded
  const size = scaled.getSize()

  const toJpeg = (quality: number): AgentActionImage => ({
    // toJPEG 返回 Buffer，data URL 要字符串；显式转一次避免各平台隐式行为不一致
    dataUrl: `data:image/jpeg;base64,${scaled.toJPEG(quality).toString('base64')}`,
    mimeType: 'image/jpeg',
    width: size.width,
    height: size.height,
    ...(raw.fullScreen !== undefined ? { fullScreen: raw.fullScreen } : {}),
  })

  let quality = 90
  let best = toJpeg(quality)
  while (base64ByteLength(best.dataUrl) > budget && quality > AGENT_ACTION_LIMITS.screenshotMinQuality) {
    quality = Math.max(AGENT_ACTION_LIMITS.screenshotMinQuality, quality - 20)
    best = toJpeg(quality)
  }
  return base64ByteLength(best.dataUrl) <= budget ? best : null
}

/** 落盘后的图像引用。字段与 ToolResultImage 一致，渲染层直接转手上报给宿主 */
export interface PersistedImage {
  path: string
  mimeType: string
  width: number
  height: number
  fullScreen?: boolean
}

/**
 * 把截图落盘，返回给渲染层的磁盘引用。
 *
 * **必须由主进程写**：`ipc.writeFile` 是文本通道（`fs.writeFileSync(path, content, 'utf-8')`），
 * 拿它写 data URL 落盘的是字符串 `data:image/png;base64,...` 而不是 PNG；
 * 渲染层再把这段文本 base64 一次发给模型，服务端就会报
 * `invalid image content: decode image config: image: unknown format`。
 * 主进程这里还握着 NativeImage，直接 `toBuffer()` 落二进制，字节精确，
 * 也省掉「主进程 → 渲染层 → 主进程」一趟 base64 往返。
 */
export function persistImageToTmp(image: AgentActionImage, tag: string): PersistedImage | null {
  const decoded = nativeImage.createFromDataURL(image.dataUrl)
  if (decoded.isEmpty()) {
    console.error('[agent-image] 无法解码截图，落盘跳过')
    return null
  }
  const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png'
  const buffer = ext === 'jpg' ? decoded.toJPEG(90) : decoded.toPNG()
  try {
    const dir = path.join(app.getPath('home'), '.clerkbox', 'tmp')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `agent-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`)
    fs.writeFileSync(file, buffer)
    return {
      path: file,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      ...(image.fullScreen !== undefined ? { fullScreen: image.fullScreen } : {}),
    }
  } catch (err) {
    console.error('[agent-image] 截图落盘失败:', err)
    return null
  }
}
