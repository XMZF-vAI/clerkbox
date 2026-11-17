import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const h = vi.hoisted(() => ({
  available: vi.fn(() => true),
  backend: vi.fn(() => 'gnome_libsecret'),
  encrypt: vi.fn((value: string) => Buffer.concat([Buffer.from([0x81, 0x43, 0x42]), Buffer.from(value, 'utf8').map(byte => byte ^ 0xa5)])),
  decrypt: vi.fn((value: Buffer) => {
    if (!value.subarray(0, 3).equals(Buffer.from([0x81, 0x43, 0x42]))) throw new Error('Unable to decrypt')
    return Buffer.from(value.subarray(3).map(byte => byte ^ 0xa5)).toString('utf8')
  }),
}))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: h.available, getSelectedStorageBackend: h.backend, encryptString: h.encrypt, decryptString: h.decrypt } }))

import { createRemoteCredentialStore, REMOTE_CREDENTIAL_MAX_BYTES } from '../electron/remote-credential-store'

let directory: string
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clerkbox-remote-credential-'))
  vi.clearAllMocks()
  h.available.mockReturnValue(true)
  h.backend.mockReturnValue('gnome_libsecret')
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})
const destination = () => path.join(directory, 'remote-access-v1.bin')

describe('dedicated encrypted remote credential storage', () => {
  it('returns null for missing storage without creating any files', async () => {
    const store = createRemoteCredentialStore(directory)
    expect(await store.read()).toBeNull()
    expect(await fs.readdir(directory)).toEqual([])
    expect(h.decrypt).not.toHaveBeenCalled()
  })

  it('persists only ciphertext and round-trips across store instances', async () => {
    const value = JSON.stringify({ roomId: 'room', token: 'test-device-token', key: 'test-device-key' })
    await createRemoteCredentialStore(directory).write(value)
    const bytes = await fs.readFile(destination())
    expect(bytes.includes(Buffer.from(value))).toBe(false)
    expect(bytes.includes(Buffer.from('test-device-token'))).toBe(false)
    expect(await createRemoteCredentialStore(directory).read()).toBe(value)
    expect(await fs.readdir(directory)).toEqual(['remote-access-v1.bin'])
    if (process.platform !== 'win32') expect((await fs.stat(destination())).mode & 0o777).toBe(0o600)
  })

  it('supports the remote receipt budget beyond the API-key 16 KiB limit', async () => {
    const store = createRemoteCredentialStore(directory)
    const value = JSON.stringify({ receipts: Array.from({ length: 2000 }, (_, index) => ({ id: index, state: 'done', result: { received: 131072 } })) })
    expect(Buffer.byteLength(value)).toBeGreaterThan(16 * 1024)
    await store.write(value)
    expect(await store.read()).toBe(value)
  })

  it('rejects unavailable encryption without replacing an existing file', async () => {
    const store = createRemoteCredentialStore(directory)
    await store.write('original')
    const before = await fs.readFile(destination())
    h.available.mockReturnValue(false)
    await expect(store.write('replacement')).rejects.toThrow('remote-credential-encryption-unavailable')
    await expect(store.read()).rejects.toThrow('remote-credential-encryption-unavailable')
    expect(await fs.readFile(destination())).toEqual(before)
    expect(await fs.readdir(directory)).toEqual(['remote-access-v1.bin'])
  })

  it.each(['basic_text', 'unknown'])('refuses Linux %s storage instead of plaintext fallback', async backend => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
    h.backend.mockReturnValue(backend)
    await expect(createRemoteCredentialStore(directory).write('sensitive')).rejects.toThrow('remote-credential-encryption-unavailable')
    expect(await fs.readdir(directory)).toEqual([])
    expect(h.encrypt).not.toHaveBeenCalled()
  })

  it('enforces the UTF-8 plaintext limit before encryption', async () => {
    const store = createRemoteCredentialStore(directory)
    await expect(store.write('界'.repeat(Math.ceil(REMOTE_CREDENTIAL_MAX_BYTES / 3)))).rejects.toThrow('remote-credential-too-large')
    expect(h.encrypt).not.toHaveBeenCalled()
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('enforces the encrypted file limit before publishing it', async () => {
    const store = createRemoteCredentialStore(directory)
    await store.write('original')
    const before = await fs.readFile(destination())
    h.encrypt.mockReturnValueOnce(Buffer.alloc(REMOTE_CREDENTIAL_MAX_BYTES + 1))
    await expect(store.write('small')).rejects.toThrow('remote-credential-too-large')
    expect(await fs.readFile(destination())).toEqual(before)
    expect(await fs.readdir(directory)).toEqual(['remote-access-v1.bin'])
  })

  it.each([Buffer.alloc(0), Buffer.from('invalid ciphertext')])('rejects damaged ciphertext without deleting it', async bytes => {
    const store = createRemoteCredentialStore(directory)
    await fs.writeFile(destination(), bytes)
    await expect(store.read()).rejects.toThrow('remote-credential-invalid')
    expect(await fs.readFile(destination())).toEqual(bytes)
  })

  it('rejects oversized ciphertext without attempting to decrypt it', async () => {
    await fs.writeFile(destination(), Buffer.alloc(REMOTE_CREDENTIAL_MAX_BYTES + 1))
    await expect(createRemoteCredentialStore(directory).read()).rejects.toThrow('remote-credential-invalid')
    expect(h.decrypt).not.toHaveBeenCalled()
  })

  it('checks the decrypted size independently of ciphertext size', async () => {
    const store = createRemoteCredentialStore(directory)
    await store.write('original')
    h.decrypt.mockReturnValueOnce('x'.repeat(REMOTE_CREDENTIAL_MAX_BYTES + 1))
    await expect(store.read()).rejects.toThrow('remote-credential-invalid')
  })

  it('fsyncs a private temporary file before its atomic replacement', async () => {
    const open = fs.open.bind(fs)
    const rename = fs.rename.bind(fs)
    const calls: string[] = []
    const modes: number[] = []
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[1] === 'wx') {
        modes.push(args[2] as number)
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { calls.push('sync'); await sync() }
      }
      return handle
    })
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      calls.push('rename')
      expect(path.dirname(String(from))).toBe(directory)
      expect(String(to)).toBe(destination())
      await rename(from, to)
    })
    await createRemoteCredentialStore(directory).write('encrypted state')
    expect(calls).toEqual(['sync', 'rename'])
    expect(modes).toEqual([0o600])
  })

  it('cleans a failed replacement, preserves the original and permits a later retry', async () => {
    const store = createRemoteCredentialStore(directory)
    await store.write('original')
    const before = await fs.readFile(destination())
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated rename failure'))
    await expect(store.write('replacement')).rejects.toThrow('remote-credential-write-failed')
    expect(await fs.readFile(destination())).toEqual(before)
    expect(await fs.readdir(directory)).toEqual(['remote-access-v1.bin'])
    await store.write('retry')
    expect(await store.read()).toBe('retry')
  })

  it('serializes concurrent writes, reads and removal in invocation order', async () => {
    const store = createRemoteCredentialStore(directory)
    const writes = Array.from({ length: 20 }, (_, index) => store.write(`state-${index}`))
    const read = store.read()
    const removed = store.remove()
    const empty = store.read()
    await Promise.all(writes)
    expect(await read).toBe('state-19')
    await removed
    expect(await empty).toBeNull()
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('removes storage idempotently even when encryption is unavailable', async () => {
    const store = createRemoteCredentialStore(directory)
    await store.write('original')
    h.available.mockReturnValue(false)
    await store.remove()
    await store.remove()
    expect(await store.read()).toBeNull()
  })
})
