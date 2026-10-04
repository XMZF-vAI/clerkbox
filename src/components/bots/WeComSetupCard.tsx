import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, KeyRound, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import type { BotListItem } from '../../../electron/im-bots/types'

interface WeComSetupCardProps {
  bot: BotListItem
  /** 列表重拉：凭据写入通道接上后，hasCredential 由主进程决定 */
  onChanged: () => void
}

/** 企业微信智能机器人长连接的官方文档（创建步骤与限制都在这一页） */
const WECOM_DOC_URL = 'https://developer.work.weixin.qq.com/document/path/101463'

const inputCls =
  'w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-ui-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors'

/**
 * 企业微信智能机器人凭据表单：管理后台「智能机器人 → 创建机器人 → API 模式 →
 * 连接方式选长连接」拿到的 BotID + Secret。长连接是出站 WebSocket，不需要公网回调。
 */
export default function WeComSetupCard({ bot, onChanged }: WeComSetupCardProps) {
  const { t } = useTranslation()
  const [botId, setBotId] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // 切换 bot 时清草稿：上一个机器人的 BotID 不该出现在这一个的表单里
  useEffect(() => {
    setBotId('')
    setSecret('')
    setSaved(false)
    setFormError(null)
  }, [bot.id])

  const save = useCallback(async () => {
    if (saving) return
    const trimmedId = botId.trim()
    const trimmedSecret = secret.trim()
    if (!trimmedId || !trimmedSecret) {
      setFormError(t('bots.wecom.required'))
      return
    }
    setSaving(true)
    setFormError(null)
    try {
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
      const credential = await ipc.bots.setCredential(bot.id, { botId: trimmedId, secret: trimmedSecret })
      if (!credential.ok) {
        setFormError(t('bots.error.credentialFailed', { error: credential.error }))
        return
      }
      // Secret 不在界面上留明文：保存动作完成后当场抹掉
      setSecret('')
      setSaved(true)
      await onChanged()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [bot, botId, onChanged, saving, secret, t])

  return (
    <div className="p-3 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound size={15} className="text-md-primary flex-shrink-0" />
        <span className="text-ui-sm font-medium text-dark-onSurface">{t('bots.wecom.title')}</span>
      </div>
      <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-2">{t('bots.wecom.desc')}</p>

      <button
        type="button"
        onClick={() => void ipc.openExternal(WECOM_DOC_URL)}
        className="md-focus inline-flex items-center gap-1.5 text-ui-xs text-md-primary hover:underline mb-3"
      >
        <ExternalLink size={12} />
        <span>{t('bots.wecom.guideLink')}</span>
      </button>

      {/* 官方硬限制值得在表单里说清：回复限频决定了长回复会分条慢送 */}
      <div className="mb-3 p-2.5 rounded-md3-sm bg-dark-surfaceContainerHigh">
        <p className="text-ui-xs font-medium text-dark-onSurfaceVariant uppercase tracking-wider mb-1.5">
          {t('bots.wecom.stepsTitle')}
        </p>
        <ul className="space-y-1">
          <li className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{t('bots.wecom.step1')}</li>
          <li className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{t('bots.wecom.step2')}</li>
          <li className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{t('bots.wecom.step3')}</li>
        </ul>
      </div>

      <div className="space-y-2">
        <div>
          <label className="block text-ui-xs text-dark-onSurfaceVariant mb-1" htmlFor={`wecom-botid-${bot.id}`}>
            {t('bots.wecom.botId')}
          </label>
          <input
            id={`wecom-botid-${bot.id}`}
            className={inputCls}
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
            placeholder={t('bots.wecom.botIdPlaceholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <label className="block text-ui-xs text-dark-onSurfaceVariant mb-1" htmlFor={`wecom-secret-${bot.id}`}>
            {t('bots.wecom.secret')}
          </label>
          <input
            id={`wecom-secret-${bot.id}`}
            type="password"
            className={inputCls}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={t('bots.wecom.secretPlaceholder')}
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
          <span>{saving ? t('bots.wecom.saving') : t('bots.wecom.save')}</span>
        </button>
        {/* Secret 不在界面上留明文：只说「有没有凭据」，值本身一个字都不留在界面上 */}
        {bot.hasCredential ? (
          <span className="text-ui-xs text-md-success">{t('bots.credentialReady')}</span>
        ) : (
          saved && <p className="text-ui-xs text-md-success leading-relaxed">{t('bots.wecom.credentialSaved')}</p>
        )}
      </div>
    </div>
  )
}
