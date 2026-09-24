/**
 * 云同步端到端加密（E2EE）—— 主进程模块
 *
 * 职责：
 * 1. 同步加密密码的本地持久化（safeStorage 加密；不可用时降级明文并标记）
 * 2. 同步数据段的加解密：scrypt 派生密钥 + AES-256-GCM（自带防篡改校验）
 *
 * 密文信封格式（cloud 端只见密文，updatedAt 保留明文供"新者优先"比较）：
 * {
 *   "version": 2, "enc": true, "alg": "aes-256-gcm+scrypt",
 *   "salt": "hex", "iv": "hex", "tag": "base64", "data": "base64",
 *   "updatedAt": 1234567890123
 * }
 *
 * 约束：
 * - 密码绝不上传云端；密码丢失 = 云端已加密数据不可恢复（E2EE 本质特性）
 * - 所有路径惰性获取（app ready 后才可调用 getPath）
 */

import { app, safeStorage } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/** scrypt 参数：N=16384, r=8, p=1（OWASP 推荐量级，单次派生约 50ms） */
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
/** 派生密钥长度（AES-256） */
const KEY_LEN = 32
/** 加密算法标识（写入信封 alg 字段，供未来算法升级识别） */
const ALG = 'aes-256-gcm+scrypt'
/** 密码最小长度 */
const MIN_PASSPHRASE_LEN = 8

// ── 密码本地持久化 ──

/** 密码状态文件结构（userData/rt-sync-pass.json） */
interface PassphraseState {
  /** 密码：safeStorage 加密后 base64；passPlain 为 true 时是明文（降级） */
  passEnc: string
  /** true = passEnc 为明文（safeStorage 不可用时的降级标记） */
  passPlain?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 密码文件路径（惰性获取：app ready 后才可调用 getPath） */
function passphraseFilePath(): string {
  return path.join(app.getPath('userData'), 'rt-sync-pass.json')
}

/** 原子写文件：tmp + rename（与 rt-account.ts writeJsonAtomic 同模式） */
function writeJsonAtomic(filePath: string, text: string): void {
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(temporary, text, 'utf-8')
  try {
    fs.renameSync(temporary, filePath)
  } catch (error) {
    try {
      fs.copyFileSync(temporary, filePath)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
    if (!fs.existsSync(filePath)) throw error
  }
}

/** 读取密码状态文件；不存在或损坏时返回 null（视为未设置） */
function readPassphraseState(): PassphraseState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(passphraseFilePath(), 'utf-8'))
    if (!isRecord(parsed)) return null
    if (typeof parsed.passEnc !== 'string' || !parsed.passEnc) return null
    return { passEnc: parsed.passEnc, passPlain: parsed.passPlain === true }
  } catch {
    return null
  }
}

/** 读取当前同步加密密码（明文）；未设置或解密失败返回 null */
export function getSyncPassphrase(): string | null {
  const state = readPassphraseState()
  if (!state) return null
  if (state.passPlain) return state.passEnc
  try {
    const plain = safeStorage.decryptString(Buffer.from(state.passEnc, 'base64'))
    return plain || null
  } catch {
    // 系统加密不可恢复（如换了系统账户）时视为未设置，用户重新设置即可
    return null
  }
}

/** 是否已设置同步加密密码 */
export function isSyncPassphraseSet(): boolean {
  return readPassphraseState() !== null
}

/**
 * 设置/修改同步加密密码（本地覆盖式保存，不影响云端已有数据）。
 * 返回 { ok } 或 { error }；不向渲染层抛异常。
 */
export function setSyncPassphrase(passphrase: string): { ok: true } | { error: string } {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LEN) {
    return { error: `密码至少 ${MIN_PASSPHRASE_LEN} 个字符` }
  }
  try {
    const state: PassphraseState = safeStorage.isEncryptionAvailable()
      ? { passEnc: safeStorage.encryptString(passphrase).toString('base64') }
      : { passEnc: passphrase, passPlain: true }
    writeJsonAtomic(passphraseFilePath(), JSON.stringify(state))
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ── 数据段加解密 ──

/** 密文信封（云端存储格式） */
export interface SyncEnvelope {
  version: 2
  enc: true
  alg: string
  /** scrypt 盐（hex，16 字节）；随段同步，保证多设备派生出相同密钥 */
  salt: string
  /** GCM 初始向量（hex，12 字节） */
  iv: string
  /** GCM 认证标签（base64，16 字节） */
  tag: string
  /** 密文（base64） */
  data: string
  /** 明文时间戳（供云端较新比较，无需解密即可读） */
  updatedAt: number
}

/** 判断云端 payload 是否为加密信封 */
export function isEncryptedEnvelope(payload: unknown): payload is SyncEnvelope {
  return (
    isRecord(payload) &&
    payload.enc === true &&
    typeof payload.salt === 'string' &&
    typeof payload.iv === 'string' &&
    typeof payload.data === 'string'
  )
}

/** 从明文 payload 提取 updatedAt（兜底当前时间），保留在信封明文层供新者比较 */
function plaintextUpdatedAt(payload: object): number {
  const value = (payload as { updatedAt?: unknown }).updatedAt
  return typeof value === 'number' && value > 0 ? value : Date.now()
}

/**
 * 加密同步 payload：明文对象 → 密文信封 JSON 字符串。
 * 每次加密生成随机 salt + iv（概率性语义安全性）。
 */
export function encryptSyncPayload(passphrase: string, plainPayload: object): string {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(plainPayload), 'utf-8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope: SyncEnvelope = {
    version: 2,
    enc: true,
    alg: ALG,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
    updatedAt: plaintextUpdatedAt(plainPayload),
  }
  return JSON.stringify(envelope)
}

/**
 * 解密密文信封 → 明文 payload 对象。
 * GCM 认证失败（密码错误 / 数据被篡改）抛出可读错误。
 */
export function decryptSyncPayload(passphrase: string, envelope: SyncEnvelope): Record<string, unknown> {
  if (envelope.alg !== ALG) throw new Error('云端数据使用了不支持的加密算法')
  try {
    const salt = Buffer.from(envelope.salt, 'hex')
    const iv = Buffer.from(envelope.iv, 'hex')
    const key = crypto.scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ])
    const parsed: unknown = JSON.parse(plaintext.toString('utf-8'))
    if (!isRecord(parsed)) throw new Error('invalid payload')
    return parsed
  } catch {
    // GCM 校验失败 = 密码错误或密文损坏；JSON/结构错误同样归入此类
    throw new Error('同步密码错误或云端数据已损坏')
  }
}
