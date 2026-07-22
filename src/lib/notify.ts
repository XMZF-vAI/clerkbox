/**
 * 系统通知工具
 *
 * 仅当用户当前不在触发事件的会话时才发通知（自己看着的会话不发）。
 * 通知点击会切换到对应会话并聚焦窗口。
 */

import { useChatStore } from '../stores/chat-store'
import APP_ICON from '../assets/icon.png'

export type NotifyKind = 'done' | 'error' | 'confirm-danger'

const TITLES: Record<NotifyKind, string> = {
  done: 'ClerkBox 已完成工作',
  error: 'ClerkBox 异常停下',
  'confirm-danger': 'ClerkBox 有危险命令需确认',
}

const BODIES: Record<NotifyKind, string> = {
  done: '一个会话的任务已完成，点击查看',
  error: '一个会话的 AI 执行出现错误，点击查看',
  'confirm-danger': '检测到高风险命令，需要你确认后才会执行',
}

/**
 * 判断当前用户是否「看着」这个会话（即该会话是激活会话且应用聚焦）。
 * 应用失焦时也算「不在看」——用户可能在干别的事。
 */
function isUserViewingSession(sessionId: string): boolean {
  if (document.hidden) return false
  return useChatStore.getState().activeSessionId === sessionId
}

/**
 * 发送桌面通知。仅当用户当前不在该会话时才触发。
 *
 * @param sessionId 触发事件的会话 ID
 * @param kind 通知类型
 * @param body 可选的自定义正文（覆盖默认）
 */
export function notifyIfNotViewing(
  sessionId: string,
  kind: NotifyKind,
  body?: string,
): void {
  if (isUserViewingSession(sessionId)) return
  if (!('Notification' in window)) return

  // 权限未授权时静默请求一次；denied 时直接放弃
  let permission = Notification.permission
  if (permission === 'default') {
    Notification.requestPermission().then((p) => {
      permission = p
      if (permission === 'granted') emit()
    })
    return
  }
  if (permission !== 'granted') return

  emit()

  function emit() {
    try {
      // tag 加时间戳避免同一会话多次触发时被合并吞掉
      const n = new Notification(TITLES[kind], {
        body: body ?? BODIES[kind],
        // 复用应用图标
        icon: APP_ICON,
        tag: `clerkbox-${sessionId}-${kind}-${Date.now()}`,
      })
      n.onclick = () => {
        // 切换到对应会话；window.focus() 把窗口拉到前台
        useChatStore.getState().setActiveSession(sessionId)
        window.focus()
        n.close()
      }
    } catch {
      // 某些 Electron 版本 Notification 构造异常时静默
    }
  }
}
