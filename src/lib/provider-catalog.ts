import type { ApiCompat } from '../types/agent'

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
}

export type ProviderGroup = 'international' | 'china' | 'aggregator' | 'local' | 'custom'

/** 分组顺序（UI 依此渲染分组标题） */
export const PROVIDER_GROUPS: ProviderGroup[] = ['international', 'china', 'aggregator', 'local', 'custom']

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── 国际 ──
  {
    id: 'openai',
    name: 'OpenAI',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    group: 'international',
    apiCompat: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://api.x.ai' },
    apiKeyUrl: 'https://console.x.ai',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'together',
    name: 'Together AI',
    group: 'international',
    apiCompat: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyUrl: 'https://api.together.xyz/settings/api-keys',
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
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
    apiKeyUrl: 'https://bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'dashscope',
    name: '通义千问 DashScope',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy' },
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    altCompat: { apiCompat: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic' },
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'volcengine',
    name: '火山方舟 Ark',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    id: 'qianfan',
    name: '百度千帆',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    apiKeyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    apiKeyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    group: 'china',
    apiCompat: 'openai',
    baseUrl: 'https://api.stepfun.com/v1',
    apiKeyUrl: 'https://platform.stepfun.com/interface-key',
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
