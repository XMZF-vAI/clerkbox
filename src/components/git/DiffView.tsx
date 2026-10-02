/**
 * unified patch 渲染器（Git 审查面板的 diff 视图）。
 *
 * 主进程吐出的是标准 unified diff 文本，这里按行分类着色渲染：
 * 文件头/meta 行弱化、@@ hunk 行高亮、+/- 行加底色、上下文行原样。
 * 不引第三方 diff 库 —— patch 本身已经带齐了行级信息，解析只是分类。
 */
import { useMemo } from 'react'

type DiffLineType = 'meta' | 'hunk' | 'add' | 'del' | 'ctx'

interface DiffLine {
  type: DiffLineType
  text: string
}

export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  for (const raw of patch.split('\n')) {
    // 结尾换行产生的空尾巴不渲染
    if (raw === '' && lines.length > 0 && lines[lines.length - 1].text === '') continue
    if (
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('--- ') ||
      raw.startsWith('+++ ') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('rename ') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('similarity ') ||
      raw.startsWith('copy ') ||
      raw.startsWith('Binary files ') ||
      raw.startsWith('\\ No newline')
    ) {
      lines.push({ type: 'meta', text: raw })
      continue
    }
    if (raw.startsWith('@@')) lines.push({ type: 'hunk', text: raw })
    else if (raw.startsWith('+')) lines.push({ type: 'add', text: raw })
    else if (raw.startsWith('-')) lines.push({ type: 'del', text: raw })
    else if (raw.startsWith(' ')) lines.push({ type: 'ctx', text: raw })
    else lines.push({ type: 'meta', text: raw })
  }
  return lines
}

const LINE_CLASS: Record<DiffLineType, string> = {
  meta: 'text-dark-onSurfaceVariant/50',
  hunk: 'text-sky-400 bg-sky-500/10',
  add: 'bg-emerald-500/10 text-emerald-300',
  del: 'bg-red-500/10 text-red-300',
  ctx: '',
}

export default function DiffView({ patch, className = '' }: { patch: string; className?: string }) {
  const lines = useMemo(() => parsePatch(patch), [patch])
  return (
    <div
      className={`overflow-x-auto rounded-md3-sm bg-black/20 font-mono text-[11px] leading-[1.6] ${className}`}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={`whitespace-pre px-2 ${LINE_CLASS[line.type]}`}
        >
          {line.text === '' ? ' ' : line.text}
        </div>
      ))}
    </div>
  )
}
