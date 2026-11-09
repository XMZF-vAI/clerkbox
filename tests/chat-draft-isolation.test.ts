/**
 * 草稿与会话状态隔离（UI-07/08/10/11）。
 *
 * 这几条都是纯 store 语义，不需要 DOM：输入区把草稿写进按 sessionId 分格的 store，
 * 只有「发送被受理」才清，本地错误也按来源会话回流——一旦这三点回退，
 * 表现就是切会话串草稿、发送失败丢字、后台会话的报错挂到当前会话上。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { EMPTY_CHAT_DRAFT, hasChatDraft, useChatStore } from '../src/stores/chat-store'

const chatInputSource = readFileSync(new URL('../src/components/chat/ChatInput.tsx', import.meta.url), 'utf8')

const session = (id: string) => ({ id, title: '新会话', messages: [], createdAt: 1, updatedAt: 1 })

beforeEach(() => {
  useChatStore.setState({
    sessions: [session('a'), session('b')],
    activeSessionId: 'a',
    drafts: {},
    draftSubmitting: {},
    sessionErrors: {},
    queuedMessages: {},
    sessionStatus: {},
    streamingSessionIds: new Set<string>(),
  })
})

describe('草稿按会话隔离', () => {
  it('草稿写在来源会话上，切会话不会串到别的会话', () => {
    useChatStore.getState().updateDraft('a', { content: 'A 的半截话' })
    useChatStore.getState().setActiveSession('b')
    expect(useChatStore.getState().drafts['b'] ?? EMPTY_CHAT_DRAFT).toEqual(EMPTY_CHAT_DRAFT)
    useChatStore.getState().setActiveSession('a')
    expect(useChatStore.getState().drafts['a'].content).toBe('A 的半截话')
  })

  it('有草稿的空会话不会被切会话清理掉，草稿因此不会丢', () => {
    useChatStore.getState().updateDraft('a', { content: '还没发出去' })
    useChatStore.getState().setActiveSession('b')
    expect(useChatStore.getState().sessions.some((s) => s.id === 'a')).toBe(true)
  })

  it('空草稿的会话仍按原规则清理', () => {
    useChatStore.getState().setActiveSession('b')
    expect(useChatStore.getState().sessions.some((s) => s.id === 'a')).toBe(false)
  })

  it('只清「发送时那份」草稿：迟到的成功响应不能清掉用户期间的新输入', () => {
    const sent = useChatStore.getState().drafts['a'] ?? EMPTY_CHAT_DRAFT
    useChatStore.getState().updateDraft('a', { content: '发送后又打了字' })
    useChatStore.getState().clearDraft('a', sent)
    expect(useChatStore.getState().drafts['a'].content).toBe('发送后又打了字')

    const current = useChatStore.getState().drafts['a']
    useChatStore.getState().clearDraft('a', current)
    expect(useChatStore.getState().drafts['a']).toBeUndefined()
  })

  it('受理中锁住草稿，删除会话时一并回收', () => {
    useChatStore.getState().updateDraft('a', { content: 'x' })
    useChatStore.getState().setDraftSubmitting('a', true)
    expect(hasChatDraft(useChatStore.getState().drafts['a'])).toBe(true)
    useChatStore.getState().deleteSession('a')
    expect(useChatStore.getState().drafts['a']).toBeUndefined()
    expect(useChatStore.getState().draftSubmitting['a']).toBeUndefined()
  })
})

describe('本地错误按来源会话隔离', () => {
  it('后台会话的错误不进当前会话，当前会话的错误也不外溢', () => {
    useChatStore.getState().setSessionError('b', 'B 会话炸了')
    expect(useChatStore.getState().sessionErrors['a']).toBeUndefined()
    useChatStore.getState().setSessionError('a', 'A 会话炸了')
    expect(useChatStore.getState().sessionErrors['b']).toBe('B 会话炸了')
    useChatStore.getState().setSessionError('a', undefined)
    expect(useChatStore.getState().sessionErrors['b']).toBe('B 会话炸了')
  })
})

describe('输入区发送契约', () => {
  it('发送只在受理成功后清草稿，未受理保留原文', () => {
    expect(chatInputSource).toContain('if (await onSend(text, files, mode, skills))')
    expect(chatInputSource).toContain('useChatStore.getState().clearDraft(sessionId, sentDraft)')
    expect(chatInputSource).toContain('onSend: (content: string, attachments?: MessageAttachment[], taskMode?: TaskMode, skills?: MessageSkillSnapshot[]) => Promise<boolean>')
  })

  it('排队消息编辑整份覆盖草稿（含空附件），并且先问过用户', () => {
    expect(chatInputSource).toContain('attachments: item.attachments ?? []')
    expect(chatInputSource).toContain('hasChatDraft(useChatStore.getState().drafts[sessionId])')
    expect(chatInputSource).toContain('queuedEditReplaceTitle')
  })
})
