import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { ToolCall, ToolResult } from '../../../types/agent'

/** 渲染器入参：call=工具调用；result=结果（未返回时 undefined）；args=已解析入参 */
export interface ToolRendererProps {
  call: ToolCall
  result?: ToolResult
  isError: boolean
  args: Record<string, unknown>
  vibe?: boolean
}

export type ToolRenderer = LazyExoticComponent<ComponentType<ToolRendererProps>>

/** 子 Agent 走 SubAgentCard 统一入口（不注册工具行渲染器，避免重复实现） */
export const SUBAGENT_UNIFIED_ENTRY = 'spawn_agent'

/** 该工具是否已由统一入口渲染（工具行侧直接排除） */
export function isRenderedByUnifiedEntry(name: string): boolean {
  return name === SUBAGENT_UNIFIED_ENTRY
}

const REGISTRY: Record<string, ToolRenderer> = {
  execute_command: lazy(() => import('./ExecuteCommandRenderer')),
  read_file: lazy(() => import('./ReadFileRenderer')),
  write_file: lazy(() => import('./WriteFileRenderer')),
  search_replace: lazy(() => import('./EditFileRenderer')),
  edit_file: lazy(() => import('./EditFileRenderer')),
  web_search: lazy(() => import('./WebSearchRenderer')),
  web_fetch: lazy(() => import('./WebFetchRenderer')),
  app: lazy(() => import('./AppRenderer')),
  mcp: lazy(() => import('./McpRenderer')),
  agentAction: lazy(() => import('./AgentActionRenderer')),
}

const MCP_PREFIX = 'mcp__'
/** 自我管控工具（app_*）：7 个只读工具共用一个渲染器 */
const APP_PREFIX = 'app_'

/** 工具名 → 专属渲染器；未注册返回 undefined，由调用方走通用回退 */
export function resolveRenderer(name: string): ToolRenderer | undefined {
  if (isRenderedByUnifiedEntry(name)) return undefined
  if (name.startsWith(MCP_PREFIX)) return REGISTRY.mcp
  if (name.startsWith(APP_PREFIX)) return REGISTRY.app
  if (name.startsWith('browser_') || name.startsWith('computer_')) return REGISTRY.agentAction
  return REGISTRY[name]
}
