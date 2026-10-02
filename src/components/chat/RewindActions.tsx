/**
 * 最后一轮上的 编辑 / 撤回 / 撤销本轮文件改动 入口（对标 ZCode v4 的 UI 动作面）。
 *
 * 三个动作都只作用于**最后一轮**，这是刻意收窄而不是省事：
 * 任意历史消息的 time-travel 需要 append-only 分支模型（ZCode 有，本项目没有），
 * 物理截断做半成品会留下「删了中间一轮、后面却还引用着它」的断裂对话。
 * ZCode 在服务端硬校验同一件事：editUserQuery 只能落在最后一轮 real user query。
 * 渲染的是图标按钮，并且**由 MessageItem 的动作条承载**：与「复制」同一行、同一尺寸、
 * 同一套 hover 规则，否则一条消息下面会长出两排样式不同的按钮。
 */
import { useMemo, useState } from 'react'
import { Pencil, RotateCcw, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isWebUIMode } from '../../lib/ipc-client'
import { MessageActionButton } from './MessageActions'
import RewindDialog, { fileRewindState, type RewindMode } from './RewindDialog'
import type { Message } from '../../types/agent'

interface RewindActionsProps {
  sessionId: string
  /** 本轮的锚点用户消息 */
  anchor: Message
  /** 这一轮是不是最后一条可撤回的用户消息（由 MessageList 统一判定，别在两处各算一遍） */
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

  // WebUI 远程视图不给这三个动作：撤回要删本机文件、截断本机对话，能力面本来就不在远程。
  // 压缩边界/子 agent 卡片等合成出来的「类用户消息」也不能当锚点（与 rewind.isRewindableUserMessage 同一条判断）。
  const canUse =
    canRewindAnchor &&
    !isStreaming &&
    !isWebUIMode &&
    anchor.role === 'user' &&
    !anchor.isCompactSummary &&
    !anchor.isCompactAttachment &&
    !anchor.isRewindNotice &&
    !anchor.subAgentId &&
    !anchor.isSubAgentCard

  const buttons = useMemo(
    () => (
      <>
        <MessageActionButton
          icon={<Pencil size={12} />}
          label={t('chat.rewind.edit')}
          onClick={() => setMode('edit')}
          vibe={vibe}
        />
        <MessageActionButton
          icon={<RotateCcw size={12} />}
          label={t('chat.rewind.recall')}
          onClick={() => setMode('recall')}
          vibe={vibe}
        />
        {/* 「本轮没有文件改动」「已经撤销过」「有无法证明的改动」都不给这个入口：
            前两者点了是空动作，后者点开了也只能拒绝，说明放在撤回框里 */}
        {files.reason === 'available' && (
          <MessageActionButton
            icon={<Undo2 size={12} />}
            label={t('chat.rewind.undoFiles')}
            onClick={() => setMode('files')}
            vibe={vibe}
          />
        )}
      </>
    ),
    [t, vibe, files.reason]
  )

  if (!canUse) return null

  return (
    <>
      {buttons}
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
