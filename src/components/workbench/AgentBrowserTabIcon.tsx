import { useEffect, useState } from 'react'
import { MousePointer2 } from 'lucide-react'
import { useWorkbench, type WorkbenchTab } from '../../stores/workbench-store'

/**
 * Agent 浏览器标签的图标。
 *
 * AI 正在驱动页面时，用一个**呼吸的指针图标替换掉**标签标题（而不是在标题旁加徽标）——
 * 徽标会把标签栏挤窄，而替换是零布局成本的强信号。空闲时退回标题文字。
 *
 * 判定用的是 store 里的 `agentBrowserOperationUntil`（5s 滑动窗口），
 * 而不是「正在执行」布尔量：主进程只发「刚发生了一次操作」这个事实，
 * 窗口到期自己熄灭，AI 停手后不需要任何配对事件来收尾。
 */
export function AgentBrowserTabIcon({ tab }: { tab: WorkbenchTab }) {
  const { agentBrowserOperationUntil } = useWorkbench()
  const isOperating = useIsOperating(agentBrowserOperationUntil)

  if (isOperating) {
    return (
      <span
        aria-hidden
        data-agent-browser-operation="active"
        className="agent-browser-breathe inline-flex w-3.5 shrink-0 items-center justify-center"
      >
        <MousePointer2 size={14} />
      </span>
    )
  }
  return <span className="truncate">{tab.title || 'agent'}</span>
}

/** 滑动窗口判定：到期后靠一次定时器把自己翻成 false，不需要外部再推一次事件 */
function useIsOperating(operationUntil: number): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const remaining = operationUntil - now
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setNow(Date.now()), remaining)
    return () => window.clearTimeout(timer)
  }, [operationUntil, now])
  return operationUntil > now
}
