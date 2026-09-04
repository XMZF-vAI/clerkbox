import type { ApiCompat, ReasoningEffort, ThinkingStyle } from '../types/agent'
import { DEFAULT_THINKING_STYLE } from '../types/agent'

/**
 * 内置提供商目录。
 *
 * 只存**连接信息**（baseUrl + 默认协议），不预设任何模型 id ——
 * 模型一律通过 `/models` 在线拉取，避免目录过期导致填错模型名。
 * 预设仅作为「添加提供商」时的填表默认值，落库后用户可任意修改。
 */
export interface ProviderPreset {
  id: string
  name: string
  group: ProviderGroup
  apiCompat: ApiCompat
  baseUrl: string
  /** 该平台同时提供另一种协议的端点时填，UI 上给「切协议」快捷入口 */
  altCompat?: { apiCompat: ApiCompat; baseUrl: string }
  /** 「去拿 Key」外链 */
  apiKeyUrl?: string
  /** false = 本地部署，无需 Key */
  requiresKey?: boolean
  /**
   * 该平台思考能力的默认协议预设。
   * 不同厂商的思考档位名称/参数各不相同，这里按厂商声明：
   * - thinkingStyle：思考在请求体里的默认表达方式
   * - efforts：该平台思考模型默认支持的档位（从弱到强）
   * - effortKeywords：模型 id 含这些关键词 → 视为思考模型（自动开启）
   * 未命中 effortKeywords 的模型默认支持思考 = false（由用户在高级设置手动开）。
   */
  thinking?: {
    thinkingStyle: ThinkingStyle
    efforts: ReasoningEffort[]
    effortKeywords: string[]
  }
}

export type ProviderGroup = 'official' | 'international' | 'china' | 'aggregator' | 'local' | 'custom'

/** 分组顺序（UI 依此渲染分组标题） */
export const PROVIDER_GROUPS: ProviderGroup[] = ['official', 'international', 'china', 'aggregator', 'local', 'custom']

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── 官方 ──
  {
    id: 'lunora',
    name: 'Lunora API',
    group: 'official',
    apiCompat: 'openai',
    baseUrl: 'https://api.uselunora.com/v1',
    apiKeyUrl: 'https://www.uselunora.com/',
    thinking: {
      thinkingStyle: 'enable',
      // Lunora 聚合多厂商模型（Claude / OpenAI o 系 / DeepSeek / 通义 / Gemini / Grok 等）
      efforts: ['low', 'medium', 'high'],
      effortKeywords: [
        'claude', 'sonnet', 'opus', 'haiku',
        'o1', 'o3', 'o4', 'gpt-5',
        'reasoning', 'thinking', 'reasoner',
        'deepseek', 'qwen',
        'gemini', 'grok',
      ],
    },
  },

  // ── 国际 ──
  {
    id: 'openai',
    name: 'OpenAI',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    thinking: {
      thinkingStyle: 'effort',
      // o 系推理模型通过 reasoning_effort 控制，档位 low/medium/high
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['o1', 'o3', 'o4', 'gpt-5', 'reasoning'],
    },
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    group: 'international',
    apiCompat: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    thinking: {
      thinkingStyle: 'budget',
      // Anthropic 无离散档位，用 budget_tokens 近似；全部档位可用
      efforts: ['minimal', 'low', 'medium', 'high', 'max', 'xhigh'],
      effortKeywords: ['claude', 'sonnet', 'opus', 'haiku'],
    },
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['gemini'],
    },
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://api.x.ai' },
    apiKeyUrl: 'https://console.x.ai',
    thinking: {
      thinkingStyle: 'effort',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['grok', 'reasoning'],
    },
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['reasoning', 'thinking'],
    },
  },
  {
    id: 'groq',
    name: 'Groq',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyUrl: 'https://console.groq.com/keys',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['reasoning', 'thinking'],
    },
  },
  {
    id: 'together',
    name: 'Together AI',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyUrl: 'https://api.together.xyz/settings/api-keys',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['reasoning', 'thinking'],
    },
  },

  // ── 国内 ──
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' },
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    thinking: {
      thinkingStyle: 'auto',
      // deepseek-reasoner 自动思考无档位；V3.1/V4 也开始支持 reasoning_effort
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['reasoner', 'v4', 'thinking'],
    },
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
    apiKeyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    thinking: {
      thinkingStyle: 'glm',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['glm', 'thinking'],
    },
  },
  {
    id: 'dashscope',
    name: '通义千问 DashScope',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy' },
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['qwen'],
    },
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic' },
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['kimi', 'reasoning', 'thinking'],
    },
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['reasoning', 'thinking'],
    },
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['reasoning', 'thinking'],
    },
  },
  {
    id: 'volcengine',
    name: '火山方舟 Ark',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['deepseek', 'qwen'],
    },
  },
  {
    id: 'qianfan',
    name: '百度千帆',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    apiKeyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['deepseek', 'qwen', 'ernie'],
    },
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    apiKeyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['hunyuan', 'thinking'],
    },
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.stepfun.com/v1',
    apiKeyUrl: 'https://platform.stepfun.com/interface-key',
    thinking: {
      thinkingStyle: 'enable',
      efforts: ['low', 'medium', 'high'],
      effortKeywords: ['step', 'thinking'],
    },
  },

  // ── 聚合 ──
  {
    id: 'openrouter',
    name: 'OpenRouter',
    group: 'aggregator',
    apiCompat: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'aihubmix',
    name: 'AiHubMix',
    group: 'aggregator',
    apiCompat: 'openai',
    baseUrl: 'https://aihubmix.com/v1',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://aihubmix.com' },
    apiKeyUrl: 'https://aihubmix.com/token',
  },

  // ── 本地 ──
  {
    id: 'ollama',
    name: 'Ollama',
    group: 'local',
    apiCompat: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    group: 'local',
    apiCompat: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    requiresKey: false,
  },

  // ── 自定义 ──
  {
    id: 'custom',
    name: '',
    group: 'custom',
    apiCompat: 'openai',
    baseUrl: '',
  },
]

export const getPreset = (id?: string): ProviderPreset | undefined =>
  id ? PROVIDER_PRESETS.find((p) => p.id === id) : undefined

/** 按 host 猜测预设（老数据迁移用） */
export function guessPresetByBaseUrl(baseUrl: string): ProviderPreset | undefined {
  let host: string
  try {
    host = new URL(baseUrl).host.toLowerCase()
  } catch {
    return undefined
  }
  // 排除 custom 占位项；同 host 时取 baseUrl 最长匹配（更精确的路径优先）
  const matches = PROVIDER_PRESETS.filter((p) => {
    if (p.group === 'custom' || !p.baseUrl) return false
    const candidates = [p.baseUrl, p.altCompat?.baseUrl].filter(Boolean) as string[]
    return candidates.some((c) => {
      try {
        return new URL(c).host.toLowerCase() === host
      } catch {
        return false
      }
    })
  })
  if (matches.length === 0) return undefined
  return matches.sort((a, b) => b.baseUrl.length - a.baseUrl.length)[0]
}

/** 从 baseUrl 猜测协议：路径里带 anthropic 关键字则按 anthropic 处理 */
export function guessApiCompat(baseUrl: string): ApiCompat {
  const lower = baseUrl.toLowerCase()
  if (lower.includes('anthropic') || lower.includes('claude')) return 'anthropic'
  return 'openai'
}

/**
 * 按提供商预设推断一个「新拉取模型」的思考默认值。
 *
 * 策略：
 * 1. 命中预设 && 模型 id 含 effortKeywords → 按预设风格（档位/effort 风格时附档位）
 * 2. 命中预设但未命中关键词 → 用预设的默认 thinkingStyle（通常为 'enable' 开关）
 * 3. 没有预设（custom/未声明 thinking）→ 一律走开关模式（enable）
 *
 * 函数始终返回值，不再返回 undefined —— 用户视角下"导入模型后默认支持思考（开关）"，
 * 具体档位可到高级设置里再勾选。
 */
export function inferThinkingDefaults(
  presetId: string | undefined,
  modelId: string
): { supportsThinking: boolean; thinkingStyle: ThinkingStyle; reasoningEfforts: ReasoningEffort[] } {
  // 兜底：开关模式
  const fallback = {
    supportsThinking: true,
    thinkingStyle: 'enable' as ThinkingStyle,
    reasoningEfforts: [] as ReasoningEffort[],
  }
  const preset = getPreset(presetId)
  const t = preset?.thinking
  if (!t) return fallback

  const lower = modelId.toLowerCase()
  const hit = t.effortKeywords.some((k) => lower.includes(k))
  // 档位方案（effort 风格）才附带档位；其他风格（enable/glm/budget/auto）开关即可
  const efforts = hit && t.thinkingStyle === 'effort' ? [...t.efforts] : []
  return {
    supportsThinking: true,
    thinkingStyle: t.thinkingStyle,
    reasoningEfforts: efforts,
  }
}

/**
 * 该端点是否需要 API Key。
 * 预设显式声明 requiresKey: false 的（Ollama / LM Studio）不需要；
 * 自定义提供商指向本机时也按本地部署处理，避免逼用户填一个假 Key。
 */
export function requiresApiKey(baseUrl: string, presetId?: string): boolean {
  const preset = getPreset(presetId)
  if (preset?.requiresKey === false) return false
  return !isLocalEndpoint(baseUrl)
}

/** 判断 baseUrl 是否指向本机 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

/** 从 baseUrl 提取一个可读的兜底显示名 */
export function fallbackNameFromBaseUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).host
    return host.replace(/^www\./, '')
  } catch {
    return baseUrl || 'Custom'
  }
}
