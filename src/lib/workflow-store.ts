/**
 * 已保存的工作流（三期「能存能复跑」的「存」）。
 *
 * 存 `<cwd>/.clerkbox/workflows/<slug>.json`——与 spec 文档同一收纳约定：
 * 用户看得见、可进版本库。ZCode 同思路（<cwd>/.zcode/workflows/），文件格式
 * 从 YAML 前言换成 JSON（CB 的脚本本来就是 JS，没有编译期元数据需求）。
 *
 * 保存不设权限门（与 save_memory 同级）：写的是受控目录下的元数据文件，
 * 真正有副作用的执行仍在 create_workflow 的脚本确认门后面。
 */
import { ipc } from './ipc-client'

export interface SavedWorkflow {
  version: 1
  name: string
  description: string
  script: string
  savedAt: number
}

/** 文件名安全化：路径分隔符与 Windows 非法字符一律转连字符；过长截断 */
export function workflowSlug(name: string): string | null {
  const slug = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  if (!slug || slug === '.' || slug === '..') return null
  return slug
}

export function workflowsDir(workingDir: string): string {
  return `${workingDir.replace(/[\\/]+$/, '')}/.clerkbox/workflows`
}

export function workflowFilePath(workingDir: string, name: string): string | null {
  const slug = workflowSlug(name)
  if (!slug) return null
  return `${workflowsDir(workingDir)}/${slug}.json`
}

/** 保存（同名覆盖）；返回落盘路径 */
export async function saveWorkflowFile(
  workingDir: string,
  input: { name: string; description: string; script: string },
): Promise<string> {
  const filePath = workflowFilePath(workingDir, input.name)
  if (!filePath) throw new Error('工作流名称不合法（不能是空、点号或只含路径分隔符）')
  const record: SavedWorkflow = {
    version: 1,
    name: input.name.slice(0, 80),
    description: input.description.slice(0, 500),
    script: input.script,
    savedAt: Date.now(),
  }
  await ipc.writeFile(filePath, JSON.stringify(record, null, 2))
  return filePath
}

/** 读取；不存在或损坏返回 null（损坏不炸调用方，让模型重存一遍） */
export async function readWorkflowFile(workingDir: string, name: string): Promise<SavedWorkflow | null> {
  const filePath = workflowFilePath(workingDir, name)
  if (!filePath) return null
  try {
    const raw = await ipc.readFile(filePath)
    const parsed = JSON.parse(raw) as SavedWorkflow
    if (parsed?.version === 1 && typeof parsed.script === 'string' && parsed.script) return parsed
    return null
  } catch {
    return null
  }
}

/** 列出已保存工作流的名字（按文件名，去掉 .json 后缀） */
export async function listSavedWorkflowNames(workingDir: string): Promise<string[]> {
  try {
    const entries = await ipc.listDir(workflowsDir(workingDir))
    return entries
      .filter((e) => e.name.endsWith('.json') && e.isDirectory !== true)
      .map((e) => e.name.slice(0, -'.json'.length))
      .sort()
  } catch {
    return []
  }
}
