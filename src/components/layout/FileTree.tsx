import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  HardDrive,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc, isWebUIMode } from '../../lib/ipc-client'
import type { FileEntry } from '../../types/ipc'
import HostFolderPicker from '../ui/HostFolderPicker'

interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: TreeNode[]
  expanded?: boolean
  loading?: boolean
}

function appendPath(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/'
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`
}

function displayName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

type FileIconInfo = {
  Icon: LucideIcon
  color: string
}

function fileIconForName(name: string): FileIconInfo {
  const extension = name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? ''

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'avif'].includes(extension)) {
    return { Icon: FileImage, color: 'text-md-info' }
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'].includes(extension)) {
    return { Icon: FileArchive, color: 'text-md-warning' }
  }
  if (['xls', 'xlsx', 'xlsm', 'csv', 'ods', 'numbers'].includes(extension)) {
    return { Icon: FileSpreadsheet, color: 'text-md-success' }
  }
  if (['ppt', 'pptx', 'odp', 'key'].includes(extension)) {
    return { Icon: Presentation, color: 'text-md-error' }
  }
  if (['doc', 'docx', 'odt', 'rtf', 'pages'].includes(extension)) {
    return { Icon: FileType, color: 'text-md-primary' }
  }
  if (
    [
      'c',
      'cc',
      'cpp',
      'css',
      'go',
      'h',
      'hpp',
      'html',
      'java',
      'js',
      'json',
      'jsx',
      'kt',
      'less',
      'php',
      'ps1',
      'py',
      'rs',
      'scss',
      'sh',
      'sql',
      'swift',
      'ts',
      'tsx',
      'vue',
      'xml',
      'yaml',
      'yml',
    ].includes(extension)
  ) {
    return { Icon: FileCode, color: 'text-md-tertiary' }
  }
  if (['md', 'mdx', 'pdf', 'txt', 'log', 'tex'].includes(extension)) {
    return { Icon: FileText, color: 'text-dark-onSurfaceVariant' }
  }

  return { Icon: File, color: 'text-dark-onSurfaceVariant/70' }
}

function findNode(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node
    const child = node.children ? findNode(node.children, targetPath) : null
    if (child) return child
  }
  return null
}

function updateNode(nodes: TreeNode[], targetPath: string, update: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) return update(node)
    return node.children ? { ...node, children: updateNode(node.children, targetPath, update) } : node
  })
}

function FileTreeNode({ node, depth = 0, onToggle, onFileSelect }: { node: TreeNode; depth?: number; onToggle: (path: string) => void; onFileSelect?: (path: string) => void }) {
  const { t } = useTranslation()
  const paddingLeft = depth * 16 + 8

  if (!node.isDirectory) {
    const { Icon, color } = fileIconForName(node.name)
    // 工作台面板传入 onFileSelect 时，文件可点击预览；否则维持原纯展示行为
    const inner = (
      <>
        <Icon size={14} className={`shrink-0 ${color}`} aria-hidden="true" />
        <span className="truncate">{node.name}</span>
      </>
    )
    if (!onFileSelect) {
      return (
        <div
          title={node.path}
          className="flex items-center gap-2 py-1 px-2 rounded-md3-sm text-sm text-dark-onSurfaceVariant"
          style={{ paddingLeft }}
        >
          {inner}
        </div>
      )
    }
    return (
      <button
        type="button"
        title={node.path}
        onClick={() => onFileSelect(node.path)}
        className="w-full flex items-center gap-2 py-1 px-2 rounded-md3-sm text-sm text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh hover:text-dark-onSurface transition-colors text-left"
        style={{ paddingLeft }}
      >
        {inner}
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        aria-expanded={node.expanded ?? false}
        aria-busy={node.loading ?? false}
        title={node.path}
        onClick={() => onToggle(node.path)}
        className="w-full flex items-center gap-2 py-1 px-2 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-sm text-dark-onSurface"
        style={{ paddingLeft }}
      >
        {node.expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {node.expanded ? <FolderOpen size={14} className="text-md-info" aria-hidden="true" /> : <Folder size={14} className="text-md-info" aria-hidden="true" />}
        <span className="truncate font-medium">{node.name}</span>
      </button>
      {node.expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode key={child.path} node={child} depth={depth + 1} onToggle={onToggle} onFileSelect={onFileSelect} />
          ))}
        </div>
      )}
      {node.expanded && node.loading && (
        <div role="status" className="py-1 text-xs text-dark-onSurfaceVariant/50" style={{ paddingLeft: paddingLeft + 20 }}>
          {t('fileTree.loading')}
        </div>
      )}
    </>
  )
}

interface FileTreeProps {
  /** 传入后：点击文件节点回调该文件路径（工作台预览用）；缺省维持纯浏览行为 */
  onFileSelect?: (path: string) => void
  /** 传入后：自动以该目录为根并跟随变化（工作台把当前会话工作目录传进来） */
  initialRoot?: string
}

export default function FileTree({ onFileSelect, initialRoot }: FileTreeProps) {
  const { t } = useTranslation()
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [hostFolderPickerOpen, setHostFolderPickerOpen] = useState(false)
  const treeRef = useRef<TreeNode[]>([])
  const rootRequestRef = useRef(0)
  const pendingLoadsRef = useRef(new Set<string>())

  const updateTree = useCallback((updater: (nodes: TreeNode[]) => TreeNode[]) => {
    setTree((previous) => {
      const next = updater(previous)
      treeRef.current = next
      return next
    })
  }, [])

  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    try {
      const entries = await ipc.listDir(dirPath)
      return entries
        .sort((a: FileEntry, b: FileEntry) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })
        .map((entry: FileEntry) => ({
          name: entry.name,
          path: appendPath(dirPath, entry.name),
          isDirectory: entry.isDirectory,
          expanded: false,
        }))
    } catch {
      return []
    }
  }, [])

  const handleSelectFolder = async () => {
    if (isWebUIMode) {
      setHostFolderPickerOpen(true)
      return
    }
    const selectedPath = await ipc.selectFolder()
    if (!selectedPath) return

    await applyRootFolder(selectedPath)
  }

  const applyRootFolder = async (selectedPath: string) => {

    const requestId = ++rootRequestRef.current
    setRootPath(selectedPath)
    updateTree(() => [{
      name: displayName(selectedPath),
      path: selectedPath,
      isDirectory: true,
      expanded: true,
      loading: true,
      children: [],
    }])

    const children = await loadDir(selectedPath)
    if (requestId !== rootRequestRef.current) return
    updateTree((nodes) => updateNode(nodes, selectedPath, (node) => ({ ...node, children, loading: false })))
  }

  const handleToggle = useCallback(async (targetPath: string) => {
    const currentNode = findNode(treeRef.current, targetPath)
    if (!currentNode?.isDirectory) return

    const nextExpanded = !currentNode.expanded
    const shouldLoad = nextExpanded && !currentNode.children && !currentNode.loading && !pendingLoadsRef.current.has(targetPath)
    if (shouldLoad) pendingLoadsRef.current.add(targetPath)

    updateTree((nodes) => updateNode(nodes, targetPath, (node) => ({
      ...node,
      expanded: !node.expanded,
      ...(shouldLoad ? { loading: true } : {}),
    })))
    if (!shouldLoad) return

    const children = await loadDir(targetPath)
    pendingLoadsRef.current.delete(targetPath)
    updateTree((nodes) => updateNode(nodes, targetPath, (node) => ({ ...node, children, loading: false })))
  }, [loadDir, updateTree])

  // 工作台模式：跟随传入的会话工作目录自动挂根（目录变化/切换会话时重挂）
  // rootPath 不进依赖：用户手动「更换」后保持其选择，直到会话目录再次变化
  const rootRef = useRef<string | null>(null)
  rootRef.current = rootPath
  useEffect(() => {
    if (!initialRoot || rootRef.current === initialRoot) return
    void applyRootFolder(initialRoot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoot])

  if (!rootPath && !initialRoot) {
    return (
      <>
        <div className="flex flex-col items-center justify-center h-48 gap-3 text-dark-onSurfaceVariant">
        <HardDrive size={32} className="opacity-30" aria-hidden="true" />
        <p className="text-sm opacity-50">{t('fileTree.selectWorkspace')}</p>
        <button
          type="button"
          onClick={handleSelectFolder}
          className="px-4 py-2 bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer rounded-md3-sm text-sm transition-colors"
        >
          {t('fileTree.selectFolder')}
        </button>
        </div>
        <HostFolderPicker
          open={hostFolderPickerOpen}
          onClose={() => setHostFolderPickerOpen(false)}
          onSelect={(path) => void applyRootFolder(path)}
          initialPath={ipc.homeDir()}
        />
      </>
    )
  }

  return (
    <>
      <div className="py-1">
      <div className="flex items-center justify-between px-2 mb-2">
        <span title={rootPath ?? undefined} className="text-xs text-dark-onSurfaceVariant/50 truncate flex-1">{rootPath}</span>
        <button
          type="button"
          onClick={handleSelectFolder}
          className="text-xs text-md-info hover:underline"
        >
          {t('fileTree.change')}
        </button>
      </div>
      <div>
        {tree.map((node) => (
          <FileTreeNode key={node.path} node={node} onToggle={handleToggle} onFileSelect={onFileSelect} />
        ))}
      </div>
      </div>
      <HostFolderPicker
        open={hostFolderPickerOpen}
        onClose={() => setHostFolderPickerOpen(false)}
        onSelect={(path) => void applyRootFolder(path)}
        initialPath={rootPath || ipc.homeDir()}
      />
    </>
  )
}
