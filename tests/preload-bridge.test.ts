import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * preload 桥接面的完整性守卫。
 *
 * `contextBridge.exposeInMainWorld` 暴露的是一个**平面对象**，而 `src/types/ipc.ts`
 * 的 `ClerkBoxAPI` 只是它的类型声明 —— 两者没有任何机制保证同步。加了 handler、
 * 加了类型、加了 ipc-client 包装，唯独忘了在 preload 里加那一行，
 * 运行时就是 `window.clerkbox.xxx is not a function`，而且只在真机上、只在点到那条路径时才炸。
 *
 * 这条测试从三个源文件各自抽出「契约名」，比对它们是否一致：
 *   - `src/types/ipc.ts` 的 ClerkBoxAPI 成员（声明了什么）
 *   - `electron/preload.ts` 的 exposeInMainWorld 键（真正桥接了什么）
 *   - `src/lib/ipc-client.ts` 对 window.clerkbox.X 的引用（谁在用）
 */

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf-8')

const IPC_TYPES = read('src/types/ipc.ts')
const PRELOAD = read('electron/preload.ts')
const IPC_CLIENT = read('src/lib/ipc-client.ts')

/** ClerkBoxAPI 内的成员名（缩进 2 空格的属性签名） */
function declaredApiMembers(): Set<string> {
  const anchor = IPC_TYPES.indexOf('interface ClerkBoxAPI')
  expect(anchor, 'types/ipc.ts 里找不到 ClerkBoxAPI').toBeGreaterThan(-1)
  const body = IPC_TYPES.slice(anchor, IPC_TYPES.indexOf('\n}', anchor))
  const members = new Set<string>()
  for (const line of body.split('\n')) {
    const match = /^ {2}([A-Za-z][A-Za-z0-9_]*)[?]?:/.exec(line)
    if (match?.[1]) members.add(match[1])
  }
  return members
}

/** exposeInMainWorld 对象里的顶层键 */
function bridgedKeys(): Set<string> {
  const anchor = PRELOAD.indexOf("exposeInMainWorld(")
  expect(anchor, 'preload 里找不到 exposeInMainWorld').toBeGreaterThan(-1)
  const keys = new Set<string>()
  let depth = 0
  // 顶层键的缩进（prettier 下恒为 2 空格）。多行箭头函数的**参数行**缩进更深，
  // 例如 `command: string,` / `cwd?: string,` —— 它们处于深度 1 但不是键，
  // 所以必须用缩进把它们排除掉，只看花括号深度会误收。
  let topIndent: number | null = null
  for (const line of PRELOAD.slice(anchor).split('\n')) {
    const indent = line.length - line.trimStart().length
    if (depth === 1) {
      if (topIndent === null && indent > 0 && /^\s*[A-Za-z][A-Za-z0-9_]*\s*:/.test(line)) {
        topIndent = indent
      }
      if (topIndent !== null && indent === topIndent) {
        const match = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:/.exec(line)
        if (match?.[1]) keys.add(match[1])
      }
    }
    for (const char of line) {
      if (char === '{') depth++
      else if (char === '}') depth--
    }
  }
  return keys
}

const declared = declaredApiMembers()
const bridged = bridgedKeys()

describe('preload bridge completeness', () => {
  it('两个提取器都真的提取到了东西（写法变了要先炸，避免静默失效）', () => {
    expect(declared.size).toBeGreaterThan(50)
    expect(bridged.size).toBeGreaterThan(50)
  })

  it('ClerkBoxAPI 声明的每个成员都在 preload 里桥接了', () => {
    const missing = [...declared].filter((name) => !bridged.has(name))
    expect(missing, `这些方法只存在于类型声明里，运行时会报 is not a function: ${missing.join(', ')}`).toEqual([])
  })

  it('preload 桥接的每个键都在 ClerkBoxAPI 里有类型（反向也要一致）', () => {
    const extra = [...bridged].filter((name) => !declared.has(name))
    expect(extra, `这些键没有类型声明，渲染层拿不到类型: ${extra.join(', ')}`).toEqual([])
  })

  it('Agent 动作通道的三个 invoke 确实桥接了（这条 bug 已经发生过一次）', () => {
    for (const channel of ['agentBrowserCommand', 'agentBrowserReady', 'computerUseCommand']) {
      expect(bridged, channel).toContain(channel)
      expect(PRELOAD, channel).toContain(`ipcRenderer.invoke('${channel === 'agentBrowserCommand' ? 'agentBrowser:command' : channel === 'agentBrowserReady' ? 'agentBrowser:ready' : 'computerUse:command'}'`)
    }
  })

  it('Agent 动作通道的两个事件订阅确实桥接了', () => {
    for (const name of ['onAgentBrowserOperation', 'onComputerUseOperation']) {
      expect(bridged, name).toContain(name)
      expect(PRELOAD, name).toContain(`ipcRenderer.removeListener('${name === 'onAgentBrowserOperation' ? 'agentBrowser:operation' : 'computerUse:operation'}'`)
    }
  })

  it('ipc-client 里 window.clerkbox.X 的每个 X 都有 preload 桥接', () => {
    const used = new Set<string>()
    for (const match of IPC_CLIENT.matchAll(/window\.clerkbox\.([A-Za-z][A-Za-z0-9_]*)/g)) {
      if (match[1]) used.add(match[1])
    }
    expect(used.size).toBeGreaterThan(20)
    const missing = [...used].filter((name) => !bridged.has(name))
    expect(missing, `ipc-client 引用了未桥接的成员: ${missing.join(', ')}`).toEqual([])
  })
})
