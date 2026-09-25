# ClerkBox 批次 D：设计系统治理实施计划（D1~D3）

> 目标读者：实施 D 批次的 AI/工程师。与批次 B（`AGENT_RUNTIME_MIGRATION_PLAN.md`）、
> 批次 C（`BATCH_C_CHAT_EXPERIENCE_PLAN.md`）**三方并行**，共享 `main` 分支。
> **改文件前 `git status`，推送前 `git pull --rebase` + 全量测试。**
> 行号锚点基于 commit `744338d`，实施时以符号搜索为准。
>
> 对标来源：`d:\zcode-compare\02-zcode-uiux.md` 借鉴清单 #2（AI 可读设计规范）、#3（单一字号变量）、
> #11（Agent 交互颜色语义）；ZCode 原件见 `d:\ZCode\DESIGN.md` 与 `d:\ZCode\packages\ui\src\styles.css`。

## 范围与顺序

| 子批次 | 内容 | 说明 |
|---|---|---|
| D1 | `DESIGN.md`（写给 AI/工程师的设计规范） | 先做：纯文档，零风险，立即约束后续所有 UI 改动 |
| D3 | 颜色 token 分层（含 C2 要的 ask/confirmation） | 中间做：C2 依赖它 |
| D2 | 字号缩放体系（--ui-font-size + text-ui-*） | 最后做：涉及全站视觉回归 |

---

## D1：DESIGN.md 设计规范

### 现状
- 项目**没有**成文设计规范；token 边界只存在于 `tailwind.config.ts` 与 `src/index.css` 的注释里；
  魔法色值与任意值类名（`text-[10px]`，如 `MessageItem.tsx:180`）散落各处，靠 review 自觉。
- ZCode 的 `DESIGN.md` 明确自述 "meant for coding agents"——让 AI 编码时不发明新视觉规则，
  这是本次对标最便宜、收益最高的实践。

### 交付
仓库根新建 `DESIGN.md`，章节大纲（内容必须从**现状代码**中提炼，不许凭空立规）：

1. **Token 分层总览**：结构面色（surface/card/popover/…）、前景三档（primary/secondary/tertiary）、
   语义色（md-error/success/warning…）、Material 主题变量（`--md-*-rgb`，`src/index.css:9` 起）、
   交互语义色（D3 新增）——每层给出「在哪定义、在哪消费、谁能改」。
2. **暗色与主题**：`.dark` 类切换（`App.tsx` ThemeProvider 约 50~65 行）、
   `applyColorScheme`/`resolveSeed` 生成链（`src/lib/theme-engine.ts:40/57`）、
   禁止绕过 theme-engine 直写颜色变量。
3. **字号与间距**：现行 Tailwind 默认 scale 的使用约定 + D2 落地后的 `text-ui-*` 迁移规则。
4. **组件视觉契约**：按钮/卡片/输入框/弹窗/徽标的允许类名组合，折叠动效约定（grid-rows 模式）。
5. **Do / Don't 清单**（硬约束，AI 必读）：
   - 禁止 `text-[Npx]` 任意值（D2 落地后改用 `text-ui-*`）；
   - 禁止在组件内新写十六进制色，一律走 token；
   - vibe 模式必须显式考虑（白色系降级样式）；
   - 新增用户可见文案必须 i18n 双语；
   - 图标一律 lucide-react（现有约定）。
6. **无障碍基线**：`role="alert"` 用于错误、`aria-*` 最低要求、focus-visible。
7. **中文排版**：`--app-font-family` 字体栈（`index.css:8`）、serif 档位（theme-engine:34）的约束。

### 验收
- [ ] 文档中每个论断都能回指到具体文件行；不引入未实现的规范
- [ ] 与 ZCode DESIGN.md 对照：token 边界、Do/Don't 两节不缺项

---

## D3：颜色 token 分层与交互语义色

### 现状
- 颜色体系 = `tailwind.config.ts:11` 起的 `extend.colors`（`rgb(var(--md-*-rgb) / <alpha-value>)`
  间接层 + `dark-*` surface 色板）+ `src/index.css:9` 起的 `--md-*-rgb` 基线值（`.dark` 覆盖）。
- **缺口**：Agent 交互没有专属语义色——C2 审批卡片要的「待审批 ask」「危险 confirmation」
  两组颜色目前不存在；ZCode 对应 `--color-interaction-ask-*` / `--color-interaction-confirmation-*`。

### 交付
1. **只增不改**地新增两组语义 token：
   ```
   /* index.css 基线（亮色） */
   --md-ask-surface-rgb / --md-ask-onSurface-rgb        /* 待审批：黄/琥珀系 */
   --md-confirmation-surface-rgb / --md-confirmation-onSurface-rgb  /* 危险确认：红系 */
   /* .dark 下覆盖；tailwind.config 注册为
      md.askSurface / md.askForeground / md.confirmationSurface / md.confirmationForeground
      （沿用 <alpha-value> 模式，可带透明度）*/
   ```
2. **前景三档规范化**（不改现有类名，只在 DESIGN.md 记录既有事实 + 补齐缺档）：
   盘点 `text-dark-onSurface` / `/70` / `/50` 的实际用法，确认三档语义并文档化。
3. **图表/终端色板**（如已存在则记录，缺失则列为可选项，不在本批次强推）。

### 与 C2 的契约
- C2 的 `PermissionCard` **只消费** `md.ask*` / `md.confirmation*`；
- D3 先行合入 → C2 无需占位常量；若 C2 先行，占位常量集中在
  `src/components/chat/PermissionCard.tsx` 顶部一处，D3 落地后删除。

### 验收
- [ ] 亮/暗两主题下新 token 均有定义且对比度可读（正文 ≥ 4.5:1）
- [ ] 现有页面视觉**零变化**（只增不改的直接推论，截图抽查 3 页确认）
- [ ] tailwind config + index.css + DESIGN.md 三处同步

---

## D2：字号缩放体系

### 现状
- `tailwind.config.ts` **没有**自定义 `fontSize` scale——全站使用 Tailwind 默认
  `text-xs/sm/base/lg/xl`，无法整体缩放；
- 部分组件用任意值（`text-[10px]` 等，MessageItem/CommandPalette 等处），破坏统一缩放；
- 已有 `appFont`（default/serif）设置项与 `applyAppFont`（theme-engine:125）先例，
  设置项接线模式可复刻；启动防闪由 `theme-init.js`（index.html）处理，字号需同样处理。

### 交付（参照 ZCode `--ui-font-size` 方案，适配 Tailwind 3）

1. **根变量**：`index.css` `:root` 增 `--ui-font-size: 14px;`；`html` 字号跟随。
2. **Tailwind scale 映射**：`tailwind.config.ts` 新增 `fontSize` scale：
   ```ts
   fontSize: {
     'ui-2xl': ['calc(var(--ui-font-size) * 1.75)', { lineHeight: '1.4' }],
     'ui-xl':  ['calc(var(--ui-font-size) * 1.5)',  { lineHeight: '1.45' }],
     'ui-lg':  ['calc(var(--ui-font-size) * 1.25)', { lineHeight: '1.5' }],
     'ui-base':['var(--ui-font-size)',              { lineHeight: '1.6' }],
     'ui-sm':  ['calc(var(--ui-font-size) * 0.875)',{ lineHeight: '1.5' }],
     'ui-xs':  ['calc(var(--ui-font-size) * 0.75)', { lineHeight: '1.45' }],
   }
   ```
   （**保留**默认 scale 不删——旧类名零破坏，新类名渐进迁移。）
3. **设置项**：`AppSettings` 新增 `uiScale?: number`（0.9 / 1 / 1.1 / 1.25 四档或滑杆 90%~150%），
   `applyAppFont` 旁新增 `applyUiScale(scale)` 写 `--ui-font-size = 14px * scale`；
   设置页外观 Tab 加控件（i18n 双语 `settings.appearance.uiScale*`）。
4. **防闪**：`index.html` 的 `theme-init.js` 同步从 KV 读 `uiScale` 预设根变量（与 appFont 同模式）。
5. **迁移策略（渐进，不强推）**：
   - 本批次只建体系 + 设置控件，**不批量替换**现有 `text-sm/text-xs`（避免与 C 的组件改动冲突）；
   - 新代码一律 `text-ui-*`（写入 DESIGN.md Do/Don't）；
   - 任意值 `text-[Npx]` 在后续 C/D 迭代中顺手替换。

### 验收
- [ ] 缩放 100%/125%/150% 三档下：主界面、设置、命令面板、聊天流布局不破（无溢出/截断）
- [ ] 旧类名 `text-sm` 页面视觉与改前逐像素一致（scale=100% 时）
- [ ] 冷启动无字号闪烁（theme-init 预设生效）；serif/黑体两字体档位叠加缩放正常

---

## 协作边界（三方并行）

1. **D 独占**：`DESIGN.md`（新建）、`tailwind.config.ts`、`src/index.css`、
   `src/lib/theme-engine.ts` 的 scale 相关新增、`index.html` 的 theme-init 段。
2. **与 C**：C 的组件只消费 D 的 token/scale；C 不改 tailwind.config/index.css；
   两者对 `PermissionCard` 等新组件的样式以 D 的 Do/Don't 为准。
3. **与 B**：B 不碰视觉层；D 不碰 `agent-core`/`preload`/`chat-store` 运行期。
4. **共享文件**（`settings-store.ts`、`types/agent.ts`、i18n locales、`package.json`）只追加不重排；
   `uiScale`、`pendingSettingsTab` 扩类型等新增字段时先 `git pull --rebase`。
5. 每个子批次独立 commit + push；**视觉敏感的 D2 必须附前后对比截图**（演示阶段）。
