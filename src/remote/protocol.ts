/** Shared transport contract. Cloud credentials and principal objects are never browser input. */
export const REMOTE_PROTOCOL_VERSION = 1
export const DEFAULT_REMOTE_ORIGIN = 'https://webui.clerkbox.xmzf.space'
export const REMOTE_MAX_FRAME_BYTES = 1024 * 1024
export interface RemotePrincipal {
  readonly deviceId: string
  readonly workspace: string
  readonly control: boolean
  readonly approve: boolean
  readonly files: boolean
  isActive(): boolean
}
export interface RemoteEnableOptions { workspace: string; approve: boolean; files: boolean }
export interface RemoteDeviceView { id: string; name: string; createdAt: number; lastSeenAt: number; online: boolean; control: boolean; approve: boolean; files: boolean }
export interface RemotePendingPair { id: string; name: string; code: string; requestedAt: number }
export interface RemoteAccessStatus {
  enabled: boolean
  state: 'disabled' | 'connecting' | 'online' | 'reconnecting' | 'error'
  workspace?: string
  url?: string
  inviteExpiresAt?: number
  devices: RemoteDeviceView[]
  pending: RemotePendingPair[]
  error?: string
}
export interface RemoteDeviceCredential {
  protocol: 1
  roomId: string
  deviceId: string
  token: string
  key: string
  name: string
}
export interface RemoteInvite { protocol: 1; roomId: string; token: string; key: string }
export interface EncryptedFrame { v: 1; iv: string; data: string }
export interface RemoteRequest { kind: 'request'; challenge: string; id: string; issuedAt: number; method: string; args: unknown[] }
export interface RemoteReply { kind: 'response'; challenge: string; id: string; result?: unknown; error?: string }
