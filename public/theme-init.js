// Prevent FOUC: apply theme before React renders.
// 独立外部文件（而非 index.html 内联），配合 CSP script-src 'self'。
;(function () {
  try {
    var raw = localStorage.getItem('clerkbox-settings')
    if (raw) {
      var parsed = JSON.parse(raw)
      var theme = parsed.state && parsed.state.theme
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
