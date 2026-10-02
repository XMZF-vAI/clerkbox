/**
 * 变更前快照的采集与回收（渲染层宿主与主进程宿主共用）。
 *
 * 单独成模块的原因：分类规则（体积上限、二进制、readFile 截断返回）必须两侧完全一致，
 * 否则会出现「一边肯拍快照、另一边拒绝恢复」的对不上。落盘通道是 ipc，
 * 宿主模式下 ipc.ckptPut 经 installAgentHostBridge 直调同一个 handler，语义同源。
 */
import { ipc } from './ipc-client'
import { byteLength, checkpointRef, classifyMutation, contentFingerprint, makeCheckpointId } from './rewind'
import type { FileCheckpoint, FileMutation, FileMutationGap } from '../types/agent'

export interface SaveMutationResult {
  checkpoint: FileCheckpoint | null
  gap: FileMutationGap | null
}

/**
 * 记录一次成功的文件写入。
 *
 * 快照失败绝不升级成「写入失败」：文件已经按模型的意思改好了，这是既定事实，
 * 能做的只是诚实承认「这一轮没法回滚了」——所以失败一律转成 gap 交回调用方记账。
 */
export async function saveFileMutation(sessionId: string, mutation: FileMutation): Promise<SaveMutationResult> {
  const gapFor = (reason: FileMutationGap['reason']): SaveMutationResult => ({
    checkpoint: null,
    gap: { toolName: mutation.toolName, path: mutation.path, reason },
  })

  // 存在但读不出正文：可能是权限、可能是符号链断裂。此时若按「新建」处理，
  // 回滚就会把一个原本存在的文件删掉 —— 直接记缺口，不给它这个机会。
  if (mutation.existedBefore && mutation.before === null) return gapFor('unreadable')

  const classified = classifyMutation(mutation.before)
  if (classified) return gapFor(classified)

  const id = makeCheckpointId()
  const beforeRef = mutation.existedBefore ? checkpointRef(id) : null
  if (beforeRef) {
    try {
      await ipc.ckptPut(sessionId, beforeRef, mutation.before as string)
    } catch (err) {
      console.error('[checkpoint] put failed:', err)
      return gapFor('unreadable')
    }
  }

  return {
    checkpoint: {
      id,
      toolCallId: mutation.toolCallId,
      toolName: mutation.toolName,
      path: mutation.path,
      existedBefore: mutation.existedBefore,
      beforeRef,
      afterHash: contentFingerprint(mutation.after),
      beforeBytes: mutation.before === null ? 0 : byteLength(mutation.before),
      createdAt: Date.now(),
    },
    gap: null,
  }
}

/** 读回某份快照正文；读不到一律返回 null，由回滚计划标 missing-snapshot */
export async function readSnapshotFile(sessionId: string, ref: string): Promise<string | null> {
  if (!ref) return null
  try {
    return await ipc.ckptGet(sessionId, ref)
  } catch (err) {
    console.error('[checkpoint] get failed:', err)
    return null
  }
}

/** 回收快照正文：对话被截断后这些索引已经无人引用，留着就是白吃磁盘 */
export async function dropSnapshotFiles(sessionId: string, refs: string[]): Promise<void> {
  const usable = refs.filter((r) => typeof r === 'string' && r.length > 0)
  if (usable.length === 0) return
  try {
    await ipc.ckptRemove(sessionId, usable)
  } catch (err) {
    // 回收失败只是留了点垃圾，不该把已经成功的撤回标成失败
    console.error('[checkpoint] remove failed:', err)
  }
}

/** 会话删除时整目录回收 */
export async function dropSessionSnapshots(sessionId: string): Promise<void> {
  try {
    await ipc.ckptRemoveSession(sessionId)
  } catch (err) {
    console.error('[checkpoint] removeSession failed:', err)
  }
}
