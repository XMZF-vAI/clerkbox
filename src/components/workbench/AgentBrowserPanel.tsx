import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader2, MousePointer2, RotateCw, TriangleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import { useWorkbench } from '../../stores/workbench-store'
import { useSettingsStore } from '../../stores/settings-store'

/** webview 元素上我们实际用到的最小能力面（与 BrowserPanel 保持同一份形状） */
interface WebviewEl extends HTMLElement {
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): void
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
}

const FAKE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Agent 浏览器分区。与人类浏览器隔离，cookie / 登录态互不污染；
 *  主进程正是靠这个分区在 did-attach-webview 里认出 guest。 */
const AGENT_PARTITION = 'persist:clerkbox-agent-browser'

/**
 * 空闲占位页。用 data URL 而非 about:blank：后者上 CDP 的页面域受限。
 *
 * 三个曾经把面板毁掉的点，都在这里：
 *   1. **背景写死 `#fff`** —— 黑夜模式下就是一坨刺眼的白块，比加载中的空白还糟。
 *      主题必须由宿主算好后传进来（`prefers-color-scheme` 不可靠：ClerkBox 的
 *      深色是应用级的，guest 未必跟着系统走）。
 *   2. **🌐 emoji** —— 本项目不用 emoji 占位。
 *   3. 文案写死中文且不走 i18n。
 * 占位页刻意做得很轻：它只是「还没开始」的一句话，不该抢面板的注意力。
 */
function idleUrl(isDark: boolean, title: string, hint: string): string {
  const bg = isDark ? '#14161a' : '#ffffff'
  const fg = isDark ? '#8b95a5' : '#6b7280'
  const faint = isDark ? '#5c6472' : '#9ca3af'
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      '<!doctype html><meta charset="utf-8">' +
        `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;` +
        `font:14px/1.6 system-ui,sans-serif;color:${fg};background:${bg}">` +
        `<div style="text-align:center">` +
        `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${faint}" stroke-width="1.5" ` +
        `stroke-linecap="round" style="margin:0 auto 12px;display:block">` +
        `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"/></svg>` +
        `<div>${title}</div>` +
        `<div style="font-size:12px;color:${faint};margin-top:4px">${hint}</div>` +
        `</div></body>`,
    )
  )
}

/** 尺寸变化警告的显示时长 */
const RESIZE_WARNING_MS = 3_000
/**
 * AI 自己改布局也要走同一套盒子（视口尺寸会变），所以只有「静置超过这段时间」
 * 才算「是人拖的」。太短会把 AI 的正常步骤误报成用户抢方向盘。
 */
const HUMAN_RESIZE_SETTLE_MS = 400

/**
 * Agent 浏览器面板。
 *
 * 与人类浏览器面板（BrowserPanel）刻意分成两个组件而不是加 props 复用：
 * 两者的**权限模型相反** —— 这个页面由模型驱动，用户只能看；那个页面由用户操作。
 * 混在一个组件里迟早会出现「用户输入被 AI 覆盖」或「AI 的页面被用户导航走」这类状态。
 *
 * 关键约束：**面板折叠时不能卸载**。主进程持有 guest 的 CDP 附着，
 * 卸载即销毁，正在进行的任务会直接失败。挂载与否由 WorkbenchPanel 决定，不在这里判断。
 */
export default function AgentBrowserPanel({ vibe }: { vibe?: boolean }) {
  const { t } = useTranslation()
  const webviewRef = useRef<WebviewEl | null>(null)
  const [input, setInput] = useState('')
  const [currentUrl, setCurrentUrl] = useState('')
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [resizeWarning, setResizeWarning] = useState(false)
  const { agentBrowserOperationUntil } = useWorkbench()
  const isOperating = agentBrowserOperationUntil > Date.now()

  // 空闲占位页只作为**初始 src**（about:blank 上 CDP 的页面域受限）。
  // 刻意用 ref 固化：主题/语言变化后不要重设 src —— 那会把 AI 已经导航到的
  // 页面冲回占位页，等于把正在进行的任务界面擦掉。
  const idleSrc = useRef('')
  if (!idleSrc.current) {
    const theme = useSettingsStore.getState().theme
    const isDark =
      theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    idleSrc.current = idleUrl(isDark, t('workbench.agentBrowserIdleTitle'), t('workbench.agentBrowserIdleHint'))
  }

  const syncNavState = useCallback(() => {
    const wv = webviewRef.current
    if (!wv) return
    try {
      setCanBack(wv.canGoBack())
      setCanForward(wv.canGoForward())
      setInput(wv.getURL())
      setCurrentUrl(wv.getURL())
    } catch { /* 尚未 ready */ }
  }, [])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onDomReady = () => {
      setReady(true)
      syncNavState()
    }
    const onNavStart = () => setLoading(true)
    const onNavEnd = () => {
      setLoading(false)
      syncNavState()
    }
    const onWillNavigate = (e: Event) => {
      const url = (e as Event & { url?: string }).url || ''
      if (url && !url.startsWith('http://') && !url.startsWith('https://')) e.preventDefault()
    }
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-start-loading', onNavStart)
    wv.addEventListener('did-stop-loading', onNavEnd)
    wv.addEventListener('did-navigate', onNavEnd)
    wv.addEventListener('did-navigate-in-page', onNavEnd)
    wv.addEventListener('will-navigate', onWillNavigate)
    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-start-loading', onNavStart)
      wv.removeEventListener('did-stop-loading', onNavEnd)
      wv.removeEventListener('did-navigate', onNavEnd)
      wv.removeEventListener('did-navigate-in-page', onNavEnd)
      wv.removeEventListener('will-navigate', onWillNavigate)
    }
  }, [syncNavState])

  // AI 正在操作时用户改了面板宽度 → 视口尺寸变了，AI 手上的坐标可能已经失效。
  // 报一次、闪一下就够；每个操作周期最多报一次，否则用户拖一下就弹一次。
  const warnedRef = useRef(false)
  useEffect(() => {
    warnedRef.current = false
  }, [agentBrowserOperationUntil])
  useEffect(() => {
    if (!isOperating || !ready) return
    let timer: number | undefined
    const onResize = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (!isOperating || warnedRef.current) return
        warnedRef.current = true
        setResizeWarning(true)
        window.setTimeout(() => setResizeWarning(false), RESIZE_WARNING_MS)
      }, HUMAN_RESIZE_SETTLE_MS)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.clearTimeout(timer)
    }
  }, [isOperating, ready])

  const iconBtn = `flex h-7 w-7 shrink-0 items-center justify-center rounded-md3-sm transition-colors disabled:opacity-30 ${
    vibe ? 'text-white/70 hover:bg-white/10 hover:text-white' : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface'
  }`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex items-center gap-1 px-2 py-1.5 border-b ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'}`}>
        <button type="button" className={iconBtn} disabled={!ready || !canBack || isOperating} onClick={() => webviewRef.current?.goBack()} aria-label={t('workbench.agentBrowserBack')} title={t('workbench.agentBrowserBack')}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className={iconBtn} disabled={!ready || !canForward || isOperating} onClick={() => webviewRef.current?.goForward()} aria-label={t('workbench.agentBrowserForward')} title={t('workbench.agentBrowserForward')}>
          <ArrowRight size={15} />
        </button>
        <button type="button" className={iconBtn} disabled={!ready || isOperating} onClick={() => (loading ? webviewRef.current?.stop() : webviewRef.current?.reload())} aria-label={t('workbench.agentBrowserReload')} title={t('workbench.agentBrowserReload')}>
          {loading ? <X size={15} /> : <RotateCw size={14} />}
        </button>

        <div className={`flex min-w-0 flex-1 items-center gap-2 rounded-md3-md px-3 py-1.5 ${vibe ? 'bg-white/8' : 'bg-dark-surfaceContainerHigh'}`}>
          {loading ? (
            <Loader2 size={13} className="shrink-0 animate-spin opacity-60" />
          ) : isOperating ? (
            <MousePointer2 size={13} className="agent-browser-breathe shrink-0 text-md-primary" />
          ) : null}
          {!loading && !isOperating && currentUrl && (
            <Globe size={13} className={`shrink-0 ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/50'}`} />
          )}
          <span
            className={`w-full min-w-0 truncate text-xs ${
              vibe ? 'text-white/80' : 'text-dark-onSurface'
            }`}
            title={currentUrl || t('workbench.agentBrowserIdle')}
          >
            {isOperating ? t('workbench.agentBrowserOccupied') : currentUrl || t('workbench.agentBrowserIdle')}
          </span>
        </div>

        <button type="button" className={iconBtn} disabled={!currentUrl} onClick={() => currentUrl && void ipc.openExternal(currentUrl)} aria-label={t('workbench.agentBrowserOpenExternal')} title={t('workbench.agentBrowserOpenExternal')}>
          <ExternalLink size={14} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <webview
          ref={webviewRef}
          src={idleSrc.current}
          partition={AGENT_PARTITION}
          useragent={FAKE_UA}
          className="h-full w-full"
        />
        {!currentUrl && !loading && (
          <div className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs ${vibe ? 'text-white/45' : 'text-dark-onSurfaceVariant/50'}`}>
            <Globe size={28} aria-hidden />
            <span>{t('workbench.agentBrowserIdle')}</span>
          </div>
        )}
        {resizeWarning && (
          <div
            role="status"
            aria-live="polite"
            className={`pointer-events-none absolute inset-x-2 top-2 z-20 mx-auto flex w-fit max-w-full items-center gap-2 rounded-md3-md border px-3 py-2 text-ui-sm shadow-elevation-2 ${
              vibe ? 'border-white/15 bg-black/70 text-white' : 'border-dark-onSurfaceVariant/20 bg-dark-surfaceContainerHighest text-dark-onSurface'
            }`}
          >
            <TriangleAlert size={14} className="shrink-0 text-md-error" />
            <span>{t('workbench.agentBrowserResizeWarning')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
