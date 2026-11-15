import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CircleAlert, Loader2, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  /** 工作台标签 id，用于派生 PTY 会话 key */
  termId: string
  /** 标签是否处于激活态：隐藏期间输出继续流入缓冲，重新显示时 refit + 聚焦 */
  active: boolean
  vibe?: boolean
  cwd?: string
}

/** xterm 不能直接读取 CSS 变量；从当前主题的计算样式解析，避免浅色主题仍用白字。 */
function terminalTheme(container: HTMLElement) {
  const styles = getComputedStyle(container)
  const accent = styles.getPropertyValue('--md-primary-rgb').trim()
  return {
    background: 'transparent',
    foreground: styles.color,
    cursor: styles.color,
    selectionBackground: `rgb(${accent} / 0.24)`,
  }
}

/**
 * 工作台终端面板：node-pty 真 TTY + xterm 渲染。
 * 隐藏（切换到其他标签）不卸载实例，仅 refit，保证后台进程输出不丢。
 *
 * 会话 key 每次启动都换新（`termId#代次`）：
 * React StrictMode 开发模式会对挂载 effect 跑「挂载→清理→再挂载」，
 * 若新旧会话共用同一 id，被清理会话的 exit/data 事件会污染新会话状态
 * （表现为刚打开就提示「进程已退出」、输入无响应）。
 */
export default function TerminalPanel({ termId, active, vibe, cwd }: TerminalPanelProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // 当前生效的 PTY 会话 key；空串表示尚无会话
  const ptyKeyRef = useRef('')
  // 启动代次计数器
  const bootSeqRef = useRef(0)
  // startSession 定义在挂载 effect 内，通过 ref 暴露给「重新启动」按钮
  const startSessionRef = useRef<() => void>(() => {})
  const [booting, setBooting] = useState(true)
  const [exited, setExited] = useState<number | null>(null)
  const [bootError, setBootError] = useState(false)
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (termRef.current) return
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: 'Consolas, Menlo, "Courier New", monospace',
      fontSize: parseFloat(getComputedStyle(container).fontSize),
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 4000,
      allowTransparency: true,
      theme: terminalTheme(container),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    let disposed = false
    let resizeObserver: ResizeObserver | null = null

    const doFit = () => {
      // 面板隐藏时尺寸为 0，跳过；恢复激活时由 effect 触发重试
      if (!container.clientWidth || !container.clientHeight) return
      try {
        fit.fit()
        if (ptyKeyRef.current) ipc.ptyResize(ptyKeyRef.current, term.cols, term.rows)
      } catch {
        /* 会话可能刚退出，忽略 */
      }
    }

    const syncTheme = () => {
      if (disposed) return
      term.options.theme = terminalTheme(container)
      term.options.fontSize = parseFloat(getComputedStyle(container).fontSize)
      doFit()
    }
    const themeObserver = new MutationObserver(syncTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    themeObserver.observe(container, { attributes: true, attributeFilter: ['class'] })

    /** 启动（或重启）一个全新代次的 PTY 会话，先回收旧 key */
    const startSession = () => {
      const prevKey = ptyKeyRef.current
      const key = `${termId}#${++bootSeqRef.current}`
      ptyKeyRef.current = key
      if (prevKey) void ipc.ptyKill(prevKey).catch(() => {})
      setBooting(true)
      setBootError(false)
      setExited(null)
      ipc
        .ptyCreate({ id: key, cwd, cols: term.cols || 80, rows: term.rows || 24 })
        .then(() => {
          // 期间已换新会话（快速重启）或组件已卸载：回收本次会话
          if (disposed || ptyKeyRef.current !== key) {
            void ipc.ptyKill(key).catch(() => {})
            return
          }
          setBooting(false)
          doFit()
          if (activeRef.current) term.focus()
          if (!resizeObserver) {
            resizeObserver = new ResizeObserver(doFit)
            resizeObserver.observe(container)
          }
        })
        .catch(() => {
          if (disposed || ptyKeyRef.current !== key) return
          setBooting(false)
          // 启动失败也保留终端容器，允许修复目录或短暂连接故障后重试。
          setBootError(true)
        })
    }
    startSessionRef.current = startSession

    // 订阅先于创建建立，避免首屏输出竞态丢失
    const offData = ipc.onPtyData((id, data) => {
      if (id === ptyKeyRef.current && !disposed) term.write(data)
    })
    const offExit = ipc.onPtyExit((id, code) => {
      // 仅当前代次会话的退出才视为「本终端退出」；旧代次的残余事件直接忽略
      if (id === ptyKeyRef.current && !disposed) {
        setExited(code)
        term.write(`\r\n\x1b[2m[${t('workbench.terminalExited', { code })}]\x1b[0m\r\n`)
      }
    })

    term.onData((d) => {
      if (ptyKeyRef.current) ipc.ptyInput(ptyKeyRef.current, d)
    })
    startSession()

    return () => {
      disposed = true
      offData()
      offExit()
      resizeObserver?.disconnect()
      themeObserver.disconnect()
      if (ptyKeyRef.current) void ipc.ptyKill(ptyKeyRef.current).catch(() => {})
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // cwd 变化不重建会话（保持 shell 现场）；仅按 termId 挂载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId])

  // 重新启动：清屏后换新代次会话（组件不重挂载）
  const handleRestart = () => {
    const term = termRef.current
    if (!term) return
    term.reset()
    startSessionRef.current()
  }

  // 标签重新激活：refit + 聚焦
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        if (ptyKeyRef.current && termRef.current) {
          ipc.ptyResize(ptyKeyRef.current, termRef.current.cols, termRef.current.rows)
        }
      } catch { /* ignore */ }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, termId])

  return (
    <div
      className="relative h-full min-h-0 p-2"
      // 点击终端区域任意位置都把焦点交给 xterm（兜底：即使焦点此前落在其他控件）
      onMouseDown={() => termRef.current?.focus()}
    >
      {booting && (
        <div role="status" className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-ui-sm text-dark-onSurfaceVariant">
          <Loader2 size={16} className="animate-spin opacity-60" aria-hidden />
          {t('common.loading')}
        </div>
      )}
      {bootError && (
        <div role="alert" className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 py-5 text-center text-ui-sm ${vibe ? 'bg-dark-surfaceDim/95 text-white/75' : 'bg-dark-surfaceDim text-dark-onSurfaceVariant'}`}>
          <CircleAlert size={26} className="text-md-error" aria-hidden />
          <p className="max-w-sm leading-relaxed">{t('workbench.terminalStartFailed')}</p>
          <button type="button" onClick={handleRestart} className="md-focus flex min-h-9 items-center gap-2 rounded-md3-sm border border-dark-onSurfaceVariant/20 px-4 py-2 text-ui-sm hover:bg-dark-surfaceContainerHigh transition-colors"><RotateCw size={14} aria-hidden />{t('common.retry')}</button>
        </div>
      )}
      {!booting && exited !== null && (
        <div className="absolute bottom-2 right-2 z-10">
          <button
            type="button"
            onClick={handleRestart}
            className={`md-focus flex min-h-9 items-center gap-1.5 rounded-md3-md px-3 py-2 text-ui-xs shadow-elevation-2 transition-colors ${
              vibe
                ? 'liquid-glass-subtle text-white/90 hover:bg-white/15'
                : 'bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
            }`}
          >
            <RotateCw size={12} />
            {t('workbench.terminalRestart')}
          </button>
        </div>
      )}
      <div ref={containerRef} className={`h-full w-full text-ui-sm ${vibe ? 'text-white' : 'text-dark-onSurface'}`} />
    </div>
  )
}
