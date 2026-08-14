import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './i18n'

// WebUI 模式（浏览器中无 window.clerkbox）：给 html 加标记，CSS 据此调整 body 背景
if (typeof window !== 'undefined' && !window.clerkbox) {
  document.documentElement.classList.add('webui-mode')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
