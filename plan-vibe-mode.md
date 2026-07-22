# ClerkBox VIBE 模式实施计划

## 上下文

在 ClerkBox 现有界面（侧边栏、顶部栏、聊天界面、输入框）基础上，新增一个名为 **VIBE 模式** 的氛围模式。进入后隐藏大部分 UI，仅保留消息内容、输入框、音乐播放器、退出按钮、定制按钮，并以全屏背景图 + 液态玻璃风格呈现，同时支持背景音乐播放与个性化配置。

---

## 需求拆解

1. **入口**：TitleBar 原模型选择器位置新增"VIBE 模式"切换按钮。
2. **VIBE 界面**：隐藏 Sidebar 与 TitleBar；仅保留消息列表、ChatInput、退出按钮（右下）、音乐播放器（右上）、定制按钮（左下）。
3. **输入框**：VIBE 模式下仍在底部，采用液态玻璃风格。
4. **背景**：全屏显示默认 Pexels 背景图，可自定义为网络图片或本地图片。
5. **音乐播放器**：右上角悬浮玻璃控制器，自动播放默认音频，支持上一首/下一首/播放暂停/白色进度条，可自定义为网络音频、本地音频或音乐文件夹。
6. **定制菜单**：左下角"定制"按钮弹出玻璃菜单，支持背景、音乐、音乐文件夹设置。
7. **持久化**：VIBE 配置持久化，应用启动后自动恢复；退出 VIBE 后普通界面状态保持不变。

---

## 方案设计

### 1. 状态管理

**新建 `src/stores/vibe-store.ts`**

使用 zustand + persist 持久化以下配置：

```ts
interface VibeState {
  isVibeMode: boolean                // 不持久化
  background: { type: 'url' | 'local'; value: string }
  music: { type: 'url' | 'local'; value: string } | null
  musicFolder: string | null
  toggleVibeMode: (next?: boolean) => void
  setBackground: (bg) => void
  setMusic: (track) => void
  setMusicFolder: (folder) => void
}
```

- 默认背景：Pexels 链接
- 默认音乐：`https://xmzf.space/bj.mp3`
- `partialize` 只持久化 background / music / musicFolder，不持久化 `isVibeMode`

### 2. App.tsx 渲染切换

修改 `src/App.tsx`：

- 非 VIBE 模式：保持现有布局（Sidebar + TitleBar + ChatPage/SkillStore）
- VIBE 模式：
  - 不渲染 Sidebar、TitleBar
  - 渲染全屏 `VibeBackground`
  - 渲染 `ChatPage vibe`（只显示消息 + 输入框）
  - 绝对定位：`VibeMusicPlayer`（右上）、`VibeControls`（退出+定制按钮）

### 3. 入口按钮

修改 `src/components/layout/TitleBar.tsx`：

- 在右侧状态指示器左侧（原模型选择器位置）新增"VIBE"按钮
- 点击调用 `toggleVibeMode()`

### 4. VIBE 模式聊天界面

修改 `src/components/chat/ChatPage.tsx`：

- 新增 `vibe?: boolean` prop
- `vibe=true` 时：
  - 隐藏 `SkillLoader`
  - 使用玻璃样式渲染消息列表
  - 输入框使用 VIBE 液态玻璃样式
  - 布局保持底部输入框

修改 `src/components/chat/MessageList.tsx` / `MessageItem.tsx`：

- 新增 `vibe?: boolean` prop
- VIBE 模式下消息气泡改为半透明玻璃风格（白色/浅色文字 + 毛玻璃背景）

修改 `src/components/chat/ChatInput.tsx`：

- 新增 `vibe?: boolean` prop
- VIBE 模式下使用液态玻璃样式：
  ```
  bg-white/10 backdrop-blur-xl border border-white/20 shadow-lg
  rounded-[28px] text-white/90 placeholder-white/50
  ```
- 按钮图标颜色调整为白色/半透明白色

### 5. VIBE 专用组件（新建）

| 文件 | 职责 |
|---|---|
| `src/components/vibe/VibeBackground.tsx` | 全屏背景图（网络/本地），带加载回退 |
| `src/components/vibe/VibeMusicPlayer.tsx` | 右上角悬浮音乐控制器：曲名、上一首/下一首、播放/暂停、白色进度条 |
| `src/components/vibe/VibeControls.tsx` | 右下角退出按钮 + 左下角定制按钮 |
| `src/components/vibe/VibeCustomizeMenu.tsx` | 玻璃风格定制菜单：背景 URL、本地图片、音频 URL、本地音频、音乐文件夹 |

### 6. 音乐播放器逻辑

- 使用 `<audio>` + ref 控制
- 曲目列表来源优先级：
  1. 若 `musicFolder` 存在，读取文件夹内音频文件（mp3/wav/ogg/flac/m4a/aac），按文件名排序
  2. 若 `music` 存在，单首循环
  3. 否则使用默认音频
- 进度条：`<input type="range">` 或自定义 div
- 切歌：`trackIndex` 循环
- 自动播放：进入 VIBE 模式后尝试自动播放，被浏览器阻止时显示播放按钮让用户手动触发

### 7. 定制菜单

`VibeCustomizeMenu.tsx` 提供：

- **背景图**：输入网络 URL 或选择本地图片文件
- **音乐**：输入网络 URL 或选择本地音频文件
- **音乐文件夹**：选择文件夹后，清空单首音乐，播放器按文件夹切歌

### 8. Electron IPC 扩展

新增 IPC 通道：

- `selectImageFile`：选择图片文件（jpg/png/gif/webp 等）
- `selectAudioFile`：选择音频文件（mp3/wav/ogg/flac/m4a/aac）
- `selectMusicFolder`：选择音乐文件夹
- `fileExists`：检查文件是否存在

修改文件：

- `electron/main.ts`：注册 handlers
- `electron/preload.ts`：暴露给渲染进程
- `src/types/ipc.ts`：类型声明
- `src/lib/ipc-client.ts`：前端封装

### 9. 持久化与恢复

- 使用 zustand persist 自动保存 background、music、musicFolder
- 应用启动后 `isVibeMode` 默认为 false
- 下次进入 VIBE 模式时自动恢复背景、音乐、文件夹
- 本地文件路径若失效，回退到默认配置

### 10. 样式规范（液态玻璃）

基础玻璃类：

```
bg-white/10 backdrop-blur-xl border border-white/20 shadow-lg
hover:bg-white/15 hover:border-white/30 transition-colors
text-white/90 placeholder-white/50
```

- 输入框：`rounded-[28px]`，聚焦时边框更亮
- 按钮：`rounded-full`，玻璃底色
- 音乐播放器：`rounded-full`，悬浮在右上
- 定制菜单：`rounded-2xl`，左下弹出

---

## 需要修改/新建的文件清单

### 新建

- `src/stores/vibe-store.ts`
- `src/components/vibe/VibeBackground.tsx`
- `src/components/vibe/VibeMusicPlayer.tsx`
- `src/components/vibe/VibeControls.tsx`
- `src/components/vibe/VibeCustomizeMenu.tsx`

### 修改

- `src/App.tsx`：VIBE 布局切换
- `src/components/layout/TitleBar.tsx`：VIBE 入口按钮
- `src/components/chat/ChatPage.tsx`：vibe prop 分支
- `src/components/chat/MessageList.tsx`：vibe prop 与玻璃样式
- `src/components/chat/MessageItem.tsx`：vibe prop 与玻璃气泡
- `src/components/chat/ChatInput.tsx`：vibe prop 与液态玻璃样式
- `src/lib/ipc-client.ts`：新增 IPC 封装
- `src/types/ipc.ts`：新增类型
- `electron/preload.ts`：暴露 IPC
- `electron/main.ts`：注册 IPC handlers

---

## 执行顺序

1. **状态层**：新建 `vibe-store.ts`
2. **IPC 层**：新增文件选择/存在检查相关 IPC
3. **入口**：TitleBar 添加 VIBE 按钮
4. **布局切换**：App.tsx 根据 `isVibeMode` 切换布局
5. **背景组件**：VibeBackground
6. **音乐播放器**：VibeMusicPlayer
7. **控制按钮**：VibeControls + VibeCustomizeMenu
8. **聊天适配**：ChatPage / MessageList / MessageItem / ChatInput 接入 vibe prop
9. **测试验证**：进入/退出 VIBE、背景切换、音乐播放与切歌、本地文件选择、持久化恢复

---

## 验证方法

1. 启动 `npm run dev`
2. 点击 TitleBar 的 VIBE 按钮，确认：
   - Sidebar 和 TitleBar 隐藏
   - 全屏背景图显示
   - 输入框位于底部且为玻璃风格
   - 音乐播放器出现在右上角并自动播放
3. 发送消息，确认消息气泡为玻璃风格
4. 点击"定制"，设置本地图片/音频/文件夹，确认生效并持久化
5. 退出 VIBE 模式，确认普通界面恢复
6. 重启应用，再次进入 VIBE 模式，确认上次的背景/音乐配置已恢复

---

## 潜在风险与应对

| 风险 | 应对 |
|---|---|
| 浏览器自动播放策略阻止背景音乐 | 进入 VIBE 模式本身需要用户点击按钮；若仍失败，播放器显示手动播放按钮 |
| 网络图片/音频跨域或加载失败 | 监听 onError 回退到默认背景/音乐 |
| 本地文件路径失效 | 进入 VIBE 模式前用 `fileExists` 校验，失效则回退默认 |
| 音乐文件夹无音频文件 | 自动降级为单首音乐或默认音频 |
| 背景图过大导致性能问题 | 使用 `background-size: cover`，避免缩放重绘；本地图片使用 file:// 或 object URL |

---

## 待确认点

1. VIBE 模式下是否还需要显示 AI 的中间步骤/工具调用折叠？
   - 建议：保留，因为属于"AI/用户消息内容"的一部分。
2. 普通模式 welcome 界面的 SkillLoader 是否需要保留？
   - 建议：保留现有改动，VIBE 模式下才隐藏 SkillLoader。
