import { describe, expect, it } from 'vitest'
import { mapMessageRows, messageToRow, messageUpdateArgs, parseToolCalls, parseToolResults } from '../src/lib/chat-row'
import type { Message } from '../src/types/agent'

const base: Message = {
  id: 'm1',
  role: 'assistant',
  content: '正文',
  timestamp: 1700000000000,
}

/** 行编码是渲染层与宿主共用的唯一事实源：往返一次必须无损 */
const roundTrip = (msg: Message): Message => mapMessageRows([
  messageToRow(msg, 's1'),
] as never)[0]

describe('messageToRow / mapMessageRows 往返', () => {
  it('最小消息往返字段一致', () => {
    expect(roundTrip(base)).toEqual(base)
  })

  it('思考链、finishReason、任务工作流与技能快照全部保留', () => {
    const msg: Message = {
      ...base,
      thinkingContent: '思考过程',
      finishReason: 'tool_calls',
      taskMode: 'goal',
      skills: [{ id: 'sk', name: '技能名', icon: '🔧', slug: 'slug-a' }],
    }
    const back = roundTrip(msg)
    expect(back.thinkingContent).toBe('思考过程')
    expect(back.finishReason).toBe('tool_calls')
    expect(back.taskMode).toBe('goal')
    expect(back.skills).toEqual(msg.skills)
  })

  it('工具调用与结果往返一致', () => {
    const msg: Message = {
      ...base,
      toolCalls: [{ id: 'c1', name: 'execute_command', arguments: { command: 'ls' } }],
      toolResults: [{ toolCallId: 'c1', content: 'out', isError: true }],
    }
    const back = roundTrip(msg)
    expect(back.toolCalls).toEqual(msg.toolCalls)
    expect(back.toolResults).toEqual(msg.toolResults)
  })

  it('附件与三个布尔标记往返一致（压缩/子 agent 卡片依赖它们）', () => {
    const msg: Message = {
      ...base,
      role: 'user',
      attachments: [{ id: 'a1', kind: 'image', name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA' }],
      isCompactSummary: true,
      isSubAgentCard: true,
      subAgentId: 'run-9',
    }
    const back = roundTrip(msg)
    expect(back.role).toBe('user')
    expect(back.attachments).toEqual(msg.attachments)
    expect(back.isCompactSummary).toBe(true)
    expect(back.isSubAgentCard).toBe(true)
    expect(back.subAgentId).toBe('run-9')
  })

  it('user 消息不被写成 assistant；未知 task_mode 与 role 回落而不是抛错', () => {
    const row = messageToRow({ ...base, role: 'user', taskMode: 'plan' as never }, 's1')
    expect(row.role).toBe('user')
    expect(row.task_mode).toBe('plan')
    expect(mapMessageRows([{ ...row, role: 'weird', task_mode: 'nope' } as never])[0].role).toBe('assistant')
    expect(mapMessageRows([{ ...row, task_mode: 'nope' } as never])[0].taskMode).toBeUndefined()
  })

  it('session_id 始终按入参写入，不取消息自带字段', () => {
    expect(messageToRow(base, 'other').session_id).toBe('other')
  })
})

describe('增量落库参数', () => {
  it('messageUpdateArgs 顺序与 dbUpdateMessage 形参一致', () => {
    const msg: Message = { ...base, content: '改后', toolCalls: [{ id: 'c', name: 'read_file', arguments: {} }] }
    const [id, content, toolCalls, toolResults, thinking, finish] = messageUpdateArgs(msg)
    expect(id).toBe('m1')
    expect(content).toBe('改后')
    expect(toolCalls).toBe('[{"id":"c","name":"read_file","arguments":{}}]')
    expect(toolResults).toBeUndefined()
    expect(thinking).toBeNull()
    expect(finish).toBeNull()
  })
})

describe('脏数据容忍（DB 里可能存在人工改坏的历史）', () => {
  it('非法 JSON 与形状不符的行降级为字段缺失而不是抛错', () => {
    expect(parseToolCalls('{ 坏数据')).toBeUndefined()
    expect(parseToolCalls('{"not":"array"}')).toBeUndefined()
    expect(parseToolResults('[{"content":123}]')).toEqual([])
    const back = mapMessageRows([{
      id: 'x', session_id: 's', role: 'assistant', content: 'c', timestamp: 1,
      attachments: '[{"id":"a1","kind":"video","name":"v.mp4"}]',
    } as never])[0]
    expect(back.attachments).toBeUndefined()
  })
})
