import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import { useUIStore } from '../../stores/ui-store'

/**
 * 系统托盘 ↔ 渲染层桥接（仅桌面端有实际作用）。
 *
 * 渲染进程是"会话 / i18n / 设置"的唯一来源，主进程没有这些能力，因此本组件负责：
 * 1. 下发文案（菜单、首次隐藏通知、退出确认）与配置（关闭行为、会话条数）；
 * 2. 接收托盘菜单里的"点击某个对话"并切过去（必要时先增量同步 DB，覆盖另一端新建的会话）；
 * 3. 挂载完成即通知主进程消费"窗口未就绪时暂存的点击"。
 *
 * 挂在 App 根部（等 zustand 水合完成后才挂载），因此 `notifyTrayReady` 天然代表
 * "渲染层已可接收指令"。WebUI 模式下 ipc 包装全部是 no-op，无需在此分支。
 */
export default function TrayBridge() {
  const { t, i18n } = useTranslation()
  const closeBehavior = useSettingsStore((s) => s.closeBehavior)
  const recentSessionsLimit = useSettingsStore((s) => s.recentSessionsLimit)

  // 文案：语言切换后重新下发（主进程会重建菜单）
  useEffect(() => {
    ipc.setTrayLabels({
      tooltip: t('tray.tooltip'),
      tooltipBusy: t('tray.tooltipBusy'),
      showWindow: t('tray.showWindow'),
      recentSessions: t('tray.recentSessions'),
      noRecentSessions: t('tray.noRecentSessions'),
      quit: t('tray.quit'),
      quitConfirmTitle: t('tray.quitConfirmTitle'),
      quitConfirmMessage: t('tray.quitConfirmMessage'),
      firstHideNoticeTitle: t('tray.firstHideNoticeTitle'),
      firstHideNoticeBody: t('tray.firstHideNoticeBody'),
      untitledSession: t('tray.untitledSession'),
    })
  }, [t, i18n.language])

  // 配置：关闭行为 + 菜单里的会话条数
  useEffect(() => {
    ipc.setTrayConfig({ closeBehavior, recentSessionsLimit })
  }, [closeBehavior, recentSessionsLimit])

  // 就绪通知（消费主进程暂存的会话点击，否则"窗口刚建好后的第一次点击"会丢）
  useEffect(() => {
    ipc.notifyTrayReady()
  }, [])

  // 托盘点选对话：关掉全屏子页 → 必要时补齐数据 → 切会话
  useEffect(() => ipc.onTrayOpenSession((sessionId) => {
    void (async () => {
      const chat = useChatStore.getState()
      if (!chat.sessions.some((session) => session.id === sessionId)) {
        // 该会话可能只存在于 DB（WebUI 端新建），先增量同步再激活
        await chat.syncFromDb().catch(() => undefined)
      }
      useSettingsStore.getState().updateSettings({ showSettings: false })
      useUIStore.getState().setShowSkillStore(false)
      useUIStore.getState().setShowScheduledTasks(false)
      useChatStore.getState().setActiveSession(sessionId)
    })()
  }), [])

  return null
}
