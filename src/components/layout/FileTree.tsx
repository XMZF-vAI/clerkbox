import { useState, useEffect, useCallback } from 'react'
import { FolderOpen, Folder, File, ChevronRight, ChevronDown, HardDrive } from 'lucide-react'
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

function FileTreeNode({ node, depth = 0, onToggle }: { node: TreeNode; depth?: number; onToggle: (path: string) => void }) {
  const paddingLeft = depth * 16 + 8

  if (!node.isDirectory) {
    return (
      <div
        className="flex items-center gap-2 py-1 px-2 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors cursor-pointer text-sm text-dark-onSurfaceVariant"
        style={{ paddingLeft }}
      >
        <File size={14} />
        <span className="truncate">{node.name}</span>
      </div>
    )
  }

  return (
    <div>
      <button
        onClick={() => onToggle(node.path)}
        className="w-full flex items-center gap-2 py-1 px-2 rounded-md3-sm hover:bg-dark-surfaceContainerHigh transition-colors text-sm text-dark-onSurface"
        style={{ paddingLeft }}
      >
        {node.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {node.expanded ? <FolderOpen size={14} className="text-md-info" /> : <Folder size={14} className="text-md-info" />}
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
        <div className="py-1 text-xs text-dark-onSurfaceVariant/50" style={{ paddingLeft: paddingLeft + 20 }}>
          加载中...
        </div>
      )}
    </div>
  )
}

export default function FileTree() {
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])

  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    try {
      const entries = await ipc.listDir(dirPath)
      return entries
        .sort((a: FileEntry, b: FileEntry) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })
        .map((e: FileEntry) => ({
          name: e.name,
          path: `${dirPath}\\${e.name}`,
          isDirectory: e.isDirectory,
          expanded: false,
        }))
    } catch {
      return []
    }
  }, [])

  const handleSelectFolder = async () => {
    const path = await ipc.selectFolder()
    if (path) {
      setRootPath(path)
      const children = await loadDir(path)
      setTree([{ name: path.split('\\').pop() || path, path, isDirectory: true, expanded: true, children }])
    }
  }

  const handleToggle = useCallback(
    async (path: string) => {
      const toggleNode = (nodes: TreeNode[]): TreeNode[] => {
        return nodes.map((node) => {
          if (node.path === path) {
            const newExpanded = !node.expanded
            return { ...node, expanded: newExpanded }
          }
          if (node.children) {
            return { ...node, children: toggleNode(node.children) }
          }
          return node
        })
      }

      setTree((prev) => toggleNode(prev))

      // Lazy load children
      const findNode = (nodes: TreeNode[]): TreeNode | null => {
        for (const node of nodes) {
          if (node.path === path) return node
          if (node.children) {
            const found = findNode(node.children)
            if (found) return found
          }
        }
        return null
      }

      const currentTree = tree
      const node = findNode(currentTree)
      if (node && node.isDirectory && !node.children && !node.expanded) {
        setTree((prev) => {
          const setLoading = (nodes: TreeNode[]): TreeNode[] =>
            nodes.map((n) =>
              n.path === path ? { ...n, loading: true } : n.children ? { ...n, children: setLoading(n.children) } : n
            )
          return setLoading(prev)
        })

        const children = await loadDir(path)
        setTree((prev) => {
          const updateNode = (nodes: TreeNode[]): TreeNode[] =>
            nodes.map((n) =>
              n.path === path
                ? { ...n, children, loading: false }
                : n.children
                ? { ...n, children: updateNode(n.children) }
                : n
            )
          return updateNode(prev)
        })
      }
    },
    [loadDir, tree]
  )

  if (!rootPath) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-dark-onSurfaceVariant">
        <HardDrive size={32} className="opacity-30" />
        <p className="text-sm opacity-50">选择一个工作区文件夹</p>
        <button
          onClick={handleSelectFolder}
          className="px-4 py-2 bg-dark-surfaceContainerHigh hover:bg-dark-surfaceContainer rounded-md3-sm text-sm transition-colors"
        >
          选择文件夹
        </button>
      </div>
    )
  }

  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-2 mb-2">
        <span className="text-xs text-dark-onSurfaceVariant/50 truncate flex-1">{rootPath}</span>
        <button
          onClick={handleSelectFolder}
          className="text-xs text-md-info hover:underline"
        >
          更换
        </button>
      </div>
      {tree.map((node) => (
        <FileTreeNode key={node.path} node={node} onToggle={handleToggle} />
      ))}
    </div>
  )
}
