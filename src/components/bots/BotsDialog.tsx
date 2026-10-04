import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, FolderCog, Loader2, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Modal, { useOverlayKeyboardLock } from '../ui/Modal'
import ConfirmDialog from '../ui/ConfirmDialog'
import BindPanel from './BindPanel'
import FeishuSetupCard from './FeishuSetupCard'
import WeixinSetupCard from './WeixinSetupCard'
import { ChannelBadge } from './channelIcons'
import { useBots } from './useBots'
import { ipc } from '../../lib/ipc-client'
import type { BotListItem, BotProvider } from '../../../electron/im-bots/types'

/** 首发渠道清单：与主进程 BOT_PROVIDERS 同序。渲染层刻意只做 type import，不引运行时值 */
const PROVIDERS: BotProvider[] = ['weixin', 'feishu']

interface BotsDialogProps {
  onClose: () => void
  /** 从「远程访问」的渠道卡进来：直接落到该渠道的新建流程（ZCode 的 entryProvider 模式） */
  entryProvider?: BotProvider | null
}

/** 详情区的编辑草稿：只装可改字段，enabled 走即时生效的开关 */
interface DetailDraft {
  name: string
  defaultWorkDir: string
}

/** 新建流程的草稿：provider 为空时先选渠道 */
interface CreateDraft {
  provider: BotProvider | null
  name: string
}

const EMPTY_CREATE: CreateDraft = { provider: null, name: '' }

/** 六态点：颜色表达状态，文字表达状态名，两者分头给（色盲用户只读文字也够） */
const STATUS_DOT: Record<BotListItem['status'], string> = {
  idle: 'bg-dark-onSurfaceVariant/40',
  starting: 'bg-md-warning',
  polling: 'bg-md-primary',
  connected: 'bg-md-success',
  error: 'bg-md-error',
  disabled: 'bg-dark-onSurfaceVariant/30',
}

const STATUS_LABEL_KEY: Record<BotListItem['status'], string> = {
  idle: 'bots.status.idle',
  starting: 'bots.status.starting',
  polling: 'bots.status.polling',
  connected: 'bots.status.connected',
  error: 'bots.status.error',
  disabled: 'bots.status.disabled',
}

function StatusDot({ state, pulse }: { state: BotListItem['status']; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[state]} ${
        pulse && (state === 'starting' || state === 'polling') ? 'animate-pulse' : ''
      }`}
    />
  )
}

function providerLabelKey(provider: BotProvider): string {
  return provider === 'weixin' ? 'bots.channel.weixin' : 'bots.channel.feishu'
}

/** 一句话渠道说明：键名写成字面量返回，i18n 校验与代码审查都能直接对上 */
function providerDescKey(provider: BotProvider): string {
  return provider === 'weixin' ? 'bots.channelDesc.weixin' : 'bots.channelDesc.feishu'
}

/**
 * IM 机器人管理面板（左列表 + 右详情）。
 *
 * 详情页刻意按「凭据 → 绑定 → 工作目录 → 危险操作」的顺序排：这四步就是新用户从 0 到
 * 能在微信里发任务的实际路径，任何一步没做完，下一步都是徒劳（没凭据就发不出绑定码）。
 */
export default function BotsDialog({ onClose, entryProvider }: BotsDialogProps) {
  const { t } = useTranslation()
  const { bots, loading, loadError, refresh, statusOf } = useBots()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [create, setCreate] = useState<CreateDraft | null>(entryProvider ? { ...EMPTY_CREATE, provider: entryProvider } : null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [draft, setDraft] = useState<DetailDraft>({ name: '', defaultWorkDir: '' })
  const [saving, setSaving] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<BotListItem | null>(null)
  const [pendingReset, setPendingReset] = useState<BotListItem | null>(null)

  // 删除确认框叠在本弹窗之上：期间让出 Modal 的 Esc / Tab，否则一次按键关掉两层
  // Esc 要一次只关一层：确认框叠在 Modal 上时，锁必须把两个都算进去
  // （只写 pendingDelete 的话，重置确认框开着按 Esc 会把整个弹窗一起关掉）
  useOverlayKeyboardLock(pendingDelete !== null || pendingReset !== null)

  const selected = useMemo(() => bots.find((item) => item.id === selectedId) ?? null, [bots, selectedId])

  // 列表变化后校正选中项：删完了就回到空态，外部新建第一个 bot 时自动选中它
  useEffect(() => {
    if (create) return
    if (selectedId && bots.some((item) => item.id === selectedId)) return
    setSelectedId(bots[0]?.id ?? null)
  }, [bots, create, selectedId])

  // 选中项变化 → 重置草稿。凭据类字段不进草稿：它们由渠道卡片自己管，这里是元数据
  useEffect(() => {
    if (!selected) return
    setDraft({ name: selected.name, defaultWorkDir: selected.defaultWorkDir ?? '' })
    setDetailError(null)
  }, [selected?.id, selected?.name, selected?.defaultWorkDir])

  const dirty =
    !!selected && (draft.name !== selected.name || draft.defaultWorkDir !== (selected.defaultWorkDir ?? ''))

  const submitCreate = useCallback(async () => {
    const provider = create?.provider
    if (!provider || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const name = (create?.name ?? '').trim() || t('bots.newBotFallback')
      /*
       * 新建只提交元数据：id 与 credentialRef 都不传。
       * 主进程给新 bot 发号，并按 bot-<provider>-<id> 生成凭据命名空间——
       * 这两个字段让渲染层指定，就等于让外部自选主键、甚至覆盖别人的凭据条目。
       */
      const result = await ipc.bots.upsert({
        provider,
        name,
        enabled: true,
      })
      if (!result.ok) {
        setCreateError(t('bots.error.createFailed', { error: result.error }))
        return
      }
      setCreate(null)
      await refresh()
      // data 是可选字段：拿得到就选中新机器人，拿不到就交给上面的校正效应落到列表首项
      if (result.data) setSelectedId(result.data.id)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }, [create?.name, create?.provider, creating, refresh, t])

  const submitDraft = useCallback(async () => {
    if (!selected || saving) return
    setSaving(true)
    setDetailError(null)
    try {
      const name = draft.name.trim() || selected.name
      // 更新同样不回传 credentialRef：strict 入参装不下它，主进程按 id 保留原值
      const result = await ipc.bots.upsert({
        id: selected.id,
        provider: selected.provider,
        name,
        enabled: selected.enabled,
        ...(draft.defaultWorkDir.trim() ? { defaultWorkDir: draft.defaultWorkDir.trim() } : {}),
      })
      if (!result.ok) {
        setDetailError(t('bots.error.saveFailed', { error: result.error }))
        return
      }
      await refresh()
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [draft.defaultWorkDir, draft.name, refresh, saving, selected, t])

  const toggleEnabled = useCallback(
    async (next: boolean) => {
      if (!selected) return
      setDetailError(null)
      try {
        const result = await ipc.bots.setEnabled(selected.id, next)
        if (!result.ok) setDetailError(t('bots.error.toggleFailed', { error: result.error }))
        await refresh()
      } catch (error) {
        setDetailError(error instanceof Error ? error.message : String(error))
      }
    },
    [refresh, selected, t]
  )

  const chooseWorkDir = useCallback(async () => {
    const dir = await ipc.selectFolder().catch(() => null)
    if (dir) setDraft((prev) => ({ ...prev, defaultWorkDir: dir }))
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    const id = pendingDelete.id
    setPendingDelete(null)
    setDetailError(null)
    try {
      const result = await ipc.bots.remove(id)
      if (!result.ok) setDetailError(t('bots.error.removeFailed', { error: result.error }))
      if (selectedId === id) setSelectedId(null)
      await refresh()
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error))
    }
  }, [pendingDelete, refresh, selectedId, t])

  /**
   * 重置这个 bot 的 IM 侧状态：绑定关系、聊天上下文与长轮询游标一次清干净，
   * 配置与凭据保留（区别于删除，也区别于 BindPanel 里按单个账号的重置）。
   * 典型场景是换了自己的微信账号、或游标卡死不再收到新消息。
   */
  const confirmReset = useCallback(async () => {
    if (!pendingReset) return
    const id = pendingReset.id
    setPendingReset(null)
    setDetailError(null)
    try {
      const result = await ipc.bots.resetBot(id)
      if (!result.ok) setDetailError(t('bots.error.resetFailed', { error: result.error }))
      await refresh()
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error))
    }
  }, [pendingReset, refresh, t])

  const startCreate = useCallback((provider: BotProvider | null) => {
    setCreate({ provider, name: '' })
    setCreateError(null)
    setSelectedId(null)
  }, [])

  const status = selected ? statusOf(selected.id) : undefined

  return (
    <Modal
      title={t('bots.title')}
      description={t('bots.desc')}
      onClose={onClose}
      widthClass="w-[720px]"
      bodyClassName="p-0"
      bodyScroll={false}
      titleIcon={<Bot size={18} />}
    >
      <div className="h-full flex max-md:flex-col min-h-0">
        {/* ── 左：机器人列表 ── */}
        <div className="w-[220px] max-md:w-full max-md:border-b border-dark-onSurfaceVariant/10 flex flex-col min-h-0 max-md:max-h-[168px]">
          <div className="px-3 pt-1 pb-1.5 text-ui-xs font-medium text-dark-onSurfaceVariant/50 uppercase tracking-wider">
            {t('bots.listTitle')}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2">
            {loading && (
              <p className="px-2 py-3 text-ui-xs text-dark-onSurfaceVariant/60 flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                {t('common.loading')}
              </p>
            )}
            {!loading && bots.length === 0 && (
              <p className="px-2 py-3 text-ui-xs text-dark-onSurfaceVariant/60 leading-relaxed">{t('bots.empty')}</p>
            )}
            <ul className="space-y-0.5">
              {bots.map((item) => {
                const active = item.id === selectedId && !create
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setCreate(null)
                        setSelectedId(item.id)
                      }}
                      aria-current={active}
                      className={`md-focus w-full flex items-center gap-2 px-2 py-2 rounded-md3-xs text-ui-xs transition-colors text-left ${
                        active
                          ? 'bg-md-secondaryContainer text-md-onSecondaryContainer'
                          : 'text-dark-onSurfaceVariant/85 hover:bg-dark-surfaceContainer'
                      }`}
                    >
                      <ChannelBadge provider={item.provider} size="sm" />
                      <span className="flex-1 truncate">{item.name}</span>
                      <StatusDot state={statusOf(item.id)?.state ?? item.status} pulse />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="p-2 border-t border-dark-onSurfaceVariant/10">
            <button
              type="button"
              onClick={() => startCreate(null)}
              className="md-focus w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md3-sm bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors text-ui-xs text-dark-onSurfaceVariant"
            >
              <Plus size={14} />
              <span>{t('bots.addBot')}</span>
            </button>
          </div>
        </div>

        {/* ── 右：详情 / 新建 ── */}
        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {loadError && (
            <p role="alert" className="text-ui-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2">
              {t('bots.error.loadFailed')}
            </p>
          )}

          {create && (
            <div className="space-y-3">
              <p className="text-ui-sm font-medium text-dark-onSurface">{t('bots.newBotTitle')}</p>
              <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{t('bots.chooseChannelHint')}</p>
              <div className="grid gap-2 max-md:grid-cols-1">
                {PROVIDERS.map((provider) => {
                  const picked = create.provider === provider
                  return (
                    <button
                      key={provider}
                      type="button"
                      onClick={() => setCreate((prev) => (prev ? { ...prev, provider } : prev))}
                      aria-pressed={picked}
                      className={`md-focus flex items-center gap-2.5 p-3 rounded-md3-md border text-left transition-colors ${
                        picked
                          ? 'border-md-primary/40 bg-md-primary/10'
                          : 'border-dark-onSurfaceVariant/10 hover:bg-dark-surfaceContainer'
                      }`}
                    >
                      <ChannelBadge provider={provider} />
                      <span className="min-w-0">
                        <span className="block text-ui-sm text-dark-onSurface">{t(providerLabelKey(provider))}</span>
                        <span className="block text-ui-xs text-dark-onSurfaceVariant/70 truncate">
                          {t(providerDescKey(provider))}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>

              <div>
                <label className="block text-ui-xs text-dark-onSurfaceVariant mb-1" htmlFor="bot-new-name">
                  {t('bots.name')}
                </label>
                <input
                  id="bot-new-name"
                  value={create.name}
                  onChange={(e) => setCreate((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                  placeholder={t('bots.namePlaceholder')}
                  className="w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-ui-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors"
                />
              </div>

              {createError && (
                <p role="alert" className="text-ui-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2">
                  {createError}
                </p>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={submitCreate}
                  disabled={!create.provider || creating}
                  className="md-focus inline-flex items-center gap-1.5 px-4 py-2 rounded-md3-sm text-ui-sm font-medium bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors disabled:opacity-50"
                >
                  {creating && <Loader2 size={14} className="animate-spin" />}
                  <span>{t('bots.create')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreate(null)
                    setSelectedId(bots[0]?.id ?? null)
                  }}
                  className="md-focus inline-flex items-center gap-1.5 px-4 py-2 rounded-md3-sm text-ui-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
                >
                  <X size={14} />
                  <span>{t('common.cancel')}</span>
                </button>
              </div>
            </div>
          )}

          {!create && !selected && !loading && (
            <div className="h-full flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Bot size={22} className="text-dark-onSurfaceVariant/40" />
              <p className="text-ui-xs text-dark-onSurfaceVariant/60">{t('bots.emptyHint')}</p>
            </div>
          )}

          {!create && selected && (
            <>
              <div className="flex items-start gap-3">
                <ChannelBadge provider={selected.provider} />
                <div className="flex-1 min-w-0">
                  <input
                    aria-label={t('bots.name')}
                    value={draft.name}
                    onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                    className="w-full bg-transparent text-ui-sm font-medium text-dark-onSurface outline-none border-b border-transparent focus:border-md-primary/40 transition-colors"
                  />
                  <p className="mt-1 flex items-center gap-1.5 text-ui-xs text-dark-onSurfaceVariant/70">
                    <StatusDot state={status?.state ?? selected.status} pulse />
                    <span>{t(STATUS_LABEL_KEY[status?.state ?? selected.status])}</span>
                    <span className="text-dark-onSurfaceVariant/40">·</span>
                    <span>{selected.hasCredential ? t('bots.credentialReady') : t('bots.noCredential')}</span>
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer flex-shrink-0 pt-1">
                  <input
                    type="checkbox"
                    checked={selected.enabled}
                    onChange={(e) => void toggleEnabled(e.target.checked)}
                    className="accent-md-primary"
                  />
                  <span className="text-ui-xs text-dark-onSurface">{t('bots.enabled')}</span>
                </label>
              </div>

              {/* error 态的 message 是主进程给的排错线索，也是用户唯一能看到的一句解释，单独摊开 */}
              {(status?.state ?? selected.status) === 'error' && (status?.message ?? selected.statusMessage) && (
                <p
                  role="alert"
                  className="text-ui-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2 leading-relaxed"
                >
                  {status?.message ?? selected.statusMessage}
                </p>
              )}

              {selected.provider === 'weixin' ? (
                <WeixinSetupCard bot={selected} onChanged={refresh} />
              ) : (
                <FeishuSetupCard bot={selected} onChanged={refresh} />
              )}

              <BindPanel bot={selected} onChanged={refresh} />

              {/* 默认工作目录 */}
              <div className="p-3 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
                <div className="flex items-center gap-2 mb-1">
                  <FolderCog size={15} className="text-md-primary flex-shrink-0" />
                  <span className="text-ui-sm font-medium text-dark-onSurface">{t('bots.workDir.title')}</span>
                </div>
                <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-2">{t('bots.workDir.desc')}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 text-ui-xs break-all text-dark-onSurfaceVariant select-all">
                    {draft.defaultWorkDir || t('bots.workDir.none')}
                  </code>
                  <button
                    type="button"
                    onClick={() => void chooseWorkDir()}
                    className="md-focus px-3 py-1.5 rounded-md3-sm text-ui-xs bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer transition-colors"
                  >
                    {t('bots.workDir.choose')}
                  </button>
                  {draft.defaultWorkDir && (
                    <button
                      type="button"
                      onClick={() => setDraft((prev) => ({ ...prev, defaultWorkDir: '' }))}
                      className="md-focus px-3 py-1.5 rounded-md3-sm text-ui-xs text-dark-onSurfaceVariant/70 hover:bg-dark-surfaceContainerHigh transition-colors"
                    >
                      {t('bots.workDir.clear')}
                    </button>
                  )}
                </div>
              </div>

              {/* 未保存提示 + 保存：元数据改动（名称 / 目录）统一一次提交，避免改一个字写一次盘 */}
              {dirty && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void submitDraft()}
                    disabled={saving}
                    className="md-focus inline-flex items-center gap-1.5 px-4 py-2 rounded-md3-sm text-ui-sm font-medium bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors disabled:opacity-50"
                  >
                    {saving && <Loader2 size={14} className="animate-spin" />}
                    <span>{t('bots.save')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({ name: selected.name, defaultWorkDir: selected.defaultWorkDir ?? '' })
                    }
                    className="md-focus px-4 py-2 rounded-md3-sm text-ui-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
                  >
                    {t('bots.discard')}
                  </button>
                  <span className="text-ui-xs text-dark-onSurfaceVariant/60">{t('bots.dirty')}</span>
                </div>
              )}

              {detailError && (
                <p role="alert" className="text-ui-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2">
                  {detailError}
                </p>
              )}

              {/* 危险区：重置会清掉绑定与游标，删除会连带清掉凭据，两个都过确认 */}
              <div className="pt-3 border-t border-dark-onSurfaceVariant/10 flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setPendingReset(selected)}
                  className="md-focus inline-flex items-center gap-1.5 px-3 py-2 rounded-md3-sm text-ui-xs text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh transition-colors"
                >
                  <RotateCcw size={13} />
                  <span>{t('bots.resetAll')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDelete(selected)}
                  className="md-focus inline-flex items-center gap-1.5 px-3 py-2 rounded-md3-sm text-ui-xs text-md-error hover:bg-md-error/10 transition-colors"
                >
                  <Trash2 size={13} />
                  <span>{t('bots.delete')}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {pendingReset && (
        <ConfirmDialog
          title={t('bots.resetAllTitle')}
          message={t('bots.resetAllMsg')}
          confirmText={t('bots.resetAll')}
          cancelText={t('common.cancel')}
          variant="danger"
          onConfirm={() => void confirmReset()}
          onCancel={() => setPendingReset(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t('bots.deleteTitle')}
          message={t('bots.deleteMsg')}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </Modal>
  )
}
