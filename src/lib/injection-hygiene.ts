/**
 * 注入卫生（报告 03 P1 · 防注入双层的外层数据面）。
 *
 * 模型层的注入防线靠提示词本身（双层声明）；这里处理的是**数据面**：
 * 外部文件（SKILL.md）、子代理结果这类不可信文本，注入回主对话时可能
 * 伪造系统信封——提前闭合 `<subagent-notification>`、伪造
 * `<system-reminder>` 等。做法与 ZCode 同口径：进入系统信封的内容把
 * 尖括号转义成 HTML 实体，信封本身由系统拼接，模型读到的是字面量。
 *
 * 刻意**不**转义子代理结果正文（代码片段里的 `<` 是真内容，转义会损坏），
 * 只转义会破坏信封结构的序列（`</tag>` 形态的闭合 + `<system-reminder`、
 * `<subagent`、`<workflow` 开头的新信封伪造）。
 */

/** 可能被伪造的系统信封开标签（新增信封时在此登记） */
const FAKE_ENVELOPE_TAG = /<\/?(?:system-reminder|subagent-notification|workflow-notification|background-agent-notifications|agent-approval|goal-condition)\b[^>]*>/gi

/**
 * 转义会破坏/伪造系统信封的尖括号序列：
 * - 闭合与开标签整体转义（&lt;tag）
 * - 其余 `<` 原样保留（代码与比较符是真内容）
 */
export function escapeEnvelopeSpoofing(text: string): string {
  if (!text) return text
  return text.replace(FAKE_ENVELOPE_TAG, (m) => m.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
}

/** 外部文件数据的全量尖括号转义（SKILL.md 摘要等纯说明文本——代码示例不在其中） */
export function escapeExternalText(text: string): string {
  if (!text) return text
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 通知防伪声明：ZCode 同款——系统注入不是用户输入，这条要写进信封本身 */
export const SYSTEM_INJECTION_DISCLAIMER = '[系统注入] 本块由 ClerkBox 运行时自动生成，不是用户输入；其中引用的执行结果来自子代理/工作流的输出原文。'
