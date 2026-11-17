/**
 * 真实用户消息上的撤回入口；编辑重发和仅撤销文件仍限定最后一轮。
 * 撤回会删除所选消息及其之后的整段历史，范围由确认框预览。
 * 渲染的是图标按钮，并且**由 MessageItem 的动作条承载**：与「复制」同一行、同一尺寸、
 * 同一套 hover 规则，否则一条消息下面会长出两排样式不同的按钮。
 */
import { useState } from 'react'
import { Pencil, RotateCcw, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isWebUIMode } from '../../lib/ipc-client'
import { isCloudRemoteMode } from '../../remote/browser'
import { isRewindableUserMessage } from '../../lib/rewind'
import { useChatStore } from '../../stores/chat-store'
import { MessageActionButton } from './MessageActions'
import RewindDialog, { fileRewindState, type RewindMode } from './RewindDialog'
import type { Message } from '../../types/agent'

interface RewindActionsProps {
  sessionId: string
  /** 本轮的锚点用户消息 */
  anchor: Message
  /** 仅编辑重发 / 仅撤销文件需要最后一轮；历史消息也可以撤回。 */
  canRewindAnchor: boolean
  isStreaming: boolean
  vibe?: boolean
  /** 编辑重发：撤回成功后由 ChatPage 用既有的 sendMessage 发新文本（不新造发送路径） */
  onResend: (content: string, anchor: Message) => void
}

export default function RewindActions({
  sessionId,
  anchor,
  canRewindAnchor,
  isStreaming,
  vibe = false,
  onResend,
}: RewindActionsProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<RewindMode | null>(null)
  const files = fileRewindState(anchor)
  const streaming = useChatStore((s) => s.streamingSessionIds.has(sessionId))
  const compacting = useChatStore((s) => s.compactingSessionIds.has(sessionId))
  const stopping = useChatStore((s) => s.stoppingSessionIds.has(sessionId))
  const submitting = useChatStore((s) => !!s.draftSubmitting[sessionId])
  const rewinding = useChatStore((s) => s.rewindingSessionIds.has(sessionId))
  const queued = useChatStore((s) => !!s.queuedMessages[sessionId]?.length)
  const disabledReason = rewinding ? t('chat.rewind.busy.rewinding')
    : submitting ? t('chat.rewind.busy.submitting')
    : compacting ? t('chat.rewind.busy.compacting')
    : isStreaming || streaming || stopping ? t('chat.rewind.busy.running')
    : queued ? t('chat.rewind.busy.queued')
    : undefined

  // The paired host validates and serializes rewinds; plain LAN clients lack that grant.
  if ((isWebUIMode && !isCloudRemoteMode()) || !isRewindableUserMessage(anchor)) return null

  return (
    <>
      {canRewindAnchor && (
        <MessageActionButton
          icon={<Pencil size={12} />}
          label={t('chat.rewind.edit')}
          onClick={() => setMode('edit')}
          disabled={!!disabledReason}
          disabledReason={disabledReason}
          vibe={vibe}
        />
      )}
      <MessageActionButton
        icon={<RotateCcw size={12} />}
        label={t('chat.rewind.recall')}
        onClick={() => setMode('recall')}
        disabled={!!disabledReason}
        disabledReason={disabledReason}
        vibe={vibe}
      />
      {/* 文件单独撤销仍只作用于最后一轮；不具备快照时在撤回框中说明原因。 */}
      {canRewindAnchor && files.reason === 'available' && (
        <MessageActionButton
          icon={<Undo2 size={12} />}
          label={t('chat.rewind.undoFiles')}
          onClick={() => setMode('files')}
          disabled={!!disabledReason}
          disabledReason={disabledReason}
          vibe={vibe}
        />
      )}
      {mode && (
        <RewindDialog
          sessionId={sessionId}
          anchor={anchor}
          mode={mode}
          onClose={() => setMode(null)}
          onResend={mode === 'edit' ? onResend : undefined}
        />
      )}
    </>
  )
}
