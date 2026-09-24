import { describe, it, expect, vi } from 'vitest'

// sync-crypto 是主进程模块，顶部 import electron；加解密函数本身只用 node:crypto，
// 打桩 electron 后即可在 Node 环境做纯逻辑测试。
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\tmp\\clerkbox-test' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
}))

import {
  encryptSyncPayload,
  decryptSyncPayload,
  isEncryptedEnvelope,
  type SyncEnvelope,
} from '../electron/sync-crypto'

const PASSPHRASE = 'correct horse battery staple'

function encryptToEnvelope(payload: object): SyncEnvelope {
  return JSON.parse(encryptSyncPayload(PASSPHRASE, payload)) as SyncEnvelope
}

describe('sync-crypto 加解密', () => {
  it('加密 → 解密往返一致（含中文与嵌套结构）', () => {
    const payload = {
      providers: [{ id: 'p1', label: '智谱', models: ['glm-4.6'] }],
      updatedAt: 1700000000000,
      nested: { list: [1, 'two', { three: true }] },
    }
    const envelope = encryptToEnvelope(payload)
    expect(decryptSyncPayload(PASSPHRASE, envelope)).toEqual(payload)
  })

  it('信封格式符合契约（version/alg/salt/iv/tag/data/updatedAt）', () => {
    const envelope = encryptToEnvelope({ a: 1, updatedAt: 1700000000000 })
    expect(envelope.version).toBe(2)
    expect(envelope.enc).toBe(true)
    expect(envelope.alg).toBe('aes-256-gcm+scrypt')
    expect(envelope.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(envelope.iv).toMatch(/^[0-9a-f]{24}$/)
    expect(Buffer.from(envelope.tag, 'base64')).toHaveLength(16)
    expect(envelope.data.length).toBeGreaterThan(0)
    expect(envelope.updatedAt).toBe(1700000000000)
  })

  it('概率性加密：同一明文两次加密产物不同（随机 salt/iv）', () => {
    const payload = { same: 'plain' }
    expect(encryptSyncPayload(PASSPHRASE, payload)).not.toBe(encryptSyncPayload(PASSPHRASE, payload))
  })

  it('明文 updatedAt 保留在信封明文层；缺失时兜底为当前时间', () => {
    const withTs = encryptToEnvelope({ updatedAt: 123456789 })
    expect(withTs.updatedAt).toBe(123456789)
    const withoutTs = encryptToEnvelope({ a: 1 })
    expect(withoutTs.updatedAt).toBeGreaterThan(Date.now() - 10_000)
  })

  it('密码错误 → 抛出可读错误', () => {
    const envelope = encryptToEnvelope({ secret: 'data' })
    expect(() => decryptSyncPayload('wrong-passphrase', envelope)).toThrow('同步密码错误或云端数据已损坏')
  })

  it('密文被篡改 → GCM 校验失败', () => {
    const envelope = encryptToEnvelope({ secret: 'data' })
    const tampered = { ...envelope, data: envelope.data.slice(0, -4) + 'AAAA' }
    expect(() => decryptSyncPayload(PASSPHRASE, tampered)).toThrow('同步密码错误或云端数据已损坏')
  })

  it('未知算法标识 → 直接拒绝', () => {
    const envelope = { ...encryptToEnvelope({ a: 1 }), alg: 'rot13' }
    expect(() => decryptSyncPayload(PASSPHRASE, envelope)).toThrow('不支持的加密算法')
  })
})

describe('isEncryptedEnvelope', () => {
  it('识别合法信封', () => {
    expect(isEncryptedEnvelope(encryptToEnvelope({ a: 1 }))).toBe(true)
  })

  it('拒绝明文 payload 与畸形对象', () => {
    expect(isEncryptedEnvelope({ a: 1 })).toBe(false)
    expect(isEncryptedEnvelope(null)).toBe(false)
    expect(isEncryptedEnvelope('string')).toBe(false)
    expect(isEncryptedEnvelope([1, 2])).toBe(false)
    expect(isEncryptedEnvelope({ enc: true, salt: 1, iv: 'x', data: 'y' })).toBe(false)
  })
})
