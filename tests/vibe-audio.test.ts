import { describe, expect, it, vi } from 'vitest'
import {
  AudioPlaybackIntent, AudioSourceError, WEB_AUDIO_MAX_BYTES, audioTrackName, audioTracksFromFolder,
  clampAudioPosition, formatAudioTime, resolveAudioSource,
} from '../src/lib/vibe-audio'

const ports = (webUI = false) => ({
  webUI,
  fileExists: vi.fn(async () => true),
  readFileBase64: vi.fn(async () => ({ data: 'YWJj', size: 3, mimeType: 'application/octet-stream' })),
})

describe('VIBE audio source boundaries', () => {
  it('displays decoded track names without signed URL query strings or fragments', () => {
    expect(audioTrackName('https://audio.example/a%20quiet%20day.mp3?token=private#part')).toBe('a quiet day.mp3')
    expect(audioTrackName('D:\\音乐\\夜晚.mp3')).toBe('夜晚.mp3')
    expect(audioTrackName('/music/track #1.mp3')).toBe('track #1.mp3')
    expect(audioTrackName('https://audio.example/bad%name.mp3?token=private')).toBe('bad%name.mp3')
    expect(audioTrackName('data:audio/mpeg;base64,YWJj')).toBe('')
  })

  it('builds a naturally sorted playlist and excludes folders and non-audio files', () => {
    expect(audioTracksFromFolder('D:\\Music\\', [
      { name: 'track10.MP3', isFile: true }, { name: 'notes.txt', isFile: true },
      { name: 'track2.mp3', isFile: true }, { name: 'folder.mp3', isFile: false },
    ])).toEqual([
      { name: 'track2.mp3', value: 'D:\\Music/track2.mp3', local: true },
      { name: 'track10.MP3', value: 'D:\\Music/track10.MP3', local: true },
    ])
    expect(audioTracksFromFolder('/empty', [])).toEqual([])
  })

  it('keeps remote URLs intact for playback without reading host files', async () => {
    const api = ports(true)
    const url = 'https://audio.example/song.mp3?token=private'
    expect(await resolveAudioSource({ name: 'song.mp3', value: url, local: false }, api)).toBe(url)
    expect(api.fileExists).not.toHaveBeenCalled()
    expect(api.readFileBase64).not.toHaveBeenCalled()
    await expect(resolveAudioSource({ name: 'file', value: 'file:///D:/secret.mp3', local: false }, api)).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('uses an encoded file URL only on desktop and reports a deleted file', async () => {
    const api = ports()
    const track = { name: 'a #1.mp3', value: 'D:\\Music\\a #1.mp3', local: true }
    expect(await resolveAudioSource(track, api)).toBe('file:///D:/Music/a%20%231.mp3')
    expect(api.readFileBase64).not.toHaveBeenCalled()
    api.fileExists.mockResolvedValue(false)
    await expect(resolveAudioSource(track, api)).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it('plays uploaded audio data URLs without exposing the payload as a title or reading host files', async () => {
    const api = ports(true)
    const value = 'data:audio/mpeg;base64,YWJj'
    expect(await resolveAudioSource({ name: '', value, local: false }, api)).toBe(value)
    expect(audioTrackName(value)).toBe('')
    expect(api.readFileBase64).not.toHaveBeenCalled()
    expect(api.fileExists).not.toHaveBeenCalled()
    for (const invalid of ['data:text/html;base64,YWJj', 'data:audio/mpeg,abc', 'data:audio/mpeg;base64,@@@=', 'data:audio/mpeg;base64,']) {
      await expect(resolveAudioSource({ name: '', value: invalid, local: false }, api)).rejects.toMatchObject({ reason: 'unavailable' })
    }
    const oversized = `data:audio/mpeg;base64,${'A'.repeat(Math.ceil(WEB_AUDIO_MAX_BYTES / 3) * 4 + 4)}`
    await expect(resolveAudioSource({ name: '', value: oversized, local: false }, api)).rejects.toMatchObject({ reason: 'too-large' })
  })

  it('resolves the current WebUI track to a correctly typed data URL', async () => {
    const api = ports(true)
    expect(await resolveAudioSource({ name: 'song.m4a', value: '/music/song.m4a', local: true }, api)).toBe('data:audio/mp4;base64,YWJj')
    expect(api.fileExists).not.toHaveBeenCalled()
    expect(api.readFileBase64).toHaveBeenCalledTimes(1)
    expect(api.readFileBase64).toHaveBeenCalledWith('/music/song.m4a')
  })

  it('never falls back to a file URL or default music when remote file access is denied', async () => {
    const api = ports(true)
    api.readFileBase64.mockRejectedValue(new Error('Remote file access disabled'))
    await expect(resolveAudioSource({ name: 'song.mp3', value: 'D:/song.mp3', local: true }, api)).rejects.toEqual(new AudioSourceError('web-local-unavailable'))
  })

  it('rejects oversized and empty WebUI audio instead of retaining them', async () => {
    const api = ports(true)
    const track = { name: 'song.mp3', value: '/song.mp3', local: true }
    api.readFileBase64.mockResolvedValue({ data: 'YWJj', size: WEB_AUDIO_MAX_BYTES + 1, mimeType: 'audio/mpeg' })
    await expect(resolveAudioSource(track, api)).rejects.toMatchObject({ reason: 'too-large' })
    api.readFileBase64.mockResolvedValue({ data: '', size: 0, mimeType: 'audio/mpeg' })
    await expect(resolveAudioSource(track, api)).rejects.toMatchObject({ reason: 'unavailable' })
  })
})

describe('VIBE user playback intent', () => {
  it('never plays on first entry or on a replacement source', async () => {
    const intent = new AudioPlaybackIntent()
    const target = { play: vi.fn(async () => {}) }
    expect(await intent.play(target)).toBe('idle')
    expect(target.play).not.toHaveBeenCalled()
    intent.request()
    expect(await intent.play(target)).toBe('playing')
    intent.resetSource()
    expect(await intent.play(target)).toBe('idle')
    expect(target.play).toHaveBeenCalledTimes(1)
  })

  it('continues user-started playback when switching tracks but preserves an intentional pause', async () => {
    const intent = new AudioPlaybackIntent()
    const target = { play: vi.fn(async () => {}) }
    intent.request()
    await intent.play(target)
    intent.changeTrack()
    expect(await intent.play(target)).toBe('playing')
    intent.pause()
    intent.changeTrack()
    expect(await intent.play(target)).toBe('idle')
    expect(target.play).toHaveBeenCalledTimes(2)
  })

  it.each(['pause', 'resetSource', 'changeTrack'] as const)('ignores a stale play result after %s', async (action) => {
    const intent = new AudioPlaybackIntent()
    let finish!: () => void
    intent.request()
    const pending = intent.play({ play: () => new Promise<void>((resolve) => { finish = resolve }) })
    intent[action]()
    finish()
    expect(await pending).toBe('stale')
  })

  it('separates an interaction restriction from a corrupt or unsupported resource and allows an explicit retry', async () => {
    const intent = new AudioPlaybackIntent()
    intent.request()
    expect(await intent.play({ play: async () => { throw { name: 'NotAllowedError' } } })).toBe('blocked')
    expect(intent.wantsPlayback).toBe(false)
    intent.request()
    expect(await intent.play({ play: async () => { throw { name: 'NotSupportedError' } } })).toBe('error')
    intent.request()
    expect(await intent.play({ play: async () => {} })).toBe('playing')
  })

  it('ignores an older rejection after a newer play request succeeds', async () => {
    const intent = new AudioPlaybackIntent()
    let reject!: (reason: Error) => void
    intent.request()
    const old = intent.play({ play: () => new Promise<void>((_, fail) => { reject = fail }) })
    intent.request()
    expect(await intent.play({ play: async () => {} })).toBe('playing')
    reject(new Error('old load aborted'))
    expect(await old).toBe('stale')
    expect(intent.wantsPlayback).toBe(true)
  })
})

describe('VIBE media timeline', () => {
  it('clamps progress to the current duration and handles live/unknown metadata', () => {
    expect(clampAudioPosition(5000, 3000)).toBe(3000)
    expect(clampAudioPosition(-1, 3000)).toBe(0)
    expect(clampAudioPosition(1, Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampAudioPosition(Number.NaN, 3000)).toBe(0)
    expect(formatAudioTime(125000)).toBe('2:05')
    expect(formatAudioTime(Number.NaN)).toBe('0:00')
  })
})
