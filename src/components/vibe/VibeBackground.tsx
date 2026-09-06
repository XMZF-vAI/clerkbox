import { useCallback, useEffect, useRef, useState } from 'react'
import { useVibeStore, DEFAULT_VIBE_BACKGROUND, type VibeGlassTrack } from '../../stores/vibe-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import { toFileUrl } from '../../lib/file-url'

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']
// WebUI 走 base64（每张驻留内存），上限收紧；Electron 走 file:// 零拷贝
const SLIDESHOW_MAX_IMAGES = isWebUIMode ? 24 : 60
// 已解析 src 的 LRU 缓存上限：WebUI 的 base64 每张驻留内存，只保留当前与前后相邻几张
const SRC_CACHE_LIMIT = isWebUIMode ? 4 : 16
// 图片失效（含默认外链签名过期）时的内置渐变兜底，避免整屏死黑
const GRADIENT_FALLBACK = 'bg-gradient-to-br from-[#1b1b2f] via-[#16243d] to-[#0f3460]'

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
      {/* 兜底渐变：图片加载失败（含默认外链过期）时不至于死黑 */}
      <div className={`absolute inset-0 ${GRADIENT_FALLBACK}`} />
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

/**
 * 模式二：文件夹轮播 —— 双层交叉，新图以「缩放」动画淡入。
 * src 按需解析 + LRU 缓存：WebUI 不再把整个文件夹的 base64 全量驻留内存，
 * 只保留当前与前后相邻几张；Electron 走 file:// 拼串，缓存几乎零成本。
 */
function SlideshowBackground() {
  const slideshowFolder = useVibeStore((s) => s.slideshowFolder)
  const slideshowIntervalSec = useVibeStore((s) => s.slideshowIntervalSec)
  const [files, setFiles] = useState<string[]>([])
  const [tick, setTick] = useState(0)
  const [layers, setLayers] = useState<{ base: string; top: string | null; topKey: number }>({
    base: '',
    top: null,
    topKey: 0,
  })
  const [nextSrc, setNextSrc] = useState<string | null>(null)
  const topKeyRef = useRef(0)
  const srcCacheRef = useRef<Map<string, string>>(new Map())
  const initializedRef = useRef(false)

  // 解析并缓存 src；命中即 LRU 提鲜，超限时淘汰最早条目
  const resolveSrc = useCallback(async (path: string): Promise<string> => {
    const cache = srcCacheRef.current
    const hit = cache.get(path)
    if (hit !== undefined) {
      cache.delete(path)
      cache.set(path, hit)
      return hit
    }
    const src = await resolveImageSrc(path)
    cache.set(path, src)
    while (cache.size > SRC_CACHE_LIMIT) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return src
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!slideshowFolder) {
        setFiles([])
        return
      }
      try {
        const entries = await ipc.listDir(slideshowFolder)
        const paths = entries
          .filter((e) => e.isFile && IMAGE_EXTENSIONS.includes(ext(e.name)))
          .map((e) => `${slideshowFolder}/${e.name}`)
          .sort()
        if (cancelled) return
        srcCacheRef.current.clear()
        initializedRef.current = false
        setNextSrc(null)
        setLayers({ base: '', top: null, topKey: topKeyRef.current })
        setFiles(paths.slice(0, SLIDESHOW_MAX_IMAGES))
        setTick(0)
      } catch {
        if (!cancelled) setFiles([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [slideshowFolder])

  // 当前图变化：解析后交叉淡入（旧上层降级为新的底层），随后预热下一张，切换时零等待。
  // 用递增 tick 取模得到当前图，避免整轮回绕到 0 时跳过切换
  useEffect(() => {
    if (files.length === 0) return
    let cancelled = false
    const current = files[tick % files.length]
    const next = files[(tick + 1) % files.length]
    void (async () => {
      const src = await resolveSrc(current)
      if (cancelled) return
      if (!initializedRef.current) {
        initializedRef.current = true
        setLayers({ base: src, top: null, topKey: topKeyRef.current })
      } else {
        setLayers((prev) => ({
          base: prev.top ?? prev.base,
          top: src,
          topKey: ++topKeyRef.current,
        }))
      }
      setNextSrc(null)
      const pre = await resolveSrc(next)
      if (!cancelled) setNextSrc(pre)
    })()
    return () => {
      cancelled = true
    }
  }, [files, tick, resolveSrc])

  useEffect(() => {
    if (files.length <= 1) return
    const id = setInterval(() => {
      setTick((t) => t + 1)
    }, slideshowIntervalSec * 1000)
    return () => clearInterval(id)
  }, [files.length, slideshowIntervalSec])

  // 文件夹未选 / 为空：回退单图模式
  if (files.length === 0) return <SingleBackground />

  return (
    <div className="fixed inset-0 z-0">
      {/* 兜底渐变：任何一层图片失效时不至于死黑 */}
      <div className={`absolute inset-0 ${GRADIENT_FALLBACK}`} />
      {/* 预加载下一张（WebUI 为已解析的 base64），切换时零白屏；
          加载失败则把该图从轮播列表剔除并立即切下一张（对齐单图模式的失效兜底） */}
      {nextSrc && (
        <img
          src={nextSrc}
          alt=""
          className="hidden"
          aria-hidden
          onError={() => {
            const failedPath = files[(tick + 1) % files.length]
            if (!failedPath) return
            srcCacheRef.current.delete(failedPath)
            setFiles((prev) => prev.filter((p) => p !== failedPath))
            setTick((v) => v + 1)
          }}
        />
      )}
      {layers.base && (
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat animate-fade-in"
          style={{ backgroundImage: `url(${JSON.stringify(layers.base)})` }}
        />
      )}
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
