import { useCallback, useState } from 'react'
import { File as FileIcon, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import FileTree from '../layout/FileTree'

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i

/**
 * 工作台文件面板：左侧浏览当前会话工作目录的文件树，右侧预览选中内容。
 * 目录来源沿用现有 ipc.listDir / ipc.readFile 通道；图片走 base64 通道直接渲染。
 */
export default function FilesPanel({ vibe, rootDir }: { vibe?: boolean; rootDir?: string }) {
  const { t } = useTranslation()
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // 预览请求序号：快速连点文件时丢弃过期响应
  const [reqSeq, setReqSeq] = useState(0)

  const handleFileSelect = useCallback(async (path: string) => {
    const seq = reqSeq + 1
    setReqSeq(seq)
    setPreviewPath(path)
    setLoading(true)
    setTextContent(null)
    setImageDataUrl(null)

    try {
      if (IMAGE_EXT_RE.test(path)) {
        const dataUrl = await ipc.readImageFileBase64(path)
        if (seq !== reqSeq + 1) return
        setImageDataUrl(dataUrl)
      } else {
        const content = await ipc.readFile(path)
        if (seq !== reqSeq + 1) return
        setTextContent(content)
      }
    } catch (e) {
      if (seq !== reqSeq + 1) return
      setTextContent(`${t('workbench.previewFailed')}\n${String((e as Error)?.message || e)}`)
    } finally {
      if (seq === reqSeq + 1) setLoading(false)
    }
  }, [reqSeq, t])

  const closePreview = () => {
    setPreviewPath(null)
    setTextContent(null)
    setImageDataUrl(null)
  }

  const fileName = previewPath ? previewPath.split(/[\\/]/).filter(Boolean).pop() || previewPath : ''

  return (
    <div className="flex h-full min-h-0">
      {/* 左：目录树（自动跟随会话工作目录） */}
      <div className={`h-full w-[45%] min-w-[140px] overflow-y-auto border-r ${vibe ? 'border-white/10' : 'border-dark-onSurfaceVariant/10'}`}>
        <FileTree onFileSelect={handleFileSelect} initialRoot={rootDir} />
      </div>

      {/* 右：预览 */}
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        {previewPath && (
          <div className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b ${vibe ? 'border-white/10 text-white/70' : 'border-dark-onSurfaceVariant/10 text-dark-onSurfaceVariant'}`}>
            <FileIcon size={12} className="shrink-0" />
            <span className="min-w-0 truncate" title={previewPath}>{fileName}</span>
            <button
              type="button"
              onClick={closePreview}
              className={`ml-auto shrink-0 rounded p-0.5 transition-colors ${vibe ? 'hover:bg-white/10' : 'hover:bg-dark-surfaceContainerHigh'}`}
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              <X size={12} />
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {!previewPath ? (
            <div className={`flex h-full flex-col items-center justify-center gap-2 text-xs ${vibe ? 'text-white/40' : 'text-dark-onSurfaceVariant/50'}`}>
              <FileIcon size={24} aria-hidden />
              <span>{t('workbench.previewEmpty')}</span>
            </div>
          ) : loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={18} className="animate-spin opacity-50" />
            </div>
          ) : imageDataUrl ? (
            <img src={imageDataUrl} alt={fileName} className="mx-auto max-h-full max-w-full object-contain p-2" />
          ) : textContent !== null ? (
            <pre
              className={`whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed ${
                vibe ? 'text-white/85' : 'text-dark-onSurface'
              }`}
            >
              {textContent}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  )
}
