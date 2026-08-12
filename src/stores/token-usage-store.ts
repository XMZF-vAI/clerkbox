import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TokenUsage } from '../types/agent'

/** 单次调用记录：用于明细展示 */
export interface UsageRecord {
  ts: number
  sessionId: string
  model: string
  providerId?: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

interface TokenUsageState {
  /** 累计输入 token */
  totalPromptTokens: number
  /** 累计输出 token */
  totalCompletionTokens: number
  /** 累计总 token */
  totalTokens: number
  /** 累计缓存写入 token */
  totalCacheCreationTokens: number
  /** 累计缓存读取 token（命中） */
  totalCacheReadTokens: number
  /** 累计 API 调用次数 */
  totalCalls: number
  /** 最近 N 条调用明细，用于面板展示 */
  recentRecords: UsageRecord[]
  /** 记录一次 API 调用的 usage */
  recordUsage: (params: {
    usage: TokenUsage
    sessionId: string
    model: string
    providerId?: string
  }) => void
  /** 清空所有统计 */
  resetStats: () => void
}

const MAX_RECENT_RECORDS = 50

export const useTokenUsageStore = create<TokenUsageState>()(
  persist(
    (set) => ({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCalls: 0,
      recentRecords: [],

      recordUsage: ({ usage, sessionId, model, providerId }) => {
        const record: UsageRecord = {
          ts: Date.now(),
          sessionId,
          model,
          providerId,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || (usage.prompt_tokens + usage.completion_tokens),
          cacheCreationTokens: usage.cache_creation_input_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
        }
        set((state) => {
          const recentRecords = [record, ...state.recentRecords].slice(0, MAX_RECENT_RECORDS)
          return {
            totalPromptTokens: state.totalPromptTokens + record.promptTokens,
            totalCompletionTokens: state.totalCompletionTokens + record.completionTokens,
            totalTokens: state.totalTokens + record.totalTokens,
            totalCacheCreationTokens:
              state.totalCacheCreationTokens + (record.cacheCreationTokens || 0),
            totalCacheReadTokens:
              state.totalCacheReadTokens + (record.cacheReadTokens || 0),
            totalCalls: state.totalCalls + 1,
            recentRecords,
          }
        })
      },

      resetStats: () =>
        set({
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalCalls: 0,
          recentRecords: [],
        }),
    }),
    {
      name: 'clerkbox-token-usage',
    }
  )
)
