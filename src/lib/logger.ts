/**
 * 渲染进程结构化日志（A1：对标 ZCode 的日志中间件体系）。
 *
 * - `logger.<level>(scope, ...)`：控制台输出 + 转发主进程落盘（fire-and-forget）。
 * - `installRendererLogHooks()`：捕获 window.onerror / unhandledrejection，
 *   把以往「渲染崩了没有任何记录」的现场写进主进程日志文件。
 * - WebUI 模式下无 preload 桥，只保留控制台输出，不转发。
 */
import { isWebUIMode } from './ipc-client'

export type RendererLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 单条转发消息上限（与主进程 MAX_RENDERER_MESSAGE_BYTES 对齐） */
const MAX_MESSAGE_BYTES = 8 * 1024

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function forward(level: RendererLogLevel, scope: string, args: unknown[]): void {
  if (isWebUIMode) return
  try {
    window.clerkbox?.logWrite(level, scope, args.map(formatArg).join(' ').slice(0, MAX_MESSAGE_BYTES))
  } catch {
    // 日志通道自身异常绝不影响业务
  }
}

export const logger = {
  debug: (scope: string, ...args: unknown[]) => {
    console.debug(`[${scope}]`, ...args)
    forward('debug', scope, args)
  },
  info: (scope: string, ...args: unknown[]) => {
    console.info(`[${scope}]`, ...args)
    forward('info', scope, args)
  },
  warn: (scope: string, ...args: unknown[]) => {
    console.warn(`[${scope}]`, ...args)
    forward('warn', scope, args)
  },
  error: (scope: string, ...args: unknown[]) => {
    console.error(`[${scope}]`, ...args)
    forward('error', scope, args)
  },
}

let hooksInstalled = false

/** 安装全局异常钩子（幂等）。应在 main.tsx 渲染前调用，确保启动期异常也能落盘。 */
export function installRendererLogHooks(): void {
  if (hooksInstalled || isWebUIMode) return
  hooksInstalled = true

  window.addEventListener('error', (event) => {
    forward('error', 'window.onerror', [
      event.message,
      `${event.filename}:${event.lineno}:${event.colno}`,
      (event.error as Error | null)?.stack,
    ])
  })
  window.addEventListener('unhandledrejection', (event) => {
    forward('error', 'unhandledrejection', [event.reason])
  })
}
