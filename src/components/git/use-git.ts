/**
 * Git UI 共享数据层：状态获取 hook + 窗口内刷新事件总线。
 *
 * 刷新事件解决一个具体问题：分支芯片（输入框上方）和 Git 审查面板（工作台 tab）
 * 各自独立拉状态，谁提交/切了分支，另一边不会知道。靠 window CustomEvent 广播
 * 「git 数据脏了」，监听方各自重拉 —— 与 ZCode 的 refreshToken 手动刷新模型同构，
 * 只是传输换成窗口内事件。无 watcher 自动刷新，靠打开时拉取 + 操作后广播 + 手动刷新。
 */
import { useCallback, useEffect, useState } from 'react'
import { ipc } from '../../lib/ipc-client'
import type { GitStatusResult } from '../../types/ipc'

const GIT_REFRESH_EVENT = 'clerkbox:git-refresh'

/** 通知本窗口所有 Git UI：指定目录（缺省=全部）的数据已经脏了 */
export function emitGitRefresh(workDir?: string): void {
  window.dispatchEvent(new CustomEvent(GIT_REFRESH_EVENT, { detail: { workDir } }))
}

export interface GitStatusState {
  data: GitStatusResult | null
  loading: boolean
  error: string | null
  /** 手动刷新（刷新按钮 / 操作成功后调用；同时广播给其它 Git UI） */
  refresh: () => void
}

/** 按工作目录拉取仓库状态快照；目录变化自动重拉，并监听窗口内的 git 刷新事件 */
export function useGitStatus(workDir: string | undefined): GitStatusState {
  const [data, setData] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!workDir) {
      setData(null)
      return
    }
    let disposed = false
    setLoading(true)
    ipc.gitGetStatus(workDir)
      .then((res) => {
        if (disposed) return
        setData(res)
        setError(null)
      })
      .catch((err) => {
        if (!disposed) setError(String(err))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [workDir, tick])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ workDir?: string }>).detail
      // 不带目录的广播（操作方不知道别的目录）也要响应
      if (!detail?.workDir || !workDir || detail.workDir === workDir) setTick((t) => t + 1)
    }
    window.addEventListener(GIT_REFRESH_EVENT, handler)
    return () => window.removeEventListener(GIT_REFRESH_EVENT, handler)
  }, [workDir])

  const refresh = useCallback(() => {
    // 只广播：自己的监听器会接住并重拉，避免这里 setTick + 事件回声造成双份请求
    emitGitRefresh(workDir)
  }, [workDir])

  return { data, loading, error, refresh }
}
