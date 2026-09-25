import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './i18n'
import { installRendererLogHooks } from './lib/logger'
import { attachAgentEvents } from './lib/agent-event-apply'

// 渲染进程异常落盘（A1）：须在渲染前安装，启动期错误也能被主进程日志捕获
installRendererLogHooks()

// 宿主事件通道（批次 B · P4）：渲染前就挂上，避免启动瞬间的事件无人认领。
// 非宿主模式下只做一次模式询问，不建订阅，行为与改前一致
void attachAgentEvents()

// WebUI 模式（浏览器中无 window.clerkbox）：给 html 加标记，CSS 据此调整 body 背景
if (typeof window !== 'undefined' && !window.clerkbox) {
  document.documentElement.classList.add('webui-mode')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
