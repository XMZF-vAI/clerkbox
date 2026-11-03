/**
 * 工作流停止的门面（仿 subagent-control.ts）：渲染层宿主本地直接 abort，
 * 宿主模式发 workflow.stop 命令给主进程。调用方不感知模式差异。
 */
import { agentClient } from './agent-client'
import { stopWorkflowRun } from './workflow-runtime'

/** 停止单个工作流运行；返回是否受理（运行不存在/已终态时 false） */
export async function stopWorkflowRunControlled(runId: string, sessionId: string): Promise<boolean> {
  const mode = await agentClient.ensureMode()
  if (mode === 'main') {
    const res = await agentClient.send({ type: 'workflow.stop', sessionId, runId })
    return res.ok
  }
  return stopWorkflowRun(runId)
}
