import { useEffect } from 'react'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore, getSessionAbortController } from '../../stores/chat-store'
import { useWorkbench } from '../../stores/workbench-store'
import { ipc } from '../../lib/ipc-client'

/**
 * Agent 动作能力的运行时桥接（应用层单例）。
 *
 * 三件事，都是主进程与渲染层之间的接线，不该出现在业务组件里：
 *   1. 订阅「Agent 刚操作了一次浏览器」→ 推进标签呼吸图标的 5s 滑动窗口；
 *   2. 订阅「请打开 Agent 浏览器面板」→ 打开标签。
 *      **这个请求只在 AI 真的发出了浏览器命令时才发生**（工具层经 IPC 发起）。
 *      能力开关打开本身不走这条路径 —— 否则用户一开开关面板就自己跳出来，
 *      而这个标签本该是「AI 正在操控浏览器」这件事的视觉载体，没有正在操控就不该亮出来。
 *   3. 「没有 run 在跑」时通知主进程收起电脑操控浮层 —— 浮块在整个操控期常驻，
 *      收手时机是运行结束，而不是单个动作结束（逐动作熄灯会让「正在接管我的电脑」
 *      看起来像「偶尔动一下」，安全上几乎无效）。
 *
 * 只在开关打开时挂载：关掉能力后不该有任何后台订阅。
 */
export function AgentActionBridge() {
  const browserUseEnabled = useSettingsStore((s) => s.browserUseEnabled)
  const computerUseEnabled = useSettingsStore((s) => s.computerUseEnabled)
  const { markAgentBrowserOperation, openAgentBrowser, openAgentBrowserFor } = useWorkbench()

  useEffect(() => {
    if (!browserUseEnabled) return
    return ipc.onAgentBrowserOperation(() => markAgentBrowserOperation())
  }, [browserUseEnabled, markAgentBrowserOperation])

  useEffect(() => {
    if (!browserUseEnabled) return
    // 请求带的是**正在跑任务的那个会话**。开在它自己分片里：
    // 用户切到别的对话时，面板不会凭空出现在这个无关对话里。
    // 拿不到 sessionId（旧客户端 / 远端）时退回当前会话 —— 那是唯一有意义的猜测。
    return ipc.onAgentBrowserEnsurePanel((sessionId) => {
      if (sessionId) openAgentBrowserFor(sessionId)
      else openAgentBrowser()
    })
  }, [browserUseEnabled, openAgentBrowser, openAgentBrowserFor])

  useEffect(() => {
    if (!computerUseEnabled) return
    // 浮层在**整个操控期常驻**，收手时机是「没有任何 run 在跑」。
    // 主进程不知道运行什么时候结束（run 在渲染层），所以由这里下发。
    // 逐动作熄灯是错的：AI 两次动作之间隔着推理与审批，那段时间用户看到的
    // 「AI 偶尔动一下我的电脑」远比常驻的「正在接管」安全。
    return useChatStore.subscribe((state, prev) => {
      if (prev.streamingSessionIds.size > 0 && state.streamingSessionIds.size === 0) {
        void ipc.endComputerUseControl()
      }
    })
  }, [computerUseEnabled])

  useEffect(() => {
    if (!computerUseEnabled) return
    // 用户按 Esc 叫停。**中止的是正在跑的那次运行** —— 电脑操控必然发生在
    // 某个 streaming 的 run 里，所以按 streamingSessionIds 找得到它。
    // 必须真的 abort：只关浮块的话 AI 会在下一轮继续动鼠标，
    // 而用户按下 Esc 的直觉是「我拒绝这次操控」，不是「把提示关掉」。
    return ipc.onComputerUseUserStopped(() => {
      const streaming = useChatStore.getState().streamingSessionIds
      for (const sessionId of streaming) {
        const ctrl = getSessionAbortController(sessionId)
        if (ctrl) {
          try { ctrl.abort() } catch { /* 已结束 */ }
        }
      }
    })
  }, [computerUseEnabled])

  useEffect(() => {
    if (!computerUseEnabled) return
    // 开发态留一条日志，便于确认「AI 确实接管了桌面」这件事发生过
    const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false
    if (!isDev) return
    return ipc.onComputerUseOperation((event) => {
      console.log('[agent-action] computer use', event.phase)
    })
  }, [computerUseEnabled])

  return null
}
