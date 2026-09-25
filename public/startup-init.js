// 启动遮罩退场控制：动画播完 + 应用核心初始化就绪，两个条件都满足才淡出。
// 独立外部文件（而非 index.html 内联），配合 CSP script-src 'self'。
;(function () {
  var overlay = document.getElementById('clerkbox-startup')
  var logo = document.getElementById('clerkbox-startup-logo')
  if (!overlay) return

  var root = document.documentElement
  // 透明窗口最大化时应用内容没有圆角，遮罩若仍带圆角会在四角露出桌面底色
  if (window.clerkbox && window.clerkbox.isWindowMaximized) root.classList.add('clerkbox-startup-square')

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var finished = false
  var animationDone = reduceMotion || !logo
  var coreReady = false

  // 遮罩自身有超时兜底，宁可早退也不能永久盖住界面
  var HARD_TIMEOUT = 6000

  var finish = function () {
    if (finished || !animationDone || !coreReady) return
    finished = true
    root.classList.add('clerkbox-startup-hidden')
    window.setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    }, 450)
  }

  var markAnimationDone = function () {
    animationDone = true
    finish()
  }

  var markCoreReady = function () {
    coreReady = true
    finish()
  }

  window.addEventListener('clerkbox-startup-ready', markCoreReady, { once: true })
  window.setTimeout(markCoreReady, HARD_TIMEOUT)

  if (!reduceMotion && logo) {
    logo.addEventListener('animationend', markAnimationDone, { once: true })
    // animationend 在后台标签页/降级环境下可能不触发，不能让它成为退场的唯一依据
    window.setTimeout(markAnimationDone, 1000)
  }
})()
