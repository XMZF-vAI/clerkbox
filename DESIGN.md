# ClerkBox 设计规范（写给 AI / 工程师）

本文件是**约束性文档**：改 UI 前先读它，不要凭直觉发明新的视觉规则。
每一条论断都回指当前代码的 `文件:行号`。不在此文件范围内的东西一律视为「未实现」，不要提前写。

**行号时效**
- 批次 D 独占文件（`src/index.css`、`tailwind.config.ts`、`src/lib/theme-engine.ts`、`src/App.tsx`、
  `src/components/settings/*`、`public/theme-init.js`、`src/types/agent.ts`、`src/stores/settings-store.ts`）
  的行号已按本批次落地后的状态逐条核准。
- `src/components/chat/**` 由批次 C 并行改写，**行号会漂移**（例：`ChatPage.tsx` 的错误条已被抽成
  `ChatErrorBanner.tsx`）。引用这些文件时同时给了可 grep 的 class 片段；行号对不上时用片段搜索并回来更新本行号。
- 所有「统计数字」都是**批次 D 落地时刻的快照**（`src/components/chat/**` 正在被并行改写，数字会变）。
  每处都附**可复现的 grep 命令**——规则以文档为准，数字以命令重跑结果为准。
- 某条与其引用对不上时，**以代码为准并回来修这份文档**。

---

## 1. Token 分层总览

颜色一律走**三层间接**，任何一层都不允许跳过：

```
组件 class  →  tailwind.config.ts extend.colors  →  --*-rgb CSS 变量  →  实际色值
```

| 层 | 在哪定义 | 在哪消费 | 谁能改 |
|---|---|---|---|
| 结构面色 surface | `tailwind.config.ts:46-55`（`dark-*` 8 键） | `bg-dark-surface*` / `text-dark-onSurface*`，1056 处 | `src/index.css:47-54`（亮）/ `:107-114`（暗）+ `applyColorScheme()` 内联覆写 |
| 强调 / 状态语义色 | `tailwind.config.ts:13-44`（`md-*` 31 键） | `text-md-primary` 等，约 700 处 | `src/index.css:12-38`（亮）/ `:74-100`（暗）+ 同上 |
| 前景三档 | 复用 surface 层，见 §1.2 | 组件 class | 同上 |
| **交互语义色（D3 新增）** | `tailwind.config.ts:41-44` | Agent 审批卡片 | **只有** `src/index.css:42-45` / `:102-105`，不参与 seed |
| Material 生成链 | `src/lib/theme-engine.ts:57-108` | 运行时内联写 `documentElement.style` | 用户设置 `colorScheme` / `customSeedColor` |
| 圆角 | `tailwind.config.ts:70-76`（`md3-xs/sm/md/lg/xl` = 4/8/12/16/28px） | 299 处 `rounded-md3-*` | 只有 config |
| 高程阴影 | `tailwind.config.ts:78-82`，令牌值 `src/index.css:62-64` | 26 处 `shadow-elevation-*` | 只有 `index.css:62-64` |
| 缓动曲线 | `tailwind.config.ts:84-87`（class）**与** `src/index.css:67-69`（内联/CSS 用） | `ease-md-standard` 等 | **两处同值，必须一起改** |
| 入场动画 | `tailwind.config.ts:89-97`，keyframes `:98-129` | `animate-fade-in` / `animate-pop-in` / `animate-vibe-cross` | 只有 config |
| 字体栈 | `src/index.css:8`，消费 `:299-303` 与 `tailwind.config.ts:57-59` | 全站 | 见 §7 |
| 字号缩放 | 见 §3.1 | 全站 rem | 见 §3.1 |

复现统计：
```bash
grep -rEo '\b(bg|text|border|from|via|to|ring|fill|stroke|decoration|divide|placeholder|shadow|accent|caret)-dark-[a-zA-Z]+(/[0-9]+)?' src --include=*.tsx --include=*.css | wc -l
grep -rEo '\b(bg|text|border|from|via|to|ring|fill|stroke|decoration|divide|placeholder|shadow|accent|caret)-md-[a-zA-Z]+(/[0-9]+)?'   src --include=*.tsx --include=*.css | wc -l
grep -rEo 'rounded-md3-[a-z]+'    src --include=*.tsx --include=*.css | wc -l
grep -rEo 'shadow-elevation-[0-9]' src --include=*.tsx | wc -l
```

### 1.1 `dark-*` 是历史命名，不是「暗色专用」

`bg-dark-surface` 在**浅色主题下同样在用**：`src/index.css:47-54` 给 `:root` 写了它，
而 `applyColorScheme()` 把 `--dark-*-rgb` 与 `--md-*-rgb` 的 surface 族写成同一个色
（`src/lib/theme-engine.ts:94-107`，原注释「dark-* token 是当前主题 surface 的镜像（历史命名）」）。
因此：

- `bg-dark-surface` = **当前主题的背景**，与深浅无关。
- 结构面色一律用 `dark-*`：`bg-md-surface` / `bg-md-surfaceContainer*` / `bg-md-surfaceBright`
  在组件里的实际用量是 **0**（`grep -rEo '(bg|text|border)-md-(surface|surfaceDim|surfaceBright|surfaceContainer|surfaceContainerHigh|surfaceContainerHighest)\b' src --include=*.tsx | wc -l` → 0）。
  那是一组事实上的死键，**别用**。
- 需要 `onPrimary` / `onError` 这类「只有强调色才有」的前景时，`dark-*` 族里**没有**对应键
  （`tailwind.config.ts:46-55` 只有 8 个），只能用 `md-*`。
- 描边例外：`border-md-outlineVariant`（4 处，`tailwind.config.ts:34` 注册）与
  `border-md-outline`（`SubAgentCard.tsx` 1 处 + `SubAgentDetailPanel.tsx` 3 处，
  定位：`grep -rn 'border-md-outline' src --include=*.tsx`）在用；
  但更常见的既有写法是 `border-dark-onSurfaceVariant/10`（弹窗、分区、分隔线都用它）。

### 1.2 前景三档（实测用法归纳，不是理想态）

统计：`grep -rEo 'text-dark-onSurface([^/a-zA-Z]|$)' src --include=*.tsx --include=*.ts --include=*.css | wc -l` 等。

| 档 | 写法 | 次数 | 语义 |
|---|---|---|---|
| 一档 主文本 | `text-dark-onSurface` | 107 | 标题、消息正文、可读性优先的一切 |
| 一档 弱化 | `text-dark-onSurface/85`、`/90` | 4 | 只出现在工具行标签（`MessageItem.tsx` 的 `vibe ? 'text-white/85' : 'text-dark-onSurface/85'`） |
| 二档 次文本 | `text-dark-onSurfaceVariant` | 184 | 说明、占位、图标 |
| 三档 三级文本 | `text-dark-onSurfaceVariant/60` | 73 | 计数、时间戳、单位 |
| | `text-dark-onSurfaceVariant/50` | 54 | 折叠区、辅助提示 |
| | `text-dark-onSurfaceVariant/70` | 47 | 一行副标题 |
| | `text-dark-onSurfaceVariant/40` | 38 | 分区小标题（常配 `uppercase`） |
| | `text-dark-onSurfaceVariant/30` | 15 | 免责声明、最弱脚注（`ChatInput.tsx` 的 `t('chat.disclaimer')` 那一行） |
| 长尾 | `/80`(5) `/25`(3) `/35`(1) `/85`(1) | 10 | 个例，**新增时不要照抄** |

规则：

- 三档 = **一档 `onSurface`** / **二档 `onSurfaceVariant` 不透明** / **三档 `onSurfaceVariant` + `/30~/70`**。
  项目里 `text-dark-onSurface/70`、`text-dark-onSurface/50` 是 **0 次**。
  **不要**给 `onSurface` 加透明度来当次要文字——那是 `onSurfaceVariant` 的职责。
- 三档的落点只在 `/60`（默认）/`/50`/`/40`/`/30` 四档里取，其余是长尾。
- 另有 21 处 `text-md-onSurfaceVariant` 与 8 处 `text-md-onSurface`，与 `dark-*` 同值
  （`theme-engine.ts:83` 与 `:103` 写同一色），属可收敛的重复，本批次不动，**新代码别选它**。

### 1.3 交互语义色（批次 D3 新增）

给 Agent 审批流用，**固定基线**，不随马卡龙 seed 变化。类名就这四个，大小写抄准：

| Tailwind 类名 | CSS 变量 | 亮色值 | 暗色值 |
|---|---|---|---|
| `bg-md-askSurface` / `border-md-askSurface` | `--md-ask-surface-rgb` | `255 236 179` `#FFECB3` | `78 58 12` `#4E3A0C` |
| `text-md-askForeground` | `--md-ask-onSurface-rgb` | `110 70 0` `#6E4600` | `255 214 130` `#FFD682` |
| `bg-md-confirmationSurface` | `--md-confirmation-surface-rgb` | `255 222 220` `#FFDEDC` | `88 32 28` `#58201C` |
| `text-md-confirmationForeground` | `--md-confirmation-onSurface-rgb` | `124 22 20` `#7C1614` | `255 209 204` `#FFD1CC` |

定义：`src/index.css:42-45`（`:root`）与 `src/index.css:102-105`（`.dark`）；
注册：`tailwind.config.ts:41-44`，沿用 `rgb(var(--x-rgb) / <alpha-value>)`，
所以 `bg-md-askSurface/10`、`border-md-confirmationForeground/30` 这类带透明度的写法直接可用。

配对固定为 **`*Surface` 当背景/描边、`*Foreground` 当文字**，不交叉：

```tsx
<div className="rounded-md3-md border border-md-askSurface bg-md-askSurface/10">
  <p className="text-ui-sm text-md-askForeground">…</p>
</div>
// 危险确认卡片：同结构，换 confirmationSurface / confirmationForeground
```

对比度（WCAG 2.1 相对亮度法实测；「最坏面色」= 跨全部 7 个马卡龙预设 + 自定义预设、
跨 `surface/surfaceDim/surfaceBright/surfaceContainer/surfaceContainerHigh/surfaceContainerHighest`
全族取最小值）：

| 场景 | ask | confirmation |
|---|---|---|
| 亮色：Foreground on 同档 Surface 实色 | **7.05:1** | **8.44:1** |
| 暗色：Foreground on 同档 Surface 实色 | **7.85:1** | **9.30:1** |
| 亮色：Foreground on `/10` 淡底叠 `#FAFAFA` | 7.83:1 | 9.68:1 |
| 暗色：Foreground on `/10` 淡底叠 `#121212` | 13.11:1 | 12.96:1 |
| 亮色：Foreground on 最坏面色（surfaceDim，tone 90） | 6.38:1 | 8.18:1 |
| 暗色：Foreground on 最坏面色（surfaceBright，tone 24） | 8.36:1 | 8.38:1 |

最坏值 6.38:1 > 4.5:1，正文与图标都可放心用；不需要再叠自定义遮罩。

**谁能改**：只有 `src/index.css:42-45` 与 `:102-105`。
`applyColorScheme()` 的写入清单（`theme-engine.ts:63-88` 与 `:95-104`）**故意不含**这四个变量，
所以用户换色系不会动它们——这是设计决定不是遗漏：审批色要跨主题稳定可辨识。
将来若让 seed 参与 ask/confirmation 生成，改动点是 `theme-engine.ts:63` 的 `entries` 数组，
且必须重算上表最坏值并回到 ≥ 4.5:1。

### 1.4 其它既有的非通用变量

- `--shimmer-base/mid/peak-rgb`：`index.css:57-59`（亮）/ `:117-119`（暗），
  只服务思考态文字渐变（消费 `index.css:225-239`、`:281-290`）。不是色板，别挪用。
- `--md-shadow-1/2/3`：`index.css:62-64`；`--md-ease-*`：`index.css:67-69`。
- `--ofv-*`：`index.css:417-426`（浅色嵌入）与 `:486-495`（VIBE 嵌入），只服务 File Viewer。
- **图表 / 终端色板**：现状**没有**统一 token。图表序列色目前靠 `rgb(var(--md-*-rgb))` 插值复用主题色
  （`ContextUsageIndicator.tsx` 搜 `rgb(var(--md-`，6 行序列色表），终端则是**整块硬编码**
  （`TerminalPanel.tsx:18-23`，全站唯一成块的字面色，本批次未动）。二者列为 D+1 可选项，不在本批次强推。

---

## 2. 暗色与主题

- **切换机制**：`darkMode: 'class'`（`tailwind.config.ts:4`）。`.dark` 挂在 `<html>` 上，
  React 侧唯一写入点 `src/App.tsx:60`（`root.classList.toggle('dark', isDark)`）。
- **配色生成链**：`App.tsx:61` → `resolveSeed()`（`theme-engine.ts:40-43`，设置项 → 种子色）
  → `applyColorScheme(seed, isDark)`（`theme-engine.ts:57-108`；`SchemeTonalSpot` + 饱和度 0，见 `:49-51`）
  → 以**内联样式**写 `documentElement.style`。
  内联优先级高于 `src/index.css` 的 `:root` / `.dark` 块，所以 CSS 里那份只是「首帧基线」。
- **跟随系统**：`theme === 'system'` 时 `App.tsx:64-67` 挂 `matchMedia` 回调，重跑同一条链。
- **首帧防闪**：`public/theme-init.js`（`index.html:89` 引入，早于 React）
  从 `localStorage['clerkbox-settings']` 读 `state.theme` 决定 `.dark` 初始态（`:22-31`）。
- **WebUI 例外**：浏览器模式下 `main.tsx:12-14` 给 `<html>` 加 `.webui-mode`，
  `index.css:314-316` 据此把 body 底色改为实体 surface（桌面是透明窗口，body 必须透明）。

**禁止**

- 绕过 `applyColorScheme` 直接 `style.setProperty('--md-*-rgb', …)`。
- 在组件里写 `dark:` 变体手工配色 —— 主题全靠变量层切换，不走 `dark:` 分支。
- 新增 `.dark { --x-rgb }` 却漏掉 `:root` 基线（首帧会拿到 `undefined` → 渲染成黑色/透明）。

**新增一个主题变量的正确姿势**（照 D3 四步，可当 checklist）

1. `index.css` 的 `:root` 写亮色基线（对照 `:42-45`）；
2. `index.css` 的 `.dark` 写暗色覆写（对照 `:102-105`）；
3. `tailwind.config.ts` 注册 `rgb(var(--x-rgb) / <alpha-value>)`（对照 `:41-44`）；
4. 若该色要跟随 seed，把它加进 `theme-engine.ts:63` 的 `entries`；**不跟就什么都不加**。

---

## 3. 字号与间距

### 3.1 缩放体系（批次 D2）

单一根变量驱动，`--ui-font-size` 就是 **rem base**：

| 环节 | 位置 | 内容 |
|---|---|---|
| 变量声明 | `src/index.css:11` | `--ui-font-size: 16px;` |
| html 跟随 | `src/index.css:299-303`（`font-size` 在 `:301`） | `html { font-size: var(--ui-font-size) }` |
| Tailwind 档位 | `tailwind.config.ts:62-68` | `text-ui-2xl / xl / lg / base / sm / xs` |
| 运行时写入 | `src/lib/theme-engine.ts:144-152` | `applyUiScale(scale)`：`16px * scale`；`scale===1` 时 `removeProperty` 回落 |
| 常量（基准/区间/档位） | `src/lib/theme-engine.ts:135-138` | `UI_FONT_BASE_PX=16`、`UI_SCALE_MIN=0.8`、`UI_SCALE_MAX=1.6`、`UI_SCALE_OPTIONS=[0.9,1,1.1,1.25]` |
| React 接线 | `src/App.tsx:77-81` | 水合后与设置同步（复刻 `applyAppFont` 的 `:71-75`） |
| 首帧防闪 | `public/theme-init.js:17-21` | 读 `state.uiScale` 预设内联值（越界/等于 1 时不写） |
| 设置控件（桌面） | `src/components/settings/SettingsPage.tsx:430-452` | 四档分段按钮 |
| 设置控件（移动） | `src/components/settings/MSettingsPage.tsx:440-462` | 同上，触控高度 `py-2.5` |
| 类型与默认值 | `src/types/agent.ts:273-274`、`src/stores/settings-store.ts:36` | `uiScale?: number`，默认 `1`（`agent.ts:273` 的旧注释写「基准 14px」，与实现的 16px 不符，待 owner 修正）|

**为什么基准是 16px 而不是 14px**：Tailwind 3.4 的 preflight（`node_modules/tailwindcss/src/css/preflight.css:30-40`）
**不设** `html { font-size }`，改动前 root 字号是 Chromium UA 默认 = 16px；而所有 `text-*`、间距、宽度都是 rem。
基准取 16px 才让 `scale=100%` 时的 `html` 字号**等于改动前**，旧类名逐像素不变（这是验收项）；
正文默认档由 `text-ui-sm = 0.875 × 16px = 14px` 给出。若照 14px 建基准，全站 rem（含 `p-4`、`h-7`、`w-40`
与全部旧 `text-sm`）会瞬间缩 12.5%。
副作用（已知、可接受）：root 字号被显式钉成 16px 后，**WebUI 模式**下若浏览器改过「标准字号」，
不再跟随（桌面 Electron 恒为 16px，无此设置）。`-webkit-text-size-adjust: 100%` 由 preflight:33 保证，
移动端不会二次自动放大字号。

`text-ui-*` ↔ Tailwind 默认档对照（`--ui-font-size = 16px`，即 scale 100%）：

| `text-ui-*` | 声明（`tailwind.config.ts:63-68`） | computed | 对应默认类 | 默认 computed | 相等 |
|---|---|---|---|---|---|
| `ui-2xl` | `calc(var(--ui-font-size) * 1.5)` | 24px | `text-2xl` `1.5rem` | 24px | ✅ |
| `ui-xl` | `calc(var(--ui-font-size) * 1.25)` | 20px | `text-xl` `1.25rem` | 20px | ✅ |
| `ui-lg` | `calc(var(--ui-font-size) * 1.125)` | 18px | `text-lg` `1.125rem` | 18px | ✅ |
| `ui-base` | `var(--ui-font-size)` | 16px | `text-base` `1rem` | 16px | ✅ |
| `ui-sm` | `calc(var(--ui-font-size) * 0.875)` | 14px | `text-sm` `0.875rem` | 14px | ✅ |
| `ui-xs` | `calc(var(--ui-font-size) * 0.75)` | 12px | `text-xs` `0.75rem` | 12px | ✅ |

`line-height` 同样逐档取 Tailwind 默认值（`2rem / 2rem / 1.75rem / 1.5rem / 1.25rem / 1rem`
= `32 / 32 / 28 / 24 / 20 / 16` px），所以 **`text-ui-sm` 是 `text-sm` 的同名等价替换**，
迁移不引入任何行高变化。缩放时新档与旧档、以及间距一起缩放（rem 同源），排版比例不变。
四档实际 `--ui-font-size`：`0.9→14.4px`、`1→16px（无内联，回落 :root）`、`1.1→17.6px`、`1.25→20px`。

### 3.2 迁移策略（本批次只建体系，不动旧类名）

- **新代码一律 `text-ui-*`**。本批次新写的设置控件已按此执行
  （`SettingsPage.tsx:431,442`、`MSettingsPage.tsx:441,452` 用 `text-ui-sm`，
  与相邻的 `text-sm` 控件计算值完全相同）。
- 旧类名 `text-xs/sm/base/lg/xl/2xl` **不批量替换**；按「改到哪个文件顺手迁哪一处」推进，
  一次提交不要把无关文件的字号打包一起改（会与并行批次撞车）。
- **禁止新增 `text-[Npx]`**（§5.1）。现存底账：全站 **187** 处
  （`grep -rEo 'text-\[[0-9]+px\]' src --include=*.tsx --include=*.ts --include=*.css | wc -l`）。
  按值：`10px`×94、`11px`×74、`9px`×7、`12px`×7、`13px`×3、`15px`×2。
  按文件（前列）：`SkillStore.tsx` 34、`ChatInput.tsx` 31、`MessageItem.tsx` 26、`ProvidersSection.tsx` 23、
  `SubAgentDetailPanel.tsx` 12、`VibeCustomizeMenu.tsx` 11、`Sidebar.tsx` 6、`VibeMusicPlayer.tsx` 5、
  `SettingsPage.tsx` 5、`ScheduledTasksPage.tsx` 4、`UpdateBadge.tsx` 4、`SubAgentCard.tsx` 4、
  `index.css` 3（`:169`、`:172`、`:603`）、`CommandPalette.tsx` 3（`:155`、`:172`、`:194`）、
  `TokenUsageStats.tsx` 3、`MSettingsPage.tsx` 3、`GoalBanner.tsx` 3、`ContextUsageIndicator.tsx` 2、
  `AgentStatusIndicator.tsx` 2（`:123`、`:126`）。
  典型样本：`CommandPalette.tsx:155`、`ChatInput.tsx` 的 `text-[9px]`、
  `MessageItem.tsx` 的 `text-[10px] tabular-nums`（全站 `text-[9px]` 共 7 处）。
  迁移映射：`9/10px → ui-xs`；`11/12px → ui-xs 或 ui-sm`（看行高是否敏感）；`13/15px → ui-sm`。
  **注意** `10/11px` 比 `ui-xs`(12px) 更小，直换会撑大版面——这是有意的，但要连排版一起看，别机械替换。

### 3.3 间距

间距**没有**自定义 scale，直接用 Tailwind 默认（`gap-2`、`p-4`、`h-7`…），单位 rem，
因此随 §3.1 一起缩放。现状约定：

- 图标按钮 `w-7 h-7`（`ConfirmDialog.tsx:95`）；小复选框 `w-5 h-5`（`ChatInput.tsx` 的 `text-[9px]` 那一行）。
- 卡片内边距 `p-3`、行内条 `px-3 py-1.5`（`MessageItem.tsx` 搜 `px-3 py-1.5` / `px-2.5 py-1.5`）；
  弹窗头/身/尾统一 `px-5 py-4`（`ConfirmDialog.tsx:83,102,107`）。
- 按钮 `px-4 py-2`（`ConfirmDialog.tsx:111,119`）；
  分段选择 `py-2`（桌面 `SettingsPage.tsx:398,418,442`）/ `py-2.5`（移动 `MSettingsPage.tsx:408,428,452`）。
- 需要随字号缩放的尺寸**别写死 px**：`ConfirmDialog.tsx:79` 的 `w-[400px] max-w-[calc(100vw-2rem)]`
  就是「弹窗宽度不随字号成长」的既成例外，新增弹窗沿用即可，别再扩散这类写法。

---

## 4. 组件视觉契约

项目**没有** `button.tsx` / `card.tsx` 原语（`src/components/ui/` 只有
`CommandPalette / ConfirmDialog / HostFolderPicker / QrCode`），样式靠 class 组合。
下面是各类型的**既成组合**，新代码照抄，不要另起炉灶。

### 4.1 弹窗 / 抽屉（样板 = `ConfirmDialog.tsx`）

```
遮罩   fixed + z-50 + flex items-center justify-center + animate-fade-in        (:70)
       vibe 时 inset-0 + bg-black/50 backdrop-blur-sm，否则 top-11 + bg-black/60 (:70)
面板   bg-dark-surfaceDim rounded-md3-xl border border-dark-onSurfaceVariant/10
       shadow-elevation-3 animate-pop-in                                        (:79)
A11y   role="dialog" aria-modal aria-labelledby aria-describedby                (:75-78)
头部   px-5 py-4 border-b border-dark-onSurfaceVariant/10，标题 text-base font-semibold (:83,:88)
正文   px-5 py-4，text-sm text-dark-onSurfaceVariant leading-relaxed            (:102-103)
底部   px-5 py-4 border-t border-dark-onSurfaceVariant/10，右对齐 gap-2          (:107)
关闭钮 md-focus w-7 h-7 rounded-md3-sm hover:bg-dark-surfaceContainerHigh
       transition-colors text-dark-onSurfaceVariant，带 aria-label              (:94-95)
```

`rounded-md3-xl`(28px) 全站只 5 处，只给弹窗容器；卡片 / 输入框最高到 `rounded-md3-md`(12px)，
大面板用 `rounded-md3-lg`(16px)。

### 4.2 按钮 / 分段选择器

- 主要按钮：`md-focus px-4 py-2 rounded-md3-sm text-sm font-medium transition-colors`
  + `bg-md-primary text-md-onPrimary hover:bg-md-primary/90`；
  危险态整段换 `bg-md-error text-white hover:bg-md-error/90`（`ConfirmDialog.tsx:119-123`）。
- 次要按钮：同上但去 `font-medium`，
  `text-dark-onSurfaceVariant hover:bg-dark-surfaceContainerHigh`（`ConfirmDialog.tsx:111`）。
- 分段选择器（主题 / 字体 / 字号三组是同一套，新增控件**照抄这段**）：
  ```
  flex-1 py-2 rounded-md3-sm text-ui-sm border transition-colors
  选中：border-md-primary/40 bg-md-primary/10 text-md-primary
  未选：border-dark-onSurfaceVariant/10 hover:bg-dark-surfaceContainer
  aria-pressed={选中态}
  ```
  实现见 `SettingsPage.tsx:436-450`（字号档，本批次新增）、`:393-406`（主题）、`:413-426`（字体）。

### 4.3 卡片 / 分区 / 徽标

- 分区容器：`p-4 rounded-md3-md bg-dark-surfaceContainer/50 border border-dark-onSurfaceVariant/10`
  （`SettingsPage.tsx:320`）。
- 消息内嵌条：`flex items-center gap-2 px-3 py-1.5 rounded-md3-md text-[11px]`
  → 迁移目标 `text-ui-xs`（`MessageItem.tsx` 搜 `rounded-md3-md text-[11px]`，3 处）。
- 徽标 / 徽章：`px-1.5 py-0.5 rounded-full text-[10px] font-medium` + 语义淡底，
  淡底 **alpha 固定 `/15`**、前景取同色系实色：
  `bg-md-info/15 text-md-info`、`bg-md-success/15 text-md-success`（`SkillStore.tsx:44-58` 的徽章常量表 + 渲染处）。
  **不要**前景一个色系、底色另一个色系。
- 等宽块：代码 / diff / 计数一律 `font-mono` + `rounded-md3-xs`(4px)，
  数字再加 `tabular-nums`（`MessageItem.tsx` 搜 `font-mono text-[11px]` 与 `tabular-nums text-md-success`）。

### 4.4 折叠动效（两种，别混用）

1. **grid-rows 模式**（内容高度未知，推荐）：
   ```tsx
   <div className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0,
                 transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' }}>
   ```
   见 `MessageItem.tsx`（两处，搜 `transition-[grid-template-rows,opacity]`，其一上方有注释
   「展开明细：grid-rows 折叠过渡」）与 `Sidebar.tsx:405-408`。
   子元素必须自己带 `overflow-hidden`。
2. **max-height 模式**（定高下拉）：
   `overflow-hidden transition-[max-height,opacity,visibility] duration-200 ease-out
   motion-reduce:transition-none`（`ChatInput.tsx` 搜 `transition-[max-height`）。

**禁止**用 `blur` / `box-shadow` 作全屏过渡关键帧
（理由见 `tailwind.config.ts:99-100` 的注释：核显机器每帧重算模糊会掉帧）；
入场动画只用 `opacity` / `transform`（`tailwind.config.ts:98-129` 全部遵守此约束）。

---

## 5. Do / Don't（硬约束，AI 必读）

### 5.1 禁止新增 `text-[Npx]` 任意值字号

Do：`text-ui-xs | ui-sm | ui-base | ui-lg | ui-xl | ui-2xl`（§3.1）。
Don't 锚点：`CommandPalette.tsx:155`、`MessageItem.tsx` 的 `text-[10px] tabular-nums`、
`ChatInput.tsx` 的 `text-[9px]`。
同理禁止新增任意行高（反例：`MessageItem.tsx` 搜 `leading-[1.6]` 与 `leading-[1.8]`）
与任意颜色透明度（反例：`MessageItem.tsx` 搜 `border-dark-onSurfaceVariant/[0.06]`）——
透明度用整数档（`/5 /10 /15 /20 /30 /40 /50 /60 /70 /80 /90`）。

### 5.2 禁止在组件内新写十六进制 / `rgb()` 字面色，一律走 token

现状底账（`.tsx` 里全部字面色，**共 4 处 hex + 3 处 rgba**，都是有意例外）：

| 位置 | 值 | 为什么允许 |
|---|---|---|
| `src/components/ui/QrCode.tsx:25` | `dark:'#111111', light:'#ffffff'` | 二维码点阵必须纯黑白，随主题变会扫不出 |
| `src/components/workbench/TerminalPanel.tsx:20-21` | `#e6e6e6` / `#4d8ef7` | xterm 主题对象只吃颜色串，是**已知缺口**（§1.4） |
| `src/components/vibe/VibeBackground.tsx:12` | `from-[#1b1b2f] via-[#16243d] to-[#0f3460]` | VIBE 渐变兜底，属白色系降级层（§5.3） |
| `TerminalPanel.tsx:19,22` | `rgba(0,0,0,0)` / `rgba(77,142,247,0.35)` | 同上，xterm |
| `src/components/chat/ThemeWaves.tsx`（搜 `ctx.fillStyle`）| `rgba(${...})` 模板 | canvas 填充，但颜色来自 CSS 变量（同文件顶部 `WAVE_LAYERS` + `getComputedStyle`）|

**正确的非 DOM 写法**（别拿字面值，去插值变量）：
`ContextUsageIndicator.tsx:31-36` 用 `rgb(var(--md-*-rgb))` 复用主题色；
`ThemeWaves.tsx` 用 `getComputedStyle(document.documentElement)` 读 `--md-*-rgb` 再合成 rgba。

**DOM 样式里 0 处硬编码色——新代码必须仍然是 0。**

### 5.3 vibe 模式必须显式考虑（白色系降级的正确写法）

VIBE 根容器已经给了 `text-white`（`App.tsx:165`），子树里再写 `text-dark-*` 而不加降级分支 = bug。
三种正确写法，按场景选一：

1. 组件已有 `vibe` prop → 三元并行，**白色档按 §1.2 的三档一一对应**：
   ```
   一档 → text-white/90      二档 → text-white/70      三档 → text-white/40~/60
   ```
   范例（均在 `src/components/chat/`，按片段搜索）：
   `vibe ? 'text-white/60' : 'text-dark-onSurfaceVariant/70'`（`ChatInput.tsx`）、
   `vibe ? 'text-white/85' : 'text-dark-onSurface/85'`（`MessageItem.tsx`）、
   `vibe ? 'text-white/45' : 'text-dark-onSurfaceVariant/40'`（`MessageItem.tsx`）。
   现量：**183 处 `vibe ? '`，分布 14 个文件**
   （`grep -rE "vibe \? '" src --include=*.tsx | wc -l`）。
   白色系实际只用 `/90 /85 /80 /70 /60 /55 /50 /45 /40 /35` 十档（`/75` 仅 1 处，属长尾）
   （`grep -rEoh 'text-white/[0-9]+' src --include=*.tsx | sort -u`）；
   **新增时从这十档里取，不要开新档**；`/95`、`/25`、`/15` 之类项目里没有。
2. 拿不到 prop 的全局浮层 → 读 store：
   `const isVibeMode = useVibeStore((s) => s.isVibeMode)`
   （`ConfirmDialog.tsx:26`、`SettingsPage.tsx:36`、`MSettingsPage.tsx:47`、`App.tsx:96`）。
3. 需要整块换肤的 CSS → 加覆写类，别新开规则：
   `.markdown-body.md-vibe`（挂载在 `MessageItem.tsx` 搜 `` `markdown-body${vibe ? ' md-vibe'` ``，
     覆写块 `index.css:195-219`）、
   `.agent-status-label-vibe`（`index.css:293-296`，**只重绑局部变量** `--asl-base/--asl-peak`）。

补充约束：

- **只降前景/面色；强调色 token 保持主题色** —— `text-md-primary` 在 vibe 下不降级（`ChatInput.tsx` 搜 `text-md-primary/80`）。
- 玻璃底一律用 `.liquid-glass` / `-strong` / `-subtle` / `-btn`（`index.css:513-580`），
  别自己拼 `backdrop-filter`。选择口径：浮层面板 `-strong`、按钮 `-btn`、大面积重复元素（消息气泡）`-subtle`。
- 交互语义色（§1.3）**不需要**为 vibe 另写一套：暗色档本身就是深色容器 + 亮前景，
  叠在玻璃上仍满足 §1.3 表里的对比度。

### 5.4 新增用户可见文案必须 i18n 双语

`src/i18n/index.ts:19-28`：单 `translation` 命名空间，`lng:'zh-CN'`、`fallbackLng:'en'`
（语言清单 `:6-9`）。两个 locale 文件**结构逐行对齐**——`settings:` 都在 `:80`，
`settings.appearance` 都在 `:182-196`。新增 key 必须同时进两个文件的同一位置，
命名沿用现有 camelCase 后缀风格（`*Title` / `*Desc` / `*Label` / `*Confirm` / `*Placeholder`）。
**只加中文不加英文 = 违反本条。**

### 5.5 图标一律 `lucide-react`

33 个文件从它导入，`react-icons` / `tabler` / `heroicons` / `react-feather` **0 处**。
尺寸走 `size={14|16|18}` 属性（`ConfirmDialog.tsx:86`、`SettingsPage.tsx:322`），
颜色走 `className="text-md-primary"`；**不要**用 `color` 属性传字面色。

### 5.6 其它

- 不新增 `dark:` 变体配色（§2）。
- 不用 `md-surface*` 族（§1.1 死键）。
- 阴影只用 `shadow-elevation-1|2|3`；`shadow-sm/md/lg/xl` 是遗留长尾（13 处，
  含 `index.css:502` 的 `.md3-elevated` 与 `:585` 起的移动端块），别新增。
- 一个 class 串里的颜色只来自同一层（surface 族 or md 族 or 交互语义族），不跨层混配。

---

## 6. 无障碍基线

- **错误提示用 `role="alert"`**：现状 **15 处**
  （`SettingsPage.tsx:248,558,691,808`、`MSettingsPage.tsx:264`、`McpSection.tsx` 3、
  `ProvidersSection.tsx:465`、`FileTree.tsx:188`、`ScheduledTasksPage.tsx:379`、
  `SkillStore.tsx`（搜 `role="alert"`，3 处）、`ChatErrorBanner.tsx`（批次 C 新增，1 处）。
  配色固定 `text-md-error` + 淡底 `bg-md-error/10 border-md-error/20`
  （`SkillStore.tsx` 与 `ChatErrorBanner.tsx` 均如此，搜 `bg-md-error/10`）。
  新增错误条不得换色、不得漏 `role="alert"`。
- **对话框**：`role="dialog"` + `aria-modal="true"` + `aria-labelledby` / `aria-describedby`
  （`ConfirmDialog.tsx:75-78`；全站 `role="dialog"` 16 处）。标题 id 用固定字符串
  （`ConfirmDialog.tsx:88`）或 `useId()`（`SettingsPage.tsx:52`）。
- **可切换项必须 `aria-pressed`**：23 处，含本批次新增的字号档位按钮
  （`SettingsPage.tsx:441`、`MSettingsPage.tsx:451`）。
- **键盘焦点兜底**：`index.css:347-352` 给
  `:where(button, [role='button'], a[href], input, select, textarea, [tabindex]):focus-visible`
  统一 2px 主题色焦点环。组件里凡写 `outline-none` / 自定义 `focus:`，
  必须挂 `.md-focus`（`index.css:356-359`）而不是删掉焦点样式。
  颜色选择器等无焦点框场景用 `focus-within:outline` 补（`SettingsPage.tsx:496` 附近）。
- **装饰性元素** `aria-hidden`（38 处），**仅屏幕阅读器可见**用 `sr-only`（5 处），
  图标按钮必须有 `aria-label`（135 处，如 `ConfirmDialog.tsx:94`）。
- **减弱动态效果**：`index.css:268-279` 全局兜底把入场动画压到 0.01ms；
  内联 `transition` 的组件需自加 `motion-reduce:transition-none`（`ChatInput.tsx` 搜 `transition-[max-height`）。
- **对比度**：正文 ≥ 4.5:1。`text-dark-onSurfaceVariant/30` 与 `text-white/35` 是最弱档，
  只用于**可丢失**的脚注（`ChatInput.tsx` 的 `t('chat.disclaimer')`）；承载信息的内容不得低于 `/40`。
  新增语义色必须给出对比度算式（参照 §1.3 的表）。

---

## 7. 中文排版

- **字体栈单一来源**：`--app-font-family`，基线 `index.css:8`
  （`"PingFang SC", "Microsoft YaHei", system-ui, sans-serif`）；
  消费处 `index.css:299-303` 与 `tailwind.config.ts:57-59`
  （`fontFamily.sans` 被整体替换为该变量，**没有**第二套 sans，也没有 serif 的 Tailwind 键）。
- **字体档位只有两个**：`AppFont = 'default' | 'serif'`（`theme-engine.ts:33`），
  栈定义 `theme-engine.ts:34-37`（serif = `Georgia, "Songti SC", "Source Han Serif SC", SimSun, serif`）。
  写入方式 `applyAppFont()`（`theme-engine.ts:125-132`）：serif 才内联，default 走 `removeProperty` 回落基线。
- **双份常量是既成约定**：新增字体档位必须同步 `public/theme-init.js:9-16`——
  那里是**手抄的第二份**（脚本先于 React 执行、不能 import，约定注释见 `:9` 与 `:17`）。
  同样地，`--ui-font-size` 的基准值与合法区间在 `theme-engine.ts:135-138` 与
  `theme-init.js:17-21` 各存一份。**改一处必改两处**，否则冷启动会先闪一下错误字号。
- **serif 档的边界**：它只改 `--app-font-family`，**不影响** `font-mono`。
  所以代码块、diff、计数、token 数一律显式 `font-mono`（+ 数字加 `tabular-nums`），
  见 `MessageItem.tsx`（搜 `font-mono text-[11px]`）、`AgentStatusIndicator.tsx:126`；
  否则切到 serif 档会字符错位、数字跳动。
- 中英混排**不要**用 `letter-spacing` 补救：现有 `tracking-wider` / `tracking-wide` 只落在
  `uppercase` 的英文分区小标题上（`ChatInput.tsx` 搜 `text-[10px] uppercase tracking-wider`，4 处），
  中文文案上不要用。
- 正文默认档 = `text-ui-sm`（14px @100%）+ `leading-relaxed`
  （Markdown 正文就是这么定的：`index.css:123-125`）。
