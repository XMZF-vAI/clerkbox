import fs from 'fs/promises'
import path from 'path'
import { randomBytes } from 'crypto'
import { safeStorage } from 'electron'

export const REMOTE_CREDENTIAL_MAX_BYTES = 4 * 1024 * 1024
const FILE_NAME = 'remote-access-v1.bin'

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('remote-credential-encryption-unavailable')
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend()
    if (backend === 'basic_text' || backend === 'unknown') throw new Error('remote-credential-encryption-unavailable')
  }
}

/** Dedicated encrypted storage: receipts must not consume the API-key store's small per-key budget. */
export function createRemoteCredentialStore(userDataPath: string) {
  const destination = path.join(userDataPath, FILE_NAME)
  let operations: Promise<void> = Promise.resolve()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = operations.then(operation)
    // A failed write must not prevent a later read, retry or explicit revocation.
    operations = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    read(): Promise<string | null> {
      return serial(async () => {
        let handle: Awaited<ReturnType<typeof fs.open>>
        try { handle = await fs.open(destination, 'r') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw new Error('remote-credential-read-failed')
        }
        let encrypted: Buffer
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.size < 1 || info.size > REMOTE_CREDENTIAL_MAX_BYTES) throw new Error('remote-credential-invalid')
          // Bound allocation and reading even if another process grows the file after stat.
          const buffer = Buffer.alloc(REMOTE_CREDENTIAL_MAX_BYTES + 1)
          let length = 0
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
            if (bytesRead === 0) break
            length += bytesRead
          }
          if (length < 1 || length > REMOTE_CREDENTIAL_MAX_BYTES) throw new Error('remote-credential-invalid')
          encrypted = buffer.subarray(0, length)
        } finally { await handle.close() }
        assertEncryptionAvailable()
        try {
          const value = safeStorage.decryptString(encrypted)
          if (Buffer.byteLength(value, 'utf8') > REMOTE_CREDENTIAL_MAX_BYTES) throw new Error('Oversized plaintext')
          return value
        } catch { throw new Error('remote-credential-invalid') }
      })
    },
    write(value: string): Promise<void> {
      return serial(async () => {
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > REMOTE_CREDENTIAL_MAX_BYTES) throw new Error('remote-credential-too-large')
        assertEncryptionAvailable()
        let encrypted: Buffer
        try { encrypted = safeStorage.encryptString(value) }
        catch { throw new Error('remote-credential-encryption-failed') }
        if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 || encrypted.length > REMOTE_CREDENTIAL_MAX_BYTES) throw new Error('remote-credential-too-large')
        const temporary = `${destination}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined
        try {
          await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 })
          handle = await fs.open(temporary, 'wx', 0o600)
          await handle.writeFile(encrypted)
          await handle.sync()
          await handle.close()
          handle = undefined
          // Same-directory rename publishes only a completely written ciphertext.
          // Do not fall back to copying: readers must never observe a partial replacement.
          await fs.rename(temporary, destination)
        } catch { throw new Error('remote-credential-write-failed') }
        finally {
          if (handle) await handle.close().catch(() => {})
          await fs.rm(temporary, { force: true }).catch(() => {})
        }
      })
    },
    remove(): Promise<void> {
      // Revocation must work even when the OS encryption service is unavailable.
      return serial(async () => { await fs.rm(destination, { force: true }) })
    },
  }
}
