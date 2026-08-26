import { useEffect, useRef, useState } from 'react'
import { useVibeStore, DEFAULT_VIBE_BACKGROUND, type VibeGlassTrack } from '../../stores/vibe-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import { toFileUrl } from '../../lib/file-url'

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']
// WebUI 走 base64（每张驻留内存），上限收紧；Electron 走 file:// 零拷贝
const SLIDESHOW_MAX_IMAGES = isWebUIMode ? 24 : 60

function ext(name: string): string {
  return name.split('.').pop()?.toLowerCase() || ''
}

/** 本地图片路径 → 可渲染 src：Electron 走 file://，WebUI 走 base64 data URL */
async function resolveImageSrc(path: string): Promise<string> {
  if (isWebUIMode) {
    try {
      return await ipc.readImageFileBase64(path)
    } catch {
      return toFileUrl(path)
    }
  }
  return toFileUrl(path)
}

export default function VibeBackground() {
  const backgroundMode = useVibeStore((s) => s.backgroundMode)
  if (backgroundMode === 'glass') return <GlassBackground />
  if (backgroundMode === 'slideshow') return <SlideshowBackground />
  return <SingleBackground />
}

/** 模式一：单张图片（原图逻辑，加载淡入 + 失效回退默认图） */
function SingleBackground() {
  const background = useVibeStore((s) => s.background)
  const setBackground = useVibeStore((s) => s.setBackground)
  const [src, setSrc] = useState(background.value)
  const [fade, setFade] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFade(false)

    const resolveSrc = async () => {
      if (background.type === 'local') {
        const exists = await ipc.fileExists(background.value)
        if (cancelled) return
        if (!exists) {
          setBackground(DEFAULT_VIBE_BACKGROUND)
          setSrc(DEFAULT_VIBE_BACKGROUND.value)
          return
        }
        setSrc(toFileUrl(background.value))
      } else {
        if (cancelled) return
        setSrc(background.value)
      }
    }

    void resolveSrc()

    return () => {
      cancelled = true
    }
  }, [background, setBackground])

  const handleError = () => {
    if (src !== DEFAULT_VIBE_BACKGROUND.value) {
      setBackground(DEFAULT_VIBE_BACKGROUND)
      setSrc(DEFAULT_VIBE_BACKGROUND.value)
    }
  }

  return (
    <div className="fixed inset-0 z-0">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-700"
        style={{
          backgroundImage: `url(${JSON.stringify(src)})`,
          opacity: fade ? 1 : 0,
        }}
      />
      <img
        src={src}
        alt=""
        className="hidden"
        onLoad={() => setFade(true)}
        onError={handleError}
      />
      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-black/30" />
    </div>
  )
}

/** 模式二：文件夹轮播 —— 双层交叉，新图以「缩放 + 模糊」动画淡入 */
function SlideshowBackground() {
  const slideshowFolder = useVibeStore((s) => s.slideshowFolder)
  const slideshowIntervalSec = useVibeStore((s) => s.slideshowIntervalSec)
  const [slides, setSlides] = useState<string[]>([])
  const [tick, setTick] = useState(0)
  const topKeyRef = useRef(0)
  const [layers, setLayers] = useState<{ base: string; top: string | null; topKey: number }>({
    base: '',
    top: null,
    topKey: 0,
  })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!slideshowFolder) {
        setSlides([])
        return
      }
      try {
        const entries = await ipc.listDir(slideshowFolder)
        const files = entries
          .filter((e) => e.isFile && IMAGE_EXTENSIONS.includes(ext(e.name)))
          .map((e) => e.name)
          .sort()
        if (cancelled) return
        if (files.length === 0) {
          setSlides([])
          return
        }
        const srcs = await Promise.all(
          files.slice(0, SLIDESHOW_MAX_IMAGES).map((name) => resolveImageSrc(`${slideshowFolder}/${name}`)),
        )
        if (cancelled) return
        setSlides(srcs)
        setTick(0)
        setLayers({ base: srcs[0], top: null, topKey: 0 })
      } catch {
        if (!cancelled) setSlides([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [slideshowFolder])

  // 切换时：上层入场动画结束后即为最终画面，旧上层降级为新的底层
  // 用递增 tick 取模得到当前图，避免整轮回绕到 0 时跳过切换
  useEffect(() => {
    if (slides.length === 0 || tick === 0) return
    const current = slides[tick % slides.length]
    setLayers((prev) => ({
      base: prev.top ?? prev.base,
      top: current,
      topKey: ++topKeyRef.current,
    }))
  }, [tick, slides])

  useEffect(() => {
    if (slides.length <= 1) return
    const id = setInterval(() => {
      setTick((t) => t + 1)
    }, slideshowIntervalSec * 1000)
    return () => clearInterval(id)
  }, [slides, slideshowIntervalSec])

  // 文件夹未选 / 为空：回退单图模式
  if (slides.length === 0) return <SingleBackground />

  const index = tick % slides.length
  const nextSrc = slides[(index + 1) % slides.length]

  return (
    <div className="fixed inset-0 z-0">
      {/* 预加载下一张，切换时零白屏 */}
      <img src={nextSrc} alt="" className="hidden" aria-hidden />
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat animate-fade-in"
        style={{ backgroundImage: `url(${JSON.stringify(layers.base)})` }}
      />
      {layers.top && (
        <div
          key={layers.topKey}
          className="absolute inset-0 bg-cover bg-center bg-no-repeat animate-vibe-cross"
          style={{ backgroundImage: `url(${JSON.stringify(layers.top)})` }}
        />
      )}
      <div className="absolute inset-0 bg-black/30" />
    </div>
  )
}

/**
 * 模式三：透明玻璃 —— 双轨渲染。
 * - Electron Windows：vibeGlassSet 直接对窗口应用系统级亚克力（实时透出桌面），
 *   页面不再绘制背景；level 0 为纯透明。
 * - 其他环境（WebUI / 非 Windows / 特效失败）：拉取壁纸快照，用 CSS 模糊模拟玻璃。
 */
function GlassBackground() {
  const glassLevel = useVibeStore((s) => s.glassLevel)
  const setGlassTrack = useVibeStore((s) => s.setGlassTrack)
  const [track, setTrack] = useState<VibeGlassTrack | 'pending'>('pending')
  const [wallpaper, setWallpaper] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setTrack('pending')
    setGlassTrack('pending')

    const loadWallpaper = async () => {
      try {
        const wp = await ipc.vibeGetWallpaper()
        if (!cancelled) setWallpaper(wp)
      } catch {
        // 壁纸快照不可用时保持纯透明
      }
    }

    const apply = async () => {
      try {
        const res = await ipc.vibeGlassSet(glassLevel)
        if (cancelled) return
        setTrack(res.track)
        setGlassTrack(res.track)
        if (res.track === 'fallback') void loadWallpaper()
      } catch {
        if (cancelled) return
        setTrack('fallback')
        setGlassTrack('fallback')
        void loadWallpaper()
      }
    }
    void apply()

    return () => {
      cancelled = true
      void ipc.vibeGlassClear()
    }
  }, [glassLevel, setGlassTrack])

  // 原生轨道：页面不绘制任何背景，系统亚克力/纯透明直接透出桌面
  if (track === 'acrylic' || track === 'transparent') return null

  // 降级轨道：壁纸快照 + CSS 模糊模拟玻璃；pending 时同样先画壁纸避免闪黑
  const blurPx = Math.round(glassLevel * 0.4)
  return (
    <div className="fixed inset-0 z-0 overflow-hidden">
      {wallpaper && (
        <div
          className="absolute -inset-10 bg-cover bg-center bg-no-repeat"
          style={{
            backgroundImage: `url(${JSON.stringify(wallpaper)})`,
            filter: `blur(${blurPx}px)`,
          }}
        />
      )}
      <div className="absolute inset-0 bg-black/25" />
    </div>
  )
}
