/**
 * Harness 兼容模式注册表。
 *
 * 背景：各家模型按自家官方 harness（系统提示词 + 工具形态 + 行为规范）调优，
 * 第三方 harness 驱动这些模型时，对齐官方形态可获得接近官方的效果。
 * 本模块定义除默认模式外的四个兼容模式（Codex / Grok Build / dsh / dsh 极简），
 * 每个模式 = 一份静态 system prompt + 可选的内置工具集变换。
 *
 * 约束：
 * - 模式在会话首条消息发出后锁定（与 dsh 官方 preset 语义一致：会话产出过
 *   消息/工具调用后组合不可变更），存储在 Session.harnessMode 上；
 * - 兼容模式只替换静态 system 段与工具定义，工具名与实现保持 ClerkBox
 *   内部不变（权限白名单/压缩/UI 的工具名引用零改动）；
 * - 各模式 prompt 文件头部记录底本来源与许可证署名（Apache-2.0 / MIT）。
 */

import type { HarnessMode, ToolDefinition } from '../types/agent'
import { CODEX_SYSTEM_PROMPT } from './harness-prompts/codex'
import { GROK_BUILD_SYSTEM_PROMPT } from './harness-prompts/grok-build'
import { DSH_SYSTEM_PROMPT } from './harness-prompts/dsh'
import { DSH_MINIMAL_SYSTEM_PROMPT, dshMinimalTransformTools } from './harness-prompts/dsh-minimal'

/** 动态 system 段的注入策略 */
export type HarnessDynamicContext =
  /** 与默认模式一致：工作目录 + 环境 + .clerkbox/AGENTS.md/记忆/技能目录 */
  | 'full'
  /** 极简（dsh-minimal 官方语义）：仅工作目录 + 环境，其余全不注入 */
  | 'minimal'

export interface HarnessModeMeta {
  id: HarnessMode
  /** 菜单分组：default = 默认模式；compat = 第三方 harness 兼容模式 */
  group: 'default' | 'compat'
  /** i18n key：显示名 */
  nameKey: string
  /** i18n key：小字解析 */
  descKey: string
  /** i18n key：推荐模型搭配提示 */
  hintKey: string
}

/** 模式选择器菜单的展示顺序与文案 key（i18n 见 locales chat.harness*） */
export const HARNESS_MODE_METAS: HarnessModeMeta[] = [
  { id: 'default', group: 'default', nameKey: 'chat.harnessDefault', descKey: 'chat.harnessDefaultDesc', hintKey: 'chat.harnessDefaultHint' },
  { id: 'codex', group: 'compat', nameKey: 'chat.harnessCodex', descKey: 'chat.harnessCodexDesc', hintKey: 'chat.harnessCodexHint' },
  { id: 'grok-build', group: 'compat', nameKey: 'chat.harnessGrok', descKey: 'chat.harnessGrokDesc', hintKey: 'chat.harnessGrokHint' },
  { id: 'dsh', group: 'compat', nameKey: 'chat.harnessDsh', descKey: 'chat.harnessDshDesc', hintKey: 'chat.harnessDshHint' },
  { id: 'dsh-minimal', group: 'compat', nameKey: 'chat.harnessDshMinimal', descKey: 'chat.harnessDshMinimalDesc', hintKey: 'chat.harnessDshMinimalHint' },
]

export interface HarnessModeContent {
  /** 静态 system 段全文（跨请求字节一致，无易变内容——前缀缓存前提） */
  staticPrompt: string
  /** 动态 system 段注入策略 */
  dynamicContext: HarnessDynamicContext
  /**
   * 内置工具定义变换（过滤/描述覆盖）。只改模型可见的定义，
   * 不改工具名与执行实现。
   */
  transformTools?: (defs: ToolDefinition[]) => ToolDefinition[]
  /**
   * 是否随模式附带用户配置的 MCP 工具（缺省 true，MCP 属用户显式配置的
   * 部署层能力）。dsh-minimal 置 false：官方 minimal 组合不挂任何 MCP 插件。
   */
  includeMcpTools?: boolean
}

/** 非默认模式的模式内容（default 模式走 prompts.ts 原有静态段，不在此表） */
export const HARNESS_MODE_CONTENT: Record<Exclude<HarnessMode, 'default'>, HarnessModeContent> = {
  codex: {
    staticPrompt: CODEX_SYSTEM_PROMPT,
    dynamicContext: 'full',
  },
  'grok-build': {
    staticPrompt: GROK_BUILD_SYSTEM_PROMPT,
    dynamicContext: 'full',
  },
  dsh: {
    staticPrompt: DSH_SYSTEM_PROMPT,
    dynamicContext: 'full',
  },
  'dsh-minimal': {
    staticPrompt: DSH_MINIMAL_SYSTEM_PROMPT,
    dynamicContext: 'minimal',
    transformTools: dshMinimalTransformTools,
    includeMcpTools: false,
  },
}

/** 存储值兜底：未知/缺失值一律回退默认模式（旧会话行无此字段） */
export function normalizeHarnessMode(value: unknown): HarnessMode {
  return typeof value === 'string' && HARNESS_MODE_CONTENT[value as Exclude<HarnessMode, 'default'>]
    ? (value as HarnessMode)
    : 'default'
}
