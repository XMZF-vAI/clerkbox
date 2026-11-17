import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronRight, Copy, ExternalLink, Globe, Loader2, MessageSquare, Play, RefreshCw, ShieldCheck, Smartphone, Square, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Modal from '../ui/Modal'
import QrCode from '../ui/QrCode'
import BotsDialog from '../bots/BotsDialog'
import { ChannelBadge } from '../bots/channelIcons'
import { useBots } from '../bots/useBots'
import { ipc } from '../../lib/ipc-client'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import { agentClient } from '../../lib/agent-client'
import { attachAgentEvents } from '../../lib/agent-event-apply'
import type { RemoteAccessStatus } from '../../remote/protocol'
import type { BotProvider } from '../../../electron/im-bots/types'

interface RemoteAccessDialogProps {
  onClose: () => void
}

/** 启动结果里二维码需要的三件套：port + token 拼局域网地址（与侧栏历史行为同一口径） */
interface WebUIRuntime {
  port: number
  token: string
  url: string
}

/**
 * 从 `http://localhost:PORT/?token=XXX` 反解出口令。
 *
 * 只在内存里过一遍：不写日志、不进 URL 查询串、不上报。
 * 解析失败（主进程换了 url 形状）就退化成「只显示 url、不出二维码」，
 * 总比拿一个错的 token 去画码害手机扫出个死链好。
 */
function parseWebUIRuntime(url: string): WebUIRuntime | null {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    const token = parsed.searchParams.get('token') || ''
    if (!port || !token) return null
    return { port, token, url }
  } catch {
    return null
  }
}

/**
 * 远程访问：把这台 ClerkBox 交给手机的两种玩法摆在同一处。
 *
 * 左栏 WebUI（浏览器直连）是从侧栏内嵌弹窗整体搬过来的，启动 / 停止 / 复制 / 二维码 /
 * 局域网开关重启的行为与原来逐条对齐；右栏 IM 机器人是新入口，只负责跳到 BotsDialog。
 */
export default function RemoteAccessDialog({ onClose }: RemoteAccessDialogProps) {
  const { t } = useTranslation()
  const [accessTab, setAccessTab] = useState<'cloud' | 'local'>('cloud')
  const { bots, loading: botsLoading } = useBots()

  // ── WebUI 控制（自 Sidebar 原样搬运）──
  const [webuiStarting, setWebuiStarting] = useState(false)
  const [webuiChecking, setWebuiChecking] = useState(true)
  const [webuiStopping, setWebuiStopping] = useState(false)
  const [webuiError, setWebuiError] = useState<string | null>(null)
  const operationRef = useRef(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [webuiInfo, setWebuiInfo] = useState<WebUIRuntime | null>(null)
  const [webuiCopied, setWebuiCopied] = useState(false)
  const [webuiRestarting, setWebuiRestarting] = useState<'lan' | 'file' | null>(null)
  // 二维码内容：仅在「允许局域网访问」且检测到局域网 IP 时才生成（绝不指向 localhost）
  const [webuiQrUrl, setWebuiQrUrl] = useState<string | null>(null)
  // 开启了局域网访问但没探测到可用网卡地址
  const [webuiLanMissing, setWebuiLanMissing] = useState(false)
  const webuiLanAccess = useSettingsStore((s) => s.webuiLanAccess)
  const webuiFileAccess = useSettingsStore((s) => s.webuiFileAccess)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [botsOpen, setBotsOpen] = useState(false)
  const [botsEntryProvider, setBotsEntryProvider] = useState<BotProvider | null>(null)
  const webuiBusy = webuiChecking || webuiStarting || webuiStopping || webuiRestarting !== null

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

  /** 解析二维码 URL：lanAllowed 时取第一个非内部 IPv4 拼 URL，否则不生成二维码 */
  const resolveQrUrl = async (result: WebUIRuntime, lanAllowed: boolean) => {
    const ips = await ipc.getLanAddresses().catch(() => [] as string[])
    const ip = lanAllowed ? ips[0] : undefined
    setWebuiQrUrl(ip ? `http://${ip}:${result.port}/?token=${result.token}` : null)
    setWebuiLanMissing(lanAllowed && !ip)
  }

  /** 起服务并刷新二维码：返回 null 表示主进程给了错误（调用方按错误分支提示） */
  const startWebUIService = async (lanAccess: boolean, fileAccess: boolean): Promise<WebUIRuntime | null> => {
    const result = await ipc.startWebUI(lanAccess, fileAccess)
    if ('error' in result && result.error) return null
    if (!('url' in result)) return null
    const runtime: WebUIRuntime = { port: result.port, token: result.token, url: result.url }
    setWebuiInfo(runtime)
    await resolveQrUrl(runtime, lanAccess)
    return runtime
  }

  // 打开弹窗时先对齐现状：WebUI 可能早就在跑（上次没停），不能让用户看到「未启动」再点一次
  useEffect(() => {
    let cancelled = false
    void ipc
      .getWebUIStatus()
      .then(async (status) => {
        if (cancelled || !status.running || !status.url) return
        const runtime = parseWebUIRuntime(status.url)
        // 状态接口只给 url；解析不出来就退回「不显示二维码」，其余信息与操作照常可用
        if (!runtime) {
          setWebuiInfo({ port: 0, token: '', url: status.url })
          setWebuiLanMissing(false)
          return
        }
        setWebuiInfo(runtime)
        await resolveQrUrl(runtime, webuiLanAccess)
      })
      .catch(() => { if (!cancelled) setWebuiError(t('remoteAccess.webuiOperationError')) })
      .finally(() => { if (!cancelled) setWebuiChecking(false) })
    return () => {
      cancelled = true
    }
    // 只在对齐现状那一次读设置：之后局域网开关由 handleToggleLanAccess 全权接管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStartWebUI = async () => {
    if (operationRef.current || webuiChecking) return
    operationRef.current = true
    setWebuiError(null)
    setWebuiStarting(true)
    try {
      const runtime = await startWebUIService(webuiLanAccess, webuiFileAccess)
      if (!runtime) setWebuiError(t('remoteAccess.webuiError'))
    } catch {
      setWebuiError(t('remoteAccess.webuiError'))
    } finally {
      operationRef.current = false
      setWebuiStarting(false)
    }
  }

  // 两个开关都改变主进程服务态；先成功重启，再保存与实际服务一致的设置。
  const restartWebUI = async (kind: 'lan' | 'file', lanAccess: boolean, fileAccess: boolean) => {
    if (operationRef.current || webuiChecking) return
    operationRef.current = true
    setWebuiError(null)
    setWebuiRestarting(kind)
    try {
      const stopped = await ipc.stopWebUI()
      if (!stopped.ok) throw new Error('WebUI stop was rejected')
      // 服务停止后旧链接已失效，重启失败时不能继续展示为可用地址。
      setWebuiInfo(null)
      setWebuiQrUrl(null)
      setWebuiLanMissing(false)
      const runtime = await startWebUIService(lanAccess, fileAccess)
      if (!runtime) throw new Error('WebUI restart failed')
      updateSettings({ webuiLanAccess: lanAccess, webuiFileAccess: fileAccess })
    } catch {
      setWebuiError(t('remoteAccess.webuiOperationError'))
    } finally {
      operationRef.current = false
      setWebuiRestarting(null)
    }
  }

  const handleToggleLanAccess = () => {
    const next = !webuiLanAccess
    void restartWebUI('lan', next, webuiFileAccess)
  }

  const handleToggleFileAccess = () => {
    const next = !webuiFileAccess
    void restartWebUI('file', webuiLanAccess, next)
  }

  const handleStopWebUI = async () => {
    if (operationRef.current || webuiChecking) return
    operationRef.current = true
    setWebuiStopping(true)
    setWebuiError(null)
    try {
      const stopped = await ipc.stopWebUI()
      if (!stopped.ok) throw new Error('WebUI stop was rejected')
      setWebuiInfo(null)
      setWebuiQrUrl(null)
      setWebuiLanMissing(false)
      setWebuiCopied(false)
    } catch {
      setWebuiError(t('remoteAccess.webuiOperationError'))
    } finally {
      operationRef.current = false
      setWebuiStopping(false)
    }
  }

  const handleCopyWebUIUrl = async () => {
    if (!webuiInfo) return
    try {
      await navigator.clipboard.writeText(webuiInfo.url)
      setWebuiError(null)
      setWebuiCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setWebuiCopied(false), 2000)
    } catch {
      setWebuiError(t('remoteAccess.webuiCopyError'))
    }
  }

  const openBots = (provider: BotProvider | null) => {
    setBotsEntryProvider(provider)
    setBotsOpen(true)
  }

  return (
    <>
      <Modal
        title={t('remoteAccess.title')}
        description={t('remoteAccess.desc')}
        onClose={onClose}
        widthClass="w-[800px]"
        bodyClassName="p-0"
        titleIcon={<Globe size={18} />}
      >
        <div role="tablist" aria-label={t('remoteAccess.title')} className="flex gap-1 border-b border-dark-onSurfaceVariant/10 px-5 pt-3">
          {(['cloud', 'local'] as const).map(tab => <button type="button" role="tab" id={`remote-tab-${tab}`} aria-controls={`remote-panel-${tab}`} aria-selected={accessTab === tab} key={tab} onClick={() => setAccessTab(tab)} className={`md-focus min-h-11 border-b-2 px-4 py-2 text-ui-sm transition-colors ${accessTab === tab ? 'border-md-primary text-md-primary' : 'border-transparent text-dark-onSurfaceVariant hover:bg-dark-surfaceContainer'}`}>{t(tab === 'cloud' ? 'remoteAccess.cloudTab' : 'remoteAccess.localTab')}</button>)}
        </div>
        {accessTab === 'cloud' ? <div role="tabpanel" id="remote-panel-cloud" aria-labelledby="remote-tab-cloud"><CloudRemotePanel /></div> : <div role="tabpanel" id="remote-panel-local" aria-labelledby="remote-tab-local" className="grid md:grid-cols-2">
          {/* ── 左栏：手机访问（WebUI）── */}
          <section className="min-w-0 p-6 max-md:p-4 md:border-r border-dark-onSurfaceVariant/10 max-md:border-b max-md:border-r-0">
            <div className="flex items-center gap-2.5 mb-2">
              <Smartphone size={16} className="text-md-primary" />
              <h3 className="text-ui-base font-semibold text-dark-onSurface">{t('remoteAccess.webuiTitle')}</h3>
            </div>
            <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-3">
              {t('remoteAccess.webuiDesc')}
            </p>

            {webuiBusy && (
              <p role="status" className="mb-3 flex items-center gap-2 text-ui-xs text-dark-onSurfaceVariant"><Loader2 size={14} className="animate-spin" aria-hidden />{webuiRestarting ? t('remoteAccess.webuiRestarting') : webuiStarting ? t('remoteAccess.webuiStarting') : t('common.loading')}</p>
            )}
            {webuiError && (
              <p role="alert" className="mb-3 flex items-start gap-2 rounded-md3-sm border border-md-error/20 bg-md-error/10 px-3 py-2 text-ui-xs leading-relaxed text-md-error"><AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />{webuiError}</p>
            )}

            {!webuiInfo && !webuiChecking && (
              <div className="p-3 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
                <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-3">
                  {t('remoteAccess.webuiIdleHint')}
                </p>
                <button
                  type="button"
                  onClick={handleStartWebUI}
                  disabled={webuiBusy}
                  className="md-focus w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-md3-sm text-ui-sm font-medium bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors disabled:opacity-50"
                >
                  {webuiStarting ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                  <span>{webuiStarting ? t('remoteAccess.webuiStarting') : t('remoteAccess.webuiStart')}</span>
                </button>
              </div>
            )}

            {webuiInfo && (
              <>
                <div className="flex items-center gap-2 p-2.5 rounded-md3-md bg-dark-surfaceContainerHigh mb-1">
                  <code className="flex-1 text-ui-xs break-all text-dark-onSurfaceVariant select-all">
                    {webuiInfo.url}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopyWebUIUrl}
                    className="md-focus flex-shrink-0 w-7 h-7 max-md:w-9 max-md:h-9 flex items-center justify-center rounded-md3-sm hover:bg-dark-surfaceContainer transition-colors"
                    aria-label={t('remoteAccess.webuiCopy')}
                    title={t('remoteAccess.webuiCopy')}
                  >
                    {webuiCopied ? <Check size={14} className="text-md-primary" /> : <Copy size={14} />}
                  </button>
                </div>
                {webuiCopied && <p role="status" className="text-ui-xs text-md-primary mb-1">{t('remoteAccess.webuiCopied')}</p>}

                {/* 扫码直达：仅在允许局域网访问且探测到网卡地址时展示 */}
                {webuiLanAccess && webuiQrUrl && (
                  <div className="flex flex-col items-center gap-1.5 py-3">
                    <QrCode text={webuiQrUrl} size={168} />
                    <p className="text-ui-xs text-dark-onSurfaceVariant/60 text-center">
                      {t('remoteAccess.webuiScanHint')}
                    </p>
                    <code className="text-ui-xs break-all text-center text-dark-onSurfaceVariant/50 px-4 select-all">
                      {webuiQrUrl}
                    </code>
                  </div>
                )}
                {webuiLanAccess && webuiLanMissing && (
                  <p className="text-ui-xs text-md-warning text-center py-2">{t('remoteAccess.webuiNoLanIp')}</p>
                )}

                <p className="text-ui-xs text-dark-onSurfaceVariant/60 mb-3">{t('remoteAccess.webuiSecurityNote')}</p>

                {/* 局域网访问开关：默认仅本机 127.0.0.1；开启后绑定 0.0.0.0 并重启服务 */}
                <div className="mb-2 p-2.5 rounded-md3-md bg-dark-surfaceContainerHigh">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={webuiLanAccess}
                      onChange={handleToggleLanAccess}
                      disabled={webuiBusy}
                      className="accent-md-primary"
                    />
                    <span className="text-ui-xs text-dark-onSurface">{t('remoteAccess.webuiLanAccess')}</span>
                    {webuiRestarting === 'lan' && <Loader2 size={12} className="animate-spin text-dark-onSurfaceVariant/60" />}
                  </label>
                  <p className="text-ui-xs text-dark-onSurfaceVariant/60 leading-relaxed mt-1">
                    {webuiRestarting === 'lan' ? t('remoteAccess.webuiRestarting') : t('remoteAccess.webuiLanHint')}
                  </p>
                </div>

                {/* 本机文件读取授权：默认关。远程文件面板/壁纸/审批预览都靠它，令牌泄露时它是最大的泄漏面 */}
                <div className="mb-4 p-2.5 rounded-md3-md bg-dark-surfaceContainerHigh">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={webuiFileAccess}
                      onChange={handleToggleFileAccess}
                      disabled={webuiBusy}
                      className="accent-md-primary"
                    />
                    <span className="text-ui-xs text-dark-onSurface">{t('remoteAccess.webuiFileAccess')}</span>
                    {webuiRestarting === 'file' && <Loader2 size={12} className="animate-spin text-dark-onSurfaceVariant/60" />}
                  </label>
                  <p className="text-ui-xs text-dark-onSurfaceVariant/60 leading-relaxed mt-1">
                    {webuiRestarting === 'file' ? t('remoteAccess.webuiFileRestarting') : t('remoteAccess.webuiFileHint')}
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => ipc.openExternal(webuiInfo.url)}
                    disabled={webuiBusy}
                    className="md-focus min-h-10 max-md:min-h-11 flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-sm bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors text-ui-sm disabled:opacity-50"
                  >
                    <ExternalLink size={15} />
                    <span>{t('remoteAccess.webuiOpen')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleStopWebUI}
                    disabled={webuiBusy}
                    className="md-focus min-h-10 max-md:min-h-11 inline-flex items-center gap-1.5 px-3 py-2 rounded-md3-sm border border-dark-onSurfaceVariant/15 hover:bg-dark-surfaceContainer transition-colors text-ui-sm disabled:opacity-50"
                  >
                    <Square size={13} />
                    <span>{t('remoteAccess.webuiStop')}</span>
                  </button>
                </div>
              </>
            )}
          </section>

          {/* ── 右栏：IM 机器人 ── */}
          <section className="min-w-0 p-6 max-md:p-4">
            <div className="flex items-center gap-2.5 mb-2">
              <MessageSquare size={16} className="text-md-primary" />
              <h3 className="text-ui-base font-semibold text-dark-onSurface">{t('remoteAccess.botsTitle')}</h3>
            </div>
            <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-3">
              {t('remoteAccess.botsDesc')}
            </p>

            <div className="space-y-2">
              {(
                [
                  ['weixin', 'remoteAccess.channelWeixin', 'remoteAccess.channelWeixinDesc'],
                  ['feishu', 'remoteAccess.channelFeishu', 'remoteAccess.channelFeishuDesc'],
                  ['telegram', 'remoteAccess.channelTelegram', 'remoteAccess.channelTelegramDesc'],
                  ['wecom', 'remoteAccess.channelWecom', 'remoteAccess.channelWecomDesc'],
                ] as Array<[BotProvider, string, string]>
              ).map(([provider, labelKey, descKey]) => (
                <button
                  key={provider}
                  type="button"
                  onClick={() => openBots(provider)}
                  className="md-focus w-full flex items-center gap-3 p-3.5 rounded-md3-md border border-dark-onSurfaceVariant/10 bg-dark-surface/50 hover:bg-dark-surfaceContainer transition-colors text-left"
                >
                  <ChannelBadge provider={provider} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-ui-sm text-dark-onSurface">{t(labelKey)}</span>
                    <span className="mt-1 block text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{t(descKey)}</span>
                  </span>
                  <span className="flex-shrink-0 flex items-center gap-0.5 text-ui-xs text-md-primary">
                    <span>{t('remoteAccess.botsOpen')}</span>
                    <ChevronRight size={12} />
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-3 pt-3 border-t border-dark-onSurfaceVariant/10">
              {!botsLoading && bots.length > 0 && (
                <p className="text-ui-xs text-dark-onSurfaceVariant/60 mb-2">
                  {t('remoteAccess.botsCount', { total: bots.length })}
                </p>
              )}
              <button
                type="button"
                onClick={() => openBots(null)}
                className="md-focus w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-sm text-ui-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors border border-dark-onSurfaceVariant/10"
              >
                <SlidersHorizontal size={13} />
                <span>{t('remoteAccess.botsManage')}</span>
              </button>
            </div>
          </section>
        </div>}
      </Modal>

      {botsOpen && (
        <BotsDialog
          entryProvider={botsEntryProvider}
          onClose={() => {
            setBotsOpen(false)
            setBotsEntryProvider(null)
          }}
        />
      )}
    </>
  )
}

function CloudRemotePanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [approve, setApprove] = useState(false)
  const [files, setFiles] = useState(true)
  const [busy, setBusy] = useState(false)
  const operation = useRef(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [verified, setVerified] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let active = true
    const accept = (value: RemoteAccessStatus) => {
      if (!active) return
      setStatus(value)
      if (value.permissions) { setApprove(value.permissions.approve); setFiles(value.permissions.files) }
    }
    const unsubscribe = ipc.onRemoteStatus(accept)
    void ipc.remoteGetStatus().then(accept).catch(() => { if (active) setError('remoteAccess.cloudOperationFailed') })
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { active = false; unsubscribe(); clearInterval(timer) }
  }, [])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer) }, [copied])
  useEffect(() => { setCopied(false) }, [status?.url])
  const act = async (operationFn: () => Promise<RemoteAccessStatus>, enable = false) => {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError('')
    let enableAttempted = false
    let ownerAttached = false
    try {
      if (enable) {
        const chat = useChatStore.getState()
        if (chat.streamingSessionIds.size || chat.compactingSessionIds.size || chat.stoppingSessionIds.size || chat.rewindingSessionIds.size) throw new Error('busy')
        enableAttempted = true
        agentClient.stop()
        await ipc.remotePrepare()
        await attachAgentEvents()
        ownerAttached = true
      }
      const result = await operationFn()
      setStatus(result)
    } catch (reason) { setError(reason instanceof Error && reason.message === 'busy' ? 'remoteAccess.cloudAgentBusy' : 'remoteAccess.cloudOperationFailed') }
    finally {
      if (enableAttempted && !ownerAttached) {
        // Main may already own the agent even if the network connection failed.
        agentClient.stop()
        try { await attachAgentEvents() } catch { setError('remoteAccess.cloudOperationFailed') }
      }
      operation.current = false
      setBusy(false)
    }
  }
  const validInvite = !!status?.url && (status.inviteExpiresAt || 0) > now
  const statusError = status?.error === 'remote-room-authentication-failed'
    ? 'remoteAccess.cloudCredentialsExpired'
    : status?.error === 'remote-restore-failed'
      ? 'remoteAccess.cloudRestoreFailed'
      : status?.state === 'error' ? 'remoteAccess.cloudConnectionError' : ''
  const visibleError = statusError || error
  const upgradeLegacyAccess = async () => {
    if (operation.current) return
    try {
      const confirmed = await ipc.confirmDialog(t('remoteAccess.cloudUpgradeAccess'), t('remoteAccess.cloudUpgradeAccessConfirm'))
      if (!confirmed) return
      await act(async () => {
        await ipc.remoteDisable()
        return ipc.remoteEnable({ scope: 'desktop', approve, files })
      })
    } catch { setError('remoteAccess.cloudOperationFailed') }
  }
  const buttonClass = 'md-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-md3-sm px-4 py-2 text-ui-sm disabled:opacity-40 transition-colors'
  return <section className="space-y-5 p-6 max-md:p-4" aria-labelledby="cloud-remote-title">
    <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md3-md bg-md-primary/10 text-md-primary"><Globe size={21} /></span><div><h3 id="cloud-remote-title" className="text-ui-base font-semibold text-dark-onSurface">{t('remoteAccess.cloudTitle')}</h3><p className="mt-1 text-ui-xs leading-relaxed text-dark-onSurfaceVariant">{t('remoteAccess.cloudDescription')}</p></div><span role="status" className="ml-auto shrink-0 rounded-full border border-dark-onSurfaceVariant/15 px-2.5 py-1 text-ui-xs text-dark-onSurfaceVariant">{t(`remoteAccess.cloudState_${status?.state || 'disabled'}`)}</span></div>
    {visibleError && <p role="alert" className="flex gap-2 rounded-md3-sm border border-md-error/20 bg-md-error/10 p-3 text-ui-xs leading-relaxed text-md-error"><AlertCircle size={15} className="shrink-0" />{t(visibleError)}</p>}
    {!status && !error && <p role="status" className="flex items-center gap-2 text-ui-xs text-dark-onSurfaceVariant"><Loader2 size={14} className="animate-spin" />{t('common.loading')}</p>}
    {status?.enabled && (status.scope !== 'desktop' || status.devices.some(device => device.scope !== 'desktop')) && <div className="space-y-3 rounded-md3-sm border border-md-primary/20 bg-md-primary/5 p-3"><p role="status" className="text-ui-xs leading-relaxed text-dark-onSurfaceVariant">{t('remoteAccess.cloudLegacyPairingNote')}</p>{status.scope !== 'desktop' && <button type="button" disabled={busy} className={`${buttonClass} bg-md-primary text-md-onPrimary hover:bg-md-primary/90`} onClick={() => { void upgradeLegacyAccess() }}><RefreshCw size={15} />{t('remoteAccess.cloudUpgradeAccess')}</button>}</div>}
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_288px]">
      <div className="min-w-0 space-y-4">
        <div className="rounded-md3-md border border-md-primary/20 bg-md-primary/5 p-4"><p className="text-ui-sm font-medium text-dark-onSurface">{t('remoteAccess.cloudWorkspace')}</p><p className="mt-2 text-ui-xs leading-relaxed text-dark-onSurfaceVariant">{t('remoteAccess.cloudWorkspaceNote')}</p></div>
        <fieldset disabled={busy || status?.enabled} className="space-y-3 rounded-md3-md border border-dark-onSurfaceVariant/15 p-4 disabled:opacity-70"><legend className="px-1 text-ui-xs font-medium text-dark-onSurface">{t('remoteAccess.cloudPermissions')}</legend><p className="text-ui-xs leading-relaxed text-dark-onSurfaceVariant">{t('remoteAccess.cloudControlNote')}</p><label className="flex min-h-8 cursor-pointer items-start gap-2 text-ui-xs leading-relaxed text-dark-onSurface"><input className="mt-0.5 accent-md-primary" type="checkbox" checked={approve} onChange={event => setApprove(event.target.checked)} />{t('remoteAccess.cloudAllowApprove')}</label><label className="flex min-h-8 cursor-pointer items-start gap-2 text-ui-xs leading-relaxed text-dark-onSurface"><input className="mt-0.5 accent-md-primary" type="checkbox" checked={files} onChange={event => setFiles(event.target.checked)} />{t('remoteAccess.cloudAllowFiles')}</label></fieldset>
        <div className="flex flex-wrap gap-2">{status?.enabled ? <><button type="button" className={`${buttonClass} bg-md-primary text-md-onPrimary hover:bg-md-primary/90`} disabled={busy || status.state !== 'online'} onClick={() => { void act(ipc.remoteCreateInvite) }}><LinkIcon />{t('remoteAccess.cloudNewInvite')}</button><button type="button" className={`${buttonClass} border border-dark-onSurfaceVariant/20 hover:bg-dark-surfaceContainer`} disabled={busy} onClick={() => { void act(ipc.remoteDisable) }}><Square size={13} />{t('remoteAccess.cloudDisable')}</button></> : <button type="button" className={`${buttonClass} bg-md-primary text-md-onPrimary hover:bg-md-primary/90`} disabled={busy || !status} onClick={() => { void act(() => ipc.remoteEnable({ scope: 'desktop', approve, files }), true) }}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}{t('remoteAccess.cloudEnable')}</button>}</div>
      </div>
      <div className="flex min-w-0 flex-col items-center justify-center gap-3 rounded-md3-md border border-dark-onSurfaceVariant/15 bg-dark-surfaceContainer/30 p-5">{validInvite ? <><QrCode text={status!.url!} size={224} /><span className="text-center text-ui-xs text-dark-onSurfaceVariant">{t('remoteAccess.cloudInviteExpiry', { seconds: Math.max(0, Math.ceil(((status?.inviteExpiresAt || 0) - now) / 1000)) })}</span><button type="button" className={`${buttonClass} w-full border border-dark-onSurfaceVariant/20 hover:bg-dark-surfaceContainer`} onClick={() => { void navigator.clipboard.writeText(status!.url!).then(() => setCopied(true)).catch(() => setError('remoteAccess.webuiCopyError')) }}>{copied ? <Check size={15} /> : <Copy size={15} />}{t(copied ? 'remoteAccess.webuiCopied' : 'remoteAccess.cloudCopyInvite')}</button><p className="text-center text-ui-xs leading-relaxed text-dark-onSurfaceVariant/65">{t('remoteAccess.cloudInviteSecret')}</p></> : <><ShieldCheck size={30} className="text-md-primary/70" /><p className="text-center text-ui-xs leading-relaxed text-dark-onSurfaceVariant">{t(status?.enabled ? 'remoteAccess.cloudInviteHint' : 'remoteAccess.cloudDisabledHint')}</p></>}</div>
    </div>
    {status?.enabled && <p className="text-ui-xs leading-relaxed text-dark-onSurfaceVariant/70">{t('remoteAccess.cloudInviteRotationNote')}</p>}
    {status?.pending.map(peer => <div key={peer.id} className="rounded-md3-md border border-md-primary/30 bg-md-primary/5 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-ui-sm font-medium text-dark-onSurface">{t('remoteAccess.cloudPairRequest', { name: peer.name })}</p><code className="mt-2 block text-xl font-semibold tracking-[.25em] text-md-primary">{peer.code}</code></div><div className="flex gap-2"><button type="button" className={`${buttonClass} border border-dark-onSurfaceVariant/20`} disabled={busy} onClick={() => { void act(() => ipc.remoteApprovePair(peer.id, false)) }}>{t('remoteAccess.cloudReject')}</button><button type="button" className={`${buttonClass} bg-md-primary text-md-onPrimary`} disabled={busy || !verified[peer.id]} onClick={() => { void act(() => ipc.remoteApprovePair(peer.id, true)) }}>{t('remoteAccess.cloudApproveDevice')}</button></div></div><label className="mt-3 flex min-h-9 items-center gap-2 text-ui-xs text-dark-onSurfaceVariant"><input type="checkbox" className="accent-md-primary" checked={verified[peer.id] || false} onChange={event => setVerified(value => ({ ...value, [peer.id]: event.target.checked }))} />{t('remoteAccess.cloudCodeVerified')}</label></div>)}
    {!!status?.devices.length && <div className="space-y-2 border-t border-dark-onSurfaceVariant/15 pt-4"><h4 className="text-ui-xs font-medium text-dark-onSurfaceVariant">{t('remoteAccess.cloudDeviceList')}</h4>{status.devices.map(device => <div key={device.id} className="flex items-center gap-3 rounded-md3-sm bg-dark-surfaceContainer/40 px-3 py-2"><ShieldCheck size={16} className="shrink-0 text-md-primary" /><div className="min-w-0 flex-1"><span className="block truncate text-ui-sm text-dark-onSurface">{device.name}</span><span className="text-ui-xs text-dark-onSurfaceVariant/70">{t(device.online ? 'remoteAccess.cloudDeviceOnline' : 'remoteAccess.cloudDeviceOffline')} · {t(device.scope === 'desktop' ? 'remoteAccess.cloudFullWorkbench' : 'remoteAccess.cloudLegacyWorkspace')}</span></div><button type="button" className={`${buttonClass} border border-dark-onSurfaceVariant/15 hover:bg-md-error/10`} disabled={busy} onClick={() => { void ipc.confirmDialog(t('remoteAccess.cloudRevoke'), t('remoteAccess.cloudRevokeConfirm', { name: device.name })).then(accepted => { if (accepted) void act(() => ipc.remoteRevokeDevice(device.id)) }) }}><Trash2 size={14} />{t('remoteAccess.cloudRevoke')}</button></div>)}</div>}
    <p className="flex gap-2 text-ui-xs leading-relaxed text-dark-onSurfaceVariant/65"><ShieldCheck size={15} className="mt-0.5 shrink-0" /><span>{t('remoteAccess.cloudPrivacy')} {t('remoteAccess.cloudDisconnectNote')}</span></p>
  </section>
}

function LinkIcon() { return <RefreshCw size={15} /> }
