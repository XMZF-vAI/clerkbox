# ZCode v3.17.1 对标研究报告合集

> 调研对象：D:\ZCode（zai-org/ZCode 开源仓库，已更新至 v3.17.1，a60ba6a7，2026-10-30）
> 调研日期：2026-11-01 · 目标：**ClerkBox 功能与 UI/UX 全面对齐 ZCode**
> 方法：7 路并行源码考古（Explore 子代理，只读）+ 交叉核实；报告由主会话汇总撰写

## 报告索引

| # | 文件夹 | 主题 | 优先级 |
|---|---|---|---|
| 01 | [01-chat-tool-loop-ui](./01-chat-tool-loop-ui/研究报告.md) | **对话界面与 AI 工具调用整个循环的 UI**（投影架构/行模型/工具卡状态机/审批 UI/时间线三板斧/输入区/流式 markdown） | ★★★ 最高——此前一直未搞定，重构施工图纸 |
| 02 | [02-dynamic-workflow](./02-dynamic-workflow/研究报告.md) | **动态工作流**（/workflow 入口/编译器/沙箱/确定性引擎/journal 重放/hole/quota 续跑/UI 三件/最小实现清单+四期分期） | ★★★ 鱼皮文章重点 |
| 03 | [03-system-prompt](./03-system-prompt/研究报告.md) | **系统提示词体系**（section 模块化/组装管线/工具描述五范本/system-reminder 注册表/防注入/子代理与压缩提示词） | ★★★ |
| 04 | [04-permission-security](./04-permission-security/研究报告.md) | **权限与安全模式**（plan/build/guarded/yolo 语义/18 级 fail-closed 瀑布/unbash AST/any-every 语义/危险命令清单/CB 三期落地方案） | ★★★ 直接回答「三种模式怎么实现」 |
| 05 | [05-agent-loop-tools](./05-agent-loop-tools/研究报告.md) | Agent 主循环与工具系统（command queue/工具契约 7 钩子/结果四轨/三层压缩/流式协议/子代理/持久化） | ★★ |
| 06 | [06-ui-ux-shell](./06-ui-ux-shell/研究报告.md) | 整体 UI/UX 壳层（多 workspace tab/界面模式纠偏/首页草稿模型/设置体系/插件市场/视觉规范/桌面集成/响应式） | ★★ |

## 核心结论速览

1. **CB 最大的差距是「最后接线」而非「不知道怎么抄」**：对话 UI 的 6 件 ZCode 机制模块（markdown/code-highlighter/live-tail-split/timeline-row-height-cache/timeline-scroll-anchor）已写完+测完，但只有 1 件通电——报告 01 §12 的 P0 就是通电清单。
2. **ZCode 的专业感来自机制**：UI 零事实产生（只读投影）、turnId 稳定 key、following 滚动权状态机、工具卡折叠状态机（模块级持久+边沿收起+300ms 延迟卸载）、renderer 三层分流——抄机制不抄文件（ZCode 单文件 200KB+ 血债别学）。
3. **动态工作流的核心资产只有一个**：「一份 facade .d.ts + 一个 ts.Program 同时产出诊断/站点表/JSON Schema/lowered 代码」——图、确认窗、引擎全部从它派生。四期分期见报告 02 §9。
4. **三种安全模式的答案**：plan=只读+其余 DENY；build（默认）=只读放行+有副作用 ask；guarded=yolo 基线+危险命令 AST 命中时单次审批。引擎=18 级 fail-closed 瀑布+unbash AST+any/every 双语义。CB 三期落地方案见报告 04 §8。
5. **提示词的四个反直觉决策**：section 微段落模块化、系统提示词零工具描述、防注入是注册表+转义+防伪声明三件套、模式切换不换 system prompt 保缓存。
6. **界面模式纠偏**：ZCode 的 office/coding 只是轻量偏好（推荐词/设置页/遥测），没有独立工具集——CB 现有实现方向正确，不必加重。

## 关键事实

- ZCode v3.14.3 → v3.17.1 期间 packages/ui 变更 1583 文件 +14.4 万行，workflow UI 与协议 v4 投影是大头；老结论（overscan=8、72px 估高）已被新版推翻（现 overscan=2、turn 级估高=一屏）。
- 三代 workflow 机制并存于仓库：鱼皮文章测的是第三代 dynamic-workflow（11 工具、TS 脚本、vm 沙箱、journal 重放）。
- OS 级 bash 沙箱已被 ZCode 撤除，安全边界完全靠权限模式+审批——CB 不必做沙箱。

## 配套记忆

本次调研结论已同步写入 ZCode 记忆库（clerkbox 项目），含 ZCode IM bot/agent 机制/对话 UI 等历次考古的交叉引用。
