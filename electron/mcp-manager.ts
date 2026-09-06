/**
 * MCP (Model Context Protocol) 客户端管理器 —— 运行在主进程。
 *
 * - 持有所有已启用 MCP 服务器的长连接（stdio 子进程 / HTTP）
 * - 对渲染进程提供：配置同步、状态查询、临时测试、聚合工具清单、工具调用
 * - 状态变化通过 'mcp:statusChanged' 事件推送给渲染进程
 */
import { app, BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
} from '../src/types/ipc'

/** 连接超时：stdio 首次 npx 拉包可能较慢，给足时间 */
const CONNECT_TIMEOUT_MS = 60_000
/** 工具调用超时 */
const CALL_TIMEOUT_MS = 120_000
/** 工具返回内容上限（防止超大结果撑爆上下文） */
const MAX_RESULT_CHARS = 60_000

interface ManagedConnection {
  config: McpServerConfig
  /** 建连时的配置指纹（用于识别配置变更触发重连） */
  fingerprint?: string
  client: Client | null
  state: 'connecting' | 'connected' | 'error'
  tools: McpToolInfo[]
  error?: string
}

/** 服务器名 → 工具前缀（仅保留字母数字与连字符，小写） */
export function mcpServerSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'server'
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/** 建立 Client 连接（stdio 或 HTTP，HTTP 自动回退 SSE）。
 *  onClient：client 一经创建立即回调，让调用方持有引用 —— 连接超时/失败时
 *  可回收半成品连接（尤其是 stdio 已 spawn 的子进程），避免僵尸进程。 */
async function createClient(config: McpServerConfig, onClient?: (client: Client) => void): Promise<Client> {
  const client = new Client({ name: 'ClerkBox', version: app.getVersion() })
  onClient?.(client)

  if (config.transport === 'stdio') {
    if (!config.command?.trim()) throw new Error('缺少启动命令（command）')
    const transport = new StdioClientTransport({
      command: config.command.trim(),
      args: (config.args ?? []).filter((a) => typeof a === 'string'),
      env: config.env && Object.keys(config.env).length > 0 ? { ...config.env } : undefined,
      stderr: 'pipe',
    })
    // 把子进程 stderr 转发到主进程日志（排障用：npx 拉包失败等信息在这里）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stderrAny = (transport as any)._stderrStream
    if (stderrAny && typeof stderrAny.on === 'function') {
      stderrAny.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) console.warn(`[MCP:${config.name}:stderr] ${text}`)
      })
    }
    await client.connect(transport)
    return client
  }

  if (!config.url?.trim()) throw new Error('缺少服务器 URL')
  const headers = config.headers && Object.keys(config.headers).length > 0
    ? { ...config.headers } as Record<string, string>
    : undefined
  const url = new URL(config.url.trim())
  const requestInit = headers ? { headers } : undefined

  // 先按 streamable-http 连，4xx 再回退老 SSE 协议
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }))
    return client
  } catch (httpError) {
    const fallback = new Client({ name: 'ClerkBox', version: app.getVersion() })
    onClient?.(fallback)
    try {
      await fallback.connect(new SSEClientTransport(url, { requestInit }))
      return fallback
    } catch {
      throw httpError instanceof Error ? httpError : new Error(String(httpError))
    }
  }
}

/** 拉取服务器工具清单并转为 mcp__<server>__<tool> 命名 */
async function fetchTools(client: Client, config: McpServerConfig): Promise<McpToolInfo[]> {
  const result = await client.listTools()
  const slug = mcpServerSlug(config.name)
  return (result.tools ?? []).map((tool) => ({
    name: `mcp__${slug}__${tool.name}`,
    description: `[MCP:${config.name}] ${tool.description || tool.name}`,
    parameters: (tool.inputSchema as object) ?? { type: 'object', properties: {} },
  }))
}

/** 把 callTool 结果内容压成字符串 */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) {
    if (typeof content === 'string') return content
    return JSON.stringify(content ?? '')
  }
  const parts: string[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else {
      parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n')
}

export class McpManager {
  private connections = new Map<string, ManagedConnection>()
  private mainWindow: BrowserWindow | null = null
  private disposed = false

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  /** 全量同步：新增/变更的连接、消失的断开。并发调用会串行排队。 */
  private syncQueue: Promise<unknown> = Promise.resolve()
  sync(configs: McpServerConfig[]): Promise<McpServerStatus[]> {
    const run = async (): Promise<McpServerStatus[]> => {
      if (this.disposed) return this.statuses()
      const wanted = new Map(
        configs
          .filter((c) => c && c.id && c.name)
          .map((c) => [c.id, c] as const),
      )

      // 1. 断开已移除的
      for (const [id, conn] of this.connections) {
        if (!wanted.has(id)) {
          void this.closeConnection(conn).catch(() => {})
          this.connections.delete(id)
        }
      }

      // 2. 连接新增 / 重连变更的（序列化配置一致则跳过）
      for (const [id, config] of wanted) {
        const existing = this.connections.get(id)
        const fingerprint = JSON.stringify(this.fingerprintOf(config))
        if (existing && existing.fingerprint !== fingerprint) {
          void this.closeConnection(existing).catch(() => {})
          this.connections.delete(id)
        }
        if (!this.connections.has(id)) {
          this.connectOne(config, fingerprint)
        }
      }

      // 3. 等待本轮连接尘埃落定（最长等全部 connecting 完成）
      const deadline = Date.now() + CONNECT_TIMEOUT_MS + 5_000
      while (Date.now() < deadline) {
        const pending = [...this.connections.values()].filter((c) => c.state === 'connecting')
        if (pending.length === 0) break
        await new Promise((r) => setTimeout(r, 200))
      }
      return this.statuses()
    }
    const next = this.syncQueue.then(run, run)
    this.syncQueue = next.catch(() => {})
    return next
  }

  /** fingerprint：参与连接的实质字段（enabled 不参与，由调用方过滤或连接层处理） */
  private fingerprintOf(config: McpServerConfig): string {
    const { id: _id, name: _name, enabled: _enabled, ...rest } = config
    return JSON.stringify(rest)
  }

  private connectOne(config: McpServerConfig, fingerprint: string): void {
    const conn: ManagedConnection = {
      config: { ...config },
      fingerprint,
      client: null,
      state: config.enabled ? 'connecting' : 'error',
      tools: [],
      error: config.enabled ? undefined : '已停用',
    }
    if (!config.enabled) {
      conn.state = 'error'
      conn.error = '已停用'
      this.connections.set(config.id, conn)
      return
    }
    this.connections.set(config.id, conn)
    this.broadcast()

    void (async () => {
      // 持有半成品 client 引用：withTimeout 超时后 createClient 仍在后台进行，
      // stdio 子进程可能已 spawn，必须在失败分支回收，否则沦为无人管理的僵尸进程
      let pendingClient: Client | null = null
      // 经函数读取规避 TS 窄化误判：TS 看不到回调内的赋值，会把 catch 分支的
      // pendingClient 误窄化为 null
      const getPendingClient = (): Client | null => pendingClient
      try {
        const client = await withTimeout(
          createClient(config, (c) => { pendingClient = c }),
          CONNECT_TIMEOUT_MS,
          '连接 MCP 服务器',
        )
        pendingClient = null
        if (this.disposed || this.connections.get(config.id) !== conn) {
          await client.close().catch(() => {})
          return
        }
        conn.client = client
        conn.tools = await fetchTools(client, config)
        conn.state = 'connected'
        conn.error = undefined
      } catch (error) {
        // 超时/连接失败：关闭半成品连接回收子进程（close 可能再抛错，吞掉即可）
        void getPendingClient()?.close().catch(() => {})
        conn.state = 'error'
        conn.error = error instanceof Error ? error.message : String(error)
      }
      this.broadcast()
    })()
  }

  statuses(): McpServerStatus[] {
    return [...this.connections.values()].map((conn) => ({
      id: conn.config.id,
      name: conn.config.name,
      transport: conn.config.transport,
      enabled: conn.config.enabled,
      state: conn.config.enabled ? conn.state : 'disabled',
      toolCount: conn.tools.length,
      tools: conn.tools,
      error: conn.config.enabled ? conn.error : undefined,
    }))
  }

  /** 聚合所有已连接服务器的工具（对话注入用） */
  allTools(): McpToolInfo[] {
    const tools: McpToolInfo[] = []
    for (const conn of this.connections.values()) {
      if (conn.state === 'connected' && conn.config.enabled) tools.push(...conn.tools)
    }
    return tools
  }

  /** 按 mcp__<server>__<tool> 全名调用 */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const parts = toolName.split('__')
    if (parts.length < 3 || parts[0] !== 'mcp') {
      return { content: `Error: 非法的 MCP 工具名 "${toolName}"`, isError: true }
    }
    const slug = parts[1]
    const tool = parts.slice(2).join('__')
    const conn = [...this.connections.values()].find(
      (c) => c.config.enabled && mcpServerSlug(c.config.name) === slug && c.state === 'connected',
    )
    if (!conn?.client) {
      return { content: `Error: MCP 服务器 "${slug}" 未连接，无法调用 ${toolName}`, isError: true }
    }
    try {
      const result = await withTimeout(
        conn.client.callTool({ name: tool, arguments: args ?? {} }),
        CALL_TIMEOUT_MS,
        `MCP 工具调用 ${toolName}`,
      )
      let text = flattenContent((result as { content?: unknown }).content)
      if (text.length > MAX_RESULT_CHARS) {
        text = text.slice(0, MAX_RESULT_CHARS) + '\n\n... [MCP 工具返回内容过长，已截断]'
      }
      return { content: text, isError: result.isError === true }
    } catch (error) {
      return {
        content: `Error: MCP 工具调用失败 ${toolName} - ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  }

  /** 临时测试一条配置：连接 → 列工具 → 断开 */
  async test(config: McpServerConfig): Promise<{ ok: true; toolCount: number; tools: Array<{ name: string; description: string }> } | { error: string }> {
    let client: Client | null = null
    try {
      // onClient 让 client 在创建后立即被引用：连接超时时 finally 也能关闭
      // 已 spawn stdio 子进程的半成品连接，避免僵尸进程
      client = await withTimeout(
        createClient(config, (c) => { client = c }),
        CONNECT_TIMEOUT_MS,
        '连接 MCP 服务器',
      )
      const tools = await fetchTools(client, config)
      return {
        ok: true,
        toolCount: tools.length,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (client) await client.close().catch(() => {})
    }
  }

  private async closeConnection(conn: ManagedConnection): Promise<void> {
    if (conn.client) {
      await conn.client.close().catch(() => {})
      conn.client = null
    }
  }

  private broadcast(): void {
    const win = this.mainWindow
    if (win && !win.isDestroyed()) {
      win.webContents.send('mcp:statusChanged', this.statuses())
    }
  }

  /** 应用退出前清理全部子进程 */
  async disposeAll(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.connections.values()].map((conn) => this.closeConnection(conn)))
    this.connections.clear()
  }
}

export const mcpManager = new McpManager()
