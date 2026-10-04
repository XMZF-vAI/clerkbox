import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, KeyRound, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import type { BotListItem } from '../../../electron/im-bots/types'

interface TelegramSetupCardProps {
  bot: BotListItem
  /** 列表重拉：凭据写入通道接上后，hasCredential 由主进程决定 */
  onChanged: () => void
}

/** BotFather 对话页（公开链接，可直接开外链） */
const BOTFATHER_URL = 'https://t.me/BotFather'

const inputCls =
  'w-full px-3 py-2 bg-dark-surfaceContainerHighest rounded-md3-sm text-ui-sm border border-dark-onSurfaceVariant/10 outline-none focus:border-md-primary/40 transition-colors'

/**
 * Telegram 凭据表单：只有 BotFather 下发的 bot token。
 *
 * 网络预期：api.telegram.org 在中国大陆被阻断。刻意不做应用内代理设置——
 * 能用 Telegram 的用户自有网络方案（系统代理会被主进程的 Electron net.fetch
 * 自动带上，TUN 模式直连也通）。连不上时通道状态会明确区分「Token 无效」与
 * 「网络请求失败」，界面上见到的错误就是可行动的。
 */
export default function TelegramSetupCard({ bot, onChanged }: TelegramSetupCardProps) {
  const { t } = useTranslation()
  const [botToken, setBotToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // 切换 bot 时清草稿：上一个机器人的 token 不该出现在这一个的表单里
  useEffect(() => {
    setBotToken('')
    setSaved(false)
    setFormError(null)
  }, [bot.id])

  const save = useCallback(async () => {
    if (saving) return
    const trimmed = botToken.trim()
    if (!trimmed) {
      setFormError(t('bots.telegram.required'))
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
      const credential = await ipc.bots.setCredential(bot.id, { botToken: trimmed })
      if (!credential.ok) {
        setFormError(t('bots.error.credentialFailed', { error: credential.error }))
        return
      }
      // token 不在界面上留明文：保存动作完成后当场抹掉
      setBotToken('')
      setSaved(true)
      await onChanged()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [bot, botToken, onChanged, saving, t])

  return (
    <div className="p-3 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound size={15} className="text-md-primary flex-shrink-0" />
        <span className="text-ui-sm font-medium text-dark-onSurface">{t('bots.telegram.title')}</span>
      </div>
      <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed mb-2">{t('bots.telegram.desc')}</p>

      <button
        type="button"
        onClick={() => void ipc.openExternal(BOTFATHER_URL)}
        className="md-focus inline-flex items-center gap-1.5 text-ui-xs text-md-primary hover:underline mb-3"
      >
        <ExternalLink size={12} />
        <span>{t('bots.telegram.guideLink')}</span>
      </button>

      {/* 网络预期说在前头，而不是等报错才解释 */}
      <div className="mb-3 p-2.5 rounded-md3-sm bg-dark-surfaceContainerHigh">
        <p className="text-ui-xs text-dark-onSurfaceVariant leading-relaxed">{t('bots.telegram.networkNote')}</p>
      </div>

      <div>
        <label className="block text-ui-xs text-dark-onSurfaceVariant mb-1" htmlFor={`tg-token-${bot.id}`}>
          {t('bots.telegram.botToken')}
        </label>
        <input
          id={`tg-token-${bot.id}`}
          type="password"
          className={inputCls}
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder={t('bots.telegram.botTokenPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
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
          <span>{saving ? t('bots.telegram.saving') : t('bots.telegram.save')}</span>
        </button>
        {/* token 不在界面上留明文：只说「有没有凭据」，值本身一个字都不留在界面上 */}
        {bot.hasCredential ? (
          <span className="text-ui-xs text-md-success">{t('bots.credentialReady')}</span>
        ) : (
          saved && <p className="text-ui-xs text-md-success leading-relaxed">{t('bots.telegram.credentialSaved')}</p>
        )}
      </div>
    </div>
  )
}
