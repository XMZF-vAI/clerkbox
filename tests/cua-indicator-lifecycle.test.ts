import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * 「AI 正在操控你的电脑」浮块的语义守卫。
 *
 * 由来：浮块曾经是**每个动作 show → 动作结束 hide**。结果它一直闪 ——
 * AI 的两次动作之间隔着推理、审批、以及可能几十秒的等待，浮块在那段时间熄掉。
 * 用户看到的是「AI 偶尔动一下我的电脑」，而不是「AI 正在接管我的电脑」。
 * 闪烁的提示在安全上几乎无效：用户无从判断现在能不能碰鼠标。
 *
 * 所以语义必须是「整段操控期常驻」，收手时机是运行结束（主进程从渲染层收信号），
 * 而不是单个动作结束。
 *
 * 这些是源码级断言：浮层窗口在主进程，只能读文本。真值验证靠 preload 桥完整性测试。
 */

const indicator = readFileSync(
  fileURLToPath(new URL('../electron/cua-indicator.ts', import.meta.url)),
  'utf8',
)
const computerUse = readFileSync(
  fileURLToPath(new URL('../electron/computer-use.ts', import.meta.url)),
  'utf8',
)
const bridge = readFileSync(
  fileURLToPath(new URL('../src/components/workbench/AgentActionBridge.tsx', import.meta.url)),
  'utf8',
)
const webui = readFileSync(fileURLToPath(new URL('../electron/webui-server.ts', import.meta.url)), 'utf8')

describe('电脑操控浮块常驻语义', () => {
  it('动作结束不再熄灯（逐动作 hide 会让浮块一直闪）', () => {
    // runComputerAction 里不能有 finally + hideComputerUseIndicator
    const body = computerUse.slice(
      computerUse.indexOf('export async function runComputerAction'),
      computerUse.indexOf('/** 供 IPC 层做入参校验'),
    )
    expect(body).not.toMatch(/finally\s*{[\s\S]*hideComputerUseIndicator/)
  })

  it('收手靠运行结束的显式信号，而不是猜', () => {
    expect(computerUse).toContain('export function endComputerUseControl')
    expect(indicator).toContain('export function hideComputerUseIndicator')
    // 渲染层在没有任何 run 在跑时下发
    expect(bridge).toContain('streamingSessionIds')
    expect(bridge).toContain('endComputerUseControl')
  })

  it('兜底时限远大于单个动作（否则操控中途熄灭）', () => {
    // 允许 `300_000` 与 `5 * 60_000` 两种写法
    const match = indicator.match(/const AUTO_HIDE_MS = ([^;\r\n]+)/)
    expect(match).not.toBeNull()
    const ms = (match as RegExpMatchArray)[1]!
      .split('*')
      .map((part) => Number(part.trim().replace(/_/g, '')))
      .reduce((a, b) => a * b, 1)
    // 旧值 30_000 会在 AI 思考时熄灭；常驻语义下兜底只是失约保险
    expect(ms).toBeGreaterThanOrEqual(60_000)
  })

  it('常驻语义下不能再用「文案为空就不开窗」这种逐动作前提', () => {
    // showComputerUseIndicator 允许 text 为空（纯收尾通知），但不能整体 return
    const body = indicator.slice(
      indicator.indexOf('export async function showComputerUseIndicator'),
      indicator.indexOf('export function hideComputerUseIndicator'),
    )
    expect(body).toContain('label = text')
    expect(body).not.toMatch(/if \(disposed \|\| !text\) return/)
  })
})

describe('浮块文案要说清是什么', () => {
  it('标题恒定为「ClerkBox 正在操控你的电脑」，不随动作跳动', () => {
    // 用户要看到的是「我的电脑正在被别人控制」，不是「它此刻在点哪里」
    expect(computerUse).toContain("const DESKTOP_CONTROL_TITLE = 'ClerkBox 正在操控你的电脑'")
    expect(computerUse).toContain('showComputerUseIndicator(DESKTOP_CONTROL_TITLE,')
    // 动作短语不得再当标题
    expect(computerUse).not.toMatch(/showComputerUseIndicator\(\s*DESKTOP_TOUCHING_LABELS/)
  })

  it('**标题必须烤进 HTML**：浮块窗口没有 preload，send 过去没人接', () => {
    // 这是「一坨灰东西加三个点」的根因：窗口 sandbox + 无 preload，
    // 渲染侧没有 ipcRenderer，webContents.send('indicator:label') 没有任何接收方，
    // window.setLabel 定义了却从不被调用。3 个点是纯 CSS 动画，所以照常动。
    expect(indicator).toContain('function indicatorHtml(title: string, hint: string)')
    expect(indicator).toContain('<span class="title">${escapeHtml(title)}</span>')
    // 不得再有 ipcRenderer 推送文案的死链路
    expect(indicator).not.toContain("webContents.send('indicator:label'")
    expect(indicator).not.toContain("webContents.send('indicator:sub'")
  })

  it('退场动画走 executeJavaScript（indicator:state 同样是死链路）', () => {
    expect(indicator).not.toContain("webContents.send('indicator:state'")
    expect(indicator).toContain('executeJavaScript(`window.setState')
  })

  it('窗口要为 box-shadow 留出余量（否则卡片贴边、阴影被裁，看着像块灰方块）', () => {
    expect(indicator).toContain('INDICATOR_SHADOW_INSET')
    expect(indicator).toMatch(/const INDICATOR_HEIGHT = INDICATOR_SHADOW_INSET\.top \+ INDICATOR_CARD_HEIGHT \+ INDICATOR_SHADOW_INSET\.bottom/)
    expect(indicator).toContain('padding: ${INDICATOR_SHADOW_INSET.top}px')
  })

it('会话名改走日志，不再挤进浮块', () => {
    expect(computerUse).toMatch(/runComputerAction\(\s*action: ComputerAction,\s*sessionLabel\?: string/)
    expect(computerUse).toContain("console.log('[cua] controlling computer'")
  })
})

describe('endControl 通道的远端策略', () => {
  it('进 WebUI 黑名单：它证明远端能指挥本机桌面能力的状态机', () => {
    expect(webui).toContain("'computerUse:endControl'")
  })
})
