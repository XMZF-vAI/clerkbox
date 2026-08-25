import { create } from 'zustand'
import { ipc } from '../lib/ipc-client'
import { toolRegistry } from '../lib/tool-registry'
import { useSettingsStore } from './settings-store'
import type { McpServerConfig, McpServerStatus, McpToolInfo } from '../types/ipc'

/**
 * MCP 服务器运行状态 store。
 *
 * - 配置持久化在 settings-store（mcpServers），本 store 只持有主进程连接状态
 * - 配置变化 → syncMcpServers 全量同步到主进程 McpManager
 * - 状态推送（Electron 模式）→ applyStatuses 更新状态并注入工具注册表
 */

interface McpState {
  /** 各服务器最新状态（含连接态与工具清单） */
  statuses: McpServerStatus[]
  /** 是否正在执行全量同步 */
  syncing: boolean
}

export const useMcpStore = create<McpState>(() => ({
  statuses: [],
  syncing: false,
}))

/** 把状态写入 store，并把已连接服务器的工具注入 toolRegistry（对话即可用） */
function applyStatuses(statuses: McpServerStatus[]): void {
  useMcpStore.setState({ statuses })
  const tools: McpToolInfo[] = []
  for (const s of statuses) {
    if (s.state === 'connected') tools.push(...s.tools)
  }
  toolRegistry.setMcpTools(tools)
}

/** 全量同步：settings.mcpServers → 主进程建立/断开连接 */
export async function syncMcpServers(servers: McpServerConfig[]): Promise<void> {
  useMcpStore.setState({ syncing: true })
  try {
    const statuses = await ipc.mcpSync(servers)
    applyStatuses(statuses)
  } catch (e) {
    console.error('[mcp-store] sync failed:', e)
  } finally {
    useMcpStore.setState({ syncing: false })
  }
}

/**
 * 应用启动时调用一次（App.tsx）：
 * 1. 用当前配置做首次同步
 * 2. 订阅配置变化 → 自动重新同步
 * 3. 订阅主进程状态推送（连接中 → 已连接 / 出错）
 * 返回清理函数。
 */
export function initMcp(): () => void {
  void syncMcpServers(useSettingsStore.getState().mcpServers ?? [])

  const unsubSettings = useSettingsStore.subscribe((state, prev) => {
    if (state.mcpServers !== prev.mcpServers) {
      void syncMcpServers(state.mcpServers)
    }
  })

  const unsubStatus = ipc.onMcpStatus((statuses) => applyStatuses(statuses))

  return () => {
    unsubSettings()
    unsubStatus()
  }
}
