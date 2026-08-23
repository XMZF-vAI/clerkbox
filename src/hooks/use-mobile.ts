import { useEffect, useState } from 'react'

const MOBILE_QUERY = '(max-width: 768px)'

/**
 * 窄屏检测：WebUI 在手机/平板浏览器中的移动端布局开关。
 * 桌面 Electron 最小窗宽 800px，永远不会触发，因此该 hook 可无条件使用。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
  )
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isMobile
}
