/**
 * 编辑差异元数据（行级 diff）：tool-registry 执行期与 PermissionCard 审批期共用。
 * 审批期复用同一套 diff，用户批准写文件时看到的就是执行后将落盘的那份变更。
 */

export interface EditDiffLine {
  text: string
  tone: 'add' | 'del' | 'ctx'
}

export interface EditDiffMeta {
  path: string
  added: number
  removed: number
  /** 供悬停预览的小样本行（上下文截断，超长折叠） */
  lines: EditDiffLine[]
}

const DIFF_CTX = 2
const DIFF_SIDE_CAP = 12

/**
 * 行级 diff：公共前缀/后缀压缩，中间整块替换。
 * write_file 整文件重写与 search_replace 局部修改都适用；
 * 只输出 UI 预览用的小样本（前后各 2 行 ctx，del/add 各至多 12 行），不追求补丁最小化。
 */
export function computeEditDiff(path: string, oldText: string, newText: string): EditDiffMeta {
  const a = oldText.length === 0 ? [] : oldText.split('\n')
  const b = newText.length === 0 ? [] : newText.split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const removed = a.length - pre - suf
  const added = b.length - pre - suf

  const lines: EditDiffLine[] = []
  for (let i = Math.max(0, pre - DIFF_CTX); i < pre; i++) lines.push({ text: a[i], tone: 'ctx' })
  const delEnd = a.length - suf
  const addEnd = b.length - suf
  for (let i = pre; i < Math.min(delEnd, pre + DIFF_SIDE_CAP); i++) lines.push({ text: a[i], tone: 'del' })
  if (delEnd - pre > DIFF_SIDE_CAP) lines.push({ text: `… 共 ${delEnd - pre} 行删除`, tone: 'ctx' })
  for (let i = pre; i < Math.min(addEnd, pre + DIFF_SIDE_CAP); i++) lines.push({ text: b[i], tone: 'add' })
  if (addEnd - pre > DIFF_SIDE_CAP) lines.push({ text: `… 共 ${addEnd - pre} 行新增`, tone: 'ctx' })
  // 变更区之后紧邻的公共尾部 ctx（a 与 b 在该区间内容一致，取 a 即可）
  for (let i = delEnd; i < Math.min(a.length - suf, delEnd + DIFF_CTX); i++) lines.push({ text: a[i], tone: 'ctx' })

  return { path, added, removed, lines }
}
