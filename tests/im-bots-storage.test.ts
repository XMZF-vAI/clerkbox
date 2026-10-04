import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { BotsStorage, safeLockName, isPidAlive } from '../electron/im-bots/storage'
import {
  BIND_CODE_TTL_MS,
  BotsConfigFileSchema,
  BotsStateFileSchema,
  credentialFingerprint,
  credentialRefFor,
  emptyBotsConfig,
  emptyBotsState,
  makeActorKey,
  parseFeishuSecret,
  parseWeixinSecret,
  type BotConfig,
} from '../electron/im-bots/types'

/**
 * D1 落盘层验收：配置读写、损坏恢复、绑定码 TTL 与单次有效、上下文并发不丢写、文件锁抢占。
 * 用真实临时目录而不是 mock fs——原子写与 rename 的行为正是被测对象本身，打桩等于没测。
 */
let base: string
let storage: BotsStorage

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), `cb-bots-${process.pid}-`))
  storage = new BotsStorage(base)
  // 先把目录建出来：下面有用例直接往 im-bots/ 里写损坏文件
  await storage.ensureReady()
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true }).catch(() => {})
})

function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot1',
    provider: 'weixin',
    name: '我的微信',
    enabled: true,
    credentialRef: credentialRefFor('weixin', 'bot1'),
    ...overrides,
  }
}

describe('bots-config 读写', () => {
  it('首次读取建空档并落盘', async () => {
    const file = path.join(base, 'im-bots', 'bots-config.json')
    await fs.access(file)
    const config = await storage.readConfig()
    expect(config).toEqual(emptyBotsConfig())
  })

  it('写入后能原样读回', async () => {
    const next = { version: 1 as const, bots: [bot()] }
    await storage.writeConfig(next)
    expect(await storage.readConfig()).toEqual(next)
  })

  it('损坏文件被备份成 .bak 后重建，而不是静默清空', async () => {
    const file = path.join(base, 'im-bots', 'bots-config.json')
    await fs.writeFile(file, '{ "version": 1, "bots": [ 截断了', 'utf-8')
    const fresh = new BotsStorage(base)
    const config = await fresh.readConfig()
    expect(config).toEqual(emptyBotsConfig())
    const dir = await fs.readdir(path.join(base, 'im-bots'))
    expect(dir.some((name) => name.endsWith('.bak'))).toBe(true)
    const backup = dir.find((name) => name.endsWith('.bak'))
    expect(backup).toBeTruthy()
    expect(await fs.readFile(path.join(base, 'im-bots', backup as string), 'utf-8')).toContain('截断')
  })

  it('多余字段按 strict 拒绝并触发重建（防上一版的字段被静默沿用）', async () => {
    const file = path.join(base, 'im-bots', 'bots-config.json')
    await fs.writeFile(file, JSON.stringify({ version: 1, bots: [], hacked: true }), 'utf-8')
    const fresh = new BotsStorage(base)
    expect(await fresh.readConfig()).toEqual(emptyBotsConfig())
  })

  it('凭据引用命名落在 assertCredentialId 白名单内', () => {
    expect(credentialRefFor('feishu', 'ab.CD-9_1')).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
  })
})

describe('bots-state：聊天上下文', () => {
  it('patch 不存在的上下文时按 seed 建行', async () => {
    const ctx = await storage.patchContext('bot1:weixin:u1:private', { workDir: 'D:/x' }, () => ({ mode: 'draft' }))
    expect(ctx).toMatchObject({ actorKey: 'bot1:weixin:u1:private', mode: 'draft', workDir: 'D:/x' })
    expect(await storage.getContext('bot1:weixin:u1:private')).toEqual(ctx)
  })

  it('并发 patch 不丢写（绑定码风暴 / 多消息交错是常态）', async () => {
    const key = makeActorKey('bot1', 'weixin', 'u1')
    await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        storage.patchContext(key, (current) => ({ workDir: `${current.workDir ?? '0'}|${index}` }))
      )
    )
    const ctx = await storage.getContext(key)
    expect(ctx?.workDir?.split('|').length).toBe(21)
  })

  it('actorKey 换 bot 即换上下文（同一微信绑两个 bot 不共享工作目录）', async () => {
    await storage.patchContext(makeActorKey('botA', 'weixin', 'u1'), { workDir: 'D:/a' }, () => ({ mode: 'draft' }))
    expect(await storage.getContext(makeActorKey('botB', 'weixin', 'u1'))).toBeUndefined()
  })

  it('dropContextsOf 一并清掉绑定与待用码', async () => {
    const key = makeActorKey('bot1', 'feishu', 'ou_x')
    await storage.patchContext(key, { mode: 'task' }, () => ({ mode: 'draft' }))
    await storage.addBinding({ actorKey: key, botId: 'bot1', providerUserId: 'ou_x' })
    await storage.issueBindCode('bot1', 'ABC123')
    await storage.dropContextsOf('bot1')
    expect((await storage.readState()).contexts).toHaveLength(0)
    expect(await storage.listBindings('bot1')).toHaveLength(0)
    expect(await storage.liveBindCodes()).toHaveLength(0)
  })
})

describe('绑定码：30 秒 TTL 与单次有效', () => {
  it('签发后立即可核销，且核销后即失效', async () => {
    const entry = await storage.issueBindCode('bot1', 'ABCDE1')
    expect(entry.expiresAt).toBeGreaterThan(Date.now())
    expect(await storage.consumeBindCode('bot1', 'ABCDE1')).toEqual({ ok: true })
    expect(await storage.consumeBindCode('bot1', 'ABCDE1')).toEqual({ ok: false, reason: 'none' })
  })

  it('过期码不可用', async () => {
    await storage.issueBindCode('bot1', 'ZZZ999', -1)
    expect(await storage.consumeBindCode('bot1', 'ZZZ999')).toEqual({ ok: false, reason: 'none' })
  })

  it('A 机器人的码不能在 B 上核销，且码本身不被消费掉', async () => {
    await storage.issueBindCode('botA', 'SHARED')
    expect(await storage.consumeBindCode('botB', 'SHARED')).toEqual({ ok: false, reason: 'mismatch' })
    expect(await storage.consumeBindCode('botA', 'SHARED')).toEqual({ ok: true })
  })

  it('同一 bot 重复签发只留最新一条', async () => {
    await storage.issueBindCode('bot1', 'OLD123')
    await storage.issueBindCode('bot1', 'NEW456')
    expect(await storage.consumeBindCode('bot1', 'OLD123')).toEqual({ ok: false, reason: 'none' })
    expect(await storage.consumeBindCode('bot1', 'NEW456')).toEqual({ ok: true })
  })

  it('默认 TTL 就是规格里的 30 秒', async () => {
    const entry = await storage.issueBindCode('bot1', 'TTL123')
    expect(entry.expiresAt).toBeGreaterThanOrEqual(Date.now() + BIND_CODE_TTL_MS - 500)
  })
})

describe('解绑与重置', () => {
  it('解绑连带清掉聊天上下文', async () => {
    const key = makeActorKey('bot1', 'weixin', 'u1')
    await storage.patchContext(key, { mode: 'task', activeSessionId: 's1' }, () => ({ mode: 'draft' }))
    await storage.addBinding({ actorKey: key, botId: 'bot1', providerUserId: 'u1' })
    expect(await storage.isBound(key)).toBe(true)
    await storage.removeBinding(key)
    expect(await storage.isBound(key)).toBe(false)
    expect(await storage.getContext(key)).toBeUndefined()
  })

  it('重置保留绑定关系、只清上下文', async () => {
    const key = makeActorKey('bot1', 'weixin', 'u1')
    await storage.patchContext(key, { mode: 'task', activeSessionId: 's1' }, () => ({ mode: 'draft' }))
    await storage.addBinding({ actorKey: key, botId: 'bot1', providerUserId: 'u1' })
    await storage.resetContext(key)
    expect(await storage.getContext(key)).toBeUndefined()
    expect(await storage.isBound(key)).toBe(true)
  })
})

describe('进程文件锁', () => {
  it('自己持有时可以重取（重启同进程不应被自己的旧锁挡住）', async () => {
    expect(await storage.acquireLock('bot1')).toEqual({ acquired: true })
    expect(await storage.acquireLock('bot1')).toEqual({ acquired: true })
  })

  it('活着的他人 PID 持锁时抢不到', async () => {
    const lockDir = path.join(base, 'im-bots', 'locks')
    await fs.mkdir(lockDir, { recursive: true })
    // 用一个确实存在的父进程 pid（不是自己）模拟另一个实例
    const other = process.ppid && process.ppid !== process.pid ? process.ppid : null
    if (!other) return
    expect(isPidAlive(other)).toBe(true)
    await fs.writeFile(path.join(lockDir, 'bot1.lock'), JSON.stringify({ pid: other, at: Date.now() }), 'utf-8')
    expect(await storage.acquireLock('bot1')).toEqual({ acquired: false, holderPid: other })
  })

  it('死进程留下的锁能被抢回（一次崩溃不能永久停用通道）', async () => {
    const lockDir = path.join(base, 'im-bots', 'locks')
    await fs.mkdir(lockDir, { recursive: true })
    await fs.writeFile(path.join(lockDir, 'bot1.lock'), JSON.stringify({ pid: 2_000_000_000, at: 1 }), 'utf-8')
    expect(await storage.acquireLock('bot1')).toEqual({ acquired: true })
  })

  it('释放只删自己的锁', async () => {
    const lockDir = path.join(base, 'im-bots', 'locks')
    await fs.mkdir(lockDir, { recursive: true })
    const other = process.ppid && process.ppid !== process.pid ? process.ppid : null
    if (!other) return
    await fs.writeFile(path.join(lockDir, 'bot1.lock'), JSON.stringify({ pid: other, at: 1 }), 'utf-8')
    await storage.releaseLock('bot1')
    const holder = JSON.parse(await fs.readFile(path.join(lockDir, 'bot1.lock'), 'utf-8')) as { pid: number }
    expect(holder.pid).toBe(other)
  })

  it('锁文件名里的目录穿越被消毒', () => {
    // 点号也必须换掉：保留时 '../../etc/passwd' 会洗成 '.._.._etc_passwd'，
    // 那两段 '..' 拼进锁文件路径仍然能穿出 locks 目录
    expect(safeLockName('../../etc/passwd')).toBe('______etc_passwd')
    expect(safeLockName('a/b')).toBe('a_b')
    expect(safeLockName('')).toBe('bot')
  })

  it('非法 pid 一律视为不存活', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(isPidAlive(pid)).toBe(false)
  })
})

describe('凭据解析与指纹', () => {
  it('微信 secret 认 token+baseUrl，instanceId 可缺', () => {
    expect(parseWeixinSecret(JSON.stringify({ token: 't', baseUrl: 'https://x' }))).toMatchObject({ token: 't' })
    expect(parseWeixinSecret(JSON.stringify({ token: 't' }))).toBeNull()
    expect(parseWeixinSecret('not json')).toBeNull()
  })

  it('飞书 secret 两个字段都必填', () => {
    expect(parseFeishuSecret(JSON.stringify({ appId: 'a', appSecret: 's' }))).toMatchObject({ appId: 'a' })
    expect(parseFeishuSecret(JSON.stringify({ appId: 'a' }))).toBeNull()
  })

  it('内容变化则指纹变化，内容相同则指纹相同（通道自重启的唯一判据）', () => {
    const a = credentialFingerprint('feishu', JSON.stringify({ appId: 'a', appSecret: 's' }))
    expect(credentialFingerprint('feishu', JSON.stringify({ appId: 'a', appSecret: 's2' }))).not.toBe(a)
    expect(credentialFingerprint('feishu', JSON.stringify({ appId: 'a', appSecret: 's' }))).toBe(a)
    expect(credentialFingerprint('weixin', JSON.stringify({ appId: 'a', appSecret: 's' }))).not.toBe(a)
  })
})

describe('状态文件校验器', () => {
  it('zod strict 拒掉未知顶层字段', () => {
    expect(() => BotsStateFileSchema.parse({ ...emptyBotsState(), extra: 1 })).toThrow()
    expect(() => BotsConfigFileSchema.parse({ ...emptyBotsConfig(), bots: [] })).not.toThrow()
  })

  it('版本号不是 1 就拒（未来迁移必须显式过一遍）', () => {
    expect(() => BotsConfigFileSchema.parse({ version: 2, bots: [] })).toThrow()
  })

  it('context 里的 weixinContextToken 能存能取（答案回推的唯一凭证）', async () => {
    const key = makeActorKey('bot1', 'weixin', 'u1')
    await storage.patchContext(key, { weixinContextToken: 'CTX-1' }, () => ({ mode: 'draft' }))
    expect((await storage.getContext(key))?.weixinContextToken).toBe('CTX-1')
  })
})

describe('读失败与文件损坏的界限', () => {
  /**
   * 这一条是踩过的坑：readValidated 曾经是 catch-all，把「权限拒绝 / 目标其实是目录 /
   * schema 自己写错」统统当成「文件损坏」，于是每次都备份并重建空档，
   * 表现是「绑定关系与游标永远读不回来」而且完全静默。
   * 现在只有 ENOENT（建空档）与 ZodError/坏 JSON（备份重建）算数，其余一律上抛。
   */
  it('非 ENOENT 的读异常向上抛，绝不当成损坏重建', async () => {
    const stateFile = path.join(base, 'im-bots', 'bots-state.json')
    await fs.rm(stateFile, { force: true })
    await fs.mkdir(stateFile, { recursive: true }) // 拿状态文件的位置当目录：readFile 必非 ENOENT 地失败
    const fresh = new BotsStorage(base)
    await expect(fresh.readState()).rejects.toThrow()
    // 失败过之后不许把位置吃成空档：目录还在那儿
    const stat = await fs.stat(stateFile)
    expect(stat.isDirectory()).toBe(true)
  })

  it('一次读失败之后仍可恢复（失败的 promise 不许被永久缓存）', async () => {
    const stateFile = path.join(base, 'im-bots', 'bots-state.json')
    await fs.rm(stateFile, { force: true })
    await fs.mkdir(stateFile, { recursive: true })
    const fresh = new BotsStorage(base)
    await expect(fresh.readState()).rejects.toThrow()
    await fs.rm(stateFile, { recursive: true, force: true })
    expect(await fresh.readState()).toEqual(emptyBotsState())
  })

  it('空文件算损坏并留下备份', async () => {
    const configFile = path.join(base, 'im-bots', 'bots-config.json')
    await fs.writeFile(configFile, '   ', 'utf-8')
    const fresh = new BotsStorage(base)
    expect(await fresh.readConfig()).toEqual(emptyBotsConfig())
    const dir = await fs.readdir(path.join(base, 'im-bots'))
    expect(dir.some((name) => name.endsWith('.bak'))).toBe(true)
  })
})

describe('写失败不阻塞后续写', () => {
  /**
   * 串行链上一个任务失败绝不能卡死后续写入：消息回推、上下文 patch、绑定码核销
   * 都挂在这条链上，卡住等于整条 IM 通道静默停摆。
   * 用「mutate 自己抛」来注入失败，而不是打桩 fs.writeFile——原子写的临时文件名
   * 带 pid 后缀，按路径匹配桩既脆弱又容易假绿。
   */
  it('前一次写入异常后，链仍能完成下一次写入', async () => {
    const key = makeActorKey('bot1', 'weixin', 'u1')
    await expect(
      storage.patchContext(key, () => {
        throw new Error('EBUSY')
      }, () => ({ mode: 'draft' }))
    ).rejects.toThrow('EBUSY')
    await storage.patchContext(key, { workDir: 'D:/b' }, () => ({ mode: 'draft' }))
    expect(await storage.getContext(key)).toMatchObject({ workDir: 'D:/b' })
  })

  it('读回来的内容仍是合法 JSON（失败那次没有留下半个文件）', async () => {
    const key = makeActorKey('bot1', 'weixin', 'u1')
    await storage.patchContext(key, { workDir: 'D:/a' }, () => ({ mode: 'draft' }))
    await expect(
      storage.patchContext(key, () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    const state = await storage.readState()
    expect(state.contexts).toHaveLength(1)
    expect(state.contexts[0]?.workDir).toBe('D:/a')
  })
})
