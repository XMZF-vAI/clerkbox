import { useCallback, useEffect, useMemo, useState } from 'react'
import { ipc } from '../../lib/ipc-client'
import type { BotListItem, RuntimeStatus } from '../../../electron/im-bots/types'

/**
 * 机器人列表 + 运行状态的共享订阅。
 *
 * 数据来源有两份，故意不合成一份：
 * - `bots:list` 给配置（名称 / enabled / 凭据是否存在 / 已绑定账号），变化靠 `bots:changed` 重拉；
 * - `bots:status` 给连接状态（六态 + 错误消息），主进程按全量快照推，来一条覆盖一条即可，
 *   不必和列表比对时序 —— 状态是易变数据，晚一拍的列表配上新状态不会读错凭据。
 * 于是 `statusOf()` 优先用实时状态，缺省回落到列表里携带的那份（首帧不至于空白）。
 */
export interface UseBotsResult {
  bots: BotListItem[]
  loading: boolean
  /** 列表读取失败的原因（主进程原文，界面上直接展示，用户能据此排查） */
  loadError: string | null
  /** 重拉列表 + 状态 */
  refresh: () => Promise<void>
  statusOf: (botId: string) => RuntimeStatus | undefined
  boundCountOf: (botId: string) => number
}

export function useBots(): UseBotsResult {
  const [bots, setBots] = useState<BotListItem[]>([])
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      // 两个请求并发：状态接口不看配置版本，列表接口自带凭据探测，串行只会更慢
      const [list, status] = await Promise.all([ipc.bots.list(), ipc.bots.runtimeStatus()])
      setBots(list)
      setStatuses(status)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const offChanged = ipc.bots.onChanged(() => void refresh())
    const offStatus = ipc.bots.onStatus((next) => setStatuses(next))
    return () => {
      offChanged()
      offStatus()
    }
  }, [refresh])

  const statusById = useMemo(() => {
    const map = new Map<string, RuntimeStatus>()
    for (const item of statuses) map.set(item.botId, item)
    return map
  }, [statuses])

  const statusOf = useCallback(
    (botId: string): RuntimeStatus | undefined => {
      const live = statusById.get(botId)
      if (live) return live
      const row = bots.find((item) => item.id === botId)
      if (!row) return undefined
      return {
        botId,
        state: row.status,
        ...(row.statusMessage ? { message: row.statusMessage } : {}),
      }
    },
    [statusById, bots]
  )

  const boundCountOf = useCallback(
    (botId: string) => bots.find((item) => item.id === botId)?.boundActors.length ?? 0,
    [bots]
  )

  return { bots, loading, loadError, refresh, statusOf, boundCountOf }
}
