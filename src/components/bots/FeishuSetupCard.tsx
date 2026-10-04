import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, KeyRound, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import type { BotListItem } from '../../../electron/im-bots/types'

interface FeishuSetupCardProps {
  bot: BotListItem
  /** 列表重拉：凭据写入通道接上后，hasCredential 由主进程决定 */
  onChanged: () => void
}

/** 飞书开放平台的应用列表页（无 token、无用户标识，可以直接开外链） */
const FEISHU_CONSOLE_URL = 'https://open.feishu.cn/app'

const inputCls =
  'w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-ui-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors'

/**
 * 飞书自建应用凭据表单。
 *
 * 本期只做「手动粘贴 App ID / App Secret」：ZCode 的扫码建应用依赖它的云端配合，列为 P2。
 * App Secret 一律 `type="password"`，保存后立刻清空输入框——界面上不再回显明文，
 * 也不进日志、不拼进任何 URL（外链只指向公开的控制台地址）。
 */
export default function FeishuSetupCard({ bot, onChanged }: FeishuSetupCardProps) {
  const { t } = useTranslation()
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // 切换 bot 时清草稿：上一个机器人的 App ID 不该出现在这一个的表单里
  useEffect(() => {
    setAppId('')
    setAppSecret('')
    setSaved(false)
    setFormError(null)
  }, [bot.id])

  const save = useCallback(async () => {
    if (saving) return
    const trimmedId = appId.trim()
    const trimmedSecret = appSecret.trim()
    if (!trimmedId || !trimmedSecret) {
      setFormError(t('bots.feishu.required'))
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      // 先存元数据再写凭据：元数据失败就没有必要留下半份凭据；
      // 凭据失败则元数据仍然自洽（只是连不上），且界面上会明确说出哪一步没成。
      // 注意这里不能再回传 credentialRef：bots:upsert 的入参是 strict 的，
      // 那个字段只由主进程按 bot-<provider>-<id> 生成。
      const meta = await ipc.bots.upsert({
        id: bot.id,
        provider: bot.provider,
        name: bot.name,
        enabled: bot.enabled,
        ...(bot.defaultWorkDir ? { defaultWorkDir: bot.defaultWorkDir } : {}),
      })
      if (!meta.ok) {
        setFormError(t('bots.error.saveFailed', { error: meta.error }))
        return
      }
      const credential = await ipc.bots.setCredential(bot.id, { appId: trimmedId, appSecret: trimmedSecret })
      if (!credential.ok) {
        setFormError(t('bots.error.credentialFailed', { error: credential.error }))
        return
      }
      // App Secret 不在界面上留明文：保存动作完成后当场抹掉
      setAppSecret('')
      setSaved(true)
      await onChanged()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [appId, appSecret, bot, onChanged, saving, t])

  return (
    <div className="p-3 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound size={15} className="text-md-primary flex-shrink-0" />
        <span className="text-ui-sm font-medium text-dark-onSurface">{t('bots.feishu.title')}</span>
      </div>
      <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-2">{t('bots.feishu.desc')}</p>

      <button
        type="button"
        onClick={() => void ipc.openExternal(FEISHU_CONSOLE_URL)}
        className="md-focus inline-flex items-center gap-1.5 text-ui-xs text-md-primary hover:underline mb-3"
      >
        <ExternalLink size={12} />
        <span>{t('bots.feishu.guideLink')}</span>
      </button>

      {/* 需要的权限点：少一个就是「能收不到发」或「能发收不到」，值得单独列出来 */}
      <div className="mb-3 p-2.5 rounded-md3-sm bg-dark-surfaceContainerHigh">
        <p className="text-ui-xs font-medium text-dark-onSurfaceVariant uppercase tracking-wider mb-1.5">
          {t('bots.feishu.permissions')}
        </p>
        <ul className="space-y-1">
          <li className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{t('bots.feishu.permReceive')}</li>
          <li className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{t('bots.feishu.permSend')}</li>
        </ul>
      </div>

      <div className="space-y-2">
        <div>
          <label className="block text-ui-xs text-dark-onSurfaceVariant mb-1" htmlFor={`feishu-appid-${bot.id}`}>
            {t('bots.feishu.appId')}
          </label>
          <input
            id={`feishu-appid-${bot.id}`}
            className={inputCls}
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder={t('bots.feishu.appIdPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="block text-ui-xs text-dark-onSurfaceVariant mb-1" htmlFor={`feishu-secret-${bot.id}`}>
            {t('bots.feishu.appSecret')}
          </label>
          <input
            id={`feishu-secret-${bot.id}`}
            type="password"
            className={inputCls}
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={t('bots.feishu.appSecretPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>

      {formError && (
        <p role="alert" className="mt-2 text-ui-xs text-md-error bg-md-error/10 border border-md-error/20 rounded-md3-sm px-3 py-2">
          {formError}
        </p>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="md-focus inline-flex items-center gap-1.5 px-4 py-2 rounded-md3-sm text-ui-sm font-medium bg-md-primary text-md-onPrimary hover:bg-md-primary/90 transition-colors disabled:opacity-50"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          <span>{saving ? t('bots.feishu.saving') : t('bots.feishu.save')}</span>
        </button>
        {/* 保存后不回显明文：只说「有没有凭据」，值本身一个字都不留在界面上 */}
        {bot.hasCredential ? (
          <span className="text-ui-xs text-md-success">{t('bots.credentialReady')}</span>
        ) : (
          saved && (
            <p className="text-ui-xs text-md-success leading-relaxed">{t('bots.feishu.credentialSaved')}</p>
          )
        )}
      </div>

    </div>
  )
}
