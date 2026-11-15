import { toFileUrl } from './file-url'

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', wma: 'audio/x-ms-wma', opus: 'audio/ogg', webm: 'audio/webm',
}
const UPLOADED_AUDIO_MIME = new Set([...Object.values(AUDIO_MIME), 'audio/mp3', 'audio/x-wav', 'audio/wave', 'audio/x-m4a', 'audio/opus'])

export const WEB_AUDIO_MAX_BYTES = 12 * 1024 * 1024
export type AudioFailure = 'unavailable' | 'empty-folder' | 'web-local-unavailable' | 'too-large'
export class AudioSourceError extends Error {
  constructor(public readonly reason: AudioFailure) { super(reason) }
}

export interface AudioTrack {
  name: string
  value: string
  local: boolean
}

interface AudioSourcePorts {
  webUI: boolean
  fileExists: (path: string) => Promise<boolean>
  readFileBase64: (path: string) => Promise<{ data: string; mimeType: string; size: number }>
}

/** Query strings are source credentials/parameters, never part of a displayed track name. */
export function audioTrackName(value: string): string {
  if (/^data:/i.test(value)) return ''
  let path = value.replace(/\\/g, '/')
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try { path = new URL(value).pathname } catch { path = path.split(/[?#]/)[0] }
  }
  const name = path.split('/').filter(Boolean).pop() ?? ''
  try { return decodeURIComponent(name) } catch { return name }
}

export function isAudioFile(name: string): boolean {
  return Object.hasOwn(AUDIO_MIME, name.split('.').pop()?.toLowerCase() ?? '')
}

export function audioTracksFromFolder(folder: string, entries: Array<{ name: string; isFile: boolean }>): AudioTrack[] {
  return entries.filter((entry) => entry.isFile && isAudioFile(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map(({ name }) => ({ name, value: `${folder.replace(/[\\/]$/, '')}/${name}`, local: true }))
}

export async function resolveAudioSource(track: AudioTrack, ports: AudioSourcePorts): Promise<string> {
  if (!track.local) {
    if (/^data:/i.test(track.value)) {
      const comma = track.value.indexOf(',')
      const header = track.value.slice(0, comma).toLowerCase()
      const mime = header.match(/^data:([^;,]+);base64$/)?.[1]
      if (!mime || !UPLOADED_AUDIO_MIME.has(mime)) throw new AudioSourceError('unavailable')
      const data = track.value.slice(comma + 1)
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
      if (data.length / 4 * 3 - padding > WEB_AUDIO_MAX_BYTES) throw new AudioSourceError('too-large')
      if (!data || data.length % 4 !== 0 || !/^[a-z\d+/]+={0,2}$/i.test(data)) throw new AudioSourceError('unavailable')
      return track.value
    }
    try {
      const url = new URL(track.value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
      return url.href
    } catch { throw new AudioSourceError('unavailable') }
  }
  if (!ports.webUI) {
    if (!(await ports.fileExists(track.value))) throw new AudioSourceError('unavailable')
    return toFileUrl(track.value)
  }
  let file: Awaited<ReturnType<AudioSourcePorts['readFileBase64']>>
  try { file = await ports.readFileBase64(track.value) }
  catch { throw new AudioSourceError('web-local-unavailable') }
  // Resolve only the current track and retain no playlist-sized data-URL cache.
  if (file.size > WEB_AUDIO_MAX_BYTES || file.data.length > Math.ceil(WEB_AUDIO_MAX_BYTES / 3) * 4) {
    throw new AudioSourceError('too-large')
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || !file.data) throw new AudioSourceError('unavailable')
  const mime = AUDIO_MIME[track.value.split('.').pop()?.toLowerCase() ?? '']
  if (!mime) throw new AudioSourceError('web-local-unavailable')
  return `data:${mime};base64,${file.data}`
}

export function formatAudioTime(milliseconds: number): string {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function clampAudioPosition(position: number, duration: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return 0
  return Math.min(duration, Math.max(0, position))
}

/** Owns user intent across async play(), track changes, and source replacement. */
export class AudioPlaybackIntent {
  private requested = false
  private revision = 0

  get wantsPlayback(): boolean { return this.requested }
  request(): void { this.requested = true; this.revision += 1 }
  pause(): void { this.requested = false; this.revision += 1 }
  changeTrack(): void { this.revision += 1 }
  resetSource(): void { this.pause() }

  async play(target: { play: () => Promise<void> }): Promise<'idle' | 'playing' | 'blocked' | 'error' | 'stale'> {
    if (!this.requested) return 'idle'
    const revision = ++this.revision
    try {
      await target.play()
      return revision === this.revision && this.requested ? 'playing' : 'stale'
    } catch (error) {
      if (revision !== this.revision) return 'stale'
      this.requested = false
      return error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError' ? 'blocked' : 'error'
    }
  }
}
