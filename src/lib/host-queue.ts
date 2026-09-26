/**
 * 排队队列的宿主同步（批次 B · P4 补）。
 *
 * 宿主模式下队列的真源在主进程 AgentHost：它每次变更都广播 queue.snapshot 整段覆盖
 * 渲染层队列。渲染层若只改本地就会长出两种分脑——界面上删掉的条目宿主照样发出去，
 * 宿主一次广播又让本地仅存的排队条目凭空消失。所以三个动作（入队/删除/立即发送）
 * 必须成对下发。renderer 模式下这些调用整体跳过，不改本地路径的任何行为。
 */
import { agentClient } from './agent-client'
import type { AgentCommand } from '../agent-core/protocol'
import type { QueuedMessageItem } from '../stores/chat-store'

async function dispatch(cmd: AgentCommand): Promise<void> {
  if ((await agentClient.ensureMode()) !== 'main') return
  const res = await agentClient.send(cmd)
  if (!res.ok) console.warn(`[host-queue] ${cmd.type} 未被受理:`, res.error)
}

export const hostQueue = {
  enqueue: (sessionId: string, item: QueuedMessageItem): Promise<void> =>
    dispatch({ type: 'queue.enqueue', sessionId, item }),
  remove: (sessionId: string, id: string): Promise<void> => dispatch({ type: 'queue.remove', sessionId, id }),
  /** 立即发送：id 指定要插队的那一条（宿主会先把它提到队首再中断当前轮） */
  flush: (sessionId: string, id?: string): Promise<void> => dispatch({ type: 'queue.flush', sessionId, id }),
}
