import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, FolderOpen, Loader2, Search, Store } from 'lucide-react'
import { useChatStore, getSessionAbortController } from '../../stores/chat-store'
import { useAgent } from '../../hooks/use-agent'
import { useSkillsStore } from '../../stores/skills-store'
import { useSettingsStore } from '../../stores/settings-store'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import type { Message, MessageAttachment, MessageSkillSnapshot, TaskMode } from '../../types/agent'
import MessageList from './MessageList'
import ChatInput from './ChatInput'
import ThemeWaves from './ThemeWaves'
import NEW_CHAT_ICON from '../../assets/new-chat-icon.png'
import QuestionCard from './QuestionCard'
import TodoListCard from './TodoListCard'
import GoalBanner from './GoalBanner'
import ChatErrorBanner from './ChatErrorBanner'
import RewindDialog from './RewindDialog'
import { PermissionApprovalCard } from './PermissionCard'
import { useUIStore } from '../../stores/ui-store'
import ModelSetupGuidance from './ModelSetupGuidance'
import { getRemoteConnection, isCloudRemoteMode } from '../../remote/browser'

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
  // 界面模式：编程=按时段问候原文案；通用=固定一条工作导向问候
  const interfaceMode = useSettingsStore((s) => s.interfaceMode)
  const cloudRemote = isCloudRemoteMode()
  const modelConfigured = useSettingsStore((s) => !!s.model.trim() && (cloudRemote || !!s.baseUrl.trim()))
  const modelLabel = useSettingsStore((s) => {
    const provider = s.providers.find((item) => item.id === s.activeProviderId)
    return provider?.models.find((item) => item.id === s.activeModelId)?.label || s.model
  })
  const initialized = useChatStore((s) => s.initialized)
  const loadFromDb = useChatStore((s) => s.loadFromDb)
  const sessionId = activeSessionId || ''
  const { sendMessage, abort, manualCompact, isCompacting, isStopping, error, sendQueuedNow, requestQueuedFlush } = useAgent(sessionId)

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
      if (cloudRemote && getRemoteConnection().state !== 'connected') return
      void syncFromDb()
    }, 3000)
    return () => clearInterval(timer)
  }, [initialized, syncFromDb, cloudRemote])

  useEffect(() => {
    if (initialized && !activeSessionId) {
      createSession()
    }
  }, [initialized, activeSessionId, createSession])

  // Safety: 应用启动时清理上次崩溃遗留的 streaming 状态（全部清空，重启后无 ReAct 循环在跑）
  useEffect(() => {
    if (cloudRemote) return
    const ids = useChatStore.getState().streamingSessionIds
    if (ids.size > 0) {
      ids.forEach((sid) => useChatStore.getState().setStreaming(false, sid))
    }
  }, [cloudRemote])

  // Initialize .clerkbox directory when working directory is set (user-picked or default)
  const currentSession = sessions.find((s) => s.id === activeSessionId)
  const workingDir = currentSession?.workingDir || currentSession?.defaultWorkDir
  const workingDirLabel = currentSession?.workingDir
    ? currentSession.workingDir.split(/[\\/]/).filter(Boolean).pop() || currentSession.workingDir
    : workingDir ? t('shell.defaultDirectory') : t('shell.autoDirectory')

  useEffect(() => {
    if (workingDir) {
      ipc.initClerkbox(workingDir).catch((e) => { console.error('initClerkbox failed:', e) })
      useSkillsStore.getState().discoverStandardSkills(workingDir).catch((e) => { console.error('discoverStandardSkills failed:', e) })
    }
  }, [workingDir, cloudRemote])

  // Sync active skills when the directory or enabled skill set changes.
  const sessionSkillIds = useSkillsStore((s) => s.sessionSkillIds)
  const syncSessionSkills = useSkillsStore((s) => s.syncSessionSkills)

  useEffect(() => {
    if (!workingDir) return
    void syncSessionSkills(workingDir)
  }, [workingDir, sessionSkillIds, syncSessionSkills, cloudRemote])

  const messages = currentSession?.messages || []
  const isCurrentSessionStreaming = streamingSessionIds.has(activeSessionId || '')
  const isEmpty = messages.length === 0

  const handleSend = async (
    content: string,
    attachments?: MessageAttachment[],
    taskMode?: TaskMode,
    skills?: MessageSkillSnapshot[]
  ) => {
    if (!sessionId) return false
    return sendMessage(content, attachments, taskMode, skills)
  }

  // 重试：先按 ZCode 的 retryTurn 语义「截断这一轮再原样重发」，而不是在原地叠一份重复提问。
  // 是否连带回滚文件由对话框里的复选框决定 —— 失败的那一轮可能已经写坏了文件。
  const lastUserMessage = useMemo<Message | undefined>(
    () => [...messages].reverse().find((m) => m.role === 'user'),
    [messages]
  )
  const [rewindRetry, setRewindRetry] = useState<{ sessionId: string; messageId: string } | null>(null)
  // 会话仍在运行 / 正在压缩 / 无用户消息时不提供重发，避免重复入队与并发发送
  const canRetry =
    !!lastUserMessage &&
    !isCurrentSessionStreaming &&
    !isCompacting &&
    !getSessionAbortController(sessionId)
  const handleRetry = useCallback(() => {
    if (!sessionId || !lastUserMessage || !canRetry) return
    if (isWebUIMode && !cloudRemote) {
      // 远程视图不做截断（撤回是本地专属动作），退化成原来的原地重发
      void sendMessage(lastUserMessage.content, lastUserMessage.attachments, lastUserMessage.taskMode, lastUserMessage.skills)
      return
    }
    setRewindRetry({ sessionId, messageId: lastUserMessage.id })
  }, [sessionId, lastUserMessage, canRetry, sendMessage, cloudRemote])

  /** 编辑重发：撤回成功后用既有的发送路径发出新文本（附件/任务档/技能沿用原那条） */
  const handleResend = useCallback((content: string, anchor: Message) => {
    void sendMessage(content, anchor.attachments, anchor.taskMode, anchor.skills)
  }, [sendMessage])

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

  // Remote history restores asynchronously. A temporary composer with an empty
  // or unbound session would lose an upload when the restored composer mounts.
  if (cloudRemote && (!initialized || !sessionId || !currentSession)) {
    return (
      <div role="status" aria-live="polite" aria-busy="true" className={`flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center ${vibe ? 'text-white/70' : 'text-dark-onSurfaceVariant'}`}>
        <Loader2 size={24} className="animate-spin text-md-primary motion-reduce:animate-none" aria-hidden />
        <p className="text-ui-sm font-medium">{t('remoteAccess.cloudLoadingWorkbench')}</p>
        <p className="max-w-sm text-ui-xs leading-relaxed opacity-75">{t('remoteAccess.cloudLoadingWorkbenchNote')}</p>
      </div>
    )
  }

  // 空态与消息态共用同一输入契约；欢迎区只提供已有功能的可发现入口。
  if (isEmpty) {
    return (
      <div aria-busy={!initialized} className={`relative flex min-h-0 flex-col h-full overflow-hidden ${vibe ? 'bg-transparent' : 'bg-dark-surface'}`}>
        <div className={`relative z-10 flex-1 min-h-0 overflow-y-auto ${vibe ? 'vibe-empty-layout' : ''}`}>
          <div className={`flex min-h-full flex-col items-center justify-center px-4 py-8 sm:px-8 sm:py-12 ${vibe ? 'vibe-empty-inner' : ''}`}>
            <div className={`w-full max-w-3xl ${vibe ? 'vibe-empty-content' : ''}`}>
              <div className={vibe ? 'vibe-empty-intro' : undefined}>
              {vibe && (
                <header className="vibe-welcome">
                  <span className="text-ui-xs font-medium tracking-widest text-white/50">ClerkBox · VIBE</span>
                  <h1 className="mt-4 text-ui-2xl font-medium tracking-tight text-white/90">{t('vibe.welcomeTitle')}</h1>
                  <p className="mt-3 max-w-md text-ui-sm leading-relaxed text-white/60">{t('vibe.welcomeDescription')}</p>
                </header>
              )}
              {!vibe && (
                <header className="mb-7 sm:mb-8">
                  <div className="mb-4 flex items-center gap-2.5">
                    <img src={NEW_CHAT_ICON} alt="" className="w-9 h-9 rounded-md3-md object-cover" />
                    <span className="text-ui-xs font-medium text-dark-onSurfaceVariant/60">{t('shell.welcomeEyebrow')}</span>
                  </div>
                  <h1 className="text-ui-2xl font-semibold tracking-tight text-dark-onSurface">
                    {t(interfaceMode === 'general' ? 'chat.emptyWelcomeGeneral' : 'chat.emptyWelcome')}
                  </h1>
                  <p className="mt-3 max-w-xl text-ui-sm leading-relaxed text-dark-onSurfaceVariant">
                    {t('shell.welcomeDescription')}
                  </p>
                </header>
              )}
              {!modelConfigured && <ModelSetupGuidance />}
              </div>
              <ChatInput key={`composer:${sessionId}`} sessionId={sessionId}
                  onSend={handleSend}
                  onStop={() => { void abort() }}
                  onManualCompact={manualCompact}
                  isCompacting={isCompacting}
                  isStopping={isStopping}
                  isStreaming={isCurrentSessionStreaming}
                  onSendNow={sendQueuedNow}
                  onEnqueueQueued={requestQueuedFlush}
                  variant={vibe ? 'default' : 'welcome'}
                  vibe={vibe}
                />
              {!vibe && (
                <>
                  <div className="mt-5 flex flex-wrap gap-3">
                    <button type="button" onClick={() => useUIStore.getState().setShowSkillStore(true)} className="md-focus group flex min-w-0 flex-1 basis-64 items-start gap-3 rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surface/60 p-4 text-left hover:bg-dark-surfaceContainer/60 hover:border-dark-onSurfaceVariant/20 transition-colors">
                      <Store size={17} className="mt-0.5 shrink-0 text-dark-onSurfaceVariant" aria-hidden="true" />
                      <span className="min-w-0 flex-1"><span className="block text-ui-sm font-medium text-dark-onSurface">{t('shell.browseSkills')}</span><span className="mt-1 block text-ui-xs leading-relaxed text-dark-onSurfaceVariant">{t('shell.browseSkillsDescription')}</span></span>
                      <ArrowUpRight size={14} className="mt-0.5 shrink-0 text-dark-onSurfaceVariant/40 group-hover:text-dark-onSurfaceVariant" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => useUIStore.getState().setCommandPaletteOpen(true)} className="md-focus group flex min-w-0 flex-1 basis-64 items-start gap-3 rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surface/60 p-4 text-left hover:bg-dark-surfaceContainer/60 hover:border-dark-onSurfaceVariant/20 transition-colors">
                      <Search size={17} className="mt-0.5 shrink-0 text-dark-onSurfaceVariant" aria-hidden="true" />
                      <span className="min-w-0 flex-1"><span className="block text-ui-sm font-medium text-dark-onSurface">{t('shell.viewHistory')}</span><span className="mt-1 block text-ui-xs leading-relaxed text-dark-onSurfaceVariant">{t('shell.viewHistoryDescription')}</span></span>
                      <ArrowUpRight size={14} className="mt-0.5 shrink-0 text-dark-onSurfaceVariant/40 group-hover:text-dark-onSurfaceVariant" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-ui-xs text-dark-onSurfaceVariant/60">
                    {modelConfigured && <span className="min-w-0 max-w-full truncate" title={modelLabel}>{t('shell.modelConfigured')} · {modelLabel}</span>}
                    <span className="flex min-w-0 max-w-full items-center gap-1.5" title={workingDir ? `${t('shell.workDirectory')} · ${workingDir}` : t('shell.autoDirectory')}><FolderOpen size={13} className="shrink-0" aria-hidden="true" /><span className="truncate">{workingDirLabel}</span></span>
                  </div>
                </>
              )}
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
      {/* overflow-clip：此列绝不可滚。若用 hidden/auto，MessageList 内层滚动内容的高度会
          穿透成列的 scrollHeight，列就变成滚动容器 —— 滚轮/选区自动滚动落在输入框上时，
          消息+输入框会作为刚体被一起卷走（看起来像输入框被拖走且停住）。 */}
      <div className="flex flex-1 flex-col min-h-0 min-w-0 overflow-clip">
        {/* 同级组件的 key 必须唯一；各自按会话重挂载，隔离滚动与输入状态。 */}
        <MessageList key={`messages:${sessionId}`} sessionId={sessionId} messages={messages} isStreaming={isCurrentSessionStreaming} vibe={vibe} onResend={handleResend} />
        <GoalBanner sessionId={sessionId} vibe={vibe} />
        <TodoListCard sessionId={sessionId} vibe={vibe} />
        <QuestionCard sessionId={sessionId} vibe={vibe} />
        <PermissionApprovalCard sessionId={sessionId} vibe={vibe} />
        {errorBanner}
        <ChatInput key={`composer:${sessionId}`} sessionId={sessionId} onSend={handleSend} onStop={() => { void abort() }} onManualCompact={manualCompact} isCompacting={isCompacting} isStopping={isStopping} isStreaming={isCurrentSessionStreaming} onSendNow={sendQueuedNow} onEnqueueQueued={requestQueuedFlush} vibe={vibe} />
      </div>
      {rewindRetry?.sessionId === sessionId && rewindRetry.messageId === lastUserMessage?.id && lastUserMessage && (
        <RewindDialog
          sessionId={sessionId}
          anchor={lastUserMessage}
          mode="retry"
          onClose={() => setRewindRetry(null)}
          onResend={handleResend}
        />
      )}
    </div>
  )
}
