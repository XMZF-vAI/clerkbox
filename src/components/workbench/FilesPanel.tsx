import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { File as FileIcon, Loader2, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  archivePlugin, assetPlugin, audioPlugin, cadPlugin, drawingPlugin, emailPlugin,
  epubPlugin, fallbackPlugin, gisPlugin, imagePlugin, model3dPlugin, officePlugin,
  ofdPlugin, pdfPlugin, textPlugin, videoPlugin, xmindPlugin, xpsPlugin,
} from '@open-file-viewer/core'
import type { PreviewTheme, PreviewToolbarOptions } from '@open-file-viewer/core'
import '@open-file-viewer/core/style.css'
import { FileViewer } from '@open-file-viewer/react'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { ipc } from '../../lib/ipc-client'
import FileTree from '../layout/FileTree'

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * 工作台文件面板：左侧浏览当前会话工作目录的文件树，右侧预览选中内容。
 * 目录来源沿用现有 ipc.listDir 通道，预览由 Open File Viewer 统一处理。
 */
export default function FilesPanel({ vibe, rootDir }: { vibe?: boolean; rootDir?: string }) {
  const { t } = useTranslation()
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewFile, setPreviewFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const requestIdRef = useRef(0)
  const [fileTreeVisible, setFileTreeVisible] = useState(true)

  const plugins = useMemo(() => [
    imagePlugin(), videoPlugin(), audioPlugin(), pdfPlugin({ workerSrc: pdfWorkerSrc }),
    epubPlugin(), xpsPlugin(), officePlugin(), ofdPlugin(), archivePlugin(), emailPlugin(),
    drawingPlugin(), xmindPlugin(), cadPlugin(), model3dPlugin(), gisPlugin(), assetPlugin(),
    textPlugin(), fallbackPlugin(),
  ], [])

  const toolbar = useMemo<PreviewToolbarOptions>(() => ({
    zoom: true,
    rotate: true,
    download: false,
    fullscreen: false,
    print: false,
    search: false,
    order: ['zoom-out', 'zoom-in', 'zoom-reset', 'rotate-left', 'rotate-right'],
  }), [])

  const handleFileSelect = useCallback(async (path: string) => {
    const currentRequest = ++requestIdRef.current
    setPreviewPath(path)
    setPreviewFile(null)
    setError(null)
    setLoading(true)

    try {
      const result = await ipc.readFileBase64(path)
      if (currentRequest !== requestIdRef.current) return
      const fileName = path.split(/[\\/]/).filter(Boolean).pop() || path
      setPreviewFile(new File([base64ToBytes(result.data) as unknown as BlobPart], fileName, { type: result.mimeType }))
    } catch (e) {
      if (currentRequest !== requestIdRef.current) return
      setError(`${t('workbench.previewFailed')}\n${String((e as Error)?.message || e)}`)
    } finally {
      if (currentRequest === requestIdRef.current) setLoading(false)
    }
  }, [t])

  const closePreview = useCallback(() => {
    // 关闭后使仍在进行的文件读取失效，避免旧回包再次填入已关闭的预览。
    requestIdRef.current += 1
    setPreviewPath(null)
    setPreviewFile(null)
    setError(null)
    setLoading(false)
  }, [])

  useEffect(() => { closePreview() }, [rootDir, closePreview])

  const fileName = previewPath ? previewPath.split(/[\\/]/).filter(Boolean).pop() || previewPath : ''
  const previewRequest = requestIdRef.current
  const viewerTheme: PreviewTheme = vibe ? 'dark' : 'auto'

  return (
    <div className="flex h-full min-h-0">
      {/* 左：目录树（自动跟随会话工作目录） */}
      {fileTreeVisible && (
        <div className={`h-full w-[36%] min-w-[128px] max-w-64 overflow-y-auto border-r ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'}`}>
          <FileTree onFileSelect={handleFileSelect} initialRoot={rootDir} />
        </div>
      )}

      {/* 右：预览 */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        <div className={`flex min-h-11 items-center gap-2 border-b px-2 py-1 text-ui-xs ${vibe ? 'border-white/10 text-white/70' : 'border-dark-onSurfaceVariant/10 text-dark-onSurfaceVariant'}`}>
          <button
            type="button"
            onClick={() => setFileTreeVisible((visible) => !visible)}
            aria-label={fileTreeVisible ? t('workbench.hideFileList') : t('workbench.showFileList')}
            aria-pressed={fileTreeVisible}
            title={fileTreeVisible ? t('workbench.hideFileList') : t('workbench.showFileList')}
            className={`md-focus flex h-9 w-9 shrink-0 items-center justify-center rounded-md3-sm transition-colors ${vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh'}`}
          >
            {fileTreeVisible ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          <span className="min-w-0 flex-1 truncate" title={previewPath ?? undefined}>{fileName}</span>
          {previewPath && (
            <button
              type="button"
              onClick={closePreview}
              className={`md-focus ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-md3-sm transition-colors ${vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh'}`}
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className={`ofv-sidebar-preview min-h-0 flex-1 overflow-auto ${vibe ? 'ofv-vibe-preview' : ''}`}>
          {!previewPath ? (
            <div className={`flex h-full flex-col items-center justify-center gap-3 px-5 py-6 text-ui-sm text-center ${vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant'}`}>
              <FileIcon size={28} className="opacity-60" aria-hidden />
              <span className="leading-relaxed">{t('workbench.previewEmpty')}</span>
            </div>
          ) : loading ? (
            <div role="status" className="flex h-full items-center justify-center gap-2 px-4 text-ui-sm text-dark-onSurfaceVariant">
              <Loader2 size={18} className="animate-spin opacity-60" aria-hidden />
              {t('common.loading')}
            </div>
          ) : error ? (
            <div className="p-4 space-y-3">
              <pre role="alert" className={`whitespace-pre-wrap break-all font-sans text-ui-sm leading-relaxed ${vibe ? 'text-white/75' : 'text-dark-onSurfaceVariant'}`}>{error}</pre>
              <button type="button" onClick={() => void handleFileSelect(previewPath)} className="md-focus min-h-9 rounded-md3-sm border border-dark-onSurfaceVariant/20 px-3 py-2 text-ui-xs hover:bg-dark-surfaceContainerHigh transition-colors">{t('common.retry')}</button>
            </div>
          ) : previewFile ? (
            <FileViewer
              file={previewFile}
              fileName={fileName}
              width="100%"
              height="100%"
              fit="contain"
              toolbar={toolbar}
              theme={viewerTheme}
              plugins={plugins}
              fallback="inline"
              onError={(viewerError) => {
                if (previewRequest === requestIdRef.current) setError(`${t('workbench.previewFailed')}\n${String(viewerError?.message || viewerError)}`)
              }}
              onUnsupported={() => {
                if (previewRequest === requestIdRef.current) setError(t('workbench.previewUnsupported'))
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
