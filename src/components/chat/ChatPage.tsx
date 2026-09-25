import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, getSessionAbortController } from '../../stores/chat-store'
import { useAgent } from '../../hooks/use-agent'
import { useSkillsStore } from '../../stores/skills-store'
import { ipc } from '../../lib/ipc-client'
import type { Message, MessageAttachment, MessageSkillSnapshot, TaskMode } from '../../types/agent'
import MessageList from './MessageList'
import ChatInput from './ChatInput'
import ThemeWaves from './ThemeWaves'
import NEW_CHAT_ICON from '../../assets/new-chat-icon.png'
import QuestionCard from './QuestionCard'
import TodoListCard from './TodoListCard'
import GoalBanner from './GoalBanner'
import ChatErrorBanner from './ChatErrorBanner'
import { PermissionApprovalCard } from './PermissionCard'

interface ChatPageProps {
  vibe?: boolean
}

export default function ChatPage({ vibe = false }: ChatPageProps) {
  const { t } = useTranslation()
  // 用 selector 精细化订阅，避免 agent-runs-store 流式期间（~20fps set）触发 ChatPage 全树重渲染
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingSessionIds = useChatStore((s) => s.streamingSessionIds)
  const createSession = useChatStore((s) => s.createSession)
  const initialized = useChatStore((s) => s.initialized)
  const loadFromDb = useChatStore((s) => s.loadFromDb)
  const sessionId = activeSessionId || ''
  const { sendMessage, abort, manualCompact, isCompacting, error, sendQueuedNow, requestQueuedFlush } = useAgent(sessionId)

  useEffect(() => {
    if (!initialized) {
      loadFromDb()
    }
  }, [initialized, loadFromDb])

  // 跨模式实时同步：定时从 DB 增量拉取，让桌面端与 WebUI 看到彼此的对话
  const syncFromDb = useChatStore((s) => s.syncFromDb)
  useEffect(() => {
    if (!initialized) return
    const timer = setInterval(() => {
      void syncFromDb()
    }, 3000)
    return () => clearInterval(timer)
  }, [initialized, syncFromDb])

  useEffect(() => {
    if (initialized && !activeSessionId) {
      createSession()
    }
  }, [initialized, activeSessionId, createSession])

  // Safety: 应用启动时清理上次崩溃遗留的 streaming 状态（全部清空，重启后无 ReAct 循环在跑）
  useEffect(() => {
    const ids = useChatStore.getState().streamingSessionIds
    if (ids.size > 0) {
      ids.forEach((sid) => useChatStore.getState().setStreaming(false, sid))
    }
  }, [])

  // Initialize .clerkbox directory when working directory is set (user-picked or default)
  const currentSession = sessions.find((s) => s.id === activeSessionId)
  const workingDir = currentSession?.workingDir || currentSession?.defaultWorkDir

  useEffect(() => {
    if (workingDir) {
      ipc.initClerkbox(workingDir).catch((e) => { console.error('initClerkbox failed:', e) })
      useSkillsStore.getState().discoverStandardSkills(workingDir).catch((e) => { console.error('discoverStandardSkills failed:', e) })
    }
  }, [workingDir])

  // Sync active skills when the directory or enabled skill set changes.
  const sessionSkillIds = useSkillsStore((s) => s.sessionSkillIds)
  const syncSessionSkills = useSkillsStore((s) => s.syncSessionSkills)

  useEffect(() => {
    if (!workingDir) return
    void syncSessionSkills(workingDir)
  }, [workingDir, sessionSkillIds, syncSessionSkills])

  const messages = currentSession?.messages || []
  const isCurrentSessionStreaming = streamingSessionIds.has(activeSessionId || '')
  const isEmpty = messages.length === 0

  const handleSend = async (
    content: string,
    attachments?: MessageAttachment[],
    taskMode?: TaskMode,
    skills?: MessageSkillSnapshot[]
  ) => {
    if (!sessionId) return
    await sendMessage(content, attachments, taskMode, skills)
  }

  // 重试：走 sendMessage 现有导出面重发最后一条用户消息（不新增 useAgent 接口）
  const lastUserMessage = useMemo<Message | undefined>(
    () => [...messages].reverse().find((m) => m.role === 'user'),
    [messages]
  )
  // 会话仍在运行 / 正在压缩 / 无用户消息时不提供重发，避免重复入队与并发发送
  const canRetry =
    !!lastUserMessage &&
    !isCurrentSessionStreaming &&
    !isCompacting &&
    !getSessionAbortController(sessionId)
  const handleRetry = useCallback(() => {
    if (!sessionId || !lastUserMessage || !canRetry) return
    void sendMessage(
      lastUserMessage.content,
      lastUserMessage.attachments,
      lastUserMessage.taskMode,
      lastUserMessage.skills
    )
  }, [sessionId, lastUserMessage, canRetry, sendMessage])

  const errorBanner = error ? (
    <ChatErrorBanner
      error={error}
      sessionId={sessionId}
      vibe={vibe}
      isCompacting={isCompacting}
      canRetry={canRetry}
      onCompact={() => void manualCompact()}
      onRetry={handleRetry}
    />
  ) : null

  // Welcome screen: centered layout with icon + greeting + skill loader + input
  if (isEmpty) {
    return (
      <div className={`relative flex flex-col h-full ${vibe ? 'bg-transparent' : 'bg-dark-surface'}`}>
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <div className="w-full max-w-3xl">
            {!vibe && (
              <>
                {/* Icon + Welcome text */}
                <div className="flex items-center gap-4 mb-6">
                  <img
                    src={NEW_CHAT_ICON}
                    alt="Welcome"
                    className="w-14 h-14 rounded-md3-lg object-cover"
                  />
                  <span className="text-xl font-medium text-dark-onSurface">
                    {t('chat.emptyWelcome')}
                  </span>
                </div>
              </>
            )}
            {/* Centered input */}
            <div className={vibe ? '' : 'mt-2'}>
              <ChatInput
                onSend={handleSend}
                onStop={abort}
                onManualCompact={manualCompact}
                isCompacting={isCompacting}
                isStreaming={isCurrentSessionStreaming}
                onSendNow={sendQueuedNow}
                onEnqueueQueued={requestQueuedFlush}
                variant={vibe ? 'default' : 'welcome'}
                vibe={vibe}
              />
            </div>
          </div>
        </div>
        {errorBanner}
        {!vibe && <ThemeWaves />}
      </div>
    )
  }

  // Normal layout: message list + input at bottom, with optional detail panel on the right
  return (
    <div className={`relative flex h-full ${vibe ? 'bg-transparent' : 'bg-dark-surface'}`}>
      <div className="flex flex-1 flex-col min-h-0 min-w-0 overflow-x-hidden">
        {/* key=会话 id：切会话强制重挂载，重置滚动粘底状态并回到最新消息 */}
        <MessageList key={sessionId} sessionId={sessionId} messages={messages} isStreaming={isCurrentSessionStreaming} vibe={vibe} />
        <GoalBanner sessionId={sessionId} vibe={vibe} />
        <TodoListCard sessionId={sessionId} vibe={vibe} />
        <QuestionCard sessionId={sessionId} vibe={vibe} />
        <PermissionApprovalCard sessionId={sessionId} vibe={vibe} />
        {errorBanner}
        <ChatInput onSend={handleSend} onStop={abort} onManualCompact={manualCompact} isCompacting={isCompacting} isStreaming={isCurrentSessionStreaming} onSendNow={sendQueuedNow} onEnqueueQueued={requestQueuedFlush} vibe={vibe} />
      </div>
    </div>
  )
}
