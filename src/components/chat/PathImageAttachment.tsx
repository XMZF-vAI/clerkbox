import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Image as ImageIcon, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import { getRemoteBootstrap, getRemoteConnection, isCloudRemoteMode, subscribeRemoteConnection } from '../../remote/browser'
import type { MessageAttachment } from '../../types/agent'

const PREVIEW_LIMIT = 256 * 1024

/** The host rechecks real paths and file size before reading, including symlink escapes. */
export function imagePreviewRestriction(attachment: MessageAttachment): string | null {
  if (isCloudRemoteMode()) {
    const bootstrap = getRemoteBootstrap()
    if (!bootstrap?.capabilities.files) return 'remoteAccess.cloudFilesDisabled'
    if (getRemoteConnection().state !== 'connected') return 'remoteAccess.cloudDisconnected'
    const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
    let root = normalize(bootstrap.workspace)
    let target = normalize(attachment.path || '')
    if (bootstrap.platform === 'win32' || /^[a-z]:\//i.test(root)) { root = root.toLowerCase(); target = target.toLowerCase() }
    if (!target.startsWith(root === '/' ? '/' : `${root}/`) || target.split('/').includes('..')) return 'remoteAccess.cloudImageReference'
  }
  if (!attachment.path || attachment.path.length > 4096 || /[\x00-\x1f]/.test(attachment.path) || !/\.(png|jpe?g|webp|gif)$/i.test(attachment.path)) return 'remoteAccess.cloudImageReference'
  if (attachment.size !== undefined && (!Number.isFinite(attachment.size) || attachment.size > PREVIEW_LIMIT || attachment.size < 0)) return 'remoteAccess.cloudImagePreviewTooLarge'
  return null
}

export async function loadAttachmentImagePreview(attachment: MessageAttachment): Promise<string> {
  const restriction = imagePreviewRestriction(attachment)
  if (restriction) throw new Error(restriction)
  try {
    const dataUrl = await ipc.readImageFileBase64(attachment.path!)
    if (dataUrl.length > Math.ceil(PREVIEW_LIMIT / 3) * 4 + 100) throw new Error('remote-preview-too-large')
    if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(dataUrl)) throw new Error('remote-not-image')
    return dataUrl
  } catch (error) {
    throw new Error(error instanceof Error && error.message === 'remote-preview-too-large' ? 'remoteAccess.cloudImagePreviewTooLarge' : 'remoteAccess.cloudImageReference')
  }
}

/** Path-only history stays visible even when its preview is unavailable. Bytes never enter a store. */
export default function PathImageAttachment({ attachment, vibe = false }: { attachment: MessageAttachment; vibe?: boolean }) {
  const { t } = useTranslation()
  const connection = useSyncExternalStore(subscribeRemoteConnection, getRemoteConnection, getRemoteConnection)
  const rootRef = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [preview, setPreview] = useState<{ path?: string; dataUrl?: string; error?: string }>({})
  const [loading, setLoading] = useState(false)
  const restriction = imagePreviewRestriction(attachment)
  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '120px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || restriction) return
    let cancelled = false
    setLoading(true)
    setPreview({ path: attachment.path })
    void loadAttachmentImagePreview(attachment).then(dataUrl => {
      if (!cancelled) setPreview({ path: attachment.path, dataUrl })
    }).catch(error => {
      if (!cancelled) setPreview({ path: attachment.path, error: error.message })
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [attachment.path, attachment.size, visible, restriction, connection.state])
  const current = preview.path === attachment.path ? preview : {}
  return <figure ref={rootRef} className={`max-w-[260px] overflow-hidden rounded-md3-md border text-ui-xs ${vibe ? 'border-white/20 bg-white/10 text-white/90' : 'border-dark-onSurfaceVariant/15 bg-md-primaryContainer text-md-onPrimaryContainer'}`}>
    {!restriction && current.dataUrl && <img src={current.dataUrl} alt={attachment.name} title={attachment.path || attachment.name} className="max-h-40 max-w-[240px] object-cover" onError={() => setPreview({ path: attachment.path, error: 'remoteAccess.cloudImageReference' })} />}
    <figcaption className="space-y-1 px-2.5 py-2">
      <span className="flex items-center gap-1.5"><ImageIcon size={13} className="shrink-0" /><span className="truncate">{attachment.name}</span></span>
      {attachment.path && <span className="block break-all text-[10px] opacity-65">{attachment.path}</span>}
      {(restriction || current.error || !current.dataUrl) && <span className="flex items-start gap-1.5 text-[11px] leading-relaxed opacity-75" role={loading && !restriction ? 'status' : undefined}>{loading && !restriction && <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" />}{t(restriction || current.error || (loading ? 'common.loading' : 'remoteAccess.cloudImageReference'))}</span>}
    </figcaption>
  </figure>
}
