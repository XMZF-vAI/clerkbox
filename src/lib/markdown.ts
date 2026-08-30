/**
 * 轻量 Markdown → HTML 渲染器（无第三方依赖）。
 *
 * 从 MessageItem.tsx 抽出：这是 dangerouslySetInnerHTML 的唯一入口，
 * 即聊天内容的 **XSS 边界**。安全约定：
 *  - 所有插值文本先经 escapeHtml 转义；
 *  - 链接 href 经 sanitizeLinkHref 协议白名单（http/mailto/相对锚点）过滤；
 *  - 代码块整体转义，不做语法高亮。
 * 修改渲染规则时必须保持以上不变量，并回归测试 javascript:/onerror= 等注入向量。
 */

export function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeLang = ''
  let codeLines: string[] = []
  let inList = false
  let inOrderedList = false
  let inTable = false
  let tableRows: string[] = []

  const closeList = () => {
    if (inList) { result.push('</ul>'); inList = false }
    if (inOrderedList) { result.push('</ol>'); inOrderedList = false }
  }

  const closeTable = () => {
    if (!inTable) return
    // A table requires a header and a separator row to avoid dropping plain text.
    // 否则这不是合法 markdown 表格，回退为普通段落渲染，避免数据丢失。
    if (tableRows.length >= 2 && isTableSeparatorLine(tableRows[1])) {
      result.push('<table class="markdown-table"><thead><tr>')
      const headerCells = splitTableCells(tableRows[0])
      headerCells.forEach((cell) => {
        result.push(`<th>${inlineFormat(cell.trim())}</th>`)
      })
      result.push('</tr></thead><tbody>')
      for (let r = 2; r < tableRows.length; r++) {
        result.push('<tr>')
        splitTableCells(tableRows[r]).forEach((cell) => {
          result.push(`<td>${inlineFormat(cell.trim())}</td>`)
        })
        result.push('</tr>')
      }
      result.push('</tbody></table>')
    } else {
      // 回退为段落渲染
      tableRows.forEach((row) => {
        result.push(`<p>${inlineFormat(row)}</p>`)
      })
    }
    inTable = false
    tableRows = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      closeList()
      closeTable()
      if (inCodeBlock) {
        result.push(`<pre class="code-block"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
        inCodeBlock = false
        codeLines = []
        codeLang = ''
        continue
      } else {
        inCodeBlock = true
        codeLang = line.trim().slice(3)
        codeLines = []
        continue
      }
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)/)
    if (headingMatch) {
      closeList()
      closeTable()
      const level = headingMatch[1].length
      result.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`)
      continue
    }

    const ulMatch = line.match(/^[\s]*[-*+]\s+(.+)/)
    if (ulMatch) {
      closeTable()
      if (inOrderedList) { closeList() }
      if (!inList) { result.push('<ul>'); inList = true }
      result.push(`<li>${inlineFormat(ulMatch[1])}</li>`)
      continue
    }

    const olMatch = line.match(/^[\s]*\d+\.\s+(.+)/)
    if (olMatch) {
      closeTable()
      if (inList) { closeList() }
      if (!inOrderedList) { result.push('<ol>'); inOrderedList = true }
      result.push(`<li>${inlineFormat(olMatch[1])}</li>`)
      continue
    }

    if (/^[-*_]{3,}$/.test(line.trim())) {
      closeList()
      closeTable()
      result.push('<hr />')
      continue
    }

    const bqMatch = line.match(/^>\s*(.*)/)
    if (bqMatch) {
      closeList()
      closeTable()
      result.push(`<blockquote>${inlineFormat(bqMatch[1])}</blockquote>`)
      continue
    }

    if (isTableLine(line)) {
      closeList()
      if (!inTable) inTable = true
      tableRows.push(line)
      continue
    } else if (inTable) {
      closeTable()
    }

    if (line.trim() === '') {
      closeList()
      closeTable()
      continue
    }

    closeList()
    closeTable()
    result.push(`<p>${inlineFormat(line)}</p>`)
  }

  closeList()
  closeTable()
  if (inCodeBlock) {
    result.push(`<pre class="code-block"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
  }

  return result.join('')
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return false
  // 至少有一个非空 cell（避免把单个 "|" 当表格）
  const cells = trimmed.split('|').filter((s) => s.trim() !== '')
  return cells.length >= 1
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return false
  // 去掉首尾的 | 后，所有 cell 必须只含 - / : / | / 空格，且至少有一个 - 字符
  const cells = trimmed.split('|').filter((s) => s.trim() !== '')
  if (cells.length === 0) return false
  return cells.every((c) => /^[-:|\s]+$/.test(c.trim()) && c.includes('-'))
}

function splitTableCells(line: string): string[] {
  return line
    .split('|')
    .map((s) => s.trim())
    .filter((s, i, arr) => {
      if (i === 0 || i === arr.length - 1) return s !== ''
      return true
    })
}

function inlineFormat(text: string): string {
  let html = escapeHtml(text)
  const protectedHtml: string[] = []
  const protect = (value: string) => {
    const index = protectedHtml.push(value) - 1
    return `\uE000${index}\uE000`
  }

  html = html.replace(/`([^`]+)`/g, (_match, code: string) => protect(`<code class="inline-code">${code}</code>`))
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const safeHref = sanitizeLinkHref(href)
    return protect(safeHref ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>` : label)
  })
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>')
  html = html.replace(/\uE000(\d+)\uE000/g, (_match, index: string) => protectedHtml[Number(index)] || '')
  return html
}

function sanitizeLinkHref(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || /[\u0000-\u001F\u007F\s]/.test(trimmed)) return null
  if (/[<>"']/.test(trimmed)) return null
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (/^(#|\/|\.\/|\.\.\/)/.test(trimmed)) return trimmed
  return null
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
