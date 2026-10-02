import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * Agent 浏览器面板的观感守卫。
 *
 * 由来（用户实测，最难忍受的一条）：AI 浏览器一打开就是**一坨白色**，
 * 黑夜模式下也一样；上面还顶着一个 🌐 emoji。
 *
 * 真凶在 `idleUrl`：占位页把 `background` 写死成 `#fff`，并且用 emoji 当图标。
 * 为什么 `prefers-color-scheme` 救不了 —— ClerkBox 的深色是**应用级**的
 * （settings-store 的 theme，默认 dark），guest 里的媒体查询只反映操作系统，
 * 两者不一致时占位页就必然与面板脱节。所以主题必须由宿主算好后传进去。
 *
 * 另外把「+」菜单里的 Agent 浏览器入口删了：它不是用户面板，手动打开只会得到
 * 一个永远停不下来的空面板，而它的权限模型是反的（页面由模型驱动、用户只能看）。
 */

const IDLE_BLOCK = (() => {
  const text = readFileSync(
    fileURLToPath(new URL('../src/components/workbench/AgentBrowserPanel.tsx', import.meta.url)),
    'utf8',
  )
  const start = text.indexOf('function idleUrl')
  const end = text.indexOf('/** 尺寸变化警告')
  return text.slice(start, end === -1 ? text.length : end)
})()

const panel = readFileSync(
  fileURLToPath(new URL('../src/components/workbench/AgentBrowserPanel.tsx', import.meta.url)),
  'utf8',
)
const workbench = readFileSync(
  fileURLToPath(new URL('../src/components/workbench/WorkbenchPanel.tsx', import.meta.url)),
  'utf8',
)

describe('Agent 浏览器占位页', () => {
  it('不得出现 emoji（本项目不用 emoji 做 UI）', () => {
    // 取 idleUrl 那一段，避免误伤注释里的字符
    const block = IDLE_BLOCK
    const emoji = block.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)
    expect(emoji, `占位页里出现了 emoji：${JSON.stringify(emoji)}`).toBeNull()
  })

  it('背景不得写死 #fff（黑夜模式下的白块就是从这来的）', () => {
    const block = IDLE_BLOCK
    expect(block).not.toMatch(/background:#fff/)
    // 必须按主题二分
    expect(block).toMatch(/isDark \? '#14161a' : '#ffffff'/)
  })

  it('主题由宿主传入，不指望 guest 的 prefers-color-scheme', () => {
    expect(panel).toContain('useSettingsStore')
    expect(panel).toMatch(/theme === 'dark' \|\| \(theme === 'system' && window\.matchMedia/)
  })

  it('占位页 src 固化在挂载时，不会因主题变化把 AI 已导航的页面冲回占位页', () => {
    expect(panel).toContain('idleSrc.current')
    // 不能是 useMemo 跟随主题变化后被写回 src
    expect(panel).not.toMatch(/useMemo\([\s\S]{0,120}idleUrl/)
  })

  it('占位页文案走 i18n，不写死中文', () => {
    expect(panel).toContain('workbench.agentBrowserIdleTitle')
    expect(panel).toContain('workbench.agentBrowserIdleHint')
    const block = IDLE_BLOCK
    expect(block).not.toMatch(/Agent 浏览器待命/)
  })
})

describe('「+」菜单不提供手动打开 Agent 浏览器', () => {
  it('MENU_ENTRIES 里没有 agent-browser', () => {
    const block = workbench.slice(workbench.indexOf('const MENU_ENTRIES'), workbench.indexOf('const KIND_ICON'))
    expect(block).not.toMatch(/agent-browser/)
  })

  it('它仍然能作为标签被打开（工具层按需打开这条路没断）', () => {
    // 标签渲染与保活挂载都还得认 agent-browser，否则 AI 打开的浏览器会看不见
    expect(workbench).toMatch(/tab\.kind === 'agent-browser'/)
    expect(workbench).toContain('foreignAgentBrowserSessions')
  })

})