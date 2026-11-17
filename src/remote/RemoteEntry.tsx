import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowRight, Check, Globe, Link, Loader2, LogOut, ShieldCheck, Trash2, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { consumeRemoteInvite, consumeRemoteInviteNavigation, forgetRemoteDevice, getRemoteBootstrap, getRemoteConnection, readRemoteDevices, remoteBrowser, subscribeRemoteConnection } from './browser'
import type { RemoteDeviceCredential } from './protocol'
import './remote.css'
import '../i18n'

// Load the actual workbench only after bootstrap is authenticated. Its stores
// then hydrate from the redacted desktop projection, never from unauthenticated KV.
const Workbench = lazy(async () => {
  const [{ default: App }, { attachAgentEvents }] = await Promise.all([import('../App'), import('../lib/agent-event-apply')])
  await attachAgentEvents()
  return { default: App }
})
export default function RemoteEntry() {
  const { t, i18n } = useTranslation()
  const connection = useSyncExternalStore(subscribeRemoteConnection, getRemoteConnection)
  const [devices, setDevices] = useState<RemoteDeviceCredential[]>(() => readRemoteDevices())
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const [everConnected, setEverConnected] = useState(false)
  const workspaceLoaded = useRef(false)
  const reloadPending = useRef(false)
  useEffect(() => {
    document.documentElement.classList.add('webui-mode', 'cloud-remote-mode')
    const consumeNavigation = () => {
      if (reloadPending.current) return
      try {
        if (consumeRemoteInviteNavigation(window.location, window.history, {
          workspaceLoaded: workspaceLoaded.current || !!getRemoteBootstrap(),
          connect: invite => remoteBrowser().connect(invite),
          reload: () => { reloadPending.current = true; remoteBrowser().disconnect(); window.location.reload() },
        })) setError('')
      } catch { setError('remoteAccess.cloudInvalidInvite') }
    }
    consumeNavigation()
    window.addEventListener('hashchange', consumeNavigation)
    return () => window.removeEventListener('hashchange', consumeNavigation)
  }, [])
  useEffect(() => {
    if (connection.state !== 'connected') return
    workspaceLoaded.current = true
    setEverConnected(true)
    setDevices(readRemoteDevices())
    void import('../lib/agent-client').then(({ agentClient }) => agentClient.resync()).catch(() => {})
  }, [connection.state])
  useEffect(() => {
    let hiddenAt = 0
    const recover = () => {
      if (getRemoteBootstrap() && getRemoteConnection().state !== 'error') remoteBrowser().reconnect()
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > 10_000) recover()
    }
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) recover() }
    window.addEventListener('online', recover)
    window.addEventListener('pageshow', pageShow)
    document.addEventListener('visibilitychange', visibility)
    return () => { window.removeEventListener('online', recover); window.removeEventListener('pageshow', pageShow); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  const connectLink = (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    try {
      const parsed = new URL(link.trim(), window.location.origin)
      const invite = consumeRemoteInvite(parsed, { replaceState: () => {} })
      if (!invite) throw new Error('Invalid invitation')
      setLink('')
      remoteBrowser().connect(invite)
    } catch { setError('remoteAccess.cloudInvalidInvite') }
  }
  const leave = () => {
    remoteBrowser().disconnect()
    // A fresh document isolates chat/store memory when changing computers.
    window.location.replace(window.location.pathname)
  }
  if (everConnected && getRemoteBootstrap()) {
    return <>
      <Suspense fallback={<div className="remote-entry"><Loader2 className="remote-spinner" aria-label={t('common.loading')} /></div>}><Workbench /></Suspense>
      <div className={`remote-connection-bar ${connection.state === 'connected' ? 'is-connected' : ''}`} role="status" aria-live="polite">
        {connection.state === 'connected' ? <ShieldCheck size={13} aria-hidden /> : <WifiOff size={13} aria-hidden />}
        <span>{t(connection.state === 'connected' ? 'remoteAccess.cloudConnected' : connection.state === 'error' ? (connection.error || 'remoteAccess.cloudConnectionError') : 'remoteAccess.cloudReconnecting')}</span>
        <button type="button" onClick={leave} aria-label={t('remoteAccess.cloudDisconnect')} title={t('remoteAccess.cloudDisconnect')}><LogOut size={13} /></button>
      </div>
      {connection.state === 'error' && <div className="remote-recovery"><p>{t(connection.error || 'remoteAccess.cloudConnectionError')}</p><button type="button" onClick={remoteBrowser().reconnect}>{t('common.retry')}</button><button type="button" onClick={leave}>{t('remoteAccess.cloudDisconnect')}</button></div>}
    </>
  }
  const busy = ['connecting', 'reconnecting', 'pairing'].includes(connection.state)
  return <main className="remote-entry">
    <div className="remote-entry-inner">
      <header className="remote-entry-header"><a href="https://clerkbox.xmzf.space" className="remote-wordmark">ClerkBox<span>WebUI</span></a><button className="remote-language" type="button" onClick={() => { void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh-CN') }} aria-label={t('remoteAccess.cloudLanguage')}><Globe size={15} />{i18n.language.startsWith('zh') ? 'EN' : '中文'}</button></header>
      <section className="remote-entry-card" aria-labelledby="remote-entry-title">
        <div className="remote-entry-mark"><Globe size={25} aria-hidden /></div>
        <p className="remote-eyebrow">{t('remoteAccess.cloudEyebrow')}</p>
        <h1 id="remote-entry-title">{t(busy ? 'remoteAccess.cloudConnectingTitle' : 'remoteAccess.cloudEntryTitle')}</h1>
        <p className="remote-entry-intro">{t(busy ? connection.state === 'pairing' ? 'remoteAccess.cloudPairInstructions' : 'remoteAccess.cloudConnectingNote' : 'remoteAccess.cloudEntryNote')}</p>
        {busy ? <div className="remote-pair-state" role="status" aria-live="polite">
          {connection.code ? <><span>{t('remoteAccess.cloudPairCode')}</span><strong className="remote-pair-code">{connection.code}</strong><p>{t('remoteAccess.cloudPairKeepOpen')}</p></> : <Loader2 className="remote-spinner" size={28} aria-label={t('common.loading')} />}
          <button className="remote-secondary" type="button" onClick={() => { remoteBrowser().disconnect(); setDevices(readRemoteDevices()) }}>{t('common.cancel')}</button>
        </div> : <>
          {(error || connection.error) && <p className="remote-error" role="alert">{t(error || connection.error || 'remoteAccess.cloudConnectionError')}</p>}
          {connection.state === 'error' && <button className="remote-secondary" type="button" onClick={remoteBrowser().reconnect}>{t('common.retry')}</button>}
          {devices.length > 0 && <div className="remote-known-devices"><h2>{t('remoteAccess.cloudKnownDevices')}</h2>{devices.map(device => <div className="remote-known-device" key={`${device.roomId}:${device.deviceId}`}><button type="button" onClick={() => { setError(''); remoteBrowser().connect(device) }}><span className="remote-known-icon"><ShieldCheck size={18} /></span><span>{device.name}<small>{t('remoteAccess.cloudPairedBrowser')}</small></span><ArrowRight size={17} /></button><button type="button" className="remote-forget" onClick={() => { forgetRemoteDevice(device); setDevices(readRemoteDevices()) }} aria-label={t('remoteAccess.cloudForget', { name: device.name })}><Trash2 size={16} /></button></div>)}</div>}
          <form onSubmit={connectLink} className="remote-invite-form"><label htmlFor="remote-invite-link">{t('remoteAccess.cloudPasteInvite')}</label><div className="remote-invite-input"><Link size={17} aria-hidden /><input id="remote-invite-link" type="password" autoComplete="off" spellCheck={false} value={link} onChange={event => setLink(event.target.value)} placeholder={t('remoteAccess.cloudLinkPlaceholder')} required /></div><button className="remote-primary" type="submit" disabled={!link.trim()}>{t('remoteAccess.cloudConnect')}<ArrowRight size={16} /></button></form>
          <div className="remote-entry-steps"><p><span>1</span>{t('remoteAccess.cloudStepDesktop')}</p><p><span>2</span>{t('remoteAccess.cloudStepInvite')}</p><p><Check size={15} />{t('remoteAccess.cloudStepApprove')}</p></div>
        </>}
      </section>
      <footer className="remote-entry-footer"><ShieldCheck size={15} /><p>{t('remoteAccess.cloudPrivacy')}</p></footer>
    </div>
  </main>
}
