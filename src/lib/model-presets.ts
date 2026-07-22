export interface ModelPreset {
  label: string
  model: string
  baseUrl: string
}

export const MODEL_PRESETS: ModelPreset[] = [
  { label: 'DeepSeek Chat', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
  { label: 'DeepSeek Reasoner', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1' },
  { label: 'GPT-4o', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
  { label: 'GPT-4o Mini', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  { label: 'Claude 3.5 Sonnet', model: 'claude-3-5-sonnet-20241022', baseUrl: 'https://api.anthropic.com/v1' },
  { label: 'Qwen Max', model: 'qwen-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: 'GLM-4', model: 'glm-4', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
]
