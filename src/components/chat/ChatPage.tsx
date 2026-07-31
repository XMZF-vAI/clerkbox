import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chat-store'
import { useAgent } from '../../hooks/use-agent'
import { useSkillsStore } from '../../stores/skills-store'
import { AlertCircle } from 'lucide-react'
import { ipc } from '../../lib/ipc-client'
import MessageList from './MessageList'
import ChatInput from './ChatInput'
import ThemeWaves from './ThemeWaves'
import { SubAgentDetailPanel } from './SubAgentDetailPanel'
import { useAgentRunsStore } from '../../stores/agent-runs-store'
import APP_ICON from '../../assets/icon.png'
import NEW_CHAT_ICON from '../../assets/new-chat-icon.png'

interface ChatPageProps {
  vibe?: boolean
}

export default function ChatPage({ vibe = false }: ChatPageProps) {
  const { t } = useTranslation()
  // 用 selector 精细化订阅，避免 agent-runs-store 流式期间（~20fps set）触发 ChatPage 全树重渲染
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamingSessionId = useChatStore((s) => s.streamingSessionId)
  const createSession = useChatStore((s) => s.createSession)
  const initialized = useChatStore((s) => s.initialized)
  const loadFromDb = useChatStore((s) => s.loadFromDb)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const sessionId = activeSessionId || ''
  const { sendMessage, abort, error } = useAgent(sessionId)
  const selectedRunId = useAgentRunsStore((s) => s.selectedRunId)

  useEffect(() => {
    if (!initialized) {
      loadFromDb()
    }
  }, [initialized, loadFromDb])

  useEffect(() => {
    if (initialized && !activeSessionId) {
      createSession()
    }
  }, [initialized, activeSessionId, createSession])

  // Safety: clear stale streaming state on mount
  useEffect(() => {
    if (streamingSessionId) {
      setStreaming(false)
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

  // Sync active skills to disk when working directory or active skill ids change.
  // 只依赖 sessionSkillIds（激活 id 列表）与 workingDir，避免整个 skills 数组引用变化触发重渲染与重复 IO。
  // 用 useSkillsStore.getState() 快照取数，不订阅 skills，防止无关 skills 变化（如搜索/推荐）拖累 ChatPage。
  const sessionSkillIds = useSkillsStore((s) => s.sessionSkillIds)

  useEffect(() => {
    if (!workingDir) return
    // 快照取当前激活技能，不建立订阅
    const allSkills = useSkillsStore.getState().skills
    const activeSkills = allSkills.filter((s) => sessionSkillIds.includes(s.id))
    for (const skill of activeSkills) {
      // 标准路径技能（clerkbox/claude 全局+项目级）不写盘，直接引用原路径
      if (skill.source === 'global-clerkbox' || skill.source === 'project-clerkbox' || skill.source === 'global-claude' || skill.source === 'project-claude') continue
      // online/custom 技能写盘完整文件目录（files 空时回退单文件）
      const files = skill.files && skill.files.length > 0
        ? skill.files
        : [{ path: 'SKILL.md', content: skill.skillMdContent }]
      ipc.writeSkillDir(workingDir, skill.slug, files).catch((err) =>
        console.error(`[ChatPage] writeSkillDir failed for ${skill.slug}:`, err)
      )
    }
  }, [workingDir, sessionSkillIds])

  const messages = currentSession?.messages || []
  const isCurrentSessionStreaming = streamingSessionId === activeSessionId
  const isEmpty = messages.length === 0

  const handleSend = async (content: string) => {
    if (!sessionId) return
    await sendMessage(content)
  }

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
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = APP_ICON
                    }}
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
                isStreaming={isCurrentSessionStreaming}
                variant={vibe ? 'default' : 'welcome'}
                vibe={vibe}
              />
            </div>
          </div>
        </div>
        {error && (
          <div className={`flex items-center gap-2 px-4 py-2 mx-4 mb-2 rounded-md3-sm text-sm ${
            vibe
              ? 'liquid-glass-subtle text-white/90'
              : 'bg-md-error/10 border border-md-error/20 text-md-error'
          }`}>
            <AlertCircle size={14} className="flex-shrink-0" />
            <span className="flex-1">{error}</span>
          </div>
        )}
        {!vibe && <ThemeWaves />}
      </div>
    )
  }

  // Normal layout: message list + input at bottom, with optional detail panel on the right
  return (
    <div className={`flex h-full ${vibe ? 'bg-transparent' : 'bg-dark-surface'}`}>
      <div className="flex flex-1 flex-col min-h-0">
        <MessageList messages={messages} isStreaming={isCurrentSessionStreaming} vibe={vibe} />
        {error && (
          <div className={`flex items-center gap-2 px-4 py-2 mx-4 rounded-md3-sm text-sm ${
            vibe
              ? 'liquid-glass-subtle text-white/90'
              : 'bg-md-error/10 border border-md-error/20 text-md-error'
          }`}>
            <AlertCircle size={14} className="flex-shrink-0" />
            <span className="flex-1">{error}</span>
          </div>
        )}
        <ChatInput onSend={handleSend} onStop={abort} isStreaming={isCurrentSessionStreaming} vibe={vibe} />
      </div>
      {selectedRunId && <SubAgentDetailPanel sessionId={sessionId} vibe={vibe} />}
    </div>
  )
}
