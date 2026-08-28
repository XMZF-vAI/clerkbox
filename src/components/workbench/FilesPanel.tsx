import { useCallback, useMemo, useRef, useState } from 'react'
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

  const closePreview = () => {
    setPreviewPath(null)
    setPreviewFile(null)
    setError(null)
  }

  const fileName = previewPath ? previewPath.split(/[\\/]/).filter(Boolean).pop() || previewPath : ''
  const viewerTheme: PreviewTheme = vibe ? 'dark' : 'auto'

  return (
    <div className="flex h-full min-h-0">
      {/* 左：目录树（自动跟随会话工作目录） */}
      {fileTreeVisible && (
        <div className={`h-full w-[45%] min-w-[140px] overflow-y-auto border-r ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'}`}>
          <FileTree onFileSelect={handleFileSelect} initialRoot={rootDir} />
        </div>
      )}

      {/* 右：预览 */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        <div className={`flex min-h-8 items-center gap-2 border-b px-3 py-1.5 text-xs ${vibe ? 'border-white/10 text-white/70' : 'border-dark-onSurfaceVariant/10 text-dark-onSurfaceVariant'}`}>
          <button
            type="button"
            onClick={() => setFileTreeVisible((visible) => !visible)}
            aria-label={fileTreeVisible ? t('workbench.hideFileList') : t('workbench.showFileList')}
            aria-pressed={fileTreeVisible}
            title={fileTreeVisible ? t('workbench.hideFileList') : t('workbench.showFileList')}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md3-sm transition-colors ${vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh'}`}
          >
            {fileTreeVisible ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          {previewPath && (
            <button
              type="button"
              onClick={closePreview}
              className={`ml-auto shrink-0 rounded p-0.5 transition-colors ${vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh'}`}
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className={`ofv-sidebar-preview min-h-0 flex-1 overflow-auto ${vibe ? 'ofv-vibe-preview' : ''}`}>
          {!previewPath ? (
            <div className={`flex h-full flex-col items-center justify-center gap-2 text-xs ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/50'}`}>
              <FileIcon size={24} aria-hidden />
              <span>{t('workbench.previewEmpty')}</span>
            </div>
          ) : loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={18} className="animate-spin opacity-50" />
            </div>
          ) : error ? (
            <pre className={`whitespace-pre-wrap break-all p-3 text-xs ${vibe ? 'text-white/75' : 'text-dark-onSurfaceVariant'}`}>{error}</pre>
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
              onError={(viewerError) => setError(`${t('workbench.previewFailed')}\n${String(viewerError?.message || viewerError)}`)}
              onUnsupported={() => setError(t('workbench.previewUnsupported'))}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
