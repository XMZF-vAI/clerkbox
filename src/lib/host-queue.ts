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

export type HostQueueResult =
  | { status: 'accepted'; mode: 'main' | 'renderer' }
  | { status: 'rejected'; error: string }
  | { status: 'unknown'; error: string }

async function dispatch(cmd: AgentCommand): Promise<HostQueueResult> {
  try {
    if ((await agentClient.ensureMode()) !== 'main') return { status: 'accepted', mode: 'renderer' }
    const res = await agentClient.send(cmd)
    return res.ok
      ? { status: 'accepted', mode: 'main' }
      : { status: 'rejected', error: res.error || 'queue-command-rejected' }
  } catch (error) {
    // 可能已执行、仅回执丢失。只拉权威状态，绝不在这里重发原命令。
    void agentClient.resync(cmd.sessionId).catch(() => undefined)
    return { status: 'unknown', error: error instanceof Error ? error.message : String(error) }
  }
}

export const hostQueue = {
  enqueue: (sessionId: string, item: QueuedMessageItem): Promise<HostQueueResult> =>
    dispatch({ type: 'queue.enqueue', sessionId, item }),
  remove: (sessionId: string, id: string): Promise<HostQueueResult> => dispatch({ type: 'queue.remove', sessionId, id }),
  /** 立即发送：id 指定要插队的那一条（宿主会先把它提到队首再中断当前轮） */
  flush: (sessionId: string, id?: string): Promise<HostQueueResult> => dispatch({ type: 'queue.flush', sessionId, id }),
}
