import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MessageAttachment } from '../src/types/agent'
const h = vi.hoisted(() => ({ cloud: true, files: true, connection: 'connected', read: vi.fn(async (_path: string) => 'data:image/png;base64,aGVsbG8=') }))
vi.mock('../src/lib/ipc-client', () => ({ ipc: { readImageFileBase64: h.read } }))
vi.mock('../src/remote/browser', () => ({
  isCloudRemoteMode: () => h.cloud,
  getRemoteBootstrap: () => ({ workspace: 'D:\\shared', platform: 'win32', capabilities: { files: h.files } }),
  getRemoteConnection: () => ({ state: h.connection }),
  subscribeRemoteConnection: () => () => {},
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import PathImageAttachment, { imagePreviewRestriction, loadAttachmentImagePreview } from '../src/components/chat/PathImageAttachment'
const image: MessageAttachment = Object.freeze({ id: 'uploaded-image', kind: 'image', name: 'photo.png', path: 'D:\\shared\\.clerkbox\\uploads\\photo.png', size: 20 })

beforeEach(() => { vi.clearAllMocks(); h.cloud = true; h.files = true; h.connection = 'connected'; h.read.mockResolvedValue('data:image/png;base64,aGVsbG8=') })
describe('path-only image history previews', () => {
  it('loads an authorized small image through restricted IPC without modifying its attachment', async () => {
    const before = { ...image }
    expect(await loadAttachmentImagePreview(image)).toBe('data:image/png;base64,aGVsbG8=')
    expect(h.read).toHaveBeenCalledWith(image.path)
    expect(image).toEqual(before)
    expect(image.dataUrl).toBeUndefined()
  })
  it('does not request images without file access, while offline or outside the workspace', async () => {
    h.files = false
    await expect(loadAttachmentImagePreview(image)).rejects.toThrow('cloudFilesDisabled')
    h.files = true
    h.connection = 'reconnecting'
    await expect(loadAttachmentImagePreview(image)).rejects.toThrow('cloudDisconnected')
    h.connection = 'connected'
    for (const path of ['C:\\private\\photo.png', 'D:\\shared-other\\photo.png', 'D:\\shared\\..\\photo.png', 'D:\\shared\\image.svg']) {
      await expect(loadAttachmentImagePreview({ ...image, path })).rejects.toThrow('cloudImageReference')
    }
    expect(h.read).not.toHaveBeenCalled()
  })
  it('avoids known oversized reads and explains a host size rejection when size was unknown', async () => {
    await expect(loadAttachmentImagePreview({ ...image, size: 256 * 1024 + 1 })).rejects.toThrow('cloudImagePreviewTooLarge')
    expect(h.read).not.toHaveBeenCalled()
    h.read.mockRejectedValueOnce(new Error('remote-preview-too-large'))
    await expect(loadAttachmentImagePreview({ ...image, size: undefined })).rejects.toThrow('cloudImagePreviewTooLarge')
    h.read.mockRejectedValueOnce(new Error('remote-outside-workspace'))
    await expect(loadAttachmentImagePreview(image)).rejects.toThrow('cloudImageReference')
  })
  it('keeps file name and path visible before the lazy preview loads or when previews are unavailable', () => {
    const html = renderToStaticMarkup(createElement(PathImageAttachment, { attachment: { ...image, size: 256 * 1024 + 1 } }))
    expect(html).toContain('photo.png')
    expect(html).toContain(image.path)
    expect(html).toContain('cloudImagePreviewTooLarge')
    expect(html).not.toContain('<img')
    expect(h.read).not.toHaveBeenCalled()
    expect(imagePreviewRestriction({ ...image, size: 256 * 1024 })).toBeNull()
  })
})
