import type { EncryptedFrame } from './protocol'

export function randomHex(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)))
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}
function fromHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) throw new Error('Invalid encrypted message')
  return Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16))
}
export async function sha256Hex(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}
async function importKey(key: string): Promise<CryptoKey> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid encryption key')
  return crypto.subtle.importKey('raw', fromHex(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function seal(key: string, value: unknown): Promise<EncryptedFrame> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(value))
  if (data.byteLength > 480 * 1024) throw new Error('Remote message too large')
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key), data)
  return { v: 1, iv: toHex(iv), data: toHex(new Uint8Array(encrypted)) }
}
export async function open<T = Record<string, unknown>>(key: string, value: unknown): Promise<T> {
  const frame = value as Partial<EncryptedFrame> | null
  if (!frame || frame.v !== 1 || typeof frame.iv !== 'string' || !/^[a-f0-9]{24}$/.test(frame.iv) || typeof frame.data !== 'string' || frame.data.length > 984000) throw new Error('Invalid encrypted message')
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(frame.iv) }, await importKey(key), fromHex(frame.data))
  return JSON.parse(new TextDecoder().decode(decrypted)) as T
}
