import { useChatStore } from '../stores/chat-store'

/**
 * 当前激活会话的生效工作目录（用户选过的 workingDir 优先，否则回退默认目录）。
 *
 * 从 ChatPage / ChatInput / SkillStore / WorkbenchPanel 重复出现 4 次的
 * `sessions.find(...)?.workingDir || ...?.defaultWorkDir` 收敛而来。
 * selector 返回字符串原始值：流式期间 sessions 数组引用每 tick 变化，
 * 但只要目录字符串不变就不触发重渲染。
 */
export function useActiveWorkingDir(): string {
  return useChatStore(
    (s) => s.sessions.find((session) => session.id === s.activeSessionId)?.workingDir
      || s.sessions.find((session) => session.id === s.activeSessionId)?.defaultWorkDir
      || ''
  )
}
