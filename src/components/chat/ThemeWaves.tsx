import { useEffect, useRef } from 'react'

// 三层波浪参数：不同波长 / 振幅 / 速度 / 透明度，营造纵深
const LAYERS = [
  { varName: '--md-primary-rgb', alpha: 0.12, amplitude: 16, wavelength: 1.1, speed: 0.00042, phase: 0 },
  { varName: '--md-tertiary-rgb', alpha: 0.09, amplitude: 22, wavelength: 0.8, speed: -0.00031, phase: 2.1 },
  { varName: '--md-secondary-rgb', alpha: 0.06, amplitude: 28, wavelength: 0.6, speed: 0.00022, phase: 4.4 },
]

function readColors(): string[] {
  const style = getComputedStyle(document.documentElement)
  return LAYERS.map((l) => style.getPropertyValue(l.varName).trim() || '128 128 128')
}

/**
 * 新对话空状态底部的主题色流动波浪。
 * 颜色运行时读取 CSS 变量，换色系 / 亮暗模式自动跟随。
 */
export default function ThemeWaves() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let rafId = 0
    let colors = readColors()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

    // 兜底：下一帧再读一次，规避挂载时 ThemeProvider 尚未写入 CSS 变量的竞态
    requestAnimationFrame(() => { colors = readColors() })

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const draw = (time: number) => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)

      LAYERS.forEach((layer, i) => {
        const baseY = h * (0.45 + i * 0.12)
        const k = (Math.PI * 2) / (w * layer.wavelength)
        const drift = reducedMotion.matches ? 0 : time * layer.speed

        ctx.beginPath()
        ctx.moveTo(0, h)
        for (let x = 0; x <= w; x += 4) {
          const y =
            baseY +
            Math.sin(x * k + drift + layer.phase) * layer.amplitude +
            Math.sin(x * k * 0.5 + drift * 1.3 + layer.phase) * layer.amplitude * 0.4
          ctx.lineTo(x, y)
        }
        ctx.lineTo(w, h)
        ctx.closePath()
        ctx.fillStyle = `rgba(${colors[i].replace(/\s+/g, ',')},${layer.alpha})`
        ctx.fill()
      })
    }

    const loop = (time: number) => {
      draw(time)
      rafId = requestAnimationFrame(loop)
    }

    if (reducedMotion.matches) {
      draw(0)
    } else {
      rafId = requestAnimationFrame(loop)
    }

    // 色系 / 亮暗切换时重读颜色（theme-engine 会改写 documentElement 内联样式）
    const observer = new MutationObserver(() => {
      colors = readColors()
      if (reducedMotion.matches) draw(0)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)

    return () => {
      cancelAnimationFrame(rafId)
      observer.disconnect()
      resizeObserver.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 h-36 w-full pointer-events-none [mask-image:linear-gradient(to_top,black_55%,transparent)]"
    />
  )
}
