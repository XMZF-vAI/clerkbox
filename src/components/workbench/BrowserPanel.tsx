import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CircleAlert, ExternalLink, Globe, Loader2, RotateCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'

/** webview 元素上我们实际用到的最小能力面（避免在渲染层引入 electron 类型） */
interface WebviewEl extends HTMLElement {
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
}

// 常规桌面 Chrome UA：部分站点会因 Electron UA 拒绝渲染
const FAKE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 将地址栏输入规范化为可导航 URL；带空格或无协议无点号的输入视为搜索词 */
export function normalizeAddressInput(raw: string): string | null {
  const input = raw.trim()
  if (!input) return null
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    || (!input.includes(' ') && (/^[\w-]+(\.[\w-]+)+/.test(input) || /^localhost(?::\d+)?(?:\/|$)/i.test(input)))
  if (looksLikeUrl) {
    try {
      const scheme = /^localhost(?::\d+)?(?:\/|$)/i.test(input) ? 'http' : 'https'
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `${scheme}://${input}`)
      // 仅放行 http(s)：file/ftp/custom scheme 一律拒绝
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
    } catch { /* fallthrough */ }
    return null
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(input)}`
}

/**
 * 工作台浏览器面板：<webview> 内嵌预览 + 地址栏 + 导航按钮。
 * 每个工作台标签维护一个独立实例（隐藏不销毁，保页面现场）。
 *
 * 导航分两轨：guest 页面就绪前靠 src 属性触发首次导航
 * （无 src 的 webview 不会创建 guest，loadURL 会直接抛错）；就绪后走 loadURL。
 */
export default function BrowserPanel({
  vibe,
  initialUrl,
  active,
  onOpenNewTab,
}: {
  vibe?: boolean
  initialUrl?: string
  active: boolean
  onOpenNewTab?: (url: string) => void
}) {
  const { t } = useTranslation()
  const webviewRef = useRef<WebviewEl | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const [input, setInput] = useState(initialUrl || '')
  const [currentUrl, setCurrentUrl] = useState('')
  // src 属性态：仅在 guest 未就绪时用于触发首次导航
  const [navSrc, setNavSrc] = useState(initialUrl || '')
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(Boolean(initialUrl))
  const [loadError, setLoadError] = useState<{ url: string; message: string } | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)

  const syncNavState = useCallback(() => {
    const wv = webviewRef.current
    if (!wv) return
    try {
      setCanBack(wv.canGoBack())
      setCanForward(wv.canGoForward())
      const url = wv.getURL()
      setCurrentUrl(url)
      setInput(url)
    } catch { /* 尚未 ready */ }
  }, [])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onDomReady = () => {
      setReady(true)
      syncNavState()
    }
    const onNavStart = () => { setLoading(true); setLoadError(null) }
    const onNavEnd = () => {
      setLoading(false)
      syncNavState()
    }
    // 拦截非 http(s) 跳转（页面内链接指向 file:// 等协议时阻止）
    const onWillNavigate = (e: Event) => {
      const url = (e as Event & { url?: string }).url || ''
      if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
        e.preventDefault()
      }
    }
    const onLoadFailed = (event: Event) => {
      const failure = event as Event & { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }
      // 用户中断/跳转和子资源失败均不应盖住仍然可用的页面。
      if (failure.errorCode === -3 || failure.isMainFrame === false) return
      setLoading(false)
      setLoadError({ url: failure.validatedURL || '', message: failure.errorDescription || '' })
    }
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-start-loading', onNavStart)
    wv.addEventListener('did-stop-loading', onNavEnd)
    wv.addEventListener('did-navigate', onNavEnd)
    wv.addEventListener('did-navigate-in-page', onNavEnd)
    wv.addEventListener('will-navigate', onWillNavigate)
    wv.addEventListener('did-fail-load', onLoadFailed)
    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-start-loading', onNavStart)
      wv.removeEventListener('did-stop-loading', onNavEnd)
      wv.removeEventListener('did-navigate', onNavEnd)
      wv.removeEventListener('did-navigate-in-page', onNavEnd)
      wv.removeEventListener('will-navigate', onWillNavigate)
      wv.removeEventListener('did-fail-load', onLoadFailed)
    }
  }, [onOpenNewTab, syncNavState])

  useEffect(() => {
    if (!active || !onOpenNewTab) return
    return ipc.onBrowserNewTab((url) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') onOpenNewTab(parsed.toString())
      } catch { /* 主进程已校验，渲染层再做一次边界保护 */ }
    })
  }, [active, onOpenNewTab])

  const navigate = (raw: string) => {
    const url = normalizeAddressInput(raw)
    if (!url) return
    setInput(url)
    setLoading(true)
    setLoadError(null)
    const wv = webviewRef.current
    if (wv && ready) {
      try {
        void wv.loadURL(url).catch((error: unknown) => {
          if (error instanceof Error && error.message.includes('ERR_ABORTED')) return
          setLoading(false)
          setLoadError({ url, message: error instanceof Error ? error.message : String(error) })
        })
      } catch {
        // 极端时序下 guest 尚未真正可用：退回 src 属性导航
        setNavSrc(url)
      }
    } else {
      setNavSrc(url)
    }
  }

  const openExternal = () => {
    if (currentUrl) void ipc.openExternal(currentUrl)
  }

  const iconBtn = `md-focus flex h-9 w-9 shrink-0 items-center justify-center rounded-md3-sm transition-colors disabled:opacity-30 ${
    vibe ? 'text-white/70 hover:bg-white/10 hover:text-white' : 'text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface'
  }`

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={(event) => {
      if (active && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        addressRef.current?.focus()
        addressRef.current?.select()
      }
    }}>
      {/* 工具栏 */}
      <div className={`flex items-center gap-1 px-2 py-1.5 border-b ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'}`}>
        <button type="button" className={iconBtn} disabled={!ready || !canBack} onClick={() => webviewRef.current?.goBack()} aria-label={t('workbench.browserBack')} title={t('workbench.browserBack')}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className={iconBtn} disabled={!ready || !canForward} onClick={() => webviewRef.current?.goForward()} aria-label={t('workbench.browserForward')} title={t('workbench.browserForward')}>
          <ArrowRight size={15} />
        </button>
        <button type="button" className={iconBtn} disabled={!ready} onClick={() => (loading ? webviewRef.current?.stop() : webviewRef.current?.reload())} aria-label={t('workbench.browserReload')} title={t('workbench.browserReload')}>
          {loading ? <X size={15} /> : <RotateCw size={14} />}
        </button>

        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(input)
          }}
        >
          <div className={`flex min-h-9 items-center gap-2 rounded-md3-sm border px-3 py-1.5 ${vibe ? 'border-white/10 bg-white/10 focus-within:border-white/30' : 'border-dark-onSurfaceVariant/10 bg-dark-surface focus-within:border-md-primary/40'} transition-colors`}>
            {loading && <Loader2 size={13} className="shrink-0 animate-spin opacity-60" />}
            {!loading && currentUrl && (
              <Globe size={13} className={`shrink-0 ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/50'}`} />
            )}
            <input
              ref={addressRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('workbench.browserPlaceholder')}
              spellCheck={false}
              aria-label={t('workbench.browserPlaceholder')}
              onFocus={(event) => event.currentTarget.select()}
              className={`w-full min-w-0 bg-transparent text-ui-xs outline-none ${
                vibe ? 'text-white placeholder:text-white/35' : 'text-dark-onSurface placeholder:text-dark-onSurfaceVariant/40'
              }`}
            />
          </div>
        </form>

        <button type="button" className={iconBtn} disabled={!currentUrl} onClick={openExternal} aria-label={t('workbench.browserOpenExternal')} title={t('workbench.browserOpenExternal')}>
          <ExternalLink size={14} />
        </button>
      </div>

      {/* 页面区 */}
      <div className="relative min-h-0 flex-1">
        <webview
          ref={webviewRef}
          src={navSrc || undefined}
          partition="persist:workbench-browser"
          useragent={FAKE_UA}
          // Allow target="_blank"/window.open to reach the main-process handler,
          // which forwards the safe URL to a new workbench tab.
          allowpopups
          className="h-full w-full"
        />
        {loadError && (
          <div role="alert" className={`absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-6 text-center text-ui-sm ${vibe ? 'bg-dark-surfaceDim/95 text-white/75' : 'bg-dark-surfaceDim text-dark-onSurfaceVariant'}`}>
            <CircleAlert size={28} className="shrink-0 text-md-error" aria-hidden />
            <p className="max-w-sm leading-relaxed">{t('workbench.browserLoadFailed')}</p>
            {loadError.message && <p className="max-w-full break-all font-mono text-ui-xs opacity-70">{loadError.message}</p>}
            <button type="button" onClick={() => navigate(loadError.url || input || currentUrl || navSrc)} className="md-focus flex min-h-9 shrink-0 items-center gap-2 rounded-md3-sm border border-dark-onSurfaceVariant/20 px-4 py-2 hover:bg-dark-surfaceContainerHigh transition-colors"><RotateCw size={14} aria-hidden />{t('common.retry')}</button>
          </div>
        )}
        {!currentUrl && !loading && !loadError && (
          <div className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-ui-sm leading-relaxed ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant'}`}>
            <Globe size={28} aria-hidden />
            <span>{t('workbench.browserEmpty')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
