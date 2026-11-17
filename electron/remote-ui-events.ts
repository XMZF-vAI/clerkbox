/** Host UI notifications for authenticated, paired workbench clients. */
export interface RemoteUiEvent { channel: string; args: unknown[] }
const listeners = new Set<(event: RemoteUiEvent) => void>()
const CHANNELS = new Set(['pty:data', 'pty:exit', 'mcp:statusChanged', 'joule:state', 'shared:changed', 'bots:changed', 'bots:status', 'bots:weixinQr'])

export function publishRemoteUiEvent(channel: string, ...args: unknown[]): void {
  if (!CHANNELS.has(channel)) return
  for (const listener of listeners) {
    try { listener({ channel, args }) } catch { /* One device cannot stop host notifications. */ }
  }
}

export function subscribeRemoteUiEvents(listener: (event: RemoteUiEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
