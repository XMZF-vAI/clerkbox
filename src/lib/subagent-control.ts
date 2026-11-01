/**
 * 子代理控制门面：UI（详情面板）按 (sessionId, runId) 单取消 / steering 注入。
 *
 * 双宿主分派与 manualCompact / abort 同一模式：宿主模式下命令交主进程
 * （run 与注册表都在宿主进程里），渲染层模式直接走 agent-core 的进程内注册表。
 */
import { agentClient } from './agent-client'
import { abortSubagentLocal, steerSubagentLocal } from '../agent-core/session-context'

/** 单子代理取消：只中止该 run 的循环，父轮与其它子代理不受影响。 */
export async function stopSubAgentRun(sessionId: string, runId: string): Promise<void> {
  if ((await agentClient.ensureMode()) === 'main') {
    await agentClient.send({ type: 'subagent.stop', sessionId, runId })
    return
  }
  abortSubagentLocal(sessionId, runId)
}

/**
 * 向运行中的子代理注入一条指令。返回 false = 该 run 不在运行（已终态或未知），
 * 调用方可据此提示用户改用续聊（模型侧的 send_message_to_agent 会走续跑分支）。
 */
export async function steerSubAgentRun(sessionId: string, runId: string, text: string): Promise<boolean> {
  if ((await agentClient.ensureMode()) === 'main') {
    const res = await agentClient.send({ type: 'subagent.steer', sessionId, runId, text })
    return res.ok
  }
  return steerSubagentLocal(sessionId, runId, text)
}
