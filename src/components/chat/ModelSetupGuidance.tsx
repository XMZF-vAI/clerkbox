import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Settings2 } from 'lucide-react'
import { useJouleStore } from '../../stores/joule-store'
import { useSettingsStore } from '../../stores/settings-store'
import { isWebUIMode } from '../../lib/ipc-client'
import type { JoulePlan, JouleStatus, JouleSubscription } from '../../types/joule'
import { canSelectJouleModel } from '../../lib/joule-models'
import JouleAccountCard from '../settings/JouleAccountCard'
import Modal from '../ui/Modal'
import JOULE_MARK from '../../assets/joule-mark.png'

type SetupState = 'desktop' | 'preparing' | 'authorizing' | 'expired' | 'reauth' | 'error' | 'syncing' | 'subscription' | 'models' | 'ready' | 'unlinked'

interface SetupAccount {
  status: JouleStatus
  loggingIn: boolean
  userCode: string | null
  plan: JoulePlan | null
  subscription: JouleSubscription | null
  stale: boolean
  error: string | null
}

/** Account connectivity, subscription access and model availability are separate states. */
export function resolveJouleSetupState(account: SetupAccount, modelCount: number, webUI: boolean, now = Date.now()): SetupState {
  if (webUI) return 'desktop'
  if (account.userCode) return 'authorizing'
  if (account.loggingIn) return 'preparing'
  if (account.status === 'needs_reauth') return 'reauth'
  if (account.status === 'expired' || (account.status === 'connected' && account.subscription && account.subscription.expiresAt <= now)) return 'expired'
  if (account.status === 'error' || account.error) return 'error'
  if (account.status !== 'connected') return 'unlinked'
  if (account.stale) return 'syncing'
  if (!canSelectJouleModel(account, now)) return 'subscription'
  return modelCount > 0 ? 'ready' : 'models'
}

const stateCopy: Record<SetupState, { title: string; description: string; action: string }> = {
  desktop: { title: 'joule.setup.desktopTitle', description: 'joule.webuiNote', action: 'joule.setup.desktopAction' },
  preparing: { title: 'joule.setup.pendingTitle', description: 'joule.setup.preparingDescription', action: 'joule.setup.pendingAction' },
  authorizing: { title: 'joule.setup.pendingTitle', description: 'joule.setup.authorizingDescription', action: 'joule.setup.pendingAction' },
  expired: { title: 'joule.setup.expiredTitle', description: 'joule.quotaExpiredHint', action: 'joule.viewSubscription' },
  reauth: { title: 'joule.statusNeedsReauth', description: 'joule.reauthHint', action: 'joule.relogin' },
  error: { title: 'joule.setup.errorTitle', description: 'joule.setup.errorDescription', action: 'joule.setup.accountAction' },
  syncing: { title: 'joule.setup.syncingTitle', description: 'joule.setup.syncingDescription', action: 'joule.setup.accountAction' },
  subscription: { title: 'joule.setup.connectedTitle', description: 'joule.setup.subscriptionDescription', action: 'joule.viewSubscription' },
  models: { title: 'joule.setup.connectedTitle', description: 'joule.setup.modelsDescription', action: 'joule.setup.accountAction' },
  ready: { title: 'joule.setup.connectedTitle', description: 'joule.setup.readyDescription', action: 'joule.setup.selectAction' },
  unlinked: { title: 'joule.setup.loginTitle', description: 'joule.setup.loginDescription', action: 'joule.login' },
}

/** Empty-chat guidance only; opening this dialog never starts device authorization. */
export default function ModelSetupGuidance() {
  const { t } = useTranslation()
  const status = useJouleStore((s) => s.status)
  const loggingIn = useJouleStore((s) => s.loggingIn)
  const userCode = useJouleStore((s) => s.userCode)
  const plan = useJouleStore((s) => s.plan)
  const subscription = useJouleStore((s) => s.subscription)
  const stale = useJouleStore((s) => s.stale)
  const error = useJouleStore((s) => s.error)
  const provider = useSettingsStore((s) => s.providers.find((item) => item.id === 'joule'))
  const [open, setOpen] = useState(false)
  const [selectedModelId, setSelectedModelId] = useState('')
  const models = provider?.models ?? []
  const state = resolveJouleSetupState({ status, loggingIn, userCode, plan, subscription, stale, error }, models.length, isWebUIMode)
  const copy = stateCopy[state]
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0]

  const configureManually = () => {
    setOpen(false)
    useSettingsStore.getState().updateSettings({ showSettings: true, pendingSettingsTab: 'api' })
  }

  const selectModel = () => {
    const account = useJouleStore.getState()
    const settings = useSettingsStore.getState()
    const latest = settings.providers.find((item) => item.id === 'joule')
    // Recheck at click time: a subscription or model may have changed while the dialog was open.
    if (resolveJouleSetupState(account, latest?.models.length ?? 0, isWebUIMode) !== 'ready') return
    if (!selectedModel || !latest?.models.some((model) => model.id === selectedModel.id)) return
    settings.activateModel('joule', selectedModel.id)
    setOpen(false)
  }

  return (
    <>
      <section aria-label={t('shell.modelMissing')} className="mb-4 rounded-md3-md border border-md-primary/20 bg-dark-surfaceContainer/80 p-4 backdrop-blur-sm">
        <div className="flex items-start gap-3">
          <img src={JOULE_MARK} alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded-md3-sm" />
          <div className="min-w-0 flex-1">
            <h2 className="text-ui-sm font-medium text-dark-onSurface">{t(copy.title)}</h2>
            <p className="mt-1 text-ui-xs leading-relaxed text-dark-onSurfaceVariant">{t(copy.description)}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 pl-11 max-sm:pl-0">
          <button type="button" onClick={() => setOpen(true)} className="md-focus flex min-h-10 items-center justify-center gap-1.5 rounded-md3-sm bg-md-primary px-4 py-2 text-ui-xs font-medium text-md-onPrimary transition-colors hover:bg-md-primary/90 max-md:min-h-11">
            {t(copy.action)}<ArrowUpRight size={14} aria-hidden="true" />
          </button>
          <button type="button" onClick={configureManually} className="md-focus flex min-h-10 items-center justify-center gap-1.5 rounded-md3-sm px-3 py-2 text-ui-xs font-medium text-dark-onSurfaceVariant transition-colors hover:bg-dark-surfaceContainerHigh max-md:min-h-11">
            <Settings2 size={14} aria-hidden="true" />{t('joule.setup.manualAction')}
          </button>
        </div>
      </section>
      {open && (
        <Modal title={t('joule.accountTitle')} description={t(copy.description)} onClose={() => setOpen(false)} titleIcon={<img src={JOULE_MARK} alt="" className="h-5 w-5 rounded-[4px]" />} footer={
          <button type="button" onClick={configureManually} className="md-focus min-h-10 rounded-md3-sm px-3 py-2 text-ui-xs font-medium text-dark-onSurfaceVariant transition-colors hover:bg-dark-surfaceContainerHigh max-md:min-h-11">{t('joule.setup.manualAction')}</button>
        }>
          <JouleAccountCard />
          {state === 'ready' && selectedModel && (
            <div className="space-y-3 rounded-md3-md border border-dark-onSurfaceVariant/10 p-4">
              <label className="block space-y-2 text-ui-xs font-medium text-dark-onSurface">
                <span>{t('joule.setup.modelLabel')}</span>
                <select value={selectedModel.id} onChange={(event) => setSelectedModelId(event.target.value)} className="md-focus min-h-11 w-full rounded-md3-sm border border-dark-onSurfaceVariant/20 bg-dark-surface px-3 py-2 text-ui-sm text-dark-onSurface">
                  {models.map((model) => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
                </select>
              </label>
              <button type="button" onClick={selectModel} className="md-focus min-h-11 w-full rounded-md3-sm bg-md-primary px-4 py-2 text-ui-xs font-medium text-md-onPrimary transition-colors hover:bg-md-primary/90">{t('joule.setup.useModel')}</button>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
