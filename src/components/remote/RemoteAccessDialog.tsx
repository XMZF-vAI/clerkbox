import { useEffect, useState } from 'react'
import { Check, ChevronRight, Copy, ExternalLink, Globe, Loader2, MessageSquare, Play, Smartphone, Square, SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Modal from '../ui/Modal'
import QrCode from '../ui/QrCode'
import BotsDialog from '../bots/BotsDialog'
import { ChannelBadge } from '../bots/channelIcons'
import { useBots } from '../bots/useBots'
import { ipc } from '../../lib/ipc-client'
import { useSettingsStore } from '../../stores/settings-store'
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
  const { bots, loading: botsLoading } = useBots()

  // ── WebUI 控制（自 Sidebar 原样搬运）──
  const [webuiStarting, setWebuiStarting] = useState(false)
  const [webuiInfo, setWebuiInfo] = useState<WebUIRuntime | null>(null)
  const [webuiCopied, setWebuiCopied] = useState(false)
  const [webuiRestarting, setWebuiRestarting] = useState(false)
  // 二维码内容：仅在「允许局域网访问」且检测到局域网 IP 时才生成（绝不指向 localhost）
  const [webuiQrUrl, setWebuiQrUrl] = useState<string | null>(null)
  // 开启了局域网访问但没探测到可用网卡地址
  const [webuiLanMissing, setWebuiLanMissing] = useState(false)
  const webuiLanAccess = useSettingsStore((s) => s.webuiLanAccess)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [botsOpen, setBotsOpen] = useState(false)
  const [botsEntryProvider, setBotsEntryProvider] = useState<BotProvider | null>(null)

  /** 解析二维码 URL：lanAllowed 时取第一个非内部 IPv4 拼 URL，否则不生成二维码 */
  const resolveQrUrl = async (result: WebUIRuntime, lanAllowed: boolean) => {
    const ips = await ipc.getLanAddresses().catch(() => [] as string[])
    const ip = lanAllowed ? ips[0] : undefined
    setWebuiQrUrl(ip ? `http://${ip}:${result.port}/?token=${result.token}` : null)
    setWebuiLanMissing(lanAllowed && !ip)
  }

  /** 起服务并刷新二维码：返回 null 表示主进程给了错误（调用方按错误分支提示） */
  const startWebUIService = async (lanAccess: boolean): Promise<WebUIRuntime | null> => {
    const result = await ipc.startWebUI(lanAccess)
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
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // 只在对齐现状那一次读设置：之后局域网开关由 handleToggleLanAccess 全权接管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStartWebUI = async () => {
    if (webuiStarting) return
    setWebuiStarting(true)
    try {
      const runtime = await startWebUIService(webuiLanAccess)
      if (!runtime) alert(t('remoteAccess.webuiError'))
    } catch {
      alert(t('remoteAccess.webuiError'))
    } finally {
      setWebuiStarting(false)
    }
  }

  // 切换局域网访问：写设置后重启 WebUI 以应用新的绑定范围（127.0.0.1 ↔ 0.0.0.0）
  const handleToggleLanAccess = async () => {
    if (webuiRestarting) return
    setWebuiRestarting(true)
    const next = !webuiLanAccess
    updateSettings({ webuiLanAccess: next })
    try {
      await ipc.stopWebUI()
      await startWebUIService(next)
    } catch {
      /* 重启失败时保留原状态，用户可手动重试（与搬运前一致） */
    } finally {
      setWebuiRestarting(false)
    }
  }

  const handleStopWebUI = async () => {
    await ipc.stopWebUI()
    setWebuiInfo(null)
    setWebuiQrUrl(null)
    setWebuiLanMissing(false)
  }

  const handleCopyWebUIUrl = async () => {
    if (!webuiInfo) return
    try {
      await navigator.clipboard.writeText(webuiInfo.url)
      setWebuiCopied(true)
      setTimeout(() => setWebuiCopied(false), 2000)
    } catch {
      /* 剪贴板不可用时忽略 */
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
        widthClass="w-[680px]"
        bodyClassName="p-0"
        titleIcon={<Globe size={18} />}
      >
        <div className="grid md:grid-cols-2">
          {/* ── 左栏：手机访问（WebUI）── */}
          <section className="p-5 max-md:p-4 md:border-r border-dark-onSurfaceVariant/10 max-md:border-b max-md:border-r-0">
            <div className="flex items-center gap-2 mb-1">
              <Smartphone size={16} className="text-md-primary" />
              <h3 className="text-ui-sm font-medium text-dark-onSurface">{t('remoteAccess.webuiTitle')}</h3>
            </div>
            <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-3">
              {t('remoteAccess.webuiDesc')}
            </p>

            {!webuiInfo && (
              <div className="p-3 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
                <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-3">
                  {t('remoteAccess.webuiIdleHint')}
                </p>
                <button
                  type="button"
                  onClick={handleStartWebUI}
                  disabled={webuiStarting}
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
                {webuiCopied && <p className="text-ui-xs text-md-primary mb-1">{t('remoteAccess.webuiCopied')}</p>}

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
                <div className="mb-4 p-2.5 rounded-md3-md bg-dark-surfaceContainerHigh">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={webuiLanAccess}
                      onChange={handleToggleLanAccess}
                      disabled={webuiRestarting}
                      className="accent-md-primary"
                    />
                    <span className="text-ui-xs text-dark-onSurface">{t('remoteAccess.webuiLanAccess')}</span>
                    {webuiRestarting && <Loader2 size={12} className="animate-spin text-dark-onSurfaceVariant/60" />}
                  </label>
                  <p className="text-ui-xs text-dark-onSurfaceVariant/60 leading-relaxed mt-1">
                    {webuiRestarting ? t('remoteAccess.webuiRestarting') : t('remoteAccess.webuiLanHint')}
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => ipc.openExternal(webuiInfo.url)}
                    className="md-focus flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-md bg-md-primary text-md-onPrimary hover:opacity-90 transition-opacity text-ui-sm"
                  >
                    <ExternalLink size={15} />
                    <span>{t('remoteAccess.webuiOpen')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleStopWebUI}
                    className="md-focus inline-flex items-center gap-1.5 px-3 py-2 rounded-md3-md bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-ui-sm"
                  >
                    <Square size={13} />
                    <span>{t('remoteAccess.webuiStop')}</span>
                  </button>
                </div>
              </>
            )}
          </section>

          {/* ── 右栏：IM 机器人 ── */}
          <section className="p-5 max-md:p-4">
            <div className="flex items-center gap-2 mb-1">
              <MessageSquare size={16} className="text-md-primary" />
              <h3 className="text-ui-sm font-medium text-dark-onSurface">{t('remoteAccess.botsTitle')}</h3>
            </div>
            <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-3">
              {t('remoteAccess.botsDesc')}
            </p>

            <div className="space-y-2">
              {(['weixin', 'feishu'] as BotProvider[]).map((provider) => (
                <button
                  key={provider}
                  type="button"
                  onClick={() => openBots(provider)}
                  className="md-focus w-full flex items-center gap-3 p-3 rounded-md3-md border border-dark-onSurfaceVariant/10 hover:bg-dark-surfaceContainer transition-colors text-left"
                >
                  <ChannelBadge provider={provider} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-ui-sm text-dark-onSurface">
                      {t(provider === 'weixin' ? 'remoteAccess.channelWeixin' : 'remoteAccess.channelFeishu')}
                    </span>
                    <span className="block text-ui-xs text-dark-onSurfaceVariant/70 truncate">
                      {t(provider === 'weixin' ? 'remoteAccess.channelWeixinDesc' : 'remoteAccess.channelFeishuDesc')}
                    </span>
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
        </div>
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
