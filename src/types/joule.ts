/**
 * Joule 账号的跨进程共享类型（主进程 / preload / 渲染层）。
 *
 * 这里只放**无秘密**的账号快照：API Key 永远不进快照、不进 store、不进日志。
 * Key 由主进程写入 safeStorage，只通过 jouleStartLogin 的返回值一次性交给渲染层，
 * 用于创建 Provider 后立即被 settings-store 的 partialize 剥离。
 */

import type { ReasoningEffort, ThinkingStyle } from './agent'

export type JouleStatus = 'unlinked' | 'connected' | 'expired' | 'needs_reauth' | 'error'

/** 服务端下发的模型思考能力（ClerkBox 只消费，不按模型名硬编码） */
export interface JouleThinkingConfig {
  style: ThinkingStyle
  efforts: ReasoningEffort[]
  defaultEffort?: ReasoningEffort
  alwaysOn?: boolean
}

export interface JouleUser {
  username: string
  email?: string | null
}

export interface JouleSubscription {
  tier: string
  label: string
  expiresAt: number
}

export interface JouleExpired {
  tier: string
  label: string
  expiresAt: number
}

export interface JoulePlan {
  tier: string
  label: string
  monthly: number
  w5h: number
  week: number
  conc: number
  concFree: number
  freeDaily: number
}

export interface JouleQuotaWindow {
  used: number
  cap: number
  remaining: number
  ratio: number
  resetAt: number
}

export interface JouleQuotas {
  w5h: JouleQuotaWindow
  week: JouleQuotaWindow
  month: JouleQuotaWindow
}

export interface JouleDesktop {
  linked: boolean
  keyName?: string
  lastUsedAt?: number | null
}

/** 客户端折扣：服务端按安装签名判定，界面上只做如实展示 */
export interface JoulePromo {
  label: string
  factor: number
}

export interface JouleModelFree {
  until: number
  daily: Record<string, number>
  conc: Record<string, number>
  usedToday: number
}

export interface JouleModel {
  id: string
  displayName: string
  contextLength: number | null
  /** 服务端能力配置；老版本后端或未知模型可能为 null */
  thinking?: JouleThinkingConfig | null
  est5h: number
  cap: number
  used: number
  remaining: number
  tiers?: Record<string, { est5h: number; cap: number }>
  free?: JouleModelFree
}

export interface JouleLoginState {
  userCode: string
  expiresAt: number
  verificationUri: string
}

export interface JouleStateSnapshot {
  status: JouleStatus
  user: JouleUser | null
  subscription: JouleSubscription | null
  expired: JouleExpired | null
  plan: JoulePlan | null
  quotas: JouleQuotas | null
  desktop: JouleDesktop | null
  promo?: JoulePromo | null
  models?: JouleModel[]
  login: JouleLoginState | null
  lastSyncAt: number | null
  stale: boolean
  error: string | null
  serverNow: number | null
}

export interface JouleLoginResult {
  ok?: boolean
  cancelled?: boolean
  error?: string
  key?: string
  account?: JouleStateSnapshot
  models?: JouleModel[]
}
