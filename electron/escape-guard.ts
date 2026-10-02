/**
 * 「按 Esc 停止电脑操控」的系统级拦截
 *
 * 为什么需要系统级：浮块小岛是 `focusable: false` + `setIgnoreMouseEvents(true)` 的
 * 窗口，**它自己收不到键盘**。而操控期间用户的焦点在别的应用上（甚至不在 ClerkBox），
 * 所以 Esc 必须由主进程全局捕获，再转成一个事件通知渲染层去中止那次运行。
 *
 * 代价必须说清楚：注册期间 **Esc 在这台机器上被 ClerkBox 占着**，
 * 别的应用（浏览器、编辑器、终端）会收不到 Esc。这在「AI 正在接管你的电脑」
 * 期间是可接受的 —— 用户此时的正确操作本来就是叫停它，而不是用 Esc 取消别的东西。
 * 一收手就立刻注销，窗口期只有操控本身。
 *
 * 为什么不自己装全局键盘钩子（uiohook 之类）：本仓 `npmRebuild: false`，
 * 新增原生模块不会为 Electron 42 重建，发布包直接起不来。Electron 自带的
 * globalShortcut 覆盖 Esc 足够，且不引入任何新依赖。
 */
import { globalShortcut } from 'electron'

let registered = false
let onTrigger: (() => void) | null = null

/**
 * 开始接管 Esc。
 * @returns 是否真的接管成功。失败（被别的应用占着、平台不支持）时返回 false，
 *   调用方要据此把「按 Esc 停止」这句提示藏掉 —— 提示一个按不动的键比没有提示更糟。
 */
export function beginEscapeGuard(trigger: () => void): boolean {
  if (registered) {
    onTrigger = trigger
    return true
  }
  let ok = false
  try {
    ok = globalShortcut.register('Escape', () => {
      onTrigger?.()
    })
  } catch (err) {
    console.error('[escape-guard] register failed:', err)
    return false
  }
  if (!ok) {
    console.error('[escape-guard] Escape is already taken by another application')
    return false
  }
  registered = true
  onTrigger = trigger
  return true
}

/** 收手：立刻把 Esc 还给系统。这是「占多久」的上界，必须与操控期严格一致。 */
export function endEscapeGuard(): void {
  onTrigger = null
  if (!registered) return
  try {
    globalShortcut.unregister('Escape')
  } catch {
    // unregister 失败不留档：进程退出时系统会回收，这里不追
  }
  registered = false
}

export function isEscapeGuardActive(): boolean {
  return registered
}
