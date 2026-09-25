/**
 * useAgent：渲染层宿主的端口装配器（批次 B · P1）
 *
 * ReAct 编排逻辑已抽至 src/agent-core/loop.ts（进程无关）。
 * 本文件只负责：React 状态、store 订阅、把 zustand store / api-transport /
 * toolRegistry / QuestionCard 回调接成 AgentPorts，然后驱动 runReactLoop。
 * 导出面（sendMessage/abort/manualCompact/isCompacting/error/sendQueuedNow/
 * requestQueuedFlush）与抽核前保持不变。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../stores/settings-store'
import { useChatStore, getSessionAbortController, setSessionAbortController, type QueuedMessageItem } from '../stores/chat-store'
import { useTokenUsageStore } from '../stores/token-usage-store'
import { useSkillsStore } from '../stores/skills-store'
import { toolRegistry } from '../lib/tool-registry'
import { ipc } from '../lib/ipc-client'
import { buildMemoryPrompt } from '../lib/memory'
import { compactConversation, findKeepBoundaryIndex } from '../lib/compact'
import { computeContextUsage, getApiVisibleMessages, type ContextUsageInfo } from '../lib/context-usage'
import { estimateTokensForText } from '../lib/token-estimate'
import { SYSTEM_PROMPT } from '../lib/prompts'
import { findAgent } from '../lib/agent-registry'
import { useAgentRunsStore } from '../stores/agent-runs-store'
import { useShallow } from 'zustand/react/shallow'
import { notifyIfNotViewing } from '../lib/notify'
import { openChatStream } from '../lib/api-transport'
import { requiresApiKey } from '../lib/provider-catalog'
import i18n from '../i18n'
import type { Message, MessageAttachment, MessageSkillSnapshot, TaskMode } from '../types/agent'
import { useInteractiveStore, useTodoStore } from '../stores/interactive-store'
import { useGoalStore } from '../stores/goal-store'
import { buildRelevantSkillReminder } from '../lib/skill-matcher'
import { makeId, runReactLoop } from '../agent-core/loop'
import { SessionContextStore } from '../agent-core/session-context'
import type { AgentPorts } from '../agent-core/ports'

/** 会话级 Agent 能力注册表：供 TitleBar 等 hook 外部组件调用当前会话的手动压缩 / 用量统计 */
export interface SessionAgentEntry {
  manualCompact: (instructions?: string) => Promise<void>
  getUsage: (messages: Message[]) => ContextUsageInfo
}
const sessionAgentRegistry = new Map<string, SessionAgentEntry>()
export function getSessionAgent(sessionId: string | null | undefined): SessionAgentEntry | undefined {
  return sessionId ? sessionAgentRegistry.get(sessionId) : undefined
}

/** 渲染进程可得的系统环境信息（OS 版本从 userAgent 提取，避免新增 IPC） */
function getOsDescription(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const win = /Windows NT ([\d.]+)/.exec(ua)
  if (win) {
    const nt = win[1]
    const version = nt === '10.0' ? '10/11' : nt
    return `Windows ${version}`
  }
  const mac = /Mac OS X ([\d_.]+)/.exec(ua)
  if (mac) return `macOS ${mac[1].replace(/_/g, '.')}`
  if (/Linux/.test(ua)) return 'Linux'
  return navigator.platform || 'unknown'
}

/** 平台感知的可用 shell 描述（与 prompts.ts 的 Shell selection 段口径一致） */
function getShellDescription(): string {
  const platform = window.clerkbox?.platform
  if (platform === 'darwin') return 'zsh, bash'
  if (platform === 'linux') return 'bash, sh'
  return 'cmd.exe, PowerShell'
}

export function useAgent(sessionId: string) {
  // Agent 只订阅请求构造和上下文预算所需的设置，减少设置页/主题等变化带来的重建。
  const settings = useSettingsStore(useShallow((s) => ({
    model: s.model,
    apiCompat: s.apiCompat,
    activeProviderId: s.activeProviderId,
    activeModelId: s.activeModelId,
    providers: s.providers,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    reasoningEffort: s.reasoningEffort,
    enableThinking: s.enableThinking,
    thinkingBudget: s.thinkingBudget,
    approvalMode: s.approvalMode,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    directFetch: s.directFetch,
    maxInputTokens: s.maxInputTokens,
    agentsMdEnabled: s.agentsMdEnabled,
    claudeMdCompat: s.claudeMdCompat,
  })))
  // store 动作是稳定引用，逐个 selector 订阅：避免整店订阅导致聊天流式期间
  // （chat-store 每 ~50ms 变更一次）本 hook 及挂载它的 ChatPage 整树重渲染。
  const addMessage = useChatStore((s) => s.addMessage)
  const updateMessage = useChatStore((s) => s.updateMessage)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const compactSession = useChatStore((s) => s.compactSession)
  const setSessionStatus = useChatStore((s) => s.setSessionStatus)
  // 「本次运行」状态按 sessionId 隔离（per-session 并发）：多会话同时跑 ReAct 循环时，
  // 后台会话的 run 仍持有自己的 SessionContext（token 锚点/读取快照/任务模式）。
  const contextsRef = useRef(new SessionContextStore())
  const [error, setError] = useState<string | null>(null)
  /** 手动压缩进行中（/压缩 命令）：输入栏即时反馈 + 锁定，防止压缩期间并发发送 */
  const [isCompacting, setIsCompacting] = useState(false)
  const isCompactingRef = useRef(false)

  /** 端口装配：把渲染层的 store / IPC / 工具注册表接成 agent-core 的依赖束。
   *  settings 是本次渲染的快照（与旧实现的闭包捕获语义一致）。 */
  const makePorts = useCallback((): AgentPorts => ({
    sessionId,
    settings,
    model: {
      stream: (body, signal) => openChatStream(
        {
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          apiCompat: settings.apiCompat || 'openai',
          directFetch: settings.directFetch,
        },
        body,
        signal
      ),
    },
    tools: {
      definitions: (harnessMode) => toolRegistry.getDefinitionsForMode(harnessMode),
      execute: (name, args, ctx) => toolRegistry.execute(name, args, ctx),
      findAgent: (agentType, workingDir) => findAgent(agentType, workingDir),
    },
    store: {
      getSession: (sid) => useChatStore.getState().sessions.find((s) => s.id === sid),
      addMessage: (sid, msg) => useChatStore.getState().addMessage(sid, msg),
      updateMessage: (sid, msgId, updates) => useChatStore.getState().updateMessage(sid, msgId, updates),
      setStatus: (sid, status) => useChatStore.getState().setSessionStatus(sid, status),
      compact: (sid, messages, boundaryMessageId) => useChatStore.getState().compactSession(sid, messages, boundaryMessageId),
    },
    permission: {
      confirm: (title, body) => ipc.confirmDialog(title, body),
    },
    ui: {
      askQuestion: (sid, questions) => useInteractiveStore.getState().requestQuestion(sid, questions),
      setTodos: (sid, items) => useTodoStore.getState().setTodos(sid, items),
      notify: (sid, kind, message) => notifyIfNotViewing(sid, kind, message),
      recordUsage: (entry) => useTokenUsageStore.getState().recordUsage(entry),
      agentMemoryCapture: async (payload) => { await ipc.agentMemoryCapture(payload) },
      addSubAgentRun: (sid, run) => useAgentRunsStore.getState().addSubAgentRun(sid, run),
      appendSubAgentMessage: (sid, runId, msg) => useAgentRunsStore.getState().appendSubAgentMessage(sid, runId, msg),
      updateSubAgentMessage: (sid, runId, msgId, updates) => useAgentRunsStore.getState().updateSubAgentMessage(sid, runId, msgId, updates),
      completeSubAgentRun: (sid, runId, result) => useAgentRunsStore.getState().completeSubAgentRun(sid, runId, result),
      abortSubAgentRun: (sid, runId) => useAgentRunsStore.getState().abortSubAgentRun(sid, runId),
      failSubAgentRun: (sid, runId, errMsg) => useAgentRunsStore.getState().failSubAgentRun(sid, runId, errMsg),
    },
    goal: {
      get: (sid) => useGoalStore.getState().bySession[sid],
      setGoal: (sid, condition) => useGoalStore.getState().setGoal(sid, condition),
      updateGoal: (sid, patch) => useGoalStore.getState().updateGoal(sid, patch),
    },
    skills: {
      catalog: () => useSkillsStore.getState().getSkillCatalog(),
    },
    env: {
      platform: navigator.platform || 'unknown',
      osDescription: getOsDescription(),
      shellDescription: getShellDescription(),
      homeDir: () => ipc.homeDir(),
      readFile: (path) => ipc.readFile(path),
      runShell: (command, cwd) => ipc.executeCommandWithShell(command, cwd, 'cmd'),
      buildMemoryPrompt: (workingDir, homeDir) => buildMemoryPrompt(workingDir, homeDir),
    },
    emit: () => { /* P1 渲染层宿主直写 store；P3 起接 'agent:event' 通道 */ },
  }), [sessionId, settings])

  /** Main send message function with full ReAct loop.
   *  返回 true 表示运行真正开始（排队消息 flush 据此决定是否放回队首）。 */
  const sendMessage = useCallback(
    async (content: string, attachments?: MessageAttachment[], taskMode?: TaskMode, skills?: MessageSkillSnapshot[]): Promise<boolean> => {
      // Prevent concurrent sends on the same session（per-session 粒度，不阻塞其他会话并发）
      if (getSessionAbortController(sessionId)) {
        setError(i18n.t('agent.busy'))
        return false
      }

      if (!settings.baseUrl) {
        setError(i18n.t('agent.needBaseUrl'))
        return false
      }
      // 本地部署（Ollama / LM Studio 等）无需 Key，不能在这里一刀切拦掉
      const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
      if (!settings.apiKey && requiresApiKey(settings.baseUrl, activeProvider?.presetId)) {
        setError(i18n.t('agent.needApiKey'))
        return false
      }

      setError(null)
      setStreaming(true, sessionId)
      // 标记 per-session 工作状态（侧边栏 loading 圈依据此显示）
      setSessionStatus(sessionId, 'working')

      const controller = new AbortController()
      setSessionAbortController(sessionId, controller)
      const ctx = contextsRef.current.get(sessionId)
      const currentSession = useChatStore.getState().sessions.find((s) => s.id === sessionId)
      ctx.requestWorkingDir = currentSession?.workingDir || currentSession?.defaultWorkDir || ''
      // 记录本次运行的任务工作流模式（/spec /plan /goal；工具权限检查与提示词注入都会读取）。
      // /goal 是会话级目标：设定后跨消息持续生效，后续普通消息也按 goal 模式注入语境。
      if (taskMode === 'goal' && content.trim()) {
        useGoalStore.getState().setGoal(sessionId, content.trim())
      }
      const goalActive = useGoalStore.getState().bySession[sessionId]?.status === 'active'
      ctx.activeTaskMode = taskMode ?? (goalActive ? 'goal' : null)
      // 记录是否是用户主动 abort，用于决定是否发"异常停下"通知
      let abortedByUser = false

      // Add user message
      const userMsg: Message = {
        id: makeId(),
        role: 'user',
        content,
        timestamp: Date.now(),
        // 附件随消息入内存 + 持久化（仅在非空时携带）
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        // 任务工作流随消息记录（气泡内展示 + 重启后可见）
        ...(taskMode ? { taskMode } : {}),
        ...(skills && skills.length > 0 ? { skills } : {}),
      }
      addMessage(sessionId, userMsg)

      // Get all messages for context.
      // addMessage 已同步把 userMsg 追加进会话，session.messages 里已包含它；
      // 旧实现再拼一次 userMsg，导致每次 API 请求体带两份重复用户消息（token 双花）。
      const chatStore = useChatStore.getState()
      const session = chatStore.sessions.find((s) => s.id === sessionId)
      const contextMessages = session?.messages ?? [userMsg]

      // 相关技能提醒：按本条消息内容对全部已安装技能做词面匹配（命中才注入，
      // 未命中不注入任何内容）。与用户手动激活（skills 快照）互补。
      const skillReminder = buildRelevantSkillReminder(content, useSkillsStore.getState().getSkillCatalog()) ?? undefined

      try {
        await runReactLoop(makePorts(), ctx, contextMessages, controller, taskMode, skillReminder)
      } catch (err) {
        if (controller.signal.aborted) {
          abortedByUser = true
          return false
        }
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        addMessage(sessionId, {
          id: makeId(),
          role: 'assistant',
          content: i18n.t('agent.sendFailed', { message: msg }),
          timestamp: Date.now(),
        })
        // 标记 error 状态 + 系统通知（仅当用户不在此会话时）
        setSessionStatus(sessionId, 'error')
        notifyIfNotViewing(sessionId, 'error', msg.slice(0, 200))
        return false
      } finally {
        ctx.requestWorkingDir = undefined
        ctx.activeTaskMode = null
        // Do not clear a controller installed by a newer request for this session.
        if (getSessionAbortController(sessionId) === controller) {
          setSessionAbortController(sessionId, null)
        }
        // 仅清当前会话的 streaming 状态，不影响其他并发会话
        useChatStore.getState().setStreaming(false, sessionId)
        // 用户主动 abort：直接清状态，不发通知
        if (abortedByUser) {
          setSessionStatus(sessionId, null)
        } else {
          // 正常完成或异常：若状态仍是 working（说明没被 catch 标成 error），发"完成"通知
          const cur = useChatStore.getState().sessionStatus[sessionId]
          if (cur === 'working') {
            setSessionStatus(sessionId, null)
            notifyIfNotViewing(sessionId, 'done')
          }
          // 若是 error，catch 块已发通知，这里不再重复
          // 排队消息自动发送：仅正常完成时触发（用户中断/出错时队列保留，
          // 避免停不下来或错误循环）；error 状态时上方 if 未命中，不会走到这里
          if (useChatStore.getState().sessionStatus[sessionId] !== 'error') {
            scheduleQueuedFlush()
          }
        }
      }
      return true
    },
    [sessionId, settings, makePorts, addMessage, updateMessage, setStreaming, setSessionStatus]
  )

  // ── 排队消息：AI 运行中用户发送 → 输入框上方组件 → run 正常结束后 FIFO 逐条自动发出 ──
  // flush 直接闭包引用 sendMessage（deps 含 sessionId）：闭包内 sessionId 与 sendMessage
  // 的目标会话天然一致。不能用"最新渲染实例"的 ref——后台会话的 run 收尾触发 flush 时，
  // hook 的 sessionId 可能已切走，ref 方案会把 A 会话的排队消息发进 B 会话。

  /** 稍后尝试发出队首排队消息。守卫不满足时静默跳过，由对应的收尾点再次触发：
   *  - run 进行中 → 该 run 正常结束的 finally 再触发
   *  - 压缩进行中 → manualCompact 的 finally 再触发
   *  - 会话已删除 / 队列已空 → 无事发生 */
  const scheduleQueuedFlush = useCallback((delayMs = 150) => {
    window.setTimeout(() => {
      const state = useChatStore.getState()
      if (!state.sessions.some((s) => s.id === sessionId)) return
      if (state.streamingSessionIds.has(sessionId)) return
      if (getSessionAbortController(sessionId)) return
      if (isCompactingRef.current) return
      const next = state.dequeueQueuedMessage(sessionId)
      if (!next) return
      void sendMessage(next.content, next.attachments, next.taskMode ?? undefined, next.skills).then((ok) => {
        // 发送未真正开始（配置缺失等入口守卫拦截）：放回队首等下次触发，不丢消息
        if (!ok) useChatStore.getState().requeueQueuedMessage(sessionId, next)
      })
    }, delayMs)
  }, [sessionId, sendMessage])

  /** 立即发送排队消息：中断当前运行 → 等待旧 run 收尾释放 → 移出队列 → 立即发送。
   *  剩余排队消息由新 run 正常结束后的自动 flush 继续 FIFO 逐条发出。 */
  const sendQueuedNow = useCallback(
    async (item: QueuedMessageItem) => {
      const ctrl = getSessionAbortController(sessionId)
      if (ctrl) {
        try {
          ctrl.abort()
        } catch {
          /* ignore */
        }
        // 等旧 run 收尾释放 controller（abort 后流式立刻抛错，通常 <300ms；5s 兜底）
        for (let i = 0; i < 100; i++) {
          if (!getSessionAbortController(sessionId)) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      // 手动压缩中：等压缩收尾（压缩不占 controller；30s 兜底防极端挂死）
      for (let i = 0; i < 300; i++) {
        if (!isCompactingRef.current) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      useChatStore.getState().removeQueuedMessage(sessionId, item.id)
      await sendMessage(item.content, item.attachments, item.taskMode ?? undefined, item.skills)
    },
    [sessionId, sendMessage]
  )

  /** 手动压缩上下文（/压缩 命令触发）：
   *  编排与 reactLoop 内的自动压缩完全一致（占位提示 → compactConversation → 双消息数组 → 原子持久化 → 重置计数），
   *  仅两处差异：trigger 标记为 'manual'、支持可选自定义指令（留空则行为等同自动压缩）。 */
  const manualCompact = useCallback(
    async (customInstructions?: string) => {
      // 重入防护 + Agent 运行中忽略（避免与 ReAct 循环中途的消息状态冲突）
      if (isCompactingRef.current || getSessionAbortController(sessionId)) return
      if (!settings.baseUrl) {
        setError(i18n.t('agent.needBaseUrl'))
        return
      }
      const activeProvider = settings.providers.find((p) => p.id === settings.activeProviderId)
      if (!settings.apiKey && requiresApiKey(settings.baseUrl, activeProvider?.presetId)) {
        setError(i18n.t('agent.needApiKey'))
        return
      }

      const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
      const conversationMessages = session?.messages ?? []
      if (conversationMessages.length === 0) return

      const ctx = contextsRef.current.get(sessionId)
      setError(null)
      isCompactingRef.current = true
      setIsCompacting(true)

      // ── 压缩过程展示：插入"正在压缩上下文"占位消息（同自动压缩路径） ──
      const compactingId = makeId()
      addMessage(sessionId, {
        id: compactingId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        _isCompacting: true,
      })
      try {
        const compactionResult = await compactConversation(
          conversationMessages,
          settings,
          ctx.readFiles,
          customInstructions?.trim() || undefined,
          'manual'
        )
        // Recompute the keep boundary (same logic as inside compactConversation)
        const keepStartIndex = findKeepBoundaryIndex(conversationMessages)
        const keptMessages = conversationMessages.slice(keepStartIndex)
        // 被压缩的历史消息（压缩点之前）——用户仍要在界面上看到它们，故保留但不发给 API
        const summarizedMessages = conversationMessages.slice(0, keepStartIndex)

        // 界面/DB 消息：完整保留全部历史，压缩组件（边界 + 摘要）插在压缩点位置。
        // 手动压缩不接续对话循环，无需构建 API 子集。
        const newMessages = [
          ...summarizedMessages,
          compactionResult.boundaryMessage,
          compactionResult.summaryMessage,
          ...keptMessages,
          ...compactionResult.fileAttachments,
        ]

        // Sync to store and DB（保留全部历史）
        compactSession(sessionId, newMessages, compactionResult.boundaryMessage.id)

        // Clear the read file state (it's now in file attachments)
        ctx.readFiles = new Map()
        // Reset the token tracker after compaction so stale usage cannot retrigger auto-compact.
        ctx.tokenTracker.reset()

        console.log(`[compact] Manually compacted: ${compactionResult.preCompactTokenCount} → ${compactionResult.postCompactTokenCount} tokens, ${compactionResult.boundaryMessage.compactMetadata?.messagesSummarized} messages summarized`)
      } catch (err) {
        console.error('[compact] Manual compaction failed:', err)
        // 失败：把"正在压缩"占位消息改为可见提示，避免残留空白占位
        updateMessage(sessionId, compactingId, {
          content: i18n.t('chat.compactFailed'),
          _isCompacting: false,
        })
      } finally {
        isCompactingRef.current = false
        setIsCompacting(false)
        // 压缩期间入队的排队消息：压缩完成后（无论成败）继续自动发送
        scheduleQueuedFlush()
      }
    },
    [sessionId, settings, addMessage, updateMessage, compactSession]
  )

  /** 上下文用量统计（TitleBar 环形指示器面板）：
   *  总量与自动压缩判定同源（tokenTracker.getTokenCount），预算与阈值口径同 reactLoop 的 autoCompactThreshold。
   *  注意：先过滤为 API 实际发送的消息子集，压缩后旧历史不计入总量/细分。 */
  const getContextUsage = useCallback(
    (messages: Message[]): ContextUsageInfo => {
      const budget = settings.providers
        .find((p) => p.id === settings.activeProviderId)
        ?.models.find((x) => x.id === settings.activeModelId)?.maxInputTokens
        ?? settings.maxInputTokens ?? 184000
      // API 实际发送的消息子集（摘要 + 边界之后的消息）
      const apiMessages = getApiVisibleMessages(messages)
      // 空会话（无可发送消息）强制为 0：残留 lastUsage 会让空会话的指示器
      // 凭空显示上一场对话的用量弧
      const ctx = contextsRef.current.get(sessionId)
      const total = apiMessages.length === 0 ? 0 : ctx.tokenTracker.getTokenCount(apiMessages)
      return computeContextUsage(apiMessages, total, budget, estimateTokensForText(SYSTEM_PROMPT))
    },
    [settings, sessionId] // contextsRef 闭包依赖 sessionId
  )

  // per-session context：切换会话无需清空（各会话各自持有锚点）；
  // 仅顺带清理已删除会话的残留 context，避免 Map 无限增长。
  useEffect(() => {
    const { sessions } = useChatStore.getState()
    for (const id of contextsRef.current.sessionIds()) {
      if (!sessions.some((s) => s.id === id)) contextsRef.current.delete(id)
    }
  }, [sessionId])

  // 注册到模块级注册表（切换会话/卸载时清理），供 TitleBar 的上下文用量面板调用
  useEffect(() => {
    sessionAgentRegistry.set(sessionId, { manualCompact, getUsage: getContextUsage })
    return () => { sessionAgentRegistry.delete(sessionId) }
  }, [sessionId, manualCompact, getContextUsage])

  const abort = useCallback(() => {
    // per-session abort：只中止当前会话的 controller，不影响其他并发会话
    const ctrl = getSessionAbortController(sessionId)
    if (ctrl) {
      ctrl.abort()
    }
    // 杀掉该会话在主进程里还在跑的 shell 子进程，让阻塞中的 execute_command 立即返回
    if (sessionId) {
      void ipc.cancelSessionCommands(sessionId).catch(() => { /* ignore */ })
    }
    // 仅清当前会话的 streaming 状态
    useChatStore.getState().setStreaming(false, sessionId)
    // 用户主动 abort：清当前会话工作状态，不发通知
    if (sessionId) {
      useChatStore.getState().setSessionStatus(sessionId, null)
      useInteractiveStore.getState().cancelQuestion(sessionId)
    }
  }, [sessionId])

  return { sendMessage, abort, manualCompact, isCompacting, error, sendQueuedNow, requestQueuedFlush: scheduleQueuedFlush }
}
