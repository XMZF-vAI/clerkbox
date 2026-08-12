import { useCallback, useRef, useState } from 'react'
import { FolderOpen, Folder, File, ChevronRight, ChevronDown, HardDrive } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ipc } from '../../lib/ipc-client'
import type { FileEntry } from '../../types/ipc'

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

function FileTreeNode({ node, depth = 0, onToggle }: { node: TreeNode; depth?: number; onToggle: (path: string) => void }) {
  const { t } = useTranslation()
  const paddingLeft = depth * 16 + 8

  if (!node.isDirectory) {
    return (
      <div
        title={node.path}
        className="flex items-center gap-2 py-1 px-2 rounded-md3-sm text-sm text-dark-onSurfaceVariant"
        style={{ paddingLeft }}
      >
        <File size={14} aria-hidden="true" />
        <span className="truncate">{node.name}</span>
      </div>
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
            <FileTreeNode key={child.path} node={child} depth={depth + 1} onToggle={onToggle} />
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

export default function FileTree() {
  const { t } = useTranslation()
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
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
    const selectedPath = await ipc.selectFolder()
    if (!selectedPath) return

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

  if (!rootPath) {
    return (
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
    )
  }

  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-2 mb-2">
        <span title={rootPath} className="text-xs text-dark-onSurfaceVariant/50 truncate flex-1">{rootPath}</span>
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
          <FileTreeNode key={node.path} node={node} onToggle={handleToggle} />
        ))}
      </div>
    </div>
  )
}
