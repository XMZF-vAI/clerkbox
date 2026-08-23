import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

interface QrCodeProps {
  text: string
  /** 二维码边长（px，不含白边） */
  size?: number
}

/**
 * 本地生成的二维码（SVG）。内容仅来自应用自身拼装的 URL，
 * 不经过任何外部服务；白底容器保证深色主题下的扫码对比度。
 */
export default function QrCode({ text, size = 168 }: QrCodeProps) {
  const [svg, setSvg] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    QRCode.toString(text, {
      type: 'svg',
      margin: 0,
      width: size,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' },
    })
      .then((out) => { if (!cancelled) { setSvg(out); setFailed(false) } })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [text, size])

  if (failed || !svg) return null
  return (
    <div
      className="bg-white p-2 rounded-md3-md inline-flex [&>svg]:block"
      style={{ width: size + 16, height: size + 16 }}
      // 内容为 qrcode 库对本地 URL 字符串生成的纯 path SVG，无外部输入参与拼装
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
