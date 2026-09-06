import { useState, useRef } from 'react'
import {
  Plus, Trash2, Pencil, X, Check, AlertCircle, Loader2, Plug, FileJson, RefreshCw,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settings-store'
import { useMcpStore, syncMcpServers } from '../../stores/mcp-store'
import { ipc } from '../../lib/ipc-client'
import type { McpServerConfig, McpTransportType } from '../../types/ipc'

const inputCls =
  'w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors'

/** 解析标准 MCP 配置 JSON（兼容 Claude Desktop / Cursor 的 mcpServers 格式）；error 返回 i18n key，由调用方翻译 */
function parseMcpJson(text: string): { servers: Omit<McpServerConfig, 'id' | 'enabled'>[]; error?: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { servers: [], error: 'settings.mcp.errorParseFailed' }
  }
  if (typeof data !== 'object' || data === null) {
    return { servers: [], error: 'settings.mcp.errorRootObject' }
  }

  // {"mcpServers": {...}} 或直接的 {名称: 配置} 表；单条服务器对象也接受
  let table: Record<string, unknown> | null = null
  const obj = data as Record<string, unknown>
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    table = obj.mcpServers as Record<string, unknown>
  } else if (obj.command || obj.url) {
    table = { '': obj }
  } else {
    table = obj
  }

  const servers: Omit<McpServerConfig, 'id' | 'enabled'>[] = []
  for (const [rawName, rawEntry] of Object.entries(table)) {
    if (typeof rawEntry !== 'object' || rawEntry === null) continue
    const entry = rawEntry as Record<string, unknown>
    const name = (typeof entry.name === 'string' && entry.name) || rawName
    if (!name) continue

    if (typeof entry.command === 'string' && entry.command.trim()) {
      // stdio：command / args / env
      servers.push({
        name,
        transport: 'stdio',
        command: entry.command.trim(),
        args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : undefined,
        env: entry.env && typeof entry.env === 'object'
          ? Object.fromEntries(
              Object.entries(entry.env as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => [k, String(v)]),
            )
          : undefined,
      })
    } else if (typeof entry.url === 'string' && entry.url.trim()) {
      // http：url / headers
      servers.push({
        name,
        transport: 'http',
        url: entry.url.trim(),
        headers: entry.headers && typeof entry.headers === 'object'
          ? Object.fromEntries(
              Object.entries(entry.headers as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => [k, String(v)]),
            )
          : undefined,
      })
    }
    // 既无 command 也无 url 的条目跳过
  }

  if (servers.length === 0) {
    return { servers: [], error: 'settings.mcp.errorNoValidServer' }
  }
  return { servers }
}

/** env/headers 编辑器文本 → Record（每行一条 KEY=VALUE） */
function parseKeyValueLines(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function keyValueLines(record?: Record<string, string>): string {
  if (!record) return ''
  return Object.entries(record).map(([k, v]) => `${k}=${v}`).join('\n')
}

function argsLines(args?: string[]): string {
  return (args ?? []).join('\n')
}

function parseArgsLines(text: string): string[] | undefined {
  const args = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return args.length > 0 ? args : undefined
}

/** 服务器编辑弹窗（新建 / 编辑通用） */
function ServerDialog({
  initial,
  onClose,
  onSave,
}: {
  initial?: McpServerConfig
  onClose: () => void
  onSave: (server: McpServerConfig) => void
}) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState<McpTransportType>(initial?.transport ?? 'stdio')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [argsText, setArgsText] = useState(argsLines(initial?.args))
  const [envText, setEnvText] = useState(keyValueLines(initial?.env))
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headersText, setHeadersText] = useState(keyValueLines(initial?.headers))
  const [error, setError] = useState('')
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testResult, setTestResult] = useState('')

  const buildConfig = (): McpServerConfig | null => {
    if (!name.trim()) {
      setError(t('settings.mcp.errorName'))
      return null
    }
    if (transport === 'stdio') {
      if (!command.trim()) {
        setError(t('settings.mcp.errorCommand'))
        return null
      }
      return {
        id: initial?.id ?? `mcp-${Date.now()}`,
        name: name.trim(),
        transport,
        enabled: initial?.enabled ?? true,
        command: command.trim(),
        args: parseArgsLines(argsText),
        env: parseKeyValueLines(envText),
      }
    }
    if (!url.trim()) {
      setError(t('settings.mcp.errorUrl'))
      return null
    }
    return {
      id: initial?.id ?? `mcp-${Date.now()}`,
      name: name.trim(),
      transport,
      enabled: initial?.enabled ?? true,
      url: url.trim(),
      headers: parseKeyValueLines(headersText),
    }
  }

  const handleTest = async () => {
    const config = buildConfig()
    if (!config) return
    setTestState('testing')
    setTestResult('')
    const res = await ipc.mcpTest(config)
    if ('error' in res) {
      setTestState('fail')
      setTestResult(res.error)
    } else {
      setTestState('ok')
      setTestResult(t('settings.mcp.testOk', { count: res.toolCount }))
    }
  }

  const handleSave = () => {
    const config = buildConfig()
    if (!config) return
    onSave(config)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 rounded-md3-xl p-4" onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="w-full max-w-md max-h-full overflow-y-auto bg-dark-surfaceDim rounded-md3-lg border border-dark-onSurfaceVariant/10 p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{initial ? t('settings.mcp.editServer') : t('settings.mcp.addServer')}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-7 h-7 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant"
          >
            <X size={14} />
          </button>
        </div>

        <div>
          <label className="block text-xs text-dark-onSurfaceVariant mb-1">{t('settings.mcp.serverName')}</label>
          <input ref={nameRef} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.mcp.namePlaceholder')} autoFocus />
        </div>

        <div>
          <label className="block text-xs text-dark-onSurfaceVariant mb-1">{t('settings.mcp.transport')}</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTransport('stdio')}
              className={`flex-1 px-3 py-1.5 rounded-md3-sm text-xs border transition-colors ${
                transport === 'stdio'
                  ? 'bg-md-primary/10 border-md-primary/40 text-md-primary'
                  : 'border-dark-onSurfaceVariant/15 text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
              }`}
            >
              {t('settings.mcp.transportStdio')}
            </button>
            <button
              type="button"
              onClick={() => setTransport('http')}
              className={`flex-1 px-3 py-1.5 rounded-md3-sm text-xs border transition-colors ${
                transport === 'http'
                  ? 'bg-md-primary/10 border-md-primary/40 text-md-primary'
                  : 'border-dark-onSurfaceVariant/15 text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'
              }`}
            >
              {t('settings.mcp.transportHttp')}
            </button>
          </div>
        </div>

        {transport === 'stdio' ? (
          <>
            <div>
              <label className="block text-xs text-dark-onSurfaceVariant mb-1">{t('settings.mcp.command')}</label>
              <input className={inputCls} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx / uvx / node" />
            </div>
            <div>
              <label className="block text-xs text-dark-onSurfaceVariant mb-1">{t('settings.mcp.args')}</label>
              <textarea className={`${inputCls} font-mono text-xs`} rows={3} value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem'} />
            </div>
            <div>
              <label className="block text-xs text-dark-onSurfaceVariant mb-1">{t('settings.mcp.env')}</label>
              <textarea className={`${inputCls} font-mono text-xs`} rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'API_KEY=xxx'} />
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="block text-xs text-dark-onSurfaceVariant mb-1">URL</label>
              <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
            </div>
            <div>
              <label className="block text-xs text-dark-onSurfaceVariant mb-1">{t('settings.mcp.headers')}</label>
              <textarea className={`${inputCls} font-mono text-xs`} rows={2} value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder={'Authorization=Bearer xxx'} />
            </div>
          </>
        )}

        {error && (
          <div role="alert" className="flex items-center gap-1.5 text-xs text-md-error">
            <AlertCircle size={13} /> {error}
          </div>
        )}
        {testState === 'ok' && (
          <div role="status" className="flex items-center gap-1.5 text-xs text-md-success">
            <Check size={13} /> {testResult}
          </div>
        )}
        {testState === 'fail' && (
          <div role="alert" className="flex items-start gap-1.5 text-xs text-md-error">
            <AlertCircle size={13} className="flex-shrink-0 mt-0.5" /> <span className="break-all">{testResult}</span>
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={handleTest}
            disabled={testState === 'testing' || !name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())}
            className="flex items-center gap-1 px-3 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors disabled:opacity-50"
          >
            {testState === 'testing' ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
            {testState === 'testing' ? t('settings.mcp.testing') : t('settings.mcp.test')}
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors">
              {t('common.cancel')}
            </button>
            <button type="button" onClick={handleSave} className="px-3 py-1.5 bg-md-primary text-md-onPrimary rounded-md3-sm text-xs font-medium hover:bg-md-primary/90 transition-colors">
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** JSON 导入弹窗：粘贴标准 mcpServers 配置批量添加 */
function ImportDialog({
  onClose,
  onImport,
}: {
  onClose: () => void
  onImport: (servers: Omit<McpServerConfig, 'id' | 'enabled'>[]) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }

  const handleImport = () => {
    const { servers, error } = parseMcpJson(text)
    if (error) {
      setError(t(error))
      return
    }
    onImport(servers)
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 rounded-md3-xl p-4" onKeyDown={handleKeyDown}>
      <div
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="w-full max-w-md max-h-full overflow-y-auto bg-dark-surfaceDim rounded-md3-lg border border-dark-onSurfaceVariant/10 p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('settings.mcp.importTitle')}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-7 h-7 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainerHigh text-dark-onSurfaceVariant"
          >
            <X size={14} />
          </button>
        </div>
        <p className="text-xs text-dark-onSurfaceVariant leading-relaxed">{t('settings.mcp.importHint')}</p>
        <textarea
          className={`${inputCls} font-mono text-xs`}
          rows={8}
          value={text}
          onChange={(e) => { setText(e.target.value); setError('') }}
          placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]\n    }\n  }\n}'}
          autoFocus
        />
        {error && (
          <div role="alert" className="flex items-center gap-1.5 text-xs text-md-error">
            <AlertCircle size={13} /> {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!text.trim()}
            className="px-3 py-1.5 bg-md-primary text-md-onPrimary rounded-md3-sm text-xs font-medium hover:bg-md-primary/90 transition-colors disabled:opacity-50"
          >
            {t('settings.mcp.importButton')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 状态点：connected 绿 / connecting 黄 / error 红 / disabled 灰 */
function StateDot({ state }: { state: string }) {
  const cls =
    state === 'connected' ? 'bg-md-success'
    : state === 'connecting' ? 'bg-yellow-500 animate-pulse'
    : state === 'error' ? 'bg-md-error'
    : 'bg-dark-onSurfaceVariant/40'
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cls}`} aria-hidden />
}

const STATE_LABEL_KEY: Record<string, string> = {
  connected: 'settings.mcp.stateConnected',
  connecting: 'settings.mcp.stateConnecting',
  error: 'settings.mcp.stateError',
  disabled: 'settings.mcp.stateDisabled',
}

export default function McpSection() {
  const { t } = useTranslation()
  const settings = useSettingsStore()
  const statuses = useMcpStore((s) => s.statuses)
  const syncing = useMcpStore((s) => s.syncing)
  const [editing, setEditing] = useState<McpServerConfig | 'new' | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const saveServer = (server: McpServerConfig) => {
    const exists = settings.mcpServers.some((s) => s.id === server.id)
    settings.updateSettings({
      mcpServers: exists
        ? settings.mcpServers.map((s) => (s.id === server.id ? server : s))
        : [...settings.mcpServers, server],
    })
    setEditing(null)
  }

  const importServers = (servers: Omit<McpServerConfig, 'id' | 'enabled'>[]) => {
    const added = servers.map((s) => ({ ...s, id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, enabled: true }))
    settings.updateSettings({ mcpServers: [...settings.mcpServers, ...added] })
    setShowImport(false)
  }

  const removeServer = (id: string) => {
    settings.updateSettings({ mcpServers: settings.mcpServers.filter((s) => s.id !== id) })
    setRemoving(null)
  }

  const toggleServer = (server: McpServerConfig) => {
    settings.updateSettings({
      mcpServers: settings.mcpServers.map((s) =>
        s.id === server.id ? { ...s, enabled: !s.enabled } : s,
      ),
    })
  }

  return (
    <div className="space-y-5">
      {/* 说明 + 操作按钮 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium">{t('settings.mcp.title')}</label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void syncMcpServers(settings.mcpServers)}
              disabled={syncing}
              title={t('settings.mcp.refresh')}
              className="w-7 h-7 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md3-sm text-xs text-md-primary hover:bg-md-primary/10 transition-colors"
            >
              <FileJson size={13} />
              {t('settings.mcp.importButton')}
            </button>
            <button
              type="button"
              onClick={() => setEditing('new')}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-md3-sm text-xs text-md-primary hover:bg-md-primary/10 transition-colors"
            >
              <Plus size={13} />
              {t('settings.mcp.addServer')}
            </button>
          </div>
        </div>
        <p className="text-xs text-dark-onSurfaceVariant leading-relaxed">{t('settings.mcp.desc')}</p>
      </div>

      {/* 服务器列表 */}
      {settings.mcpServers.length === 0 ? (
        <div className="text-xs text-dark-onSurfaceVariant px-4 py-8 rounded-md3-md border border-dashed border-dark-onSurfaceVariant/15 text-center">
          {t('settings.mcp.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {settings.mcpServers.map((server) => {
            const status = statuses.find((s) => s.id === server.id)
            const state = server.enabled ? (status?.state ?? 'connecting') : 'disabled'
            return (
              <div key={server.id} className="flex items-center gap-3 px-4 py-3 rounded-md3-md bg-dark-surfaceContainer border border-dark-onSurfaceVariant/5">
                <StateDot state={state} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-dark-onSurface truncate">{server.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-dark-surfaceContainerHighest text-dark-onSurfaceVariant flex-shrink-0">
                      {server.transport === 'stdio' ? t('settings.mcp.transportStdio') : 'HTTP'}
                    </span>
                  </div>
                  <div className="text-xs text-dark-onSurfaceVariant truncate">
                    {server.transport === 'stdio' ? server.command : server.url}
                    {state === 'connected' && status ? ` · ${t('settings.mcp.toolCount', { count: status.toolCount })}` : ''}
                    {state === 'connecting' ? ` · ${t('settings.mcp.stateConnecting')}` : ''}
                    {state === 'error' && status?.error ? ` · ${status.error}` : ''}
                    {state === 'disabled' ? ` · ${t('settings.mcp.stateDisabled')}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={server.enabled}
                  aria-label={t('settings.mcp.toggleEnabled')}
                  onClick={() => toggleServer(server)}
                  className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${server.enabled ? 'bg-md-primary' : 'bg-dark-surfaceContainerHighest'}`}
                >
                  <span
                    className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${server.enabled ? 'left-[16px]' : 'left-[2px]'}`}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(server)}
                  aria-label={t('settings.mcp.editServer')}
                  title={t('settings.mcp.editServer')}
                  className="w-7 h-7 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors flex-shrink-0"
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setRemoving(server.id)}
                  aria-label={t('settings.mcp.removeServer')}
                  title={t('settings.mcp.removeServer')}
                  className="w-7 h-7 flex items-center justify-center rounded-md3-sm text-dark-onSurfaceVariant hover:bg-md-error/10 hover:text-md-error transition-colors flex-shrink-0"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* 删除确认 */}
      {removing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="alertdialog" aria-modal="true" className="w-full max-w-xs bg-dark-surfaceDim rounded-md3-lg border border-dark-onSurfaceVariant/10 p-5 space-y-4">
            <p className="text-sm">{t('settings.mcp.removeConfirm')}</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRemoving(null)} className="px-3 py-1.5 rounded-md3-sm text-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors">
                {t('common.cancel')}
              </button>
              <button type="button" onClick={() => removeServer(removing)} className="px-3 py-1.5 bg-md-error text-white rounded-md3-sm text-xs font-medium hover:bg-md-error/90 transition-colors">
                {t('settings.mcp.removeServer')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 添加/编辑弹窗 */}
      {editing && (
        <ServerDialog
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={saveServer}
        />
      )}

      {/* JSON 导入弹窗 */}
      {showImport && (
        <ImportDialog onClose={() => setShowImport(false)} onImport={importServers} />
      )}
    </div>
  )
}
