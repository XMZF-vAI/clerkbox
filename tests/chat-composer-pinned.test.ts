import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * 输入框必须钉在底部的回归守卫。
 *
 * 由来（用户实测）：输入框不固定在底部，而是紧跟在内容后面浮着，底下留一大片死区。
 * 消息越多它越往下走，视觉上像「输入框能被人拖着换位置」—— 实际上没人拖，是布局塌了。
 *
 * 根因是 `MessageList` 在 `messages.length === 0` 时 `return null`：整列里就没有任何
 * 可伸展的元素了，输入框紧跟在顶部几行后面，剩余空间全落在它下面。
 *
 * 这条是源码级断言 —— 布局塌陷要在真实视口里才看得见，
 * 而消息区是 flex 列里唯一的 `flex-1`，它的存在与否决定整列的高度分配。
 */

const messageList = readFileSync(
  fileURLToPath(new URL('../src/components/chat/MessageList.tsx', import.meta.url)),
  'utf8',
)
const chatPage = readFileSync(
  fileURLToPath(new URL('../src/components/chat/ChatPage.tsx', import.meta.url)),
  'utf8',
)

describe('输入框钉在底部', () => {
  it('空对话时也必须渲染 flex-1 容器，不能 return null', () => {
    const empty = messageList.slice(
      messageList.indexOf('if (messages.length === 0)'),
      messageList.indexOf('if (messages.length === 0)') + 400,
    )
    expect(empty).not.toMatch(/return null/)
    expect(empty).toContain('flex-1')
    expect(empty).toContain('min-h-0')
  })

  it('消息区是 flex 列里唯一的 flex-1 撑高元素', () => {
    // 少了它，整列没有可伸展项，输入框就会浮在半空
    expect(messageList).toContain('className="relative flex-1 min-h-0 flex flex-col"')
    expect(messageList).toContain('className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 pb-6"')
  })

  it('列本身是可收缩的（min-h-0），否则消息多时把输入框顶出视口', () => {
    // overflow-clip：根自身绝不可滚（hidden 会把内层滚动内容高度传播给祖先，见 ChatPage 注释）
    expect(chatPage).toContain('flex flex-1 flex-col min-h-0 min-w-0 overflow-clip')
  })

  it('App 根给的是确定高度（h-screen），高度链不断', () => {
    const app = readFileSync(
      fileURLToPath(new URL('../src/App.tsx', import.meta.url)),
      'utf8',
    )
    expect(app).toContain('h-screen')
    // main 用 min-h-0 才能让子级收缩
    expect(app).toContain('className="flex-1 min-h-0 overflow-hidden"')
  })
})