// Prevent FOUC: apply theme before React renders.
// 独立外部文件（而非 index.html 内联），配合 CSP script-src 'self'。
;(function () {
  try {
    var raw = localStorage.getItem('clerkbox-settings')
    if (raw) {
      var parsed = JSON.parse(raw)
      var theme = parsed.state && parsed.state.theme
      // 与 theme-engine.ts APP_FONT_STACKS.serif 保持同步（本脚本先于 React 执行，无法 import）
      var appFont = parsed.state && parsed.state.appFont
      if (appFont === 'serif') {
        document.documentElement.style.setProperty(
          '--app-font-family',
          'Georgia, "Songti SC", "Source Han Serif SC", SimSun, serif'
        )
      }
      // 与 theme-engine.ts 的 UI_FONT_BASE_PX / UI_SCALE_MIN / UI_SCALE_MAX 保持同步（本脚本先于 React 执行，无法 import）
      var uiScale = parsed.state && parsed.state.uiScale
      if (typeof uiScale === 'number' && uiScale >= 0.8 && uiScale <= 1.6 && uiScale !== 1) {
        document.documentElement.style.setProperty('--ui-font-size', 16 * uiScale + 'px')
      }
      var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      var isDark = theme === 'dark' || (theme === 'system' && prefersDark)
      if (!isDark && theme) {
        document.documentElement.classList.remove('dark')
      } else {
        document.documentElement.classList.add('dark')
      }
    } else {
      document.documentElement.classList.add('dark')
    }
  } catch (e) {
    document.documentElement.classList.add('dark')
  }
})()
