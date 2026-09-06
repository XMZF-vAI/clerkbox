import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Loader2, RotateCw, ShieldOff } from 'lucide-react'
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

const XTERM_THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#e6e6e6',
  cursor: '#4d8ef7',
  selectionBackground: 'rgba(77,142,247,0.35)',
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
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (termRef.current) return
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: 'Consolas, Menlo, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 4000,
      theme: XTERM_THEME,
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

    /** 启动（或重启）一个全新代次的 PTY 会话，先回收旧 key */
    const startSession = () => {
      const prevKey = ptyKeyRef.current
      const key = `${termId}#${++bootSeqRef.current}`
      ptyKeyRef.current = key
      if (prevKey) void ipc.ptyKill(prevKey).catch(() => {})
      setBooting(true)
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
          term.focus()
          if (!resizeObserver) {
            resizeObserver = new ResizeObserver(doFit)
            resizeObserver.observe(container)
          }
        })
        .catch(() => {
          if (disposed || ptyKeyRef.current !== key) return
          setBooting(false)
          // WebUI 等非桌面环境主进程通道不存在：标记不可用而不是留黑屏
          setUnavailable(true)
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

  if (unavailable) {
    return (
      <div className={`flex h-full flex-col items-center justify-center gap-3 text-xs ${vibe ? 'text-white/50' : 'text-dark-onSurfaceVariant/60'}`}>
        <ShieldOff size={28} aria-hidden />
        <span>{t('workbench.terminalDesktopOnly')}</span>
      </div>
    )
  }

  return (
    <div
      className="relative h-full min-h-0 p-1"
      // 点击终端区域任意位置都把焦点交给 xterm（兜底：即使焦点此前落在其他控件）
      onMouseDown={() => termRef.current?.focus()}
    >
      {booting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <Loader2 size={16} className="animate-spin opacity-60" />
        </div>
      )}
      {!booting && exited !== null && (
        <div className="absolute bottom-2 right-2 z-10">
          <button
            type="button"
            onClick={handleRestart}
            className={`flex items-center gap-1.5 rounded-md3-md px-2.5 py-1.5 text-xs shadow-lg transition-colors ${
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
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
