import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bot, Loader2, CheckCircle, XCircle, Wrench, Brain } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAgentRunsStore } from '../../stores/agent-runs-store'
import type { Message, ToolCall, ToolResult } from '../../types/agent'

interface SubAgentDetailPanelProps {
  sessionId: string
  vibe?: boolean
}

// 工具调用条（轻量版，不依赖 chat-store）
function ToolCallBar({ tc, result, vibe }: { tc: ToolCall; result?: ToolResult; vibe?: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const isRunning = !result
  const isError = result?.isError
  const status = isRunning
    ? t('toolPreview.statusExecuting')
    : isError
      ? t('toolPreview.statusFailed')
      : t('toolPreview.statusComplete')

  const name = t(`tools.${tc.name}`, { defaultValue: tc.name })

  // 参数预览
  const argPreview = (() => {
    const a = tc.arguments
    if (tc.name === 'read_file' || tc.name === 'write_file' || tc.name === 'search_replace') return String(a.path || '')
    if (tc.name === 'execute_command') return String(a.command || '').slice(0, 60)
    if (tc.name === 'search_files' || tc.name === 'search_content') return String(a.pattern || a.query || '')
    if (tc.name === 'list_dir') return String(a.path || '')
    return JSON.stringify(a).slice(0, 60)
  })()

  return (
    <div className={`my-1 rounded border overflow-hidden ${vibe ? 'liquid-glass-subtle border-white/[0.03]' : 'border-dark-onSurfaceVariant/[0.03] bg-dark-surfaceContainer/40'}`}>
      <button
        type="button"
        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left ${vibe ? 'hover:bg-white/10' : 'hover:bg-md-primaryContainer/20'}`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={`sub-tc-detail-${tc.id}`}
        aria-label={t('toolPreview.toolCallStatus', { name, status })}
      >
        <Wrench className={`h-3 w-3 ${isRunning ? 'animate-pulse text-md-primary' : isError ? 'text-md-error' : 'text-md-success'}`} />
        <span className={`text-xs font-medium ${vibe ? 'text-white/90' : 'text-md-onSurface'}`}>{name}</span>
        <span className={`truncate text-xs ${vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}`}>{argPreview}</span>
        <span className="ml-auto text-xs">
          {isRunning ? <Loader2 className="h-3 w-3 animate-spin text-md-primary" /> : isError ? <XCircle className="h-3 w-3 text-md-error" /> : <CheckCircle className="h-3 w-3 text-md-success" />}
        </span>
      </button>
      {expanded && (
        <div id={`sub-tc-detail-${tc.id}`} className={`border-t px-2 py-1.5 ${vibe ? 'border-white/[0.03]' : 'border-dark-onSurfaceVariant/[0.03]'}`}>
          <div className={`text-[10px] ${vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}`}>{t('chat.toolParamsShort')}</div>
          <pre className={`mt-0.5 max-h-32 overflow-auto rounded p-1.5 text-[11px] ${vibe ? 'bg-black/30 text-white/90' : 'bg-dark-surfaceContainerHigh text-md-onSurface'}`}>{JSON.stringify(tc.arguments, null, 2)}</pre>
          {result && (
            <>
              <div className={`mt-1.5 text-[10px] ${vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}`}>{t('chat.toolResultShort')}</div>
              <pre className={`mt-0.5 max-h-48 overflow-auto rounded p-1.5 text-[11px] ${isError ? 'bg-md-error/10 text-md-error' : vibe ? 'bg-black/30 text-white/90' : 'bg-dark-surfaceContainerHigh text-md-onSurface'}`}>{result.content.slice(0, 2000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// 单条消息渲染（轻量版）
function SubAgentMessage({ msg, vibe }: { msg: Message; vibe?: boolean }) {
  const { t } = useTranslation()
  if (msg.role === 'user') {
    // 初始 prompt 不在这里显示（已在头部展示）
    return null
  }
  if (msg.role === 'tool') return null  // tool 消息内嵌在 ToolCallBar 中

  // assistant 消息
  const hasThinking = msg.thinkingContent && msg.thinkingContent.length > 0
  const hasContent = msg.content && msg.content.length > 0
  const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0

  // 流式占位
  if (msg._isStreaming && !hasContent && !hasThinking && !hasToolCalls) {
    return (
      <div className={`my-2 flex items-center gap-2 text-xs ${vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}`}>
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('chat.thinkingInProgress')}
      </div>
    )
  }

  return (
    <div className="my-2">
      {/* thinking */}
      {hasThinking && (
        <details className={`mb-1 rounded p-1.5 ${vibe ? 'bg-white/5' : 'bg-md-tertiary/5'}`}>
          <summary className="flex cursor-pointer items-center gap-1 text-[11px] text-md-tertiary">
            <Brain className="h-3 w-3" /> {t('chat.thinkingProcess')}
          </summary>
          <div className={`mt-1 whitespace-pre-wrap break-words text-[11px] ${vibe ? 'text-white/60' : 'text-md-tertiary/80'}`}>{msg.thinkingContent}</div>
        </details>
      )}
      {/* content */}
      {hasContent && (
        <div className={`whitespace-pre-wrap break-words text-xs ${vibe ? 'text-white/90' : 'text-md-onSurface'}`}>{msg.content}</div>
      )}
      {/* 流式工具调用预览 */}
      {msg.streamingToolCalls && msg.streamingToolCalls.length > 0 && (
        <div className={`my-1 text-[11px] ${vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}`}>
          {msg.streamingToolCalls.map((tc) => (
            <div key={tc.id} className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('chat.generatingToolCall', { name: tc.name })}
            </div>
          ))}
        </div>
      )}
      {/* 工具调用条 */}
      {hasToolCalls && msg.toolCalls!.map((tc) => {
        const result = msg.toolResults?.find((r) => r.toolCallId === tc.id)
        return <ToolCallBar key={tc.id} tc={tc} result={result} vibe={vibe} />
      })}
    </div>
  )
}

export function SubAgentDetailPanel({ sessionId, vibe }: SubAgentDetailPanelProps) {
  const { t } = useTranslation()
  // 精细化订阅：只拿需要的字段，避免每次 set 都触发面板重渲染
  const selectRun = useAgentRunsStore((s) => s.selectRun)
  const run = useAgentRunsStore((s) => {
    const id = s.selectedRunId
    if (!id) return null
    return (s.runsBySession[sessionId] || []).find((r) => r.id === id) || null
  })
  const [elapsed, setElapsed] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!run || run.status !== 'running') {
      setElapsed(0)
      return
    }
    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - run.startedAt) / 1000))
    }
    updateElapsed()
    const timer = setInterval(updateElapsed, 1000)
    return () => clearInterval(timer)
  }, [run?.status, run?.startedAt])

  // Escape 关闭面板 + 打开时焦点移入。
  // 依赖 run?.id 而非 run 引用，避免流式期间每 50ms 重新挂载/卸载 keydown 监听器
  useEffect(() => {
    if (!run) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    if (panel) {
      // 聚焦面板使其可接收键盘事件
      panel.focus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        selectRun(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previousFocus?.focus()
    }
  }, [run?.id, selectRun])

  if (!run) return null

  const statusConfig = ({
    running: { icon: <Loader2 className="h-4 w-4 animate-spin text-md-primary" />, label: t('common.running'), class: 'text-md-primary' },
    completed: { icon: <CheckCircle className="h-4 w-4 text-md-success" />, label: t('common.complete'), class: 'text-md-success' },
    failed: { icon: <XCircle className="h-4 w-4 text-md-error" />, label: t('common.failed'), class: 'text-md-error' },
    aborted: { icon: <XCircle className="h-4 w-4 text-md-onSurfaceVariant" />, label: t('common.aborted'), class: 'text-md-onSurfaceVariant' },
  } as const)[run.status] || { icon: <Loader2 className="h-4 w-4 animate-spin text-md-onSurfaceVariant" />, label: t('common.unknown'), class: 'text-md-onSurfaceVariant' }

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="complementary"
      aria-label={t('chat.subAgentDetailAria', { name: run.agentName })}
      className={`absolute inset-0 z-30 flex h-full w-full max-w-none flex-col border-l focus:outline-none sm:static sm:z-auto sm:w-[min(480px,40vw)] sm:min-w-[320px] sm:max-w-[480px] ${vibe ? 'liquid-glass-strong border-white/20' : 'border-md-outlineVariant/30 bg-dark-surfaceContainer'}`}
    >
      {/* 头部 */}
      <div className={`flex items-center gap-2 border-b px-3 py-2 ${vibe ? 'border-white/10' : 'border-md-outlineVariant/30'}`}>
        <button
          type="button"
          className={`rounded p-1 ${vibe ? 'hover:bg-white/10' : 'hover:bg-md-primaryContainer/20'}`}
          onClick={() => selectRun(null)}
          title={t('chat.closePanelTitle')}
          aria-label={t('chat.closePanelAria')}
        >
          <ArrowLeft className={`h-4 w-4 ${vibe ? 'text-white/60' : 'text-md-onSurfaceVariant'}`} />
        </button>
        <Bot className="h-4 w-4 text-md-primary" />
        <span className={`min-w-0 truncate text-sm font-medium ${vibe ? 'text-white/90' : 'text-md-onSurface'}`}>{run.agentName}</span>
        <span className="shrink-0 rounded bg-md-primaryContainer/30 px-1.5 py-0.5 text-[10px] text-md-primary">{run.agentType}</span>
      </div>

      {/* 任务摘要 */}
      <div className={`border-b px-3 py-2 ${vibe ? 'border-white/10' : 'border-md-outlineVariant/30'}`}>
        <div className={`text-[10px] ${vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}`}>{t('chat.subAgentTask')}</div>
        <div className={`mt-0.5 whitespace-pre-wrap break-words text-xs ${vibe ? 'text-white/90' : 'text-md-onSurface'}`}>{run.prompt}</div>
        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          {statusConfig.icon}
          <span className={statusConfig.class}>{statusConfig.label}</span>
          {run.status === 'running' && elapsed > 0 && <span className={vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}>{elapsed}s</span>}
          {run.status === 'completed' && run.result && (
            <span className={vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}>· {t('chat.subAgentCharResult', { count: (run.result.length / 1000).toFixed(1) })}</span>
          )}
        </div>
        {run.status === 'failed' && run.error && (
          <div className="mt-1 whitespace-pre-wrap break-words rounded bg-md-error/10 p-1.5 text-[11px] text-md-error">{run.error}</div>
        )}
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {run.messages.length === 0 ? (
          <div className={`text-center text-xs ${vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}`}>{t('chat.subAgentNoMessages')}</div>
        ) : (
          run.messages.map((msg) => <SubAgentMessage key={msg.id} msg={msg} vibe={vibe} />)
        )}
      </div>

      {/* 最终结果 */}
      {run.status === 'completed' && run.result && (
        <div className={`border-t px-3 py-2 ${vibe ? 'border-white/10' : 'border-md-outlineVariant/30'}`}>
          <div className={`text-[10px] ${vibe ? 'text-white/50' : 'text-md-onSurfaceVariant'}`}>{t('chat.subAgentFinalResult')}</div>
          <div className={`mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded p-1.5 text-xs ${vibe ? 'bg-white/5 text-white/90' : 'bg-md-success/5 text-md-onSurface'}`}>{run.result.slice(0, 1000)}{run.result.length > 1000 && '...'}</div>
        </div>
      )}
    </div>
  )
}
