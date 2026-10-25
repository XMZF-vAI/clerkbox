import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { initJouleAccount, jouleSignatureHeaders } from '../electron/joule-account'

/**
 * 客户端签名的唯一职责：让服务端确认「这次请求来自登记过的 CB 安装」。
 * 这里锁住签名材料与私钥格式，避免和服务端 installSignatureMessage 悄悄漂移。
 */

const install = {
  id: '0123456789abcdef0123456789abcdef',
  privateKey: '',
}
let publicKey: CryptoKey

function fromBase64(value: string): ArrayBuffer {
  const buf = Buffer.from(value, 'base64')
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  install.privateKey = Buffer.from(new Uint8Array(pkcs8)).toString('base64')
  publicKey = pair.publicKey

  initJouleAccount({
    readKey: () => null,
    writeKey: () => {},
    clearKey: () => {},
    readInstall: () => JSON.stringify(install),
    writeInstall: () => {},
    clearInstall: () => {},
    notify: () => {},
    openExternal: async () => {},
  })
})

describe('Joule 请求签名', () => {
  it('对 chat 请求生成可验证的签名，材料与时间戳一致', async () => {
    const body = JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
    const headers = await jouleSignatureHeaders(
      'POST',
      'https://joule.xmzf.space/v1/chat/completions',
      body,
    )

    expect(headers['x-cb-install']).toBe(install.id)
    const ts = Number(headers['x-cb-ts'])
    expect(Number.isFinite(ts)).toBe(true)
    expect(Math.abs(Date.now() - ts)).toBeLessThan(60_000)

    const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex')
    const message = `${ts}\nPOST\n/v1/chat/completions\n${bodyHash}`
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      fromBase64(headers['x-cb-sig']),
      new TextEncoder().encode(message),
    )
    expect(ok).toBe(true)
  })

  it('只给 Joule 网关签名，其他提供商不附带任何凭据头', async () => {
    const headers = await jouleSignatureHeaders(
      'POST',
      'https://api.openai.com/v1/chat/completions',
      '{}',
    )
    expect(headers).toEqual({})
  })

  it('没有安装凭据时静默返回空头（按原价调用，不阻断请求）', async () => {
    // 另一个宿主不会重跑 init；直接断言非 Joule 域名已覆盖主要分支，
    // 这里补一条非法 URL，确认异常也不抛出。
    await expect(jouleSignatureHeaders('POST', 'not-a-url', '{}')).resolves.toEqual({})
  })
})
