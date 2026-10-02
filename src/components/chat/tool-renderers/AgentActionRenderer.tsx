import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, MonitorSmartphone, MousePointerClick, XCircle } from 'lucide-react'
import { MonoBlock, ToolDetailPanel, ToolSkeleton, ToolStatusLine, useToolDuration } from './ToolShell'
import { agentActionFamily, BROWSER_ACTION_SUMMARY_IDS, COMPUTER_ACTION_SUMMARY_IDS, isAgentActionToolReadOnly } from '../../../lib/agent-actions'
import type { ToolRendererProps } from './resolveRenderer'

/**
 * browser_* / computer_* 工具卡。
 *
 * 三个设计决定，都是从 ZCode 的 CUA 卡片上学来的：
 *
 * 1. **一个图标覆盖整个动作族**，不按动作细分。25 个动作各配一个图标是纯噪音：
 *    用户看到的是「AI 正在操作浏览器 / 正在操作这台电脑」，不是「它按了 pageDown」。
 * 2. **目标用 rounded-full 胶囊**。这是整张卡里最重要的可读性手法：
 *    `browser_click` 的目标是 `e12`，`computer_click` 的目标是 `(820, 441)` ——
 *    裸数字直接放进 chip 看起来像无上下文的值，胶囊把它框成一个「对象」。
 *    ZCode 还有一条更细的：纯数字的 ref 要重写成「元素 #57」，因为 CUA 解析不出可读名时
 *    会返回裸索引；这里同理处理。
 * 3. **运行态用文案扫光而不是旋转图标**。toolcall 在流式期间数量多且持续更新，
 *    常驻动画会长期占用渲染资源。
 */

/** 工具名 → 动作 key（用于查 i18n 词表）。命令/动作的归一在执行器里做，卡片不再重复一遍。 */
function actionKeyOf(name: string, args: Record<string, unknown>): string {
  if (name.startsWith('browser_')) {
    const method =
      name === 'browser_navigate'
        ? typeof args.action === 'string' && args.action !== 'navigate' ? args.action : 'navigate'
        : name.replace('browser_', '')
    return method
  }
  if (name === 'computer_app') return typeof args.action === 'string' && args.action === 'open' ? 'open_application' : 'list_apps'
  if (name === 'computer_clipboard') return args.action === 'write' ? 'write_clipboard' : 'read_clipboard'
  return name.replace('computer_', '')
}

function summaryIdFor(name: string, args: Record<string, unknown>): string {
  const family = agentActionFamily(name)
  if (family === 'browser') {
    return BROWSER_ACTION_SUMMARY_IDS[actionKeyOf(name, args) as keyof typeof BROWSER_ACTION_SUMMARY_IDS] ?? 'chat.toolCall.agentAction.browserSnapshot'
  }
  return COMPUTER_ACTION_SUMMARY_IDS[actionKeyOf(name, args) as keyof typeof COMPUTER_ACTION_SUMMARY_IDS] ?? 'chat.toolCall.agentAction.computerScreenshot'
}

/** 目标胶囊的文本。空则不渲染胶囊 —— 空胶囊比没有胶囊更难看。 */
function targetLabelFor(name: string, args: Record<string, unknown>, t: ReturnType<typeof useTranslation>['t']): string {
  if (name === 'browser_click' || name === 'browser_type' || name === 'browser_press' || name === 'browser_scroll') {
    const ref = args.ref
    // 裸 ref 是内部标识，重写成「元素 #e12」才有对象感（ZCode 对 CUA index 做过同样的处理）
    return ref ? t('toolRenderer.agentAction.details.element') + ' ' + String(ref) : ''
  }
  if (name === 'browser_navigate') return String(args.url ?? '')
  if (name === 'browser_evaluate') return String(args.expression ?? '').slice(0, 60)
  if (name === 'browser_wait') return String(args.selector ?? '')
  if (name === 'computer_drag') {
    return t('toolRenderer.agentAction.details.coordinates', { x: String(args.from_x), y: String(args.from_y) })
  }
  if (name === 'computer_type' || name === 'computer_clipboard') {
    const text = String(args.text ?? '')
    return text.length > 40 ? `${text.slice(0, 40)}…` : text
  }
  if (name === 'computer_key') return String(args.key ?? '')
  if (name === 'computer_app') return String(args.name ?? '')
  if (args.x !== undefined && args.y !== undefined) {
    return t('toolRenderer.agentAction.details.coordinates', { x: String(args.x), y: String(args.y) })
  }
  return ''
}

/** 关键入参的展示行：只列「这次动作真正会做的事」 */
function detailRows(name: string, args: Record<string, unknown>, content: string, t: ReturnType<typeof useTranslation>['t']) {
  const rows: Array<{ label: string; value: string; mono?: boolean }> = []
  const add = (label: string, value: string, mono = false) => {
    if (value) rows.push({ label, value, mono })
  }
  if (args.url) add(t('toolRenderer.agentAction.details.url'), String(args.url), true)
  if (args.selector) add(t('toolRenderer.agentAction.details.element'), String(args.selector), true)
  if (args.key) add(t('toolRenderer.agentAction.details.key'), String(args.key), true)
  if (args.name) add(t('toolRenderer.agentAction.details.application'), String(args.name))
  if (args.duration_ms !== undefined) add(t('toolRenderer.agentAction.details.waitMs'), `${args.duration_ms}ms`)

  // 页面状态：从结果正文里取回渲染层已经整理好的那几行
  const stateLines = content
    .split('\n')
    .filter((line) => /^(URL|Title|Scroll|Viewport|History|Page is still loading|Screen):/.test(line.trim()))
    .map((line) => line.trim())
  if (stateLines.length > 0) {
    rows.push({ label: t('toolRenderer.agentAction.details.target'), value: stateLines.join('\n'), mono: true })
  }
  return rows
}

export default function AgentActionRenderer({ call, result, isError, args, vibe = false }: ToolRendererProps) {
  const { t } = useTranslation()
  const running = !result
  const duration = useToolDuration(call.id, running)
  const [showImage, setShowImage] = useState(false)

  if (running) {
    return (
      <ToolDetailPanel vibe={vibe}>
        <span className={`agent-action-sweep inline-flex items-center gap-1 text-xs ${vibe ? 'text-white/80' : 'text-dark-onSurfaceVariant'}`}>
          <MousePointerClick size={11} />
          {t(summaryIdFor(call.name, args))}
        </span>
        <ToolSkeleton vibe={vibe} lines={1} />
      </ToolDetailPanel>
    )
  }

  const family = agentActionFamily(call.name)
  const isComputer = family === 'computer'
  const readOnly = isAgentActionToolReadOnly(call.name, args)
  const content = result?.content ?? ''
  const target = targetLabelFor(call.name, args, t)
  const rows = detailRows(call.name, args, content, t)
  const image = result?.images?.[0]

  return (
    <ToolDetailPanel vibe={vibe}>
      {/* 一行摘要：图标 + 动作 + 目标胶囊。运行态已在上面的分支处理。 */}
      <span className={`inline-flex min-w-0 items-center gap-1.5 text-xs ${vibe ? 'text-white/70' : 'text-dark-onSurfaceVariant'}`}>
        {isComputer ? <MonitorSmartphone size={11} className="shrink-0" /> : <MousePointerClick size={11} className="shrink-0" />}
        <span className="shrink-0">{t(summaryIdFor(call.name, args))}</span>
        {target && (
          <span className={`agent-action-target shrink-0 text-ui-sm ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/80'}`} title={target}>
            {target}
          </span>
        )}
      </span>

      {/* 截图：每卡最多一张，点击放大。失败时一律不展示 —— 失败原因区已经够说明问题了。 */}
      {image && !isError && (
        <button
          type="button"
          onClick={() => setShowImage(true)}
          className={`mt-1 block w-fit cursor-zoom-in overflow-hidden rounded-md3-md border ${vibe ? 'border-white/15' : 'border-dark-onSurfaceVariant/15'}`}
          aria-label={t('toolRenderer.agentAction.screenshotUnavailable')}
        >
          <img
            src={`file:///${image.path.replace(/\\/g, '/')}`}
            alt={t('toolRenderer.agentAction.groupLabel')}
            className="max-h-72 w-auto max-w-full object-contain"
            draggable={false}
          />
        </button>
      )}

      {rows.length > 0 && (
        <dl className="mt-1 grid grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-sm">
          {rows.map((row) => (
            <div className="contents" key={`${row.label}-${row.value.slice(0, 12)}`}>
              <dt className={vibe ? 'text-white/45' : 'text-dark-onSurfaceVariant/60'}>{row.label}</dt>
              <dd className={`min-w-0 whitespace-pre-wrap break-words ${row.mono ? 'font-mono' : ''} ${vibe ? 'text-white/80' : 'text-dark-onSurface'}`}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* 副作用声明：这是「会不会动到我的东西」的唯一诚实答案，写死在一行里，不靠用户推断 */}
      <ToolStatusLine vibe={vibe}>
        {isError ? (
          <span className="inline-flex items-center gap-1 text-xs text-md-error">
            <XCircle size={11} />
            {t('toolRenderer.failed')}
          </span>
        ) : (
          <span className={`inline-flex items-center gap-1 text-xs ${vibe ? 'text-white/45' : 'text-dark-onSurfaceVariant/60'}`}>
            <CheckCircle2 size={11} />
            {t(
              readOnly
                ? 'toolRenderer.agentAction.details.readOnly'
                : isComputer
                  ? 'toolRenderer.agentAction.details.changedDesktop'
                  : 'toolRenderer.agentAction.details.changedState',
            )}
          </span>
        )}
        {duration && <span>{duration}</span>}
      </ToolStatusLine>

      {isError && content && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-md-error">{content}</pre>
      )}

      {showImage && image && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          role="dialog"
          onClick={() => setShowImage(false)}
        >
          <img
            src={`file:///${image.path.replace(/\\/g, '/')}`}
            alt=""
            className="max-h-full max-w-full rounded-md3-md object-contain shadow-elevation-3"
          />
        </div>
      )}

      {!rows.length && !isError && !image && content && (
        <MonoBlock text={content.slice(0, 600)} vibe={vibe} />
      )}

      {!isError && !content && (
        <span className="inline-flex items-center gap-1 text-xs text-dark-onSurfaceVariant/50">
          <AlertTriangle size={11} />
          {t('toolRenderer.noOutput')}
        </span>
      )}
    </ToolDetailPanel>
  )
}
